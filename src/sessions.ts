// One Durable Object (SQLite) holds every launch session: what was asked for, which pod came
// up, the progress events the pod reported, the link, and when the cost guard fires.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export type SessionState =
  | "queued" | "selecting" | "creating" | "booting" | "ready" | "stopping" | "ended" | "failed";

export interface ProgressEvent {
  ts: string;
  step: string;     // select | pod | boot | weights | verify | start | ready | stop | ttl | error
  status: string;   // started | done | failed | info
  message?: string;
}

export interface Session {
  id: string;
  created: string;
  state: SessionState;
  ttl_hours: number;
  expires: string | null;
  min_gpu_gb: number;
  max_price: number;
  cloud: "SECURE" | "COMMUNITY";
  image: string;
  auth_user: string;
  auth_pass: string;
  progress_token: string;
  workflow_id: string | null;
  pod_id: string | null;
  gpu: string | null;
  price_per_hr: number | null;
  data_center: string | null;
  url: string | null;
  ready_at: string | null;
  ended_at: string | null;
  error: string | null;
  events: ProgressEvent[];
}

export class Sessions extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, created TEXT NOT NULL, state TEXT NOT NULL, doc TEXT NOT NULL)`);
  }

  private read(id: string): Session | null {
    const row = this.sql.exec("SELECT doc FROM sessions WHERE id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.doc as string) as Session) : null;
  }

  private write(s: Session): Session {
    this.sql.exec(
      "INSERT INTO sessions (id, created, state, doc) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, doc = excluded.doc",
      s.id, s.created, s.state, JSON.stringify(s));
    return s;
  }

  async create(s: Session): Promise<Session> { return this.write(s); }

  async get(id: string): Promise<Session | null> { return this.read(id); }

  async list(limit = 20): Promise<Session[]> {
    return this.sql.exec("SELECT doc FROM sessions ORDER BY created DESC LIMIT ?", limit)
      .toArray().map((r) => JSON.parse(r.doc as string) as Session);
  }

  /** Sessions whose pod may still be running (for the cost-guard sweep). */
  async live(): Promise<Session[]> {
    return this.sql.exec("SELECT doc FROM sessions WHERE state NOT IN ('ended','failed') ORDER BY created DESC")
      .toArray().map((r) => JSON.parse(r.doc as string) as Session);
  }

  async update(id: string, patch: Partial<Session>): Promise<Session | null> {
    const s = this.read(id);
    if (!s) return null;
    return this.write({ ...s, ...patch });
  }

  async event(id: string, ev: Omit<ProgressEvent, "ts"> & { ts?: string }): Promise<Session | null> {
    const s = this.read(id);
    if (!s) return null;
    s.events.push({ ts: ev.ts ?? new Date().toISOString(), step: ev.step, status: ev.status, message: ev.message });
    if (s.events.length > 200) s.events.splice(0, s.events.length - 200);
    return this.write(s);
  }
}
