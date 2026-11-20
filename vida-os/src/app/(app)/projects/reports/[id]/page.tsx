import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { PROJECT_ROLES } from "@/lib/constants";
import { date, datetime } from "@/lib/format";
import { milestoneHealth, userNames, type SavedPhoto } from "@/lib/cost";
import { PageHeader, Card, Badge, LinkButton } from "@/components/ui";
import { Flash } from "../../_components/Flash";

export default async function ReportDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser(PROJECT_ROLES);
  const { id } = await params;
  const sp = await searchParams;
  const r = await db.dailyReport.findUnique({ where: { id }, include: { project: true, milestone: true } });
  if (!r || !canSeeProject(user, r.projectId)) notFound();
  const names = await userNames([r.engineerId]);
  const photos = JSON.parse(r.photos || "[]") as SavedPhoto[];
  const h = r.milestone ? milestoneHealth(r.milestone) : null;

  const rows: [string, React.ReactNode][] = [
    ["Project", r.project.name],
    ["Milestone", r.milestone ? r.milestone.name : "General site work"],
    ["Engineer", names.get(r.engineerId) ?? "–"],
    ["Labour on site", r.labourCount],
    ["Progress reported", r.progressPct != null ? `${r.progressPct}%` : "–"],
    ["Materials used", r.materialsUsed ?? "–"],
    ["Issues or delays", r.issues ?? "None"],
    ["Submitted", datetime(r.createdAt)],
  ];

  return (
    <>
      <PageHeader eyebrow="Projects · Daily report" title={`${r.project.name}, ${date(r.date)}`}>
        <LinkButton href="/projects/reports" variant="secondary">All reports</LinkButton>
      </PageHeader>
      <Flash sp={sp} />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card title="Report">
          {h?.delayed && <div className="mb-4"><Badge tone="bad">Milestone behind plan by {h.slipDays} days</Badge></div>}
          <p className="mb-5 whitespace-pre-line">{r.workDone}</p>
          <dl className="grid gap-3 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[9rem_1fr] gap-3">
                <dt className="text-stone">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title={`Site photos (${photos.length})`}>
          {photos.length === 0 ? (
            <p className="text-sm text-stone">No photos on this report.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {photos.map((p) => (
                <figure key={p.path}>
                  <a href={p.path} target="_blank" rel="noreferrer">
                    <img src={p.path} alt={`Site photo, ${datetime(p.takenAt)}`} className="aspect-[4/3] w-full rounded-lg border border-line object-cover" />
                  </a>
                  <figcaption className="mt-1.5 text-xs text-stone">Time-stamped {datetime(p.takenAt)}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
