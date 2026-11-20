import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

/** Accepts a project code (e.g. VA) or exact project name. */
export async function projectIdFrom(v: unknown) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const p = await db.project.findFirst({ where: { OR: [{ code: s.toUpperCase() }, { name: s }] } });
  return p?.id ?? null;
}
