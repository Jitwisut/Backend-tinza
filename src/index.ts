// src/index.ts
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { Auth } from "./router/user";

// --- Types ---
type User = {
  id: string;
  ws: any;
  nickname: string;
  partnerId: string | null;
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

    // ถ้าเป็นหัวแถว
    if (node === this.head) {
      this.head = node.next;
    }
    // ถ้าเป็นท้ายแถว
    if (node === this.tail) {
      this.tail = node.prev;
    }

    // เชื่อมต่อ Node ก่อนหน้าและถัดไปเข้าด้วยกัน
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;

    // เคลียร์ reference เพื่อช่วย Garbage Collection
    node.next = null;
    node.prev = null;
  }

  // เช็คว่าอยู่ในคิวไหม
  has(userId: string): boolean {
    return this.nodes.has(userId);
  }
}

// --- State Management ---
const users = new Map<string, User>();
const waitingQueue = new MatchQueue(); // ใช้ Class ใหม่แทน Array

const app = new Elysia()
  .use(cors())
  .ws("/match", {
    open(ws) {
      console.log(`[Connect] ${ws.id}`);
      users.set(ws.id, {
        id: ws.id,
        ws,
        nickname: "Anonymous",
        partnerId: null,
      });
    },

    message(ws, raw: any) {
      const currentUser = users.get(ws.id);
      if (!currentUser) return;

      const message =
        typeof raw === "string"
          ? (() => {
              try {
                return JSON.parse(raw);
              } catch (e) {
                return null;
              }
            })()
          : raw;

      if (!message || typeof message !== "object" || !message.type) return;

      switch (message.type) {
        // --- find_partner ---
        case "find_partner": {
          const nickname = message.nickname || "Anonymous";
          currentUser.nickname = nickname;

          // Logic การจับคู่
          // ถ้ามีคนรออยู่ และคนนั้นไม่ใช่ตัวเราเอง
          if (waitingQueue.size > 0) {
            // ตรวจสอบว่าหัวแถวไม่ใช่ตัวเอง (กรณี Race condition หรือกดรัวๆ)
            // แต่ปกติ enqueue เรากันไว้แล้ว แต่เช็คเพื่อความชัวร์
            let partnerId = waitingQueue.dequeue();

            // กรณีดึงออกมาแล้วเป็นตัวเอง (Rare case) ให้ใส่กลับไปรอใหม่แล้ว return
            if (partnerId === ws.id) {
              waitingQueue.enqueue(ws.id);
              ws.send(
                JSON.stringify({ type: "waiting", message: "Waiting..." }),
              );
              return;
            }

            // ถ้า partnerId valid และยังมีตัวตนอยู่ในระบบ
            if (partnerId && users.has(partnerId)) {
              const partnerUser = users.get(partnerId)!;

              currentUser.partnerId = partnerId;
              partnerUser.partnerId = ws.id;

              console.log(
                `[Match] ${currentUser.nickname} <--> ${partnerUser.nickname}`,
              );

              ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId,
                  partnerNickname: partnerUser.nickname,
                  initiator: true,
                }),
              );

              partnerUser.ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId: ws.id,
                  partnerNickname: currentUser.nickname,
                  initiator: false,
                }),
              );
            } else {
              // ถ้าดึงมาแล้วคู่หลุดไปแล้ว ให้ตัวเองไปต่อคิวแทน
              waitingQueue.enqueue(ws.id);
              ws.send(
                JSON.stringify({
                  type: "waiting",
                  message: "Searching for a partner...",
                }),
              );
            }
          } else {
            // ไม่มีคนรอ -> เข้าคิว
            waitingQueue.enqueue(ws.id);
            ws.send(
              JSON.stringify({
                type: "waiting",
                message: "Searching for a partner...",
              }),
            );
            console.log(`[Queue] ${currentUser.nickname} added to queue.`);
          }
          break;
        }

        // --- next ---
        case "next": {
          console.log(`[Next] ${currentUser.nickname} wants new partner`);

          handleDisconnect(ws.id); // เคลียร์คู่เก่าและออกจากคิวเดิม (O(1))

          // รีเซ็ตข้อมูล
          users.set(ws.id, {
            id: ws.id,
            ws,
            nickname: message.nickname || currentUser.nickname || "Anonymous",
            partnerId: null,
          });

          // เรียกใช้ logic เดียวกับ find_partner ได้เลย หรือเขียนใหม่แบบนี้
          const me = users.get(ws.id)!;

          if (waitingQueue.size > 0) {
            let partnerId = waitingQueue.dequeue();

            if (partnerId === ws.id) {
              waitingQueue.enqueue(ws.id);
              ws.send(
                JSON.stringify({ type: "waiting", message: "Searching..." }),
              );
              return;
            }

            if (partnerId && users.has(partnerId)) {
              const partnerUser = users.get(partnerId)!;
              me.partnerId = partnerId;
              partnerUser.partnerId = ws.id;

              ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId,
                  partnerNickname: partnerUser.nickname,
                  initiator: true,
                }),
              );
              partnerUser.ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId: ws.id,
                  partnerNickname: me.nickname,
                  initiator: false,
                }),
              );
            } else {
              waitingQueue.enqueue(ws.id);
              ws.send(
                JSON.stringify({ type: "waiting", message: "Searching..." }),
              );
            }
          } else {
            waitingQueue.enqueue(ws.id);
            ws.send(
              JSON.stringify({ type: "waiting", message: "Searching..." }),
            );
          }
          break;
        }

        // --- signaling ---
        case "offer":
        case "answer":
        case "ice": {
          const partnerId = currentUser.partnerId;
          if (partnerId && users.has(partnerId)) {
            const partner = users.get(partnerId)!;
            partner.ws.send(JSON.stringify(message));
          }
          break;
        }
      }
    },

    close(ws) {
      handleDisconnect(ws.id);
    },
  })
  .use(Auth)
  .listen(process.env.PORT || 4000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);

export type App = typeof app;

// --- Helper Function ---
function handleDisconnect(userId: string) {
  const user = users.get(userId);
  if (!user) return;

  // O(1) Remove from Queue
  // ไม่ว่าจะอยู่หัวแถว กลางแถว หรือท้ายแถว ก็ลบได้ทันทีโดยไม่ต้อง loop
  waitingQueue.remove(userId);

  // แจ้งเตือนฝั่ง partner
  if (user.partnerId && users.has(user.partnerId)) {
    const partner = users.get(user.partnerId)!;
    partner.ws.send(
      JSON.stringify({
        type: "partner_disconnected",
      }),
    );
    partner.partnerId = null;
  }

  users.delete(userId);
  console.log(`[Cleaned] User ${userId} removed.`);
}
