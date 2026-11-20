import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { LEAD_STAGES, SALES_ROLES } from "@/lib/constants";
import { ago } from "@/lib/format";
import { leadScope, needsEscalation } from "@/lib/sales";
import { PageHeader, Badge } from "@/components/ui";
import { changeStage } from "../actions";
import { Flash, SubNav, one, type SP } from "../_ui";

export const dynamic = "force-dynamic";

const BOARD = LEAD_STAGES.filter((s) => s.key !== "LOST");
const MOVABLE = LEAD_STAGES.filter((s) => !["UNIT_BLOCKED", "BOOKED"].includes(s.key));

export default async function PipelinePage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(SALES_ROLES);
  const sp = await searchParams;
  const projectId = one(sp.project) ?? "";
  const where: Prisma.LeadWhereInput = { AND: [leadScope(u), projectId ? { projectId } : {}] };
  const recent = new Date(Date.now() - 90 * 864e5);

  const [leads, lost, projects, users] = await Promise.all([
    db.lead.findMany({
      where: { AND: [where, { stage: { not: "LOST" } }, { OR: [{ stage: { notIn: ["BOOKED", "AGREEMENT_SIGNED"] } }, { lastActivityAt: { gte: recent } }] }] },
      include: { project: true },
      orderBy: { lastActivityAt: "desc" },
    }),
    db.lead.count({ where: { AND: [where, { stage: "LOST" }] } }),
    db.project.findMany({ where: u.projectIds === "ALL" ? {} : { id: { in: u.projectIds } }, orderBy: { name: "asc" } }),
    db.user.findMany({ select: { id: true, name: true } }),
  ]);
  const name = new Map(users.map((x) => [x.id, x.name]));

  return (
    <>
      <PageHeader eyebrow="Sales" title="Pipeline">
        <form method="get" className="flex gap-2">
          <select className="input" name="project" defaultValue={projectId}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="min-h-11 rounded-lg border border-line bg-white px-4 text-sm">Show</button>
        </form>
      </PageHeader>
      <SubNav active="/sales/pipeline" />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      <p className="mb-4 text-sm text-stone">{lost} lost lead{lost === 1 ? "" : "s"} hidden. Booked leads show for 90 days.</p>

      <div className="-mx-4 overflow-x-auto px-4 pb-4 md:-mx-8 md:px-8">
        <div className="flex gap-4">
          {BOARD.map((col) => {
            const cards = leads.filter((l) => l.stage === col.key);
            return (
              <section key={col.key} className="w-72 shrink-0 rounded-xl border border-line bg-[#f6f3ee]">
                <header className="flex items-center justify-between px-4 py-3">
                  <h2 className="text-sm font-medium">{col.label}</h2>
                  <span className="text-xs text-stone">{cards.length}</span>
                </header>
                <ul className="grid gap-2 px-2 pb-2">
                  {cards.map((l) => (
                    <li key={l.id} className="rounded-lg border border-line bg-white p-3">
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/sales/leads/${l.id}`} className="text-sm font-medium hover:underline">{l.name}</Link>
                        {needsEscalation(l) && <Badge tone="bad">Call now</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-stone">{l.project?.name ?? "No project"} · {l.ownerId ? name.get(l.ownerId) : "Unassigned"}</p>
                      <p className="text-xs text-stone">Last touch {ago(l.lastActivityAt ?? l.createdAt)}</p>
                      {!["UNIT_BLOCKED", "BOOKED", "AGREEMENT_SIGNED"].includes(l.stage) && (
                        <form action={changeStage} className="mt-2 flex gap-1.5">
                          <input type="hidden" name="leadId" value={l.id} />
                          <input type="hidden" name="back" value={`/sales/pipeline${projectId ? `?project=${projectId}` : ""}`} />
                          <select name="stage" defaultValue={l.stage} className="min-h-9 flex-1 rounded-md border border-line bg-white px-2 text-xs" aria-label="Move to stage">
                            {MOVABLE.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                          </select>
                          <select name="lostReason" defaultValue="" className="min-h-9 w-20 rounded-md border border-line bg-white px-1 text-xs" aria-label="Lost reason">
                            <option value="">Reason</option>
                            {["Budget", "Bought elsewhere", "Location", "Not responding", "Timing"].map((r) => <option key={r}>{r}</option>)}
                          </select>
                          <button className="min-h-9 rounded-md bg-ink px-2.5 text-xs text-white">Move</button>
                        </form>
                      )}
                    </li>
                  ))}
                  {cards.length === 0 && <li className="px-2 py-6 text-center text-xs text-stone">Empty</li>}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
