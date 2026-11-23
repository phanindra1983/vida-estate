import Link from "next/link";
import { Scorecard } from "@/components/Scorecard";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { LEAD_SOURCES, LEAD_STAGES, SALES_ROLES, SALES_MANAGERS, ESCALATION } from "@/lib/constants";
import { leadScope, needsEscalation } from "@/lib/sales";
import { HOT, WARM } from "@/lib/lead-score";
import { PageHeader, Card, Button, Field, Notice, cx } from "@/components/ui";
import { quickAddLead, importCsv } from "../actions";
import { Flash, SubNav, one, type SP } from "../_ui";
import { LeadTable } from "../_crm";
import { withLastAi, salesPeople, userNames } from "../_crm-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // bulk AI calls place up to 200 calls

const CLOSED = ["LOST", "BOOKED", "AGREEMENT_SIGNED"];
const endOfTodayIST = () => new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) + "T23:59:59+05:30");

/** Smart lists: the questions a sales team asks every morning. */
const VIEWS: Record<string, { label: string; hint: string; where: () => Prisma.LeadWhereInput; order?: Prisma.LeadOrderByWithRelationInput[] }> = {
  open: { label: "All open", hint: "Every lead still in play, best first.", where: () => ({ stage: { notIn: CLOSED } }) },
  firstcall: { label: "Needs first call", hint: "Nobody has spoken to them yet. Longest wait first.", where: () => ({ firstCallAt: null, stage: "NEW" }), order: [{ createdAt: "asc" }] },
  hot: { label: "🔥 Hot", hint: `Score ${HOT}+: interested, near a decision, recently active.`, where: () => ({ score: { gte: HOT }, stage: { notIn: CLOSED } }) },
  followups: { label: "Follow-ups due", hint: "Promised callbacks due today or overdue.", where: () => ({ nextFollowUp: { lte: endOfTodayIST() }, stage: { notIn: CLOSED } }), order: [{ nextFollowUp: "asc" }] },
  visits: { label: "Site visits", hint: "Visit fixed, not done yet.", where: () => ({ stage: "VISIT_SCHEDULED" }), order: [{ nextFollowUp: "asc" }] },
  revisit: { label: "Visited, gone quiet", hint: "Saw the site but nothing for 10+ days. Invite them back.", where: () => ({ stage: "VISIT_DONE", lastActivityAt: { lt: new Date(Date.now() - 10 * 864e5) } }) },
  cold: { label: "❄️ Cold", hint: `Score under ${WARM} and quiet for 14+ days. Re-engage or close.`, where: () => ({ score: { lt: WARM }, stage: { notIn: CLOSED }, OR: [{ lastActivityAt: { lt: new Date(Date.now() - 14 * 864e5) } }, { lastActivityAt: null }] }) },
  lost: { label: "Lost", hint: "Closed as lost. Look for buyers worth another try.", where: () => ({ stage: "LOST" }), order: [{ lastActivityAt: "desc" }] },
};

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(SALES_ROLES);
  const sp = await searchParams;
  const legacy = one(sp.filter) === "firstcall" || one(sp.firstCall) === "1" ? "firstcall" : one(sp.filter) === "followups" ? "followups" : null;
  const view = VIEWS[one(sp.view) ?? ""] ? one(sp.view)! : legacy ?? "open";
  const q = one(sp.q)?.trim() ?? "";
  const projectId = one(sp.project) ?? "";
  const source = one(sp.source) ?? "";
  const stage = one(sp.stage) ?? "";
  const ownerId = one(sp.owner) ?? "";
  const isManager = SALES_MANAGERS.includes(u.role);

  const base: Prisma.LeadWhereInput[] = [leadScope(u)];
  if (q) base.push({ OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q.replace(/\D/g, "") || q } }] });
  if (projectId) base.push({ projectId });
  if (source) base.push({ source });
  if (stage) base.push({ stage });
  if (ownerId) base.push({ ownerId });
  const v = VIEWS[view];

  const [rows, counts, projects, owners, names, partners, uncalled] = await Promise.all([
    db.lead.findMany({ where: { AND: [...base, v.where()] }, include: { project: { select: { name: true } } }, orderBy: v.order ?? [{ score: "desc" }, { createdAt: "desc" }], take: 200 }),
    Promise.all(Object.entries(VIEWS).map(async ([k, x]) => [k, await db.lead.count({ where: { AND: [...base, x.where()] } })] as const)),
    db.project.findMany({ where: u.projectIds === "ALL" ? {} : { id: { in: u.projectIds } }, orderBy: { name: "asc" } }),
    salesPeople(),
    userNames(),
    db.channelPartner.findMany({ orderBy: { name: "asc" } }),
    db.lead.findMany({ where: { AND: [leadScope(u), { firstCallAt: null, stage: "NEW" }] }, select: { firstCallAt: true, createdAt: true, stage: true } }),
  ]);
  const leads = await withLastAi(rows);
  const count = Object.fromEntries(counts);
  const escalated = uncalled.filter((l) => needsEscalation(l)).length;
  const keep = { ...(q ? { q } : {}), ...(projectId ? { project: projectId } : {}), ...(source ? { source } : {}), ...(stage ? { stage } : {}), ...(ownerId ? { owner: ownerId } : {}) };
  const href = (k: string) => `/sales/leads?${new URLSearchParams({ view: k, ...keep })}`;

  return (
    <>
      <PageHeader eyebrow="Sales" title="Leads">
        <a href="#add" className="inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-ink-2">Add a lead</a>
      </PageHeader>
      <SubNav active="/sales/leads" />
      <Scorecard kpis={["LEADS", "QUALIFIED", "SITE_VISITS", "UNITS"]} />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />

      {escalated > 0 && (
        <div className="mb-6">
          <Notice tone="bad">
            <strong>{escalated} lead{escalated > 1 ? "s have" : " has"} waited more than {ESCALATION.minutes} minutes for a first call.</strong>{" "}
            {isManager ? "Call them now, tick them and press “AI call now”, or reassign them." : "Call them now."}{" "}
            <Link href={href("firstcall")} className="underline underline-offset-4">Show them</Link>
          </Notice>
        </div>
      )}

      <details className="mb-6 rounded-xl border border-line bg-white p-4 text-sm">
        <summary className="cursor-pointer font-medium">How leads flow in Vida OS</summary>
        <ol className="mt-3 grid gap-2 sm:grid-cols-5">
          {[
            ["1. Arrive", "Website, 99acres, MagicBricks, Housing, Meta, Google come in by themselves. Walk-ins, referrals, CP leads are added by staff or Telegram /lead. Duplicates merge by phone."],
            ["2. Assigned", "Round-robin to a salesperson on that project. They get a Telegram alert at once."],
            ["3. First call", "Within 15 minutes, by the salesperson, or the AI caller rings in a minute (English, Hindi, Telugu)."],
            ["4. Qualified", "Budget, size, purpose and timeline known. Posted by pre-sales or set by the AI caller when the buyer is interested. Shows on Qualified leads."],
            ["5. Visit → Book", "Fix the site visit, visit, negotiate, block a unit, book. Score shows who to call first."],
          ].map(([t, d]) => <li key={t} className="rounded-lg bg-[#f6f4f0] p-3"><p className="font-medium">{t}</p><p className="mt-1 text-xs text-stone">{d}</p></li>)}
        </ol>
      </details>

      <nav className="mb-2 flex flex-wrap gap-2">
        {Object.entries(VIEWS).map(([k, x]) => (
          <Link key={k} href={href(k)} className={cx("rounded-full border px-3 py-1.5 text-sm", view === k ? "border-ink bg-ink text-white" : "border-line bg-white text-ink-2 hover:border-stone")}>
            {x.label} <span className={view === k ? "text-white/70" : "text-stone"}>{count[k]}</span>
          </Link>
        ))}
        <Link href="/sales/qualified" className="rounded-full border border-[#d9c7a6] bg-[#f6efe2] px-3 py-1.5 text-sm text-ink hover:border-stone">⭐ Qualified leads →</Link>
      </nav>
      <p className="mb-4 text-xs text-stone">{v.hint}</p>

      <Card pad={false}>
        <form className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-6" method="get">
          <input type="hidden" name="view" value={view} />
          <input className="input lg:col-span-2" name="q" defaultValue={q} placeholder="Search name or phone" />
          <select className="input" name="project" defaultValue={projectId} aria-label="Project">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="input" name="source" defaultValue={source} aria-label="Source">
            <option value="">All sources</option>
            {Object.entries(LEAD_SOURCES).map(([k, x]) => <option key={k} value={k}>{x}</option>)}
          </select>
          <select className="input" name="stage" defaultValue={stage} aria-label="Stage">
            <option value="">Any stage</option>
            {LEAD_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          {isManager ? (
            <select className="input" name="owner" defaultValue={ownerId} aria-label="Owner">
              <option value="">Everyone</option>
              {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          ) : <span />}
          <div className="flex gap-2 lg:col-span-6 lg:justify-end">
            <Link href={`/sales/leads?view=${view}`} className="inline-flex min-h-11 items-center px-3 text-sm text-stone hover:text-ink">Clear</Link>
            <Button variant="secondary">Filter</Button>
          </div>
        </form>
        <LeadTable leads={leads} owners={owners} isManager={isManager} back={href(view)} listName={v.label.replace(/[^\w\s-]/g, "").trim()} userNames={names} />
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
            <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
              <Button>Save lead</Button>
              <Link href="/sales/qualified#post" className="text-sm underline underline-offset-4">Already qualified? Post it as a qualified lead</Link>
            </div>
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
