import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { LEAD_SOURCES, LEAD_STAGES, SALES_ROLES, SALES_MANAGERS, ESCALATION } from "@/lib/constants";
import { ago } from "@/lib/format";
import { leadScope, needsEscalation, waitingMinutes, inBusinessHours } from "@/lib/sales";
import { PageHeader, Card, Table, Badge, Status, Button, Field, Notice } from "@/components/ui";
import { quickAddLead, importCsv } from "../actions";
import { Flash, SubNav, one, type SP } from "../_ui";

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(SALES_ROLES);
  const sp = await searchParams;
  const q = one(sp.q)?.trim() ?? "";
  const projectId = one(sp.project) ?? "";
  const source = one(sp.source) ?? "";
  const stage = one(sp.stage) ?? "";
  const ownerId = one(sp.owner) ?? "";
  const filter = one(sp.filter) ?? "";
  const firstCall = one(sp.firstCall) === "1" || filter === "firstcall";
  const followUps = filter === "followups";
  const isManager = SALES_MANAGERS.includes(u.role);

  const where: Prisma.LeadWhereInput = { AND: [leadScope(u)] };
  const and = where.AND as Prisma.LeadWhereInput[];
  if (q) and.push({ OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q.replace(/\D/g, "") || q } }] });
  if (projectId) and.push({ projectId });
  if (source) and.push({ source });
  if (stage) and.push({ stage });
  else and.push({ stage: { notIn: ["LOST", "BOOKED", "AGREEMENT_SIGNED"] } });
  if (ownerId) and.push({ ownerId });
  if (firstCall) and.push({ firstCallAt: null, stage: { not: "LOST" } });
  if (followUps) {
    const endOfToday = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) + "T23:59:59+05:30");
    and.push({ nextFollowUp: { lte: endOfToday }, stage: { notIn: ["LOST", "BOOKED", "AGREEMENT_SIGNED"] } });
  }

  const [leads, projects, owners, partners, uncalled] = await Promise.all([
    db.lead.findMany({ where, include: { project: true }, orderBy: firstCall ? [{ createdAt: "asc" }] : followUps ? [{ nextFollowUp: "asc" }] : [{ firstCallAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }], take: 200 }),
    db.project.findMany({ where: u.projectIds === "ALL" ? {} : { id: { in: u.projectIds } }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { role: { in: ["SALES_EXEC", "SALES_MANAGER", "SALES_HEAD"] }, active: true }, orderBy: { name: "asc" } }),
    db.channelPartner.findMany({ orderBy: { name: "asc" } }),
    db.lead.findMany({ where: { AND: [leadScope(u), { firstCallAt: null, stage: "NEW" }] }, select: { firstCallAt: true, createdAt: true, stage: true } }),
  ]);
  const ownerName = new Map(owners.map((o) => [o.id, o.name]));
  const escalated = uncalled.filter((l) => needsEscalation(l)).length;
  const stageLabel = new Map(LEAD_STAGES.map((s) => [s.key, s.label]));

  return (
    <>
      <PageHeader eyebrow="Sales" title="Leads">
        <a href="#add" className="inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-ink-2">Add a lead</a>
      </PageHeader>
      <SubNav active="/sales/leads" />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      {(firstCall || followUps) && (
        <p className="mb-4 text-sm text-stone">
          Showing {followUps ? "follow-ups due today or earlier" : "leads still waiting for a first call, longest wait first"}.{" "}
          <Link href="/sales/leads" className="underline underline-offset-4">Show all</Link>
        </p>
      )}

      {escalated > 0 && (
        <div className="mb-6">
          <Notice tone="bad">
            <strong>{escalated} lead{escalated > 1 ? "s have" : " has"} waited more than {ESCALATION.minutes} minutes for a first call.</strong>{" "}
            {isManager ? "Call them now or reassign them." : "Call them now."}{" "}
            <Link href="/sales/leads?filter=firstcall" className="underline underline-offset-4">Show them</Link>
          </Notice>
        </div>
      )}

      <Card pad={false}>
        <form className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-6" method="get">
          <input className="input lg:col-span-2" name="q" defaultValue={q} placeholder="Search name or phone" />
          <select className="input" name="project" defaultValue={projectId}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="input" name="source" defaultValue={source}>
            <option value="">All sources</option>
            {Object.entries(LEAD_SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="input" name="stage" defaultValue={stage}>
            <option value="">Open leads</option>
            {LEAD_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          {isManager ? (
            <select className="input" name="owner" defaultValue={ownerId}>
              <option value="">Everyone</option>
              {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          ) : <span />}
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="firstCall" value="1" defaultChecked={firstCall} className="h-4 w-4 accent-[#a07a45]" /> Needs first call
          </label>
          <div className="flex gap-2 lg:col-span-5 lg:justify-end">
            <Link href="/sales/leads" className="inline-flex min-h-11 items-center px-3 text-sm text-stone hover:text-ink">Clear</Link>
            <Button variant="secondary">Filter</Button>
          </div>
        </form>
        <Table head={["Lead", "Project", "Source", "Stage", "Owner", "First call", "Next follow-up"]} empty="No leads match these filters.">
          {leads.map((l) => {
            const wait = waitingMinutes(l);
            const flag = needsEscalation(l);
            return (
              <tr key={l.id}>
                <td>
                  <Link href={`/sales/leads/${l.id}`} className="font-medium hover:underline">{l.name}</Link>
                  <div className="text-xs text-stone">{l.phone}{l.duplicateCount > 0 && ` · enquired ${l.duplicateCount + 1}×`}</div>
                </td>
                <td>{l.project?.name ?? "–"}</td>
                <td>{LEAD_SOURCES[l.source] ?? l.source}</td>
                <td><Status value={l.stage} /><span className="sr-only">{stageLabel.get(l.stage)}</span></td>
                <td>{l.ownerId ? ownerName.get(l.ownerId) ?? "–" : <Badge tone="warn">Unassigned</Badge>}</td>
                <td>
                  {flag ? <Badge tone="bad">Call now · {wait}m</Badge>
                    : wait != null ? <Badge tone="warn">{inBusinessHours() ? `Waiting ${wait}m` : "Call after 9 am"}</Badge>
                    : <span className="text-xs text-stone">{ago(l.firstCallAt)}</span>}
                </td>
                <td className="text-xs text-stone">{l.nextFollowUp ? ago(l.nextFollowUp).replace(" ago", l.nextFollowUp.getTime() > Date.now() ? "" : " overdue") : "–"}</td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <div id="add" className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card title="Quick add">
          <form action={quickAddLead} className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><input className="input" name="name" required /></Field>
            <Field label="Mobile"><input className="input" name="phone" inputMode="tel" required placeholder="10-digit number" /></Field>
            <Field label="Email (optional)"><input className="input" name="email" type="email" /></Field>
            <Field label="Project">
              <select className="input" name="projectId" required>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Source">
              <select className="input" name="source" defaultValue="WHATSAPP">
                {["WHATSAPP", "REFERRAL", "WALK_IN", "CHANNEL_PARTNER", "WEBSITE", "META"].map((k) => <option key={k} value={k}>{LEAD_SOURCES[k]}</option>)}
              </select>
            </Field>
            <Field label="Channel partner (if any)">
              <select className="input" name="channelPartnerId" defaultValue="">
                <option value="">None</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.name}{p.firm ? ` · ${p.firm}` : ""}</option>)}
              </select>
            </Field>
            <Field label="Looking for">
              <select className="input" name="preferredType" defaultValue="">
                <option value="">Not sure yet</option>
                {["2BHK", "3BHK", "4BHK"].map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Note"><input className="input" name="note" placeholder="Budget, timing, who referred" /></Field>
            <div className="sm:col-span-2"><Button>Save lead</Button></div>
          </form>
        </Card>

        <Card title="Import from a property portal">
          <form action={importCsv} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Portal">
                <select className="input" name="source" required>
                  <option value="99ACRES">99acres</option>
                  <option value="MAGICBRICKS">MagicBricks</option>
                  <option value="HOUSING">Housing.com</option>
                </select>
              </Field>
              <Field label="Project, if the file has no project column">
                <select className="input" name="projectId" defaultValue="">
                  <option value="">Use the file</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="CSV file"><input className="input" type="file" name="file" accept=".csv,text/csv" /></Field>
            <Field label="Or paste the CSV" hint="First row: name, phone, email, project. Duplicates are matched by phone.">
              <textarea className="input min-h-28" name="csv" placeholder={"name,phone,email,project\nRavi Kumar,9876543210,ravi@example.com,VA"} />
            </Field>
            <div><Button variant="secondary">Import leads</Button></div>
          </form>
        </Card>
      </div>
    </>
  );
}

export const dynamic = "force-dynamic";
