"use client";

import { useEffect, useState } from "react";

/** "Tick all" for a bulk-action form, plus a live count of ticked rows. */
export function SelectAll({ formId }: { formId: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const update = () => setN(form.querySelectorAll<HTMLInputElement>('input[name="ids"]:checked').length);
    form.addEventListener("change", update);
    update();
    return () => form.removeEventListener("change", update);
  }, [formId]);
  const toggle = (on: boolean) => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    form?.querySelectorAll<HTMLInputElement>('input[name="ids"]').forEach((c) => (c.checked = on));
    form?.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return (
    <span className="flex items-center gap-3 text-sm">
      <label className="flex min-h-9 items-center gap-2">
        <input type="checkbox" className="h-4 w-4 accent-[#a07a45]" onChange={(e) => toggle(e.target.checked)} aria-label="Tick all" /> Tick all
      </label>
      <span className="text-stone">{n} ticked</span>
    </span>
  );
}
