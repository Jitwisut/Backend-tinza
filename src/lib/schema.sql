-- รัน schema นี้กับฐานข้อมูล tinza ก่อนใช้งานครั้งแรก
-- เช่น: psql "$DATABASE_URL" -f src/lib/schema.sql
-- ปลอดภัยกับการรันซ้ำ (idempotent) — ใช้ IF NOT EXISTS / ADD COLUMN IF NOT EXISTS

-- =====================================================================
-- users — บัญชีผู้ใช้ (login ได้ ปลดล็อก like ถาวร/profile/ประวัติ)
-- anonymous ไม่มีแถวในตารางนี้ (ต่อ WS โดยไม่มี token ได้)
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username   VARCHAR(32) NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 3: ขยาย profile (เพิ่มทีละคอลัมน์ ปลอดภัยกับ DB ที่มีข้อมูลแล้ว)
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(48);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio          VARCHAR(300);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_seed  VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender       VARCHAR(16);

-- =====================================================================
-- reports — รายงานพฤติกรรมไม่เหมาะสม (Phase 1)
-- reporter เก็บได้ทั้ง user id (ถ้า login) และ session id (anonymous)
-- =====================================================================
CREATE TABLE IF NOT EXISTS reports (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reporter_session  VARCHAR(64),               -- ws id ของผู้รายงาน (anonymous)
  reported_nickname VARCHAR(48),
  reported_session  VARCHAR(64),               -- ws id ของผู้ถูกรายงาน (ถ้ามี)
  reason            VARCHAR(32) NOT NULL,
  context_snippet   VARCHAR(500),              -- ข้อความ/บริบทตอนรายงาน
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ผูก report กับบัญชีของผู้ถูกรายงาน (ถ้าเขา login อยู่) เพื่อให้นับยอดแบนอัตโนมัติได้
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reported_user_id BIGINT
  REFERENCES users(id) ON DELETE SET NULL;
-- สถานะการตรวจสอบของแอดมิน: pending | reviewed | dismissed
ALTER TABLE reports ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports (created_at DESC);
-- คิวงานของแอดมิน (ดึงเฉพาะที่ยังไม่ตรวจ)
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at DESC);
-- ใช้ตอนนับยอด report เพื่อแบนอัตโนมัติ
CREATE INDEX IF NOT EXISTS idx_reports_reported_user
  ON reports (reported_user_id) WHERE reported_user_id IS NOT NULL;

-- =====================================================================
-- bans — รายชื่อผู้ถูกแบน (ค้างอยู่ข้ามการเชื่อมต่อ ต่างจาก block ที่หายเมื่อปิดแท็บ)
-- แบนได้ทั้งตาม user id (คนที่ login) และตาม IP (คนที่ไม่ login)
-- expires_at = NULL คือแบนถาวร
-- =====================================================================
CREATE TABLE IF NOT EXISTS bans (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
  ip         VARCHAR(64),
  reason     VARCHAR(200) NOT NULL,
  created_by VARCHAR(32) NOT NULL DEFAULT 'system',  -- 'system' = แบนอัตโนมัติ
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  -- ต้องระบุอย่างน้อยหนึ่งอย่างว่าแบนใคร
  CONSTRAINT bans_target_required CHECK (user_id IS NOT NULL OR ip IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_bans_user ON bans (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bans_ip   ON bans (ip)      WHERE ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bans_expires ON bans (expires_at);

-- =====================================================================
-- likes — การกดถูกใจ (Phase 3, เฉพาะ logged-in)
-- mutual like (A→B และ B→A) = เพื่อนกัน
-- =====================================================================
CREATE TABLE IF NOT EXISTS likes (
  from_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_user_id, to_user_id),
  CHECK (from_user_id <> to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_to_user ON likes (to_user_id);

-- view: เพื่อน = like กันทั้งสองทาง (คืนเป็นคู่ user_id, friend_id ทั้งสองทิศ)
CREATE OR REPLACE VIEW friends AS
SELECT l1.from_user_id AS user_id,
       l1.to_user_id   AS friend_id,
       GREATEST(l1.created_at, l2.created_at) AS since
FROM likes l1
JOIN likes l2
  ON l1.from_user_id = l2.to_user_id
 AND l1.to_user_id   = l2.from_user_id;

-- =====================================================================
-- calls — ประวัติการคุย (Phase 3, opt-in, เฉพาะคู่ที่ login ทั้งคู่)
-- =====================================================================
CREATE TABLE IF NOT EXISTS calls (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_calls_user ON calls (user_id, started_at DESC);
-- ใช้ตอนลบข้อมูลเก่าตาม retention (predicate เป็น started_at เดี่ยวๆ
-- ซึ่ง composite index ด้านบนช่วยไม่ได้)
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls (started_at);
-- ใช้ตอน boot เพื่อปิดสายที่ค้างจากการที่เซิร์ฟเวอร์ดับกลางทาง
CREATE INDEX IF NOT EXISTS idx_calls_open ON calls (id) WHERE ended_at IS NULL;
