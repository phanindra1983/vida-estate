import Link from "next/link";

export default function NoAccess() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6 text-center">
      <div>
        <p className="eyebrow">Vida OS</p>
        <h1 className="mt-3 font-serif text-4xl">This page is not part of your role.</h1>
        <p className="mt-3 text-sm text-stone">Ask the MD to change your access if you need it.</p>
        <Link href="/" className="mt-6 inline-block text-sm underline underline-offset-4">Back to your dashboard</Link>
      </div>
    </main>
  );
}
