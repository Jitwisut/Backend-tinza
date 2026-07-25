export {}; // ทำให้ไฟล์นี้เป็น module (top-level await)

// e2e.test.ts — ทดสอบเซิร์ฟเวอร์จริงผ่าน HTTP + WebSocket
// รัน: bun run e2e (ต้องมี Postgres อยู่ที่ DATABASE_URL ก่อน)
//
// จุดสำคัญที่ทดสอบคือ regression ของบั๊กคิวเตะคนทิ้ง ซึ่งเป็นบั๊กที่หา
// ด้วยตาเปล่ายาก และจะกลับมาได้ง่ายถ้ามีคนแก้ tryMatch ในอนาคต

const BASE = `http://localhost:${process.env.PORT ?? 4599}`;
const WS_URL = `ws://localhost:${process.env.PORT ?? 4599}/match`;
const ADMIN = process.env.ADMIN_TOKEN ?? "test-admin-token";

let pass = 0;
let fail = 0;
const results: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    results.push(`  PASS  ${name}`);
  } else {
    fail++;
    results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- client ห่อ WebSocket ให้รอข้อความตามชนิดได้ ---
class Client {
  ws: WebSocket;
  inbox: any[] = [];
  constructor(public name: string) {
    this.ws = new WebSocket(WS_URL);
    this.ws.onmessage = (e) => {
      try {
        this.inbox.push(JSON.parse(String(e.data)));
      } catch {}
    };
  }
  ready() {
    return new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === 1) return resolve();
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`${this.name} failed to connect`));
      setTimeout(() => reject(new Error(`${this.name} connect timeout`)), 3000);
    });
  }
  send(obj: any) {
    this.ws.send(JSON.stringify(obj));
  }
  // รอข้อความชนิดที่ต้องการ (คืน undefined ถ้าไม่มาภายในเวลา)
  async wait(type: string, ms = 2500): Promise<any | undefined> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = this.inbox.find((m) => m.type === type);
      if (found) return found;
      await sleep(25);
    }
    return undefined;
  }
  types() {
    return this.inbox.map((m) => m.type);
  }
  clear() {
    this.inbox = [];
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const openClient = async (name: string) => {
  const c = new Client(name);
  await c.ready();
  return c;
};

console.log("\n=== E2E: Backend Tinza ===\n");

// ---------------------------------------------------------------- HTTP
const health = await fetch(`${BASE}/health`).then((r) => r.json());
check("GET /health ตอบ ok", health.status === "ok");

const metricsRes = await fetch(`${BASE}/metrics`);
const metricsText = await metricsRes.text();
check(
  "GET /metrics คืนรูปแบบ Prometheus",
  metricsRes.ok && metricsText.includes("tinza_online_users"),
);
check(
  "/metrics มี histogram เวลารอคิว",
  metricsText.includes("tinza_match_wait_ms_bucket"),
);

// ---------------------------------------------------------------- auth
const uniq = Date.now().toString(36);
const userA = { username: `a_${uniq}`, password: "password12345" };
const userB = { username: `b_${uniq}`, password: "password12345" };

const post = (path: string, body: any, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const signupA = await post("/auth/signup", userA);
check("POST /auth/signup สำเร็จ (Bun.password)", signupA.status === 201);

const signinA = await post("/auth/signin", userA);
const signinAJson: any = await signinA.json();
check("POST /auth/signin ได้ token", signinA.ok && !!signinAJson.token);

const badSignin = await post("/auth/signin", {
  username: userA.username,
  password: "wrong-password-here",
});
check("รหัสผิดตอบ 401", badSignin.status === 401);

await post("/auth/signup", userB);
const signinB: any = await post("/auth/signin", userB).then((r) => r.json());

// verify ว่า hash เก่าที่ bcryptjs สร้างไว้ยัง login ผ่าน (backward compatibility)
const legacyUser = `legacy_${uniq}`;
// $2b$10$ hash ของคำว่า "password12345" ที่สร้างด้วย bcryptjs
const legacyHash = await Bun.password.hash("password12345", {
  algorithm: "bcrypt",
  cost: 10,
});
await Bun.$`docker exec tinza-postgres psql -U postgres -d tinza -c ${`INSERT INTO users (username, password) VALUES ('${legacyUser}', '${legacyHash}')`}`.quiet();
const legacySignin = await post("/auth/signin", {
  username: legacyUser,
  password: "password12345",
});
check("hash รูปแบบ bcrypt เดิม login ผ่าน (ไม่ต้อง migrate)", legacySignin.ok);

// ---------------------------------------------------------------- ICE
const ice: any = await fetch(`${BASE}/ice`).then((r) => r.json());
check("GET /ice คืน iceServers", Array.isArray(ice.iceServers));
check("TURN_TTL default สั้นลงเหลือ 600 วินาที", ice.ttl === 600, `ttl=${ice.ttl}`);

// ---------------------------------------------------------------- admin
const adminNoToken = await fetch(`${BASE}/admin/reports`);
check("/admin ไม่มี token ตอบ 401", adminNoToken.status === 401);

const adminBadToken = await fetch(`${BASE}/admin/reports`, {
  headers: { "x-admin-token": "wrong" },
});
check("/admin token ผิดตอบ 401", adminBadToken.status === 401);

const adminOk = await fetch(`${BASE}/admin/reports`, {
  headers: { "x-admin-token": ADMIN },
});
check("/admin token ถูกเข้าได้", adminOk.ok);

// ---------------------------------------------------------------- matching
const a = await openClient("A");
const b = await openClient("B");
a.send({ type: "find_partner", nickname: "A" });
await sleep(150);
b.send({ type: "find_partner", nickname: "B" });

const aMatched = await a.wait("matched");
const bMatched = await b.wait("matched");
check("จับคู่ผู้ใช้ 2 คนสำเร็จ", !!aMatched && !!bMatched);
check(
  "ฝั่งเดียวเท่านั้นที่เป็น initiator",
  !!aMatched && !!bMatched && aMatched.initiator !== bMatched.initiator,
);

// chat relay + กรองคำหยาบ
a.send({ type: "chat", text: "สวัสดี shit นะ" });
const chat = await b.wait("chat");
check("chat ส่งถึงคู่สนทนา", !!chat);
check("กรองคำหยาบก่อนส่งต่อ", !!chat && !chat.text.includes("shit"), chat?.text);
check("server ประทับชื่อผู้ส่งเอง (กันปลอม)", chat?.from === "A");

// ---------------------------------------------------- REGRESSION: คิวเตะคนทิ้ง
// สถานการณ์: A บล็อก B แล้ว A กลับเข้าคิว จากนั้น B หาคู่ใหม่
// โค้ดเดิม B จะ dequeue A ออกมา พบว่า block กันอยู่ แล้วทิ้ง A ไปเลย
// ทำให้ A ค้างสถานะ "waiting" ตลอดกาล — C ที่เข้ามาทีหลังจะไม่มีวันเจอ A
a.clear();
b.clear();
a.send({ type: "block" });
await sleep(300);
check("B ได้รับแจ้งว่าคู่สนทนาหลุด", !!(await b.wait("partner_disconnected")));

await sleep(2100); // รอพ้น cooldown 2 วินาที
b.clear();
b.send({ type: "find_partner", nickname: "B" });
await sleep(400);

const c = await openClient("C");
c.send({ type: "find_partner", nickname: "C" });
const cMatched = await c.wait("matched");
const aRematched = await a.wait("matched", 2500);

check("C หาคู่ได้", !!cMatched, `C ได้รับ: ${c.types().join(",")}`);
check(
  "REGRESSION: A ที่ถูกข้ามเพราะ block ยังอยู่ในคิวและได้คู่ใหม่",
  !!aRematched,
  `A ได้รับ: ${a.types().join(",")} (โค้ดเดิม A จะค้าง waiting ตลอดไป)`,
);
check(
  "C จับคู่กับ A ตามลำดับคิว (ไม่ใช่ B ที่เข้าคิวทีหลัง)",
  cMatched?.partnerNickname === "A",
  `C จับคู่กับ ${cMatched?.partnerNickname}`,
);

a.close();
b.close();
c.close();
await sleep(200);

// ---------------------------------------------------------------- cooldown
const d = await openClient("D");
d.send({ type: "find_partner", nickname: "D" });
await sleep(200);
d.clear();
d.send({ type: "next" });
const cooldown = await d.wait("cooldown", 800);
check("กด next เร็วเกินไปได้รับ cooldown", !!cooldown);

// block ต้องติด cooldown เดียวกับ next (เดิมเลี่ยงได้ด้วยการส่ง block แทน)
d.clear();
d.send({ type: "block" });
const blockCooldown = await d.wait("cooldown", 800);
check("block ติด cooldown เดียวกับ next (ปิดช่องเลี่ยง)", !!blockCooldown);
d.close();

// ---------------------------------------------------------- payload cap
const e = await openClient("E");
let closedCode = 0;
e.ws.onclose = (ev) => (closedCode = ev.code);
e.send({ type: "chat", text: "x".repeat(20000) }); // เกิน 16KB
await sleep(500);
check("ข้อความใหญ่เกิน maxPayloadLength ถูกตัดการเชื่อมต่อ", e.ws.readyState === 3);
e.close();

// ------------------------------------------------- เพดาน connection ต่อ IP
// origin check ปล่อยผ่าน client ที่ไม่ส่ง Origin (native app) โดยตั้งใจ
// เพดานนี้จึงเป็นด่านหลักที่กันการเปิด connection รัวๆ — ต้องมีเทสต์
const CAP = Number(process.env.WS_MAX_CONN_PER_IP ?? 0);
if (CAP > 0 && CAP <= 6) {
  const held: Client[] = [];
  for (let i = 0; i < CAP; i++) held.push(await openClient(`cap${i}`));
  await sleep(200);

  const over = new Client("over");
  await sleep(400);
  const rejected = over.inbox.find((m) => m.reason === "too_many_connections");
  check(`เกินโควตา ${CAP} connection ต่อ IP ถูกปฏิเสธ`, !!rejected);

  // ปิดไป 1 ตัวแล้วต้องเปิดใหม่ได้ — พิสูจน์ว่า releaseIp() ไม่นับค้าง
  held[0]!.close();
  over.close();
  await sleep(400);
  const reopened = new Client("reopened");
  await sleep(400);
  const stillRejected = reopened.inbox.find(
    (m) => m.reason === "too_many_connections",
  );
  check("ปิด connection แล้วเปิดใหม่ได้ (ตัวนับไม่รั่ว)", !stillRejected);

  reopened.close();
  for (const h of held) h.close();
  await sleep(200);
} else {
  results.push(
    `  SKIP  เพดาน connection ต่อ IP (ตั้ง WS_MAX_CONN_PER_IP=3 เพื่อทดสอบ)`,
  );
}

// ---------------------------------------------------------------- ban
const banRes = await post(
  "/admin/bans",
  { userId: signinB.user.id, reason: "ทดสอบระบบแบน", hours: 1 },
  { "x-admin-token": ADMIN },
);
const banJson: any = await banRes.json();
check("แอดมินสร้างแบนได้", banRes.status === 201 && !!banJson.id);

const bannedClient = await openClient("Banned");
bannedClient.send({ type: "find_partner", nickname: "B", token: signinB.token });
const bannedMsg = await bannedClient.wait("banned", 1500);
check("ผู้ใช้ที่ถูกแบนถูกปฏิเสธตอนหาคู่", !!bannedMsg);
bannedClient.close();

const bannedSignin = await post("/auth/signin", userB);
check("บัญชีที่ถูกแบน login ไม่ได้ (403)", bannedSignin.status === 403);

const liftRes = await fetch(`${BASE}/admin/bans/${banJson.id}`, {
  method: "DELETE",
  headers: { "x-admin-token": ADMIN },
});
check("แอดมินปลดแบนได้", liftRes.ok);

const afterLift = await post("/auth/signin", userB);
check("ปลดแบนแล้ว login ได้ตามเดิม", afterLift.ok);

// ---------------------------------------------------------------- summary
console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
