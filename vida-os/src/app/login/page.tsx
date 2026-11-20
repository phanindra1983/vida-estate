import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { signSession, SESSION_COOKIE } from "@/lib/session";
import { audit } from "@/lib/audit";
import { getUser } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/constants";

/** The public website. Set WEBSITE_URL in .env when it goes live. */
const WEBSITE_URL = process.env.WEBSITE_URL || "http://localhost:4400";

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const u = await db.user.findUnique({ where: { email } });
  if (!u || !u.active || !(await bcrypt.compare(password, u.passwordHash))) {
    redirect("/login?error=1");
  }
  const token = await signSession({ uid: u.id, role: u.role, name: u.name });
  // Secure cookie only over https (the public link). Safari drops Secure cookies on http://localhost.
  const h = await headers();
  const https = (h.get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: https, path: "/", maxAge: 60 * 60 * 12 });
  await audit({ id: u.id, name: u.name }, "LOGIN", "User", u.id, `${u.name} signed in`);
  redirect("/");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getUser()) redirect("/");
  const { error } = await searchParams;
  const host = (await headers()).get("host") || "";
  const site = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http://localhost:4400" : WEBSITE_URL;
  const demo = process.env.NODE_ENV !== "production"
    ? await db.user.findMany({ select: { email: true, role: true, name: true }, orderBy: { createdAt: "asc" } })
    : [];

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-ink p-12 text-white lg:flex">
        <a href={site} aria-label="Vida Estates website"><img src="/logo-light.svg" alt="Vida Estates" className="w-40" /></a>
        <div>
          <p className="eyebrow !text-[#cdb48a]">Vida OS</p>
          <h1 className="mt-4 max-w-md font-serif text-5xl leading-[1.05]">One place to run every Vida project.</h1>
          <p className="mt-5 max-w-sm text-sm text-white/70">Sales, collections, construction, purchasing and approvals, live and traceable.</p>
        </div>
        <p className="text-xs text-white/40">Vida Estates · Hyderabad</p>
      </section>

      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <a href={site} className="mb-8 inline-flex min-h-11 items-center gap-2 text-sm text-stone hover:text-ink">
            <span aria-hidden="true">←</span> Back to vidaestates.com
          </a>
          <img src="/logo-dark.svg" alt="Vida Estates" className="mb-10 w-32 lg:hidden" />
          <h2 className="font-serif text-3xl">Sign in</h2>
          <p className="mt-1 text-sm text-stone">Use your Vida work email.</p>
          {error && <p className="mt-4 rounded-lg bg-[#fbefec] px-3 py-2 text-sm text-bad">That email and password did not match.</p>}
          <form action={login} className="mt-6 grid gap-4">
            <label className="field">Email<input className="input" name="email" type="email" required autoComplete="username" /></label>
            <label className="field">Password<input className="input" name="password" type="password" required autoComplete="current-password" /></label>
            <button className="min-h-11 rounded-lg bg-ink text-sm font-medium text-white hover:bg-ink-2">Sign in</button>
          </form>

          {demo.length > 0 && (
            <details className="mt-10 rounded-lg border border-line bg-white p-4 text-xs text-ink-2">
              <summary className="cursor-pointer font-medium">Demo accounts (development only)</summary>
              <p className="mt-2 text-stone">The shared demo password is in the README.</p>
              <ul className="mt-3 grid gap-1.5">
                {demo.map((d) => (
                  <li key={d.email} className="flex justify-between gap-3">
                    <span>{ROLE_LABEL[d.role] ?? d.role}</span>
                    <span className="text-stone">{d.email}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </section>
    </main>
  );
}
