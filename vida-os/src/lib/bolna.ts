import { randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { send, esc, notifyRoles } from "./telegram";
import { publicUrl } from "./notify";
import { LEAD_SOURCES } from "./constants";
import { refreshScore } from "./lead-score";
import { qualifyLead, purposeFrom, timelineFrom } from "./qualify";

/**
 * AI caller (Bolna, bolna.ai): calls buyers, asks a few qualifying questions, and offers a
 * site visit. The salesperson still makes the real call.
 *
 * - BOLNA_API_KEY (Vercel) is the only secret. Agent id, caller settings, on/off and the
 *   webhook key live in the Setting table (`bolna.config`).
 * - Bolna does not sign its webhooks, so the webhook URL carries our own random key, and
 *   the call is then re-read from Bolna's API before anything is saved.
 * - Calling hours 9 am to 9 pm (TRAI) are enforced by Bolna on the agent (calling_guardrails).
 * - Outcomes (interest, site visit, budget, size...) come from Bolna "extractions" (dispositions)
 *   created on the agent; they arrive in extracted_data as Category > Extraction > {objective, subjective}.
 */
const API = "https://api.bolna.ai";
const CFG = "bolna.config";

/** Lead sources that enquired themselves and may be called automatically. */
export const AUTO_CALL_SOURCES = ["WEBSITE", "META", "GOOGLE", "99ACRES", "MAGICBRICKS", "HOUSING", "NOBROKER", "SQUAREYARDS", "OTHER_PORTAL"];
/** Bolna statuses after which nothing more changes. */
export const FINAL = ["completed", "no-answer", "busy", "failed", "canceled", "stopped", "error", "balance-low", "FAILED_TO_START"];
/** Calls that reached a person and talked. */
export const talkedWhere = { status: "completed", durationSec: { gt: 0 } };

export const STATUS_LABEL: Record<string, string> = {
  QUEUED: "Queued", queued: "Queued", scheduled: "Scheduled", rescheduled: "Rescheduled (outside 9–9)", initiated: "Dialling", ringing: "Ringing",
  "in-progress": "On the call", "call-disconnected": "Finishing", completed: "Completed", "no-answer": "No answer", busy: "Busy",
  failed: "Failed", canceled: "Cancelled", stopped: "Stopped", error: "Error", "balance-low": "Bolna balance low", FAILED_TO_START: "Didn't start",
};

export const INTEREST: Record<string, { label: string; tone: "good" | "warn" | "bad" | "neutral" | "brass" }> = {
  INTERESTED: { label: "Interested", tone: "good" },
  MAYBE: { label: "Maybe", tone: "brass" },
  CALL_BACK: { label: "Call back later", tone: "warn" },
  NOT_INTERESTED: { label: "Not interested", tone: "neutral" },
  WRONG_NUMBER: { label: "Wrong number", tone: "bad" },
  DO_NOT_CALL: { label: "Asked not to call", tone: "bad" },
};

export const LANGUAGES: Record<string, string> = { en: "English", hi: "Hindi", te: "Telugu" };
/** Sarvam Bulbul v3 voices: the same 16 work in every language. */
export const VOICES: { id: string; name: string; gender: "Female" | "Male"; style: string }[] = [
  { id: "priya", name: "Priya", gender: "Female", style: "Conversational" },
  { id: "kavya", name: "Kavya", gender: "Female", style: "Conversational" },
  { id: "ritu", name: "Ritu", gender: "Female", style: "Conversational" },
  { id: "simran", name: "Simran", gender: "Female", style: "Conversational" },
  { id: "ishita", name: "Ishita", gender: "Female", style: "Business" },
  { id: "pooja", name: "Pooja", gender: "Female", style: "Assistant" },
  { id: "shreya", name: "Shreya", gender: "Female", style: "News" },
  { id: "shruti", name: "Shruti", gender: "Female", style: "Entertainment" },
  { id: "suhani", name: "Suhani", gender: "Female", style: "Audiobooks" },
  { id: "rahul", name: "Rahul", gender: "Male", style: "Sales" },
  { id: "amit", name: "Amit", gender: "Male", style: "Business" },
  { id: "sumit", name: "Sumit", gender: "Male", style: "Conversational" },
  { id: "shubh", name: "Shubh", gender: "Male", style: "Support" },
  { id: "manan", name: "Manan", gender: "Male", style: "Automation" },
  { id: "ratan", name: "Ratan", gender: "Male", style: "News" },
  { id: "ashutosh", name: "Ashutosh", gender: "Male", style: "News" },
];

export type CallerSettings = { callerName: string; language: "en" | "hi" | "te"; voiceId: string; welcome: string; notes: string; maxMinutes: number };
export type BolnaConfig = { agentId?: string; autoCall: boolean; webhookKey: string; agentCreatedAt?: string; agentUpdatedAt?: string; outcomesReady?: boolean; settings?: CallerSettings };

export const defaultWelcome = (lang: string, caller: string) =>
  lang === "hi"
    ? `नमस्ते {{customer_name}} जी, मैं ${caller} बोल रही हूँ, Vida Estates से। आपने {{project_name}} के बारे में जानकारी माँगी थी, उसके लिए आपका बहुत-बहुत धन्यवाद। क्या अभी दो मिनट बात करना आपके लिए सुविधाजनक रहेगा?`
    : lang === "te"
      ? `నమస్కారం {{customer_name}} గారు, నేను Vida Estates నుండి ${caller} మాట్లాడుతున్నాను. మీరు {{project_name}} గురించి అడిగారు. ఇప్పుడు మాట్లాడటానికి సమయం ఉందా?`
      : `Hello, am I speaking with {{customer_name}}? This is ${caller}, calling from Vida Estates about your enquiry for {{project_name}}. Is this a good time to talk?`;

export const DEFAULT_SETTINGS: CallerSettings = { callerName: "Priya", language: "hi", voiceId: "priya", welcome: "", notes: "", maxMinutes: 4 };

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

export const settingsOf = (c: BolnaConfig): CallerSettings => ({ ...DEFAULT_SETTINGS, ...(c.settings ?? {}) });

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
    signal: AbortSignal.timeout(20_000),
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

/** Account check: name and wallet balance (US cents). Never throws. */
export async function account(): Promise<{ ok: true; name?: string; wallet?: number } | { ok: false; error: string }> {
  try {
    const me = await bolna<{ name?: string; wallet?: number }>("/user/me");
    return { ok: true, name: me.name, wallet: me.wallet };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** A call recording, fetched with our key (Bolna's recording links need it). */
export async function fetchRecording(url: string) {
  if (!url.startsWith(`${API}/`)) return fetch(url, { signal: AbortSignal.timeout(30_000) });
  return fetch(url, { headers: { Authorization: `Bearer ${process.env.BOLNA_API_KEY ?? ""}` }, signal: AbortSignal.timeout(30_000) });
}

// ───────────── the agent ─────────────

const STYLE: Record<string, string> = {
  hi: `
Hindi style: polite, cultured everyday Hindi (Hindustani), not heavy Sanskrit words. Always "aap", never "tum". Add "ji" to the name. Use "kripya", "dhanyavaad", "zaroor", "bilkul", "aapka bahut-bahut shukriya". Write every reply in Devanagari script (English terms like BHK may stay in English). Example tone: "जी, बिल्कुल। क्या मैं जान सकती हूँ कि आप घर अपने रहने के लिए देख रहे हैं या निवेश के लिए?"`,
  te: `
Telugu style: polite, respectful Telugu. Use "మీరు" and "గారు". Write every reply in Telugu script (English terms like BHK may stay in English).`,
};

const HANGUP: Record<string, string> = {
  en: "Thank you so much for your time. Have a lovely day.",
  hi: "आपने अपना कीमती समय दिया, उसके लिए दिल से धन्यवाद। आपका दिन शुभ हो।",
  te: "మీ విలువైన సమయానికి చాలా ధన్యవాదాలు. శుభదినం.",
};

function systemPrompt(s: CallerSettings) {
  const lang = LANGUAGES[s.language] ?? "English";
  return `You are ${s.callerName}, calling on behalf of Vida Estates, a real-estate developer in Hyderabad. The person you are calling, {{customer_name}}, enquired about {{project_name}} ({{project_location}}) through {{source}}.

Speak in ${lang}${s.language === "en" ? " (simple Indian English)" : `. English words that are common in ${lang} conversation (BHK, budget, site visit, project names) are fine`}.${STYLE[s.language] ?? ""}

Your manner: a refined, gentle and humble lady. Speak softly and unhurriedly, with warmth and respect. Thank the caller for their time. Never sound pushy or salesy; if they hesitate, reassure them kindly and give them space.

Your goal in under ${s.maxMinutes} minutes:
1. Confirm you are speaking with {{customer_name}} and that this is a good time. If not, ask when to call back, thank them and end the call.
2. Ask, one question at a time: is the home for living in or for investment; which size they want (2, 3 or 4 BHK); their budget range; when they plan to buy.
3. Offer a site visit and agree a day and time. Our sales team will confirm it.
4. Tell them a Vida Estates sales manager will call them shortly, thank them, and end the call.
${s.notes.trim() ? `\nUseful facts you may share if asked:\n${s.notes.trim()}\n` : ""}
About this enquiry (use it in the conversation): {{project_brief}}
If the enquiry is for Vida Mars, follow the brief above: explain the concept warmly and with a light touch, ask which plot size interests them instead of home size, and offer a virtual walkthrough with the team instead of a site visit.

Rules:
- You are an AI assistant. If asked, say so honestly.
- Be warm, polite and brief. Short sentences. Never talk over the caller.
- Never quote prices, discounts, offers, possession dates, RERA details or legal terms, even if they appear above. Say the sales manager will share exact details.
- Never ask for payment, OTPs, bank details or ID numbers.
- If they are not interested or ask not to be called, apologise, confirm we will not call again, and end the call.
- The caller may prefer English, Hindi or Telugu, or mix them. Follow the language they are most comfortable in, smoothly, without commenting on it.`;
}

/** Said once when the caller switches language, in the new language. */
const HANDOFF: Record<string, string> = {
  en: "Of course, I'll continue in English.",
  hi: "जी, बिल्कुल। मैं हिंदी में बात करती हूँ।",
  te: "తప్పకుండా, నేను తెలుగులో మాట్లాడతాను.",
};

/**
 * One agent, three languages. The same Sarvam voice speaks all of them, so the buyer hears the
 * same lady when the language changes. Calls start in the chosen language and follow the buyer.
 */
function multilingual(s: CallerSettings, voice: (typeof VOICES)[number]) {
  const languages = Object.fromEntries(
    Object.keys(LANGUAGES).map((code) => {
      const ls = { ...s, language: code as CallerSettings["language"] };
      return [code, {
        transcriber: { language: code },
        synthesizer: { provider: "sarvam", provider_config: { voice: voice.name, voice_id: voice.id, model: "bulbul:v3", language: code, speed: 0.92 }, buffer_size: 150 },
        system_prompt: systemPrompt(ls),
        handoff_message: HANDOFF[code],
        agent_name: s.callerName,
        welcome_message: code === s.language && s.welcome.trim() ? s.welcome.trim() : defaultWelcome(code, s.callerName),
      }];
    }),
  );
  return { enabled: true, active_language: s.language, language_switch_trigger: "requested_or_auto_detected", languages };
}

function agentBody(cfg: BolnaConfig) {
  const s = settingsOf(cfg);
  const voice = VOICES.find((v) => v.id === s.voiceId) ?? VOICES[0];
  return {
    agent_config: {
      agent_name: "Vida Estates - Buyer caller",
      agent_welcome_message: s.welcome.trim() || defaultWelcome(s.language, s.callerName),
      webhook_url: publicUrl(`/api/bolna/webhook?key=${encodeURIComponent(cfg.webhookKey)}`),
      calling_guardrails: { call_start_hour: 9, call_end_hour: 21 },
      call_summary_enabled: true,
      tasks: [{
        task_type: "conversation",
        toolchain: { execution: "sequential", pipelines: [["transcriber", "llm", "synthesizer"]] },
        tools_config: {
          llm_agent: { agent_type: "simple_llm_agent", agent_flow_type: "streaming", llm_config: { provider: "openai", model: "gpt-5.4-mini", max_tokens: 150, temperature: 1 } },
          synthesizer: { provider: "sarvam", provider_config: { voice: voice.name, voice_id: voice.id, model: "bulbul:v3", language: s.language, speed: 0.92 }, stream: true, buffer_size: 150, audio_format: "wav" },
          transcriber: { provider: "sarvam", model: "saaras:v4", language: s.language, stream: true, endpointing: 500 },
          multilingual_config: multilingual(s, voice),
          input: { provider: "plivo", format: "wav" },
          output: { provider: "plivo", format: "wav" },
        },
        task_config: {
          call_terminate: Math.max(60, Math.min(600, s.maxMinutes * 60)),
          hangup_after_silence: 10,
          // Clean line: no ambient sound played to the buyer, and their background noise filtered out.
          ambient_noise: false,
          ambient_noise_track: null,
          noise_cancellation_level: 85,
          call_hangup_message: HANGUP[s.language] ?? HANGUP.en,
        },
      }],
    },
    agent_prompts: { task_1: { system_prompt: systemPrompt(s) } },
  };
}

/** What Bolna works out from each conversation, shown on the lead and in reports. */
const OUTCOMES = [
  {
    name: "Interest", category: "Lead", is_objective: true,
    question: "Based on the whole conversation, which best describes the caller?",
    objective_options: [
      { value: "INTERESTED", condition: "Wants to buy or see the project, agreed to a site visit, or wants the sales manager to call" },
      { value: "MAYBE", condition: "Some interest but undecided, or only wants information for now" },
      { value: "CALL_BACK", condition: "Was busy and asked to be called at another time" },
      { value: "NOT_INTERESTED", condition: "Said they are not interested or already bought elsewhere" },
      { value: "WRONG_NUMBER", condition: "Not the right person, or never made an enquiry" },
      { value: "DO_NOT_CALL", condition: "Asked not to be called again" },
    ],
  },
  { name: "Site visit", category: "Lead", is_subjective: true, subjective_type: "text", question: "If the caller agreed to a site visit, what day and time? Answer exactly 'none' if no visit was agreed." },
  { name: "Home size", category: "Lead", is_subjective: true, subjective_type: "text", question: "Which home size did the caller want (for example 2 BHK, 3 BHK)? Answer 'none' if not said." },
  { name: "Budget", category: "Lead", is_subjective: true, subjective_type: "text", question: "What budget did the caller mention? Answer 'none' if not said." },
  { name: "Purpose", category: "Lead", is_subjective: true, subjective_type: "text", question: "Is the home to live in or for investment? Answer 'none' if not said." },
  { name: "Timeline", category: "Lead", is_subjective: true, subjective_type: "text", question: "When does the caller plan to buy? Answer 'none' if not said." },
];

async function ensureOutcomes(cfg: BolnaConfig) {
  if (cfg.outcomesReady || !cfg.agentId) return cfg;
  await bolna("/dispositions/bulk", { method: "POST", body: { agent_id: cfg.agentId, dispositions: OUTCOMES } });
  const next = { ...cfg, outcomesReady: true };
  await saveConfig(next);
  return next;
}

/** Create the calling agent on Bolna and remember its id. */
export async function createAgent() {
  const cfg = await getConfig();
  const res = await bolna<{ agent_id: string }>("/v2/agent", { method: "POST", body: agentBody(cfg) });
  const next = { ...cfg, agentId: res.agent_id, agentCreatedAt: new Date().toISOString(), outcomesReady: false };
  await saveConfig(next);
  await ensureOutcomes(next);
  return res.agent_id;
}

/** Save caller settings and push them to the agent on Bolna. */
export async function saveCallerSettings(s: CallerSettings) {
  const cfg = { ...(await getConfig()), settings: s };
  if (cfg.agentId) {
    await bolna(`/v2/agent/${cfg.agentId}`, { method: "PUT", body: agentBody(cfg) });
    cfg.agentUpdatedAt = new Date().toISOString();
  }
  await saveConfig(cfg);
  if (cfg.agentId) await ensureOutcomes(cfg);
}

/** Stop every call still waiting in Bolna's queue for our agent. */
export async function stopQueuedCalls() {
  const cfg = await getConfig();
  if (!cfg.agentId) return 0;
  const r = await bolna<{ stopped_executions?: string[] }>(`/v2/agent/${cfg.agentId}/stop`, { method: "POST" });
  const ids = r.stopped_executions ?? [];
  if (ids.length) await db.aiCall.updateMany({ where: { executionId: { in: ids } }, data: { status: "stopped" } });
  return ids.length;
}

// ───────────── calls ─────────────

const e164 = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  if (d.length === 10 && /^[6-9]/.test(d)) return `+91${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  throw new Error("Enter a valid Indian mobile number.");
};

/** What the caller says about Vida Mars, with the buyer's own answers from the website form. */
function marsBrief(notes: string | null) {
  const a = (k: string) => notes?.match(new RegExp(`${k}: ([^·\\n]+)`))?.[1]?.trim();
  const said = [
    a("Speed sickness") && `motion or speed sickness: ${a("Speed sickness")}`,
    a("Likes red") && `enjoys the colour red: ${a("Likes red")}`,
    a("Married") && `married: ${a("Married")}`,
    a("Income") && `annual income: ${a("Income")}`,
  ].filter(Boolean).join("; ");
  return [
    "Vida Mars Ultimate is a CONCEPT project by Vida Estates: a 100-acre gated plotted layout on the planet Mars, for people who want room to build their own home.",
    "Three plot types: Crater View, 300 square yards, corner plots on the crater rim with the widest views; Red Valley, 500 square yards, on the main avenue near the clubhouse dome and the landing pad; Olympus Estate, 1,000 square yards, large plots at the quiet end of the layout for a villa.",
    "Be clear and honest that it is a concept: nothing can be bought or booked yet, and there are no prices.",
    said ? `On the website the buyer told us (${said}). Mention these naturally, for example that loving red is perfect for Mars.` : "",
  ].filter(Boolean).join(" ");
}

/** Place one AI call. For a lead, or a test call to any number (trigger TEST). */
export async function startCall(opts: { leadId?: string; toNumber?: string; trigger: "AUTO" | "MANUAL" | "TEST" | "CAMPAIGN"; userId?: string | null; campaignId?: string; scheduledAt?: Date }) {
  const cfg = await getConfig();
  if (!cfg.agentId) throw new Error("Set up the AI caller first (Sales → AI call centre).");
  const lead = opts.leadId ? await db.lead.findUnique({ where: { id: opts.leadId }, include: { project: true } }) : null;
  if (opts.leadId && !lead) throw new Error("Lead not found.");
  if (lead?.doNotCallAt) throw new Error(`${lead.name} asked not to be called again.`);
  const to = e164(opts.toNumber ?? lead!.phone);
  const mars = !!lead?.campaign?.startsWith("Vida Mars");
  const user_data = {
    customer_name: lead?.name.split(" ")[0] ?? "there",
    project_name: mars ? "Vida Mars Ultimate" : lead?.project?.name ?? "our new homes",
    project_location: mars ? "Mars, a concept project" : lead?.project?.location ?? "Hyderabad",
    source: lead ? LEAD_SOURCES[lead.source] ?? lead.source : "our website",
    project_brief: mars ? marsBrief(lead?.notes ?? null) : lead?.project?.description?.slice(0, 600) || "A Vida Estates project in Hyderabad.",
  };
  const row = await db.aiCall.create({
    data: { leadId: lead?.id, toNumber: to, trigger: opts.trigger, startedById: opts.userId ?? null, campaignId: opts.campaignId, projectId: lead?.projectId ?? null, status: opts.scheduledAt ? "scheduled" : "QUEUED" },
  });
  try {
    const res = await bolna<{ execution_id: string; status?: string }>("/call", {
      method: "POST",
      body: { agent_id: cfg.agentId, recipient_phone_number: to, user_data, ...(opts.scheduledAt ? { scheduled_at: opts.scheduledAt.toISOString() } : {}) },
    });
    await db.aiCall.update({ where: { id: row.id }, data: { executionId: res.execution_id, status: res.status ?? (opts.scheduledAt ? "scheduled" : "queued") } });
    if (lead && opts.trigger !== "CAMPAIGN") {
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
    const lead = await db.lead.findUnique({ where: { id: leadId }, select: { source: true, consentAt: true, doNotCallAt: true } });
    if (!lead || !lead.consentAt || lead.doNotCallAt || !AUTO_CALL_SOURCES.includes(lead.source)) return;
    await startCall({ leadId, trigger: "AUTO" });
  } catch {
    // The salesperson alert has already gone; a failed AI call must not affect the lead.
  }
}

/** Leads a campaign may call: consented, not opted out, not lost or booked. */
export const callableLeadWhere = { consentAt: { not: null }, doNotCallAt: null, stage: { notIn: ["LOST", "BOOKED", "AGREEMENT_SIGNED"] } };

/** Place a campaign's calls, spaced out so Bolna's queue isn't flooded. Returns how many were placed. */
export async function launchCampaign(campaignId: string, leadIds: string[], userId: string, startAt?: Date) {
  const SPACING_S = 30;
  let placed = 0, i = 0;
  const start = Math.max(Date.now() + 15_000, startAt?.getTime() ?? 0);
  const queue = [...leadIds];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const at = new Date(start + i++ * SPACING_S * 1000);
      try {
        await startCall({ leadId: id, trigger: "CAMPAIGN", userId, campaignId, scheduledAt: at });
        placed++;
      } catch {
        // recorded on the AiCall row as FAILED_TO_START
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return placed;
}

type Execution = {
  id: string; status?: string; conversation_duration?: number | null; transcript?: string | null; summary?: string | null;
  total_cost?: number | null; termination_reason?: string | null; error_message?: string | null;
  telephony_data?: { recording_url?: string | null } | null;
  extracted_data?: Record<string, Record<string, { objective?: unknown; subjective?: unknown }>> | null;
};

/** extracted_data → { "Interest": "INTERESTED", "Site visit": "Saturday 11 am", ... }, ignoring "none". */
function readOutcomes(x: Execution["extracted_data"]) {
  const out: Record<string, string> = {};
  for (const cat of Object.values(x ?? {})) {
    if (!cat || typeof cat !== "object") continue;
    for (const [name, v] of Object.entries(cat)) {
      const val = v?.objective ?? v?.subjective;
      const s = typeof val === "string" ? val.trim() : val == null ? "" : String(val);
      if (s && !/^(none|null|n\/?a|not (said|mentioned))\.?$/i.test(s)) out[name] = s;
    }
  }
  return out;
}

/** Read one call from Bolna and save it. Alerts once, when the call finishes. */
export async function syncExecution(executionId: string) {
  const row = await db.aiCall.findUnique({ where: { executionId } });
  if (!row) return null;
  const x = await bolna<Execution>(`/executions/${encodeURIComponent(executionId)}`);
  const status = x.status ?? row.status;
  const final = FINAL.includes(status);
  const o = readOutcomes(x.extracted_data);
  const interest = o.Interest?.toUpperCase().replace(/[^A-Z_]/g, "");
  const updated = await db.aiCall.update({
    where: { id: row.id },
    data: {
      status,
      durationSec: x.conversation_duration != null ? Math.round(Number(x.conversation_duration)) : row.durationSec,
      summary: x.summary?.slice(0, 4000) ?? row.summary,
      transcript: x.transcript?.slice(0, 40_000) ?? row.transcript,
      recordingUrl: x.telephony_data?.recording_url ?? row.recordingUrl,
      costCents: x.total_cost ?? row.costCents,
      error: final && status !== "completed" ? (x.termination_reason ?? x.error_message)?.slice(0, 300) ?? row.error : row.error,
      ...(x.extracted_data && Object.keys(x.extracted_data).length ? { extracted: JSON.stringify(x.extracted_data).slice(0, 20_000) } : {}),
      ...(interest && INTEREST[interest] ? { interest } : {}),
      ...(o["Site visit"] ? { visitNote: o["Site visit"].slice(0, 200) } : {}),
    },
  });
  if (final && !row.alerted) await afterCall(updated.id, o);
  if (final && row.campaignId) {
    const left = await db.aiCall.count({ where: { campaignId: row.campaignId, status: { notIn: FINAL } } });
    if (!left) await db.aiCampaign.updateMany({ where: { id: row.campaignId, status: "RUNNING" }, data: { status: "DONE" } });
  }
  return updated;
}

/** Update calls still in progress (webhooks can be missed). Used when call-centre pages open. */
export async function syncOpenCalls(limit = 10) {
  if (!bolnaConfigured()) return;
  const open = await db.aiCall.findMany({
    where: { executionId: { not: null }, status: { notIn: FINAL }, createdAt: { gt: new Date(Date.now() - 3 * 864e5) } },
    orderBy: { updatedAt: "asc" }, take: limit,
  });
  await Promise.allSettled(open.map((c) => syncExecution(c.executionId!)));
}

async function afterCall(callId: string, o: Record<string, string>) {
  const c = await db.aiCall.update({ where: { id: callId }, data: { alerted: true }, include: { lead: { include: { project: true } } } });
  if (!c.lead) return;
  const talked = c.status === "completed" && (c.durationSec ?? 0) > 0;
  const facts = [
    c.interest && INTEREST[c.interest] ? `Result: ${INTEREST[c.interest].label}` : "",
    c.visitNote ? `Site visit: ${c.visitNote}` : "",
    o["Home size"] ? `Wants: ${o["Home size"]}` : "",
    o.Budget ? `Budget: ${o.Budget}` : "",
    o.Purpose ? `Purpose: ${o.Purpose}` : "",
    o.Timeline ? `Buying: ${o.Timeline}` : "",
  ].filter(Boolean).join("\n");
  const what = talked
    ? `AI call done (${Math.round(((c.durationSec ?? 0) / 60) * 10) / 10} min).${facts ? `\n${facts}` : ""}${c.summary ? `\n${c.summary}` : ""}`
    : `AI call: ${STATUS_LABEL[c.status] ?? c.status}.`;
  await db.activity.create({ data: { leadId: c.lead.id, type: "SYSTEM", note: what.slice(0, 2000) } });

  // What the buyer told the AI fills gaps on the lead (never overwrites what sales entered).
  const fill: { budget?: string; preferredType?: string; doNotCallAt?: Date } = {};
  if (!c.lead.budget && o.Budget) fill.budget = o.Budget.slice(0, 100);
  if (!c.lead.preferredType && o["Home size"]) fill.preferredType = o["Home size"].slice(0, 40);
  if (c.interest === "DO_NOT_CALL") fill.doNotCallAt = new Date();
  if (Object.keys(fill).length) await db.lead.update({ where: { id: c.lead.id }, data: fill });
  // An interested buyer is a qualified lead: hand over to sales straight away.
  if (c.interest === "INTERESTED" && !c.lead.qualifiedAt) {
    await qualifyLead(c.lead.id, null, { budget: o.Budget, preferredType: o["Home size"], purpose: purposeFrom(o.Purpose), timeline: timelineFrom(o.Timeline) }).catch(() => {});
  } else {
    if (!c.lead.purpose && purposeFrom(o.Purpose)) await db.lead.update({ where: { id: c.lead.id }, data: { purpose: purposeFrom(o.Purpose) } });
    await refreshScore(c.lead.id);
  }

  // Whoever asked for the call (e.g. from Telegram /lead) hears the result either way; campaigns don't spam.
  const starter = c.startedById && c.trigger !== "CAMPAIGN" ? await db.user.findUnique({ where: { id: c.startedById } }) : null;
  if (starter?.telegramChatId && starter.id !== c.lead.ownerId) {
    await send(starter.telegramChatId, `🤖 <b>${esc(c.lead.name)}</b>: ${esc(what.slice(0, 700))}\n${publicUrl(`/sales/leads/${c.lead.id}`)}`).catch(() => {});
  }
  if (!talked || c.interest === "NOT_INTERESTED" || c.interest === "WRONG_NUMBER" || c.interest === "DO_NOT_CALL") return;
  const text = `🤖 <b>AI call done</b> · ${esc(c.lead.name)} · ${c.lead.phone}${c.lead.project ? `\n${esc(c.lead.project.name)}` : ""}${facts ? `\n${esc(facts)}` : ""}\n${esc((c.summary ?? "Open the lead to read the conversation.").slice(0, 500))}\nPlease call them now.\n${publicUrl(`/sales/leads/${c.lead.id}`)}`;
  try {
    const owner = c.lead.ownerId ? await db.user.findUnique({ where: { id: c.lead.ownerId } }) : null;
    if (owner?.telegramChatId) await send(owner.telegramChatId, text);
    else await notifyRoles(["SALES_HEAD", "SALES_MANAGER", "MD"], text, { projectId: c.lead.projectId });
  } catch {}
}
