import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/auth";
import { accountingEntries, toCsv } from "@/lib/accounting";
import { audit } from "@/lib/audit";
import { FINANCE_ROLES } from "@/lib/constants";

export async function GET(req: NextRequest) {
  const user = await getUser();
  if (!user || !FINANCE_ROLES.includes(user.role)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const from = req.nextUrl.searchParams.get("from") ?? "2000-01-01";
  const to = req.nextUrl.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
  const rows = await accountingEntries(new Date(from), new Date(new Date(to).getTime() + 864e5));
  await audit(user, "EXPORT", "Accounting", null, `Exported ${rows.length} accounting entries for ${from} to ${to}`);
  return new NextResponse("﻿" + toCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="vida-accounting-${from}-to-${to}.csv"` },
  });
}
