import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { runControls, type ControlResult } from "@/lib/controls";
import { PageHeader, Card, Stat } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";
const ROLES = ["MD", "FINANCE_HEAD", "SALES_HEAD", "GM_PROJECTS"];
const DOT = { GREEN: "🟢", AMBER: "🟡", RED: "🔴" } as const;
const AREAS: ControlResult["area"][] = ["Sales", "Collections", "Projects", "Cost", "Governance", "People"];

export default async function ControlsPage() {
  const u = await requireUser(ROLES);
  const rows = await runControls(u.projectIds);
  const n = (r: ControlResult["rag"]) => rows.filter((x) => x.rag === r).length;
  const order = { RED: 0, AMBER: 1, GREEN: 2 } as const;

  return (
    <>
      <PageHeader eyebrow="Control" title="Controls">
        <PrintButton label="Print / PDF" />
      </PageHeader>
      <p className="mb-6 max-w-3xl text-sm text-stone">
        The key controls of the business, tested automatically from live data, the way an internal audit control register works. Each control names the risk it covers, who owns it and its target. 🟢 meets target · 🟡 close · 🔴 breached. Open any red to see the records behind it.
      </p>
      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat label="🔴 Breached" value={n("RED")} tone={n("RED") ? "bad" : "good"} sub="Act this week" />
        <Stat label="🟡 Close" value={n("AMBER")} tone={n("AMBER") ? "warn" : undefined} sub="Watch" />
        <Stat label="🟢 Working" value={n("GREEN")} tone="good" sub={`of ${rows.length} controls`} />
      </div>

      <div className="grid gap-6">
        {AREAS.map((area) => {
          const list = rows.filter((r) => r.area === area).sort((a, b) => order[a.rag] - order[b.rag]);
          if (!list.length) return null;
          return (
            <Card key={area} title={area} pad={false}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-stone">
                    <tr className="border-b border-line"><th className="w-10 px-3 py-2.5" /><th className="px-3 py-2.5">Control</th><th className="px-3 py-2.5">Owner · how often</th><th className="px-3 py-2.5">Target</th><th className="px-3 py-2.5">Today</th><th className="px-3 py-2.5" /></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {list.map((r) => (
                      <tr key={r.id} className="align-top">
                        <td className="px-3 py-3 text-lg">{DOT[r.rag]}</td>
                        <td className="px-3 py-3"><p className="font-medium">{r.name}</p><p className="text-xs text-stone">Risk: {r.risk}</p></td>
                        <td className="px-3 py-3 text-xs">{r.owner}<br /><span className="text-stone">{r.frequency}</span></td>
                        <td className="px-3 py-3 text-xs">{r.target}</td>
                        <td className={`px-3 py-3 text-xs ${r.rag === "RED" ? "font-medium text-bad" : ""}`}>{r.result}</td>
                        <td className="px-3 py-3">{r.link && <Link href={r.link} className="no-print text-xs underline underline-offset-4">Open</Link>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-stone">Built-in controls that cannot be broken in Vida OS: approval limits by amount, every change in the audit trail, budget check before every order, three-way match before a bill is payable, lost leads need a reason, unit holds expire after 48 hours.</p>
    </>
  );
}
