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

// --- State Management ---
const users = new Map<string, User>();
let waitingQueue: string[] = [];

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

    message(ws, message: any) {
      const currentUser = users.get(ws.id);
      if (!currentUser) {
        console.error(`[Error] User ${ws.id} not found in users map`);
        return;
      }

      // ✅ Validation - ป้องกัน malformed messages
      if (!message || typeof message !== "object" || !message.type) {
        console.error(`[Error] Invalid message format from ${ws.id}`);
        return;
      }

      console.log(`[Message] ${currentUser.nickname} -> ${message.type}`);

      switch (message.type) {
        case "find_partner": {
          const { nickname } = message;
          currentUser.nickname = nickname || "Anonymous";

          if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();

            // ✅ Validation - ป้องกัน self-match และ invalid partner
            if (!partnerId || partnerId === ws.id || !users.has(partnerId)) {
              console.log(
                `[Queue] Invalid partner, adding ${currentUser.nickname} to queue`
              );
              waitingQueue.push(ws.id);
              ws.send(
                JSON.stringify({
                  type: "waiting",
                  message: "Waiting for someone...",
                })
              );
              return;
            }

            const partnerUser = users.get(partnerId);

            if (partnerUser) {
              console.log(
                `[Match] ${currentUser.nickname} <--> ${partnerUser.nickname} (initiator: ${currentUser.nickname})`
              );

              currentUser.partnerId = partnerId;
              partnerUser.partnerId = ws.id;

              // ✅ ส่ง JSON string แทน object
              ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId: partnerId,
                  partnerNickname: partnerUser.nickname,
                  initiator: true, // 👈 currentUser เป็น initiator
                })
              );

              partnerUser.ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId: ws.id,
                  partnerNickname: currentUser.nickname,
                  initiator: false, // 👈 partnerUser รอรับ offer
                })
              );
            }
          } else {
            waitingQueue.push(ws.id);
            ws.send(
              JSON.stringify({
                type: "waiting",
                message: "Searching for a partner...",
              })
            );
            console.log(`[Queue] ${currentUser.nickname} added to queue.`);
          }
          break;
        }

        case "next": {
          console.log(`[Next] ${currentUser.nickname} looking for new partner`);

          // ✅ Cleanup old connection properly
          handleDisconnect(ws.id);

          // ✅ Re-register user
          users.set(ws.id, {
            id: ws.id,
            ws,
            nickname: message.nickname || "Anonymous",
            partnerId: null,
          });

          const me = users.get(ws.id)!;

          // ✅ Logic หาคู่ใหม่ (เหมือน find_partner)
          if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();

            if (partnerId && partnerId !== ws.id && users.has(partnerId)) {
              const partnerUser = users.get(partnerId)!;

              console.log(
                `[Match] ${me.nickname} <--> ${partnerUser.nickname} (initiator: ${me.nickname})`
              );

              me.partnerId = partnerId;
              partnerUser.partnerId = ws.id;

              // ✅ ส่ง initiator flag!
              ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId: partnerId,
                  partnerNickname: partnerUser.nickname,
                  initiator: true, // 👈 สำคัญมาก!
                })
              );

              partnerUser.ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId: ws.id,
                  partnerNickname: me.nickname,
                  initiator: false, // 👈 สำคัญมาก!
                })
              );
            } else {
              waitingQueue.push(ws.id);
              ws.send(
                JSON.stringify({ type: "waiting", message: "Searching..." })
              );
            }
          } else {
            waitingQueue.push(ws.id);
            ws.send(
              JSON.stringify({ type: "waiting", message: "Searching..." })
            );
            console.log(`[Queue] ${me.nickname} added to queue (next).`);
          }
          break;
        }

        case "offer":
        case "answer":
        case "ice": {
          const { partnerId } = currentUser;

          // ✅ Validation
          if (!partnerId) {
            console.error(
              `[Error] ${currentUser.nickname} has no partner for ${message.type}`
            );
            return;
          }

          if (!users.has(partnerId)) {
            console.error(`[Error] Partner ${partnerId} not found`);
            // ส่งกลับว่า partner disconnected
            ws.send(JSON.stringify({ type: "partner_disconnected" }));
            currentUser.partnerId = null;
            return;
          }

          const partnerWs = users.get(partnerId)?.ws;

          if (partnerWs) {
            console.log(
              `[Relay] ${message.type} from ${currentUser.nickname} to partner`
            );
            // ✅ Forward as JSON string
            partnerWs.send(JSON.stringify(message));
          } else {
            console.error(`[Error] Partner WebSocket not available`);
          }
          break;
        }

        default:
          console.warn(`[Warning] Unknown message type: ${message.type}`);
      }
    },

    close(ws) {
      const user = users.get(ws.id);
      console.log(
        `[Disconnect] ${user?.nickname || ws.id} (Partner: ${
          user?.partnerId || "none"
        })`
      );
      handleDisconnect(ws.id);
    },
  })
  .use(Auth)
  .listen(process.env.PORT || 4000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

export type App = typeof app;

// --- Helper Function ---
function handleDisconnect(userId: string) {
  const user = users.get(userId);
  if (!user) return;

  // ✅ Remove from queue
  waitingQueue = waitingQueue.filter((id) => id !== userId);

  // ✅ Notify partner
  if (user.partnerId) {
    const partner = users.get(user.partnerId);
    if (partner) {
      console.log(
        `[Notify] Sending partner_disconnected to ${partner.nickname}`
      );
      partner.ws.send(JSON.stringify({ type: "partner_disconnected" }));
      partner.partnerId = null;
    }
  }

  users.delete(userId);
  console.log(`[Cleanup] User ${user.nickname} removed from system`);
}
