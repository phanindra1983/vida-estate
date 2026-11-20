import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { APPROVAL_ACTIONS, ROLE_LABEL } from "@/lib/constants";
import { inr } from "@/lib/format";
import { PageHeader, Card, Button, Notice } from "@/components/ui";

async function save(formData: FormData) {
  "use server";
  const user = await requireUser(["MD"]);
  const action = String(formData.get("action"));
  const before = await db.approvalRule.findMany({ where: { action }, orderBy: { level: "asc" } });
  const levels: { role: string; upTo: number | null }[] = [];
  for (let i = 1; i <= 4; i++) {
    const role = String(formData.get(`role${i}`) || "");
    if (!role) continue;
    const raw = String(formData.get(`upTo${i}`) || "").replace(/[^\d]/g, "");
    levels.push({ role, upTo: raw ? Number(raw) : null });
  }
  if (!levels.length) return;
  levels[levels.length - 1].upTo = null; // the last level always has no limit
  await db.$transaction(async (tx) => {
    await tx.approvalRule.deleteMany({ where: { action } });
    for (const [i, l] of levels.entries()) await tx.approvalRule.create({ data: { action, level: i + 1, role: l.role, upToAmount: l.upTo } });
    await audit(user, "UPDATE", "ApprovalRule", action, `Changed approval limits for ${APPROVAL_ACTIONS[action] ?? action}`,
      { before: before.map((b) => ({ role: b.role, upTo: b.upToAmount })), after: levels }, tx);
  });
  revalidatePath("/control/authority");
}

export default async function AuthorityPage() {
  await requireUser(["MD"]);
  const rules = await db.approvalRule.findMany({ orderBy: [{ action: "asc" }, { level: "asc" }] });
  const roles = Object.keys(ROLE_LABEL);

  return (
    <>
      <PageHeader eyebrow="Control" title="Approval limits" />
      <div className="mb-6">
        <Notice tone="neutral">
          Each request climbs the chain until it reaches the first person whose limit covers the amount. Example: with limits of ₹1 lakh and ₹10 lakh, a ₹38 lakh order needs all three levels. Open requests keep the chain they started with.
        </Notice>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {Object.entries(APPROVAL_ACTIONS).map(([action, label]) => {
          const levels = rules.filter((r) => r.action === action);
          return (
            <Card key={action} title={label}>
              <form action={save} className="grid gap-3">
                <input type="hidden" name="action" value={action} />
                {[1, 2, 3, 4].map((i) => {
                  const l = levels[i - 1];
                  return (
                    <div key={i} className="grid grid-cols-[2rem_1fr_9rem] items-center gap-2 text-sm">
                      <span className="text-stone">L{i}</span>
                      <select name={`role${i}`} defaultValue={l?.role ?? ""} className="input">
                        <option value="">Not used</option>
                        {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                      <input name={`upTo${i}`} defaultValue={l?.upToAmount ?? ""} placeholder="No limit" inputMode="numeric" className="input" aria-label={`Level ${i} limit in rupees`} />
                    </div>
                  );
                })}
                <p className="text-xs text-stone">
                  Now: {levels.map((l) => `${ROLE_LABEL[l.role]} ${l.upToAmount == null ? "(no limit)" : `up to ${inr(l.upToAmount)}`}`).join(" → ")}
                </p>
                <div><Button size="sm" variant="secondary">Save {label.toLowerCase()} limits</Button></div>
              </form>
            </Card>
          );
        })}
      </div>
    </>
  );
}
