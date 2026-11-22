import { randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { send, esc, notifyRoles } from "./telegram";
import { publicUrl } from "./notify";
import { LEAD_SOURCES } from "./constants";

/**
 * AI caller (Bolna, bolna.ai): calls new leads within a minute, asks a few qualifying
 * questions, and books a site-visit time. The salesperson still makes the real call.
 *
 * - BOLNA_API_KEY (Vercel) is the only secret. Everything else lives in the Setting table.
 * - Bolna does not sign its webhooks, so the webhook URL carries our own random key, and
 *   the call is then re-read from Bolna's API before anything is saved.
 * - Calling hours 9 am to 9 pm (TRAI) are enforced by Bolna on the agent (calling_guardrails).
 */
const API = "https://api.bolna.ai";
const CFG = "bolna.config";

/** Lead sources that enquired themselves and may be called automatically. */
export const AUTO_CALL_SOURCES = ["WEBSITE", "META", "GOOGLE", "99ACRES", "MAGICBRICKS", "HOUSING", "NOBROKER", "SQUAREYARDS", "OTHER_PORTAL"];
/** Bolna statuses after which nothing more changes. */
export const FINAL = ["completed", "no-answer", "busy", "failed", "canceled", "stopped", "error", "balance-low"];

export const STATUS_LABEL: Record<string, string> = {
  QUEUED: "Queued", queued: "Queued", initiated: "Dialling", ringing: "Ringing", "in-progress": "On the call",
  "call-disconnected": "Finishing", completed: "Completed", "no-answer": "No answer", busy: "Busy", failed: "Failed",
  canceled: "Cancelled", stopped: "Stopped", error: "Error", "balance-low": "Bolna balance low", FAILED_TO_START: "Didn't start",
};

export type BolnaConfig = { agentId?: string; autoCall: boolean; webhookKey: string; agentCreatedAt?: string };

export const bolnaConfigured = () => !!process.env.BOLNA_API_KEY;

export async function getConfig(): Promise<BolnaConfig> {
  const s = await db.setting.findUnique({ where: { key: CFG } });
  let c: Partial<BolnaConfig> = {};
  try { c = s ? JSON.parse(s.value) : {}; } catch {}
  if (!c.webhookKey) {
    c = { autoCall: false, ...c, webhookKey: randomBytes(24).toString("base64url") };
    await saveConfig(c as BolnaConfig);
  }
  return { autoCall: false, ...c } as BolnaConfig;
}

export async function saveConfig(c: BolnaConfig) {
  const value = JSON.stringify(c);
  await db.setting.upsert({ where: { key: CFG }, create: { key: CFG, value }, update: { value } });
}

export async function webhookKeyMatches(given: string | null) {
  if (!given) return false;
  const { webhookKey } = await getConfig();
  const a = Buffer.from(webhookKey), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function bolna<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const key = process.env.BOLNA_API_KEY;
  if (!key) throw new Error("Bolna is not connected yet (no API key).");
  const r = await fetch(API + path, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const d = data as { message?: string; detail?: unknown; error?: string } | string | null;
    const msg = typeof d === "string" ? d : d?.message ?? d?.error ?? (d?.detail ? JSON.stringify(d.detail) : "");
    throw new Error(`Bolna ${r.status}: ${String(msg).slice(0, 300) || r.statusText}`);
  }
  return data as T;
}

/** Account check for the call-centre page: name and wallet balance. Never throws. */
export async function account(): Promise<{ ok: true; name?: string; wallet?: number } | { ok: false; error: string }> {
  try {
    const me = await bolna<{ name?: string; wallet?: number }>("/user/me");
    return { ok: true, name: me.name, wallet: me.wallet };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const SYSTEM_PROMPT = `You are Priya, calling on behalf of Vida Estates, a real-estate developer in Hyderabad. The person you are calling, {{customer_name}}, just enquired about {{project_name}} ({{project_location}}) through {{source}}.

Your goal in under 3 minutes:
1. Confirm you are speaking with {{customer_name}} and that this is a good time. If not, ask when to call back, thank them and end the call.
2. Ask, one question at a time: is the home for living in or for investment; which size they want (2, 3 or 4 BHK); their budget range; when they plan to buy.
3. Offer a site visit and agree a day and time. Our sales team will confirm it.
4. Tell them a Vida Estates sales manager will call them shortly, thank them, and end the call.

Rules:
- You are an AI assistant. If asked, say so honestly.
- Be warm, polite and brief. Speak simply. Short sentences.
- If they prefer Hindi or Telugu, say a sales manager who speaks it will call them, and continue simply in English.
- Never quote prices, discounts, offers, possession dates, RERA details or legal terms. Say the sales manager will share exact details.
- Never ask for payment, OTPs, bank details or ID numbers.
- If they say they are not interested or ask not to be called, apologise, confirm we will not call again, and end the call.`;

/** Create the calling agent on Bolna and remember its id. */
export async function createAgent() {
  const cfg = await getConfig();
  const body = {
    agent_config: {
      agent_name: "Vida Estates - New lead caller",
      agent_welcome_message: "Hello, am I speaking with {{customer_name}}? This is Priya, calling from Vida Estates about your enquiry for {{project_name}}.",
      webhook_url: publicUrl(`/api/bolna/webhook?key=${encodeURIComponent(cfg.webhookKey)}`),
      calling_guardrails: { call_start_hour: 9, call_end_hour: 21 },
      call_summary_enabled: true,
      tasks: [{
        task_type: "conversation",
        toolchain: { execution: "sequential", pipelines: [["transcriber", "llm", "synthesizer"]] },
        tools_config: {
          llm_agent: { agent_type: "simple_llm_agent", agent_flow_type: "streaming", llm_config: { provider: "openai", model: "gpt-5.4-mini", max_tokens: 150, temperature: 1 } },
          synthesizer: { provider: "elevenlabs", provider_config: { voice: "Angelica", voice_id: "IkSv4tkouLJ6kYsQA7XD", model: "eleven_turbo_v2_5" }, stream: true, buffer_size: 250, audio_format: "wav" },
          transcriber: { provider: "deepgram", model: "nova-3", language: "en", stream: true, encoding: "linear16", sampling_rate: 16000, endpointing: 250 },
          input: { provider: "plivo", format: "wav" },
          output: { provider: "plivo", format: "wav" },
        },
        task_config: { call_terminate: 240, hangup_after_silence: 10 },
      }],
    },
    agent_prompts: { task_1: { system_prompt: SYSTEM_PROMPT } },
  };
  const res = await bolna<{ agent_id: string }>("/v2/agent", { method: "POST", body });
  await saveConfig({ ...cfg, agentId: res.agent_id, agentCreatedAt: new Date().toISOString() });
  return res.agent_id;
}

const e164 = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  throw new Error("Enter a valid Indian mobile number.");
};

/** Place one AI call. For a lead, or a test call to any number (trigger TEST). */
export async function startCall(opts: { leadId?: string; toNumber?: string; trigger: "AUTO" | "MANUAL" | "TEST"; userId?: string | null }) {
  const cfg = await getConfig();
  if (!cfg.agentId) throw new Error("Set up the AI caller first (Sales → AI call centre).");
  const lead = opts.leadId ? await db.lead.findUnique({ where: { id: opts.leadId }, include: { project: true } }) : null;
  if (opts.leadId && !lead) throw new Error("Lead not found.");
  const to = e164(opts.toNumber ?? lead!.phone);
  const user_data = {
    customer_name: lead?.name.split(" ")[0] ?? "there",
    project_name: lead?.project?.name ?? "our new homes",
    project_location: lead?.project?.location ?? "Hyderabad",
    source: lead ? LEAD_SOURCES[lead.source] ?? lead.source : "our website",
  };
  const row = await db.aiCall.create({ data: { leadId: lead?.id, toNumber: to, trigger: opts.trigger, startedById: opts.userId ?? null } });
  try {
    const res = await bolna<{ execution_id: string; status?: string }>("/call", { method: "POST", body: { agent_id: cfg.agentId, recipient_phone_number: to, user_data } });
    await db.aiCall.update({ where: { id: row.id }, data: { executionId: res.execution_id, status: res.status ?? "queued" } });
    if (lead) {
      await db.activity.create({ data: { leadId: lead.id, userId: opts.userId ?? null, type: "SYSTEM", note: `AI caller is calling ${user_data.customer_name}. The result will appear here.` } });
    }
    return row.id;
  } catch (e) {
    await db.aiCall.update({ where: { id: row.id }, data: { status: "FAILED_TO_START", error: (e as Error).message.slice(0, 500) } });
    throw e;
  }
}

/** New lead arrived: call it if the MD has switched automatic calling on. Never throws. */
export async function autoCallNewLead(leadId: string) {
  try {
    if (!bolnaConfigured()) return;
    const cfg = await getConfig();
    if (!cfg.autoCall || !cfg.agentId) return;
    const lead = await db.lead.findUnique({ where: { id: leadId }, select: { source: true, consentAt: true } });
    if (!lead || !lead.consentAt || !AUTO_CALL_SOURCES.includes(lead.source)) return;
    await startCall({ leadId, trigger: "AUTO" });
  } catch {
    // The salesperson alert has already gone; a failed AI call must not affect the lead.
  }
}

type Execution = {
  id: string; status?: string; conversation_duration?: number | null; transcript?: string | null; summary?: string | null;
  total_cost?: number | null; termination_reason?: string | null; telephony_data?: { recording_url?: string | null; duration?: string | number | null } | null;
};

/** Read one call from Bolna and save it. Alerts the salesperson once, when a conversation finishes. */
export async function syncExecution(executionId: string) {
  const row = await db.aiCall.findUnique({ where: { executionId } });
  if (!row) return null;
  const x = await bolna<Execution>(`/executions/${encodeURIComponent(executionId)}`);
  const status = x.status ?? row.status;
  const final = FINAL.includes(status);
  const updated = await db.aiCall.update({
    where: { id: row.id },
    data: {
      status,
      durationSec: x.conversation_duration != null ? Math.round(Number(x.conversation_duration)) : row.durationSec,
      summary: x.summary?.slice(0, 4000) ?? row.summary,
      transcript: x.transcript?.slice(0, 40_000) ?? row.transcript,
      recordingUrl: x.telephony_data?.recording_url ?? row.recordingUrl,
      costCents: x.total_cost ?? row.costCents,
      error: final && status !== "completed" ? x.termination_reason?.slice(0, 300) ?? row.error : row.error,
    },
  });
  if (final && !row.alerted) await afterCall(updated.id);
  return updated;
}

/** Update calls still in progress (webhooks can be missed). Used when the call-centre page opens. */
export async function syncOpenCalls(limit = 10) {
  if (!bolnaConfigured()) return;
  const open = await db.aiCall.findMany({
    where: { executionId: { not: null }, status: { notIn: [...FINAL, "FAILED_TO_START"] }, createdAt: { gt: new Date(Date.now() - 2 * 864e5) } },
    orderBy: { createdAt: "asc" }, take: limit,
  });
  await Promise.allSettled(open.map((c) => syncExecution(c.executionId!)));
}

async function afterCall(callId: string) {
  const c = await db.aiCall.update({ where: { id: callId }, data: { alerted: true }, include: { lead: { include: { project: true } } } });
  if (!c.lead) return;
  const talked = c.status === "completed" && (c.durationSec ?? 0) > 0;
  const what = talked
    ? `AI call done (${Math.round((c.durationSec ?? 0) / 60 * 10) / 10} min).${c.summary ? `\n${c.summary}` : ""}`
    : `AI call: ${STATUS_LABEL[c.status] ?? c.status}.`;
  await db.activity.create({ data: { leadId: c.lead.id, type: "SYSTEM", note: what.slice(0, 2000) } });
  // Whoever asked for the call (e.g. from Telegram /lead) hears the result either way.
  const starter = c.startedById ? await db.user.findUnique({ where: { id: c.startedById } }) : null;
  if (starter?.telegramChatId && starter.id !== c.lead.ownerId) {
    await send(starter.telegramChatId, `🤖 <b>${esc(c.lead.name)}</b>: ${esc(what.slice(0, 700))}\n${publicUrl(`/sales/leads/${c.lead.id}`)}`).catch(() => {});
  }
  if (!talked) return;
  const text = `🤖 <b>AI call done</b> · ${esc(c.lead.name)} · ${c.lead.phone}${c.lead.project ? `\n${esc(c.lead.project.name)}` : ""}\n${esc((c.summary ?? "Open the lead to read the conversation.").slice(0, 600))}\nPlease call them now.\n${publicUrl(`/sales/leads/${c.lead.id}`)}`;
  try {
    const owner = c.lead.ownerId ? await db.user.findUnique({ where: { id: c.lead.ownerId } }) : null;
    if (owner?.telegramChatId) await send(owner.telegramChatId, text);
    else await notifyRoles(["SALES_HEAD", "SALES_MANAGER", "MD"], text, { projectId: c.lead.projectId });
  } catch {}
}
