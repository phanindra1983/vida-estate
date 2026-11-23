import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

const PUBLIC = ["/login", "/try", "/api/public", "/api/leads/web", "/api/leads/ai-call", "/api/leads/meta", "/api/leads/in/", "/api/leads/google", "/api/accounts/in", "/rfq/", "/my/", "/api/cron/procurement", "/api/cron/digest", "/api/telegram", "/api/bolna/webhook"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const s = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!s) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|monogram.svg|logo-.*\\.svg|uploads/).*)"],
};
