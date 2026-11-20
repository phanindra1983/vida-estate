import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { waLink, emailMode, emailTestTo } from "@/lib/notify";
import { sendTestEmail } from "../actions";
import { Button } from "@/components/ui";
import { datetime } from "@/lib/format";
import { PageHeader, Card, Table, Badge, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Outbox({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["MD", "GM_PROJECTS", "PURCHASE"]);
  const sp = await searchParams;
  const msgs = await db.outboxMessage.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  const mode = emailMode();
  const testTo = emailTestTo();
  const emailLive = mode !== "OFF";

  return (
    <>
      <PageHeader eyebrow="Procurement engine" title="Messages sent" />
      <div className="mb-6">
        <Notice tone={emailLive ? "good" : "warn"}>
          {!emailLive
            ? "Email is not connected yet, so messages wait here as Queued. Once the sender settings are in .env they go out automatically. WhatsApp messages have a one-click send link until a WhatsApp Business API account is connected."
            : testTo
              ? `Email is connected from ${process.env.MAIL_FROM} (${mode === "SMTP" ? "your mail server" : "Resend"}). TEST MODE is on: every email goes to ${testTo}, not to vendors. Remove MAIL_TEST_TO from .env to send to vendors for real.`
              : `Email is connected from ${process.env.MAIL_FROM}: enquiries, reminders and award letters go out to vendors automatically.`}
        </Notice>
        {emailLive && <form action={sendTestEmail} className="mt-3"><Button size="sm" variant="secondary">Send test email</Button></form>}
        {sp.ok && <div className="mt-3"><Notice tone="good">{sp.ok}</Notice></div>}
        {sp.error && <div className="mt-3"><Notice tone="bad">{sp.error}</Notice></div>}
      </div>
      <Card pad={false}>
        <Table head={["When", "Channel", "To", "Message", "Status"]} empty="Nothing sent yet.">
          {msgs.map((m) => (
            <tr key={m.id}>
              <td className="whitespace-nowrap text-stone">{datetime(m.createdAt)}</td>
              <td>{m.channel === "EMAIL" ? "Email" : "WhatsApp"}</td>
              <td className="whitespace-nowrap">{m.to}</td>
              <td className="max-w-md">
                {m.subject && <p className="font-medium">{m.subject}</p>}
                <details className="text-xs text-stone"><summary className="cursor-pointer">Show message</summary><pre className="mt-1 whitespace-pre-wrap font-sans">{m.body}</pre></details>
              </td>
              <td>
                <Badge tone={m.status === "SENT" ? "good" : m.status === "FAILED" ? "bad" : "warn"}>{m.status === "QUEUED" ? "Queued" : m.status === "SENT" ? "Sent" : "Failed"}</Badge>
                {m.channel === "WHATSAPP" && m.status === "QUEUED" && <p className="mt-1 text-xs"><a className="underline" target="_blank" rel="noreferrer" href={waLink(m.to, m.body)}>Send now</a></p>}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
