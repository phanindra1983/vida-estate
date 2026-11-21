# Vida Estates

Two parts:

- **[vida-website](vida-website/)**: the public website (static HTML). Open `index.html` through any web server, e.g. `python3 -m http.server 4400`. `config.js` sets where it finds Vida OS.
- **[vida-os](vida-os/)**: Vida OS, the company's operating system (sales and CRM, projects and PMO, procurement engine, HR, finance and MIS, approvals). Next.js, Prisma and Postgres (Neon). See [vida-os/README.md](vida-os/README.md).

## Run Vida OS

```bash
cd vida-os
cp .env.example .env      # then fill in AUTH_SECRET (and email settings if needed)
npm install
# set DATABASE_URL and DATABASE_URL_UNPOOLED to a Postgres database
npm run db:push           # creates the tables and the audit-trail triggers
npm run build && npx next start -p 3100
```

## Online

- Website: https://vida-estates.vercel.app (Vercel project `vida-estates`, root `vida-website`)
- Vida OS: https://vida-os-eosin.vercel.app (Vercel project `vida-os`, Neon Postgres and Vercel Blob in Singapore, daily procurement run at 08:00 IST)

Secrets (`.env`, Vercel settings) and the old local database (`prisma/dev.db`) are not in this repository.
