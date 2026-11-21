import { db } from "./db";
import { audit } from "./audit";
import { decide, canDecide } from "./approvals";
import { saveImages } from "./cost";
import { ALL_PROJECT_ROLES, APPROVAL_ACTIONS, ROLE_LABEL } from "./constants";
import { docNo, inr, num, date, time, istDay } from "./format";
import { speechConfigured, speechToEnglish, languageName, wordsToDigits, MAX_VOICE_SECONDS } from "./speech";
import { send, tg, esc, downloadFile, notifyRoles, askLocation, sendClear, type Button } from "./telegram";

/**
 * The site-team bot. Telegram sends every message here (via /api/telegram).
 * Each linked staff member keeps one conversation in progress (User.telegramState).
 * Rules match the web screens: same roles, same project access, same approval engine, same audit trail.
 */

const REPORT_ROLES = ["SITE_ENGINEER", "PROJECT_MANAGER", "GM_PROJECTS", "MD"];
const MR_ROLES = ["SITE_ENGINEER", "PROJECT_MANAGER", "STOREKEEPER"];
const MR_APPROVERS = ["PROJECT_MANAGER", "GM_PROJECTS"];
const MIN_PHOTOS = 2;
const ATTEND_ROLES = ["SITE_ENGINEER", "PROJECT_MANAGER", "STOREKEEPER", "GM_PROJECTS"];
const SITE_PIN_ROLES = ["PROJECT_MANAGER", "GM_PROJECTS", "MD"];
const ISSUE_ROLES = ["SITE_ENGINEER", "PROJECT_MANAGER", "STOREKEEPER", "GM_PROJECTS", "MD"];
const ISSUE_CLOSERS = ["PROJECT_MANAGER", "GM_PROJECTS", "MD"];
/** A check-in further than this from the site pin is flagged as off site. */
export const ON_SITE_METRES = 500;

type Report = { flow: "report"; step: "project" | "milestone" | "work" | "labour" | "progress" | "photos"; projectId?: string; milestoneId?: string | null; workDone?: string; labour?: number; progress?: number | null };
type Material = { flow: "material"; step: "project" | "item" | "qty" | "date" | "costcode"; projectId?: string; item?: string; qty?: number; unit?: string; neededBy?: string };
type Attend = { flow: "attend"; dir: "in" | "out"; step: "project" | "location"; projectId?: string };
type SitePin = { flow: "site"; step: "project" | "location"; projectId?: string };
type Issue = { flow: "issue"; kind: "SNAG" | "SAFETY"; step: "project" | "text" | "severity" | "photo"; projectId?: string; description?: string; severity?: string };
type Fix = { flow: "fix"; issueId: string };
type State = Report | Material | Attend | SitePin | Issue | Fix | null;

type BotUser = { id: string; name: string; role: string; telegramState: string | null; projectIds: string[] | "ALL" };

type TgMessage = {
  chat: { id: number; type: string }; date: number; from?: { first_name?: string }; text?: string;
  photo?: { file_id: string; width: number }[]; document?: { file_id: string; mime_type?: string };
  location?: { latitude: number; longitude: number }; forward_origin?: unknown; forward_date?: number;
  voice?: { file_id: string; duration: number; mime_type?: string }; audio?: { file_id: string; duration: number; mime_type?: string };
};
type TgCallback = { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
export type TgUpdate = { message?: TgMessage; callback_query?: TgCallback };

const HELP = [
  "<b>Vida OS site bot</b>",
  "",
  "/in, /out: check in and out at site",
  "/report: today's site report with photos",
  "/snag: report a quality defect",
  "/safety: report a safety issue",
  "/issues: open snags and safety issues",
  "/material: ask for material",
  "/approvals: what is waiting for you",
  "",
  "🎙 Where I ask you to type, you can send a voice note instead, in Telugu, Hindi or English (up to 30 seconds).",
  "/summary: today's picture across your projects (managers)",
  "/site: set the project's site location (project managers)",
  "/cancel: stop what you are doing",
  "/help: this list",
].join("\n");

// ───────────── entry point ─────────────

export async function handleUpdate(u: TgUpdate) {
  if (u.callback_query) return onButton(u.callback_query);
  const m = u.message;
  if (!m || m.chat.type !== "private") return; // the bot works in one-to-one chats only
  const chatId = String(m.chat.id);
  let text = (m.text ?? "").trim();

  if (text.startsWith("/start")) return onStart(chatId, text.split(/\s+/)[1]);

  const user = await userForChat(chatId);
  if (!user) {
    return send(chatId, "This Telegram account is not linked to Vida OS yet.\n\nOpen Vida OS, go to <b>My Telegram</b>, and tap <b>Link Telegram</b>.");
  }

  if (text === "/cancel") {
    await setState(user.id, null);
    await db.telegramUpload.deleteMany({ where: { userId: user.id } });
    return sendClear(chatId, "Stopped. Send /help to see what I can do.");
  }
  if (text === "/help") return send(chatId, HELP);
  if (text === "/report") return startReport(chatId, user);
  if (text === "/material") return startMaterial(chatId, user);
  if (text === "/approvals") return listApprovals(chatId, user);
  if (text === "/done") return finishReport(chatId, user);
  if (text === "/in") return startAttend(chatId, user, "in");
  if (text === "/out") return startAttend(chatId, user, "out");
  if (text === "/site") return startSitePin(chatId, user);
  if (text === "/snag") return startIssue(chatId, user, "SNAG");
  if (text === "/safety") return startIssue(chatId, user, "SAFETY");
  if (text === "/issues") return listIssues(chatId, user);
  if (text === "/summary") return (await import("./digest")).summaryFor(user, chatId);

  const state = parse(user.telegramState);
  const voice = m.voice ?? m.audio;
  if (voice) {
    const heard = await hear(chatId, state, voice);
    if (heard == null) return;
    text = heard;
  }
  if (m.location) return onLocation(chatId, user, state, m);
  const photo = m.photo?.length ? m.photo[m.photo.length - 1].file_id : m.document?.mime_type?.startsWith("image/") ? m.document.file_id : null;
  if (photo && state?.flow === "issue") return issuePhoto(chatId, user, state, photo);
  if (photo && state?.flow === "fix") return fixPhoto(chatId, user, state, photo);
  if (photo) return onPhoto(chatId, user, state, photo);
  if (!state) return send(chatId, HELP);
  if (state.flow === "report") return reportText(chatId, user, state, text);
  if (state.flow === "material") return materialText(chatId, user, state, text);
  if (state.flow === "issue") return issueText(chatId, user, state, text);
  if (state.flow === "fix") return fixText(chatId, user, state, text);
  return send(chatId, "Please tap the <b>Share my location</b> button below, or send /cancel.");
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
  const s = t.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^\d{1,3}$/.test(s)) return new Date(Date.now() + Number(s) * 864e5);
  if (s === "today") return new Date();
  if (s === "tomorrow") return new Date(Date.now() + 864e5);
  const days = s.match(/^(?:in\s+|within\s+|after\s+)?(\d{1,3})\s+days?(?:\s+from\s+(?:now|today))?$/);
  if (days) return new Date(Date.now() + Number(days[1]) * 864e5);
  const weeks = s.match(/^(?:in\s+|within\s+|after\s+)?(\d{1,2})\s+weeks?$/);
  if (weeks) return new Date(Date.now() + Number(weeks[1]) * 7 * 864e5);
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
  if (kind === "at") {
    if (s?.flow !== "attend" || s.step !== "project") return close("That question has expired. Send /in to start again.");
    if (!sees(user, id)) return close("You do not have access to that project.");
    await setState(user.id, { ...s, step: "location", projectId: id });
    await close("Checking in.");
    return askLocation(chatId, "Tap <b>Share my location</b> below.");
  }
  if (kind === "st") {
    if (s?.flow !== "site" || s.step !== "project") return close("That question has expired. Send /site to start again.");
    if (!sees(user, id)) return close("You do not have access to that project.");
    await setState(user.id, { ...s, step: "location", projectId: id });
    await close("Setting the site location.");
    return askLocation(chatId, "Stand at the site and tap <b>Share my location</b> below.");
  }
  if (kind === "ip") {
    if (s?.flow !== "issue" || s.step !== "project") return close("That question has expired. Start again with /snag or /safety.");
    if (!sees(user, id)) return close("You do not have access to that project.");
    await setState(user.id, { ...s, step: "text", projectId: id });
    return close(issuePrompt(s.kind));
  }
  if (kind === "sv") {
    if (s?.flow !== "issue" || s.step !== "severity" || !SEVERITIES[id]) return close("That question has expired. Start again with /snag or /safety.");
    await setState(user.id, { ...s, step: "photo", severity: id });
    return close(`${SEVERITIES[id]}. Now send one photo of it, or /skip.`);
  }
  if (kind === "if") return close(await startFix(user, id));
  if (kind === "ic" || kind === "io") return close(await reviewIssue(user, id, kind === "ic"));
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

// ───────────── shared ─────────────

const sees = (user: BotUser, projectId: string) => user.projectIds === "ALL" || user.projectIds.includes(projectId);

/** Distance in metres between two points on the earth. */
export function metres(aLat: number, aLng: number, bLat: number, bLng: number) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

const distanceText = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);

async function onLocation(chatId: string, user: BotUser, s: State, m: TgMessage) {
  if (m.forward_origin || m.forward_date) return send(chatId, "Please share your own location with the button, not a forwarded one.");
  if (Date.now() / 1000 - m.date > 300) return send(chatId, "That location is old. Tap <b>Share my location</b> again.");
  const { latitude: lat, longitude: lng } = m.location!;
  if (s?.flow === "attend" && s.step === "location") return saveAttend(chatId, user, s, lat, lng);
  if (s?.flow === "site" && s.step === "location") return saveSitePin(chatId, user, s, lat, lng);
  return sendClear(chatId, "To check in at site, send /in.");
}

// ───────────── attendance ─────────────

async function startAttend(chatId: string, user: BotUser, dir: "in" | "out") {
  if (!ATTEND_ROLES.includes(user.role)) return send(chatId, "Site check-in is for site engineers, project managers, storekeepers and GM Projects.");
  const today = await db.attendance.findUnique({ where: { userId_day: { userId: user.id, day: istDay() } }, include: { project: true } });
  if (dir === "out") {
    if (!today) return send(chatId, "You have not checked in today. Send /in first.");
    if (today.outAt) return send(chatId, `You already checked out at ${time(today.outAt)}.`);
    await setState(user.id, { flow: "attend", dir, step: "location", projectId: today.projectId });
    return askLocation(chatId, `<b>Check out</b> · ${esc(today.project.name)}\nTap <b>Share my location</b> below.`);
  }
  if (today) return send(chatId, `You already checked in at ${time(today.inAt)} at ${esc(today.project.name)}. Send /out when you leave.`);
  const projects = await myProjects(user);
  if (projects.length === 0) return send(chatId, "You have no projects in Vida OS yet. Ask the MD to give you access.");
  if (projects.length === 1) {
    await setState(user.id, { flow: "attend", dir, step: "location", projectId: projects[0].id });
    return askLocation(chatId, `<b>Check in</b> · ${esc(projects[0].name)}\nTap <b>Share my location</b> below.`);
  }
  await setState(user.id, { flow: "attend", dir, step: "project" });
  return send(chatId, "<b>Check in</b>\nWhich site are you at?", grid(projects.map((p) => ({ text: p.name, data: `at:${p.id}` }))));
}

async function saveAttend(chatId: string, user: BotUser, s: Attend, lat: number, lng: number) {
  const project = await db.project.findUnique({ where: { id: s.projectId! } });
  if (!project) return sendClear(chatId, "Project not found. Send /in to start again.");
  const away = project.siteLat != null && project.siteLng != null ? metres(lat, lng, project.siteLat, project.siteLng) : null;
  const where = away == null
    ? "\nThis project has no site location yet; a project manager can set it with /site."
    : away <= ON_SITE_METRES ? "\nYou are on site." : `\n⚠️ You are ${distanceText(away)} from the site.`;
  await setState(user.id, null);

  if (s.dir === "in") {
    try {
      const a = await db.attendance.create({ data: { userId: user.id, projectId: project.id, day: istDay(), inLat: lat, inLng: lng, inMeters: away } });
      await audit(user, "CREATE", "Attendance", a.id, `Checked in at ${project.name} on Telegram${away != null ? `, ${distanceText(away)} from site` : ""}`);
    } catch {
      return sendClear(chatId, "You have already checked in today.");
    }
    if (away != null && away > ON_SITE_METRES) {
      await notifyRoles(["PROJECT_MANAGER", "GM_PROJECTS"], `⚠️ ${esc(user.name)} checked in for ${esc(project.name)} but is ${distanceText(away)} from the site.`, { projectId: project.id, exceptUserId: user.id });
    }
    return sendClear(chatId, `Checked in at <b>${esc(project.name)}</b>, ${time(new Date())}.${where}\nSend /report for today's report, and /out when you leave.`);
  }

  const today = await db.attendance.findUnique({ where: { userId_day: { userId: user.id, day: istDay() } } });
  if (!today || today.outAt) return sendClear(chatId, "There is no open check-in for today.");
  const now = new Date();
  await db.attendance.update({ where: { id: today.id }, data: { outAt: now, outLat: lat, outLng: lng, outMeters: away } });
  await audit(user, "UPDATE", "Attendance", today.id, `Checked out of ${project.name} on Telegram`);
  const mins = Math.round((now.getTime() - today.inAt.getTime()) / 60000);
  return sendClear(chatId, `Checked out at ${time(now)}. On site for ${Math.floor(mins / 60)} h ${mins % 60} min.${where}`);
}

// ───────────── site location ─────────────

async function startSitePin(chatId: string, user: BotUser) {
  if (!SITE_PIN_ROLES.includes(user.role)) return send(chatId, "The site location is set by project managers, GM Projects or the MD.");
  const projects = await myProjects(user);
  if (projects.length === 0) return send(chatId, "You have no projects in Vida OS yet.");
  if (projects.length === 1) {
    await setState(user.id, { flow: "site", step: "location", projectId: projects[0].id });
    return askLocation(chatId, `<b>Site location</b> · ${esc(projects[0].name)}\nStand at the site and tap <b>Share my location</b> below.`);
  }
  await setState(user.id, { flow: "site", step: "project" });
  return send(chatId, "<b>Site location</b>\nWhich project?", grid(projects.map((p) => ({ text: p.name, data: `st:${p.id}` }))));
}

async function saveSitePin(chatId: string, user: BotUser, s: SitePin, lat: number, lng: number) {
  const project = await db.project.update({ where: { id: s.projectId! }, data: { siteLat: lat, siteLng: lng } });
  await audit(user, "UPDATE", "Project", project.id, `Set the site location of ${project.name} on Telegram`);
  await setState(user.id, null);
  return sendClear(chatId, `Site location for <b>${esc(project.name)}</b> saved.\nCheck-ins within ${ON_SITE_METRES} m of here count as on site.`);
}

// ───────────── snags and safety ─────────────

const SEVERITIES: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };
const KIND_LABEL = { SNAG: "Snag", SAFETY: "Safety issue" } as const;
const issuePrompt = (kind: "SNAG" | "SAFETY") =>
  kind === "SNAG"
    ? "Describe the defect and where it is.\nFor example: Tower A, flat 1203, cracks in the living room plaster."
    : "Describe the safety issue and where it is.\nFor example: Block B, 5th floor, no edge railing on the slab.";

async function startIssue(chatId: string, user: BotUser, kind: "SNAG" | "SAFETY") {
  if (!ISSUE_ROLES.includes(user.role)) return send(chatId, "Snags and safety issues are raised by the site team.");
  const projects = await myProjects(user);
  if (projects.length === 0) return send(chatId, "You have no projects in Vida OS yet.");
  if (projects.length === 1) {
    await setState(user.id, { flow: "issue", kind, step: "text", projectId: projects[0].id });
    return send(chatId, `<b>${KIND_LABEL[kind]}</b> · ${esc(projects[0].name)}\n${issuePrompt(kind)}`);
  }
  await setState(user.id, { flow: "issue", kind, step: "project" });
  return send(chatId, `<b>${KIND_LABEL[kind]}</b>\nWhich project?`, grid(projects.map((p) => ({ text: p.name, data: `ip:${p.id}` }))));
}

async function issueText(chatId: string, user: BotUser, s: Issue, text: string) {
  if (s.step === "project" || s.step === "severity") return send(chatId, "Please tap one of the buttons above, or send /cancel.");
  if (s.step === "text") {
    if (text.length < 5) return send(chatId, issuePrompt(s.kind));
    await setState(user.id, { ...s, step: "severity", description: text });
    return send(chatId, "How serious is it?", [[{ text: "Low", data: "sv:LOW" }, { text: "Medium", data: "sv:MEDIUM" }, { text: "High", data: "sv:HIGH" }]]);
  }
  if (text === "/skip") return saveIssue(chatId, user, s, []);
  return send(chatId, "Send one photo of it, or /skip.");
}

async function issuePhoto(chatId: string, user: BotUser, s: Issue, fileId: string) {
  if (s.step !== "photo") return send(chatId, "Please answer the question above first, or send /cancel.");
  const file = await downloadFile(fileId, `issue-${Date.now()}.jpg`);
  return saveIssue(chatId, user, s, await saveImages([file], "issues"));
}

async function saveIssue(chatId: string, user: BotUser, s: Issue, photos: { path: string; takenAt: string }[]) {
  const project = await db.project.findUniqueOrThrow({ where: { id: s.projectId! } });
  const n = (await db.siteIssue.count({ where: { projectId: project.id, kind: s.kind } })) + 1;
  const issue = await db.siteIssue.create({
    data: { number: docNo(s.kind === "SNAG" ? "SNG" : "SAF", project.code, n), projectId: project.id, kind: s.kind, description: s.description!, severity: s.severity ?? "MEDIUM", photos: JSON.stringify(photos), raisedById: user.id },
  });
  await audit(user, "CREATE", "SiteIssue", issue.id, `Raised ${issue.number} on Telegram: ${issue.description}`);
  await setState(user.id, null);
  const urgent = s.kind === "SAFETY" && issue.severity === "HIGH";
  await notifyRoles(urgent ? ["PROJECT_MANAGER", "GM_PROJECTS", "MD"] : ["PROJECT_MANAGER", "GM_PROJECTS"],
    `${urgent ? "🚨 " : ""}<b>${KIND_LABEL[s.kind]} ${issue.number}</b> · ${SEVERITIES[issue.severity]} · ${esc(project.name)}\n${esc(issue.description)}\nRaised by ${esc(user.name)}${photos.length ? ", with a photo" : ""}. Send /issues to see open items.`,
    { projectId: project.id, exceptUserId: user.id });
  return send(chatId, `Saved <b>${issue.number}</b> (${SEVERITIES[issue.severity]}).\nYour project manager has been told. When it is fixed, send /issues and tap <b>Fixed</b>.`);
}

async function listIssues(chatId: string, user: BotUser) {
  if (!ISSUE_ROLES.includes(user.role)) return send(chatId, "Snags and safety issues are for the site team.");
  const where = { status: { in: ["OPEN", "FIXED"] }, ...(user.projectIds === "ALL" ? {} : { projectId: { in: user.projectIds } }) };
  const all = await db.siteIssue.findMany({ where, include: { project: true }, orderBy: { createdAt: "asc" } });
  if (!all.length) return send(chatId, "No open snags or safety issues. 👍");
  const rank = (i: (typeof all)[number]) => (i.kind === "SAFETY" ? 0 : 3) + (i.severity === "HIGH" ? 0 : i.severity === "MEDIUM" ? 1 : 2);
  all.sort((a, b) => rank(a) - rank(b));
  const open = all.filter((i) => i.status === "OPEN").length;
  await send(chatId, `<b>${open} open</b>, ${all.length - open} fixed and waiting to be checked.`);
  for (const i of all.slice(0, 10)) {
    const buttons: Button[][] =
      i.status === "OPEN" ? [[{ text: "Fixed ✔", data: `if:${i.id}` }]]
      : ISSUE_CLOSERS.includes(user.role) ? [[{ text: "Close ✔", data: `ic:${i.id}` }, { text: "Reopen", data: `io:${i.id}` }]]
      : [];
    await send(chatId, `<b>${i.number}</b> · ${KIND_LABEL[i.kind as "SNAG" | "SAFETY"]} · ${SEVERITIES[i.severity] ?? i.severity} · ${esc(i.project.name)}\n${esc(i.description)}\n${i.status === "FIXED" ? `Fixed ${date(i.fixedAt)}, waiting for a check.` : `Raised ${date(i.createdAt)}.`}`, buttons);
  }
  if (all.length > 10) return send(chatId, `${all.length - 10} more. Open Snags & safety in Vida OS to see them all.`);
}

async function startFix(user: BotUser, id: string): Promise<string> {
  const i = await db.siteIssue.findUnique({ where: { id } });
  if (!i || !sees(user, i.projectId) || !ISSUE_ROLES.includes(user.role)) return "Issue not found.";
  if (i.status !== "OPEN") return `${i.number} is already ${i.status.toLowerCase()}.`;
  await setState(user.id, { flow: "fix", issueId: i.id });
  return `Marking <b>${i.number}</b> as fixed. Send a photo of the fix, or /skip.`;
}

async function fixText(chatId: string, user: BotUser, s: Fix, text: string) {
  if (text === "/skip") return markFixed(chatId, user, s, []);
  return send(chatId, "Send a photo of the fix, or /skip.");
}

async function fixPhoto(chatId: string, user: BotUser, s: Fix, fileId: string) {
  const file = await downloadFile(fileId, `fix-${Date.now()}.jpg`);
  return markFixed(chatId, user, s, await saveImages([file], "issues"));
}

async function markFixed(chatId: string, user: BotUser, s: Fix, photos: { path: string; takenAt: string }[]) {
  await setState(user.id, null);
  const i = await db.siteIssue.findUnique({ where: { id: s.issueId }, include: { project: true } });
  if (!i || i.status !== "OPEN") return send(chatId, "That issue is no longer open.");
  await db.siteIssue.update({ where: { id: i.id }, data: { status: "FIXED", fixedById: user.id, fixedAt: new Date(), fixPhotos: JSON.stringify(photos) } });
  await audit(user, "UPDATE", "SiteIssue", i.id, `Marked ${i.number} fixed on Telegram`);
  await notifyRoles(ISSUE_CLOSERS, `<b>${i.number}</b> · ${esc(i.project.name)} was marked fixed by ${esc(user.name)}${photos.length ? ", with a photo" : ""}.\n${esc(i.description)}`, {
    projectId: i.projectId, exceptUserId: user.id,
    buttons: [[{ text: "Close ✔", data: `ic:${i.id}` }, { text: "Reopen", data: `io:${i.id}` }]],
  });
  return send(chatId, `<b>${i.number}</b> marked fixed. Your project manager will check and close it.`);
}

async function reviewIssue(user: BotUser, id: string, closeIt: boolean): Promise<string> {
  if (!ISSUE_CLOSERS.includes(user.role)) return "Only project managers, GM Projects or the MD close issues.";
  const i = await db.siteIssue.findUnique({ where: { id } });
  if (!i || !sees(user, i.projectId)) return "Issue not found.";
  if (i.status !== "FIXED") return `${i.number} is ${i.status.toLowerCase()}, not waiting for a check.`;
  await db.siteIssue.update({
    where: { id },
    data: closeIt ? { status: "CLOSED", closedById: user.id, closedAt: new Date() } : { status: "OPEN", fixedById: null, fixedAt: null, fixPhotos: null },
  });
  await audit(user, closeIt ? "APPROVE" : "REJECT", "SiteIssue", id, `${closeIt ? "Closed" : "Reopened"} ${i.number} on Telegram`);
  const tell = [...new Set([i.raisedById, i.fixedById].filter((x): x is string => !!x && x !== user.id))];
  for (const uid of tell) {
    const u = await db.user.findUnique({ where: { id: uid } });
    if (u?.telegramChatId) await send(u.telegramChatId, `${i.number} was ${closeIt ? "closed" : "reopened"} by ${esc(user.name)}.`).catch(() => {});
  }
  return `${i.number} ${closeIt ? "closed." : "reopened. It is back on the open list."}`;
}

// ───────────── voice notes ─────────────

/** Turn a voice note into English text for the step in progress. Returns null when it has already replied. */
async function hear(chatId: string, s: State, v: { file_id: string; duration: number; mime_type?: string }): Promise<string | null> {
  const wantsText = !!s && ((s.flow === "report" && ["work", "labour", "progress"].includes(s.step)) || (s.flow === "material" && ["item", "qty", "date"].includes(s.step)) || (s.flow === "issue" && s.step === "text"));
  if (!wantsText) {
    await send(chatId, "Voice notes work when I ask you to describe something. Start with /report, /snag, /safety or /material, then speak your answer.");
    return null;
  }
  if (!speechConfigured()) {
    await send(chatId, "Voice notes are not switched on yet. Please type your answer for now.");
    return null;
  }
  if (v.duration > MAX_VOICE_SECONDS) {
    await send(chatId, `That voice note is ${v.duration} seconds. Please keep it under ${MAX_VOICE_SECONDS} seconds.`);
    return null;
  }
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const audio = await downloadFile(v.file_id, "voice.ogg", v.mime_type ?? "audio/ogg");
    const { text, language } = await speechToEnglish(audio);
    if (!text) {
      await send(chatId, "I could not hear anything in that voice note. Please try again, or type it.");
      return null;
    }
    const lang = languageName(language);
    await send(chatId, `🎙 I heard${lang && lang !== "English" ? ` (${lang})` : ""}: <i>${esc(text)}</i>`);
    const wantsNumber = s.flow === "report" ? s.step !== "work" : s.flow === "material" ? s.step !== "item" : false;
    return wantsNumber ? wordsToDigits(text) : text;
  } catch (e) {
    await send(chatId, `Sorry, I could not understand that voice note (${esc((e as Error).message)}). Please try again, or type it.`);
    return null;
  }
}
