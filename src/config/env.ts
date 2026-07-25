// src/config/env.ts
// รวมการอ่านและตรวจสอบ environment variables ไว้ที่เดียว
// ถ้าตัวแปรสำคัญหาย จะ throw ตั้งแต่ตอน boot (fail fast) แทนที่จะพังกลางทาง

function required(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(`[env] Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.trim() !== "" ? value : fallback;
}

const NODE_ENV = optional("NODE_ENV", "development");
const isProd = NODE_ENV === "production";

export const env = {
  NODE_ENV,
  isProd,
  PORT: Number(optional("PORT", "4000")),

  // ใช้ DATABASE_URL ถ้ามี (เช่นบน Railway/Render/Fly) ไม่งั้น fallback เป็นค่ารายตัว
  DATABASE_URL: process.env.DATABASE_URL,
  DB_HOST: optional("DB_HOST", "localhost"),
  DB_PORT: Number(optional("DB_PORT", "5432")),
  DB_USER: optional("DB_USER", "postgres"),
  DB_PASSWORD: optional("DB_PASSWORD", process.env.DB_Password ?? ""),
  DB_NAME: optional("DB_NAME", "tinza"),

  // JWT secret ต้องมีจริงใน production (ห้าม hardcode)
  JWT_SECRET: isProd
    ? required("JWT_SECRET")
    : optional("JWT_SECRET", "dev-only-insecure-secret-change-me"),
  JWT_EXPIRES_IN: optional("JWT_EXPIRES_IN", "7d"),

  // rounds สำหรับ bcrypt — 10-12 คือช่วงที่ปลอดภัยและเร็วพอ (20 ช้าเกินจนใช้งานจริงไม่ได้)
  BCRYPT_ROUNDS: Number(optional("BCRYPT_ROUNDS", "12")),

  // รายชื่อ origin ที่อนุญาต คั่นด้วย comma เช่น "https://app.com,https://www.app.com"
  // "*" = อนุญาตทุก origin (เหมาะกับ dev เท่านั้น)
  CORS_ORIGINS: optional("CORS_ORIGINS", "*"),

  // --- TURN (coturn REST API) สำหรับออก credential ชั่วคราวผ่าน GET /ice ---
  // TURN_URLS: รายการ turn:/turns: คั่นด้วย comma
  // TURN_SECRET: shared secret ที่ตั้งตรงกับ coturn (static-auth-secret)
  // TURN_TTL: อายุ credential เป็นวินาที (default 10 นาที)
  //   ยิ่งสั้นยิ่งจำกัดความเสียหายถ้า credential รั่ว — client ขอใหม่ได้เรื่อยๆ
  //   ค่าเดิม 1 ชั่วโมงหมายความว่า credential ที่หลุดไปใช้ relay ฟรีได้ทั้งชั่วโมง
  // ถ้าไม่ตั้ง TURN_SECRET → /ice จะคืนเฉพาะ STUN (ไม่มี TURN)
  TURN_URLS: optional("TURN_URLS", ""),
  TURN_SECRET: process.env.TURN_SECRET ?? "",
  TURN_TTL: Number(optional("TURN_TTL", "600")),
  STUN_URLS: optional(
    "STUN_URLS",
    "stun:stun.l.google.com:19302,stun:stun.relay.metered.ca:80",
  ),

  // --- Matching ---
  // ช่วงเวลาที่อนุญาตให้ทั้งคู่กด reconnect กลับมาเจอกัน (ms)
  RECONNECT_WINDOW_MS: Number(optional("RECONNECT_WINDOW_MS", "30000")),

  // --- Proxy ---
  // เปิดเมื่อ deploy หลัง reverse proxy (Railway/Fly/Render/nginx) เพื่อให้อ่าน IP จริง
  // จาก X-Forwarded-For ได้ ห้ามเปิดถ้าเซิร์ฟเวอร์รับ request ตรงจากอินเทอร์เน็ต
  // เพราะ client ปลอม header นี้เพื่อเลี่ยง rate limit ได้
  TRUST_PROXY: optional("TRUST_PROXY", "false") === "true",

  // --- WebSocket limits ---
  // ขนาดข้อความสูงสุด (bytes) — default ของ Bun คือ 16MB ซึ่งกว้างเกินไปมาก
  // ข้อความ signaling ที่ใหญ่ที่สุด (SDP offer) ยังไม่ถึง 8KB
  WS_MAX_PAYLOAD_BYTES: Number(optional("WS_MAX_PAYLOAD_BYTES", "16384")),
  // ตัดการเชื่อมต่อที่เงียบเกินกี่วินาที (Bun ส่ง ping ให้อัตโนมัติอยู่แล้ว)
  // default ของ Bun คือ 120 วินาที ซึ่งนานเกินไปสำหรับคิวจับคู่
  WS_IDLE_TIMEOUT_SEC: Number(optional("WS_IDLE_TIMEOUT_SEC", "60")),
  // จำนวน connection สูงสุดต่อ 1 IP (0 = ไม่จำกัด)
  WS_MAX_CONN_PER_IP: Number(optional("WS_MAX_CONN_PER_IP", "20")),

  // --- Database pool ---
  DB_POOL_MAX: Number(optional("DB_POOL_MAX", "20")),

  // --- Retention ---
  // ตาราง calls โต 2 แถวต่อการจับคู่ 1 ครั้ง ถ้าไม่ลบจะกลายเป็นปัญหาเอง
  CALL_RETENTION_DAYS: Number(optional("CALL_RETENTION_DAYS", "90")),
  // report ที่ยังไม่ได้ตรวจจะไม่ถูกลบ ไม่ว่าจะเก่าแค่ไหน
  REPORT_RETENTION_DAYS: Number(optional("REPORT_RETENTION_DAYS", "365")),

  // --- Moderation ---
  // จำนวน report ที่ทำให้ถูกแบนอัตโนมัติ (นับจากผู้รายงานที่ไม่ซ้ำกัน)
  AUTO_BAN_REPORT_THRESHOLD: Number(optional("AUTO_BAN_REPORT_THRESHOLD", "5")),
  // ระยะเวลาแบนอัตโนมัติ (ชั่วโมง)
  AUTO_BAN_HOURS: Number(optional("AUTO_BAN_HOURS", "72")),
  // token สำหรับเรียก /admin/* (ถ้าไม่ตั้ง = ปิดใช้งาน endpoint ทั้งหมด)
  ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? "",
};

export const corsOrigins =
  env.CORS_ORIGINS === "*"
    ? true
    : env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
