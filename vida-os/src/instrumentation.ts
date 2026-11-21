/**
 * Runs once when a server instance starts: connects the Telegram bot if it is not
 * connected yet. Self-contained (no Node-only imports) because Next also builds this
 * file for the edge runtime. Never throws.
 */
const COMMANDS = [
  { command: "report", description: "Today's site report with photos" },
  { command: "material", description: "Ask for material" },
  { command: "approvals", description: "What is waiting for you" },
  { command: "cancel", description: "Stop what you are doing" },
  { command: "help", description: "What the bot can do" },
];

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const token = process.env.TELEGRAM_BOT_TOKEN, secret = process.env.TELEGRAM_WEBHOOK_SECRET, base = process.env.PUBLIC_OS_URL;
  if (!token || !secret || !base?.startsWith("https://")) return;
  const call = async (method: string, body: Record<string, unknown> = {}) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json()) as { ok: boolean; result?: { url?: string }; description?: string };
    if (!j.ok) throw new Error(`${method}: ${j.description ?? r.status}`);
    return j.result;
  };
  try {
    const url = `${base}/api/telegram`;
    const me = (await call("getMe")) as { username?: string } | undefined;
    console.log(`Telegram bot username: @${me?.username}`);
    const info = await call("getWebhookInfo");
    if (info?.url === url) return;
    await call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    await call("setMyCommands", { commands: COMMANDS });
    console.log("Telegram bot connected.");
  } catch (e) {
    console.error("Telegram auto-connect failed:", (e as Error).message);
  }
}
