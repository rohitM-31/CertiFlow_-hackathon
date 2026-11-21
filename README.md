# CertiFlow: skilling certificate issuance

A training centre uploads **one CSV of passed candidates**. From then on the system runs the whole process itself:

**CSV validation → batch creation → multi-level approval → certificate + QR code → WhatsApp message → public verification**

Certificates are **never** created before every mandatory approval is complete.

Run it: [SETUP.md](SETUP.md) · Production plan: [DEPLOYMENT.md](DEPLOYMENT.md)

---

## 1. Requirements note

### Who does what

| Person | Role | Does |
|---|---|---|
| Anika | Training centre | Uploads the CSV (that's all); re-uploads a corrected CSV if a batch is sent back |
| Dev, Meera, Kabir | District officers (Pune) | Approve / send back / reject batches from **their district only** |
| Neha | Quality team | Reviews **large** batches after the district |
| Farah | State office | Final approval, sees what's stuck, cancels wrong certificates |
| Candidates | — | Receive the certificate on WhatsApp, download the PDF |
| Employers / public | No login | Verify a certificate by number or QR code |

### The automatic flow

```
Centre uploads CSV
   │  every row validated; ANY bad row → nothing saved, all problems listed
   ▼
Batch created + sent for approval  (one transaction)
   ▼
DISTRICT_REVIEW ── 2 officers approve ──► QUALITY_REVIEW (only if > 50 candidates) ──► STATE_REVIEW
   │ send back / reject (any stage)                                                     │ final approval
   ▼                                                                                    ▼
SENT_BACK ── centre uploads corrected CSV ──► DISTRICT_REVIEW (new round)            APPROVED
REJECTED (final)                                                                        │ automatic, in the background
                                                         one certificate per candidate ─┤
                                                         PDF with QR code ──────────────┤
                                                         WhatsApp message ──────────────┘──► ISSUED
Anyone: /verify/PSM-XXXXXXXXXX → genuine / cancelled / not found
```

### Decisions where the brief was unclear

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | When is a batch created? | **Only when a valid CSV is uploaded.** Upload, validation, batch creation and "send for approval" are one step, so there are no half-finished drafts. | The centre's job is "upload passed candidates"; everything else is the system's job. |
| D2 | "More than one officer must agree" | **2 different officers** from the batch's district *(configurable)*; the database allows one vote per person per stage per round. | The smallest number that means "more than one". |
| D3 | Officers disagree? | **One** send-back or reject stops the batch. | Approval needs agreement; objection doesn't. A problem one officer spotted shouldn't be outvoted. |
| D4 | "Big batch"? | **More than 50 candidates** *(configurable)* also needs the quality team. | The brief's example batch is 60. |
| D5 | **Moment 6:** approvals after send-back? | **Reset.** The corrected CSV starts a new round; only current-round votes count. Old votes stay in the history. | The candidate list may have changed; an approval of different data must not carry over. |
| D6 | When are certificates made? | **Only after the final (state) approval.** The certificate job is created in the *same transaction* as that approval, and the job itself refuses to run for a batch that isn't approved. | The user's explicit rule, enforced in two places. |
| D7 | Who is a candidate? | The **enrolment number**. One certificate per enrolment, ever (DB constraint). An enrolment already in another active batch is refused at upload. | "A candidate getting two certificates" must never happen. |
| D8 | WhatsApp is unreliable | Retries with exponential backoff; **idempotency key = certificate ID**, so a retry after a timeout never sends twice; one `Delivery` row per certificate. After 8 failed attempts: marked FAILED, visible to the state office. | **Moment 3:** exactly one certificate per phone. |
| D9 | "Too long" with an officer? | **60 minutes at one stage** *(configurable)*: flagged once, the state office is alerted live, and the batch shows in "stuck". | **Moment 5.** Short so it can be demoed; production might use 48h. |
| D10 | Cancelling | State office only, reason required; verification shows "cancelled" on the very next lookup; a cancelled certificate is never sent on WhatsApp. | **Moment 4.** |
| D11 | Privacy | Verification shows a masked name ("Aarav S."), course, centre and date only. The PDF download link needs a 256-bit secret token, not just the number. | "A stranger must never get someone else's certificate or details." |
| D12 | WhatsApp provider | No real account exists, so a **stand-in provider** (`/mock-whatsapp`) behaves like a real one: random 503s, and *accepted-but-timed-out* responses. A demo page shows "the candidate's phone". | The brief requires a stand-in that fails and times out. |

### Deviation from the brief (deliberate)

The brief lists **Redis** and **Docker** as mandatory. At the team's request this version runs on **Node.js + PostgreSQL only**, so it starts on a laptop without installing anything else. What Redis would have done is done by Postgres:

| Need | How it is met |
|---|---|
| Background job queue | A `Job` table; workers claim jobs with `SELECT … FOR UPDATE SKIP LOCKED` |
| Events between processes / live updates | Postgres `LISTEN` / `NOTIFY` |
| Fast public verification | One unique-index lookup (~1 ms); no cache, so nothing can be stale |
| Rate limiting | In memory, per instance (limitation noted below) |

Side benefit: jobs are written **in the same transaction** as the change that causes them, so "approved but certificates never generated" is impossible. With an external broker that needs an outbox pattern.

---

## 2. How it is put together

```
 React app (Vite) ──REST + WebSocket──► API (Express)  ×N ──┐
                                        • auth, CSV validation, approvals
                                        • Socket.IO, LISTENs for events
                                        • /mock-whatsapp (stand-in provider)
                                                            │ SQL
                                                            ▼
                                                     PostgreSQL ◄───────── Worker ×N
                                         data · audit log · Job queue        • issue-batch
                                         NOTIFY: jobs + live events          • render-pdf (QR)
                                                                             • send-whatsapp ──HTTP──► provider
                                                                             • sweep (SLA) every minute
```

**What happens on Farah's final approval:**
1. API: lock the batch row → record her decision → status `APPROVED` → write audit entries → **insert the `issue-batch` job** → commit (all or nothing). Her request returns immediately.
2. On commit, Postgres `NOTIFY` wakes a worker instantly (workers also poll every second).
3. `issue-batch`: one certificate per candidate, each together with its `render-pdf` job; batch → `ISSUED`.
4. `render-pdf`: PDF with a QR code linking to `/verify/<number>`, written atomically; then a `Delivery` row and a `send-whatsapp` job.
5. `send-whatsapp`: calls the provider with `Idempotency-Key = certificate id`; on failure the job retries with backoff (2s, 4s, 8s, …).
6. Every step `NOTIFY`s an event; each API instance pushes it to the right browsers, so pages update live.

### Key technical decisions

| Decision | Why |
|---|---|
| Every "must never happen" rule is a **database constraint** | Code has bugs and requests race; constraints don't. UNIQUE on certificate per candidate, per enrolment, and per number; one vote per person/stage/round; one delivery per certificate; a **trigger makes the audit log append-only**. |
| **Row lock** (`FOR UPDATE`) on decisions | **Moment 2.** Without it, two simultaneous approvals can each count only themselves (batch stuck) or both count two (batch moves twice). |
| **Job queue in Postgres with `SKIP LOCKED`** | Many workers, each job to exactly one; a crashed worker's job is reclaimed after 5 minutes; retries with backoff; transactional enqueue. |
| **Every job is idempotent** | A job can run twice (crash after work, before "done"). Proven by tests: running issuance twice concurrently still gives exactly one certificate each. |
| **Continuous worker pool** | Each free slot is refilled immediately, so a slow 3-second WhatsApp timeout doesn't block other jobs. (Found by watching the logs in a live run.) |
| **Identity only from the signed JWT**; role re-read from the DB on every request; HS256 pinned | Tampered bodies or `alg: none` tokens can't impersonate anyone. |
| **404 instead of 403** for records you may not see | Outsiders can't even learn a batch exists. |
| **Random certificate numbers** (`PSM-` + 10 chars, no 0/O/1/I) | Unguessable, not enumerable, readable aloud. |
| **Structured JSON logs + audit timeline** | Every batch's full story (`GET /api/batches/:id/timeline`): upload, each decision, each certificate, PDF, WhatsApp attempt, with who and when. |

### Layout

```
backend/
  prisma/schema.prisma          data model + constraints (migration adds the audit trigger)
  src/batches/csv.ts            CSV validation (pure)
  src/batches/workflow.ts       approval rules (pure)
  src/batches/service.ts        upload → batch, decisions, row locks
  src/certificates/             issuance, PDF + QR, verification, cancellation
  src/whatsapp/sender.ts        idempotent delivery     mockProvider.ts  stand-in provider
  src/queue.ts                  Postgres job queue      worker.ts        the worker process
  src/sweeper.ts                SLA escalation          realtime.ts      live updates
  tests/                        51 tests
frontend/src/pages/             Dashboard (CSV upload), Batch (pipeline tracker), Verify, Certificates, Phone (demo)
samples/                        good, bad, corrected and 60-candidate CSVs
```

---

## 3. Tests: 51, all passing, against a real PostgreSQL

| Requirement | Where |
|---|---|
| Moment 1: bad rows reported exactly, nothing (no batch) created | `moments.test.ts`, `csv.test.ts` |
| Certificates only after ALL approvals (and job created atomically with the final one) | `moments.test.ts` |
| Moment 2: three officers approve at once, batch moves once; double-click counts once | `moments.test.ts` |
| Moment 3: 60 candidates, issuance run concurrently + again, 60 certificates; provider failing + timing out, **exactly 60 messages, one per phone** | `moments.test.ts`, `pipeline.test.ts` |
| Timeout after the provider accepted, then retry: still one message | `pipeline.test.ts` |
| Moment 4: cancel, then verify says REVOKED; a cancelled certificate is never sent | `moments.test.ts`, `pipeline.test.ts` |
| Moment 5: escalation exactly once, shown in "stuck" | `moments.test.ts` |
| Moment 6: send back, corrected CSV, approvals reset | `moments.test.ts` |
| Queue: idempotent enqueue, rollback leaves no job, concurrent claims never overlap, backoff then FAILED | `pipeline.test.ts` |
| Never: wrong role/stage/district, forged / `alg:none` tokens, duplicate certificates or numbers, PII leaks, download without token, edited audit log | `never.test.ts`, `workflow.test.ts` |

**Verified live, beyond the tests:** API and worker as separate processes with the provider failing 20% and timing out 10%: a 20-candidate batch went from final approval to **20 delivered messages in 14 seconds**, 5 needing retries, **exactly one message per phone**.

---

## 4. Known limitations and next steps

- **Redis and Docker removed** (see "Deviation" above). For production, containerising the two Node processes is straightforward (DEPLOYMENT.md).
- The Postgres queue is comfortable for this load (about 25 jobs/s at peak); at 10× that, a dedicated broker would be worth it.
- Rate limiting is per API instance (in memory). Production should rate-limit at the edge.
- The stand-in provider keeps messages in API memory (lost on restart); its idempotency memory is too. Real providers persist this.
- Demo login (shared password, persona picker); production needs real accounts and MFA for officers.
- PDFs are stored on local disk; production: object storage with short-lived signed URLs.
- A cancelled certificate blocks re-issuing for that enrolment (no "re-issue" flow yet). The frontend has no automated tests.

## 5. AI usage

Built with Claude Code as a pair programmer. How the output was checked:
- Strict TypeScript and ESLint on every change; **51 automated tests** on real PostgreSQL; concurrency tests repeated several times.
- **Live end-to-end runs** with a deliberately unreliable provider, reading the worker logs.
- Problems these checks caught and fixed:
  - Timestamps compared with a plain `now()` would be off by the server's timezone (IST), so they're compared in UTC.
  - Prisma's dev database (PGlite) can't run concurrent transactions, so testing moved to real Postgres instead of weakening the tests.
  - Tests sharing the demo database left a backlog of about 1,300 jobs, which delayed the demo. Tests now use their own database.
  - The worker waited for a whole group of jobs, so one slow timeout blocked the other slots. It now refills each slot immediately.
