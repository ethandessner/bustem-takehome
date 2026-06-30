# Architecture — Scaling to Multi-Tenant Production

This document describes how the current single-tenant take-home would evolve into a production system serving hundreds of brand-protection clients.

---

## Job Orchestration

**Current:** fire-and-forget async function inside a Next.js API route.

**Production:**

```
Client UI ──► API Gateway ──► Job Service (creates job record)
                                    │
                                    ▼
                            Job Queue (e.g. BullMQ / SQS)
                                    │
                            ┌───────┴───────┐
                          Worker          Worker         (horizontally scalable)
                            │               │
                     Search sub-tasks   Score sub-tasks
                       (per-query)       (per-listing)
```

Each job is broken into small units of work (one search query, one listing to score) and enqueued individually. Workers pull tasks off the queue, execute them, and write results back to the database. This decouples job dispatch from execution, allows horizontal scaling, and makes individual failures retryable without rerunning the whole job.

A job coordinator tracks child-task completion counts and transitions the parent job to `complete` when all tasks are done (or the deadline/budget is reached).

---

## Per-Client Rate Limiting and Isolation

Each client gets its own rate-limit bucket (e.g. a sliding-window counter in Redis):

- **Search requests per minute** — prevents one client from exhausting shared ScraperAPI quota.
- **Concurrent jobs** — a client with a burst of jobs doesn't starve others.
- **Request budget per job** — configurable per client/tier (e.g. 200 for free, 2000 for pro).

Workers tag every outbound request with a `clientId` and check/decrement the appropriate bucket before making the call. If the bucket is empty, the task is re-queued with a delay rather than dropped, so the job eventually completes even under throttling.

---

## Data Storage

### Relational core (Postgres)

| Table | Key columns | Notes |
|---|---|---|
| `clients` | id, name, tier, api_key_hash | One row per brand-protection customer |
| `brands` | id, client_id, name, keywords[] | A client may protect multiple brands |
| `reference_products` | id, brand_id, name, price_min, price_max | Known canonical products |
| `reference_images` | id, product_id, url, embedding (vector) | Pre-computed CLIP embeddings stored here (e.g. pgvector), not recomputed per job |
| `jobs` | id, client_id, brand_id, status, started_at, completed_at, budget_used, error | One row per scan |
| `marketplace_queries` | id, job_id, marketplace, query, page, status, error | One row per search request; enables retry |
| `raw_results` | id, job_id, marketplace, external_id, title, price, seller, image_url, fetched_at | Deduplicated raw listing data |
| `scored_results` | id, raw_result_id, job_id, total_score, brand_mention, text_similarity, image_similarity, risk_heuristic, scored_at | Final scores |

### Object storage (S3 / GCS)

- **Image artifacts** — listing images fetched during scoring are cached by URL hash. Subsequent jobs reuse the cached copy, avoiding re-fetching the same image.
- **Image embeddings** — the CLIP (ViT-B/32) embedding vectors computed for both reference and listing images are persisted (in pgvector or a dedicated vector store), so a listing seen again is never re-embedded.

### Cache (Redis)

- Rate-limit counters (per client, per marketplace)
- Reference image embeddings (hot path — avoid a DB/vector round-trip per listing)
- Job state for the polling endpoint (avoid hitting Postgres on every 1.5 s poll)

---

## Retry Strategy and Failure Handling

Each marketplace query task stores its own `status` and `error` in `marketplace_queries`. On failure:

1. **Transient errors** (network timeout, rate limit 429) → re-enqueue with exponential backoff, up to 3 retries.
2. **Permanent errors** (404, malformed response) → mark as `failed`, log the error, continue the job.
3. **Budget exhausted** → mark remaining queued tasks as `skipped`, transition the job to `complete` with `budget_exhausted = true`.

A dead-letter queue captures tasks that exhaust retries so they can be inspected and manually replayed.

---

## Request Budgets

Budgets are tracked at two levels:

- **Per-job budget** — total requests across all search + image fetches for this scan. Configurable per client tier.
- **Per-client daily budget** — prevents a single client from consuming all ScraperAPI quota.

The job coordinator checks the per-job budget before dispatching each child task. The API gateway checks the per-client daily budget before accepting a new job at all.

---

## Observability

### Metrics (e.g. Prometheus / Datadog)

| Metric | Why it matters |
|---|---|
| `request_count{type, marketplace, client}` | Track API spend by client and marketplace |
| `job_duration_seconds{status}` | SLA monitoring; detect slowdowns |
| `marketplace_error_rate{marketplace}` | Alert when ScraperAPI degrades |
| `score_distribution{bucket}` | Track false-positive rate over time (score > 75 vs. confirmed fakes) |
| `image_similarity_null_rate` | Indicates CDN URL rot or budget exhaustion |
| `queue_depth{queue}` | Alert on worker backlog |
| `worker_task_latency_seconds{task_type}` | Detect slow upstreams |

### Logs

Structured JSON logs per task: `job_id`, `client_id`, `task_type`, `marketplace`, `listing_id`, `duration_ms`, `error` (if any). Shipped to a log aggregator (e.g. Loki, CloudWatch) for ad-hoc querying.

### Tracing

Distributed traces (OpenTelemetry) span the full job lifecycle: API → queue publish → worker dequeue → upstream call → score → DB write. This makes it easy to find which step is slow for a given job.

---

## Preserving Explainability

Every `scored_result` row stores individual signal values and the weight configuration that was active at scoring time. This means:

- The UI can always reconstruct "why this score" for any result, even after model/weight updates.
- An audit trail exists for compliance: "on date X, listing Y was scored Z because of signals A, B, C".
- Weight changes are versioned (`scoring_configs` table with a `valid_from` timestamp), so historical scores remain reproducible.

---

## Human Review and Feedback Loop

Analysts can mark any scored result as `true_positive` (confirmed fake) or `false_positive` (legitimate listing wrongly flagged). This feedback is stored in a `result_reviews` table.

Over time, this data enables:

1. **Signal recalibration** — measure precision/recall per signal; adjust weights based on which signals correlate most with confirmed fakes.
2. **Threshold tuning** — measure false-positive rate at different score thresholds to help clients set their own alert cutoffs.
3. **Supervised re-scoring** — if enough labeled examples accumulate, train a lightweight classifier (e.g. logistic regression over the four signal scores) to replace or augment the hand-tuned weight table.
4. **Reference image updates** — when analysts confirm a listing is a fake, its image can be added as a new reference image, improving image-similarity coverage over time.

The key design principle is that the signals remain human-readable and individually logged even if the aggregation function changes, so analysts can always understand and contest a score.
