// src/router/me.ts
// Endpoints ของผู้ใช้ที่ login แล้ว (Phase 3) — ต้องแนบ Bearer token
import { Elysia, t } from "elysia";
import { Mecontroller } from "../controller/me";
import { verifyJwt, bearerFromHeader } from "../lib/jwt";

export const Me = new Elysia({ prefix: "/me" })
  // resolve userId จาก Authorization header; ถ้าไม่ถูกต้องตอบ 401 ทันที
  .resolve(({ headers, set }) => {
    const token = bearerFromHeader(headers.authorization);
    const payload = verifyJwt(token);
    if (!payload) {
      set.status = 401;
      // throw เพื่อตัด request ก่อนถึง handler (Elysia จับเป็น error)
      throw new Error("Unauthorized");
    }
    return { userId: Number(payload.sub) };
  })
  .onError(({ error, set }) => {
    if (error instanceof Error && error.message === "Unauthorized") {
      set.status = 401;
      return { message: "Unauthorized" };
    }
  })
  .get("/", Mecontroller.get)
  .patch("/", Mecontroller.update, {
    body: t.Object({
      display_name: t.Optional(t.String({ maxLength: 48 })),
      bio: t.Optional(t.String({ maxLength: 300 })),
      avatar_seed: t.Optional(t.String({ maxLength: 64 })),
      gender: t.Optional(
        t.Union([
          t.Literal("male"),
          t.Literal("female"),
          t.Literal("other"),
          t.Literal("prefer_not"),
        ]),
      ),
    }),
  })
  .get("/likes", Mecontroller.likes)
  .get("/friends", Mecontroller.friends)
  .get("/calls", Mecontroller.calls);
