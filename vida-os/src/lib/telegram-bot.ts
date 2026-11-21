import { db } from "./db";
import { audit } from "./audit";
import { decide, canDecide } from "./approvals";
import { saveImages } from "./cost";
import { ALL_PROJECT_ROLES, APPROVAL_ACTIONS, ROLE_LABEL } from "./constants";
import { docNo, inr, num, date } from "./format";
import { send, tg, esc, downloadFile, notifyRoles, type Button } from "./telegram";

/**
 * The site-team bot. Telegram sends every message here (via /api/telegram).
 * Each linked staff member keeps one conversation in progress (User.telegramState).
 * Rules match the web screens: same roles, same project access, same approval engine, same audit trail.
 */

const REPORT_ROLES = ["SITE_ENGINEER", "PROJECT_MANAGER", "GM_PROJECTS", "MD"];
const MR_ROLES = ["SITE_ENGINEER", "PROJECT_MANAGER", "STOREKEEPER"];
const MR_APPROVERS = ["PROJECT_MANAGER", "GM_PROJECTS"];
const MIN_PHOTOS = 2;

type Report = { flow: "report"; step: "project" | "milestone" | "work" | "labour" | "progress" | "photos"; projectId?: string; milestoneId?: string | null; workDone?: string; labour?: number; progress?: number | null };
type Material = { flow: "material"; step: "project" | "item" | "qty" | "date" | "costcode"; projectId?: string; item?: string; qty?: number; unit?: string; neededBy?: string };
type State = Report | Material | null;

type BotUser = { id: string; name: string; role: string; telegramState: string | null; projectIds: string[] | "ALL" };

type TgMessage = { chat: { id: number; type: string }; from?: { first_name?: string }; text?: string; photo?: { file_id: string; width: number }[]; document?: { file_id: string; mime_type?: string } };
type TgCallback = { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
export type TgUpdate = { message?: TgMessage; callback_query?: TgCallback };

const HELP = [
  "<b>Vida OS site bot</b>",
  "",
  "/report: today's site report with photos",
  "/material: ask for material",
  "/approvals: what is waiting for you",
  "/cancel: stop what you are doing",
  "/help: this list",
].join("\n");

// ───────────── entry point ─────────────

export async function handleUpdate(u: TgUpdate) {
  if (u.callback_query) return onButton(u.callback_query);
  const m = u.message;
  if (!m || m.chat.type !== "private") return; // the bot works in one-to-one chats only
  const chatId = String(m.chat.id);
  const text = (m.text ?? "").trim();

  if (text.startsWith("/start")) return onStart(chatId, text.split(/\s+/)[1]);

  const user = await userForChat(chatId);
  if (!user) {
    return send(chatId, "This Telegram account is not linked to Vida OS yet.\n\nOpen Vida OS, go to <b>My Telegram</b>, and tap <b>Link Telegram</b>.");
  }

  if (text === "/cancel") {
    await setState(user.id, null);
    await db.telegramUpload.deleteMany({ where: { userId: user.id } });
    return send(chatId, "Stopped. Send /help to see what I can do.");
  }
  if (text === "/help") return send(chatId, HELP);
  if (text === "/report") return startReport(chatId, user);
  if (text === "/material") return startMaterial(chatId, user);
  if (text === "/approvals") return listApprovals(chatId, user);
  if (text === "/done") return finishReport(chatId, user);

  const state = parse(user.telegramState);
  const photo = m.photo?.length ? m.photo[m.photo.length - 1].file_id : m.document?.mime_type?.startsWith("image/") ? m.document.file_id : null;
  if (photo) return onPhoto(chatId, user, state, photo);
  if (!state) return send(chatId, HELP);
  if (state.flow === "report") return reportText(chatId, user, state, text);
  return materialText(chatId, user, state, text);
}

// ───────────── linking ─────────────

async function onStart(chatId: string, code?: string) {
  const existing = await userForChat(chatId);
  if (!code) {
    if (existing) return send(chatId, `Welcome back, ${esc(existing.name)}.\n\n${HELP}`);
    return send(chatId, "Welcome to the Vida OS site bot.\n\nTo link your account, open Vida OS, go to <b>My Telegram</b> and tap <b>Link Telegram</b>.");
  }
  const row = await db.telegramLinkCode.findUnique({ where: { code } });
  if (!row || row.expiresAt < new Date()) return send(chatId, "That link has expired. Open <b>My Telegram</b> in Vida OS and tap <b>Link Telegram</b> again.");
  const user = await db.user.findUnique({ where: { id: row.userId } });
  if (!user || !user.active) return send(chatId, "That Vida OS login is not active.");
  await db.$transaction(async (tx) => {
    await tx.user.updateMany({ where: { telegramChatId: chatId }, data: { telegramChatId: null, telegramState: null } });
    await tx.user.update({ where: { id: user.id }, data: { telegramChatId: chatId, telegramState: null } });
    await tx.telegramLinkCode.delete({ where: { code } });
    await audit({ id: user.id, name: user.name }, "UPDATE", "User", user.id, "Linked Telegram to Vida OS", undefined, tx);
  });
  return send(chatId, `Linked. Hello ${esc(user.name)} (${ROLE_LABEL[user.role] ?? user.role}).\n\n${HELP}`);
}

async function userForChat(chatId: string): Promise<BotUser | null> {
  const u = await db.user.findUnique({ where: { telegramChatId: chatId }, include: { access: true } });
  if (!u || !u.active) return null;
  return { id: u.id, name: u.name, role: u.role, telegramState: u.telegramState, projectIds: ALL_PROJECT_ROLES.includes(u.role) ? "ALL" : u.access.map((a) => a.projectId) };
}

const parse = (s: string | null): State => {
  try {
    return s ? (JSON.parse(s) as State) : null;
  } catch {
    return null;
  }
};
const setState = (userId: string, s: State) => db.user.update({ where: { id: userId }, data: { telegramState: s ? JSON.stringify(s) : null } });

async function myProjects(user: BotUser) {
  return db.project.findMany({ where: user.projectIds === "ALL" ? {} : { id: { in: user.projectIds } }, orderBy: { name: "asc" } });
}

const grid = (items: Button[], perRow = 2): Button[][] => {
  const rows: Button[][] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
};

// ───────────── daily report ─────────────

async function startReport(chatId: string, user: BotUser) {
  if (!REPORT_ROLES.includes(user.role)) return send(chatId, "Daily reports are sent by site engineers and project managers.");
  await db.telegramUpload.deleteMany({ where: { userId: user.id } });
  const projects = await myProjects(user);
  if (projects.length === 0) return send(chatId, "You have no projects in Vida OS yet. Ask the MD to give you access.");
  if (projects.length === 1) return reportProject(chatId, user, projects[0].id);
  await setState(user.id, { flow: "report", step: "project" });
  return send(chatId, "<b>Daily report</b>\nWhich project?", grid(projects.map((p) => ({ text: p.name, data: `rp:${p.id}` }))));
}

async function reportProject(chatId: string, user: BotUser, projectId: string) {
  const milestones = await db.milestone.findMany({ where: { projectId, status: { in: ["IN_PROGRESS", "NOT_STARTED"] } }, orderBy: { seq: "asc" }, take: 6 });
  await setState(user.id, { flow: "report", step: "milestone", projectId });
  const buttons = grid([...milestones.map((m) => ({ text: `${m.name} (${m.progressPct}%)`, data: `rm:${m.id}` })), { text: "General work, no milestone", data: "rm:none" }], 1);
  return send(chatId, "Which milestone did you work on today?", buttons);
}

async function reportText(chatId: string, user: BotUser, s: Report, text: string) {
  if (s.step === "project" || s.step === "milestone") return send(chatId, "Please tap one of the buttons above, or send /cancel.");
  if (s.step === "work") {
    if (text.length < 5) return send(chatId, "Please describe the work done today in a sentence or two.");
    await setState(user.id, { ...s, step: "labour", workDone: text });
    return send(chatId, "How many labourers were on site today? Send a number.");
  }
  if (s.step === "labour") {
    const n = Number(text.replace(/[^\d]/g, ""));
    if (!text.match(/\d/) || !Number.isFinite(n)) return send(chatId, "Send the labour count as a number, for example 42.");
    if (s.milestoneId) {
      await setState(user.id, { ...s, step: "progress", labour: n });
      return send(chatId, "What is the milestone's progress now, in percent? Send a number from 0 to 99, or /skip.");
    }
    await setState(user.id, { ...s, step: "photos", labour: n, progress: null });
    return askPhotos(chatId);
  }
  if (s.step === "progress") {
    let p: number | null = null;
    if (text !== "/skip") {
      p = Number(text.replace(/[^\d]/g, ""));
      if (!text.match(/\d/) || p < 0 || p > 99) return send(chatId, "Send a number from 0 to 99, or /skip.");
    }
    await setState(user.id, { ...s, step: "photos", progress: p });
    return askPhotos(chatId);
  }
  return send(chatId, `Send site photos (at least ${MIN_PHOTOS}), then /done.`);
}

const askPhotos = (chatId: string) => send(chatId, `Now send at least ${MIN_PHOTOS} site photos. You can send several at once.\nWhen you have sent them all, send /done.`);

async function onPhoto(chatId: string, user: BotUser, s: State, fileId: string) {
  if (!s || s.flow !== "report" || s.step !== "photos") return send(chatId, "To send site photos, start a daily report first with /report.");
  const file = await downloadFile(fileId, `telegram-${Date.now()}.jpg`);
  const [saved] = await saveImages([file], "dpr");
  // One row per photo, so photos sent together (each its own update) never overwrite each other.
  await db.telegramUpload.create({ data: { userId: user.id, path: saved.path } });
  const count = await db.telegramUpload.count({ where: { userId: user.id } });
  if (count === MIN_PHOTOS) return send(chatId, `${count} photos received. Send more, or /done to save the report.`);
  if (count === 1) return send(chatId, "1 photo received.");
}

async function finishReport(chatId: string, user: BotUser) {
  const s = parse(user.telegramState);
  if (!s || s.flow !== "report" || s.step !== "photos") return send(chatId, "There is no report to finish. Start one with /report.");
  const uploads = await db.telegramUpload.findMany({ where: { userId: user.id }, orderBy: { takenAt: "asc" } });
  if (uploads.length < MIN_PHOTOS) return send(chatId, `Please send at least ${MIN_PHOTOS} photos first. You have sent ${uploads.length}.`);
  const milestone = s.milestoneId ? await db.milestone.findUnique({ where: { id: s.milestoneId } }) : null;
  const report = await db.$transaction(async (tx) => {
    const r = await tx.dailyReport.create({
      data: {
        projectId: s.projectId!, milestoneId: milestone?.id ?? null, date: new Date(), engineerId: user.id,
        workDone: s.workDone!, labourCount: Math.round(s.labour ?? 0), progressPct: s.progress ?? null,
        photos: JSON.stringify(uploads.map((u) => ({ path: u.path, takenAt: u.takenAt.toISOString() }))),
      },
    });
    if (milestone && milestone.status !== "DONE" && milestone.status !== "AWAITING_APPROVAL") {
      await tx.milestone.update({
        where: { id: milestone.id },
        data: { status: "IN_PROGRESS", actualStart: milestone.actualStart ?? new Date(), ...(s.progress != null ? { progressPct: s.progress } : {}) },
      });
    }
    await tx.telegramUpload.deleteMany({ where: { userId: user.id } });
    await tx.user.update({ where: { id: user.id }, data: { telegramState: null } });
    await audit(user, "CREATE", "DailyReport", r.id, `Daily report via Telegram${milestone ? ` for ${milestone.name}` : ""}: ${uploads.length} photos, ${s.labour} labour`, undefined, tx);
    return r;
  });
  const project = await db.project.findUnique({ where: { id: report.projectId } });
  await notifyRoles(["PROJECT_MANAGER", "GM_PROJECTS"], `New daily report from ${esc(user.name)} · ${esc(project?.name ?? "")}${milestone ? ` · ${esc(milestone.name)}` : ""}\n${esc(s.workDone!)}\nLabour ${s.labour}, ${uploads.length} photos.`, { projectId: report.projectId, exceptUserId: user.id });
  return send(chatId, `Saved. Daily report for ${esc(project?.name ?? "")}${milestone ? `, ${esc(milestone.name)}` : ""} with ${uploads.length} photos.\nYour project manager can see it in Vida OS.`);
}

// ───────────── material request ─────────────

async function startMaterial(chatId: string, user: BotUser) {
  if (!MR_ROLES.includes(user.role)) return send(chatId, "Material requests are raised by site engineers, project managers and storekeepers.");
  const projects = await myProjects(user);
  if (projects.length === 0) return send(chatId, "You have no projects in Vida OS yet.");
  if (projects.length === 1) {
    await setState(user.id, { flow: "material", step: "item", projectId: projects[0].id });
    return send(chatId, `<b>Material request</b> · ${esc(projects[0].name)}\nWhat material do you need? For example: OPC 53 cement`);
  }
  await setState(user.id, { flow: "material", step: "project" });
  return send(chatId, "<b>Material request</b>\nWhich project?", grid(projects.map((p) => ({ text: p.name, data: `mp:${p.id}` }))));
}

async function materialText(chatId: string, user: BotUser, s: Material, text: string) {
  if (s.step === "project" || s.step === "costcode") return send(chatId, "Please tap one of the buttons above, or send /cancel.");
  if (s.step === "item") {
    if (text.length < 2) return send(chatId, "What material do you need?");
    await setState(user.id, { ...s, step: "qty", item: text });
    return send(chatId, "How much, and in what unit? For example: 200 bags");
  }
  if (s.step === "qty") {
    const m = text.match(/^\s*([\d.,]+)\s*(.*)$/);
    const qty = m ? Number(m[1].replace(/,/g, "")) : NaN;
    if (!m || !Number.isFinite(qty) || qty <= 0 || !m[2].trim()) return send(chatId, "Send the quantity and unit, for example: 200 bags");
    await setState(user.id, { ...s, step: "date", qty, unit: m[2].trim() });
    return send(chatId, "When is it needed on site? Send a date like 05-12-2026, or a number of days from today, like 7.");
  }
  if (s.step === "date") {
    const when = parseDate(text);
    if (!when) return send(chatId, "Send a date like 05-12-2026, or a number of days, like 7.");
    if (when.getTime() < Date.now() - 864e5) return send(chatId, "That date has passed. Send a date from today onwards.");
    await setState(user.id, { ...s, step: "costcode", neededBy: when.toISOString() });
    const codes = await db.costCode.findMany({ orderBy: { code: "asc" } });
    return send(chatId, "Which budget head is it for?", grid(codes.map((c) => ({ text: c.name, data: `mc:${c.id}` }))));
  }
}

function parseDate(t: string): Date | null {
  const s = t.trim();
  if (/^\d{1,3}$/.test(s)) return new Date(Date.now() + Number(s) * 864e5);
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/);
  if (!m) return null;
  const now = new Date();
  let y = m[3] ? Number(m[3]) : now.getFullYear();
  if (y < 100) y += 2000;
  const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1]), 6, 30)); // noon IST
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[1]) ? null : d;
}

async function finishMaterial(chatId: string, user: BotUser, s: Material, costCodeId: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id: s.projectId! } });
  const n = (await db.materialRequest.count({ where: { projectId: project.id } })) + 1;
  const mr = await db.materialRequest.create({
    data: { number: docNo("MR", project.code, n), projectId: project.id, costCodeId, item: s.item!, qty: s.qty!, unit: s.unit!, neededBy: new Date(s.neededBy!), note: "Raised on Telegram", requestedById: user.id },
  });
  await audit(user, "CREATE", "MaterialRequest", mr.id, `Raised ${mr.number} on Telegram: ${mr.qty} ${mr.unit} ${mr.item}`, { after: mr });
  await setState(user.id, null);
  await notifyRoles(MR_APPROVERS, `<b>Material request ${mr.number}</b> · ${esc(project.name)}\n${num(mr.qty)} ${esc(mr.unit)} ${esc(mr.item)}, needed by ${date(mr.neededBy)}\nRaised by ${esc(user.name)}`, {
    projectId: project.id, exceptUserId: user.id,
    buttons: [[{ text: "Approve", data: `mr:${mr.id}:A` }, { text: "Reject", data: `mr:${mr.id}:R` }]],
  });
  return send(chatId, `Raised <b>${mr.number}</b>: ${num(mr.qty)} ${esc(mr.unit)} ${esc(mr.item)}, needed by ${date(mr.neededBy)}.\nYour project manager has been asked to approve it.`);
}

// ───────────── approvals ─────────────

async function listApprovals(chatId: string, user: BotUser) {
  const sees = (projectId: string | null) => user.projectIds === "ALL" || !projectId || user.projectIds.includes(projectId);
  const pending = await db.approvalRequest.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 50 });
  const mine = [];
  for (const r of pending) if (sees(r.projectId) && (await canDecide(user, r)).ok) mine.push(r);
  const mrs = MR_APPROVERS.includes(user.role)
    ? (await db.materialRequest.findMany({ where: { status: "SUBMITTED", requestedById: { not: user.id } }, include: { project: true }, orderBy: { createdAt: "asc" }, take: 20 })).filter((m) => sees(m.projectId))
    : [];
  if (!mine.length && !mrs.length) return send(chatId, "Nothing is waiting for you.");
  for (const r of mine.slice(0, 10)) {
    await send(chatId, `<b>${esc(APPROVAL_ACTIONS[r.action] ?? r.action)}</b>\n${esc(r.title)}\n${r.amount ? inr(r.amount) : ""} · level ${r.currentLevel} of ${r.requiredLevel}`, [[{ text: "Approve", data: `ap:${r.id}:A` }, { text: "Reject", data: `ap:${r.id}:R` }]]);
  }
  for (const m of mrs.slice(0, 10)) {
    await send(chatId, `<b>Material request ${m.number}</b> · ${esc(m.project.name)}\n${num(m.qty)} ${esc(m.unit)} ${esc(m.item)}, needed by ${date(m.neededBy)}`, [[{ text: "Approve", data: `mr:${m.id}:A` }, { text: "Reject", data: `mr:${m.id}:R` }]]);
  }
  const more = mine.length + mrs.length - Math.min(mine.length, 10) - Math.min(mrs.length, 10);
  if (more > 0) return send(chatId, `${more} more are waiting. Open Approvals in Vida OS to see them all.`);
}

async function decideMaterial(user: BotUser, id: string, approve: boolean): Promise<string> {
  if (!MR_APPROVERS.includes(user.role)) return "Only project managers and GM Projects approve material requests.";
  const mr = await db.materialRequest.findUnique({ where: { id } });
  if (!mr || !(user.projectIds === "ALL" || user.projectIds.includes(mr.projectId))) return "Request not found.";
  if (mr.status !== "SUBMITTED") return `${mr.number} was already ${mr.status.toLowerCase()}.`;
  if (mr.requestedById === user.id) return "You raised this request, so someone else must approve it.";
  const decision = approve ? "APPROVED" : "REJECTED";
  await db.materialRequest.update({ where: { id }, data: { status: decision } });
  await audit(user, approve ? "APPROVE" : "REJECT", "MaterialRequest", id, `${approve ? "Approved" : "Rejected"} ${mr.number} on Telegram`);
  const requester = await db.user.findUnique({ where: { id: mr.requestedById } });
  if (requester?.telegramChatId) await send(requester.telegramChatId, `${mr.number} (${esc(mr.item)}) was ${approve ? "approved" : "rejected"} by ${esc(user.name)}.`).catch(() => {});
  return `${mr.number} ${approve ? "approved. Purchase can now collect quotes." : "rejected."}`;
}

// ───────────── buttons ─────────────

async function onButton(q: TgCallback) {
  const chatId = q.message ? String(q.message.chat.id) : null;
  const answer = (text?: string) => tg("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
  if (!chatId || !q.data) return answer();
  const user = await userForChat(chatId);
  if (!user) {
    await answer("This Telegram account is not linked to Vida OS.");
    return;
  }
  const [kind, id, flag] = q.data.split(":");
  const s = parse(user.telegramState);
  const close = async (text: string) => {
    await answer();
    if (q.message) await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return send(chatId, text);
  };

  if (kind === "rp") {
    if (s?.flow !== "report" || s.step !== "project") return close("That question has expired. Send /report to start again.");
    if (!(user.projectIds === "ALL" || user.projectIds.includes(id))) return close("You do not have access to that project.");
    await answer();
    return reportProject(chatId, user, id);
  }
  if (kind === "rm") {
    if (s?.flow !== "report" || s.step !== "milestone") return close("That question has expired. Send /report to start again.");
    const milestoneId = id === "none" ? null : id;
    if (milestoneId) {
      const m = await db.milestone.findUnique({ where: { id: milestoneId } });
      if (!m || m.projectId !== s.projectId) return close("That milestone belongs to a different project.");
    }
    await setState(user.id, { ...s, step: "work", milestoneId });
    return close("What work was done today? Write it in a sentence or two.");
  }
  if (kind === "mp") {
    if (s?.flow !== "material" || s.step !== "project") return close("That question has expired. Send /material to start again.");
    if (!(user.projectIds === "ALL" || user.projectIds.includes(id))) return close("You do not have access to that project.");
    await setState(user.id, { ...s, step: "item", projectId: id });
    return close("What material do you need? For example: OPC 53 cement");
  }
  if (kind === "mc") {
    if (s?.flow !== "material" || s.step !== "costcode") return close("That question has expired. Send /material to start again.");
    await answer();
    if (q.message) await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return finishMaterial(chatId, user, s, id);
  }
  if (kind === "mr") return close(await decideMaterial(user, id, flag === "A"));
  if (kind === "ap") {
    try {
      const result = await decide(id, user, flag === "A" ? "APPROVED" : "REJECTED", "Decided on Telegram");
      const req = await db.approvalRequest.findUnique({ where: { id } });
      const msg = result === "REJECTED" ? "Rejected." : result === "NEXT_LEVEL" ? "Approved. It now goes to the next approver." : "Approved. This was the final approval.";
      return close(`${msg}\n${esc(req?.title ?? "")}`);
    } catch (e) {
      return close(`Could not record that: ${esc((e as Error).message)}`);
    }
  }
  return answer();
}
