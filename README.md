# yue2_groove_pod

A one-tap launcher for [YUE2 // GROOVE](https://github.com/deadjoe/yue2_groove) on RunPod.
It rents the cheapest in-stock GPU that fits (at least 16 GB, with bf16), runs the prebuilt
image `ghcr.io/deadjoe/yue2_groove`, waits for the weights and the app, and hands back the URL
and a one-off password. The pod is deleted when the time limit is reached.

A single Cloudflare Worker: the page and a JSON API, a Workflow that runs the deployment
(it carries on after you close the page), a Durable Object for session state and a cron job
that deletes forgotten pods. It fits the Workers free plan; only RunPod costs money.

```
page ──► Worker ──► Workflow: pick GPU → create pod → wait for boot → wait for ready
                                   │                                     ▲
                                   ▼                                     │ progress
                         RunPod pod (groove-start) ──────────────────────┘
                                   │
                 https://<pod>-7860.proxy.runpod.net  ◄── you (groove / password)
```

## Setup

```sh
npm install
npx wrangler login
npx wrangler secret put RUNPOD_API_KEY   # RunPod API key that can create and delete pods
npx wrangler secret put LAUNCH_KEY       # long random string; required in practice, see below
npx wrangler secret put NOTIFY_URL       # optional, see Notifications
npx wrangler secret put NOTIFY_TOKEN     # only for ntfy.sh, see Notifications
npx wrangler deploy
```

`LAUNCH_KEY` guards the page and the API: without it, anyone who finds the `workers.dev`
address can start pods on your account. Open `https://<host>/?k=<key>` once per device and a
cookie keeps you in for a year; a home-screen web app can paste the key into the lock page
instead. For stronger protection, put the hostname behind Cloudflare Access and give
`/api/progress/*` a Bypass policy (the pod reports there with a per-session token).

## Use

Pick the time limit, GPU memory, price ceiling and cloud, then tap **Deploy**. Most of the
wait is RunPod pulling the ~18 GB image onto a cold host (5–15 min); after that the weights,
their verification and the app take about a minute. The timeline fills in from the pod
(`weights`, `verify`, `gguf` on cards that use the GGUF engine, `start`, `ready`). At
**ready**, tap **OPEN GROOVE** and log in with `groove` and the password shown.

**Stop & delete pod** ends a session at once; otherwise the time limit does. Every 15 minutes
the cron also deletes any `yue2-groove-*` pod whose session has ended or expired, or that
has no session and is more than six hours old.

## Notifications

With `NOTIFY_URL` set, the Worker sends a push when the app is ready, when a launch fails and
when the time limit deletes the pod, whether or not the page is open. Tapping it opens the
launcher. Messages carry the pod's address, never the password.

| Service | `NOTIFY_URL` |
|---|---|
| [Bark](https://github.com/Finb/Bark) (iOS, recommended on iPhone) | `https://api.day.app/<key>`: in the app, *Copy address and key*. A self-hosted Bark server: `bark+https://<host>/<key>` |
| [ntfy](https://ntfy.sh) (Android, iOS, desktop) | `https://ntfy.sh/<long random topic>`, or a topic on your own ntfy server |

ntfy.sh limits anonymous senders per IP, and Workers share their IPs, so an anonymous push is
refused (HTTP 429). Create a free ntfy.sh account and an access token, and store the token as
`NOTIFY_TOKEN`. Bark needs nothing more.

Treat both URLs as secrets. The bell next to *notifications* on the page sends a test push.

## Configuration

Defaults in `wrangler.jsonc`:

| var | default | |
|---|---|---|
| `IMAGE` | `ghcr.io/deadjoe/yue2_groove:latest` | must be public; `latest` follows release tags |
| `MIN_GPU_GB` | `16` | smallest card considered |
| `MAX_PRICE_PER_HR` | `0.60` | USD |
| `CLOUD` | `SECURE` | or `COMMUNITY` |
| `DEFAULT_TTL_HOURS` / `MAX_TTL_HOURS` | `3` / `8` | time limit and its cap |
| `CONTAINER_DISK_GB` | `40` | holds the image and the weights |

The page overrides the time limit, memory, price and cloud per launch. Price and stock are
read for the chosen cloud alone, and a pod that RunPod charges more for than the ceiling is
deleted at once. Pods need a CUDA 12.8 driver; cards without usable bf16 (V100, T4, P-series,
RTX 2060–2080, Quadro RTX, A2), MIG slices and non-NVIDIA cards are skipped, and so is the
RTX 2000 Ada, which has bf16 but is too slow for the price difference.

## API

| route | |
|---|---|
| `GET /api/gpus?min_gb&max_price&cloud` | in-stock candidates, cheapest first |
| `POST /api/launch` `{ttl_hours, min_gpu_gb, max_price, cloud, image}` | start a session (409 if one is running); `image` must be a `ghcr.io/deadjoe/yue2_groove` tag |
| `GET /api/sessions`, `GET /api/sessions/:id` | state, events, URL, password, cost estimate |
| `POST /api/sessions/:id/stop` | delete the pod and end the session |
| `POST /api/notify/test` | send one test push |
| `POST /api/progress/:id` | the pod's progress reports (per-session bearer token) |

## Development

```sh
npx wrangler types && npx tsc --noEmit
npx wrangler dev   # secrets go in .dev.vars
```
