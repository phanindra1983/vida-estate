/** ₹ in Indian style: crores and lakhs for large amounts. */
export function inr(n: number | null | undefined, opts: { exact?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return "–";
  const neg = n < 0;
  const a = Math.abs(n);
  let s: string;
  if (!opts.exact && a >= 1e7) s = `₹${trim(a / 1e7)} Cr`;
  else if (!opts.exact && a >= 1e5) s = `₹${trim(a / 1e5)} L`;
  else s = "₹" + Math.round(a).toLocaleString("en-IN");
  return neg ? "−" + s : s;
}
function trim(v: number) {
  return v.toFixed(2).replace(/\.?0+$/, "");
}

export function num(n: number | null | undefined, digits = 0) {
  if (n == null) return "–";
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

export function pct(part: number, whole: number) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const DATETIME = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
export const date = (d: Date | string | null | undefined) => (d ? DATE.format(new Date(d)) : "–");
export const datetime = (d: Date | string | null | undefined) => (d ? DATETIME.format(new Date(d)) : "–");

export function ago(d: Date | string | null | undefined) {
  if (!d) return "–";
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Normalise an Indian mobile number to its last 10 digits. */
export function normPhone(p: string) {
  const d = (p || "").replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}

export function titleCase(s: string) {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Sequential document numbers like PO-VP1-0007. */
export function docNo(prefix: string, project: string | null, n: number) {
  return [prefix, project, String(n).padStart(4, "0")].filter(Boolean).join("-");
}
