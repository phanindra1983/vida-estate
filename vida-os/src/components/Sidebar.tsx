"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { NavGroup } from "./nav";

export function Sidebar({ groups, user, pending }: { groups: NavGroup[]; user: { name: string; roleLabel: string }; pending: number }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  return (
    <>
      <header className="no-print sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-canvas/95 px-4 backdrop-blur lg:hidden">
        <img src="/logo-dark.svg" alt="Vida Estates" className="h-7" />
        <button onClick={() => setOpen(!open)} className="min-h-11 min-w-11 rounded-lg text-sm" aria-expanded={open} aria-label="Menu">
          {open ? "Close" : "Menu"}
        </button>
      </header>

      <aside
        className={`no-print fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-ink text-white transition-transform lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="px-6 pb-4 pt-6">
          <img src="/logo-light.svg" alt="Vida Estates" className="w-28" />
          <p className="mt-2 text-[10px] uppercase tracking-[.3em] text-white/40">Vida OS</p>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-6">
          {groups.map((g) => (
            <div key={g.label} className="mt-5">
              <p className="px-3 text-[10px] uppercase tracking-[.24em] text-white/35">{g.label}</p>
              <ul className="mt-1.5">
                {g.items.map((i) => (
                  <li key={i.href}>
                    <Link
                      href={i.href}
                      onClick={() => setOpen(false)}
                      className={`flex min-h-10 items-center justify-between rounded-md px-3 text-sm transition-colors ${active(i.href) ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"}`}
                    >
                      {i.label}
                      {i.href === "/approvals" && pending > 0 && (
                        <span className="rounded-full bg-brass px-2 text-[11px] font-medium text-white">{pending}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 px-6 py-4">
          <p className="text-sm">{user.name}</p>
          <p className="text-xs text-white/50">{user.roleLabel}</p>
          <form action="/logout" method="post" className="mt-3">
            <button className="text-xs text-white/60 underline-offset-4 hover:text-white hover:underline">Sign out</button>
          </form>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} />}
    </>
  );
}
