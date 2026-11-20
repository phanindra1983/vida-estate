import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser, can, projectScope } from "@/lib/auth";
import { PROJECT_ROLES } from "@/lib/constants";
import { date } from "@/lib/format";
import { milestoneHealth, userNames } from "@/lib/cost";
import { PageHeader, Card, Table, Badge, LinkButton } from "@/components/ui";
import { Flash } from "../_components/Flash";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser(PROJECT_ROLES);
  const sp = await searchParams;
  const reports = await db.dailyReport.findMany({
    where: projectScope(user),
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 100,
    include: { project: { select: { name: true } }, milestone: true },
  });
  const names = await userNames(reports.map((r) => r.engineerId));

  return (
    <>
      <PageHeader eyebrow="Projects" title="Daily reports">
        {can(user, ["SITE_ENGINEER", "PROJECT_MANAGER", "GM_PROJECTS", "MD"]) && <LinkButton href="/projects/reports/new">New daily report</LinkButton>}
      </PageHeader>
      <Flash sp={sp} />
      <Card pad={false}>
        <Table head={["Date", "Project", "Milestone", "Engineer", { label: "Labour", num: true }, { label: "Photos", num: true }, ""]} empty="No daily reports yet.">
          {reports.map((r) => {
            const h = r.milestone ? milestoneHealth(r.milestone) : null;
            const photos = (JSON.parse(r.photos || "[]") as unknown[]).length;
            return (
              <tr key={r.id}>
                <td className="whitespace-nowrap"><Link href={`/projects/reports/${r.id}`} className="underline-offset-4 hover:underline">{date(r.date)}</Link></td>
                <td>{r.project.name}</td>
                <td>
                  {r.milestone ? r.milestone.name : <span className="text-stone">General</span>}
                  {h?.delayed && <span className="ml-2"><Badge tone="bad">Behind plan · {h.slipDays} d</Badge></span>}
                </td>
                <td>{names.get(r.engineerId) ?? "–"}</td>
                <td className="num">{r.labourCount}</td>
                <td className="num">{photos}</td>
                <td>{r.issues && <Badge tone="warn">Issue noted</Badge>}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
