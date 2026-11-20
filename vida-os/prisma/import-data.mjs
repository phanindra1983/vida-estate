// Loads the high-rise materials master and the researched supplier database into Vida OS.
// Used by seed.mjs, and runnable on its own without touching other data:
//   node prisma/import-data.mjs
// Data files: prisma/data/materials.json and prisma/data/suppliers.json
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXTRA_CODES = [["13", "Formwork & temporary works"], ["14", "Doors, windows & facade"], ["15", "Fire & life safety"], ["16", "External development & amenities"]];

export async function importData(db) {
  const dir = new URL("./data/", import.meta.url);
  for (const [code, name] of EXTRA_CODES) await db.costCode.upsert({ where: { code }, create: { code, name }, update: {} });
  const codes = Object.fromEntries((await db.costCode.findMany()).map((c) => [c.code, c.id]));

  let mats = 0, vendors = 0, skipped = 0;
  if (existsSync(new URL("materials.json", dir))) {
    for (const m of JSON.parse(readFileSync(new URL("materials.json", dir), "utf8"))) {
      const data = { name: m.name, unit: m.unit, category: m.category, costCodeId: codes[m.costCode], leadTimeDays: m.leadTimeDays, quoteDays: m.quoteDays, refRate: m.refRate, specs: m.specs || null, package: m.package, norm: m.norm || null };
      await db.material.upsert({ where: { code: m.code }, create: { code: m.code, ...data }, update: data });
      mats++;
    }
  }
  if (existsSync(new URL("suppliers.json", dir))) {
    const existing = new Set((await db.vendor.findMany({ select: { name: true, category: true } })).map((v) => `${v.name.toLowerCase()}|${v.category}`));
    for (const s of JSON.parse(readFileSync(new URL("suppliers.json", dir), "utf8"))) {
      const key = `${s.name.toLowerCase()}|${s.category}`;
      if (!s.name || existing.has(key)) { skipped++; continue; }
      existing.add(key);
      await db.vendor.create({
        data: {
          name: s.name, category: s.category, type: s.type || null, brands: s.brands || null, area: s.area || null, address: s.address || null,
          phone: s.phone || null, email: s.email || null, website: s.website || null, sourceUrl: s.sourceUrl || null, notes: s.notes || null,
          rating: 3, verified: false, isDemo: false,
        },
      });
      vendors++;
    }
  }
  return { mats, vendors, skipped };
}

// Run directly: node prisma/import-data.mjs
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = new PrismaClient();
  importData(db).then((r) => console.log("Imported:", r)).finally(() => db.$disconnect());
}
