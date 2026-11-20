import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { SALES_ROLES } from "@/lib/constants";
import { inr } from "@/lib/format";
import { effectiveStatus } from "@/lib/sales";
import { PageHeader, Card, Stat, Notice, cx } from "@/components/ui";
import { Flash, SubNav, one, type SP } from "../_ui";

export const dynamic = "force-dynamic";

function hoursLeft(d: Date | null) {
  if (!d) return "";
  const h = Math.max(0, Math.round((d.getTime() - Date.now()) / 3600000));
  return `${h}h`;
}

export default async function InventoryPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser([...SALES_ROLES, "FINANCE_HEAD"]);
  const sp = await searchParams;
  const projects = await db.project.findMany({
    where: u.projectIds === "ALL" ? {} : { id: { in: u.projectIds } },
    include: { towers: { orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });
  if (projects.length === 0) return <p className="text-sm text-stone">No projects are assigned to you yet.</p>;

  const project = projects.find((p) => p.id === one(sp.project)) ?? projects[0];
  const tower = project.towers.find((t) => t.id === one(sp.tower)) ?? project.towers[0];
  const type = one(sp.type) ?? "";

  const units = await db.unit.findMany({ where: { towerId: tower?.id ?? "-" }, orderBy: [{ floor: "desc" }, { number: "asc" }] });
  const all = await db.unit.findMany({ where: { projectId: project.id }, select: { status: true, blockedUntil: true, price: true } });
  const counts = { AVAILABLE: 0, BLOCKED: 0, BOOKED: 0 } as Record<string, number>;
  for (const x of all) counts[effectiveStatus(x)] = (counts[effectiveStatus(x)] ?? 0) + 1;

  const floors = [...new Set(units.map((x) => x.floor))];
  const types = [...new Set(units.map((x) => x.type))].sort();
  const q = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ project: project.id, tower: tower?.id ?? "", ...(type ? { type } : {}), ...patch });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/sales/inventory?${p.toString()}`;
  };

  return (
    <>
      <PageHeader eyebrow="Sales" title="Inventory" />
      <SubNav active="/sales/inventory" />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />

      <div className="mb-6 flex flex-wrap gap-2">
        {projects.map((p) => (
          <Link key={p.id} href={`/sales/inventory?project=${p.id}`} className={cx("min-h-10 rounded-full border px-4 py-2 text-sm", p.id === project.id ? "border-ink bg-ink text-white" : "border-line bg-white")}>{p.name}</Link>
        ))}
      </div>
      {!project.reraNo && (
        <div className="mb-6">
          <Notice tone="warn">{project.name} is awaiting TS RERA registration. Units can be viewed, but blocking and booking open only after registration. Record buyers as leads to register their interest.</Notice>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Total units" value={all.length} />
        <Stat label="Available" value={counts.AVAILABLE} tone="good" sub={`${Math.round((counts.AVAILABLE / Math.max(1, all.length)) * 100)}% of stock`} />
        <Stat label="Blocked" value={counts.BLOCKED} tone="warn" sub="Held for 48 hours" />
        <Stat label="Booked" value={counts.BOOKED} sub={inr(all.filter((x) => x.status === "BOOKED").reduce((s, x) => s + x.price, 0)) + " at list price"} />
      </div>

      <Card pad={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
          <div className="flex flex-wrap gap-2">
            {project.towers.map((t) => (
              <Link key={t.id} href={q({ tower: t.id })} className={cx("min-h-9 rounded-md px-3 py-1.5 text-sm", t.id === tower?.id ? "bg-[#f1eee8] font-medium" : "text-stone hover:text-ink")}>{t.name}</Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link href={q({ type: "" })} className={cx("rounded-md px-3 py-1.5", !type ? "bg-[#f1eee8] font-medium" : "text-stone")}>All types</Link>
            {types.map((t) => <Link key={t} href={q({ type: t })} className={cx("rounded-md px-3 py-1.5", type === t ? "bg-[#f1eee8] font-medium" : "text-stone")}>{t}</Link>)}
          </div>
        </div>
        <div className="flex flex-wrap gap-4 px-4 pt-4 text-xs text-stone">
          <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded-sm border border-[#c9dfd2] bg-[#eef6f1]" />Available</span>
          <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded-sm border border-[#ead6b2] bg-[#fbf4e6]" />Blocked (hours left)</span>
          <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded-sm bg-ink" />Booked</span>
        </div>
        <div className="overflow-x-auto p-4">
          <table className="border-separate border-spacing-1.5 text-xs">
            <tbody>
              {floors.map((f) => (
                <tr key={f}>
                  <th className="pr-2 text-right font-normal text-stone">F{f}</th>
                  {units.filter((x) => x.floor === f).map((x) => {
                    const st = effectiveStatus(x);
                    const dim = type && x.type !== type;
                    return (
                      <td key={x.id}>
                        <Link
                          href={`/sales/inventory/${x.id}`}
                          title={`${x.number} · ${x.type} · ${x.facing} · ${inr(x.price)}`}
                          className={cx(
                            "flex h-14 w-24 flex-col justify-center rounded-md border px-2 transition-opacity",
                            st === "AVAILABLE" && "border-[#c9dfd2] bg-[#eef6f1] text-good hover:border-good",
                            st === "BLOCKED" && "border-[#ead6b2] bg-[#fbf4e6] text-warn hover:border-warn",
                            st === "BOOKED" && "border-ink bg-ink text-white",
                            dim && "opacity-25",
                          )}
                        >
                          <span className="font-medium">{x.number}</span>
                          <span className="opacity-80">{x.type}{st === "BLOCKED" ? ` · ${hoursLeft(x.blockedUntil)}` : ` · ${inr(x.price)}`}</span>
                        </Link>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
