// src/lib/password.ts
// hash/verify รหัสผ่านผ่าน Bun.password (native, รันบน thread pool)
//
// ทำไมไม่ใช้ bcryptjs: bcryptjs เป็น pure JavaScript จึงกิน CPU บน thread เดียวกับ
// WebSocket — วัดบนเครื่อง dev ได้ 193ms ต่อการ hash 1 ครั้ง โดย event loop เดินได้
// แค่ 2 tick (ควรได้ ~193) แปลว่าทุกคนที่กำลังคุยกันอยู่ค้างไปด้วยทั้งหมด
// Bun.password ใช้เวลาใกล้เคียงกันแต่ไม่บล็อก event loop และ 10 requests พร้อมกัน
// เร็วกว่า 8 เท่า (224ms เทียบกับ 1863ms)
//
// ยังใช้ bcrypt เป็น algorithm เดิมอยู่ → hash เก่าที่ bcryptjs สร้างไว้ verify ผ่านหมด
// ไม่ต้อง migrate อะไรทั้งสิ้น
import { env } from "../config/env";

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, {
    algorithm: "bcrypt",
    cost: env.BCRYPT_ROUNDS,
  });
}

// verify แบบไม่ throw — hash ที่พังหรือรูปแบบไม่รู้จักถือว่าไม่ผ่าน
export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}

// hash ทิ้งไว้สำหรับกรณีที่ไม่มี user จริง เพื่อให้เวลาตอบสนองใกล้เคียงกับกรณีรหัสผิด
// (ไม่งั้นจะจับเวลาแล้วเดาได้ว่า username ไหนมีอยู่ในระบบ)
const DUMMY_HASH = await hashPassword("dummy-password-for-timing-equalization");

export async function verifyDummy(plain: string): Promise<void> {
  await verifyPassword(plain, DUMMY_HASH);
}
