import type { Sessions } from "./sessions";

export interface Env {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace<Sessions>;
  DEPLOY: Workflow;
  RUNPOD_API_KEY: string;
  NOTIFY_URL?: string;
  IMAGE: string;
  MIN_GPU_GB: string;
  MAX_PRICE_PER_HR: string;
  CLOUD: string;
  DEFAULT_TTL_HOURS: string;
  MAX_TTL_HOURS: string;
  CONTAINER_DISK_GB: string;
}
