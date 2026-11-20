import Link from "next/link";
import { Notice, cx } from "@/components/ui";
import { getUser } from "@/lib/auth";
import { navFor } from "@/components/nav";

/** Shows ?ok= and ?error= messages left by server actions. */
export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <div className="mb-6">
      <Notice tone={error ? "bad" : "good"}>{error ?? ok}</Notice>
    </div>
  );
}

/** Sales tabs, limited to the pages this user's role can open (same rules as the sidebar). */
export async function SubNav({ active }: { active: string }) {
  const user = await getUser();
  const items = (navFor(user?.role ?? "").find((g) => g.label === "Sales")?.items ?? []).map((i) => [i.href, i.label]);
  return (
    <nav className="-mt-4 mb-8 flex gap-1 overflow-x-auto border-b border-line text-sm">
      {items.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className={cx("whitespace-nowrap border-b-2 px-3 py-2.5", active === href ? "border-ink text-ink" : "border-transparent text-stone hover:text-ink")}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function waLink(phone: string, text: string) {
  return `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
}

export type SP = Promise<Record<string, string | string[] | undefined>>;
export function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}
