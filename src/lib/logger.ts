// src/lib/logger.ts
// logger แบบมีระดับความสำคัญ
//
// ทำไมต้องมี: เดิม log ทุก connect / ทุกการจับคู่ / ทุกการเข้าคิว ด้วย console.log
// การเขียน stdout เป็นการเขียนแบบ synchronous — พอมีผู้ใช้เยอะ log พวกนี้จะกลาย
// เป็นคอขวดจริงบน event loop เดียวกับ WebSocket ตั้ง LOG_LEVEL=info ใน production
// เพื่อปิด log ระดับต่อ-connection ทิ้งไป โดยยังเห็น warn/error ครบ

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

function parseLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? "").toLowerCase();
  return value in LEVELS ? (value as LogLevel) : "info";
}

// อ่าน env ตรงๆ ไม่ผ่าน config/env.ts เพื่อเลี่ยง import วนกัน
const threshold = LEVELS[parseLevel(process.env.LOG_LEVEL)];

const emit =
  (level: LogLevel, sink: (...args: unknown[]) => void) =>
  (...args: unknown[]) => {
    if (LEVELS[level] < threshold) return;
    sink(...args);
  };

export const log = {
  debug: emit("debug", console.log),
  info: emit("info", console.log),
  warn: emit("warn", console.warn),
  error: emit("error", console.error),
};
