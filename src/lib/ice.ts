// src/lib/ice.ts
// สร้าง ICE server config สำหรับ WebRTC ฝั่ง client
//
// STUN: บอก client ว่า public IP/port ของตัวเองคืออะไร (ฟรี ใช้ของ Google ได้)
// TURN: relay เสียงผ่าน server กลาง เมื่อ peer ทะลุ NAT หากันตรงๆ ไม่ได้ (symmetric NAT/CGNAT)
//
// ใช้รูปแบบ "TURN REST API" (coturn use-auth-secret): server ไม่ต้องเก็บ user/pass
// แต่ออก credential ชั่วคราวที่หมดอายุเอง โดยทั้ง backend และ coturn รู้ shared secret ร่วมกัน
//   username   = "<unix-expiry>"            (หรือ "<unix-expiry>:<label>")
//   credential = base64( HMAC-SHA1( username, TURN_SECRET ) )
import { createHmac } from "crypto";
import { env } from "../config/env";

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type IceConfig = {
  iceServers: IceServer[];
  // วินาทีจนกว่า credential จะหมดอายุ — client เอาไปตั้ง refresh ก่อนหมดได้
  ttl: number;
};

const splitUrls = (raw: string): string[] =>
  raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

// สร้าง credential ชั่วคราวสำหรับ user 1 ราย
// label ใส่ user id/nickname เพื่อให้ตาม log บน coturn ได้ (ไม่บังคับ)
export function generateIceConfig(label?: string): IceConfig {
  const servers: IceServer[] = [];

  const stunUrls = splitUrls(env.STUN_URLS);
  if (stunUrls.length > 0) {
    servers.push({ urls: stunUrls });
  }

  const turnUrls = splitUrls(env.TURN_URLS);
  // ต้องมีทั้ง url และ secret ถึงจะออก TURN credential ได้
  if (turnUrls.length > 0 && env.TURN_SECRET) {
    const ttl = env.TURN_TTL > 0 ? env.TURN_TTL : 3600;
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = label ? `${expiry}:${label}` : `${expiry}`;
    const credential = createHmac("sha1", env.TURN_SECRET)
      .update(username)
      .digest("base64");

    servers.push({ urls: turnUrls, username, credential });
  }

  return {
    iceServers: servers,
    ttl: env.TURN_TTL > 0 ? env.TURN_TTL : 3600,
  };
}
