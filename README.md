# yue2_groove_pod

A phone-sized launcher for [YUE2 // GROOVE](https://github.com/deadjoe/yue2_groove) on RunPod.
One tap creates the cheapest in-stock GPU pod that fits (≥ 16 GB, bf16-capable), pulls the
prebuilt image `ghcr.io/deadjoe/yue2_groove`, waits for the weights and the app, and hands back
the URL and a one-off password. A time limit deletes the pod when you forget to.

It is a single Cloudflare Worker: static page + JSON API, a **Workflow** that runs the
deployment steps durably (it keeps going after you close the phone), a **Durable Object**
(SQLite) that holds session state, and a **cron** cost guard. Everything fits in the Workers
free plan; RunPod is the only thing that costs money.

```
phone ──► worker (/api/launch) ──► Workflow: select gpu → create pod → wait running → wait ready
                                        │                                   ▲
                                        │  YUE2_GROOVE_AUTH, GROOVE_PROGRESS_URL/TOKEN
                                        ▼                                   │
                                   RunPod pod (groove-start) ── POST /api/progress/<id> ─┘
                                        │
                              https://<pod>-7860.proxy.runpod.net  ◄── you
```

## Setup (once)

```sh
npm install
npx wrangler login
npx wrangler secret put RUNPOD_API_KEY     # a RunPod API key with pod create/delete rights
npx wrangler secret put NOTIFY_URL         # optional: a Bark or ntfy URL, see Notifications
npx wrangler secret put NOTIFY_TOKEN       # with ntfy.sh: an access token (tk_…), see Notifications
npx wrangler secret put LAUNCH_KEY         # optional: long random string; the page then needs /?k=<key> once
npx wrangler deploy
```

Then **protect the hostname**. The quick way is `LAUNCH_KEY`: with it set, the page and the
API answer 401 until you open `https://<host>/?k=<key>` once on that phone (a cookie keeps
you in for a year). The pod's progress route is exempt. The proper way, in addition or
instead, is Cloudflare Access:

1. Cloudflare Zero Trust → Access → Applications → add the Worker's hostname
   (`yue2-groove-pod.<account>.workers.dev` or your custom domain), policy *Allow* for your
   e-mail (one-time PIN is enough).
2. Add a second application for the path `<host>/api/progress/*` with a **Bypass** policy
   (*Everyone*). The pod reports progress there; that route is protected by a per-session
   bearer token instead.

## Use

Open the page on your phone, pick the time limit / memory / price ceiling, tap **Deploy**.
Most of the wait is RunPod pulling the ~18 GB image onto a cold host (5–15 min); once the
container runs, weights (31 s), verification (15 s) and app start (6 s) take about a minute.
The timeline fills in from the pod itself (`weights`, `verify`, `start`, `ready`). When the
state turns **ready**, tap *OPEN GROOVE* and log in with `groove` / the shown password.
Closing the page changes nothing; the Workflow finishes on its own and, if `NOTIFY_URL` is
set, sends a push notification (see Notifications).

**Stop & delete pod** ends the session immediately. Otherwise the pod is deleted when the
time limit is reached. Independently of both, the cron runs every 15 minutes and deletes any
`yue2-groove-*` pod on the account whose session is over, expired, or unknown for more than
six hours.

## Notifications

With `NOTIFY_URL` set, the Worker pushes a message when the app is ready, when a launch
fails and when the time limit deletes the pod, whether or not the page is open. Tapping it
opens the launcher. The message carries the pod's address, never the login password, which
stays on the launcher page. Pick one:

| Service | `NOTIFY_URL` | Notes |
|---|---|---|
| [Bark](https://github.com/Finb/Bark) (iOS) | `https://api.day.app/<device key>` | Free, open source, delivered through Apple's push service. The app shows the URL. A self-hosted Bark server: `bark+https://<host>/<device key>` |
| [ntfy](https://ntfy.sh) (Android, iOS, desktop) | `https://ntfy.sh/<topic>` or your own ntfy server's topic URL | Free, 250 messages a day. **Needs `NOTIFY_TOKEN` on ntfy.sh**, see below. Anyone who knows the topic reads it, so make it long and random |

**ntfy.sh and Workers:** ntfy.sh counts anonymous messages per sending IP, and a Worker
sends from IPs it shares with every other Worker, so their daily quota is usually used up
already (the test answers HTTP 429). Sign up for a free ntfy.sh account, create an access
token (Account → Access tokens) and store it as `NOTIFY_TOKEN`; the quota is then your
account's. Bark has no such limit. On iOS, Bark is also the more dependable of the two.

Either URL is a secret: whoever has it can send to your phone (Bark) or read the
messages (ntfy). **Send test notification** on the page checks the setup; the API
equivalent is `POST /api/notify/test`.

## Configuration

`wrangler.jsonc` `vars` (defaults, all overridable per launch from the page):

| var | default | meaning |
|---|---|---|
| `IMAGE` | `ghcr.io/deadjoe/yue2_groove:main` | image to run; must be public on GHCR |
| `MIN_GPU_GB` | `16` | smallest card considered |
| `MAX_PRICE_PER_HR` | `0.60` | price ceiling, USD/h |
| `CLOUD` | `SECURE` | `SECURE` or `COMMUNITY` |
| `DEFAULT_TTL_HOURS` / `MAX_TTL_HOURS` | `3` / `8` | time limit and its cap |
| `CONTAINER_DISK_GB` | `40` | container disk; weights (~14 GB) live in `/data` inside it |

Cards without usable bf16 (V100, T4, P-series, RTX 20xx, A2) are skipped regardless of price.

## API

| route | |
|---|---|
| `GET /api/gpus?min_gb&max_price&cloud` | in-stock candidates, cheapest first |
| `POST /api/launch` `{ttl_hours, min_gpu_gb, max_price, cloud}` | start a session (409 if one is live) |
| `GET /api/sessions`, `GET /api/sessions/:id` | state, events, URL, cost estimate |
| `POST /api/sessions/:id/stop` | delete the pod, end the session |
| `POST /api/notify/test` | one push through `NOTIFY_URL`; answers what the service replied |
| `POST /api/progress/:id` (bearer token) | called by the pod's `groove-start` |

## Development

```sh
npx wrangler types && npx tsc --noEmit
npx wrangler dev          # needs RUNPOD_API_KEY in .dev.vars
```
