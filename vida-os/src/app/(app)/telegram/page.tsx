import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { botConfigured, botUsername, newLinkCode } from "@/lib/telegram";
import { PageHeader, Card, Button, Notice, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

async function makeLink() {
  "use server";
  const u = await requireUser();
  const code = await newLinkCode(u.id);
  redirect(`/telegram?code=${code}`);
}

async function unlink() {
  "use server";
  const u = await requireUser();
  await db.user.update({ where: { id: u.id }, data: { telegramChatId: null, telegramState: null } });
  await audit(u, "UPDATE", "User", u.id, "Unlinked Telegram from Vida OS");
  revalidatePath("/telegram");
  redirect("/telegram");
}

export default async function MyTelegram({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const u = await requireUser();
  const { code } = await searchParams;
  const me = await db.user.findUniqueOrThrow({ where: { id: u.id } });
  const ready = botConfigured();
  let bot: string | null = null;
  if (ready) bot = await botUsername().catch(() => null);
  const link = bot && code ? `https://t.me/${bot}?start=${code}` : null;

  return (
    <>
      <PageHeader eyebrow="Site bot" title="My Telegram" />
      {!ready || !bot ? (
        <Notice>The Vida OS Telegram bot is not switched on yet. The MD sets it up in Control → Telegram bot.</Notice>
      ) : (
        <div className="grid max-w-2xl gap-6">
          <Card title="Your link">
            {me.telegramChatId ? (
              <div className="grid gap-3 text-sm">
                <p><Badge tone="good">Linked</Badge> Your Telegram is linked. Open <a className="underline" href={`https://t.me/${bot}`} target="_blank" rel="noreferrer">@{bot}</a> and send /help.</p>
                <form action={unlink}><Button size="sm" variant="danger">Unlink Telegram</Button></form>
              </div>
            ) : link ? (
              <div className="grid gap-3 text-sm">
                <p>Tap the button on the phone that has Telegram. Telegram opens; press <b>Start</b>. The link works once, for 30 minutes.</p>
                <a href={link} target="_blank" rel="noreferrer" className="inline-flex min-h-11 w-fit items-center rounded-lg bg-ink px-4 text-sm font-medium text-white">Open Telegram and link</a>
                <p className="text-xs text-stone">On a computer? Open @{bot} in Telegram and send: /start {code}</p>
              </div>
            ) : (
              <form action={makeLink} className="grid gap-3 text-sm">
                <p>Link your Telegram to send daily reports, photos and material requests, and to approve from your phone.</p>
                <div><Button>Link Telegram</Button></div>
              </form>
            )}
          </Card>
          <Card title="What you can do on Telegram">
            <ul className="grid gap-1.5 text-sm">
              <li><b>/report</b>: today&apos;s site report with photos</li>
              <li><b>/material</b>: ask for material</li>
              <li><b>/approvals</b>: approve or reject what is waiting for you</li>
              <li><b>/cancel</b>: stop what you are doing</li>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
