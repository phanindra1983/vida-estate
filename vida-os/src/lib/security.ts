import { timingSafeEqual } from "node:crypto";

/**
 * Small security helpers shared by public routes and sign-in.
 *
 * Rate limits are per server instance (in memory). That stops a single script hammering one
 * instance; a bot spread across many instances is the job of Cloudflare Turnstile (Needs owner:
 * a site key) — see SECURITY.md.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** true = allowed. `limit` hits per `windowMs` for this key. */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  if (buckets.size > 5000) for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= limit;
}
export const _resetRateLimits = () => buckets.clear();

export function clientIp(h: Headers) {
  return (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
}

/** Websites allowed to post enquiries and read public data. */
export function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ["https://www.vidaestates.co.in", "https://vidaestates.co.in", ...extra, ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:4400", "http://127.0.0.1:4400"])];
}
export function originAllowed(origin: string | null) {
  return !!origin && allowedOrigins().includes(origin);
}

export const cap = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
export const isEmail = (v: string) => v.length <= 120 && /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(v);

export function safeEqual(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Vercel cron sends `Authorization: Bearer <CRON_SECRET>`; nothing else is accepted. */
export function cronAuthorized(h: Headers) {
  const secret = process.env.CRON_SECRET;
  return !!secret && safeEqual(h.get("authorization"), `Bearer ${secret}`);
}

/** For public/partner routes: our own validation text passes through, anything internal becomes generic (and is logged). */
export function publicError(e: unknown, fallback = "Could not save this record") {
  const m = e instanceof Error ? e.message : String(e);
  if (/^(Enter a valid|Name is required|Please |Consent is required)/.test(m)) return m.slice(0, 160);
  console.error("public route error:", m);
  return fallback;
}
