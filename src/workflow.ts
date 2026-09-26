// The deploy workflow: pick a card → create the pod → wait for it to run → wait for the app to
// report ready (or answer on its proxy URL) → notify → sleep until the TTL → delete the pod.
// Every wait is a durable sleep; nothing here needs the phone's browser to stay open.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { createPod, deletePod, getPod, listGpuTypes, pickCandidates, podUptime, proxyUrl } from "./runpod";
import { sendNotification } from "./notify";
import type { Session } from "./sessions";

export interface DeployParams {
  sessionId: string;
  progressUrl: string; // absolute URL of POST /api/progress/<id>
}

const RUNNING_POLL_S = 20;
const RUNNING_MAX_MIN = 20; // the image is ~18 GB compressed; a cold host pulls it in 5–15 min
const READY_POLL_S = 15;
const READY_MAX_MIN = 25;
/** steps reported by groove-start inside the pod */
const POD_STEPS = new Set(["weights", "verify", "start", "ready"]);

export class DeployWorkflow extends WorkflowEntrypoint<Env, DeployParams> {
  async run(event: WorkflowEvent<DeployParams>, step: WorkflowStep) {
    const { sessionId, progressUrl } = event.payload;
    const env = this.env;
    const sessions = env.SESSIONS.get(env.SESSIONS.idFromName("global"));
    const key = env.RUNPOD_API_KEY;
    const launcher = new URL(progressUrl).origin; // where tapping a notification leads

    const fail = async (where: string, message: string) => {
      const cur = await sessions.get(sessionId);
      if (!cur || cur.state === "ended" || cur.state === "stopping") return; // stopped from the page meanwhile
      await sessions.event(sessionId, { step: "error", status: "failed", message: `${where}: ${message}` });
      await sessions.update(sessionId, { state: "failed", error: `${where}: ${message}`, ended_at: new Date().toISOString() });
      await notify(env, `GROOVE pod failed — ${where}: ${message}`.slice(0, 400), launcher);
    };

    // step outputs are persisted in the Workflow's history, so secrets stay out of them:
    // the pod's password and progress token are read from the DO inside the create step
    const session = await step.do("load session", async () => {
      const s = await sessions.get(sessionId);
      if (!s) throw new Error("session not found");
      const { auth_pass: _p, progress_token: _t, events: _e, ...rest } = s;
      return rest;
    });

    // 1. pick cards
    const candidates = await step.do("select gpu", { retries: { limit: 3, delay: "20 seconds", backoff: "exponential" } }, async () => {
      await sessions.update(sessionId, { state: "selecting" });
      await sessions.event(sessionId, { step: "select", status: "started", message: `≥${session.min_gpu_gb} GB, ≤ $${session.max_price}/h, ${session.cloud}` });
      const gpus = await listGpuTypes(key);
      const picked = pickCandidates(gpus, { minGb: session.min_gpu_gb, maxPrice: session.max_price, cloud: session.cloud });
      await sessions.event(sessionId, {
        step: "select", status: picked.length ? "done" : "failed",
        message: picked.length ? picked.slice(0, 6).map((c) => `${c.displayName} $${c.pricePerHr}/h (${c.stock})`).join(" · ") : "no card in stock within the limits",
      });
      return picked;
    });
    if (!candidates.length) { await fail("select", "no GPU in stock within the limits"); return; }

    // 2. create the pod (RunPod tries gpuTypeIds in order; retry a few times on transient no-stock)
    const pod = await step.do("create pod", { retries: { limit: 4, delay: "45 seconds", backoff: "linear" } }, async () => {
      await sessions.update(sessionId, { state: "creating" });
      await sessions.event(sessionId, { step: "pod", status: "started", message: `creating (${candidates.length} candidates)` });
      const secrets = await sessions.get(sessionId);
      if (!secrets) throw new Error("session not found");
      const p = await createPod(key, {
        name: `yue2-groove-${sessionId}`,
        imageName: session.image,
        gpuTypeIds: candidates.map((c) => c.id),
        cloudType: session.cloud,
        containerDiskInGb: Number(env.CONTAINER_DISK_GB || "40"),
        ports: ["7860/http", "22/tcp"],
        env: {
          YUE2_GROOVE_AUTH: `${session.auth_user}:${secrets.auth_pass}`,
          GROOVE_PROGRESS_URL: progressUrl,
          GROOVE_PROGRESS_TOKEN: secrets.progress_token,
        },
      });
      const { env: _env, ...podNoEnv } = p as typeof p & { env?: unknown };
      return podNoEnv as typeof p;
    }).catch(async (e: Error) => { await fail("create pod", e.message); return null; });
    if (!pod) return;

    const gpuId = pod.machine?.gpuTypeId ?? pod.gpu?.id ?? null;
    const price = pod.costPerHr ?? candidates.find((c) => c.id === gpuId)?.pricePerHr ?? null;
    await step.do("record pod", async () => {
      await sessions.update(sessionId, {
        state: "booting", pod_id: pod.id, gpu: gpuId, price_per_hr: price,
        data_center: pod.machine?.dataCenterId ?? null, url: proxyUrl(pod.id),
      });
      await sessions.event(sessionId, { step: "pod", status: "done", message: `${pod.id} · ${gpuId ?? "?"}${price ? ` · $${price}/h` : ""}${pod.machine?.dataCenterId ? ` · ${pod.machine.dataCenterId}` : ""}` });
    });

    // 2b. what RunPod actually charges must be within the ceiling, whatever the listing said:
    //     otherwise delete the pod at once (a few seconds of billing at most)
    if (pod.costPerHr != null && pod.costPerHr > session.max_price + 1e-9) {
      await step.do("over the price ceiling", async () => {
        await fail("price", `RunPod charges $${pod.costPerHr}/h for ${gpuId ?? "this card"}, above the $${session.max_price}/h ceiling; pod deleted`);
        await stopPod(env, sessionId, pod.id, "price above the ceiling");
      });
      return;
    }

    // 3. wait for the container to run (image pull happens here)
    let running = false;
    for (let i = 0; i < (RUNNING_MAX_MIN * 60) / RUNNING_POLL_S && !running; i++) {
      running = await step.do(`pod running? ${i}`, async () => {
        const p = await getPod(key, pod.id);
        if (!p) throw new Error("pod disappeared");
        const uptime = await podUptime(key, pod.id).catch(() => null);
        // any callback from groove-start also proves the container is up
        const s = await sessions.get(sessionId);
        const reported = s?.events.some((e) => POD_STEPS.has(e.step)) ?? false;
        const up = uptime !== null || (p.runtimeStatus ?? "").toLowerCase() === "running" || reported;
        if (!up && (i === 0 || i % 6 === 0)) await sessions.event(sessionId, { step: "boot", status: "info", message: `pulling the image (${Math.round((i * RUNNING_POLL_S) / 60)} min)` });
        return up;
      });
      if (!running) await step.sleep(`running poll ${i}`, `${RUNNING_POLL_S} seconds`);
    }
    if (!running) { await stopPod(env, sessionId, pod.id, "the pod never reached running"); await fail("boot", "pod did not start in time"); return; }
    await step.do("boot done", async () => sessions.event(sessionId, { step: "boot", status: "done", message: "container running; downloading weights and starting the app" }));

    // 4. wait for groove-start's ready callback, or for the proxy URL to answer
    let ready = false;
    for (let i = 0; i < (READY_MAX_MIN * 60) / READY_POLL_S && !ready; i++) {
      ready = await step.do(`app ready? ${i}`, async () => {
        const s = await sessions.get(sessionId);
        if (!s) throw new Error("session vanished");
        if (s.state === "stopping" || s.state === "ended" || s.state === "failed") return true; // stopped from the page
        if (s.events.some((e) => e.step === "ready" && e.status === "done")) return true;
        if (s.events.some((e) => e.status === "failed" && POD_STEPS.has(e.step))) return true;
        try {
          const r = await fetch(proxyUrl(pod.id), { method: "GET", redirect: "manual", headers: { "user-agent": "yue2-groove-pod/0.1" } });
          if (r.status === 200 || r.status === 401) {
            // the pod's own ready callback may have landed during this probe; don't log it twice
            const again = await sessions.get(sessionId);
            if (!again?.events.some((e) => e.step === "ready" && e.status === "done")) {
              await sessions.event(sessionId, { step: "ready", status: "done", message: `${proxyUrl(pod.id)} (proxy answered)` });
            }
            return true;
          }
        } catch { /* proxy not up yet */ }
        return false;
      });
      if (!ready) await step.sleep(`ready poll ${i}`, `${READY_POLL_S} seconds`);
    }
    const after = await step.do("read outcome", async () => sessions.get(sessionId));
    if (!after || after.state === "stopping" || after.state === "ended" || after.state === "failed") return;
    const failedStep = after.events.find((e) => e.status === "failed");
    if (!ready || failedStep) {
      await stopPod(env, sessionId, pod.id, failedStep ? `${failedStep.step}: ${failedStep.message ?? ""}` : "the app never came up");
      await fail("start", failedStep ? `${failedStep.step} failed — ${failedStep.message ?? ""}` : "the app did not answer within the time limit");
      return;
    }

    // 5. ready → notify
    // persisted as a step output: anything computed outside a step is recomputed on every replay,
    // and a moving expiry made sleepUntil sleep again after each wake (seen 2026-09-18)
    const expires = await step.do("expiry", async () => new Date(Date.now() + session.ttl_hours * 3600_000).toISOString());
    await step.do("mark ready", async () => {
      await sessions.update(sessionId, { state: "ready", ready_at: new Date().toISOString(), expires });
      // the login stays on the launcher page; a push service never sees it
      await notify(env, `GROOVE is up: ${proxyUrl(pod.id)} — log in with the password on the launcher (auto-stop ${session.ttl_hours} h)`, launcher);
    });

    // 6. cost guard — sleep to the TTL, then delete unless already stopped from the page
    await step.sleepUntil("ttl", new Date(expires));
    await step.do("ttl expired", async () => {
      const s = await sessions.get(sessionId);
      if (!s || s.state !== "ready") return;
      await sessions.event(sessionId, { step: "ttl", status: "info", message: "time limit reached — deleting the pod" });
      await stopPod(env, sessionId, pod.id, "time limit reached");
      await notify(env, `GROOVE pod stopped (time limit ${session.ttl_hours} h).`, launcher);
    });
  }
}

/** Delete the pod and close the session. Used by the workflow, the page's stop button and the sweeper. */
export async function stopPod(env: Env, sessionId: string, podId: string | null, reason: string): Promise<void> {
  const sessions = env.SESSIONS.get(env.SESSIONS.idFromName("global"));
  await sessions.update(sessionId, { state: "stopping" });
  let deleted = false;
  if (podId) {
    try { deleted = await deletePod(env.RUNPOD_API_KEY, podId); }
    catch (e) { await sessions.event(sessionId, { step: "stop", status: "failed", message: `delete failed: ${(e as Error).message}` }); throw e; }
  }
  await sessions.event(sessionId, { step: "stop", status: "done", message: `${reason}${podId ? ` · pod ${podId} ${deleted ? "deleted" : "already gone"}` : ""}` });
  await sessions.update(sessionId, { state: "ended", ended_at: new Date().toISOString() });
}

/** Best effort: a failed push never fails the deployment. See notify.ts for the formats. */
export async function notify(env: Env, text: string, click?: string): Promise<void> {
  await sendNotification(env.NOTIFY_URL, text, click, env.NOTIFY_TOKEN);
}

export type { Session };
