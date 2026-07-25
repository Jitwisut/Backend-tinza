// src/lib/profanity.ts
// กรองคำหยาบเบื้องต้น (ไทย + อังกฤษ) ก่อน relay chat
//
// หมายเหตุ: นี่คือ best-effort filter กันคำหยาบตรงๆ เท่านั้น ไม่ใช่ระบบ moderation สมบูรณ์
// (เลี่ยงด้วยเว้นวรรค/อักขระแทรกได้) — ใช้คู่กับ report + rate limit เพื่อความครบถ้วน
// ตั้งใจไม่ใส่คำหยาบเต็มๆ ในซอร์ส ใช้ pattern แบบยืดหยุ่นแทน

// pattern แต่ละตัวเผื่ออักขระซ้ำ/แทรกเล็กน้อย (เช่น "fuuuck", "f-u-c-k")
const PATTERNS: RegExp[] = [
  // อังกฤษ
  /f+\W*u+\W*c+\W*k+/i,
  /s+\W*h+\W*i+\W*t+/i,
  /b+\W*i+\W*t+\W*c+\W*h+/i,
  /a+\W*s+\W*s+\W*h+\W*o+\W*l+\W*e+/i,
  /c+\W*u+\W*n+\W*t+/i,
  /d+\W*i+\W*c+\W*k+\b/i,
  // ไทย (คำหยาบที่พบบ่อย)
  /เหี้ย|เหี้ ย/,
  /สัส|สัด|ส*ัส/,
  /ควย/,
  /หี/,
  /เย็ด/,
  /แม่ง|มึง.*สัส/,
  /ไอ้สัตว์|ไอ้เวร|ไอ้ควาย/,
];

// คืน true ถ้าพบคำหยาบ
export function hasProfanity(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}

// แทนคำหยาบด้วย * (คงความยาวเดิมไว้ให้พออ่านบริบทออก)
export function maskProfanity(text: string): string {
  let result = text;
  for (const re of PATTERNS) {
    // ทำให้ global เพื่อแทนทุกตำแหน่ง
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    result = result.replace(g, (match) => "*".repeat(match.length));
  }
  return result;
}
