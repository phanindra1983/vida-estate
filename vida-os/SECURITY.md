# Vida OS security notes

Hardening on branch `security-hardening` (Umbrella audit, 23 Nov 2026). Tests: `npm test`.

## In place
- **Testing link** (`/try`): works in production only while Vercel env `TEST_LINK=on` and the `test.access` Setting is on with its key.
- **Website enquiries** (`/api/leads/web`): only from www/apex vidaestates.co.in (+ `ALLOWED_ORIGINS`), rate limits (5 per address per 10 min, 60 site-wide per 10 min, 3 per phone per hour), field caps, email check, plain errors. Website leads are never AI-called automatically, by Vida OS or by the n8n `ai-call` route, until a salesperson has called them.
- **Sign-in**: 10 tries per address and 5 per email in 15 minutes; failures logged as `LOGIN_FAILED` in the audit trail.
- **Record access**: receipts, booking status and enquiry actions check the record's project (`src/lib/access.ts`, unit-tested).
- **Sessions**: `AUTH_SECRET` is required in production.
- **Headers**: CSP (frame-ancestors none), X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, HSTS.
- **Cron**: only Vercel's `Authorization: Bearer CRON_SECRET`, compared in constant time. `?key=CRON_KEY` no longer works.
- **Public/partner routes** return our own validation text only; internal errors are logged, not shown.

## Needs owner
- Cloudflare Turnstile on the website form (free; needs a site key + secret) to stop bots spread across many addresses. In-memory rate limits are per server instance.
- Remaining `npm audit` items sit inside Prisma 6's CLI config (deepmerge-ts, effect), `@vercel/blob` → `@vercel/oidc` (zod) and Next's bundled postcss. Fixing them means a Prisma 7 / Blob major upgrade: plan separately.
