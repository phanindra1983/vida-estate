import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { inr, date } from "@/lib/format";
import { PageHeader, Card, Table, Button, Field, Status, Badge } from "@/components/ui";

const ROLES = ["MD", "FINANCE_HEAD", "GM_PROJECTS", "PURCHASE", "SALES_HEAD", "HR"];

async function addVendor(fd: FormData) {
  "use server";
  const u = await requireUser(["MD", "FINANCE_HEAD", "PURCHASE", "GM_PROJECTS"]);
  const v = await db.vendor.create({ data: { name: String(fd.get("name")), category: String(fd.get("category")), gstin: String(fd.get("gstin") || "") || null, phone: String(fd.get("phone") || "") || null, email: String(fd.get("email") || "") || null, verified: true } });
  await audit(u, "CREATE", "Vendor", v.id, `Added vendor ${v.name}`);
  revalidatePath("/control/masters");
}
async function toggleVerified(fd: FormData) {
  "use server";
  const u = await requireUser(["MD", "FINANCE_HEAD", "PURCHASE", "GM_PROJECTS"]);
  const v = await db.vendor.findUniqueOrThrow({ where: { id: String(fd.get("id")) } });
  await db.vendor.update({ where: { id: v.id }, data: { verified: !v.verified } });
  await audit(u, "UPDATE", "Vendor", v.id, `${v.verified ? "Removed verification for" : "Verified"} ${v.name}`);
  revalidatePath("/control/masters");
}

async function addPartner(fd: FormData) {
  "use server";
  const u = await requireUser(["MD", "SALES_HEAD", "FINANCE_HEAD"]);
  const c = await db.channelPartner.create({ data: { name: String(fd.get("name")), firm: String(fd.get("firm") || "") || null, phone: String(fd.get("phone")), reraAgentNo: String(fd.get("rera") || "") || null, commissionPct: Number(fd.get("pct") || 2) } });
  await audit(u, "CREATE", "ChannelPartner", c.id, `Added channel partner ${c.name} at ${c.commissionPct}%`);
  revalidatePath("/control/masters");
}
async function addEmployee(fd: FormData) {
  "use server";
  const u = await requireUser(["MD", "HR"]);
  const e = await db.employee.create({ data: { name: String(fd.get("name")), department: String(fd.get("department")), designation: String(fd.get("designation")), phone: String(fd.get("phone") || "") || null, joinedOn: fd.get("joined") ? new Date(String(fd.get("joined"))) : null } });
  await audit(u, "CREATE", "Employee", e.id, `Added employee ${e.name}`);
  revalidatePath("/control/masters");
}

export default async function MastersPage({ searchParams }: { searchParams: Promise<{ tab?: string; cat?: string; src?: string }> }) {
  const user = await requireUser(ROLES);
  const { tab = "projects", cat, src } = await searchParams;
  const tabs = [["projects", "Projects"], ["costcodes", "Cost codes"], ["vendors", "Vendors"], ["partners", "Channel partners"], ["employees", "Employees"]];

  return (
    <>
      <PageHeader eyebrow="Control" title="Masters" />
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-line">
        {tabs.map(([k, l]) => (
          <a key={k} href={`?tab=${k}`} className={`-mb-px min-h-11 border-b-2 px-4 py-3 text-sm ${tab === k ? "border-ink font-medium" : "border-transparent text-stone hover:text-ink"}`}>{l}</a>
        ))}
      </nav>

      {tab === "projects" && <Projects />}
      {tab === "costcodes" && <CostCodes />}
      {tab === "vendors" && <Vendors canAdd={["MD", "FINANCE_HEAD", "PURCHASE", "GM_PROJECTS"].includes(user.role)} sp={{ cat, src }} />}
      {tab === "partners" && <Partners canAdd={["MD", "SALES_HEAD", "FINANCE_HEAD"].includes(user.role)} />}
      {tab === "employees" && <Employees canAdd={["MD", "HR"].includes(user.role)} />}
    </>
  );
}

async function Projects() {
  const projects = await db.project.findMany({ include: { towers: true, _count: { select: { units: true } } } });
  return (
    <Card pad={false}>
      <Table head={["Code", "Project", "Location", "Towers", "Units", "From", "TS RERA", "Status", "On website"]}>
        {projects.map((p) => (
          <tr key={p.id}>
            <td className="font-medium">{p.code}</td>
            <td>{p.name}</td>
            <td>{p.location}</td>
            <td>{p.towers.map((t) => `${t.name} (${t.floors} fl)`).join(", ")}</td>
            <td>{p._count.units}</td>
            <td>{inr(p.startingPrice)}</td>
            <td className="text-stone">{p.reraNo}</td>
            <td><Status value={p.status} /></td>
            <td>{p.published ? "Yes" : "No"}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function CostCodes() {
  const codes = await db.costCode.findMany({ orderBy: { code: "asc" } });
  return (
    <Card pad={false}>
      <Table head={["Code", "Cost head"]}>
        {codes.map((c) => <tr key={c.id}><td className="font-medium">{c.code}</td><td>{c.name}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Vendors({ canAdd, sp }: { canAdd: boolean; sp: { cat?: string; src?: string } }) {
  const all = await db.vendor.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }], include: { _count: { select: { orders: true } } } });
  const cats = [...new Set(all.map((v) => v.category))].sort();
  const vendors = all.filter((v) => (!sp.cat || v.category === sp.cat) && (sp.src === "demo" ? v.isDemo : sp.src === "research" ? !v.isDemo : sp.src === "verified" ? v.verified : true));
  const researched = all.filter((v) => !v.isDemo).length;
  return (
    <div className="grid gap-6">
      <p className="text-sm text-stone">{all.length} vendors: {researched} found by public research for West Hyderabad (each with its source), {all.length - researched} fictional demo vendors, {all.filter((v) => v.verified).length} verified by phone. Research data is unverified until your team confirms it; enquiries go to verified vendors first.</p>
      <form className="flex flex-wrap gap-2 text-sm">
        <input type="hidden" name="tab" value="vendors" />
        <select name="cat" defaultValue={sp.cat ?? ""} className="input max-w-xs"><option value="">All categories</option>{cats.map((c) => <option key={c}>{c}</option>)}</select>
        <select name="src" defaultValue={sp.src ?? ""} className="input max-w-[12rem]"><option value="">All sources</option><option value="research">Researched</option><option value="verified">Verified</option><option value="demo">Demo</option></select>
        <button className="min-h-11 rounded-lg border border-line bg-white px-4">Filter</button>
      </form>
      <Card pad={false}>
        <Table head={["Vendor", "Category", "Type and brands", "Area", "Contact", "Status", ""]} empty="No vendors match.">
          {vendors.map((v) => (
            <tr key={v.id}>
              <td className="font-medium">{v.name}{v.notes && <p className="text-xs font-normal text-stone">{v.notes}</p>}</td>
              <td className="text-sm">{v.category}</td>
              <td className="text-sm">{v.type}{v.brands && <p className="text-xs text-stone">{v.brands}</p>}</td>
              <td className="text-sm">{v.area}</td>
              <td className="text-xs">
                {v.phone && <p>{v.phone}</p>}{v.email && <p>{v.email}</p>}
                {v.website && <p><a href={v.website.startsWith("http") ? v.website : `https://${v.website}`} target="_blank" rel="noreferrer" className="underline">Website</a></p>}
                {v.sourceUrl && <p><a href={v.sourceUrl} target="_blank" rel="noreferrer" className="text-stone underline">Source</a></p>}
              </td>
              <td>{v.isDemo ? <Badge>Demo</Badge> : v.verified ? <Badge tone="good">Verified</Badge> : <Badge tone="warn">To verify</Badge>}<p className="mt-1 text-xs text-stone">{v._count.orders} PO</p></td>
              <td>{canAdd && !v.isDemo && (
                <form action={toggleVerified}><input type="hidden" name="id" value={v.id} /><Button size="sm" variant="ghost">{v.verified ? "Unverify" : "Mark verified"}</Button></form>
              )}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {canAdd && (
        <Card title="Add vendor">
          <form action={addVendor} className="grid gap-4 md:grid-cols-4">
            <Field label="Name"><input name="name" className="input" required /></Field>
            <Field label="Category"><select name="category" className="input">{cats.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="GSTIN"><input name="gstin" className="input" /></Field>
            <Field label="Phone"><input name="phone" className="input" /></Field>
            <Field label="Email"><input name="email" type="email" className="input" /></Field>
            <div><Button size="sm">Add vendor</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}

async function Partners({ canAdd }: { canAdd: boolean }) {
  const cps = await db.channelPartner.findMany({ include: { _count: { select: { leads: true } } } });
  return (
    <div className="grid gap-6">
      <Card pad={false}>
        <Table head={["Partner", "Firm", "Phone", "RERA agent no.", "Commission", "Leads"]}>
          {cps.map((c) => <tr key={c.id}><td className="font-medium">{c.name}</td><td>{c.firm}</td><td>{c.phone}</td><td className="text-stone">{c.reraAgentNo}</td><td>{c.commissionPct}%</td><td>{c._count.leads}</td></tr>)}
        </Table>
      </Card>
      {canAdd && (
        <Card title="Add channel partner">
          <form action={addPartner} className="grid gap-4 md:grid-cols-5">
            <Field label="Name"><input name="name" className="input" required /></Field>
            <Field label="Firm"><input name="firm" className="input" /></Field>
            <Field label="Phone"><input name="phone" className="input" required /></Field>
            <Field label="RERA agent no."><input name="rera" className="input" /></Field>
            <Field label="Commission %"><input name="pct" type="number" step="0.25" defaultValue={2} className="input" /></Field>
            <div><Button size="sm">Add partner</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}

async function Employees({ canAdd }: { canAdd: boolean }) {
  const emps = await db.employee.findMany({ orderBy: [{ department: "asc" }, { name: "asc" }], include: { user: true } });
  return (
    <div className="grid gap-6">
      <Card pad={false}>
        <Table head={["Name", "Department", "Designation", "Phone", "Joined", "Vida OS login"]}>
          {emps.map((e) => <tr key={e.id}><td className="font-medium">{e.name}</td><td>{e.department}</td><td>{e.designation}</td><td>{e.phone}</td><td>{date(e.joinedOn)}</td><td>{e.user ? e.user.email : "–"}</td></tr>)}
        </Table>
      </Card>
      {canAdd && (
        <Card title="Add employee">
          <form action={addEmployee} className="grid gap-4 md:grid-cols-5">
            <Field label="Name"><input name="name" className="input" required /></Field>
            <Field label="Department"><input name="department" className="input" required /></Field>
            <Field label="Designation"><input name="designation" className="input" required /></Field>
            <Field label="Phone"><input name="phone" className="input" /></Field>
            <Field label="Joined on"><input name="joined" type="date" className="input" /></Field>
            <div><Button size="sm">Add employee</Button></div>
          </form>
          <p className="mt-4 text-xs text-stone">Attendance, leave and payroll arrive in Phase 3.</p>
        </Card>
      )}
    </div>
  );
}
