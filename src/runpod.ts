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
  securePrice: number | null;
  communityPrice: number | null;
  lowestPrice: { stockStatus: string | null; uninterruptablePrice: number | null } | null;
}

export interface Candidate {
  id: string;
  displayName: string;
  memoryInGb: number;
  pricePerHr: number;
  stock: string;
}

// GPUs the app cannot use: no bf16 (Volta/Turing/Pascal) — upstream's loader refuses them.
const NO_BF16 = /V100|T4\b|P100|P40|P4\b|RTX 20|A2\b/i;

async function call(url: string, key: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("user-agent", UA);
  headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

export async function listGpuTypes(key: string): Promise<GpuType[]> {
  const query = `query { gpuTypes { id displayName memoryInGb secureCloud communityCloud securePrice communityPrice
    lowestPrice(input:{gpuCount:1}) { stockStatus uninterruptablePrice } } }`;
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
    if (g.memoryInGb < opts.minGb || NO_BF16.test(g.displayName) || NO_BF16.test(g.id)) continue;
    if (opts.cloud === "SECURE" ? !g.secureCloud : !g.communityCloud) continue;
    const price = opts.cloud === "SECURE" ? g.securePrice : g.communityPrice;
    const stock = g.lowestPrice?.stockStatus ?? null;
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
      allowedCudaVersions: ["12.8", "12.9", "13.0", "13.1", "13.2"],
      supportPublicIp: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`create pod ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Pod;
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
