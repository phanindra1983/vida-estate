import { db } from "@/lib/db";
import { requireUser, projectScope } from "@/lib/auth";
import { timing } from "@/lib/procurement";
import { date, num } from "@/lib/format";
import { PageHeader, Card, Table, Button, Field, Notice } from "@/components/ui";
import { saveMaterial, addMaterial, addRequirement, removeRequirement } from "../actions";

export const dynamic = "force-dynamic";

export default async function Setup({ searchParams }: { searchParams: Promise<{ tab?: string; ok?: string; error?: string }> }) {
  const u = await requireUser(["MD", "GM_PROJECTS", "PROJECT_MANAGER", "PURCHASE"]);
  const sp = await searchParams;
  const tab = sp.tab === "quantities" ? "quantities" : "materials";
  const [materials, codes, vendorCats] = await Promise.all([
    db.material.findMany({ orderBy: [{ package: "asc" }, { code: "asc" }] }),
    db.costCode.findMany({ orderBy: { code: "asc" } }),
    db.vendor.groupBy({ by: ["category"], _count: true }),
  ]);
  const vc = new Map(vendorCats.map((c) => [c.category, c._count]));

  return (
    <>
      <PageHeader eyebrow="Procurement engine" title="Materials & quantities" />
      {sp.ok && <div className="mb-4"><Notice tone="good">{sp.ok}</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="bad">{sp.error}</Notice></div>}
      <nav className="mb-6 flex gap-1 border-b border-line">
        {[["materials", "Materials and lead times"], ["quantities", "Quantities per milestone"]].map(([k, l]) => (
          <a key={k} href={`?tab=${k}`} className={`-mb-px min-h-11 border-b-2 px-4 py-3 text-sm ${tab === k ? "border-ink font-medium" : "border-transparent text-stone hover:text-ink"}`}>{l}</a>
        ))}
      </nav>

      {tab === "materials" ? (
        <div className="grid gap-6">
          <Card pad={false}>
            <Table head={["Material", "Vendor category", "Lead time (days)", "Quote window (days)", "Last rate (₹)", ""]}>
              {materials.map((m) => (
                <tr key={m.id}>
                  <td><p className="font-medium">{m.name}</p><p className="text-xs text-stone">{m.package ? `${m.package} · ` : ""}{m.code} · per {m.unit}{m.specs ? ` · ${m.specs}` : ""}</p>{m.norm && <p className="text-xs text-stone">Planning norm: {m.norm}</p>}</td>
                  <td>{m.category}<p className={`text-xs ${(vc.get(m.category) ?? 0) < 3 ? "text-bad" : "text-stone"}`}>{vc.get(m.category) ?? 0} vendor(s)</p></td>
                  <td colSpan={4}>
                    <form action={saveMaterial} className="grid grid-cols-[6rem_6rem_8rem_auto] items-center gap-2">
                      <input type="hidden" name="id" value={m.id} />
                      <input name="leadTimeDays" defaultValue={m.leadTimeDays} className="input" inputMode="numeric" aria-label={`Lead time for ${m.name}`} />
                      <input name="quoteDays" defaultValue={m.quoteDays} className="input" inputMode="numeric" aria-label={`Quote window for ${m.name}`} />
                      <input name="refRate" defaultValue={m.refRate ?? ""} className="input" inputMode="decimal" aria-label={`Last rate for ${m.name}`} />
                      <Button size="sm" variant="secondary">Save</Button>
                    </form>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Add a material">
            <form action={addMaterial} className="grid gap-4 md:grid-cols-4">
              <Field label="Name"><input name="name" className="input" required /></Field>
              <Field label="Unit"><input name="unit" className="input" placeholder="MT, cum, bags, nos, lot" /></Field>
              <Field label="Vendor category" hint="Must match the vendors' category">
                <select name="category" className="input">{[...vc.keys()].sort().map((c) => <option key={c}>{c}</option>)}</select>
              </Field>
              <Field label="Cost code"><select name="costCodeId" className="input">{codes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></Field>
              <Field label="Lead time (days)"><input name="leadTimeDays" className="input" inputMode="numeric" defaultValue={14} /></Field>
              <Field label="Quote window (days)"><input name="quoteDays" className="input" inputMode="numeric" defaultValue={5} /></Field>
              <Field label="Last rate (₹ per unit)"><input name="refRate" className="input" inputMode="decimal" /></Field>
              <Field label="Specification"><input name="specs" className="input" /></Field>
              <div><Button size="sm">Add material</Button></div>
            </form>
          </Card>
        </div>
      ) : (
        <Quantities u={u} materials={materials} />
      )}
    </>
  );
}

async function Quantities({ u, materials }: { u: Awaited<ReturnType<typeof requireUser>>; materials: { id: string; name: string; unit: string; leadTimeDays: number; quoteDays: number }[] }) {
  const [reqs, milestones] = await Promise.all([
    db.materialRequirement.findMany({ where: projectScope(u), include: { material: true, rfqs: { select: { status: true } } } }),
    db.milestone.findMany({ where: { ...projectScope(u), status: { not: "DONE" } }, include: { project: true }, orderBy: [{ projectId: "asc" }, { plannedStart: "asc" }] }),
  ]);
  const ms = new Map(milestones.map((m) => [m.id, m]));
  const rows = reqs.filter((r) => ms.has(r.milestoneId)).sort((a, b) => ms.get(a.milestoneId)!.plannedStart.getTime() - ms.get(b.milestoneId)!.plannedStart.getTime());

  return (
    <div className="grid gap-6">
      <Card title="Add a quantity" >
        <form action={addRequirement} className="grid gap-4 md:grid-cols-5">
          <Field label="Milestone"><select name="milestoneId" className="input">{milestones.map((m) => <option key={m.id} value={m.id}>{m.project.name} · {m.name} ({date(m.plannedStart)})</option>)}</select></Field>
          <Field label="Material"><select name="materialId" className="input">{materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}</select></Field>
          <Field label="Quantity"><input name="qty" className="input" inputMode="decimal" required /></Field>
          <Field label="On site days before start" hint="Safety buffer"><input name="buffer" className="input" inputMode="numeric" defaultValue={7} /></Field>
          <div className="self-end"><Button size="sm">Add to buying plan</Button></div>
        </form>
      </Card>
      <Card pad={false}>
        <Table head={["Milestone", "Material", { label: "Quantity", num: true }, "Starts", "Order by", "Enquiry on", ""]} empty="No quantities yet.">
          {rows.map((r) => {
            const m = ms.get(r.milestoneId)!;
            const t = timing(m.plannedStart, r, r.material);
            return (
              <tr key={r.id}>
                <td>{m.name}<p className="text-xs text-stone">{m.project.name}</p></td>
                <td>{r.material.name}</td>
                <td className="num">{num(r.qty)} {r.material.unit}</td>
                <td className="whitespace-nowrap">{date(m.plannedStart)}</td>
                <td className="whitespace-nowrap">{date(t.orderBy)}</td>
                <td className="whitespace-nowrap">{date(t.sendOn)}</td>
                <td className="text-right">
                  {r.rfqs.every((x) => x.status === "CANCELLED") && (
                    <form action={removeRequirement}><input type="hidden" name="id" value={r.id} /><Button size="sm" variant="ghost">Remove</Button></form>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <p className="text-xs text-stone">Change a milestone&apos;s planned dates in the schedule and every order-by and enquiry date here moves with it.</p>
    </div>
  );
}
