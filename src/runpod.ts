// RunPod client: GraphQL for GPU prices/stock (not in REST v1), REST v1 for pods.
// Both need a User-Agent — the default fetch UA is refused by RunPod's edge (403).

const UA = "yue2-groove-pod/0.1 (+https://github.com/deadjoe/yue2_groove_pod)";
const REST = "https://rest.runpod.io/v1";
const GQL = "https://api.runpod.io/graphql";

export interface GpuType {
  id: string;
  displayName: string;
  memoryInGb: number;
  secureCloud: boolean;
  communityCloud: boolean;
  /** stock and on-demand price in each cloud, each queried on its own: the list prices
   *  (securePrice / communityPrice) include placeholders such as 0.50 for a cloud that has
   *  no such card, and an unfiltered lowestPrice mixes the two clouds */
  secure: CloudOffer | null;
  community: CloudOffer | null;
}

export interface CloudOffer { stockStatus: string | null; uninterruptablePrice: number | null }

export interface Candidate {
  id: string;
  displayName: string;
  memoryInGb: number;
  pricePerHr: number;
  stock: string;
}

// GPUs the app cannot use: no bf16 (Volta/Turing/Pascal) — upstream's loader refuses them.
// Turing is T4, the RTX 20x0 cards and Quadro RTX; "RTX 20[4-8]0" leaves RTX 2000 Ada (bf16) in.
const NO_BF16 = /V100|T4\b|P100|P40|P4\b|RTX 20[4-8]0|Quadro RTX|TITAN RTX|A2\b|MIG/i; // MIG slices are not accepted as gpuTypeIds either

async function call(url: string, key: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("user-agent", UA);
  headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

export async function listGpuTypes(key: string): Promise<GpuType[]> {
  const query = `query { gpuTypes { id displayName memoryInGb secureCloud communityCloud
    secure: lowestPrice(input:{gpuCount:1, secureCloud:true}) { stockStatus uninterruptablePrice }
    community: lowestPrice(input:{gpuCount:1, secureCloud:false}) { stockStatus uninterruptablePrice } } }`;
  const res = await call(GQL, key, { method: "POST", body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`gpuTypes ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { data?: { gpuTypes: GpuType[] }; errors?: unknown };
  if (!data.data) throw new Error(`gpuTypes: ${JSON.stringify(data.errors).slice(0, 200)}`);
  return data.data.gpuTypes;
}

/** Cards the app can use, in stock, within the price ceiling, cheapest first. */
export function pickCandidates(
  gpus: GpuType[],
  opts: { minGb: number; maxPrice: number; cloud: "SECURE" | "COMMUNITY" },
): Candidate[] {
  const out: Candidate[] = [];
  for (const g of gpus) {
    // NVIDIA only: the image is CUDA (the list also has AMD cards)
    if (!/NVIDIA|Tesla/i.test(g.id)) continue;
    if (g.memoryInGb < opts.minGb || NO_BF16.test(g.displayName) || NO_BF16.test(g.id)) continue;
    // the chosen cloud's own offer: in stock there, at the price actually charged there
    const offer = opts.cloud === "SECURE" ? g.secure : g.community;
    const price = offer?.uninterruptablePrice ?? null;
    const stock = offer?.stockStatus ?? null;
    if (!price || price <= 0 || price > opts.maxPrice || !stock) continue;
    out.push({ id: g.id, displayName: g.displayName, memoryInGb: g.memoryInGb, pricePerHr: price, stock });
  }
  // cheapest first; on a tie prefer the smaller card (leave big ones for others) then better stock
  const rank = (s: string) => ({ High: 0, Medium: 1, Low: 2 })[s] ?? 3;
  return out.sort((a, b) => a.pricePerHr - b.pricePerHr || a.memoryInGb - b.memoryInGb || rank(a.stock) - rank(b.stock));
}

export interface Pod {
  id: string;
  name?: string;
  desiredStatus?: string;
  runtimeStatus?: string;
  gpu?: { id?: string; displayName?: string } | null;
  machine?: { gpuTypeId?: string; dataCenterId?: string } | null;
  costPerHr?: number;
  portMappings?: Record<string, number> | null;
  publicIp?: string | null;
}

export async function createPod(
  key: string,
  body: {
    name: string;
    imageName: string;
    gpuTypeIds: string[];
    cloudType: "SECURE" | "COMMUNITY";
    containerDiskInGb: number;
    env: Record<string, string>;
    ports: string[];
  },
): Promise<Pod> {
  const res = await call(`${REST}/pods`, key, {
    method: "POST",
    body: JSON.stringify({
      ...body,
      computeType: "GPU",
      gpuCount: 1,
      gpuTypePriority: "custom", // try gpuTypeIds in the order given
      dataCenterPriority: "availability",
      allowedCudaVersions: ["12.8", "12.9", "13.0"], // the REST schema enum stops at 13.0 (2026-09)
      volumeInGb: 0, // no persistent volume: weights live on the container disk for the session
      minRAMPerGPU: 16,
      supportPublicIp: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`create pod ${res.status}: ${text.slice(0, 900)}`);
  return JSON.parse(text) as Pod;
}

/** Seconds the container has been up, or null while the image is still being pulled / the pod is stopped.
 *  REST's runtimeStatus stays null on a running pod (seen 2026-09), so this is the reliable boot signal. */
export async function podUptime(key: string, podId: string): Promise<number | null> {
  const res = await call(GQL, key, {
    method: "POST",
    body: JSON.stringify({ query: `query { pod(input:{podId:${JSON.stringify(podId)}}) { runtime { uptimeInSeconds } } }` }),
  });
  if (!res.ok) throw new Error(`pod query ${res.status}`);
  const data = (await res.json()) as { data?: { pod?: { runtime?: { uptimeInSeconds?: number | null } | null } | null } };
  const up = data.data?.pod?.runtime?.uptimeInSeconds;
  return typeof up === "number" ? up : null;
}

export async function getPod(key: string, id: string): Promise<Pod | null> {
  const res = await call(`${REST}/pods/${id}`, key, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get pod ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Pod;
}

export async function listPods(key: string): Promise<Pod[]> {
  const res = await call(`${REST}/pods`, key, { method: "GET" });
  if (!res.ok) throw new Error(`list pods ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as Pod[] | { pods?: Pod[] };
  return Array.isArray(data) ? data : (data.pods ?? []);
}

export async function deletePod(key: string, id: string): Promise<boolean> {
  const res = await call(`${REST}/pods/${id}`, key, { method: "DELETE" });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`delete pod ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

export function proxyUrl(podId: string, port = 7860): string {
  return `https://${podId}-${port}.proxy.runpod.net`;
}
