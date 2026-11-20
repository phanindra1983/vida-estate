import { db } from "@/lib/db";
import { requireUser, projectScope } from "@/lib/auth";
import { emailTestTo } from "@/lib/notify";
import { PageHeader, Card, Button, Field, Notice, Badge } from "@/components/ui";
import { newEnquiry } from "../../actions";

export const dynamic = "force-dynamic";

export default async function NewEnquiry({ searchParams }: { searchParams: Promise<{ material?: string; error?: string }> }) {
  const u = await requireUser(["MD", "GM_PROJECTS", "PROJECT_MANAGER", "PURCHASE"]);
  const sp = await searchParams;
  const [projects, materials] = await Promise.all([
    db.project.findMany({ where: u.projectIds === "ALL" ? {} : { id: { in: u.projectIds } }, orderBy: { name: "asc" } }),
    db.material.findMany({ where: { active: true }, orderBy: [{ package: "asc" }, { name: "asc" }] }),
  ]);
  const material = materials.find((m) => m.id === sp.material) ?? null;
  const vendors = material ? await db.vendor.findMany({ where: { category: material.category, active: true }, orderBy: [{ isDemo: "asc" }, { verified: "desc" }, { name: "asc" }] }) : [];
  const testTo = emailTestTo();
  void projectScope;

  return (
    <>
      <PageHeader eyebrow="Procurement engine" title="New enquiry" />
      {sp.error && <div className="mb-4"><Notice tone="bad">{sp.error}</Notice></div>}

      <Card title="1. Choose the material" className="mb-6">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="Material">
            <select name="material" defaultValue={material?.id ?? ""} className="input min-w-[22rem]">
              <option value="">Select…</option>
              {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}
            </select>
          </Field>
          <Button size="sm" variant="secondary">Show suppliers</Button>
        </form>
      </Card>

      {material && (
        <Card title={`2. Enquiry for ${material.name}`}>
          <form action={newEnquiry} className="grid gap-5">
            <input type="hidden" name="materialId" value={material.id} />
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Project and delivery site"><select name="projectId" className="input">{projects.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.location}</option>)}</select></Field>
              <Field label={`Quantity (${material.unit})`}><input name="qty" className="input" inputMode="decimal" required /></Field>
              <Field label="Needed on site by"><input name="needOnSite" type="date" className="input" required /></Field>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Suppliers ({material.category})</p>
              <div className="grid gap-2 md:grid-cols-2">
                {vendors.map((v) => (
                  <label key={v.id} className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm">
                    <input type="checkbox" name="vendorIds" value={v.id} className="mt-1 h-5 w-5 accent-[#121413]" />
                    <span className="flex-1">
                      <span className="font-medium">{v.name}</span> {v.isDemo ? <Badge>Demo</Badge> : v.verified ? <Badge tone="good">Verified</Badge> : <Badge tone="warn">To verify</Badge>}
                      <span className="block text-xs text-stone">{[v.email ? `Email: ${v.email}` : "No email", v.phone ? `Phone: ${v.phone}` : "No phone", v.area].filter(Boolean).join(" · ")}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <label className="flex items-start gap-3 rounded-lg border border-[#ead6b2] bg-[#fbf4e6] p-3 text-sm">
              <input type="checkbox" name="live" value="1" className="mt-1 h-5 w-5 accent-[#121413]" />
              <span><b>Send to the suppliers for real.</b> {testTo ? `Test mode is on: unless you tick this, emails go to ${testTo} instead.` : "Test mode is off: emails go to suppliers."} Suppliers without an email get a one-click WhatsApp link on the enquiry page.</span>
            </label>
            <Field label="Note for the file (optional)"><input name="note" className="input" /></Field>
            <div><Button>Send enquiry</Button></div>
          </form>
        </Card>
      )}
    </>
  );
}
