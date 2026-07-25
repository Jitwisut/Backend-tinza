// src/lib/metrics.ts
// ตัวนับสำหรับ /metrics (รูปแบบข้อความของ Prometheus)
//
// ทำไมต้องมี: เดิมมีแค่ /health ที่บอก online กับ waiting เท่านั้น พอระบบมีปัญหา
// จะไม่มีทางรู้เลยว่าคิวยาวขึ้นตอนไหน จับคู่ช้าลงเพราะอะไร หรือมีคนโดน rate limit
// เยอะผิดปกติหรือเปล่า — ข้อมูลพวกนี้ต้องเก็บไว้ "ก่อน" จะเกิดปัญหา

const counters = new Map<string, number>();

export function inc(name: string, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

// วัดเวลาที่ใช้จับคู่ เก็บเป็น histogram อย่างง่าย (นับตามช่วง)
const MATCH_WAIT_BUCKETS_MS = [100, 500, 1000, 5000, 15000, 60000];
const matchWaitBuckets = new Array(MATCH_WAIT_BUCKETS_MS.length + 1).fill(0);
let matchWaitSum = 0;
let matchWaitCount = 0;

export function observeMatchWait(ms: number) {
  matchWaitSum += ms;
  matchWaitCount++;
  const idx = MATCH_WAIT_BUCKETS_MS.findIndex((b) => ms <= b);
  matchWaitBuckets[idx === -1 ? MATCH_WAIT_BUCKETS_MS.length : idx]++;
}

type Gauges = Record<string, number>;

// สร้างข้อความรูปแบบ Prometheus — gauge ส่งเข้ามาสดๆ ตอนเรียกเพราะเป็นค่าปัจจุบัน
export function renderMetrics(gauges: Gauges): string {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(gauges)) {
    lines.push(`# TYPE tinza_${name} gauge`);
    lines.push(`tinza_${name} ${value}`);
  }

  for (const [name, value] of counters) {
    lines.push(`# TYPE tinza_${name} counter`);
    lines.push(`tinza_${name} ${value}`);
  }

  lines.push("# TYPE tinza_match_wait_ms histogram");
  let cumulative = 0;
  for (let i = 0; i < MATCH_WAIT_BUCKETS_MS.length; i++) {
    cumulative += matchWaitBuckets[i];
    lines.push(`tinza_match_wait_ms_bucket{le="${MATCH_WAIT_BUCKETS_MS[i]}"} ${cumulative}`);
  }
  cumulative += matchWaitBuckets[MATCH_WAIT_BUCKETS_MS.length];
  lines.push(`tinza_match_wait_ms_bucket{le="+Inf"} ${cumulative}`);
  lines.push(`tinza_match_wait_ms_sum ${matchWaitSum}`);
  lines.push(`tinza_match_wait_ms_count ${matchWaitCount}`);

  return lines.join("\n") + "\n";
}
