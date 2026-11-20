# Vida OS

The central operating system for Vida Estates: Phase 0 (foundation) and Phase 1 (revenue and cost), as defined in `Vida-Estates-PRD.docx` and `Vida-OS-Blueprint.docx`.

## Run it on this Mac

```bash
cd ~/Projects/vida-os
export PATH=~/.local/node/bin:$PATH
npm run dev
```

Then open http://localhost:3100.

Reset the demo data at any time (deletes the local demo database and rebuilds it):

```bash
npm run db:reset
```

## Demo logins (development only)

Every demo user shares the password **VidaDemo@2026**. All names, projects and numbers are fictional.

| Role | Email |
|---|---|
| Managing Director | md@vidaestates.demo |
| Finance Head | finance@vidaestates.demo |
| Accounts | accounts@vidaestates.demo |
| Sales Head | saleshead@vidaestates.demo |
| Sales Manager | salesmanager@vidaestates.demo |
| Sales Executive | arjun@vidaestates.demo, sneha@vidaestates.demo |
| GM Projects | gm@vidaestates.demo |
| Project Manager | pm.aurum@vidaestates.demo, pm.luxora@vidaestates.demo |
| Site Engineer | site@vidaestates.demo |
| Purchase Officer | purchase@vidaestates.demo |
| Storekeeper | stores@vidaestates.demo |
| HR | hr@vidaestates.demo |
| Marketing | marketing@vidaestates.demo |

## What is inside

- **Foundation:** sign-in, 13 roles with project-level access, an editable approval-limits engine (Control → Approval limits), a tamper-proof audit trail (the database itself refuses edits and deletes), and masters for projects, cost codes, vendors, channel partners and employees.
- **Revenue:** leads from every channel with duplicate checks, round-robin assignment and 15-minute escalation; pipeline; live inventory with 48-hour blocking and booking; payment plans, demand letters and receipts; channel-partner and incentive payouts.
- **Cost:** schedule and milestones (approving a milestone raises demand letters for that tower), daily site reports with photos, budgets with a budget gate on every order, material requests with 3 quotes, purchase orders with approvals, goods received, site stock, and vendor bills with a three-way match.
- **Reports:** MD dashboard, one-click monthly board pack (print or save as PDF), and an accounting export (CSV with cost centres, GST and TDS).
- **For the website:** `GET /api/public/projects` lists published projects with live "units left"; `POST /api/leads/web` takes enquiries (consent required).

## Moving to Supabase later

The app uses a local SQLite file today. To move to Supabase (Postgres): change `provider` in `prisma/schema.prisma` to `postgresql`, set `DATABASE_URL` to the Supabase connection string, then run `npx prisma db push` and `npm run db:seed`. The audit-trail triggers in `prisma/triggers.sql` need their Postgres equivalent at that point.

## Not in this phase

Contracts and running bills, land and approvals, full bookkeeping, HR and payroll, the AI assistant, portals, and the two-way WhatsApp inbox. See the Blueprint roadmap.

## Procurement engine

Menu: **Procurement engine** (Buying plan, Enquiries & comparisons, Materials & quantities, Messages sent).

1. **Materials & quantities:** each material has a vendor category, a lead time and a quote window; each milestone lists the quantities it needs.
2. **The engine** works back from every milestone's planned start: on site by → order by (minus lead time) → send enquiries on (minus quote window and 3 days for approval). It runs by itself every 10 minutes while anyone uses the procurement screens, on **Run engine now**, or from a scheduler: `GET /api/cron/procurement?key=CRON_KEY`.
3. **Enquiries** go to up to 5 vendors in the matching category, each with a personal quote link (`/rfq/<token>`, no login). Vendors who have not quoted are reminded a day before quotes close; if nobody quotes, quotes are extended 2 days once.
4. **Comparison statement:** landed cost (rate × qty + freight + GST), delivery against the need date and vendor rating give a score out of 100 (price 70, delivery 20, rating 10). With 2 or more quotes the recommended vendor is sent for approval automatically (approval limits: Control → Approval limits, "Vendor award").
5. **On final approval** the purchase order is raised automatically (held for a budget revision if over budget), and award and thank-you emails go to the vendors.

Settings in `.env`: `PUBLIC_OS_URL` (the address vendors' links use), `CRON_KEY`, `DEMO_MODE` ("false" hides the demo quote button), and for real email `RESEND_API_KEY` + `MAIL_FROM`. Until email is connected, messages wait in **Messages sent** as Queued, with one-click WhatsApp links.
