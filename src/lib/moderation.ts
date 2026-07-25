// src/lib/moderation.ts
// ระบบแบนที่อยู่ถาวร + แบนอัตโนมัติเมื่อโดนรายงานถึงเกณฑ์
//
// ทำไมต้องมี: `blocked` ใน WebSocket handler เป็น Set ระดับ session ที่หายไป
// ทันทีที่ปิดแท็บ แปลว่าเดิมไม่มีวิธีเอาคนที่ทำตัวไม่ดีออกจากระบบเลย — แค่ต่อใหม่
// ก็กลับมาเจอคนอื่นได้เหมือนเดิม
//
// เรื่อง performance: การเช็คแบนอยู่บน hot path ของทุก connection ที่เข้ามา
// ถ้ายิง query ทุกครั้งจะกลายเป็น 1 query ต่อ 1 การเชื่อมต่อ จึงโหลดรายชื่อที่ยัง
// ไม่หมดอายุมาไว้ใน memory แล้ว refresh ตามรอบแทน (รายชื่อแบนมีไม่เยอะ)
import { db } from "./connectdb";
import { env } from "../config/env";

type BanCache = {
  userIds: Set<number>;
  ips: Set<string>;
  loadedAt: number;
};

let cache: BanCache = { userIds: new Set(), ips: new Set(), loadedAt: 0 };

// โหลดรายชื่อแบนที่ยัง active ทั้งหมดเข้า memory
export async function refreshBanCache(): Promise<void> {
  try {
    const result = await db.query(
      `SELECT user_id, ip FROM bans
        WHERE expires_at IS NULL OR expires_at > now()`,
    );
    const userIds = new Set<number>();
    const ips = new Set<string>();
    for (const row of result.rows) {
      if (row.user_id !== null) userIds.add(Number(row.user_id));
      if (row.ip) ips.add(row.ip);
    }
    cache = { userIds, ips, loadedAt: Date.now() };
  } catch (err) {
    // ถ้าโหลดไม่ได้ให้ใช้ cache เดิมต่อ ดีกว่าปล่อยคนที่ถูกแบนเข้ามาทั้งหมด
    console.error("[moderation.refreshBanCache] error:", err);
  }
}

// เช็คแบบ O(1) ไม่แตะ DB — ใช้ได้บน hot path ของ WebSocket
export function isBanned(userId: number | null, ip: string): boolean {
  if (userId !== null && cache.userIds.has(userId)) return true;
  return cache.ips.has(ip);
}

export function banCacheStats() {
  return {
    users: cache.userIds.size,
    ips: cache.ips.size,
    ageMs: cache.loadedAt ? Date.now() - cache.loadedAt : null,
  };
}

// สร้างแบนใหม่ แล้ว refresh cache ทันทีเพื่อให้มีผลเดี๋ยวนั้น
export async function createBan(input: {
  userId: number | null;
  ip: string | null;
  reason: string;
  createdBy: string;
  hours: number | null; // null = ถาวร
}): Promise<number | null> {
  if (input.userId === null && input.ip === null) return null;
  try {
    const result = await db.query(
      `INSERT INTO bans (user_id, ip, reason, created_by, expires_at)
       VALUES ($1, $2, $3, $4,
               CASE WHEN $5::numeric IS NULL THEN NULL
                    ELSE now() + ($5::numeric * INTERVAL '1 hour') END)
       RETURNING id`,
      [input.userId, input.ip, input.reason.slice(0, 200), input.createdBy, input.hours],
    );
    await refreshBanCache();
    return result.rows[0]?.id ?? null;
  } catch (err) {
    console.error("[moderation.createBan] error:", err);
    return null;
  }
}

// ปลดแบน (ลบแถวทิ้ง) คืน true ถ้ามีแถวถูกลบจริง
export async function liftBan(banId: number): Promise<boolean> {
  try {
    const result = await db.query("DELETE FROM bans WHERE id = $1", [banId]);
    await refreshBanCache();
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    console.error("[moderation.liftBan] error:", err);
    return false;
  }
}

export async function listBans(limit = 100) {
  const result = await db.query(
    `SELECT b.id, b.user_id, u.username, b.ip, b.reason,
            b.created_by, b.created_at, b.expires_at
       FROM bans b
  LEFT JOIN users u ON u.id = b.user_id
      WHERE b.expires_at IS NULL OR b.expires_at > now()
   ORDER BY b.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

// ตรวจว่าคนนี้โดนรายงานถึงเกณฑ์แล้วหรือยัง ถ้าใช่ให้แบนอัตโนมัติ
//
// นับเฉพาะ "ผู้รายงานที่ไม่ซ้ำกัน" เพื่อไม่ให้คนคนเดียวกดรายงานรัวๆ แล้วแบนคนอื่นได้
// (นับรวม reporter ที่ไม่ login ด้วยโดยใช้ session id เป็นตัวแทน)
export async function checkAutoBan(reportedUserId: number): Promise<boolean> {
  try {
    const result = await db.query(
      `SELECT COUNT(DISTINCT COALESCE(reporter_user_id::text, reporter_session)) AS reporters
         FROM reports
        WHERE reported_user_id = $1
          AND created_at > now() - INTERVAL '30 days'`,
      [reportedUserId],
    );
    const reporters = Number(result.rows[0]?.reporters ?? 0);
    if (reporters < env.AUTO_BAN_REPORT_THRESHOLD) return false;

    // แบนอยู่แล้วก็ไม่ต้องซ้ำ
    if (cache.userIds.has(reportedUserId)) return false;

    await createBan({
      userId: reportedUserId,
      ip: null,
      reason: `ถูกรายงานโดยผู้ใช้ ${reporters} คนภายใน 30 วัน`,
      createdBy: "system",
      hours: env.AUTO_BAN_HOURS,
    });
    console.warn(
      `[moderation] auto-banned user ${reportedUserId} (${reporters} reporters)`,
    );
    return true;
  } catch (err) {
    console.error("[moderation.checkAutoBan] error:", err);
    return false;
  }
}

// รายการ report สำหรับให้แอดมินตรวจ
export async function listReports(status = "pending", limit = 100) {
  const result = await db.query(
    `SELECT r.id, r.reporter_user_id, r.reported_user_id, u.username AS reported_username,
            r.reported_nickname, r.reason, r.context_snippet, r.status, r.created_at
       FROM reports r
  LEFT JOIN users u ON u.id = r.reported_user_id
      WHERE r.status = $1
   ORDER BY r.created_at DESC
      LIMIT $2`,
    [status, limit],
  );
  return result.rows;
}

export async function setReportStatus(
  reportId: number,
  status: string,
): Promise<boolean> {
  const result = await db.query(
    "UPDATE reports SET status = $2 WHERE id = $1",
    [reportId, status],
  );
  return (result.rowCount ?? 0) > 0;
}
