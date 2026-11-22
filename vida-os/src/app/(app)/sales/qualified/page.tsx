import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { leadScope } from "@/lib/sales";
import { HOT } from "@/lib/lead-score";
import { HOME_TYPES, LEAD_SOURCES, PURPOSES, SALES_MANAGERS, SALES_ROLES, TIMELINES } from "@/lib/constants";
import { bolnaConfigured, getConfig } from "@/lib/bolna";
import { PageHeader, Card, Stat, Button, Field, cx } from "@/components/ui";
import { Flash, SubNav, one, type SP } from "../_ui";
import { LeadTable } from "../_crm";
import { withLastAi, salesPeople, userNames } from "../_crm-data";
import { postQualifiedLead } from "../crm-actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // bulk AI calls place up to 200 calls

const OPEN = { stage: { notIn: ["LOST", "BOOKED", "AGREEMENT_SIGNED"] } };
const VIEWS: Record<string, { label: string; where: Prisma.LeadWhereInput }> = {
  all: { label: "All qualified", where: {} },
  waiting: { label: "Visit not fixed yet", where: { stage: "QUALIFIED" } },
  hot: { label: "🔥 Hot", where: { score: { gte: HOT } } },
  visit: { label: "Site visit fixed", where: { stage: { in: ["VISIT_SCHEDULED", "VISIT_DONE", "NEGOTIATION", "UNIT_BLOCKED"] } } },
  ai: { label: "🤖 Qualified by AI", where: { qualifiedById: null } },
};

export default async function QualifiedLeadsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(SALES_ROLES);
  const sp = await searchParams;
  const view = VIEWS[one(sp.view) ?? ""] ? one(sp.view)! : "all";
  const projectId = one(sp.project) ?? "";
  const ownerId = one(sp.owner) ?? "";
  const isManager = SALES_MANAGERS.includes(u.role);

  const base: Prisma.LeadWhereInput[] = [leadScope(u), OPEN, { qualifiedAt: { not: null } }];
  if (projectId) base.push({ projectId });
  if (ownerId && isManager) base.push({ ownerId });
  const where = { AND: [...base, VIEWS[view].where] };

  const [rows, counts, projects, owners, names, cfg] = await Promise.all([
    db.lead.findMany({ where, include: { project: { select: { name: true } } }, orderBy: [{ score: "desc" }, { qualifiedAt: "desc" }], take: 200 }),
    Promise.all(Object.entries(VIEWS).map(async ([k, v]) => [k, await db.lead.count({ where: { AND: [...base, v.where] } })] as const)),
    db.project.findMany({ where: u.projectIds === "ALL" ? {} : { id: { in: u.projectIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    salesPeople(),
    userNames(),
    getConfig(),
  ]);
  const leads = await withLastAi(rows);
  const count = Object.fromEntries(counts);
  const aiReady = bolnaConfigured() && !!cfg.agentId;
  const qs = (v: string) => `/sales/qualified?${new URLSearchParams({ view: v, ...(projectId ? { project: projectId } : {}), ...(ownerId ? { owner: ownerId } : {}) })}`;

  return (
    <>
      <PageHeader eyebrow="Sales" title="Qualified leads">
        <a href="#post" className="inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-ink-2">Post a qualified lead</a>
      </PageHeader>
      <SubNav active="/sales/qualified" />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      <p className="mb-6 max-w-3xl text-sm text-stone">
        Buyers who are genuine and whose budget, home size, purpose and timeline we know. Pre-sales posts them here, and the AI caller adds every buyer it finds interested. Sales takes over from here: call them, fix the site visit, and close.
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Qualified, open" value={count.all} />
        <Stat label="Visit not fixed yet" value={count.waiting} tone={count.waiting ? "warn" : "good"} sub="Call these first" />
        <Stat label="Hot" value={count.hot} sub={`Score ${HOT} or more`} />
        <Stat label="Site visit fixed" value={count.visit} tone={count.visit ? "good" : undefined} />
      </div>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <nav className="flex flex-wrap gap-2">
          {Object.entries(VIEWS).map(([k, v]) => (
            <Link key={k} href={qs(k)} className={cx("rounded-full border px-3 py-1.5 text-sm", view === k ? "border-ink bg-ink text-white" : "border-line bg-white text-ink-2 hover:border-stone")}>
              {v.label} <span className={view === k ? "text-white/70" : "text-stone"}>{count[k]}</span>
            </Link>
          ))}
        </nav>
        <form className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="view" value={view} />
          <select className="input min-h-9 py-1 text-sm" name="project" defaultValue={projectId} aria-label="Project">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {isManager && (
            <select className="input min-h-9 py-1 text-sm" name="owner" defaultValue={ownerId} aria-label="Owner">
              <option value="">Everyone</option>
              {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <Button size="sm" variant="secondary">Show</Button>
        </form>
      </div>

      <Card pad={false} className="mb-8">
        <LeadTable leads={leads} owners={owners} isManager={isManager} back={qs(view)} listName="Qualified leads" showQualified userNames={names} />
      </Card>

      <div id="post" className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card title="Post a qualified lead">
          <form action={postQualifiedLead} className="grid gap-4">
            <input type="hidden" name="back" value="/sales/qualified" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Buyer's name"><input className="input" name="name" required /></Field>
              <Field label="Mobile"><input className="input" name="phone" inputMode="tel" required placeholder="10-digit number" /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Project">
                <select className="input" name="projectId" required defaultValue={projects.length === 1 ? projects[0].id : ""}>
                  <option value="" disabled>Pick one</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Home size">
                <select className="input" name="preferredType" required defaultValue="">
                  <option value="" disabled>Pick one</option>
                  {HOME_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Budget"><input className="input" name="budget" required placeholder="₹1.5–1.8 Cr" /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Purpose">
                <select className="input" name="purpose" required defaultValue="">
                  <option value="" disabled>Pick one</option>
                  {Object.entries(PURPOSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Buying">
                <select className="input" name="timeline" required defaultValue="">
                  <option value="" disabled>Pick one</option>
                  {Object.entries(TIMELINES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Came from">
                <select className="input" name="source" defaultValue="STAFF">
                  {["STAFF", "REFERRAL", "WALK_IN", "CHANNEL_PARTNER", "WHATSAPP", "WEBSITE", "META", "99ACRES", "MAGICBRICKS", "HOUSING"].map((k) => <option key={k} value={k}>{LEAD_SOURCES[k]}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Notes for the salesperson"><input className="input" name="note" placeholder="Wants east-facing, high floor; visiting with parents on Sunday" /></Field>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="consent" required className="mt-1 accent-[#a07a45]" /> The buyer agreed to be contacted by Vida Estates.</label>
            {aiReady && <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="aiCall" className="mt-1 accent-[#a07a45]" /> Also have the AI caller ring them now to confirm and offer a site visit.</label>}
            <div><Button>Post qualified lead</Button></div>
          </form>
        </Card>
        <Card title="What “qualified” means here">
          <ul className="grid list-disc gap-2 pl-5 text-sm">
            <li>The buyer is genuine and reachable, and agreed to be contacted.</li>
            <li>We know their <b>home size</b>, <b>budget</b>, <b>purpose</b> (live in or invest) and <b>when they plan to buy</b>.</li>
            <li>The salesperson who owns the lead gets a Telegram alert at once: “Qualified lead, please call now”.</li>
            <li>The AI caller qualifies leads on its own when a buyer says they are interested.</li>
            <li>Score: 🔥 Hot 60+, 🌤 Warm 30–59, ❄️ Cold below 30. It rises with interest, visits and a near buying date, and cools when nobody follows up.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
