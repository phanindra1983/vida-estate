import { db } from "@/lib/db";
import { requireUser, projectScope } from "@/lib/auth";
import { PROJECT_ROLES, ROLE_LABEL } from "@/lib/constants";
import { date, time, istDay } from "@/lib/format";
import { ON_SITE_METRES } from "@/lib/telegram-bot";
import { PageHeader, Card, Table, Badge, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

const dist = (m: number | null) => (m == null ? "–" : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
const map = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

export default async function AttendancePage() {
  const user = await requireUser([...PROJECT_ROLES, "STOREKEEPER"]);
  const since = istDay(-6);
  const rows = await db.attendance.findMany({ where: { ...projectScope(user), day: { gte: since } }, orderBy: [{ day: "desc" }, { inAt: "asc" }], include: { project: true } });
  const users = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } } })).map((u) => [u.id, u]));
  const projects = await db.project.findMany({ where: user.projectIds === "ALL" ? {} : { id: { in: user.projectIds } }, orderBy: { name: "asc" } });
  const today = rows.filter((r) => r.day === istDay());
  const off = today.filter((r) => r.inMeters != null && r.inMeters > ON_SITE_METRES).length;

  return (
    <>
      <PageHeader eyebrow="Projects" title="Site attendance" />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Checked in today" value={today.length} />
        <Stat label="Off site today" value={off} tone={off ? "bad" : undefined} sub={`more than ${ON_SITE_METRES} m from the site pin`} />
        <Stat label="Still on site" value={today.filter((r) => !r.outAt).length} />
      </div>
      <Card title="Site pins" className="mb-6">
        <p className="mb-3 text-sm text-stone">Check-ins are measured against each project's site pin. A project manager sets it by standing on site and sending <b>/site</b> to the Telegram bot.</p>
        <ul className="grid gap-1 text-sm">
          {projects.map((p) => (
            <li key={p.id}>
              {p.name}: {p.siteLat != null && p.siteLng != null ? <a className="underline" href={map(p.siteLat, p.siteLng)} target="_blank" rel="noreferrer">pin set</a> : <Badge tone="warn">no pin yet</Badge>}
            </li>
          ))}
        </ul>
      </Card>
      <Card pad={false} title="Last 7 days">
        <Table head={["Day", "Name", "Project", "In", "Distance", "Out", "Hours"]} empty="No check-ins yet. Site staff check in by sending /in to the Telegram bot.">
          {rows.map((r) => {
            const u = users.get(r.userId);
            const hrs = r.outAt ? ((r.outAt.getTime() - r.inAt.getTime()) / 36e5).toFixed(1) : null;
            const away = r.inMeters != null && r.inMeters > ON_SITE_METRES;
            return (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{date(r.inAt)}</td>
                <td>{u?.name ?? "–"} <span className="text-xs text-stone">{u ? ROLE_LABEL[u.role] ?? u.role : ""}</span></td>
                <td>{r.project.name}</td>
                <td><a className="underline-offset-4 hover:underline" href={map(r.inLat, r.inLng)} target="_blank" rel="noreferrer">{time(r.inAt)}</a></td>
                <td>{away ? <Badge tone="bad">{dist(r.inMeters)} away</Badge> : dist(r.inMeters)}</td>
                <td>{r.outAt ? (r.outLat != null && r.outLng != null ? <a className="underline-offset-4 hover:underline" href={map(r.outLat, r.outLng)} target="_blank" rel="noreferrer">{time(r.outAt)}</a> : time(r.outAt)) : <span className="text-stone">on site</span>}</td>
                <td className="num">{hrs ?? "–"}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
