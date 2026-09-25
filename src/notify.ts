// Push notifications through NOTIFY_URL (optional secret), in whichever service it names:
//   ntfy  — https://ntfy.sh/<topic>, or a self-hosted ntfy server's topic URL: plain-text body,
//           title and click-through URL in headers. ntfy.sh counts anonymous messages per IP,
//           and a Worker shares its outgoing IPs with everyone else's, so their daily quota is
//           usually gone: give an access token (NOTIFY_TOKEN, tk_…) from a free ntfy.sh account
//           and the quota is that account's.
//   Bark  — https://api.day.app/<device key> (iOS), or a self-hosted Bark server written as
//           bark+https://<host>/<device key>: a JSON body.
// Tapping the notification opens `click` (the launcher page) in both.

const TITLE = "YUE2 // GROOVE";
const GROUP = "yue2-groove-pod";

export type NotifyKind = "ntfy" | "bark";

export interface NotifyResult {
  sent: boolean;
  kind?: NotifyKind;
  status?: number;
  detail?: string;
}

export function notifyKind(target: string): { kind: NotifyKind; url: string } {
  if (target.startsWith("bark+")) return { kind: "bark", url: target.slice(5) };
  try {
    if (new URL(target).hostname === "api.day.app") return { kind: "bark", url: target };
  } catch { /* not a URL: let fetch report it */ }
  return { kind: "ntfy", url: target };
}

/** Send `text`; best effort, never throws. `click` is where tapping the notification leads. */
export async function sendNotification(target: string | undefined, text: string, click?: string, token?: string): Promise<NotifyResult> {
  if (!target?.trim()) return { sent: false, detail: "NOTIFY_URL is not set" };
  const { kind, url } = notifyKind(target.trim());
  try {
    const res = kind === "bark"
      ? await fetch(url.replace(/\/+$/, ""), {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ title: TITLE, body: text, group: GROUP, ...(click ? { url: click } : {}) }),
        })
      : await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "text/plain; charset=utf-8", title: TITLE, tags: "musical_note",
            ...(click ? { click } : {}), ...(token?.trim() ? { authorization: `Bearer ${token.trim()}` } : {}),
          },
          body: text,
        });
    let detail = res.ok ? undefined : (await res.text().catch(() => "")).slice(0, 300);
    if (kind === "ntfy" && res.status === 429 && !token?.trim()) {
      detail = `quota reached for this Worker's shared IP; set NOTIFY_TOKEN to an ntfy access token. ${detail ?? ""}`;
    }
    return { sent: res.ok, kind, status: res.status, detail };
  } catch (e) {
    return { sent: false, kind, detail: (e as Error).message };
  }
}
