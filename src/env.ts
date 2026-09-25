import type { Sessions } from "./sessions";

export interface Env {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace<Sessions>;
  DEPLOY: Workflow;
  RUNPOD_API_KEY: string;
  NOTIFY_URL?: string;
  /** secret, optional: ntfy access token (tk_…) sent as a bearer token with ntfy pushes */
  NOTIFY_TOKEN?: string;
  /** secret, optional: shared key that gates the page and the API (cookie set via /?k=) */
  LAUNCH_KEY?: string;
  IMAGE: string;
  MIN_GPU_GB: string;
  MAX_PRICE_PER_HR: string;
  CLOUD: string;
  DEFAULT_TTL_HOURS: string;
  MAX_TTL_HOURS: string;
  CONTAINER_DISK_GB: string;
}
