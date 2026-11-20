import { db } from "@/lib/db";
import { requireUser, can } from "@/lib/auth";
import { PROCUREMENT_ROLES } from "@/lib/constants";
import { datetime, num } from "@/lib/format";
import { PageHeader, Card, Table, Field, Button, Badge } from "@/components/ui";
import { Flash } from "../../projects/_components/Flash";
import { ProjectTabs } from "../../projects/_components/ProjectTabs";
import { issueStock } from "../actions";

export default async function StockPage({ searchParams }: { searchParams: Promise<{ project?: string; ok?: string; error?: string }> }) {
  const user = await requireUser(PROCUREMENT_ROLES);
  const sp = await searchParams;
  const projects = await db.project.findMany({
    where: user.projectIds === "ALL" ? {} : { id: { in: user.projectIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  const current = projects.find((p) => p.id === sp.project) ?? projects[0];
  if (!current) return <PageHeader eyebrow="Cost" title="Site stock" />;

  const grouped = await db.stockMove.groupBy({ by: ["item", "unit"], where: { projectId: current.id }, _sum: { qty: true } });
  const received = await db.stockMove.groupBy({ by: ["item", "unit"], where: { projectId: current.id, type: "RECEIPT" }, _sum: { qty: true } });
  const stock = grouped
    .map((g) => ({ item: g.item, unit: g.unit, onHand: g._sum.qty ?? 0, received: received.find((r) => r.item === g.item && r.unit === g.unit)?._sum.qty ?? 0 }))
    .sort((a, b) => a.item.localeCompare(b.item));
  const moves = await db.stockMove.findMany({ where: { projectId: current.id }, orderBy: { at: "desc" }, take: 12 });
  const canIssue = can(user, ["STOREKEEPER", "SITE_ENGINEER", "PROJECT_MANAGER"]);
  const inStock = stock.filter((s) => s.onHand > 0);

  return (
    <>
      <PageHeader eyebrow="Cost" title="Site stock" />
      <ProjectTabs base="/cost/stock" projects={projects} current={current.id} />
      <Flash sp={sp} />
      <div className={`grid gap-6 ${canIssue ? "lg:grid-cols-[1fr_22rem]" : ""}`}>
        <div className="grid gap-6">
          <Card title={`${current.name} stores`} pad={false}>
            <Table head={["Item", { label: "Received", num: true }, { label: "Issued", num: true }, { label: "On hand", num: true }]} empty="No stock movements yet.">
              {stock.map((s) => (
                <tr key={s.item + s.unit}>
                  <td>{s.item}</td>
                  <td className="num">{num(s.received, 2)} {s.unit}</td>
                  <td className="num">{num(s.received - s.onHand, 2)} {s.unit}</td>
                  <td className="num font-medium">{num(s.onHand, 2)} {s.unit}{s.onHand <= 0 && <span className="ml-2"><Badge tone="warn">Empty</Badge></span>}</td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Recent movements" pad={false}>
            <Table head={["When", "Item", "Type", { label: "Qty", num: true }, "Reference"]}>
              {moves.map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap">{datetime(m.at)}</td>
                  <td>{m.item}</td>
                  <td><Badge tone={m.type === "RECEIPT" ? "good" : "neutral"}>{m.type === "RECEIPT" ? "Received" : "Issued"}</Badge></td>
                  <td className="num">{m.qty > 0 ? "+" : ""}{num(m.qty, 2)} {m.unit}</td>
                  <td className="text-xs">{m.reference}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>

        {canIssue && (
          <Card title="Issue to site">
            {inStock.length === 0 ? (
              <p className="text-sm text-stone">Nothing in stock to issue.</p>
            ) : (
              <form action={issueStock} className="grid gap-4">
                <Field label="Item">
                  <select name="key" className="input" required>
                    {inStock.map((s) => <option key={s.item + s.unit} value={`${current.id}|${s.item}|${s.unit}`}>{s.item} ({num(s.onHand, 2)} {s.unit})</option>)}
                  </select>
                </Field>
                <Field label="Quantity"><input name="qty" type="number" step="any" min={0} inputMode="decimal" className="input" required /></Field>
                <Field label="Issued for"><input name="reference" className="input" placeholder="e.g. Slab 10, Tower A" /></Field>
                <Button>Issue</Button>
              </form>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
