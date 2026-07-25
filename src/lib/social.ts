// src/lib/social.ts
// บันทึก like / ประวัติการคุย ลง DB (เฉพาะคู่ที่ login) — เรียกจาก WS layer
import { db } from "./connectdb";

// บันทึก like จาก → ถึง, คืน true ถ้าเป็น mutual (อีกฝ่ายเคยกดถูกใจเราแล้ว = เพื่อนกัน)
export async function recordLike(
  fromUserId: number,
  toUserId: number,
): Promise<boolean> {
  if (fromUserId === toUserId) return false;
  try {
    // รวม insert กับการเช็ค mutual ไว้ใน round-trip เดียว (เดิมยิง 2 query)
    // การเช็คมองทิศทางตรงข้าม (to → from) ซึ่งไม่ได้รับผลจาก insert ของเราเอง
    // ผลลัพธ์จึงถูกต้องแม้ CTE จะเห็น snapshot ก่อน insert
    const result = await db.query(
      `WITH inserted AS (
         INSERT INTO likes (from_user_id, to_user_id)
         VALUES ($1, $2)
         ON CONFLICT (from_user_id, to_user_id) DO NOTHING
       )
       SELECT EXISTS (
         SELECT 1 FROM likes WHERE from_user_id = $2 AND to_user_id = $1
       ) AS mutual`,
      [fromUserId, toUserId],
    );
    return result.rows[0]?.mutual === true;
  } catch (err) {
    console.error("[social.recordLike] error:", err);
    return false;
  }
}

// เริ่มบันทึกประวัติการคุย → คืน call id ไว้ปิดตอนจบ (null ถ้าบันทึกไม่ได้)
export async function startCall(
  userId: number,
  peerUserId: number | null,
): Promise<number | null> {
  try {
    const result = await db.query(
      "INSERT INTO calls (user_id, peer_user_id) VALUES ($1, $2) RETURNING id",
      [userId, peerUserId],
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    console.error("[social.startCall] error:", err);
    return null;
  }
}

// ปิดประวัติการคุย (stamp ended_at)
export async function endCall(callId: number): Promise<void> {
  try {
    await db.query("UPDATE calls SET ended_at = now() WHERE id = $1 AND ended_at IS NULL", [
      callId,
    ]);
  } catch (err) {
    console.error("[social.endCall] error:", err);
  }
}

// ปิดแถว calls ที่ค้างจากการที่เซิร์ฟเวอร์ดับกลางสาย
// สถานะการคุยอยู่ใน memory ล้วน ดังนั้นตอน boot ไม่มีสายไหน active จริง —
// แถวที่ ended_at ยังว่างคือของค้างทั้งหมด ปิดด้วย started_at เพื่อสื่อว่าไม่รู้ความยาวสาย
export async function closeOrphanedCalls(): Promise<number> {
  try {
    const result = await db.query(
      "UPDATE calls SET ended_at = started_at WHERE ended_at IS NULL",
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.error("[social.closeOrphanedCalls] error:", err);
    return 0;
  }
}

// ลบข้อมูลเก่าตามนโยบาย retention — ตาราง calls โตเร็วมาก (2 แถวต่อการจับคู่ 1 ครั้ง)
// ถ้าไม่ลบเลย ขนาดตารางจะกลายเป็นปัญหาเองเมื่อคนเยอะขึ้น
export async function pruneOldRecords(
  callDays: number,
  reportDays: number,
): Promise<{ calls: number; reports: number }> {
  const out = { calls: 0, reports: 0 };
  try {
    const calls = await db.query(
      `DELETE FROM calls WHERE started_at < now() - ($1::numeric * INTERVAL '1 day')`,
      [callDays],
    );
    out.calls = calls.rowCount ?? 0;
  } catch (err) {
    console.error("[social.pruneOldRecords] calls error:", err);
  }
  try {
    // เก็บ report ที่ยังไม่ได้ตรวจไว้เสมอ ไม่ว่าจะเก่าแค่ไหน
    const reports = await db.query(
      `DELETE FROM reports
        WHERE created_at < now() - ($1::numeric * INTERVAL '1 day')
          AND status <> 'pending'`,
      [reportDays],
    );
    out.reports = reports.rowCount ?? 0;
  } catch (err) {
    console.error("[social.pruneOldRecords] reports error:", err);
  }
  return out;
}

// บันทึก report ลง DB
// เก็บ reported_user_id ด้วย (ถ้าผู้ถูกรายงาน login อยู่) เพื่อให้ auto-ban นับยอดได้
export async function recordReport(input: {
  reporterUserId: number | null;
  reporterSession: string;
  reportedUserId: number | null;
  reportedNickname: string | null;
  reportedSession: string | null;
  reason: string;
  contextSnippet: string | null;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO reports
         (reporter_user_id, reporter_session, reported_user_id,
          reported_nickname, reported_session, reason, context_snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.reporterUserId,
        input.reporterSession,
        input.reportedUserId,
        input.reportedNickname,
        input.reportedSession,
        input.reason,
        input.contextSnippet,
      ],
    );
  } catch (err) {
    console.error("[social.recordReport] error:", err);
  }
}
