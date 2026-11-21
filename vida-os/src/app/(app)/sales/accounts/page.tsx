import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { SALES_ROLES, SALES_MANAGERS } from "@/lib/constants";
import { ACCOUNTS_SOURCE, ACCOUNT_STATUSES } from "@/lib/accounts";
import { sourceKey } from "@/lib/lead-intake";
import { ago } from "@/lib/format";
import { PageHeader, Card, Table, Badge, Button, Notice, cx } from "@/components/ui";
import { setAccountStatus } from "../actions";
import { Flash, SubNav, one, type SP } from "../_ui";

const TONE: Record<string, "good" | "bad" | "warn" | "neutral"> = { YES: "good", NO: "bad", CONTACTED: "warn", NEW: "neutral" };

export default async function CorporateAccountsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(SALES_ROLES);
  const sp = await searchParams;
  const areas = await db.corporateAccount.groupBy({ by: ["areaKey", "area"], _count: { _all: true }, orderBy: { areaKey: "asc" } });
  const areaKey = one(sp.area) ?? areas[0]?.areaKey ?? "";
  const status = one(sp.status) ?? "";
  const where: Prisma.CorporateAccountWhereInput = { areaKey };
  if (status) where.status = status;
  const [accounts, counts] = await Promise.all([
    areaKey ? db.corporateAccount.findMany({ where, orderBy: [{ fitScore: { sort: "desc", nulls: "last" } }, { kmFromSite: "asc" }], take: 300 }) : Promise.resolve([]),
    areaKey ? db.corporateAccount.groupBy({ by: ["status"], where: { areaKey }, _count: { _all: true } }) : Promise.resolve([]),
  ]);
  const countOf = (k: string) => counts.find((c) => c.status === k)?._count._all ?? 0;
  const isMd = u.role === "MD";
  const key = isMd ? await sourceKey(ACCOUNTS_SOURCE) : null;
  const here = (extra: Record<string, string>) => `/sales/accounts?${new URLSearchParams({ area: areaKey, ...(status ? { status } : {}), ...extra })}`;

  return (
    <>
      <PageHeader eyebrow="Sales" title="Corporate accounts" />
      <SubNav active="/sales/accounts" />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      <p className="-mt-4 mb-6 max-w-3xl text-sm text-stone">
        Employer clusters and employers near each project, refreshed monthly from the micromarket dashboard. Qualify each one for a corporate
        or bulk-sales tie-up: reach out through the company&apos;s HR or admin team, then mark it qualified or not a fit.
      </p>

      {areas.length === 0 ? (
        <Notice tone="neutral">No accounts yet. They arrive with the next monthly push from the micromarket dashboard.</Notice>
      ) : (
        <>
          <nav className="mb-4 flex flex-wrap gap-2">
            {areas.map((a) => (
              <Link key={a.areaKey} href={`/sales/accounts?area=${encodeURIComponent(a.areaKey)}`}
                className={cx("rounded-full border px-3 py-1.5 text-sm", a.areaKey === areaKey ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:border-stone")}>
                {a.area} <span className="opacity-70">({a._count._all})</span>
              </Link>
            ))}
          </nav>
          <nav className="mb-6 flex flex-wrap gap-1 text-sm">
            {[{ key: "", label: "All" }, ...ACCOUNT_STATUSES].map((s) => (
              <Link key={s.key} href={`/sales/accounts?${new URLSearchParams({ area: areaKey, ...(s.key ? { status: s.key } : {}) })}`}
                className={cx("rounded-lg px-3 py-1.5", status === s.key ? "bg-[#f1eee8] text-ink" : "text-stone hover:text-ink")}>
                {s.label}{s.key ? ` · ${countOf(s.key)}` : ""}
              </Link>
            ))}
          </nav>

          <Card pad={false}>
            <Table head={["Account", "Sector", { label: "From site", num: true }, { label: "Fit", num: true }, { label: "Job posts", num: true }, "Largest employers", "Status", "Qualify"]}
              empty="No accounts with this status.">
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-stone">{a.kind === "CLUSTER" ? "Employer cluster" : a.cluster ?? "Employer"} · last refreshed {ago(a.lastSeenAt)}</div>
                    {a.evidence && <div className="mt-1 max-w-sm text-xs text-stone">{a.evidence}</div>}
                  </td>
                  <td>{a.sector ?? "–"}</td>
                  <td className="num">{a.kmFromSite != null ? `${a.kmFromSite.toFixed(1)} km` : "–"}</td>
                  <td className="num">{a.fitScore ?? "–"}</td>
                  <td className="num">{a.jobPosts ?? "–"}{a.medianCtcLakh ? <div className="text-xs text-stone">₹{a.medianCtcLakh} L CTC</div> : null}</td>
                  <td className="max-w-xs text-sm">{a.topEmployers ?? "–"}</td>
                  <td>
                    <Badge tone={TONE[a.status] ?? "neutral"}>{ACCOUNT_STATUSES.find((s) => s.key === a.status)?.label ?? a.status}</Badge>
                    {a.statusNote && <div className="mt-1 max-w-[14rem] text-xs text-stone">{a.statusNote}</div>}
                  </td>
                  <td>
                    <form action={setAccountStatus} className="flex min-w-[15rem] flex-col gap-2">
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="back" value={here({})} />
                      <input className="input" name="note" placeholder="Note (who you spoke to, next step)" defaultValue={a.statusNote ?? ""} maxLength={300} />
                      <div className="flex gap-1.5">
                        <Button size="sm" name="status" value="YES">Yes</Button>
                        <Button size="sm" variant="danger" name="status" value="NO">No</Button>
                        <Button size="sm" variant="secondary" name="status" value="CONTACTED">Contacted</Button>
                      </div>
                    </form>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}

      {isMd && key && (
        <div className="mt-8">
          <Card title="Monthly push from the micromarket dashboard">
            <p className="text-sm text-ink-2">The dashboard sends accounts to <code>/api/accounts/in</code> with this key. Keep it private; it goes in the dashboard&apos;s <code>.env</code> as <code>VIDA_ACCOUNTS_KEY</code>.</p>
            <p className="mt-2 break-all rounded-lg bg-[#f1eee8] px-3 py-2 font-mono text-xs">{key}</p>
            {SALES_MANAGERS.includes(u.role) && <p className="mt-2 text-xs text-stone">To change it, rotate the key the same way as other lead sources on Control → Lead sources.</p>}
          </Card>
        </div>
      )}
    </>
  );
}
