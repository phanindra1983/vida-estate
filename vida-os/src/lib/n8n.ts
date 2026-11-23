import { timingSafeEqual } from "node:crypto";
import { publicUrl } from "./notify";
import { temperature } from "./lead-score";

/**
 * Hands a website enquiry to the n8n lead workflow (scores each answer, logs it to the Google Sheet).
 * Off until N8N_LEAD_WEBHOOK_URL is set. The lead is already saved in Vida OS before this runs,
 * so a slow or broken n8n never loses a lead: this waits at most 4 s and never throws.
 */
export type N8nLead = {
  leadId: string;
  name: string;
  phone: string;
  email: string | null;
  project: string | null;
  budget: string | null;
  homeSize: string | null;
  purpose: string | null;
  timeline: string | null;
  preferredDay: string | null;
  campaign: string | null;
  score: number;
  duplicate: boolean;
  mars?: Record<string, string | null> | null; // Vida Mars concept page answers
};

export async function sendLeadToN8n(lead: N8nLead) {
  const url = process.env.N8N_LEAD_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vida-key": process.env.N8N_LEAD_WEBHOOK_SECRET ?? "" },
      body: JSON.stringify({
        ...lead,
        temperature: temperature(lead.score),
        source: "WEBSITE",
        crmUrl: publicUrl(`/sales/leads/${lead.leadId}`),
        submittedAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {}
}

/** Requests from n8n back into Vida OS carry the same shared key (header x-vida-key). */
export function n8nKeyOk(given: string | null) {
  const want = process.env.N8N_LEAD_WEBHOOK_SECRET ?? "";
  if (!want || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
