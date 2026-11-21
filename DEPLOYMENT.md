# Deployment plan

**Load:** 100,000 registered users, about 10,000 daily active. **Results-day peak: 500 batches approved in one hour, so about 30,000 PDFs and 30,000 WhatsApp messages.** Public verification: thousands of lookups a day, in bursts.

**Per second, that peak is small:** 30,000 / 3,600 ≈ 8.3 PDFs/s and 8.3 messages/s, so about 25 queue jobs/s including issuance. The goal is not raw scale; it is to **stay correct and drain the backlog predictably** while WhatsApp or the database misbehaves.

## 1. Architecture

```
 Browsers / employers ──► CloudFront (static React app from S3; caches /api/verify for 30 s)
                                   │
                                   ▼
                     Application Load Balancer (WebSockets on)
                                   │
                    ┌──────────────┴───────────────┐
                    ▼                              │
          API service ×2–6 (Node)                  │
          REST · Socket.IO · LISTEN events         │
                    │ SQL (via RDS Proxy)          │
                    ▼                              │
          ┌─────────────────────────┐              │
          │ RDS PostgreSQL Multi-AZ │ ◄────────────┤ SQL: claim jobs (SKIP LOCKED), NOTIFY
          │ data · audit · Job queue│              │
          └─────────────────────────┘     Worker service ×2–20 (Node, autoscaled on queue depth)
                                          issue-batch → render-pdf → send-whatsapp
                                                 │                        │
                                                 ▼                        ▼
                                          S3 (private PDFs)     WhatsApp Business Cloud API
```

**Event flow:** the final approval commits together with its `issue-batch` job → `NOTIFY` wakes a worker → one `render-pdf` job per certificate → one `send-whatsapp` job per certificate. Each step `NOTIFY`s a live event that every API instance pushes to its browsers.

## 2. Hosting and why

Region **AWS ap-south-1 (Mumbai)**: candidate personal data stays in India (DPDP Act expectations for a state programme), with low latency.

| Component | Where | Why |
|---|---|---|
| React app | S3 + CloudFront | Static files; nothing to run |
| API | ECS Fargate, ≥2 tasks across 2 AZs | Stateless; scales by adding tasks. The Node app is packaged into a container image by CI (the repo itself runs without Docker locally). |
| Worker | ECS Fargate, separate service, autoscaled on **pending-job count** | Scales independently of web traffic; PDF rendering is CPU-bound |
| PostgreSQL | RDS PostgreSQL 16, Multi-AZ, `db.t4g.large`, **RDS Proxy** | The single source of truth *and* the queue: managed backups, PITR, failover in about 1 minute; the proxy pools connections from many tasks. **Note:** `LISTEN` needs a direct (non-proxied) connection; each API/worker task keeps one. |
| PDFs | S3, private, SSE, versioning | Durable, cheap, signed URLs |
| Migrations | One-off task in the deploy pipeline (`prisma migrate deploy`) before new tasks start | Never run concurrently by many app instances |

## 3. Scaling

**Horizontal:** API tasks (stateless; live events fan out via Postgres NOTIFY) and worker tasks (`SKIP LOCKED` hands each job to exactly one worker; jobs are idempotent).

**Peak maths:**
- **PDFs:** about 150 ms CPU each, so 1 vCPU ≈ 6/s. 30,000 PDFs: **4 worker tasks × 1 vCPU** clears them in about 20 minutes; autoscaling adds tasks when more than 2,000 jobs are pending.
- **WhatsApp:** 8.3/s is well within Cloud API limits; we cap concurrency per worker to respect messaging tiers. Slow responses don't block other jobs (continuous worker pool).
- **Queue in Postgres:** about 25 jobs/s means roughly 75 small writes/s (claim, update, complete). Comfortable for `db.t4g.large`. The `(status, runAt)` index keeps claims fast; finished jobs are deleted after 7 days.
- **Verification bursts:** one unique-index lookup per request (~1 ms); CloudFront caches `/api/verify/*` for **30 s**, so a burst hits the database at most once per number per 30 s, and a cancellation still shows within a minute.

**What limits throughput at peak, in order:** PDF CPU (add workers), then database write capacity (scale the RDS instance up), then WhatsApp tier limits (by design).

**How the backlog clears:** pending jobs wait safely in the `Job` table; autoscaling adds workers on queue depth; the oldest pending job's age is on the dashboard. Nobody re-clicks anything.

**When to change the design:** at about 10× this load, queue writes start to compete with application writes. That's when to move jobs to a dedicated broker (SQS / RabbitMQ) using an outbox table.

## 4. Failure handling

| Failure | What happens | Why it's safe |
|---|---|---|
| **Worker crash mid-job** | The job stays `RUNNING` with a stale lock; after 5 minutes any worker reclaims it. ECS restarts the task. | Jobs are idempotent: UNIQUE constraints prevent a second certificate; PDFs are written to a temp file and renamed atomically; WhatsApp uses an idempotency key. |
| **No Redis to restart** | Not applicable: there is no Redis. The equivalent risk, a lost in-memory queue, can't happen because jobs live in Postgres and are written in the same transaction as the approval. | |
| **WhatsApp outage** | `send-whatsapp` jobs fail and retry with exponential backoff (2s … 10 min, 8 attempts, about 30 minutes). Longer outages: the state office re-queues FAILED deliveries (next step to build). Certificates are already issued and downloadable. Alert fires on the delivery failure rate. | Idempotency key = certificate ID, plus one `Delivery` row per certificate: a retry after a timeout never double-sends (tested). |
| **Slow database** | Everything depends on Postgres, so this is the critical one: `statement_timeout` (5s) and pool limits make requests fail fast with 503 instead of piling up; workers back off; alert on p95 query time and CPU. Long-term: a read replica for list/verify queries. | Transactions are short (a row lock is held for milliseconds); nothing is ever half-written. |
| **Database failover (Multi-AZ)** | About 1 minute of errors. API requests fail and are retried by users; workers retry claiming; `LISTEN` connections reconnect automatically. | Committed work is durable; uncommitted work rolled back; jobs resume. |
| **API task dies** | ALB health check removes it; browsers reconnect their WebSocket to another task and refetch. | No session state in memory (JWT); events are only notifications. |

## 5. Certificate files and access control

- PDFs in a **private** S3 bucket (Block Public Access, SSE-S3, versioning). Key: `certificates/{number}.pdf`.
- The WhatsApp link contains a **256-bit secret token**. The API checks it in constant time, checks the certificate isn't cancelled, then redirects to a **5-minute pre-signed S3 URL**. The bucket is never public.
- Officers reach files only through the API (role and district checks). Cancelling a certificate makes its link return **410 Gone** immediately and stops any pending WhatsApp send.
- Lifecycle: S3 Infrequent Access after 90 days.

## 6. Monitoring and alerting

- **Logs:** structured JSON to CloudWatch Logs; filter by `batchId`, `certificateId`, `jobId` or `requestId` to trace one batch end to end. The audit table is the business-level trace (also shown in the UI per batch).
- **Metrics:** API p95 latency and 5xx rate; **pending jobs by type, oldest pending job age, failed jobs/min**; PDFs/min; WhatsApp delivered/failed per minute; SLA escalations/hour; DB CPU, connections, slow queries, replication lag.
- **Alerts:** 5xx > 1% for 5 min; oldest pending job > 15 min; any job in FAILED; WhatsApp failure rate > 10%; DB CPU > 80% or connections > 80%.
- **Results-day dashboard:** pending jobs vs. running workers vs. drain rate.

## 7. Rough monthly cost (ap-south-1, on demand, approximate)

| Item | USD / month |
|---|---|
| ECS Fargate: API 2 × (0.5 vCPU, 1 GB) | ~$30 |
| ECS Fargate: workers 2 baseline + peak bursts | ~$45 |
| RDS PostgreSQL `db.t4g.large` Multi-AZ + 100 GB + RDS Proxy | ~$260 |
| ALB | ~$25 |
| NAT gateway (workers call WhatsApp) | ~$40 |
| S3 + CloudFront | ~$15 |
| CloudWatch | ~$25 |
| **Infrastructure total** | **~$440** |
| WhatsApp messages (~8,000/month at Meta utility-template rates; check current pricing) | small next to infrastructure |

**Trade-offs:**
- **No Redis / broker** saves about $50–100/month and one system to operate, but puts all the eggs in the Postgres basket. That's why the database is a size larger and Multi-AZ.
- **Multi-AZ doubles the database cost.** Worth it: results day is the one day the system must not fail. A pilot could run single-AZ.
- **Fargate costs more per vCPU than EC2** but needs no server management for a small team. Fargate Spot for workers would cut that line by about 60% (jobs are idempotent, so interruptions are safe).
