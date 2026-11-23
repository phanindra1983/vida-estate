import { timingSafeEqual } from "node:crypto";
import { redirect, notFound } from "next/navigation";
import { cookies, headers } from "next/headers";
import { db } from "@/lib/db";
import { signSession, SESSION_COOKIE } from "@/lib/session";
import { audit } from "@/lib/audit";
import { ROLE_LABEL } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * Testing link: open Vida OS without a password, as any role. Only works with the secret key
 * in the link (Setting `test.access` = {"key": "...", "on": true}). Turn it off by setting "on": false.
 */
async function testAccess(given: string | undefined) {
  if (!given) return false;
  const s = await db.setting.findUnique({ where: { key: "test.access" } });
  if (!s) return false;
  try {
    const { key, on } = JSON.parse(s.value) as { key: string; on: boolean };
    const a = Buffer.from(key), b = Buffer.from(given);
    return !!on && a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const ORDER = ["MD", "SALES_HEAD", "SALES_MANAGER", "SALES_EXEC", "MARKETING", "GM_PROJECTS", "PROJECT_MANAGER", "SITE_ENGINEER", "STOREKEEPER", "PURCHASE", "FINANCE_HEAD", "ACCOUNTS", "HR"];

async function enterAs(fd: FormData) {
  "use server";
  const key = String(fd.get("key") ?? "");
  if (!linkSwitchedOn() || !(await testAccess(key))) redirect("/login");
  const u = await db.user.findUnique({ where: { id: String(fd.get("userId") ?? "") } });
  if (!u || !u.active) redirect(`/try?key=${encodeURIComponent(key)}`);
  const token = await signSession({ uid: u.id, role: u.role, name: u.name });
  const https = ((await headers()).get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: https, path: "/", maxAge: 60 * 60 * 12 });
  await audit({ id: u.id, name: u.name }, "LOGIN", "User", u.id, `${u.name} opened Vida OS with the testing link (no password)`);
  redirect("/");
}

/** In production the testing link works only while the owner sets TEST_LINK=on in Vercel. */
const linkSwitchedOn = () => process.env.NODE_ENV !== "production" || process.env.TEST_LINK === "on";

export default async function TryPage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  if (!linkSwitchedOn()) notFound();
  const { key } = await searchParams;
  const ok = await testAccess(key);
  const users = ok ? await db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, role: true } }) : [];
  const byRole = ORDER.map((r) => ({ role: r, people: users.filter((x) => x.role === r) })).filter((g) => g.people.length);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <p className="eyebrow">Vida OS · testing</p>
      <h1 className="mt-2 font-serif text-4xl">Open Vida OS as…</h1>
      {!ok ? (
        <p className="mt-6 text-stone">This testing link is off or not valid. Please sign in normally.</p>
      ) : (
        <>
          <p className="mt-3 max-w-xl text-sm text-stone">No password while we test. Pick whose screen you want to see. Open this link again any time to switch role. Everything you do is recorded under that person&apos;s name in the audit trail.</p>
          <div className="mt-8 grid gap-6">
            {byRole.map((g) => (
              <section key={g.role}>
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-stone">{ROLE_LABEL[g.role] ?? g.role}</h2>
                <div className="flex flex-wrap gap-2">
                  {g.people.map((p) => (
                    <form key={p.id} action={enterAs}>
                      <input type="hidden" name="key" value={key} />
                      <input type="hidden" name="userId" value={p.id} />
                      <button className="min-h-11 rounded-lg border border-line bg-white px-4 text-sm font-medium hover:border-stone">{p.name}</button>
                    </form>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
