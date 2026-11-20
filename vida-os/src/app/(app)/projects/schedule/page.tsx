import { db } from "@/lib/db";
import { requireUser, can } from "@/lib/auth";
import { PROJECT_ROLES } from "@/lib/constants";
import { date } from "@/lib/format";
import { milestoneHealth } from "@/lib/cost";
import { PageHeader, Card, Status, Badge, Progress, Notice } from "@/components/ui";
import { Flash } from "../_components/Flash";
import { ProjectTabs } from "../_components/ProjectTabs";
import { updateProgress, requestCompletion } from "../actions";

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ project?: string; ok?: string; error?: string }> }) {
  const user = await requireUser(PROJECT_ROLES);
  const sp = await searchParams;
  const projects = await db.project.findMany({
    where: user.projectIds === "ALL" ? {} : { id: { in: user.projectIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, location: true },
  });
  const current = projects.find((p) => p.id === sp.project) ?? projects[0];
  if (!current) return <PageHeader eyebrow="Projects" title="Schedule"><span className="text-sm text-stone">No projects assigned to you.</span></PageHeader>;

  const towers = await db.tower.findMany({
    where: { projectId: current.id },
    orderBy: { name: "asc" },
    include: { milestones: { orderBy: { seq: "asc" } } },
  });
  const canEdit = can(user, ["PROJECT_MANAGER", "GM_PROJECTS", "MD"]);
  const canRequest = can(user, ["PROJECT_MANAGER"]);
  const back = `/projects/schedule?project=${current.id}`;

  const all = towers.flatMap((t) => t.milestones);
  const delayed = all.filter((m) => milestoneHealth(m).delayed).length;
  const done = all.filter((m) => m.status === "DONE").length;

  return (
    <>
      <PageHeader eyebrow="Projects" title="Schedule">
        <span className="text-sm text-stone">{done} of {all.length} milestones done{delayed ? ` · ${delayed} behind plan` : ""}</span>
      </PageHeader>
      <ProjectTabs base="/projects/schedule" projects={projects} current={current.id} />
      <Flash sp={sp} />
      <div className="mb-6">
        <Notice tone="neutral">When GM Projects approves a milestone as complete, demand letters are raised for every buyer in that tower whose payment plan is linked to it.</Notice>
      </div>

      <div className="grid gap-6">
        {towers.map((t) => (
          <Card key={t.id} title={`${current.name} · ${t.name}`} pad={false}>
            <ul className="divide-y divide-line">
              {t.milestones.map((m) => {
                const h = milestoneHealth(m);
                const open = m.status === "NOT_STARTED" || m.status === "IN_PROGRESS";
                return (
                  <li key={m.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-center">
                    <div>
                      <p className="font-medium">{m.name.split(" · ")[0]}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Status value={m.status} />
                        {h.delayed && <Badge tone="bad">{m.status === "DONE" ? "Late" : `Behind plan · ${h.slipDays} d`}</Badge>}
                      </div>
                    </div>
                    <div className="text-xs text-stone">
                      <p>Plan {date(m.plannedStart)} to {date(m.plannedEnd)}</p>
                      <p>Actual {m.actualStart ? date(m.actualStart) : "not started"}{m.actualEnd ? ` to ${date(m.actualEnd)}` : ""}</p>
                    </div>
                    <div>
                      <div className="mb-1 flex justify-between text-xs"><span className="text-stone">Progress</span><span>{m.progressPct}%</span></div>
                      <Progress value={m.progressPct} tone={h.delayed ? "bad" : m.status === "DONE" ? "good" : undefined} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 md:justify-end">
                      {canEdit && open && (
                        <form action={updateProgress} className="flex items-center gap-2">
                          <input type="hidden" name="milestoneId" value={m.id} />
                          <input type="hidden" name="back" value={back} />
                          <input aria-label={`Progress for ${m.name}`} name="progress" type="number" min={0} max={99} defaultValue={m.progressPct} className="input !min-h-10 w-20" />
                          <button className="min-h-10 rounded-lg border border-line bg-white px-3 text-xs font-medium hover:border-stone">Save</button>
                        </form>
                      )}
                      {canRequest && m.status === "IN_PROGRESS" && (
                        <form action={requestCompletion}>
                          <input type="hidden" name="milestoneId" value={m.id} />
                          <input type="hidden" name="back" value={back} />
                          <button className="min-h-10 rounded-lg bg-ink px-3 text-xs font-medium text-white hover:bg-ink-2">Request completion</button>
                        </form>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
