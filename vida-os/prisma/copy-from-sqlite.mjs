// One-time move: copies every row from the old SQLite file (prisma/dev.db) into the
// Postgres database in DATABASE_URL. Refuses if the target already has users.
import { readFileSync } from "node:fs";
import { PrismaClient as Pg } from "@prisma/client";
import { PrismaClient as Lite } from "../node_modules/.prisma/sqlite-client/index.js";

const pg = new Pg();
const lite = new Lite();
const models = [...readFileSync(new URL("./schema.prisma", import.meta.url), "utf8").matchAll(/^model (\w+)/gm)].map((m) => m[1]);
const key = (m) => m[0].toLowerCase() + m.slice(1);

if ((await pg.user.count()) > 0) { console.error("The online database already has data. Stopping."); process.exit(1); }

let pending = models;
for (let pass = 1; pending.length && pass <= 5; pass++) {
  const failed = [];
  for (const m of pending) {
    const rows = await lite[key(m)].findMany();
    try {
      for (let i = 0; i < rows.length; i += 500) await pg[key(m)].createMany({ data: rows.slice(i, i + 500), skipDuplicates: true });
      console.log(`${m}: ${rows.length}`);
    } catch (e) {
      failed.push(m);
      if (pass === 5) console.error(m, String(e).slice(0, 300));
    }
  }
  pending = failed;
}
if (pending.length) { console.error("Not copied:", pending.join(", ")); process.exit(1); }
console.log("All data copied.");
await pg.$disconnect(); await lite.$disconnect();
