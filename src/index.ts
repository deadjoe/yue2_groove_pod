// Worker: JSON API under /api/*, the phone page from /public, and a cost-guard sweep on a cron.
// Put the whole hostname behind Cloudflare Access; add a bypass policy for /api/progress/* so
// the pod can report progress (that route is protected by the per-session bearer token).
import type { Env } from "./env";
import { listGpuTypes, listPods, pickCandidates } from "./runpod";
import { Sessions, type Session } from "./sessions";
import { DeployWorkflow, stopPod } from "./workflow";

export { Sessions, DeployWorkflow };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const LOCK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>YUE2 // GROOVE — POD</title>
<style>:root{--bg:#0B0A09;--panel:#12110F;--ink:#F1ECE2;--ink3:#7A746A;--line:#2E2B27;--pbg:#F1ECE2;--pfg:#16140F}@media(prefers-color-scheme:light){:root{--bg:#F1ECE2;--panel:#F7F3EB;--ink:#16140F;--ink3:#7A746A;--line:#C4BBA8;--pbg:#11141C;--pfg:#F1ECE2}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--ink);font:14px/1.45 "Berkeley Mono","JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;padding:16px;box-sizing:border-box}
form{width:100%;max-width:360px;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:16px}h1{font-size:15px;letter-spacing:.06em;margin:0 0 12px}label{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3);margin-bottom:4px}
input{width:100%;box-sizing:border-box;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:10px}button{width:100%;font:inherit;letter-spacing:.08em;text-transform:uppercase;font-weight:600;border-radius:8px;padding:12px;border:0;background:var(--pbg);color:var(--pfg)}</style></head>
<body><form method="get" action="/"><h1>YUE2 // GROOVE // POD</h1><label for="k">launch key</label><input id="k" name="k" type="password" autocomplete="current-password" autofocus required><button>Unlock</button></form></body></html>`;

function token(bytes = 18): string {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ "+": "a", "/": "b", "=": "" })[c] ?? "");
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  if (v === null || v === undefined || v === "") return dflt; // Number(null) is 0, not NaN
  const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** What the page may see: no progress token. */
function publicView(s: Session) {
  const { progress_token: _t, ...rest } = s;
  const started = s.ready_at ?? s.created;
  const end = s.ended_at ?? new Date().toISOString();
  const hours = s.pod_id ? Math.max(0, (Date.parse(end) - Date.parse(s.created)) / 3600_000) : 0;
  return { ...rest, hours_billed_est: Math.round(hours * 100) / 100, cost_est: s.price_per_hr ? Math.round(s.price_per_hr * hours * 100) / 100 : null, started };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const sessions = env.SESSIONS.get(env.SESSIONS.idFromName("global"));

    // Optional gate for the workers.dev hostname before (or instead of) Cloudflare Access:
    // with the LAUNCH_KEY secret set, open /?k=<key> once and a cookie keeps you in.
    const progressRoute = url.pathname.startsWith("/api/progress/");
    if (env.LAUNCH_KEY && !progressRoute) {
      const k = url.searchParams.get("k");
      if (k !== null) {
        url.searchParams.delete("k");
        const ok = k === env.LAUNCH_KEY;
        return new Response(null, { status: 303, headers: { location: url.pathname + url.search,
          ...(ok ? { "set-cookie": `groove_key=${encodeURIComponent(k)}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax` } : {}) } });
      }
      const cookie = req.headers.get("cookie") ?? "";
      const m = cookie.match(/(?:^|;\s*)groove_key=([^;]*)/);
      if (!m || decodeURIComponent(m[1]) !== env.LAUNCH_KEY) {
        if (url.pathname.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
        // a home-screen web app has its own cookie jar, so the lock page takes the key by paste too
        return new Response(LOCK_PAGE, { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
    }

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    // pod → launcher progress (bearer token per session); must be reachable without Access
    const progress = url.pathname.match(/^\/api\/progress\/([A-Za-z0-9_-]+)$/);
    if (progress && req.method === "POST") {
      const s = await sessions.get(progress[1]);
      const auth = req.headers.get("authorization") ?? "";
      if (!s || auth !== `Bearer ${s.progress_token}`) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => ({}))) as { step?: string; status?: string; message?: string; ts?: string };
      if (!body.step || !body.status) return json({ error: "step and status required" }, 400);
      await sessions.event(s.id, { step: String(body.step).slice(0, 32), status: String(body.status).slice(0, 16), message: body.message ? String(body.message).slice(0, 600) : undefined, ts: body.ts });
      return json({ ok: true });
    }

    if (url.pathname === "/api/gpus" && req.method === "GET") {
      const gpus = await listGpuTypes(env.RUNPOD_API_KEY);
      const cloud = (url.searchParams.get("cloud") === "COMMUNITY" ? "COMMUNITY" : "SECURE") as "SECURE" | "COMMUNITY";
      const minGb = clampNum(url.searchParams.get("min_gb"), 8, 80, Number(env.MIN_GPU_GB));
      const maxPrice = clampNum(url.searchParams.get("max_price"), 0.05, 5, Number(env.MAX_PRICE_PER_HR));
      return json({ candidates: pickCandidates(gpus, { minGb, maxPrice, cloud }), defaults: { min_gb: Number(env.MIN_GPU_GB), max_price: Number(env.MAX_PRICE_PER_HR), cloud: env.CLOUD, ttl_hours: Number(env.DEFAULT_TTL_HOURS), max_ttl_hours: Number(env.MAX_TTL_HOURS), image: env.IMAGE } });
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      return json({ sessions: (await sessions.list(20)).map(publicView) });
    }

    const one = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(\/stop)?$/);
    if (one) {
      const s = await sessions.get(one[1]);
      if (!s) return json({ error: "not found" }, 404);
      if (!one[2] && req.method === "GET") return json({ session: publicView(s) });
      if (one[2] && req.method === "POST") {
        if (s.state === "ended" || s.state === "failed") return json({ session: publicView(s) });
        await stopPod(env, s.id, s.pod_id, "stopped from the launcher");
        if (s.workflow_id) { try { await (await env.DEPLOY.get(s.workflow_id)).terminate(); } catch { /* already finished */ } }
        return json({ session: publicView((await sessions.get(s.id))!) });
      }
    }

    if (url.pathname === "/api/launch" && req.method === "POST") {
      const live = await sessions.live();
      if (live.length) return json({ error: `a session is already active (${live[0].id}, ${live[0].state}); stop it first`, session: publicView(live[0]) }, 409);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const id = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${token(4).toLowerCase()}`;
      const s: Session = {
        id, created: new Date().toISOString(), state: "queued",
        ttl_hours: clampNum(body.ttl_hours, 0.25, Number(env.MAX_TTL_HOURS), Number(env.DEFAULT_TTL_HOURS)),
        expires: null,
        min_gpu_gb: clampNum(body.min_gpu_gb, 8, 80, Number(env.MIN_GPU_GB)),
        max_price: clampNum(body.max_price, 0.05, 5, Number(env.MAX_PRICE_PER_HR)),
        cloud: body.cloud === "COMMUNITY" ? "COMMUNITY" : "SECURE",
        image: typeof body.image === "string" && /^ghcr\.io\/deadjoe\/yue2_groove:[\w.-]+$/.test(body.image) ? body.image : env.IMAGE,
        auth_user: "groove", auth_pass: token(9).toLowerCase(), progress_token: token(24),
        workflow_id: null, pod_id: null, gpu: null, price_per_hr: null, data_center: null,
        url: null, ready_at: null, ended_at: null, error: null, events: [],
      };
      await sessions.create(s);
      const instance = await env.DEPLOY.create({ id: `deploy-${id}`, params: { sessionId: id, progressUrl: `${url.origin}/api/progress/${id}` } });
      await sessions.update(id, { workflow_id: instance.id });
      await sessions.event(id, { step: "select", status: "info", message: "launch requested" });
      return json({ session: publicView((await sessions.get(id))!) }, 201);
    }

    return json({ error: "not found" }, 404);
  },

  // Cost guard: every 15 minutes delete any RunPod pod of ours whose session is over or
  // past its TTL, and close sessions whose pod is gone.
  async scheduled(_ctl: ScheduledController, env: Env): Promise<void> {
    const sessions = env.SESSIONS.get(env.SESSIONS.idFromName("global"));
    const pods = await listPods(env.RUNPOD_API_KEY).catch(() => [] as Awaited<ReturnType<typeof listPods>>);
    const ours = pods.filter((p) => (p.name ?? "").startsWith("yue2-groove-"));
    const known = await sessions.list(200);
    const now = Date.now();
    for (const p of ours) {
      // by pod id, or by name for a pod created seconds ago whose id the workflow has not stored yet
      const s = known.find((k) => k.pod_id === p.id) ?? known.find((k) => p.name === `yue2-groove-${k.id}`);
      const expired = s?.expires ? Date.parse(s.expires) < now : false;
      const stale = !s && now - Date.parse(String((p as { createdAt?: string }).createdAt ?? new Date().toISOString())) > 6 * 3600_000;
      if (!s || s.state === "ended" || s.state === "failed" || expired || stale) {
        await stopPod(env, s?.id ?? `orphan-${p.id}`, p.id, "cost-guard sweep").catch(() => undefined);
      }
    }
    for (const s of await sessions.live()) {
      if (s.pod_id && !ours.some((p) => p.id === s.pod_id) && (s.state === "ready" || s.state === "booting")) {
        await sessions.event(s.id, { step: "stop", status: "info", message: "pod no longer exists on RunPod" });
        await sessions.update(s.id, { state: "ended", ended_at: new Date().toISOString() });
      }
    }
  },
} satisfies ExportedHandler<Env>;
