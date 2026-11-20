import Link from "next/link";
import type { ReactNode, ButtonHTMLAttributes } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        <h1 className="font-serif text-3xl leading-tight md:text-4xl">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Card({ title, action, children, className, pad = true }: { title?: string; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("rounded-xl border border-line bg-panel", className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-medium">{title}</h2>
          {action}
        </header>
      )}
      <div className={pad ? "p-5" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 font-serif text-3xl leading-none">{value}</p>
      {sub && <p className={cx("mt-2 text-xs", tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "good" ? "text-good" : "text-stone")}>{sub}</p>}
    </div>
  );
}

const TONES: Record<string, string> = {
  neutral: "bg-[#f1eee8] text-ink-2",
  good: "bg-[#e6f0ea] text-good",
  warn: "bg-[#f6ecd9] text-warn",
  bad: "bg-[#f5e3df] text-bad",
  brass: "bg-[#f3eadb] text-brass-dark",
  ink: "bg-ink text-white",
};

/** Maps any status string to a colour, so every list uses the same language. */
export function statusTone(s: string): keyof typeof TONES {
  if (["PAID", "APPROVED", "DONE", "RECEIVED", "MATCHED", "BOOKED", "AGREEMENT_SIGNED", "AVAILABLE", "CLOSED"].includes(s)) return "good";
  if (["REJECTED", "LOST", "MISMATCH", "OVERDUE", "BUDGET_HOLD", "ON_HOLD", "DELAYED", "CANCELLED"].includes(s)) return "bad";
  if (["PENDING", "PENDING_APPROVAL", "IN_APPROVAL", "AWAITING_APPROVAL", "BLOCKED", "DUE", "PART_PAID", "PARTLY_RECEIVED", "UNIT_BLOCKED", "IN_PAYMENT"].includes(s)) return "warn";
  return "neutral";
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={cx("inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium", TONES[tone])}>{children}</span>;
}

export function Status({ value }: { value: string }) {
  return <Badge tone={statusTone(value)}>{value.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</Badge>;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" };
const BTN = {
  primary: "bg-ink text-white hover:bg-ink-2",
  secondary: "border border-line bg-white text-ink hover:border-stone",
  ghost: "text-ink-2 hover:bg-[#f1eee8]",
  danger: "border border-[#e5c4bd] bg-white text-bad hover:bg-[#fbefec]",
};
export function Button({ variant = "primary", size = "md", className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "min-h-9 px-3 text-xs" : "min-h-11 px-4 text-sm",
        BTN[variant],
        className,
      )}
    />
  );
}

export function LinkButton({ href, children, variant = "primary", size = "md" }: { href: string; children: ReactNode; variant?: keyof typeof BTN; size?: "sm" | "md" }) {
  return (
    <Link
      href={href}
      className={cx("inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors", size === "sm" ? "min-h-9 px-3 text-xs" : "min-h-11 px-4 text-sm", BTN[variant])}
    >
      {children}
    </Link>
  );
}

export function Table({ head, children, empty }: { head: (string | { label: string; num?: boolean })[]; children: ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.flat().filter(Boolean).length > 0 : !!children;
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead>
          <tr>
            {head.map((h, i) => {
              const o = typeof h === "string" ? { label: h } : h;
              return <th key={i} className={o.num ? "num" : ""}>{o.label}</th>;
            })}
          </tr>
        </thead>
        <tbody>
          {hasRows ? children : (
            <tr><td colSpan={head.length} className="py-10 text-center text-stone">{empty ?? "Nothing here yet."}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs font-normal text-stone">{hint}</span>}
    </label>
  );
}

export function Notice({ tone = "warn", children }: { tone?: "warn" | "bad" | "good" | "neutral"; children: ReactNode }) {
  const c = tone === "bad" ? "border-[#e5c4bd] bg-[#fbefec] text-bad" : tone === "good" ? "border-[#c9dfd2] bg-[#eef6f1] text-good" : tone === "neutral" ? "border-line bg-white text-ink-2" : "border-[#ead6b2] bg-[#fbf4e6] text-warn";
  return <div className={cx("rounded-lg border px-4 py-3 text-sm", c)}>{children}</div>;
}

export function Progress({ value, tone }: { value: number; tone?: "good" | "warn" | "bad" }) {
  const v = Math.max(0, Math.min(100, value));
  const c = tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-brass";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#eee9df]">
      <div className={cx("h-full rounded-full", c)} style={{ width: `${v}%` }} />
    </div>
  );
}
