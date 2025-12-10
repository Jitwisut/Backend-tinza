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

    message(ws, raw: any) {
      const currentUser = users.get(ws.id);
      if (!currentUser) return;

      // รองรับทั้ง string และ object
      const message =
        typeof raw === "string"
          ? (() => {
              try {
                return JSON.parse(raw);
              } catch (e) {
                console.error("[WS] JSON parse error:", e, "raw:", raw);
                return null;
              }
            })()
          : raw;

      if (!message || typeof message !== "object" || !message.type) {
        console.error("[WS] Invalid message:", raw);
        return;
      }

      switch (message.type) {
        // --- find_partner ---
        case "find_partner": {
          const nickname = message.nickname || "Anonymous";
          currentUser.nickname = nickname;

          if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();

            if (!partnerId || partnerId === ws.id || !users.has(partnerId)) {
              waitingQueue.push(ws.id);
              ws.send(
                JSON.stringify({
                  type: "waiting",
                  message: "Waiting for someone...",
                })
              );
              return;
            }

            const partnerUser = users.get(partnerId)!;

            currentUser.partnerId = partnerId;
            partnerUser.partnerId = ws.id;

            console.log(
              `[Match] ${currentUser.nickname} <--> ${partnerUser.nickname}`
            );

            ws.send(
              JSON.stringify({
                type: "matched",
                partnerId,
                partnerNickname: partnerUser.nickname,
                initiator: true, // ฝั่งนี้เป็นคนสร้าง offer
              })
            );

            partnerUser.ws.send(
              JSON.stringify({
                type: "matched",
                partnerId: ws.id,
                partnerNickname: currentUser.nickname,
                initiator: false, // ฝั่งนี้รอ offer
              })
            );
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

        // --- next ---
        case "next": {
          console.log(`[Next] ${currentUser.nickname} wants new partner`);

          // เคลียร์คู่เก่าออกก่อน
          handleDisconnect(ws.id);

          // ลงทะเบียนใหม่ (ใช้ nickname จาก message ถ้ามี)
          users.set(ws.id, {
            id: ws.id,
            ws,
            nickname: message.nickname || currentUser.nickname || "Anonymous",
            partnerId: null,
          });

          const me = users.get(ws.id)!;

          if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();

            if (partnerId && partnerId !== ws.id && users.has(partnerId)) {
              const partnerUser = users.get(partnerId)!;

              me.partnerId = partnerId;
              partnerUser.partnerId = ws.id;

              console.log(
                `[Match-next] ${me.nickname} <--> ${partnerUser.nickname}`
              );

              ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId,
                  partnerNickname: partnerUser.nickname,
                  initiator: true,
                })
              );

              partnerUser.ws.send(
                JSON.stringify({
                  type: "matched",
                  partnerId: ws.id,
                  partnerNickname: me.nickname,
                  initiator: false,
                })
              );
            } else {
              waitingQueue.push(ws.id);
              ws.send(
                JSON.stringify({
                  type: "waiting",
                  message: "Searching...",
                })
              );
            }
          } else {
            waitingQueue.push(ws.id);
            ws.send(
              JSON.stringify({
                type: "waiting",
                message: "Searching...",
              })
            );
          }

          break;
        }

        // --- signaling: offer / answer / ice ---
        case "offer":
        case "answer":
        case "ice": {
          const partnerId = currentUser.partnerId;
          if (!partnerId || !users.has(partnerId)) {
            console.warn(
              `[WS] No partner for ${message.type} from ${currentUser.nickname}`
            );
            return;
          }

          const partner = users.get(partnerId)!;
          partner.ws.send(JSON.stringify(message));
          break;
        }

        default:
          console.warn(`[WS] Unknown message type: ${message.type}`);
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

  // เอาออกจากคิว
  waitingQueue = waitingQueue.filter((id) => id !== userId);

  // แจ้งเตือนฝั่ง partner
  if (user.partnerId && users.has(user.partnerId)) {
    const partner = users.get(user.partnerId)!;
    partner.ws.send(
      JSON.stringify({
        type: "partner_disconnected",
      })
    );
    partner.partnerId = null;
  }

  users.delete(userId);
}
