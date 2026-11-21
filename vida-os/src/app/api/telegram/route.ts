import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { handleUpdate, type TgUpdate } from "@/lib/telegram-bot";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // photo downloads and uploads can take a few seconds

/** Telegram calls this for every message to the bot. Set up from Control → Telegram bot. */
export async function POST(req: NextRequest) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expected || got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    await handleUpdate((await req.json()) as TgUpdate);
  } catch (e) {
    // Always answer 200, or Telegram keeps re-sending the same message.
    console.error("Telegram update failed:", e);
  }
  return NextResponse.json({ ok: true });
}
