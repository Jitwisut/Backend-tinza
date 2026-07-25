// src/lib/clientip.ts
// หา IP จริงของ client เพื่อใช้เป็น key ของ rate limit และการจำกัดจำนวน connection
//
// ปัญหา: บน Railway/Fly/Render/nginx ทราฟฟิกวิ่งผ่าน reverse proxy ทำให้
// remoteAddress กลายเป็น IP ของ proxy เหมือนกันหมดทุกคน ถ้าใช้ค่านั้นเป็น key
// ทุกคนจะไปกองอยู่ bucket เดียวกัน — limit ตัวเดียวจะล็อกผู้ใช้ทั้งระบบพร้อมกัน
//
// ทางแก้คืออ่าน X-Forwarded-For แต่ header นี้ client ปลอมได้ ถ้าไม่ได้อยู่หลัง proxy
// จริง จึงต้องเปิดใช้ผ่าน TRUST_PROXY=true เท่านั้น (ค่า default คือไม่เชื่อ)
import { env } from "../config/env";

// X-Forwarded-For รูปแบบ: "client, proxy1, proxy2" → ตัวซ้ายสุดคือ client จริง
function fromForwardedFor(header: string | undefined): string | null {
  if (!header) return null;
  const first = header.split(",")[0]?.trim();
  return first ? first : null;
}

export function clientIp(
  headers: Record<string, string | undefined>,
  remoteAddress: string | undefined,
): string {
  if (env.TRUST_PROXY) {
    const forwarded =
      fromForwardedFor(headers["x-forwarded-for"]) ??
      headers["x-real-ip"]?.trim() ??
      null;
    if (forwarded) return forwarded;
  }
  return remoteAddress ?? "unknown";
}
