"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

export type PhotoAction = (fd: FormData) => Promise<{ error?: string; redirectTo?: string }>;

/** Shrink a phone photo to at most 1600px so uploads stay small on site connections. */
async function shrink(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * A form that compresses photos before sending them to a server action.
 * Fields are passed as children; the photo input is rendered here.
 */
export function PhotoForm({
  action, children, photoName, photoLabel, minPhotos = 0, multiple = true, submitLabel,
}: {
  action: PhotoAction; children: ReactNode; photoName: string; photoLabel: string; minPhotos?: number; multiple?: boolean; submitLabel: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [pending, start] = useTransition();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const files = fd.getAll(photoName).filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length < minPhotos) {
      setError(`Add at least ${minPhotos} photo${minPhotos > 1 ? "s" : ""}.`);
      return;
    }
    fd.delete(photoName);
    for (const f of files) fd.append(photoName, await shrink(f));
    start(async () => {
      const res = await action(fd);
      if (res?.error) setError(res.error);
      else if (res?.redirectTo) router.push(res.redirectTo);
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      {children}
      <label className="field">
        <span>{photoLabel}</span>
        <input
          className="input file:mr-3 file:rounded-md file:border-0 file:bg-[#f1eee8] file:px-3 file:py-2 file:text-sm"
          type="file" name={photoName} accept="image/*" capture="environment" multiple={multiple}
          onChange={(e) => setCount(e.target.files?.length ?? 0)}
        />
        <span className="text-xs font-normal text-stone">
          {count ? `${count} photo${count > 1 ? "s" : ""} selected.` : minPhotos ? `At least ${minPhotos} required. Photos are time-stamped when saved.` : "Optional."}
        </span>
      </label>
      {error && <p className="rounded-lg bg-[#fbefec] px-4 py-3 text-sm text-bad">{error}</p>}
      <button disabled={pending} className="min-h-12 rounded-lg bg-ink px-5 text-sm font-medium text-white hover:bg-ink-2 disabled:opacity-50">
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
