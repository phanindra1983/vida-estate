import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { ROLE_LABEL, ALL_PROJECT_ROLES } from "@/lib/constants";
import { PageHeader, Card, Table, Badge, Button, Field, Notice } from "@/components/ui";

async function addUser(formData: FormData) {
  "use server";
  const me = await requireUser(["MD"]);
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const role = String(formData.get("role"));
  const password = String(formData.get("password") || "");
  if (!name || !email || password.length < 10) redirect("/control/users?err=" + encodeURIComponent("Name, email and a password of at least 10 characters are required."));
  if (await db.user.findUnique({ where: { email } })) redirect("/control/users?err=" + encodeURIComponent("That email is already in use."));
  const u = await db.user.create({ data: { name, email, role, passwordHash: await bcrypt.hash(password, 10) } });
  await audit(me, "CREATE", "User", u.id, `Added user ${name} as ${ROLE_LABEL[role]}`);
  revalidatePath("/control/users");
}

async function update(formData: FormData) {
  "use server";
  const me = await requireUser(["MD"]);
  const id = String(formData.get("id"));
  const before = await db.user.findUniqueOrThrow({ where: { id }, include: { access: true } });
  const role = String(formData.get("role"));
  const active = formData.get("active") === "on";
  const projectIds = formData.getAll("projects").map(String);
  if (id === me.id && (!active || role !== "MD")) redirect("/control/users?err=" + encodeURIComponent("You cannot remove your own MD access."));
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { role, active } });
    await tx.projectAccess.deleteMany({ where: { userId: id } });
    for (const p of projectIds) await tx.projectAccess.create({ data: { userId: id, projectId: p } });
    await audit(me, "UPDATE", "User", id, `Updated access for ${before.name}`,
      { before: { role: before.role, active: before.active, projects: before.access.map((a) => a.projectId) }, after: { role, active, projects: projectIds } }, tx);
  });
  revalidatePath("/control/users");
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  await requireUser(["MD"]);
  const { err } = await searchParams;
  const users = await db.user.findMany({ include: { access: true }, orderBy: [{ role: "asc" }, { name: "asc" }] });
  const projects = await db.project.findMany({ orderBy: { name: "asc" } });

  return (
    <>
      <PageHeader eyebrow="Control" title="Users & access" />
      {err && <div className="mb-4"><Notice tone="bad">{err}</Notice></div>}
      <Card pad={false} className="mb-8">
        <Table head={["Person", "Role", "Projects", "Active", ""]}>
          {users.map((u) => (
            <tr key={u.id}>
              <td><p className="font-medium">{u.name}</p><p className="text-xs text-stone">{u.email}</p></td>
              <td colSpan={4}>
                <form action={update} className="grid items-center gap-3 md:grid-cols-[12rem_1fr_5rem_auto]">
                  <input type="hidden" name="id" value={u.id} />
                  <select name="role" defaultValue={u.role} className="input">
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-3 text-xs">
                    {ALL_PROJECT_ROLES.includes(u.role) ? <Badge>All projects</Badge> : projects.map((p) => (
                      <label key={p.id} className="flex items-center gap-1.5">
                        <input type="checkbox" name="projects" value={p.id} defaultChecked={u.access.some((a) => a.projectId === p.id)} /> {p.name}
                      </label>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" name="active" defaultChecked={u.active} /> Active</label>
                  <Button size="sm" variant="secondary">Save</Button>
                </form>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Add a person">
        <form action={addUser} className="grid gap-4 md:grid-cols-4">
          <Field label="Full name"><input name="name" className="input" required /></Field>
          <Field label="Work email"><input name="email" type="email" className="input" required /></Field>
          <Field label="Role">
            <select name="role" className="input">{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          <Field label="First password" hint="At least 10 characters. Ask them to change it."><input name="password" type="password" className="input" required minLength={10} /></Field>
          <div className="md:col-span-4"><Button>Add person</Button></div>
        </form>
      </Card>
    </>
  );
}
