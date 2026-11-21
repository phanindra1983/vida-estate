import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { botConfigured, botUsername, tg, connectBot } from "@/lib/telegram";
import { ROLE_LABEL } from "@/lib/constants";
import { PageHeader, Card, Table, Button, Notice, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";


async function connect() {
  "use server";
  const me = await requireUser(["MD"]);
  const base = process.env.PUBLIC_OS_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!base?.startsWith("https://") || !secret) redirect("/control/telegram?error=" + encodeURIComponent("PUBLIC_OS_URL (https) and TELEGRAM_WEBHOOK_SECRET must be set first."));
  try {
    await connectBot();
  } catch (e) {
    redirect("/control/telegram?error=" + encodeURIComponent((e as Error).message));
  }
  await audit(me, "UPDATE", "Setting", "telegram", "Connected the Telegram site bot");
  redirect("/control/telegram?ok=" + encodeURIComponent("The bot is connected to Vida OS."));
}

export default async function TelegramSetup({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["MD"]);
  const sp = await searchParams;
  const ready = botConfigured();
  let bot: string | null = null, hook: { url?: string; pending_update_count?: number; last_error_message?: string } | null = null, problem: string | null = null;
  if (ready) {
    try {
      bot = await botUsername();
      hook = await tg("getWebhookInfo");
    } catch (e) {
      problem = (e as Error).message;
    }
  }
  const expected = `${process.env.PUBLIC_OS_URL}/api/telegram`;
  const connected = hook?.url === expected;
  const linked = await db.user.findMany({ where: { telegramChatId: { not: null } }, orderBy: { name: "asc" } });

  return (
    <>
      <PageHeader eyebrow="Control" title="Telegram bot" />
      {sp.ok && <div className="mb-4"><Notice tone="good">{sp.ok}</Notice></div>}
      {(sp.error || problem) && <div className="mb-4"><Notice tone="bad">{sp.error ?? problem}</Notice></div>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Status">
          <ul className="grid gap-2 text-sm">
            <li>Bot token: {ready ? <Badge tone="good">Added</Badge> : <Badge tone="bad">Missing</Badge>}</li>
            <li>Bot: {bot ? <a className="underline" href={`https://t.me/${bot}`} target="_blank" rel="noreferrer">@{bot}</a> : "–"}</li>
            <li>Connected to Vida OS: {connected ? <Badge tone="good">Yes</Badge> : <Badge tone="warn">No</Badge>}</li>
            {hook?.last_error_message && <li className="text-bad">Last error from Telegram: {hook.last_error_message}</li>}
          </ul>
          {ready && !problem && (
            <form action={connect} className="mt-4"><Button variant={connected ? "secondary" : "primary"}>{connected ? "Reconnect" : "Connect the bot"}</Button></form>
          )}
        </Card>
        <Card title="How to switch it on">
          <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
            <li>In Telegram, open <b>@BotFather</b>, send /newbot, and name it (for example Vida Site Bot).</li>
            <li>BotFather replies with a token. Add it in Vercel → vida-os → Settings → Environment Variables as <b>TELEGRAM_BOT_TOKEN</b>, then redeploy.</li>
            <li>Come back here and press <b>Connect the bot</b>.</li>
            <li>Each person opens <b>My Telegram</b> in Vida OS and taps <b>Link Telegram</b>.</li>
          </ol>
        </Card>
      </div>
      <Card title={`Linked staff (${linked.length})`} pad={false} className="mt-6">
        <Table head={["Person", "Role"]} empty="Nobody has linked Telegram yet.">
          {linked.map((u) => <tr key={u.id}><td>{u.name}</td><td>{ROLE_LABEL[u.role] ?? u.role}</td></tr>)}
        </Table>
      </Card>
    </>
  );
}
