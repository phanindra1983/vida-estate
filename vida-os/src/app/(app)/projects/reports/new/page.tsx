import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PageHeader, Card, Field } from "@/components/ui";
import { PhotoForm } from "../../_components/PhotoForm";
import { createReport } from "../../actions";

export default async function NewReportPage() {
  const user = await requireUser(["SITE_ENGINEER", "PROJECT_MANAGER", "GM_PROJECTS", "MD"]);
  const projects = await db.project.findMany({
    where: user.projectIds === "ALL" ? {} : { id: { in: user.projectIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  const milestones = await db.milestone.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, status: { in: ["IN_PROGRESS", "NOT_STARTED"] } },
    orderBy: [{ projectId: "asc" }, { seq: "asc" }],
    include: { project: { select: { name: true } } },
  });
  // Show in-progress first, then the next few not started.
  const sorted = [...milestones.filter((m) => m.status === "IN_PROGRESS"), ...milestones.filter((m) => m.status === "NOT_STARTED").slice(0, 6)];

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader eyebrow="Projects · Daily reports" title="Today at site" />
      <Card>
        <PhotoForm action={createReport} photoName="photos" photoLabel="Site photos" minPhotos={2} submitLabel="Save daily report">
          <Field label="Project">
            <select name="projectId" className="input" required defaultValue={projects[0]?.id}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Milestone" hint="Pick the activity this report is about, or leave it as general.">
            <select name="milestoneId" className="input" defaultValue={sorted[0]?.id ?? ""}>
              <option value="">General site work</option>
              {sorted.map((m) => <option key={m.id} value={m.id}>{m.project.name} · {m.name}{m.status === "NOT_STARTED" ? " (not started)" : ` (${m.progressPct}%)`}</option>)}
            </select>
          </Field>
          <Field label="Work done today">
            <textarea name="workDone" rows={3} className="input" required placeholder="e.g. Slab 10 reinforcement, grid C to F" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Labour on site"><input name="labourCount" type="number" min={0} inputMode="numeric" className="input" required /></Field>
            <Field label="Progress %" hint="Optional"><input name="progressPct" type="number" min={0} max={99} inputMode="numeric" className="input" /></Field>
          </div>
          <Field label="Materials used"><input name="materialsUsed" className="input" placeholder="e.g. Steel 18 MT, RMC 140 cum" /></Field>
          <Field label="Issues or delays"><textarea name="issues" rows={2} className="input" placeholder="Leave empty if none" /></Field>
        </PhotoForm>
      </Card>
    </div>
  );
}
