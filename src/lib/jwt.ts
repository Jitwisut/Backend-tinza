// src/lib/jwt.ts
// ตรวจสอบ JWT (HS256) เองแบบไม่พึ่ง plugin — ใช้ได้ทั้งใน WebSocket handler และ REST
//
// token ที่ออกจาก /auth/signin ใช้ @elysiajs/jwt (jose) อัลกอริทึม default = HS256
// โครงสร้าง: base64url(header).base64url(payload).base64url(signature)
//   signature = HMAC-SHA256( "<header>.<payload>", JWT_SECRET )
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../config/env";

export type JwtPayload = {
  sub: string; // user id (string)
  username?: string;
  exp?: number; // unix seconds
  [key: string]: unknown;
};

// คืน payload ถ้า signature ถูกและยังไม่หมดอายุ, ไม่งั้นคืน null (ไม่ throw)
export function verifyJwt(token: string | undefined | null): JwtPayload | null {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  const expected = createHmac("sha256", env.JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  // เทียบแบบ constant-time กัน timing attack (ความยาวต้องเท่ากันก่อน)
  const sigBuf = Buffer.from(signatureB64);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  // exp เป็น unix seconds — เผื่อ clock skew เล็กน้อย
  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp + 5) {
    return null;
  }

  return payload;
}

// ดึง Bearer token จาก Authorization header
export function bearerFromHeader(authHeader?: string): string | null {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}
