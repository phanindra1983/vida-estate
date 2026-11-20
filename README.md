# Vida Estates

Two parts:

- **[vida-website](vida-website/)**: the public website (static HTML). Open `index.html` through any web server, e.g. `python3 -m http.server 4400`. `config.js` sets where it finds Vida OS.
- **[vida-os](vida-os/)**: Vida OS, the company's operating system (sales and CRM, projects and PMO, procurement engine, HR, finance and MIS, approvals). Next.js, Prisma and SQLite. See [vida-os/README.md](vida-os/README.md).

## Run Vida OS

```bash
cd vida-os
cp .env.example .env      # then fill in AUTH_SECRET (and email settings if needed)
npm install
npm run db:reset          # creates the database with demo data
npm run build && npx next start -p 3100
```

Secrets (`.env`) and the database (`prisma/dev.db`) are not in this repository.
