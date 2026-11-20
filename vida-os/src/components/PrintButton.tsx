"use client";

/** Opens the browser's print dialog; choose "Save as PDF" to download. */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button onClick={() => window.print()} className="no-print inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-ink-2">
      {label}
    </button>
  );
}
