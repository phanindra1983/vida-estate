import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "vida_session";
const secret = () => {
  const s = process.env.AUTH_SECRET;
  // In production a missing secret would let anyone forge a session with the public fallback.
  if (!s && process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(s || "dev-only-secret-change-me");
};

export type SessionPayload = { uid: string; role: string; name: string };

export async function signSession(p: SessionPayload) {
  return new SignJWT(p).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("12h").sign(secret());
}

export async function verifySession(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}
