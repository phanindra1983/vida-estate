import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { LEAD_SOURCES, LEAD_STAGES, SALES_ROLES, SALES_MANAGERS, ROLE_LABEL } from "@/lib/constants";
import { datetime, ago, inr } from "@/lib/format";
import { needsEscalation, waitingMinutes, effectiveStatus } from "@/lib/sales";
import { PageHeader, Card, Badge, Status, Button, Field, LinkButton } from "@/components/ui";
import { logActivity, scheduleVisit, changeStage, reassignLead, blockUnit } from "../../actions";
import { Flash, one, waLink, type SP } from "../../_ui";
import { callLeadWithAi } from "../../calls/actions";
import { markQualified, unqualify } from "../../crm-actions";
import { explainScore } from "@/lib/lead-score";
import { Temp } from "../../_crm";
import { HOME_TYPES, PURPOSES, TIMELINES } from "@/lib/constants";
import { bolnaConfigured, getConfig, STATUS_LABEL } from "@/lib/bolna";

export const dynamic = "force-dynamic";

const ACT_LABEL: Record<string, string> = { CALL: "Call", WHATSAPP: "WhatsApp", NOTE: "Note", SITE_VISIT: "Site visit", STAGE: "Stage", SYSTEM: "System" };

export default async function LeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const u = await requireUser(SALES_ROLES);
  const { id } = await params;
  const sp = await searchParams;
  const lead = await db.lead.findUnique({
    where: { id },
    include: { project: true, channelPartner: true, activities: { orderBy: { createdAt: "desc" } }, bookings: { include: { unit: true } } },
  });
  if (!lead) notFound();
  if (u.role === "SALES_EXEC" ? lead.ownerId !== u.id : !canSeeProject(u, lead.projectId) && u.projectIds !== "ALL") notFound();

  const isManager = SALES_MANAGERS.includes(u.role);
  const [owner, team, users, units, blocked] = await Promise.all([
    lead.ownerId ? db.user.findUnique({ where: { id: lead.ownerId } }) : null,
    isManager ? db.user.findMany({ where: { role: { in: ["SALES_EXEC", "SALES_MANAGER", "SALES_HEAD"] }, active: true }, orderBy: { name: "asc" } }) : [],
    db.user.findMany({ select: { id: true, name: true } }),
    lead.projectId
      ? db.unit.findMany({ where: { projectId: lead.projectId, status: { in: ["AVAILABLE", "BLOCKED"] } }, include: { tower: true }, orderBy: [{ tower: { name: "asc" } }, { floor: "asc" }, { number: "asc" }] })
      : [],
    db.unit.findFirst({ where: { blockedLeadId: lead.id, status: "BLOCKED" } }),
  ]);
  const [aiCalls, aiCfg] = await Promise.all([
    db.aiCall.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: "desc" }, take: 5 }),
    getConfig(),
  ]);
  const aiReady = bolnaConfigured() && !!aiCfg.agentId;

  const available = units.filter((x) => effectiveStatus(x) === "AVAILABLE" && (!lead.preferredType || x.type === lead.preferredType || sp.allTypes));
  const userName = new Map(users.map((x) => [x.id, x.name]));
  const scored = await explainScore(lead.id);
  const qualifiedBy = lead.qualifiedAt ? (lead.qualifiedById ? userName.get(lead.qualifiedById) ?? "staff" : "the AI caller") : null;
  const closed = ["LOST", "BOOKED", "AGREEMENT_SIGNED"].includes(lead.stage);
  const wait = waitingMinutes(lead);
  const nextVisit = lead.activities.find((a) => a.type === "SITE_VISIT" && a.scheduledFor && a.scheduledFor.getTime() > Date.now());
  const path = `/sales/leads/${lead.id}`;
  const first = lead.name.split(" ")[0];
  const projectName = lead.project?.name ?? "Vida Estates";
  const introText = `Hello ${first}, this is ${owner?.name ?? "the Vida Estates team"} from Vida Estates. Thank you for your interest in ${projectName}. When would be a good time to talk?`;
  const visitText = nextVisit
    ? `Hello ${first}, your site visit to ${projectName} is confirmed for ${datetime(nextVisit.scheduledFor)}. Location: https://maps.google.com/?q=${encodeURIComponent(projectName + " " + (lead.project?.location ?? "Hyderabad"))}. See you there. ${owner?.name ?? "Vida Estates"}`
    : "";

  return (
    <>
      <PageHeader eyebrow={`Lead · ${LEAD_SOURCES[lead.source] ?? lead.source}`} title={lead.name}>
        <LinkButton href="/sales/leads" variant="ghost" size="sm">All leads</LinkButton>
      </PageHeader>
      <Flash ok={one(sp.ok)} error={one(sp.error)} />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="grid content-start gap-6">
          <Card title="Buyer">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
              <dt className="text-stone">Mobile</dt><dd>{lead.phone}</dd>
              <dt className="text-stone">Email</dt><dd>{lead.email ?? "–"}</dd>
              <dt className="text-stone">Project</dt><dd>{lead.project?.name ?? "–"}</dd>
              <dt className="text-stone">Looking for</dt><dd>{[lead.preferredType, lead.budget, lead.purpose && PURPOSES[lead.purpose], lead.timeline && TIMELINES[lead.timeline]].filter(Boolean).join(" · ") || "–"}</dd>
              <dt className="text-stone">Stage</dt><dd><Status value={lead.stage} />{lead.lostReason && <span className="ml-2 text-xs text-stone">{lead.lostReason}</span>}</dd>
              <dt className="text-stone">Owner</dt><dd>{owner?.name ?? <Badge tone="warn">Unassigned</Badge>}</dd>
              {lead.channelPartner && (<><dt className="text-stone">Partner</dt><dd>{lead.channelPartner.name}{lead.channelPartner.firm ? ` · ${lead.channelPartner.firm}` : ""} ({lead.channelPartner.commissionPct}%)</dd></>)}
              {lead.campaign && (<><dt className="text-stone">Campaign</dt><dd>{lead.campaign}</dd></>)}
              <dt className="text-stone">Created</dt><dd>{datetime(lead.createdAt)}</dd>
              <dt className="text-stone">First call</dt>
              <dd>{lead.firstCallAt ? `${datetime(lead.firstCallAt)}` : needsEscalation(lead) ? <Badge tone="bad">Call now · waiting {wait}m</Badge> : <Badge tone="warn">Not called yet</Badge>}</dd>
              <dt className="text-stone">Consent</dt><dd>{lead.consentAt ? `Given ${datetime(lead.consentAt)}` : "Not recorded"}</dd>
              {lead.duplicateCount > 0 && (<><dt className="text-stone">Repeat</dt><dd>Enquired {lead.duplicateCount + 1} times</dd></>)}
            </dl>
            <div className="mt-5 flex flex-wrap gap-2">
              <a href={`tel:+91${lead.phone}`} className="inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white">📞 Call</a>
              <a href={waLink(lead.phone, introText)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-4 text-sm font-medium">WhatsApp</a>
              {visitText && <a href={waLink(lead.phone, visitText)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-4 text-sm font-medium">Send visit confirmation</a>}
            </div>
          </Card>

          <Card title={lead.qualifiedAt ? "⭐ Qualified" : "Qualify this lead"} action={<Temp score={scored?.score ?? lead.score} />}>
            {lead.qualifiedAt && <p className="mb-3 text-sm">Qualified {datetime(lead.qualifiedAt)} by {qualifiedBy}.</p>}
            {!closed && (
              <form action={markQualified} className="grid gap-3">
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="back" value={path} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Home size">
                    <select className="input" name="preferredType" defaultValue={lead.preferredType ?? ""} required>
                      <option value="" disabled>Pick one</option>
                      {[...new Set([...HOME_TYPES, ...(lead.preferredType ? [lead.preferredType] : [])])].map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </Field>
                  <Field label="Budget"><input className="input" name="budget" defaultValue={lead.budget ?? ""} required placeholder="₹1.5–1.8 Cr" /></Field>
                  <Field label="Purpose">
                    <select className="input" name="purpose" defaultValue={lead.purpose ?? ""} required>
                      <option value="" disabled>Pick one</option>
                      {Object.entries(PURPOSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </Field>
                  <Field label="Buying">
                    <select className="input" name="timeline" defaultValue={lead.timeline ?? ""} required>
                      <option value="" disabled>Pick one</option>
                      {Object.entries(TIMELINES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label="Note (optional)"><input className="input" name="note" placeholder="Genuine buyer, visiting Sunday with family" /></Field>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant={lead.qualifiedAt ? "secondary" : "primary"}>{lead.qualifiedAt ? "Update details" : "⭐ Mark qualified"}</Button>
                </div>
              </form>
            )}
            {lead.qualifiedAt && isManager && !closed && (
              <form action={unqualify} className="mt-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="back" value={path} />
                <button className="text-xs text-stone underline underline-offset-4">Not qualified after all</button>
              </form>
            )}
            {scored && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-xs text-stone">Why the score is {scored.score}</summary>
                <ul className="mt-2 grid gap-1 text-xs">
                  {scored.why.map(([k, n]) => <li key={k} className="flex justify-between"><span>{k}</span><span className={n < 0 ? "text-bad" : ""}>{n > 0 ? `+${n}` : n}</span></li>)}
                </ul>
              </details>
            )}
          </Card>

          <Card title="Move stage">
            <form action={changeStage} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="back" value={path} />
              <Field label="Stage">
                <select className="input" name="stage" defaultValue={lead.stage}>
                  {LEAD_STAGES.filter((s) => !["UNIT_BLOCKED", "BOOKED"].includes(s.key) || s.key === lead.stage).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Reason (if lost)">
                <select className="input" name="lostReason" defaultValue="">
                  <option value="">Not lost</option>
                  {["Budget", "Bought elsewhere", "Location", "Not responding", "Timing", "Loan not approved"].map((r) => <option key={r}>{r}</option>)}
                </select>
              </Field>
              <Button variant="secondary">Update</Button>
            </form>
          </Card>

          {isManager && (
            <Card title="Reassign">
              <form action={reassignLead} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="back" value={path} />
                <select className="input max-w-xs" name="ownerId" defaultValue={lead.ownerId ?? ""}>
                  {team.map((t) => <option key={t.id} value={t.id}>{t.name} · {ROLE_LABEL[t.role]}</option>)}
                </select>
                <Button variant="secondary">Reassign</Button>
              </form>
            </Card>
          )}

          <Card title="Unit">
            {lead.bookings.length > 0 ? (
              <div className="grid gap-2 text-sm">
                {lead.bookings.map((b) => (
                  <Link key={b.id} href={`/sales/bookings/${b.id}`} className="flex justify-between rounded-lg border border-line p-3 hover:border-stone">
                    <span>Booked {b.unit.number}</span><span>{inr(b.agreementValue)}</span>
                  </Link>
                ))}
              </div>
            ) : blocked && effectiveStatus(blocked) === "BLOCKED" ? (
              <div className="grid gap-3 text-sm">
                <p>Unit <strong>{blocked.number}</strong> is blocked for this buyer until {datetime(blocked.blockedUntil)}.</p>
                <LinkButton href={`/sales/inventory/${blocked.id}`}>Book this unit</LinkButton>
              </div>
            ) : !lead.projectId ? (
              <p className="text-sm text-stone">Set a project for this lead before blocking a unit.</p>
            ) : (
              <form action={blockUnit} className="grid gap-3">
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="back" value={path} />
                <Field label={`Available ${lead.preferredType && !sp.allTypes ? lead.preferredType + " " : ""}units in ${lead.project?.name}`}>
                  <select className="input" name="unitId" required>
                    {available.map((x) => <option key={x.id} value={x.id}>{x.number} · {x.type} · floor {x.floor} · {x.facing} · {inr(x.price)}</option>)}
                  </select>
                </Field>
                <div className="flex flex-wrap items-center gap-3">
                  <Button disabled={available.length === 0}>Block for 48 hours</Button>
                  {lead.preferredType && !sp.allTypes && <Link href={`${path}?allTypes=1`} className="text-xs text-stone underline underline-offset-4">Show all types</Link>}
                </div>
              </form>
            )}
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card title="Log what happened">
            <form action={logActivity} className="grid gap-3">
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="back" value={path} />
              <div className="flex flex-wrap gap-4 text-sm">
                {[["CALL", "Call"], ["WHATSAPP", "WhatsApp"], ["NOTE", "Note"]].map(([k, v], i) => (
                  <label key={k} className="flex min-h-11 items-center gap-2"><input type="radio" name="type" value={k} defaultChecked={i === 0} className="accent-[#a07a45]" /> {v}</label>
                ))}
              </div>
              <textarea className="input min-h-20" name="note" placeholder="What did you discuss?" />
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <Field label="Next follow-up (optional)"><input className="input" type="datetime-local" name="nextFollowUp" /></Field>
                <Button>Save</Button>
              </div>
            </form>
          </Card>

          {(aiReady || aiCalls.length > 0) && (
            <Card title="AI caller">
              {aiCalls.length === 0 && <p className="mb-3 text-sm text-stone">No AI calls to this buyer yet.</p>}
              <ul className="mb-3 grid gap-3 text-sm">
                {aiCalls.map((c) => (
                  <li key={c.id}>
                    <p><Badge tone={c.status === "completed" ? "good" : "neutral"}>{STATUS_LABEL[c.status] ?? c.status}</Badge> <span className="text-stone">{ago(c.createdAt)}{c.durationSec ? ` · talked ${Math.round(c.durationSec / 6) / 10} min` : ""}</span></p>
                    {c.summary && <p className="mt-1">{c.summary}</p>}
                    {c.transcript && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-stone">Full conversation</summary>
                        <pre className="mt-2 whitespace-pre-wrap font-sans text-xs">{c.transcript}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
              {aiReady && lead.consentAt && (
                <form action={callLeadWithAi}>
                  <input type="hidden" name="leadId" value={lead.id} />
                  <input type="hidden" name="back" value={path} />
                  <Button variant="secondary" size="sm">Call with AI now</Button>
                </form>
              )}
            </Card>
          )}

          <Card title="Schedule a site visit">
            <form action={scheduleVisit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="back" value={path} />
              <Field label="Date and time"><input className="input" type="datetime-local" name="when" required /></Field>
              <Field label="Note"><input className="input" name="note" placeholder="Coming with family" /></Field>
              <Button variant="secondary">Schedule</Button>
            </form>
            {nextVisit && <p className="mt-3 text-sm text-stone">Next visit: {datetime(nextVisit.scheduledFor)}</p>}
          </Card>

          <Card title="Timeline" pad={false}>
            <ol className="divide-y divide-line">
              {lead.activities.length === 0 && <li className="p-5 text-sm text-stone">No activity yet.</li>}
              {lead.activities.map((a) => (
                <li key={a.id} className="flex gap-4 px-5 py-3.5 text-sm">
                  <span className="w-20 shrink-0"><Badge tone={a.type === "SYSTEM" ? "warn" : a.type === "SITE_VISIT" ? "brass" : "neutral"}>{ACT_LABEL[a.type] ?? a.type}</Badge></span>
                  <div className="min-w-0 flex-1">
                    <p>{a.note ?? "–"}{a.scheduledFor && <span className="text-stone"> · for {datetime(a.scheduledFor)}</span>}</p>
                    <p className="mt-0.5 text-xs text-stone">{a.userId ? userName.get(a.userId) : "System"} · {ago(a.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
