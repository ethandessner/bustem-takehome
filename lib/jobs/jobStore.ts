import type { SearchJob, ScoredResult, RequestCounts } from "../types";

// Persist across hot reloads in Next.js dev mode
const globalForJobs = globalThis as typeof globalThis & {
  _jobStore: Map<string, SearchJob>;
};

if (!globalForJobs._jobStore) {
  globalForJobs._jobStore = new Map();
}

const store = globalForJobs._jobStore;

export function createJob(id: string, requestBudget: number): SearchJob {
  const job: SearchJob = {
    id,
    status: "pending",
    startedAt: Date.now(),
    results: [],
    requestCounts: { amazon: 0, ebay: 0, image: 0, other: 0 },
    requestBudget,
    marketplaceErrors: { amazon: 0, ebay: 0 },
    budgetExhausted: false,
  };
  store.set(id, job);
  return job;
}

export function getJob(id: string): SearchJob | undefined {
  return store.get(id);
}

export function updateJobStatus(
  id: string,
  status: SearchJob["status"],
  error?: string
): void {
  const job = store.get(id);
  if (!job) return;
  job.status = status;
  if (error) job.error = error;
  if (status === "complete" || status === "error") {
    job.completedAt = Date.now();
  }
}

export function addResult(id: string, result: ScoredResult): void {
  const job = store.get(id);
  if (!job) return;
  job.results.push(result);
}

/**
 * Insert a result, or replace the existing one with the same listing id.
 * Used to enrich a previously-posted base score with the image signal in place,
 * so the result doesn't disappear or duplicate when its image finishes scoring.
 */
export function upsertResult(id: string, result: ScoredResult): void {
  const job = store.get(id);
  if (!job) return;
  const idx = job.results.findIndex(
    (r) => r.result.id === result.result.id &&
      r.result.marketplace === result.result.marketplace
  );
  if (idx >= 0) job.results[idx] = result;
  else job.results.push(result);
}

export function updateRequestCounts(id: string, counts: RequestCounts): void {
  const job = store.get(id);
  if (!job) return;
  job.requestCounts = counts;
}

export function addMarketplaceError(id: string, marketplace: "amazon" | "ebay"): void {
  const job = store.get(id);
  if (!job) return;
  job.marketplaceErrors[marketplace]++;
}

export function setBudgetExhausted(id: string): void {
  const job = store.get(id);
  if (!job) return;
  job.budgetExhausted = true;
}
