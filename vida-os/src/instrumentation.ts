/**
 * Runs once when a server instance starts: connects the Telegram bot if it is not
 * connected yet. Self-contained (no Node-only imports) because Next also builds this
 * file for the edge runtime. Never throws.
 */
const COMMANDS = [
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
    const info = await call("getWebhookInfo");
    if (info?.url !== url) {
      await call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
      console.log("Telegram bot connected.");
    }
    await call("setMyCommands", { commands: COMMANDS }); // keeps the menu in step with the code
  } catch (e) {
    console.error("Telegram auto-connect failed:", (e as Error).message);
  }
}
