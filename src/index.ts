// src/index.ts
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { Auth } from "./router/user";
import { env, corsOrigins } from "./config/env";
import { closeDb } from "./lib/connectdb";
import { maskProfanity } from "./lib/profanity";
import { Cooldown, TokenBucket, startSweeper } from "./lib/ratelimit";
import { verifyJwt } from "./lib/jwt";
import {
  endCall,
  recordLike,
  recordReport,
  startCall,
  closeOrphanedCalls,
  pruneOldRecords,
} from "./lib/social";
import { Me } from "./router/me";
import { Ice } from "./router/ice";
import { clientIp } from "./lib/clientip";
import { Admin } from "./router/admin";
import { isBanned, refreshBanCache, checkAutoBan, banCacheStats } from "./lib/moderation";
import { log } from "./lib/logger";
import { inc, observeMatchWait, renderMetrics } from "./lib/metrics";

// --- Types ---
type User = {
  id: string;
  ws: any;
  // IP ของ client — ใช้เป็น key ของ rate limit ที่รีเซ็ตไม่ได้ด้วยการต่อใหม่
  ip: string;
  nickname: string;
  partnerId: string | null;
  // Phase 3: ผูกกับบัญชีถ้า login (anonymous = null)
  userId: number | null;
  // Phase 2: interest tags ไว้จับคู่ตามความสนใจ
  tags: string[];
  // Phase 1: session ที่ user นี้ block ไว้ (จะไม่ถูกจับคู่ซ้ำ)
  blocked: Set<string>;
  // Phase 3: call history ปัจจุบันของ user นี้ (เฉพาะคู่ที่ login ทั้งคู่)
  activeCallId: number | null;
  // เวลาที่เข้าคิวรอบล่าสุด ใช้วัดว่ารอกี่มิลลิวินาทีถึงได้คู่ (null = ไม่ได้อยู่ในคิว)
  queuedAt: number | null;
};

type ReconnectRequest = {
  userId: number;
  peerUserId: number;
  wsId: string;
  expiresAt: number;
};

// --- O(1) Queue Structure ---
// Node สำหรับ Linked List
class QueueNode {
  userId: string;
  next: QueueNode | null = null;
  prev: QueueNode | null = null;
  constructor(userId: string) {
    this.userId = userId;
  }
}

// Queue ที่จัดการได้ใน O(1) ทั้งหมด
class MatchQueue {
  private head: QueueNode | null = null;
  private tail: QueueNode | null = null;
  // Map ช่วยให้หา Node เจอใน O(1) เพื่อลบคนกลางคิวตอน disconnect
  private nodes = new Map<string, QueueNode>();

  get size() {
    return this.nodes.size;
  }

  // O(1) - เพิ่มคนเข้าท้ายแถว
  enqueue(userId: string) {
    if (this.nodes.has(userId)) return; // ป้องกันการเข้าคิวซ้ำ

    const node = new QueueNode(userId);
    this.nodes.set(userId, node);

    if (!this.tail) {
      this.head = this.tail = node;
    } else {
      this.tail.next = node;
      node.prev = this.tail;
      this.tail = node;
    }
  }

  // O(1) - ดึงคนออกจากหัวแถว (จับคู่)
  dequeue(): string | null {
    if (!this.head) return null;

    const userId = this.head.userId;
    this.remove(userId); // ใช้ logic ลบเพื่อเคลียร์ pointer
    return userId;
  }

  // O(1) - ลบคนออกจากตำแหน่งใดก็ได้ (เช่น กด next หรือ disconnect)
  remove(userId: string) {
    const node = this.nodes.get(userId);
    if (!node) return;

    this.nodes.delete(userId);

    if (node === this.head) this.head = node.next;
    if (node === this.tail) this.tail = node.prev;

    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;

    // เคลียร์ reference เพื่อช่วย Garbage Collection
    node.next = null;
    node.prev = null;
  }

  has(userId: string): boolean {
    return this.nodes.has(userId);
  }

  // iterate ผู้ที่รออยู่ตามลำดับคิว
  // เก็บ next ไว้ก่อน yield เพราะผู้เรียกอาจ remove() node ปัจจุบันระหว่างวน
  // (remove จะ set node.next = null ทำให้การวนหยุดกลางคันแบบเงียบๆ)
  *keys(): IterableIterator<string> {
    let node = this.head;
    while (node) {
      const next = node.next;
      yield node.userId;
      node = next;
    }
  }
}

// --- State Management ---
const users = new Map<string, User>();
const waitingQueue = new MatchQueue();
const reconnectRequests = new Map<string, ReconnectRequest>();
// index ย้อนกลับ wsId → key ของ reconnectRequests
// เดิม removeReconnectRequestsForWs() วนทั้ง map และถูกเรียกแทบทุกเส้นทางของข้อความ
// (find_partner, next, leaveMatch และอีก 2 ครั้งใน commitMatch) = O(R) ต่อครั้ง
const reconnectKeysByWs = new Map<string, Set<string>>();
// จำนวน connection ที่เปิดค้างอยู่ต่อ IP — กันคนเดียวเปิดรัวๆ จนกิน memory/fd หมด
const connectionsPerIp = new Map<string, number>();

// ความยาวข้อความ chat สูงสุด (ตัดส่วนเกินทิ้ง กัน abuse)
const MAX_CHAT_LEN = 500;
const MAX_TAGS = 5;
// จำนวน session ที่ block ได้สูงสุดต่อการเชื่อมต่อ (กัน memory โตไม่จำกัด)
const MAX_BLOCKED = 200;
const NEXT_COOLDOWN_MS = 2000;

// --- Rate limiters (กัน spam) ---
//
// ใช้ 2 ชั้นเสมอ เพราะชั้นเดียวพังทั้งคู่:
//   - ต่อ session (ws.id) อย่างเดียว → แค่ปิดแล้วต่อใหม่ก็รีเซ็ตได้ทันที
//   - ต่อ IP อย่างเดียว → คนที่ใช้เน็ตร่วมกัน (ออฟฟิศ หอพัก มือถือหลัง CGNAT)
//     จะไปกองใน bucket เดียวกันแล้วบล็อกกันเอง ทั้งที่ไม่มีใครทำผิด
//
// ชั้น session ตั้งแคบไว้คุมจังหวะการใช้งานปกติ (เป็นเรื่อง UX)
// ชั้น IP ตั้งกว้างไว้เป็นเพดานกันการใช้ในทางที่ผิด — ผู้ใช้ปกติไม่มีทางชน

// ระดับ session
const nextCooldown = new Cooldown(NEXT_COOLDOWN_MS);
const chatBucket = new TokenBucket(10, 3);
const reportBucket = new TokenBucket(3, 0.1);
const likeBucket = new TokenBucket(10, 0.5);

// ระดับ IP — ตั้งค่าเผื่อ WS_MAX_CONN_PER_IP คนใช้พร้อมกันจาก IP เดียว
// เพดานรวมทุกข้อความ กัน flood ทุกชนิดรวมถึง offer/answer/ice/typing ที่เดิมไม่คุมเลย
// (กว้างพอสำหรับ trickle ICE ที่ยิง candidate รัวตอนเริ่มสาย)
// คำนวณจาก WS_MAX_CONN_PER_IP แทนการตั้งตัวเลขตายตัว — ไม่งั้นถ้าใครขยายโควตา
// connection ต่อ IP ขึ้น เพดานพวกนี้จะกลายเป็นคอขวดที่ทำให้ผู้ใช้ปกติโดนบล็อก
const CONN_PER_IP = env.WS_MAX_CONN_PER_IP > 0 ? env.WS_MAX_CONN_PER_IP : 20;

// ทุกข้อความรวมกัน: เผื่อ 10 ข้อความ/วินาที/คน (trickle ICE ยิงรัวช่วงเริ่มสาย)
const msgIpBucket = new TokenBucket(CONN_PER_IP * 30, CONN_PER_IP * 10);
// การกระทำที่ทำให้เกิดการจับคู่ใหม่ (find_partner/next/block/report)
// ผู้ใช้ปกติกดได้เร็วสุด 1 ครั้ง/2 วินาทีตาม cooldown — เผื่อไว้ 1 ครั้ง/วินาที/คน
// เพื่อให้ IP ที่ใช้เต็มโควตายังมีที่ว่างเหลือ ไม่ใช่นั่งพอดีเป๊ะที่เพดาน
const actionIpBucket = new TokenBucket(CONN_PER_IP * 6, CONN_PER_IP);
// การกระทำที่เขียน DB (report/like) — แพงที่สุด จึงคุมแยกและเข้มกว่า
const writeIpBucket = new TokenBucket(CONN_PER_IP * 2, CONN_PER_IP / 4);

const sweeperTimer = startSweeper([
  nextCooldown,
  chatBucket,
  reportBucket,
  likeBucket,
  msgIpBucket,
  actionIpBucket,
  writeIpBucket,
]);

// ต้องผ่านทั้ง 2 ชั้นถึงจะทำได้ — ชั้น session คุมจังหวะ ชั้น IP คุมปริมาณรวม
function allowAction(user: User): boolean {
  return nextCooldown.allow(user.id) && actionIpBucket.allow(user.ip);
}

// พาเข้าคิวรอ + แจ้ง client
// ทุกเส้นทางที่ทำให้ผู้ใช้ "ไม่มีคู่" ต้องจบด้วยฟังก์ชันนี้เสมอ ไม่งั้นจะเกิดสภาพ
// ค้างกลางอากาศ: ออกจากคู่แล้วแต่ไม่อยู่ในคิว ซึ่งไม่มีใครจับคู่ให้ได้อีกเลย
function enqueueWaiting(user: User) {
  waitingQueue.enqueue(user.id);
  user.queuedAt = Date.now();
  send(user.ws, { type: "waiting", message: "Searching for a partner..." });
  log.debug(`[Queue] ${user.nickname} added to queue.`);
}

// ทำความสะอาด interest tags: ตัวพิมพ์เล็ก, ตัดอักขระแปลก, จำกัดจำนวน/ความยาว
function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.toLowerCase().trim().replace(/[^a-z0-9ก-๙_-]/gi, "").slice(0, 24);
    if (tag) seen.add(tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

// origin ที่ไม่ได้ส่ง header มาเลย (native app / เครื่องมือทดสอบ) ปล่อยผ่าน —
// เบราว์เซอร์ส่ง Origin เสมอ การเช็คนี้จึงกันเว็บอื่นเปิด WebSocket มาที่เราได้
function isAllowedOrigin(origin: string | undefined): boolean {
  if (corsOrigins === true) return true; // CORS_ORIGINS="*"
  if (!origin) return true;
  return corsOrigins.includes(origin);
}

// ลดจำนวน connection ของ IP นั้นลง 1 และลบ key ทิ้งเมื่อไม่เหลือใครแล้ว
function releaseIp(ip: string) {
  const remaining = (connectionsPerIp.get(ip) ?? 0) - 1;
  if (remaining <= 0) connectionsPerIp.delete(ip);
  else connectionsPerIp.set(ip, remaining);
}

const send = (ws: any, payload: unknown) => {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ws อาจปิดไปแล้วระหว่างส่ง — ไม่ต้องทำให้ทั้ง handler ล้ม
  }
};

// หา partner ที่ยัง online ของ user ปัจจุบัน (ใช้ร่วมกันทุก relay case)
const getPartner = (user: User): User | undefined =>
  user.partnerId ? users.get(user.partnerId) : undefined;

const reconnectKey = (userId: number, peerUserId: number) =>
  `${userId}:${peerUserId}`;

// เช็คว่าจับคู่ a กับ b ได้ไหม (ออนไลน์, ว่าง, ไม่ block กัน)
function canMatch(a: User, b: User | undefined): b is User {
  if (!b || b.id === a.id || b.partnerId) return false;
  if (a.blocked.has(b.id) || b.blocked.has(a.id)) return false;
  return true;
}

function commitMatch(me: User, partner: User) {
  me.partnerId = partner.id;
  partner.partnerId = me.id;

  // วัดเวลารอคิวก่อนล้างค่า — ตัวเลขนี้คือสิ่งที่บอกได้ว่าระบบเริ่มไม่ไหวเมื่อไหร่
  const now = Date.now();
  for (const side of [me, partner]) {
    if (side.queuedAt !== null) observeMatchWait(now - side.queuedAt);
    side.queuedAt = null;
  }
  inc("matches_total");

  waitingQueue.remove(me.id);
  waitingQueue.remove(partner.id);
  removeReconnectRequestsForWs(me.id);
  removeReconnectRequestsForWs(partner.id);

  const shared = me.tags.filter((t) => partner.tags.includes(t));
  log.debug(
    `[Match] ${me.nickname} <--> ${partner.nickname}` +
      (shared.length ? ` (tags: ${shared.join(",")})` : ""),
  );

  send(me.ws, {
    type: "matched",
    partnerId: partner.id,
    partnerNickname: partner.nickname,
    partnerUserId: partner.userId ?? undefined,
    initiator: true,
    sharedTags: shared,
  });
  send(partner.ws, {
    type: "matched",
    partnerId: me.id,
    partnerNickname: me.nickname,
    partnerUserId: me.userId ?? undefined,
    initiator: false,
    sharedTags: shared,
  });

  startCallHistory(me, partner);
}

// --- Matching logic (รวมไว้ที่เดียว ใช้ทั้ง find_partner และ next) ---
// ลำดับ: ถ้ามี tag → หาคนที่ tag ตรงก่อน, ไม่งั้นจับคู่ตามคิว (FIFO)
function tryMatch(userId: string) {
  const me = users.get(userId);
  if (!me) return;

  // ถ้าจับคู่อยู่แล้ว หรือรออยู่ในคิวแล้ว ไม่ต้องทำซ้ำ (กันกดรัวๆ)
  if (me.partnerId) return;
  if (waitingQueue.has(userId)) {
    send(me.ws, { type: "waiting", message: "Searching for a partner..." });
    return;
  }

  // สแกนคิวรอบเดียว: หาคู่ที่ tag ตรงเป็นอันดับแรก ถ้าไม่มีค่อยใช้คนแรกในคิว (FIFO)
  //
  // สำคัญ: ห้ามใช้ dequeue() ที่นี่ เพราะการดึงคนออกมาแล้วพบว่าจับคู่ไม่ได้
  // (เช่น block กันอยู่) จะทำให้คนคนนั้นหลุดออกจากคิวถาวรทั้งที่ยังรอคู่อยู่ —
  // ค้างสถานะ "waiting" ตลอดไปโดยไม่มีใครมาจับคู่ให้ ที่นี่จึงลบออกจากคิว
  // เฉพาะคนที่ตายจริงเท่านั้น (หลุดการเชื่อมต่อ หรือถูกจับคู่ไปแล้ว)
  let fallback: User | null = null;

  for (const candidateId of waitingQueue.keys()) {
    const candidate = users.get(candidateId);

    // เก็บกวาดคนที่ไม่ควรอยู่ในคิวแล้ว
    if (!candidate || candidate.partnerId) {
      waitingQueue.remove(candidateId);
      continue;
    }
    if (candidate.id === me.id) continue;
    // block กันอยู่ → ข้าม แต่ปล่อยให้เขารออยู่ในคิวต่อไปเพื่อรอคู่คนอื่น
    if (me.blocked.has(candidate.id) || candidate.blocked.has(me.id)) continue;

    // tag ตรงกัน = ได้คู่ที่ดีที่สุด จับเลย
    if (me.tags.length > 0 && me.tags.some((t) => candidate.tags.includes(t))) {
      commitMatch(me, candidate);
      return;
    }

    // ยังไม่เจอ tag ที่ตรง → จำคนแรกที่จับคู่ได้ไว้เป็นตัวสำรอง (คงลำดับ FIFO)
    if (!fallback) {
      fallback = candidate;
      // ไม่มี tag ให้จับ → ไม่ต้องสแกนต่อ ใช้คนแรกในคิวได้เลย
      if (me.tags.length === 0) break;
    }
  }

  if (fallback) {
    commitMatch(me, fallback);
    return;
  }

  // ไม่มีคู่ว่าง → เข้าคิวรอ
  enqueueWaiting(me);
}

const app = new Elysia({
  // ค่าเหล่านี้ต้องอยู่ที่ constructor เท่านั้น — Elysia ส่งต่อ app.config.websocket
  // ไปให้ Bun.serve() ใส่ใน .ws("/match", {...}) จะไม่มีผล
  websocket: {
    // default ของ Bun คือ 16MB ต่อข้อความ ซึ่งเปิดช่องให้ยิงข้อความยักษ์มา
    // JSON.parse จนเซิร์ฟเวอร์ค้าง — SDP offer ที่ใหญ่สุดยังไม่ถึง 8KB
    maxPayloadLength: env.WS_MAX_PAYLOAD_BYTES,
    // ตัดสายที่เงียบเร็วขึ้น (Bun ส่ง ping อัตโนมัติให้อยู่แล้ว) ไม่งั้นคนที่หลุด
    // ไปแล้วยังค้างอยู่ในคิวได้นานถึง 2 นาที แล้วมีคนถูกจับคู่กับผี
    idleTimeout: env.WS_IDLE_TIMEOUT_SEC,
    // client ที่รับข้อมูลไม่ทันจะสะสม buffer ได้ถึง 16MB ตาม default — ปิดสายทิ้งดีกว่า
    backpressureLimit: 1024 * 1024,
    closeOnBackpressureLimit: true,
  },
})
  .use(cors({ origin: corsOrigins }))
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") {
      set.status = 400;
      return { message: "ข้อมูลไม่ถูกต้องหรือไม่ครบถ้วน" };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { message: "Not found" };
    }
    log.error("[error]", error);
    set.status = 500;
    return { message: "Internal server error" };
  })
  // health check สำหรับ load balancer / uptime monitor
  .get("/health", () => ({
    status: "ok",
    online: users.size,
    waiting: waitingQueue.size,
  }))
  // metrics สำหรับ Prometheus — ไว้ดูว่าคิวยาวขึ้นตอนไหน จับคู่ช้าลงเพราะอะไร
  .get("/metrics", ({ set }) => {
    set.headers["content-type"] = "text/plain; version=0.0.4";
    const bans = banCacheStats();
    return renderMetrics({
      online_users: users.size,
      waiting_users: waitingQueue.size,
      paired_users: [...users.values()].filter((u) => u.partnerId).length,
      unique_ips: connectionsPerIp.size,
      pending_reconnects: reconnectRequests.size,
      banned_users: bans.users,
      banned_ips: bans.ips,
    });
  })
  .use(Ice)
  .ws("/match", {
    // ปฏิเสธตั้งแต่ก่อน upgrade — ถูกกว่าปล่อยให้ handshake เสร็จแล้วค่อยปิด
    // (CORS plugin ไม่ครอบคลุม WebSocket จึงต้องเช็ค origin เองที่นี่)
    //
    // ที่นี่เช็คได้แค่ origin เท่านั้น ไม่เช็คโควตาต่อ IP เพราะยังไม่มี remoteAddress
    // ให้ใช้ — การเช็คจาก header อย่างเดียวจะกลายเป็นการนับ IP ว่า "unknown"
    // เหมือนกันหมดเมื่อ TRUST_PROXY=false ซึ่งไม่มีความหมาย โควตาต่อ IP บังคับใน open()
    beforeHandle({ headers, set }) {
      if (!isAllowedOrigin(headers.origin)) {
        set.status = 403;
        return { message: "Origin not allowed" };
      }
    },

    open(ws) {
      const headers = (ws.data as any)?.headers ?? {};
      const ip = clientIp(headers, ws.remoteAddress);

      // นับและเช็คในจังหวะเดียวกัน (ฟังก์ชันนี้เป็น synchronous จึงไม่มี race)
      const current = connectionsPerIp.get(ip) ?? 0;
      if (env.WS_MAX_CONN_PER_IP > 0 && current >= env.WS_MAX_CONN_PER_IP) {
        inc("conn_limit_rejections_total");
        send(ws, { type: "error", reason: "too_many_connections" });
        ws.close(1008, "too many connections");
        return;
      }
      // แบนตาม IP กันคนที่ไม่ได้ login — เช็คจาก cache ใน memory ไม่แตะ DB
      if (isBanned(null, ip)) {
        inc("ban_rejections_total");
        send(ws, { type: "banned", reason: "คุณถูกระงับการใช้งานชั่วคราว" });
        ws.close(1008, "banned");
        return;
      }

      connectionsPerIp.set(ip, current + 1);

      users.set(ws.id, {
        id: ws.id,
        ws,
        ip,
        nickname: "Anonymous",
        partnerId: null,
        userId: null,
        tags: [],
        blocked: new Set(),
        activeCallId: null,
        queuedAt: null,
      });
      inc("ws_connections_total");
    },

    message(ws, raw: any) {
      const currentUser = users.get(ws.id);
      if (!currentUser) return;

      let message: any = raw;
      if (typeof raw === "string") {
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
      }
      if (!message || typeof message !== "object" || !message.type) return;

      // เพดานรวมของทุกข้อความ กัน flood ทุกชนิด (เดิม offer/answer/ice/typing
      // ส่งได้ไม่จำกัด ยิงรัวๆ ก็กิน CPU ของเซิร์ฟเวอร์และ bandwidth ของคู่สนทนาได้)
      inc("ws_messages_total");
      if (!msgIpBucket.allow(currentUser.ip)) {
        inc("rate_limited_total");
        return;
      }

      switch (message.type) {
        case "find_partner": {
          if (!allowAction(currentUser)) {
            send(currentUser.ws, { type: "cooldown", retryInMs: NEXT_COOLDOWN_MS });
            break;
          }
          removeReconnectRequestsForWs(ws.id);
          currentUser.nickname = message.nickname || currentUser.nickname || "Anonymous";
          currentUser.tags = normalizeTags(message.tags);
          // Phase 3: ถ้าแนบ token มาและถูกต้อง → ผูกกับบัญชี (anonymous ก็ต่อได้)
          applyAuth(currentUser, message.token);
          // เพิ่งรู้ userId ตอนนี้ จึงเช็คแบนตามบัญชีได้ที่นี่เป็นครั้งแรก
          if (enforceBan(currentUser)) break;
          tryMatch(ws.id);
          break;
        }

        // --- Reconnect: ทั้งสองฝั่งต้องส่ง token + peerUserId ภายใน window เดียวกัน ---
        case "reconnect": {
          applyAuth(currentUser, message.token);
          if (enforceBan(currentUser)) break;
          currentUser.nickname = message.nickname || currentUser.nickname || "Anonymous";
          if (Array.isArray(message.tags)) currentUser.tags = normalizeTags(message.tags);

          const peerUserId = Number(message.peerUserId);
          if (!currentUser.userId || !Number.isSafeInteger(peerUserId) || peerUserId <= 0) {
            send(currentUser.ws, { type: "reconnect_failed", reason: "invalid_request" });
            break;
          }

          leaveMatch(ws.id);
          tryReconnect(currentUser, peerUserId);
          break;
        }

        case "next": {
          // กันกด next รัวๆ
          if (!allowAction(currentUser)) {
            send(currentUser.ws, { type: "cooldown", retryInMs: NEXT_COOLDOWN_MS });
            break;
          }
          log.debug(`[Next] ${currentUser.nickname} wants new partner`);
          // เคลียร์คู่เก่าและออกจากคิวเดิม (แจ้ง partner เก่าด้วย) แต่ไม่ลบ user
          leaveMatch(ws.id);
          currentUser.nickname = message.nickname || currentUser.nickname || "Anonymous";
          if (Array.isArray(message.tags)) currentUser.tags = normalizeTags(message.tags);
          tryMatch(ws.id);
          break;
        }

        // --- WebRTC signaling: ส่งต่อไปยัง partner เท่านั้น ---
        case "offer":
        case "answer":
        case "ice": {
          const partner = getPartner(currentUser);
          if (partner) send(partner.ws, message);
          break;
        }

        // --- Chat: relay ข้อความหา partner (stamp ชื่อ+เวลาฝั่ง server กัน spoof) ---
        case "chat": {
          const partner = getPartner(currentUser);
          if (!partner) break;
          // กันส่ง chat ถี่เกินไป (token bucket)
          if (!chatBucket.allow(ws.id)) break;

          const text = typeof message.text === "string" ? message.text.trim() : "";
          if (!text) break;
          // ตัดความยาวกัน abuse แล้วกรองคำหยาบก่อน relay
          const safeText = maskProfanity(text.slice(0, MAX_CHAT_LEN));

          send(partner.ws, {
            type: "chat",
            text: safeText,
            from: currentUser.nickname,
            ts: Date.now(),
          });
          break;
        }

        // --- Typing indicator: relay สถานะพิมพ์ (boolean) ---
        case "typing": {
          const partner = getPartner(currentUser);
          if (partner) {
            send(partner.ws, { type: "typing", isTyping: !!message.isTyping });
          }
          break;
        }

        // --- Like: แจ้ง partner + persist ถ้าทั้งคู่ login (mutual = เพื่อน) ---
        case "like": {
          const partner = getPartner(currentUser);
          if (!partner) break;
          send(partner.ws, { type: "like", from: currentUser.nickname });
          // เก็บลง DB เฉพาะเมื่อรู้ตัวตนทั้งสองฝั่ง; ถ้า mutual แจ้งทั้งคู่ว่าเป็นเพื่อนกัน
          // (like เขียน DB ทุกครั้ง จึงต้องมีโควตาแยก กันกดรัวๆ ถล่มฐานข้อมูล)
          if (
            currentUser.userId &&
            partner.userId &&
            likeBucket.allow(ws.id) &&
            writeIpBucket.allow(currentUser.ip)
          ) {
            const myId = currentUser.userId;
            const partnerWs = partner.ws;
            const partnerId = partner.userId;
            recordLike(myId, partnerId).then((mutual) => {
              if (mutual) {
                send(currentUser.ws, { type: "friend", with: partner.nickname });
                send(partnerWs, { type: "friend", with: currentUser.nickname });
              }
            });
          }
          break;
        }

        // --- Report: บันทึกรายงานพฤติกรรมไม่เหมาะสมลง DB ---
        case "report": {
          const partner = getPartner(currentUser);
          // เขียน DB เฉพาะเมื่อยังมีโควตา — กันการยิง report รัวๆ เพื่อถล่มฐานข้อมูล
          // (ไม่ต้อง login ก็ส่งได้ จึงเป็นช่องเขียน DB ที่ถูกที่สุดถ้าไม่คุม)
          if (reportBucket.allow(ws.id) && writeIpBucket.allow(currentUser.ip)) {
            const reportedUserId = partner?.userId ?? null;
            recordReport({
              reporterUserId: currentUser.userId,
              reporterSession: currentUser.id,
              reportedUserId,
              reportedNickname: partner?.nickname ?? null,
              reportedSession: partner?.id ?? null,
              reason:
                typeof message?.reason === "string" ? message.reason.slice(0, 32) : "other",
              contextSnippet:
                typeof message?.context === "string" ? message.context.slice(0, 500) : null,
            }).then(() => {
              // ถึงเกณฑ์แล้วแบนอัตโนมัติ แล้วเตะออกจากระบบทันทีถ้ายังต่ออยู่
              if (reportedUserId === null) return;
              void checkAutoBan(reportedUserId).then((banned) => {
                if (banned) disconnectBannedUsers();
              });
            });
          }
          // รายงานแล้วถือว่า block + หาคนใหม่ให้เลย
          blockAndNext(ws.id);
          break;
        }

        // --- Block: ไม่จับคู่กับ partner ปัจจุบันอีก แล้วหาคนใหม่ ---
        case "block": {
          blockAndNext(ws.id);
          break;
        }
      }
    },

    close(ws) {
      handleDisconnect(ws.id);
    },
  })
  .use(Auth)
  .use(Me)
  .use(Admin)
  .listen(env.PORT);

// โหลดรายชื่อแบนเข้า memory ตั้งแต่ boot แล้ว refresh ตามรอบ เพื่อให้เช็คตอน
// connection เข้ามาได้โดยไม่ต้องยิง DB (และรับแบนที่แอดมินสร้างจาก instance อื่น)
void refreshBanCache();
const banRefreshTimer = setInterval(() => void refreshBanCache(), 60_000);
banRefreshTimer.unref?.();

// เก็บกวาดคำขอ reconnect ที่หมดอายุตามรอบ (ย้ายออกจากเส้นทางร้อนของข้อความ)
const reconnectSweepTimer = setInterval(cleanupExpiredReconnectRequests, 30_000);
reconnectSweepTimer.unref?.();

// ปิดแถว calls ที่ค้างจากรอบก่อน (เซิร์ฟเวอร์ดับกลางสาย) แล้วลบข้อมูลเก่าตาม retention
closeOrphanedCalls().then((n) => {
  if (n > 0) log.info(`[startup] closed ${n} orphaned call rows`);
});
const prune = () =>
  void pruneOldRecords(env.CALL_RETENTION_DAYS, env.REPORT_RETENTION_DAYS).then(
    ({ calls, reports }) => {
      if (calls || reports) {
        log.info(`[prune] removed ${calls} calls, ${reports} reports`);
      }
    },
  );
prune();
const pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000);
pruneTimer.unref?.();

log.info(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port} (${env.NODE_ENV})`,
);

export type App = typeof app;

// --- Helpers ---

// ออกจากการจับคู่/คิวปัจจุบัน แต่ยังคง user ไว้ในระบบ (ใช้ตอนกด next)
function leaveMatch(userId: string) {
  const user = users.get(userId);
  if (!user) return;

  waitingQueue.remove(userId);
  removeReconnectRequestsForWs(userId);
  endActiveCall(user);

  if (user.partnerId) {
    const partner = users.get(user.partnerId);
    if (partner) {
      send(partner.ws, { type: "partner_disconnected" });
      endActiveCall(partner);
      partner.partnerId = null;
    }
    user.partnerId = null;
  }
}

// ตัดการเชื่อมต่อถาวร (ใช้ตอน close)
function handleDisconnect(userId: string) {
  const user = users.get(userId);
  // connection ที่ถูกปฏิเสธตอน open (เกินโควตา IP) ไม่เคยถูกนับ จึงห้ามลดตัวนับ
  if (!user) return;

  inc("ws_disconnects_total");
  releaseIp(user.ip);
  leaveMatch(userId);
  users.delete(userId);
  // ล้างเฉพาะ limiter ระดับ session (key = ws.id) ที่ตายไปพร้อม connection นี้
  // ส่วน limiter ระดับ IP ห้ามล้าง ไม่งั้นต่อใหม่แล้วรีเซ็ตเพดานได้ทันที —
  // ปล่อยให้ startSweeper() เก็บกวาดตามรอบแทน
  nextCooldown.clear(userId);
  chatBucket.clear(userId);
  reportBucket.clear(userId);
  likeBucket.clear(userId);
  removeReconnectRequestsForWs(userId);
  log.debug(`[Cleaned] User ${userId} removed.`);
}

// Phase 3: verify token แล้วผูก user กับบัญชี (เงียบถ้า token ไม่ถูก — anonymous ต่อได้)
function applyAuth(user: User, token: unknown) {
  if (typeof token !== "string" || !token) return;
  const payload = verifyJwt(token);
  if (payload?.sub) {
    user.userId = Number(payload.sub);
    if (typeof payload.username === "string") user.nickname = payload.username;
  }
}

// เตะคนที่เพิ่งถูกแบนออกจากระบบทันที ไม่ต้องรอให้เขาปิดแท็บเอง
// (เรียกหลังจาก ban cache อัปเดตแล้วเท่านั้น)
function disconnectBannedUsers() {
  for (const user of [...users.values()]) {
    enforceBan(user);
  }
}

// เช็คแบนหลังรู้ตัวตนแล้ว — ตอน open เช็คได้แค่ IP เพราะยังไม่มี token
// คืน true ถ้าถูกแบน (และปิดการเชื่อมต่อให้เรียบร้อยแล้ว)
function enforceBan(user: User): boolean {
  if (!isBanned(user.userId, user.ip)) return false;
  send(user.ws, { type: "banned", reason: "คุณถูกระงับการใช้งานชั่วคราว" });
  leaveMatch(user.id);
  user.ws.close(1008, "banned");
  return true;
}

// Phase 3: บันทึก call history เฉพาะ match ที่ทั้งสองฝั่ง login แล้ว
function startCallHistory(me: User, partner: User) {
  if (!me.userId || !partner.userId) return;
  const meWsId = me.id;
  const partnerWsId = partner.id;

  Promise.all([
    startCall(me.userId, partner.userId),
    startCall(partner.userId, me.userId),
  ]).then(([meCallId, partnerCallId]) => {
    const freshMe = users.get(meWsId);
    const freshPartner = users.get(partnerWsId);

    if (
      freshMe?.partnerId === partnerWsId &&
      freshPartner?.partnerId === meWsId
    ) {
      freshMe.activeCallId = meCallId;
      freshPartner.activeCallId = partnerCallId;
      return;
    }

    if (meCallId) void endCall(meCallId);
    if (partnerCallId) void endCall(partnerCallId);
  });
}

function endActiveCall(user: User) {
  if (!user.activeCallId) return;
  const callId = user.activeCallId;
  user.activeCallId = null;
  void endCall(callId);
}

// เพิ่ม/ลบคำขอ reconnect ต้องผ่าน 2 ฟังก์ชันนี้เท่านั้น เพื่อให้ index ไม่หลุดจากกัน
function setReconnectRequest(key: string, request: ReconnectRequest) {
  deleteReconnectRequest(key); // ของเดิม (ถ้ามี) อาจผูกกับ wsId คนละตัว
  reconnectRequests.set(key, request);
  let keys = reconnectKeysByWs.get(request.wsId);
  if (!keys) {
    keys = new Set();
    reconnectKeysByWs.set(request.wsId, keys);
  }
  keys.add(key);
}

function deleteReconnectRequest(key: string) {
  const request = reconnectRequests.get(key);
  if (!request) return;
  reconnectRequests.delete(key);
  const keys = reconnectKeysByWs.get(request.wsId);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) reconnectKeysByWs.delete(request.wsId);
}

// เก็บกวาดคำขอที่หมดอายุ — ย้ายมารันตามรอบแทนการเรียกทุกครั้งที่มีคนกด reconnect
// เพื่อไม่ให้การสแกนทั้ง map ไปอยู่บนเส้นทางร้อน
function cleanupExpiredReconnectRequests() {
  const now = Date.now();
  for (const [key, request] of [...reconnectRequests]) {
    if (request.expiresAt <= now || !users.has(request.wsId)) {
      deleteReconnectRequest(key);
    }
  }
}

// O(1) ต่อ ws หนึ่งตัว แทนการวนทั้ง map
function removeReconnectRequestsForWs(wsId: string) {
  const keys = reconnectKeysByWs.get(wsId);
  if (!keys) return;
  for (const key of keys) reconnectRequests.delete(key);
  reconnectKeysByWs.delete(wsId);
}

function tryReconnect(me: User, peerUserId: number) {
  if (!me.userId || me.userId === peerUserId) {
    send(me.ws, { type: "reconnect_failed", reason: "invalid_request" });
    return;
  }

  // เช็คอายุของรายการที่สนใจตัวเดียว ไม่ต้องสแกนทั้ง map (มี sweeper ตามรอบแล้ว)
  const reciprocalKey = reconnectKey(peerUserId, me.userId);
  const reciprocal = reconnectRequests.get(reciprocalKey);
  const expired = reciprocal !== undefined && reciprocal.expiresAt <= Date.now();
  if (expired) deleteReconnectRequest(reciprocalKey);

  const partner =
    reciprocal && !expired ? users.get(reciprocal.wsId) : undefined;

  if (canMatch(me, partner) && partner.userId === peerUserId) {
    deleteReconnectRequest(reciprocalKey);
    commitMatch(me, partner);
    send(me.ws, { type: "reconnected", peerUserId });
    send(partner.ws, { type: "reconnected", peerUserId: me.userId });
    return;
  }

  setReconnectRequest(reconnectKey(me.userId, peerUserId), {
    userId: me.userId,
    peerUserId,
    wsId: me.id,
    expiresAt: Date.now() + env.RECONNECT_WINDOW_MS,
  });
  send(me.ws, {
    type: "reconnect_waiting",
    peerUserId,
    expiresInMs: env.RECONNECT_WINDOW_MS,
  });
}

// Phase 1: block partner ปัจจุบัน (สองทาง) แล้วหาคนใหม่
//
// การ block กับการออกจากคู่ทำเสมอ ไม่ผ่าน rate limit — เป็นแค่การเขียน Set ใน memory
// และเป็นทางหนีของคนที่กำลังเจอคนทำตัวไม่ดี ห้ามให้ rate limit มาขวาง
// แต่การ "หาคู่ใหม่" ราคาแพงพอๆ กับ next (สแกนคิว + เขียน DB) จึงต้องผ่าน cooldown
// เดียวกัน ไม่งั้นส่ง block รัวๆ แทน next ก็เลี่ยง cooldown ได้ทั้งหมด
function blockAndNext(userId: string) {
  const me = users.get(userId);
  if (!me) return;
  const partner = getPartner(me);
  if (partner) {
    me.blocked.add(partner.id);
    partner.blocked.add(me.id); // symmetric: อีกฝ่ายก็จะไม่เจอเราอีก
    capBlocked(me);
    capBlocked(partner);
  }
  leaveMatch(userId);

  if (allowAction(me)) {
    tryMatch(userId);
  } else {
    // ติด cooldown → ข้ามการสแกนคิว (ส่วนที่แพง) แต่ยัง "ต้อง" เข้าคิวไว้
    // ไม่งั้นจะค้างอยู่ในสภาพไม่มีคู่และไม่อยู่ในคิว = ไม่มีใครจับคู่ให้ได้อีกเลย
    // การเข้าคิวเป็น O(1) ไม่ใช่ส่วนที่ต้องคุม และคนอื่นที่สแกนจะมาเจอเราเอง
    send(me.ws, { type: "cooldown", retryInMs: NEXT_COOLDOWN_MS });
    enqueueWaiting(me);
  }
}

// จำกัดขนาด blocked set ต่อ session กัน memory โตไม่จำกัดในการเชื่อมต่อที่อยู่นาน
// Set เก็บตามลำดับที่ใส่ จึงทิ้งตัวที่เก่าที่สุดออกได้
function capBlocked(user: User) {
  while (user.blocked.size > MAX_BLOCKED) {
    const oldest = user.blocked.values().next().value;
    if (oldest === undefined) break;
    user.blocked.delete(oldest);
  }
}


// --- Graceful shutdown ---
async function shutdown(signal: string) {
  log.info(`\n[shutdown] received ${signal}, closing...`);
  try {
    clearInterval(sweeperTimer);
    clearInterval(banRefreshTimer);
    clearInterval(reconnectSweepTimer);
    clearInterval(pruneTimer);
    await app.stop();
    await closeDb();
  } catch (err) {
    log.error("[shutdown] error:", err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
