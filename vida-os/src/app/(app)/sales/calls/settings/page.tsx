import { requireUser } from "@/lib/auth";
import { datetime } from "@/lib/format";
import { PageHeader, Card, Button, Field, Notice } from "@/components/ui";
import { getConfig, settingsOf, defaultWelcome, LANGUAGES, VOICES, bolnaConfigured } from "@/lib/bolna";
import { Flash, one, type SP } from "../../_ui";
import { SETTINGS_ROLES, CallTabs } from "../_shared";
import { saveSettings, testCall } from "../actions";

export const dynamic = "force-dynamic";

export default async function CallerSettingsPage({ searchParams }: { searchParams: SP }) {
  const u = await requireUser(SETTINGS_ROLES);
  const sp = await searchParams;
  const cfg = await getConfig();
  const s = settingsOf(cfg);
  const ready = bolnaConfigured() && !!cfg.agentId;

  return (
    <>
      <PageHeader eyebrow="Sales · AI call centre" title="AI caller settings" />
      <CallTabs active="/sales/calls/settings" role={u.role} />
      <Flash ok={one(sp.ok)} error={one(sp.error)} />
      {!ready && <div className="mb-6"><Notice>Set up the AI caller on the Overview tab first. These settings are saved and used once it exists.</Notice></div>}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="How the AI caller speaks">
          <form action={saveSettings} className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Caller's name"><input className="input" name="callerName" defaultValue={s.callerName} maxLength={30} /></Field>
              <Field label="Starts the call in">
                <select className="input" name="language" defaultValue={s.language}>
                  {Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Longest call">
                <select className="input" name="maxMinutes" defaultValue={String(s.maxMinutes)}>
                  {[2, 3, 4, 5, 6, 8, 10].map((m) => <option key={m} value={m}>{m} minutes</option>)}
                </select>
              </Field>
            </div>
            <Field label="Voice" hint="Indian voices (Sarvam). The same voice speaks English, Hindi and Telugu, and the caller follows whichever language the buyer speaks.">
              <select className="input" name="voiceId" defaultValue={s.voiceId}>
                {(["Female", "Male"] as const).map((g) => (
                  <optgroup key={g} label={g}>
                    {VOICES.filter((v) => v.gender === g).map((v) => <option key={v.id} value={v.id}>{v.name} · {v.style}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label="First thing the caller says" hint="Leave empty to use the standard opening for the language. {{customer_name}} and {{project_name}} are filled in for each buyer.">
              <textarea className="input min-h-24" name="welcome" defaultValue={s.welcome} placeholder={defaultWelcome(s.language, s.callerName)} maxLength={400} />
            </Field>
            <Field label="Facts the caller may share" hint="Location, amenities, nearby schools and offices, site office timings. Prices, offers and possession dates are never spoken, even if written here.">
              <textarea className="input min-h-36" name="notes" defaultValue={s.notes} maxLength={3000} placeholder={"Vida Aurum is in Kokapet, 10 minutes from the Financial District.\nClubhouse, pool, 70% open space.\nSite office open 10 am to 6 pm, all days."} />
            </Field>
            <div><Button>Save and update the AI caller</Button></div>
            {cfg.agentUpdatedAt && <p className="text-xs text-stone">Last pushed to Bolna {datetime(cfg.agentUpdatedAt)}.</p>}
          </form>
        </Card>

        <div className="grid content-start gap-6">
          <Card title="What the caller always does">
            <ul className="grid list-disc gap-2 pl-5 text-sm">
              <li>Checks it&apos;s a good time; offers to call back if not.</li>
              <li>Asks: living or investment, home size, budget, when they plan to buy.</li>
              <li>Offers a site visit and agrees a day and time.</li>
              <li>Says a sales manager will call them shortly.</li>
              <li>Says it&apos;s an AI if asked. Never quotes prices, offers, dates or legal terms. Never asks for money, OTPs or ID.</li>
              <li>Stops calling anyone who asks not to be called again.</li>
              <li>Only calls between 9 am and 9 pm.</li>
            </ul>
            <p className="mt-3 text-xs text-stone">These rules keep calls within TRAI and RERA rules, so they can&apos;t be switched off here.</p>
          </Card>
          {ready && (
            <Card title="Hear it">
              <form action={testCall} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <input type="hidden" name="back" value="/sales/calls/settings" />
                <Field label="Your mobile number"><input className="input" name="phone" inputMode="tel" placeholder="98xxxxxxxx" required /></Field>
                <Button size="sm" variant="secondary">Call me</Button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
