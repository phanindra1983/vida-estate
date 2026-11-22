import { randomInt } from "node:crypto";
import { db } from "./db";

/**
 * Telegram Bot API client for the site-team bot.
 * Settings: TELEGRAM_BOT_TOKEN (from @BotFather, added by the owner in Vercel)
 * and TELEGRAM_WEBHOOK_SECRET (checked on every incoming update).
 */
export const botConfigured = () => !!process.env.TELEGRAM_BOT_TOKEN;

export type Button = { text: string; data: string };

export async function tg<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("The Telegram bot is not set up yet (TELEGRAM_BOT_TOKEN is missing).");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
  return json.result as T;
}

/** Send a message; `buttons` is a grid of inline buttons (one inner array per row). */
export async function send(chatId: string | number, text: string, buttons?: Button[][]) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
  });
}

/** Ask for the phone's current location with a one-tap button under the keyboard. */
export async function askLocation(chatId: string | number, text: string) {
  return tg("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML",
    reply_markup: { keyboard: [[{ text: "📍 Share my location", request_location: true }], [{ text: "/cancel" }]], resize_keyboard: true, one_time_keyboard: true },
  });
}

/** Send a message and take away the location button. */
export async function sendClear(chatId: string | number, text: string) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { remove_keyboard: true } });
}

/** Safe text for HTML parse mode. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Download a Telegram file as a File: a photo (ready for saveImages()) or, with `type`, anything else. */
export async function downloadFile(fileId: string, name: string, forceType?: string): Promise<File> {
  const f = await tg<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
  if (!res.ok) throw new Error("Could not download the file from Telegram.");
  const ext = f.file_path.split(".").pop()?.toLowerCase();
  const type = forceType ?? (ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg");
  return new File([await res.arrayBuffer()], name, { type });
}

let cachedName: string | null = null;
export async function botUsername() {
  if (cachedName) return cachedName;
  const me = await tg<{ username: string }>("getMe");
  cachedName = me.username;
  return cachedName;
}

/** A fresh 8-digit code, valid 30 minutes, that links this login to a Telegram chat. */
export async function newLinkCode(userId: string) {
  await db.telegramLinkCode.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] } });
  const code = String(randomInt(10_000_000, 100_000_000));
  await db.telegramLinkCode.create({ data: { code, userId, expiresAt: new Date(Date.now() + 30 * 60_000) } });
  return code;
}

/** Message every linked user in the given roles (and, if given, with access to the project). Never throws. */
export async function notifyRoles(roles: string[], text: string, opts: { projectId?: string | null; buttons?: Button[][]; exceptUserId?: string } = {}) {
  if (!botConfigured()) return;
  const users = await db.user.findMany({
    where: { active: true, role: { in: roles }, telegramChatId: { not: null }, ...(opts.exceptUserId ? { id: { not: opts.exceptUserId } } : {}) },
    include: { access: true },
  });
  const { ALL_PROJECT_ROLES } = await import("./constants");
  for (const u of users) {
    if (opts.projectId && !ALL_PROJECT_ROLES.includes(u.role) && !u.access.some((a) => a.projectId === opts.projectId)) continue;
    try {
      await send(u.telegramChatId!, text, opts.buttons);
    } catch {
      // A blocked or deleted chat must not stop the others.
    }
  }
}

export const COMMANDS = [
  { command: "report", description: "Today's site report with photos" },
  { command: "in", description: "Check in at site" },
  { command: "out", description: "Check out from site" },
  { command: "snag", description: "Report a quality defect" },
  { command: "safety", description: "Report a safety issue" },
  { command: "issues", description: "Open snags and safety issues" },
  { command: "material", description: "Ask for material" },
  { command: "lead", description: "Add a buyer and let the AI call them" },
  { command: "approvals", description: "What is waiting for you" },
  { command: "summary", description: "Today's picture across your projects" },
  { command: "site", description: "Set the project's site location" },
  { command: "cancel", description: "Stop what you are doing" },
  { command: "help", description: "What the bot can do" },
];

const webhookUrl = () => `${process.env.PUBLIC_OS_URL}/api/telegram`;

/** Point Telegram at this app's webhook and set the command menu. */
export async function connectBot() {
  await tg("setWebhook", { url: webhookUrl(), secret_token: process.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  await tg("setMyCommands", { commands: COMMANDS });
}

