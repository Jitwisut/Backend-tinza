// src/index.ts
import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { Auth } from "./router/kuy";
// --- Types ---
type User = {
  id: string;
  ws: any;
  nickname: string;
  partnerId: string | null;
};

// --- State Management ---
// เก็บข้อมูลผู้ใช้ทั้งหมดที่ online
const users = new Map<string, User>();

// เก็บ ID ของคนที่กำลังรอคิว (FIFO Queue)
let waitingQueue: string[] = [];

const app = new Elysia()
  .use(cors()) // อนุญาตให้ Frontend เชื่อมต่อข้าม Port ได้
  .use(Auth)
  .ws("/match", {
    // Schema Validation (Optional แต่ใส่ไว้เพื่อความปลอดภัย)
    body: t.Object({
      type: t.String(),
      nickname: t.Optional(t.String()),
      offer: t.Optional(t.Any()),
      answer: t.Optional(t.Any()),
      candidate: t.Optional(t.Any()),
      partnerId: t.Optional(t.String()),
    }),

    open(ws) {
      console.log(`[Connect] ${ws.id}`);
      // เมื่อเชื่อมต่อ สร้าง User เปล่าๆ รอไว้
      users.set(ws.id, {
        id: ws.id,
        ws,
        nickname: "Anonymous",
        partnerId: null,
      });
    },

    message(ws, message: any) {
      const currentUser = users.get(ws.id);
      if (!currentUser) return;

      switch (message.type) {
        case "find_partner": {
          const { nickname } = message;
          currentUser.nickname = nickname || "Anonymous";

          // 1. ตรวจสอบว่ามีคนรออยู่ในคิวไหม?
          if (waitingQueue.length > 0) {
            // ดึงคนที่รออยู่ออกมา
            const partnerId = waitingQueue.shift();

            // กรณีคิวหลุด หรือตัวเองจับคู่กับตัวเอง (Edge case)
            if (!partnerId || partnerId === ws.id || !users.has(partnerId)) {
              waitingQueue.push(ws.id);
              ws.send({ type: "waiting", message: "Waiting for someone..." });
              return;
            }

            const partnerUser = users.get(partnerId);

            if (partnerUser) {
              // --- Match Found! ---
              console.log(
                `[Match] ${currentUser.nickname} <--> ${partnerUser.nickname}`
              );

              // Update Partner ID ให้ทั้งคู่
              currentUser.partnerId = partnerId;
              partnerUser.partnerId = ws.id;

              // แจ้งเตือนทั้งคู่
              ws.send({
                type: "matched",
                partnerId: partnerId,
                partnerNickname: partnerUser.nickname,
                initiator: true, // บอกให้คนนี้เป็นคนเริ่มส่ง Offer (Optional logic)
              });

              partnerUser.ws.send({
                type: "matched",
                partnerId: ws.id,
                partnerNickname: currentUser.nickname,
                initiator: false,
              });
            }
          } else {
            // 2. ไม่มีคนรอ -> เข้าไปต่อคิว
            waitingQueue.push(ws.id);
            ws.send({ type: "waiting", message: "Searching for a partner..." });
            console.log(`[Queue] ${currentUser.nickname} added to queue.`);
          }
          break;
        }

        case "next": {
          // Logic เหมือน disconnect แล้ว connect ใหม่
          handleDisconnect(ws.id); // ตัดคู่เก่า

          // Reset state เพื่อนับหนึ่งใหม่
          users.set(ws.id, {
            id: ws.id,
            ws,
            nickname: message.nickname || "Anonymous",
            partnerId: null,
          });

          // เรียกหาคู่ใหม่ทันที
          const selfMatch = { ...message, type: "find_partner" };
          // (เรียก logic ซ้ำ หรือ copy logic find_partner มาใส่ตรงนี้ก็ได้)
          // เพื่อความง่าย ให้ Client ส่ง find_partner มาใหม่ หรือเราจัดการ manual:
          if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();
            if (partnerId && partnerId !== ws.id && users.has(partnerId)) {
              const partnerUser = users.get(partnerId)!;
              const me = users.get(ws.id)!;
              me.partnerId = partnerId;
              partnerUser.partnerId = ws.id;
              ws.send({
                type: "matched",
                partnerId: partnerId,
                partnerNickname: partnerUser.nickname,
              });
              partnerUser.ws.send({
                type: "matched",
                partnerId: ws.id,
                partnerNickname: me.nickname,
              });
            } else {
              waitingQueue.push(ws.id);
              ws.send({ type: "waiting", message: "Searching..." });
            }
          } else {
            waitingQueue.push(ws.id);
            ws.send({ type: "waiting", message: "Searching..." });
          }
          break;
        }

        // --- Signaling (WebRTC) Relay ---
        // ข้อความเหล่านี้จะถูกส่งผ่าน Server ไปหา Partner ตรงๆ
        case "offer":
        case "answer":
        case "ice": {
          const { partnerId } = currentUser;
          if (partnerId && users.has(partnerId)) {
            const partnerWs = users.get(partnerId)?.ws;
            partnerWs.send(message); // ส่งต่อ message ไปหา partner
          }
          break;
        }
      }
    },

    close(ws) {
      console.log(`[Disconnect] ${ws.id}`);
      handleDisconnect(ws.id);
    },
  })
  .listen(4000); // *** รันที่ Port 3001 ***

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
export default app;
// --- Helper Function ---
function handleDisconnect(userId: string) {
  const user = users.get(userId);
  if (!user) return;

  // 1. ถ้าอยู่ในคิว ให้ลบออก
  waitingQueue = waitingQueue.filter((id) => id !== userId);

  // 2. ถ้ามีคู่สนทนาอยู่ ให้แจ้งเตือนคู่สนทนา
  if (user.partnerId) {
    const partner = users.get(user.partnerId);
    if (partner) {
      partner.ws.send({ type: "partner_disconnected" });
      partner.partnerId = null; // ปลดสถานะคู่สนทนา
      // อาจจะ Auto-queue partner กลับไปหาคนใหม่ก็ได้ถ้าต้องการ
    }
  }

  // 3. ลบ User ออกจากระบบ (ถ้าเป็นการปิด browser)
  // หมายเหตุ: กรณีปุ่ม Next เราจะไม่ลบ users.delete(userId) ใน function นี้
  // แต่เนื่องจาก Elysia close() จะถูกเรียกเมื่อ connection ขาดจริงๆ
  // ดังนั้น logic ใน app.ws.close จึงเรียก function นี้ได้เลย
  users.delete(userId);
}
