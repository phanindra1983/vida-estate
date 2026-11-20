import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "./db";
import { SESSION_COOKIE, verifySession } from "./session";
import { ALL_PROJECT_ROLES } from "./constants";

export type CurrentUser = { id: string; name: string; email: string; role: string; projectIds: string[] | "ALL" };

export const getUser = cache(async (): Promise<CurrentUser | null> => {
  const jar = await cookies();
  const s = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!s) return null;
  const u = await db.user.findUnique({ where: { id: s.uid }, include: { access: true } });
  if (!u || !u.active) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    projectIds: ALL_PROJECT_ROLES.includes(u.role) ? "ALL" : u.access.map((a) => a.projectId),
  };
});

/** Use at the top of every page and server action. Redirects if not allowed. */
export async function requireUser(roles?: string[]): Promise<CurrentUser> {
  const u = await getUser();
  if (!u) redirect("/login");
  if (roles && !roles.includes(u.role)) redirect("/no-access");
  return u;
}

export function can(u: CurrentUser, roles: string[]) {
  return roles.includes(u.role);
}

/** Prisma `where` fragment limiting rows to the user's projects. */
export function projectScope(u: CurrentUser): { projectId?: { in: string[] } } {
  return u.projectIds === "ALL" ? {} : { projectId: { in: u.projectIds } };
}

export function canSeeProject(u: CurrentUser, projectId: string | null | undefined) {
  if (u.projectIds === "ALL") return true;
  return !!projectId && u.projectIds.includes(projectId);
}
