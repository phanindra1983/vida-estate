import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser, projectScope, can } from "@/lib/auth";
import { PROJECT_ROLES } from "@/lib/constants";
import { date } from "@/lib/format";
import { userNames, type SavedPhoto } from "@/lib/cost";
import { PageHeader, Card, Table, Badge, Button, Stat } from "@/components/ui";
import { Flash } from "../_components/Flash";
import { reviewIssue } from "./actions";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "open", label: "Open", statuses: ["OPEN"] },
  { key: "fixed", label: "Fixed, to check", statuses: ["FIXED"] },
  { key: "closed", label: "Closed", statuses: ["CLOSED"] },
];
const SEV_TONE = { HIGH: "bad", MEDIUM: "warn", LOW: "neutral" } as const;

export default async function IssuesPage({ searchParams }: { searchParams: Promise<{ tab?: string; ok?: string; error?: string }> }) {
  const user = await requireUser([...PROJECT_ROLES, "STOREKEEPER"]);
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0];
  const scope = projectScope(user);
  const issues = await db.siteIssue.findMany({ where: { ...scope, status: { in: tab.statuses } }, include: { project: true }, orderBy: { createdAt: "desc" }, take: 200 });
  const counts = await db.siteIssue.groupBy({ by: ["status", "kind"], where: scope, _count: true });
  const c = (status: string, kind?: string) => counts.filter((x) => x.status === status && (!kind || x.kind === kind)).reduce((a, x) => a + x._count, 0);
  const names = await userNames(issues.flatMap((i) => [i.raisedById, i.fixedById]));
  const closer = can(user, ["PROJECT_MANAGER", "GM_PROJECTS", "MD"]);

  return (
    <>
      <PageHeader eyebrow="Projects" title="Snags & safety" />
      <Flash sp={sp} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Open safety issues" value={c("OPEN", "SAFETY")} tone={c("OPEN", "SAFETY") ? "bad" : "good"} />
        <Stat label="Open snags" value={c("OPEN", "SNAG")} tone={c("OPEN", "SNAG") ? "warn" : "good"} />
        <Stat label="Fixed, waiting for a check" value={c("FIXED")} />
      </div>
      <p className="mb-4 text-sm text-stone">The site team raises these from Telegram with <b>/snag</b> and <b>/safety</b>, and marks them fixed from <b>/issues</b>.</p>
      <div className="mb-4 flex gap-2">
        {TABS.map((t) => (
          <Link key={t.key} href={`/projects/issues?tab=${t.key}`} className={`rounded-full px-4 py-1.5 text-sm ${t.key === tab.key ? "bg-ink text-white" : "border border-line"}`}>{t.label}</Link>
        ))}
      </div>
      <Card pad={false}>
        <Table head={["No.", "Type", "Project", "What and where", "Raised", "Photos", ""]} empty="Nothing here.">
          {issues.map((i) => {
            const photos = [...(JSON.parse(i.photos || "[]") as SavedPhoto[]), ...(JSON.parse(i.fixPhotos || "[]") as SavedPhoto[])];
            return (
              <tr key={i.id}>
                <td className="whitespace-nowrap">{i.number}</td>
                <td>
                  <Badge tone={i.kind === "SAFETY" ? "bad" : "neutral"}>{i.kind === "SAFETY" ? "Safety" : "Snag"}</Badge>{" "}
                  <Badge tone={SEV_TONE[i.severity as keyof typeof SEV_TONE] ?? "neutral"}>{i.severity.toLowerCase()}</Badge>
                </td>
                <td>{i.project.name}</td>
                <td className="max-w-md">{i.description}{i.fixedAt && <div className="mt-1 text-xs text-stone">Fixed {date(i.fixedAt)} by {names.get(i.fixedById ?? "") ?? "–"}</div>}</td>
                <td className="whitespace-nowrap">{date(i.createdAt)}<div className="text-xs text-stone">{names.get(i.raisedById) ?? "–"}</div></td>
                <td>{photos.map((p, n) => <a key={p.path} href={p.path} target="_blank" rel="noreferrer" className="mr-2 underline">{n + 1}</a>)}</td>
                <td className="whitespace-nowrap">
                  {closer && i.status === "FIXED" && (
                    <form action={reviewIssue} className="flex gap-2">
                      <input type="hidden" name="id" value={i.id} />
                      <Button size="sm" name="decision" value="close">Close</Button>
                      <Button size="sm" variant="secondary" name="decision" value="reopen">Reopen</Button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
