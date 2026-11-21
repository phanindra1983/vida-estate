# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two parts of Vida Estates (a real estate developer in Hyderabad), in one Git repo (`phanindra1983/vida-estate`, public):

- **`vida-website/`**: the public marketing site. Static HTML (`index.html` holds all the markup, CSS and JS) with no build step. `config.js` sets `window.VIDA_OS_URL`, which points at localhost:3100 on this Mac and at the online Vida OS everywhere else. `index.html` loads it as `config.js?v=N`, so bump `N` whenever `config.js` changes.
- **`vida-os/`**: Vida OS, the company's internal system (sales/CRM, projects/PMO, cost and purchase, procurement engine, approvals, reports). Next.js 15 App Router, React 19, Prisma 6 on Postgres (Neon), Tailwind 4, TypeScript.

`vida-website-review/` is gitignored scratch material (design frames and prompts), not product code.

**Online:**
- Website: https://vida-estates.vercel.app. Vercel project `vida-estates`, deployed from the repo root. The root `.vercelignore` uploads only `vida-website/`.
- Vida OS: https://vida-os-eosin.vercel.app. Vercel project `vida-os`, deployed from `vida-os/`, region `sin1`. It uses Neon Postgres and Vercel Blob (for photos).
- Neither project is connected to Git. Deploys are manual: `npx vercel@latest deploy --prod --yes`, run from the matching directory.

## Commands (run in `vida-os/`)

Node is not on the default PATH. Run `export PATH=$HOME/.local/node/bin:$PATH` first.

```bash
npm run dev          # next dev on port 3100
npm run build        # prisma generate && next build
npm start            # next start -p 3100
npm run typecheck    # tsc --noEmit: the only automated check (no tests, no linter)
npm run db:push      # prisma db push, then install the audit-trail triggers (prisma/triggers.sql)
npm run db:seed      # demo data, for an EMPTY database only
node prisma/import-data.mjs   # (re)load materials and suppliers from prisma/data/*.json without touching other data
```

- **`db:reset` is disabled on purpose.** The database is the live online one.
- **Local runs need Neon access.** `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (used as `directUrl`) come from Vercel, via `vercel env pull <file>`. Don't write `.env.local` into `vida-os/`, because it overrides `.env`.
- **SQLite is legacy.** `prisma/dev.db` is the old local database, and `prisma/sqlite/` with `db:copy-from-sqlite` was the one-time move to Postgres.
- **Schema changes:** edit `prisma/schema.prisma`, then run `db:push` against the target database. There are no migration files.

## Architecture (vida-os)

**Auth and access.**
- `src/middleware.ts` checks the jose-signed `vida_session` cookie on every route except the public ones (`/login`, `/rfq/`, `/api/public`, `/api/leads/web|meta`, `/api/cron/procurement`).
- Every page and server action begins with `requireUser(ROLE_LIST)` from `src/lib/auth.ts`.
- Role lists such as `SALES_ROLES` and `PROCUREMENT_ROLES` live in `src/lib/constants.ts`.
- Roles in `ALL_PROJECT_ROLES` see every project. Everyone else is limited through `ProjectAccess`. Filter queries with `projectScope(u)` and check single records with `canSeeProject(u, id)`.

**Mutations.**
- Writes are server actions in `src/app/(app)/<area>/actions.ts`.
- They report back by redirecting with `?ok=` or `?error=`, using `done(to, msg)` and `fail(to, msg)` from `src/lib/cost.ts`. Pages show these as a `Notice`.
- Every change writes an `audit()` row (`src/lib/audit.ts`), usually inside the same `db.$transaction`. Postgres triggers make `AuditLog` append-only, so never update or delete its rows.

**Approvals.**
- `src/lib/approvals.ts`: `requiredLevels(action, amount)` reads the editable `ApprovalRule` table (Control → Approval limits) to decide how many levels and which roles must approve.
- `decide()` moves a request through its levels. Final approval triggers what follows, such as a PO from a vendor award, or demand letters from a milestone.

**Procurement engine** (`src/lib/procurement.ts`).
- It works back from each milestone's planned start: on-site date, then order-by (minus the lead time), then send-on (minus the quote window and `APPROVAL_DAYS`).
- It creates an RFQ, invites up to 5 vendors in the material's category, and gives each vendor a personal no-login link at `/rfq/<token>`.
- It sends reminders, extends quotes when none arrive, and scores quotes: price 70, delivery 20, rating 10.
- With 2 or more quotes it sends the recommended vendor for approval automatically. On approval it raises the PO and emails the vendors.
- It runs through `runEngineIfStale()` (at most every 10 minutes, when the procurement pages load) and through the Vercel cron. The cron (`vida-os/vercel.json`) calls `/api/cron/procurement` once a day, with `Authorization: Bearer CRON_SECRET` or `?key=CRON_KEY`.
- `Rfq.live` marks an enquiry that goes to real suppliers.

**Messaging** (`src/lib/notify.ts`).
- Email uses SMTP (Gmail), or Resend if configured. With no sender configured, emails are only queued in `OutboxMessage`, which shows as "Messages sent".
- `MAIL_TEST_TO` is test mode: every email goes to that address instead, except `sendEmail(..., { live: true })` for live RFQs.
- WhatsApp is only queued, with `wa.me` links from `waLink()`.
- Vendor-facing links come from `publicUrl()`, using `PUBLIC_OS_URL`.

**Website integration.**
- `GET /api/public/projects` returns the published projects and the units left.
- `POST /api/leads/web` takes enquiries (CORS `*`, consent required).
- Both lead routes (`/api/leads/web` and `/api/leads/meta`) go through `intakeLead()` in `src/lib/sales.ts`, which checks for duplicates, assigns leads round-robin and handles 15-minute escalation.

**Uploads.** `saveImages()` in `src/lib/cost.ts` writes to Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set. Otherwise it writes to `public/uploads/`.

**Data conventions.**
- Money is whole rupees (`Int`).
- Status fields are plain strings; the allowed values are listed in `src/lib/constants.ts`.
- IDs are string cuids.
- Use the formatters in `src/lib/format.ts` (`inr`, `date`, `docNo`, etc.) so the display stays consistent with the rest of the app (IST, Indian number format).
- Use the shared UI pieces in `src/components/ui` (`PageHeader`, `Card`, `Table`, `Status`, `Button`, `Notice`).

**Settings.** Settings are environment variables; see `vida-os/.env.example`.
- `DEMO_MODE="false"` hides the demo-only buttons.
- On Vercel they're set per project. The Gmail app password (`SMTP_PASS`) is added by the owner, not by Claude.

`vida-os/README.md` describes the features and the procurement flow. Its setup sections (SQLite, `db:reset`, demo password) are out of date: online, the staff accounts have their own passwords.
