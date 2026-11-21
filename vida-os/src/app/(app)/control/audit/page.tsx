import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { datetime } from "@/lib/format";
import { PageHeader, Card, Table, Badge, Notice } from "@/components/ui";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string }> }) {
  await requireUser(["MD", "FINANCE_HEAD"]);
  const { q, type } = await searchParams;
  const rows = await db.auditLog.findMany({
    where: {
      ...(type ? { entityType: type } : {}),
      ...(q ? { OR: [{ summary: { contains: q, mode: "insensitive" } }, { userName: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: { at: "desc" },
    take: 300,
  });
  const types = (await db.auditLog.findMany({ distinct: ["entityType"], select: { entityType: true } })).map((t) => t.entityType).sort();

  return (
    <>
      <PageHeader eyebrow="Control" title="Audit trail" />
      <div className="mb-6">
        <Notice tone="neutral">Every create, change, approval and sign-in is recorded here with who and when. Records can be added but never edited or deleted, not even by the MD.</Notice>
      </div>
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Search person or text" className="input max-w-xs" />
        <select name="type" defaultValue={type ?? ""} className="input max-w-[14rem]">
          <option value="">All record types</option>
          {types.map((t) => <option key={t}>{t}</option>)}
        </select>
        <button className="min-h-11 rounded-lg border border-line bg-white px-4 text-sm">Filter</button>
      </form>
      <Card pad={false}>
        <Table head={["When", "Who", "Action", "Record", "What happened"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap text-stone">{datetime(r.at)}</td>
              <td className="whitespace-nowrap">{r.userName ?? "System"}</td>
              <td><Badge tone={r.action === "REJECT" ? "bad" : r.action === "APPROVE" ? "good" : "neutral"}>{r.action}</Badge></td>
              <td className="text-stone">{r.entityType}</td>
              <td>
                {r.summary}
                {(r.before || r.after) && (
                  <details className="mt-1 text-xs text-stone">
                    <summary className="cursor-pointer">Show change</summary>
                    {r.before && <pre className="mt-1 whitespace-pre-wrap">Before: {r.before}</pre>}
                    {r.after && <pre className="whitespace-pre-wrap">After: {r.after}</pre>}
                  </details>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
