// Installs the append-only audit triggers (one statement per line in triggers.sql).
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
for (const stmt of readFileSync(new URL("./triggers.sql", import.meta.url), "utf8").split("\n").map((s) => s.trim()).filter(Boolean)) {
  await db.$executeRawUnsafe(stmt);
}
console.log("Audit triggers installed.");
await db.$disconnect();
