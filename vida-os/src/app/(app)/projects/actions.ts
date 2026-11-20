"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, canSeeProject } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { createApproval } from "@/lib/approvals";
import { saveImages, imageFiles, str, numVal, fail, done } from "@/lib/cost";

const PROGRESS_ROLES = ["PROJECT_MANAGER", "GM_PROJECTS", "MD"];
const REPORT_ROLES = ["SITE_ENGINEER", "PROJECT_MANAGER", "GM_PROJECTS", "MD"];

export async function updateProgress(fd: FormData) {
  const user = await requireUser(PROGRESS_ROLES);
  const id = str(fd, "milestoneId");
  const back = str(fd, "back") || "/projects/schedule";
  const value = numVal(fd, "progress");
  const m = await db.milestone.findUnique({ where: { id } });
  if (!m || !canSeeProject(user, m.projectId)) fail(back, "Milestone not found.");
  if (!Number.isFinite(value) || value < 0 || value > 99) fail(back, "Progress must be between 0 and 99%. Use Request completion for 100%.");
  if (m.status === "DONE" || m.status === "AWAITING_APPROVAL") fail(back, "This milestone is already complete or waiting for approval.");
  const data = { progressPct: Math.round(value), status: "IN_PROGRESS", actualStart: m.actualStart ?? new Date() };
  await db.milestone.update({ where: { id }, data });
  await audit(user, "UPDATE", "Milestone", id, `${m.name} progress set to ${data.progressPct}%`, { before: { progressPct: m.progressPct }, after: { progressPct: data.progressPct } });
  revalidatePath("/projects/schedule");
  done(back, `${m.name} updated to ${data.progressPct}%.`);
}

export async function requestCompletion(fd: FormData) {
  // GM Projects is the approver for milestones, so the project manager raises the request.
  const user = await requireUser(["PROJECT_MANAGER"]);
  const id = str(fd, "milestoneId");
  const back = str(fd, "back") || "/projects/schedule";
  const m = await db.milestone.findUnique({ where: { id } });
  if (!m || !canSeeProject(user, m.projectId)) fail(back, "Milestone not found.");
  if (m.status === "DONE" || m.status === "AWAITING_APPROVAL") fail(back, "This milestone is already complete or waiting for approval.");
  await db.$transaction(async (tx) => {
    await tx.milestone.update({ where: { id }, data: { status: "AWAITING_APPROVAL", progressPct: 100, actualStart: m.actualStart ?? new Date() } });
    await audit(user, "UPDATE", "Milestone", id, `Requested completion of ${m.name}`, undefined, tx);
    await createApproval(tx, { action: "MILESTONE", entityType: "Milestone", entityId: id, title: `${m.name} complete`, amount: 0, projectId: m.projectId }, user);
  });
  revalidatePath("/projects/schedule");
  done(back, `Completion of ${m.name} sent to GM Projects for approval.`);
}

export async function createReport(fd: FormData): Promise<{ error?: string; redirectTo?: string }> {
  const user = await requireUser(REPORT_ROLES);
  const projectId = str(fd, "projectId");
  const milestoneId = str(fd, "milestoneId") || null;
  const workDone = str(fd, "workDone");
  const labour = numVal(fd, "labourCount");
  const progress = str(fd, "progressPct") ? numVal(fd, "progressPct") : null;
  const photos = imageFiles(fd, "photos");

  if (!canSeeProject(user, projectId)) return { error: "Choose one of your projects." };
  if (!workDone) return { error: "Describe the work done today." };
  if (!Number.isFinite(labour) || labour < 0) return { error: "Enter the labour count as a number." };
  if (progress != null && (!Number.isFinite(progress) || progress < 0 || progress > 99)) return { error: "Progress must be between 0 and 99%." };
  if (photos.length < 2) return { error: "Add at least 2 site photos." };

  let milestone = null;
  if (milestoneId) {
    milestone = await db.milestone.findUnique({ where: { id: milestoneId } });
    if (!milestone || milestone.projectId !== projectId) return { error: "That milestone belongs to a different project." };
  }

  let saved;
  try {
    saved = await saveImages(photos, "dpr");
  } catch (e) {
    return { error: (e as Error).message };
  }

  const report = await db.$transaction(async (tx) => {
    const r = await tx.dailyReport.create({
      data: {
        projectId, milestoneId, date: new Date(), engineerId: user.id, workDone, labourCount: Math.round(labour),
        materialsUsed: str(fd, "materialsUsed") || null, issues: str(fd, "issues") || null,
        progressPct: progress == null ? null : Math.round(progress), photos: JSON.stringify(saved),
      },
    });
    if (milestone && milestone.status !== "DONE" && milestone.status !== "AWAITING_APPROVAL") {
      await tx.milestone.update({
        where: { id: milestone.id },
        data: { status: "IN_PROGRESS", actualStart: milestone.actualStart ?? new Date(), ...(progress != null ? { progressPct: Math.round(progress) } : {}) },
      });
    }
    await audit(user, "CREATE", "DailyReport", r.id, `Daily report${milestone ? ` for ${milestone.name}` : ""}: ${saved.length} photos, ${Math.round(labour)} labour`, undefined, tx);
    return r;
  });
  revalidatePath("/projects/reports");
  revalidatePath("/projects/schedule");
  return { redirectTo: `/projects/reports/${report.id}?ok=${encodeURIComponent("Daily report saved.")}` };
}
