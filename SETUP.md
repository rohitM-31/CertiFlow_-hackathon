# Local setup

You need **Node.js 22+** and **PostgreSQL 14+**. Nothing else: no Redis, no Docker.

Commands below are for **Windows PowerShell** (the VS Code terminal). On macOS/Linux use `cp` instead of `Copy-Item`.

---

Backend: 
npm run dev  -- API 
npm run dev:worker -- Worker
 Run in Two Different terminals

Front end: 
npm run dev 

## 1. Backend setup

The backend is **two programs** that share one PostgreSQL database:

| Program | Command | Job |
|---|---|---|
| **API** | `npm run dev` | Website requests: login, CSV upload, approvals, verification, live updates. Port **4000**. |
| **Worker** | `npm run dev:worker` | Background work after final approval: certificates, PDFs with QR codes, WhatsApp messages, SLA checks |

### Step 1.1: Find your PostgreSQL server (port and password)

You need to know **which port** your PostgreSQL listens on and **its password**.

- One PostgreSQL installed: it's almost always port **5432**.
- **Several versions installed** (e.g. 17, 18 and 19): each runs as a separate server on its own port (5432, 5433, 5434…), with its own databases and possibly its own password. **Pick one and use it everywhere**: in pgAdmin, in `.env` and for the tests. Otherwise you'll create a database on one server and the app will look for it on another.

To see which servers are running, press Win+R, type `services.msc`, and look for `postgresql-x64-NN`. In pgAdmin, right-click a server, choose **Properties**, then **Connection**, to see its port.

### Step 1.2: Create the two databases

Use the **same server** you picked in step 1.1.

**pgAdmin:** go to **Servers → PostgreSQL NN → Databases**. Right-click **Databases** and choose **Query Tool**. Run each line **on its own** (select the line, then press F5):

```sql
CREATE DATABASE certiflow;
```
```sql
CREATE DATABASE certiflow_test;
```

**Or psql (SQL Shell):**
```
CREATE DATABASE certiflow;
CREATE DATABASE certiflow_test;
\q
```

- `certiflow` holds the app and demo data.
- `certiflow_test` is used only by the automated tests. Keep it separate, or test data piles up in your demo.
- If you get `CREATE DATABASE cannot run inside a transaction block`, you ran several statements at once in pgAdmin. Run each `CREATE DATABASE` on its own.

### Step 1.3: Create the `.env` file

```powershell
cd backend
Copy-Item .env.example .env
```

Open `backend/.env` and edit **one line**:

```
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/certiflow"
```

| Part | Set it to |
|---|---|
| `postgres` | Your PostgreSQL username (default `postgres`) |
| `YOUR_PASSWORD` | Your PostgreSQL password, **URL-encoded** (see below) |
| `5432` | The port from step 1.1 |
| `certiflow` | Leave as is |

**URL-encoding the password:** some characters have a special meaning in a URL and must be replaced:

| Character | Write it as | Example |
|---|---|---|
| `@` | `%40` | `Rohith@1274` → `Rohith%401274` |
| `#` | `%23` | `pass#1` → `pass%231` |
| `/` | `%2F` | |
| `:` | `%3A` | |
| `%` | `%25` | |

The line must start with `DATABASE_URL="postgresql://…`. Don't paste `DATABASE_URL=` twice.

The other settings in `.env` already have working defaults:

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | API port |
| `JWT_SECRET` | dev value | Signs login tokens. Change it in production. |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Base of links in WhatsApp messages and QR codes |
| `SLA_MINUTES` | `60` | How long a batch may wait at one stage before escalation |
| `DISTRICT_APPROVALS_REQUIRED` | `2` | Officers needed at the district stage |
| `LARGE_BATCH_THRESHOLD` | `50` | More candidates than this also needs the quality team |
| `MOCK_WHATSAPP_FAILURE_RATE` / `_TIMEOUT_RATE` | `0.2` / `0.1` | How often the stand-in WhatsApp provider fails on purpose. Use `0` for a calm demo. |

### Step 1.4: Install, create the tables, and add demo data

Still in the `backend` folder:

```powershell
npm install          # downloads packages and generates the Prisma client
npm run db:migrate   # creates the 10 tables (runs prisma/migrations/*/migration.sql)
npm run db:seed      # adds demo people, batches and certificates
```

Expected output:
- `db:migrate`: `All migrations have been successfully applied.`
- `db:seed`: `Seed: demo data created. Password for every demo user: demo123`

`db:seed` is safe to run again: it does nothing if the demo data already exists (`Seed: demo data already present, skipping.`).

**Check it worked:** in pgAdmin, right-click the **`certiflow`** database (on the same server), choose **Query Tool**, and run:

```sql
SELECT username, name, role FROM "User";
```

You should see 6 rows: anika, dev, meera, kabir, neha and farah. Table names need **double quotes** because they start with a capital letter. If you get `relation "User" does not exist`, the Query Tool is on the wrong database or the wrong server (see step 1.1).

### Step 1.5: Start the API and the worker

Open **two terminals** (the **+** button in VS Code's terminal panel). Both must stay open while you use the app.

**Terminal 1: API**
```powershell
cd C:\path\to\algohire_hackathon\backend
npm run dev
```
Wait for: `{"level":"info","msg":"api listening","port":4000}`

**Terminal 2: worker**
```powershell
cd C:\path\to\algohire_hackathon\backend
npm run dev:worker
```
Wait for: `{"level":"info","msg":"worker started",…}`

Both scripts exist only in the **`backend`** folder. If you see `Missing script: "dev:worker"`, that terminal is in `frontend`; `cd` into `backend` first.

**Check the API works:** open http://localhost:4000/health in a browser. It should show `{"status":"ok"}`.

### Backend troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `P1013: The provided database string is invalid` | `DATABASE_URL` is badly formed | Check for a doubled `DATABASE_URL=` and quotes; URL-encode `@` as `%40` |
| `Can't reach database server at <odd name>` | A raw `@` in the password split the URL | Write `@` as `%40` |
| `Can't reach database server at localhost:5432` | PostgreSQL isn't running, or is on another port | Start the `postgresql-x64-NN` service in `services.msc`; check the port |
| `password authentication failed` | Wrong password for **that** server | Each installed version can have its own password |
| `database "certiflow" does not exist` | Database not created on **this** server | Step 1.2, on the server/port that `.env` points to |
| `relation "User" does not exist` (pgAdmin) | Query Tool connected to `postgres` or another server | Right-click **certiflow** under the right server, then **Query Tool** |
| `EADDRINUSE: address already in use :::4000` | Another program (or an old API) is using port 4000 | Close the old terminal, or set `PORT=4001` **and** `WHATSAPP_API_URL="http://localhost:4001/mock-whatsapp"` |
| Website shows **502 Bad Gateway** / `ECONNREFUSED` | The API (terminal 1) isn't running | Start `npm run dev` in `backend` |
| Approvals work but certificates never appear | The worker (terminal 2) isn't running | Start `npm run dev:worker` in `backend` |
| `Prisma Migrate detected that it was invoked by Claude Code` | Prisma blocks destructive commands like `migrate reset` from AI tools | Run it yourself in a normal terminal if you really want to wipe the database |

### Useful backend commands

| Command (in `backend`) | Does |
|---|---|
| `npm run dev` | Start the API (auto-restarts when you edit code) |
| `npm run dev:worker` | Start the worker |
| `npm run db:migrate` | Apply new migrations |
| `npm run db:seed` | Add demo data (skips if present) |
| `npm run db:studio` | Open Prisma Studio, a browser view of every table |
| `npm run typecheck` | Check TypeScript types |
| `npm test` | Run the tests (see section 3) |
| `npm run build`, then `npm start` and `npm run start:worker` | Production build and start |

---

## 2. Frontend

```bash
cd frontend
npm install
npm run dev                     # http://localhost:5173
```

Open **http://localhost:5173**. The API (terminal 1) must be running, or the page shows 502 errors.

## 3. Tests

Run these in a **separate terminal** (terminal 4). The setting only applies to that terminal, so the running app keeps using `certiflow`.

```powershell
cd backend
# point this terminal at the TEST database (same server, port and encoded password as .env)
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/certiflow_test"
npx prisma migrate deploy      # first time only: creates the tables in certiflow_test
npm test
```

Expected: `Test Files 5 passed`, `Tests 51 passed`.

Close this terminal afterwards. If you run the API from it, the API would use the test database.

> Don't use `npx prisma dev` as the test database: it runs PGlite, which can't handle concurrent transactions, so the concurrency tests fail for that reason alone.

---

## Demo walkthrough (about 2 minutes)

All demo passwords are `demo123`; the login screen picks a person in one click. **Each browser tab keeps its own login**, so put two people side by side to watch live updates.

| # | Who | Do | You should see |
|---|---|---|---|
| 1 | Anika | Upload `samples/bad-batch.csv` (any course name) | Every problem listed by row and column; **no batch created** |
| 2 | Anika | Upload `samples/good-batch.csv` | Batch created and already in **District review**; the tracker shows "CSV validated"; certificates column says "after final approval" |
| 3 | Dev (tab 1) + Meera (tab 2) | Both approve the new batch | Each tab updates live; after the 2nd approval it moves to **State review** |
| 4 | Farah | Approve it | Approved, then within seconds: certificate numbers, PDFs, then WhatsApp "Delivered" (some show "retry 1": the stand-in provider fails on purpose) |
| 5 | anyone | Open **Candidate's phone (demo)** | One message per candidate with the download link; open it and get the PDF with the QR code |
| 6 | anyone | Scan the QR / open **Verify**, enter a number (or `PSM-DEMO000001`) | "Genuine certificate", masked name |
| 7 | Farah | Cancel a certificate, verify it again | "NOT VALID: cancelled" immediately |
| 8 | Anika | Open **"Electrician - Domestic"** (sent back), upload `samples/corrected-batch.csv` | Back in district review, round 2; earlier approvals don't count |
| 9 | Dev + Kabir | Approve **"Data Entry Operator"** (60 candidates) | Goes to **Quality review** (Neha) before the state |
| 10 | Farah | Dashboard | **"Stuck past the SLA"** shows "Beauty Therapist" (the worker flags it within a minute) |
| 11 | anyone | Any batch → **History** | Every step: upload, decisions, certificates, PDFs, WhatsApp attempts, with who and when |

Known demo certificates: `PSM-DEMO000001` (valid), `PSM-DEMO000002` (cancelled).

### Tuning the stand-in WhatsApp provider

In `backend/.env`: `MOCK_WHATSAPP_FAILURE_RATE=0.2` and `MOCK_WHATSAPP_TIMEOUT_RATE=0.1`. Set both to `0` for a calm demo, or raise them to show retries.
