"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { str, fail, done } from "@/lib/cost";
import { send, esc } from "@/lib/telegram";

const CLOSERS = ["PROJECT_MANAGER", "GM_PROJECTS", "MD"];
const BACK = "/projects/issues";

/** Close a fixed issue after checking it, or send it back to open. */
export async function reviewIssue(fd: FormData) {
  const user = await requireUser(CLOSERS);
  const id = str(fd, "id");
  const closeIt = str(fd, "decision") === "close";
  const i = await db.siteIssue.findUnique({ where: { id } });
  if (!i || !canSeeProject(user, i.projectId)) fail(BACK, "Issue not found.");
  if (i.status !== "FIXED") fail(BACK, `${i.number} is not waiting for a check.`);
  await db.siteIssue.update({
    where: { id },
    data: closeIt ? { status: "CLOSED", closedById: user.id, closedAt: new Date() } : { status: "OPEN", fixedById: null, fixedAt: null, fixPhotos: null },
  });
  await audit(user, closeIt ? "APPROVE" : "REJECT", "SiteIssue", id, `${closeIt ? "Closed" : "Reopened"} ${i.number}`);
  for (const uid of new Set([i.raisedById, i.fixedById].filter((x): x is string => !!x && x !== user.id))) {
    const u = await db.user.findUnique({ where: { id: uid } });
    if (u?.telegramChatId) await send(u.telegramChatId, `${i.number} was ${closeIt ? "closed" : "reopened"} by ${esc(user.name)}.`).catch(() => {});
  }
  revalidatePath(BACK);
  done(BACK, `${i.number} ${closeIt ? "closed" : "reopened"}.`);
}
