import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ROLE_LABEL } from "@/lib/constants";
import { Sidebar } from "@/components/Sidebar";
import { navFor } from "@/components/nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Count requests that are waiting for this user's role right now.
  const pendingReqs = await db.approvalRequest.findMany({ where: { status: "PENDING", requestedById: { not: user.id } }, select: { action: true, currentLevel: true } });
  const rules = await db.approvalRule.findMany({ where: { role: user.role } });
  const pending = pendingReqs.filter((r) => rules.some((x) => x.action === r.action && x.level === r.currentLevel)).length;

  return (
    <div className="min-h-screen">
      <Sidebar groups={navFor(user.role)} user={{ name: user.name, roleLabel: ROLE_LABEL[user.role] ?? user.role }} pending={pending} />
      <main className="lg:pl-64 print:pl-0">
        <div className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-10">{children}</div>
      </main>
    </div>
  );
}
