// src/index.ts
import { Elysia } from "elysia"; // เอา t ออกเพราะไม่ได้ใช้ validation แล้ว
import { cors } from "@elysiajs/cors";
import { Auth } from "./router/user";

// --- Types ---
type User = {
  id: string;
  ws: any;
  nickname: string;
  partnerId: string | null;
};

// --- State Management ---
const users = new Map<string, User>();
let waitingQueue: string[] = [];

const app = new Elysia()
  .use(cors()) // อนุญาตให้ Frontend เชื่อมต่อข้าม Port ได้

  .ws("/match", {
    // ❌ ลบส่วน body: t.Object(...) ออกแล้ว เพื่อป้องกัน Error 400 ตอน Handshake

    open(ws) {
      console.log(`[Connect] ${ws.id}`);
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

      // ตรวจสอบนิดหน่อยกัน Error เพราะเราลบ Validation ออกแล้ว
      if (!message || !message.type) return;

      switch (message.type) {
        case "find_partner": {
          const { nickname } = message;
          currentUser.nickname = nickname || "Anonymous";

          if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();

            if (!partnerId || partnerId === ws.id || !users.has(partnerId)) {
              waitingQueue.push(ws.id);
              ws.send({ type: "waiting", message: "Waiting for someone..." });
              return;
            }

            const partnerUser = users.get(partnerId);

            if (partnerUser) {
              console.log(
                `[Match] ${currentUser.nickname} <--> ${partnerUser.nickname}`
              );

              currentUser.partnerId = partnerId;
              partnerUser.partnerId = ws.id;

              ws.send({
                type: "matched",
                partnerId: partnerId,
                partnerNickname: partnerUser.nickname,
                initiator: true,
              });

              partnerUser.ws.send({
                type: "matched",
                partnerId: ws.id,
                partnerNickname: currentUser.nickname,
                initiator: false,
              });
            }
          } else {
            waitingQueue.push(ws.id);
            ws.send({ type: "waiting", message: "Searching for a partner..." });
            console.log(`[Queue] ${currentUser.nickname} added to queue.`);
          }
          break;
        }

        case "next": {
          handleDisconnect(ws.id);

          users.set(ws.id, {
            id: ws.id,
            ws,
            nickname: message.nickname || "Anonymous",
            partnerId: null,
          });

          // Logic หาคู่ใหม่
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

        case "offer":
        case "answer":
        case "ice": {
          const { partnerId } = currentUser;
          if (partnerId && users.has(partnerId)) {
            const partnerWs = users.get(partnerId)?.ws;
            partnerWs.send(message);
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
  .use(Auth) // Auth อยู่หลัง WS ถูกต้องแล้ว
  // ✅ แก้ Port ให้รองรับ Render (สำคัญมาก)
  .listen(process.env.PORT || 4000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
export default app;

// --- Helper Function ---
function handleDisconnect(userId: string) {
  const user = users.get(userId);
  if (!user) return;

  waitingQueue = waitingQueue.filter((id) => id !== userId);

  if (user.partnerId) {
    const partner = users.get(user.partnerId);
    if (partner) {
      partner.ws.send({ type: "partner_disconnected" });
      partner.partnerId = null;
    }
  }

  users.delete(userId);
}
