// src/router/ice.ts
// GET /ice — ออก ICE server config (STUN + TURN credential ชั่วคราว) ให้ frontend
// frontend อ่านผ่าน NEXT_PUBLIC_ICE_SERVERS_URL → fetchIceConfig()
//
// endpoint นี้ไม่บังคับ login โดยตั้งใจ — คนที่ไม่ได้สมัครสมาชิกก็ต้องโทรได้
// (และต้องใช้ TURN ด้วยเมื่ออยู่หลัง CGNAT) แต่ TURN คือ bandwidth ที่เราจ่ายจริง
// ถ้าปล่อยให้ขอ credential ได้ไม่จำกัด ใครก็เอา TURN ของเราไปใช้เป็น relay ฟรีได้
// จึงคุมด้วย rate limit ต่อ IP + อายุ credential สั้น แทนการบังคับ auth
import { Elysia, t } from "elysia";
import { generateIceConfig } from "../lib/ice";
import { TokenBucket, startSweeper } from "../lib/ratelimit";
import { clientIp } from "../lib/clientip";

// ปกติ client ขอครั้งเดียวตอนเริ่มสาย แล้วขอใหม่เมื่อ credential ใกล้หมดอายุ
// burst 10 ครั้ง เติมคืน 1 ครั้ง/6 วินาที เผื่อการกด next หลายรอบติดกัน
const iceBucket = new TokenBucket(10, 1 / 6);
startSweeper([iceBucket], 5 * 60_000);

export const Ice = new Elysia().get(
  "/ice",
  ({ query, headers, server, request, set }) => {
    const ip = clientIp(headers, server?.requestIP(request)?.address);
    if (!iceBucket.allow(ip)) {
      set.status = 429;
      return { message: "ขอ ICE config ถี่เกินไป กรุณารอสักครู่" };
    }

    // label ไว้ตาม log บน coturn เท่านั้น — sanitize กัน header/format injection
    const label = (query.label ?? "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 32);
    return generateIceConfig(label || undefined);
  },
  {
    query: t.Object({
      label: t.Optional(t.String()),
    }),
  },
);
