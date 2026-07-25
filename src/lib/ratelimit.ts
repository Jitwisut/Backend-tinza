// src/lib/ratelimit.ts
// Rate limiter แบบ in-memory ต่อ key (ใช้ IP เป็น key)
// ใช้กัน spam: กด next รัวๆ, ส่ง chat ถี่เกินไป, ยิง signaling ถล่มเซิร์ฟเวอร์
//
// 2 รูปแบบ:
//   - cooldown: ห้ามทำซ้ำเร็วกว่า X ms (เหมาะกับ next)
//   - token bucket: อนุญาต burst ได้ N ครั้ง แล้วเติมคืนตามเวลา (เหมาะกับ chat/signaling)
//
// ทำไมต้องมี sweep(): เดิม key คือ ws.id แล้วลบทิ้งตอน disconnect ซึ่งทำให้
// เลี่ยง limit ได้ด้วยการต่อใหม่ พอเปลี่ยนมาใช้ IP เป็น key แล้ว การ disconnect
// ไม่ได้แปลว่า key นั้นตายแล้ว (IP เดิมอาจกลับมาอีก) จึงลบตอน disconnect ไม่ได้
// ถ้าไม่มีอะไรมาเก็บกวาด map จะโตไปเรื่อยๆ ตามจำนวน IP ที่เคยเข้ามาทั้งหมด

export interface Sweepable {
  // ลบ entry ที่ไม่มีผลต่อการตัดสินใจแล้ว คืนจำนวนที่ลบไป
  sweep(): number;
  readonly size: number;
}

// --- Cooldown: true = ผ่าน, false = เร็วเกินไป ---
export class Cooldown implements Sweepable {
  private last = new Map<string, number>();
  constructor(private intervalMs: number) {}

  get size() {
    return this.last.size;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const prev = this.last.get(key) ?? 0;
    if (now - prev < this.intervalMs) return false;
    this.last.set(key, now);
    return true;
  }

  clear(key: string) {
    this.last.delete(key);
  }

  // entry ที่พ้น cooldown แล้วให้ผลเหมือนกับไม่มี entry เลย → ลบทิ้งได้
  sweep(): number {
    const cutoff = Date.now() - this.intervalMs;
    let removed = 0;
    for (const [key, at] of this.last) {
      if (at <= cutoff) {
        this.last.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

// --- Token bucket: allow() คืน true จนกว่า token หมดในหน้าต่างเวลา ---
export class TokenBucket implements Sweepable {
  private state = new Map<string, { tokens: number; updatedAt: number }>();

  // capacity = จำนวน token เต็มถัง, refillPerSec = เติมกี่ token ต่อวินาที
  constructor(
    private capacity: number,
    private refillPerSec: number,
  ) {}

  get size() {
    return this.state.size;
  }

  allow(key: string, cost = 1): boolean {
    const now = Date.now();
    const entry = this.state.get(key) ?? { tokens: this.capacity, updatedAt: now };

    // เติม token ตามเวลาที่ผ่านไป
    const elapsedSec = (now - entry.updatedAt) / 1000;
    entry.tokens = Math.min(this.capacity, entry.tokens + elapsedSec * this.refillPerSec);
    entry.updatedAt = now;

    if (entry.tokens < cost) {
      this.state.set(key, entry);
      return false;
    }

    entry.tokens -= cost;
    this.state.set(key, entry);
    return true;
  }

  clear(key: string) {
    this.state.delete(key);
  }

  // ถังที่เติมจนเต็มแล้วให้ผลเหมือนกับไม่มี entry เลย → ลบทิ้งได้
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.state) {
      const elapsedSec = (now - entry.updatedAt) / 1000;
      if (entry.tokens + elapsedSec * this.refillPerSec >= this.capacity) {
        this.state.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

// เก็บกวาด limiter ทุกตัวตามรอบ คืน timer ไว้ clearInterval ตอน shutdown
export function startSweeper(
  limiters: Sweepable[],
  intervalMs = 60_000,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    for (const limiter of limiters) limiter.sweep();
  }, intervalMs);
  // อย่าให้ timer นี้กันไม่ให้ process ปิดตัว
  timer.unref?.();
  return timer;
}
