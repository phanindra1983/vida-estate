import { Notice } from "@/components/ui";

/** Shows ?ok= and ?error= messages left by server actions. */
export function Flash({ sp }: { sp: { ok?: string; error?: string } }) {
  if (!sp.ok && !sp.error) return null;
  return (
    <div className="mb-6">
      <Notice tone={sp.error ? "bad" : "good"}>{sp.error ?? sp.ok}</Notice>
    </div>
  );
}
