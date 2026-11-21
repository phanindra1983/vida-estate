/**
 * Speech to text for Telegram voice notes, using Sarvam AI (https://docs.sarvam.ai).
 * Setting: SARVAM_API_KEY (added by the owner in Vercel).
 * One call both transcribes and translates to English, so a report spoken in
 * Telugu, Hindi or English is saved in English. Sarvam's quick API takes up to 30 seconds of audio.
 */
export const speechConfigured = () => !!process.env.SARVAM_API_KEY;
export const MAX_VOICE_SECONDS = 30;

export async function speechToEnglish(audio: Blob): Promise<{ text: string; language: string | null }> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error("Voice notes are not switched on yet.");
  const form = new FormData();
  form.append("file", audio, "voice.ogg");
  form.append("model", "saaras:v4");
  form.append("mode", "translate");
  form.append("language_code", "unknown");
  const res = await fetch("https://api.sarvam.ai/speech-to-text", { method: "POST", headers: { "api-subscription-key": key }, body: form });
  const json = (await res.json().catch(() => ({}))) as { transcript?: string; language_code?: string | null; error?: { message?: string; code?: string } };
  if (!res.ok) {
    if (res.status === 402 || json.error?.code === "insufficient_quota_error") throw new Error("The voice service has run out of credit.");
    throw new Error(json.error?.message ?? `Voice service error ${res.status}`);
  }
  return { text: (json.transcript ?? "").trim(), language: json.language_code ?? null };
}

const LANG: Record<string, string> = { "te-IN": "Telugu", "hi-IN": "Hindi", "en-IN": "English", "ta-IN": "Tamil", "kn-IN": "Kannada", "mr-IN": "Marathi", "ur-IN": "Urdu", "bn-IN": "Bengali", "od-IN": "Odia" };
export const languageName = (code: string | null) => (code ? LANG[code] ?? code : null);

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** "Forty-two workers" -> "42 workers", so spoken numbers work where the bot wants digits. */
export function wordsToDigits(s: string) {
  return s.replace(/\b((?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)[\s-]*)+)\b/gi, (m) => {
    const words = m.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== "and");
    if (!words.length) return m;
    let total = 0, cur = 0;
    for (const w of words) {
      if (w === "hundred") cur = (cur || 1) * 100;
      else if (w === "thousand") { total += (cur || 1) * 1000; cur = 0; }
      else if (w in SMALL) cur += SMALL[w];
      else return m;
    }
    return `${total + cur} `;
  }).replace(/\s+([.,!?])/g, "$1").trim();
}
