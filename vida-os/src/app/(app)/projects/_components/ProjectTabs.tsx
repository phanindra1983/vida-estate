import Link from "next/link";
import { cx } from "@/components/ui";

/** Simple project switcher using ?project=<id>. */
export function ProjectTabs({ base, projects, current }: { base: string; projects: { id: string; name: string }[]; current?: string }) {
  if (projects.length < 2) return null;
  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {projects.map((p) => (
        <Link
          key={p.id}
          href={`${base}?project=${p.id}`}
          className={cx(
            "inline-flex min-h-10 items-center rounded-full border px-4 text-sm",
            p.id === current ? "border-ink bg-ink text-white" : "border-line bg-white text-ink-2 hover:border-stone",
          )}
        >
          {p.name}
        </Link>
      ))}
    </div>
  );
}
