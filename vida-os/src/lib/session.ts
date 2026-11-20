import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "vida_session";
const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET || "dev-only-secret-change-me");

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
