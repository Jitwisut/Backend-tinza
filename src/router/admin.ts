// src/router/admin.ts
// endpoint สำหรับแอดมินตรวจ report และจัดการแบน
//
// ป้องกันด้วย ADMIN_TOKEN ใน header `x-admin-token` — ถ้าไม่ได้ตั้ง env นี้
// endpoint ทั้งกลุ่มจะตอบ 404 เหมือนไม่มีอยู่จริง (ปลอดภัยกว่าเปิดทิ้งไว้เฉยๆ)
import { Elysia, t } from "elysia";
import { timingSafeEqual } from "crypto";
import { env } from "../config/env";
import {
  createBan,
  liftBan,
  listBans,
  listReports,
  setReportStatus,
  banCacheStats,
} from "../lib/moderation";

// เทียบ token แบบ constant-time กัน timing attack
function tokenMatches(provided: string | undefined): boolean {
  if (!provided || !env.ADMIN_TOKEN) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(env.ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Admin = new Elysia({ prefix: "/admin" })
  .onBeforeHandle(({ headers, set }) => {
    // ไม่ได้ตั้ง ADMIN_TOKEN = ปิดใช้งานทั้งกลุ่ม ไม่ใช่เปิดให้ทุกคน
    if (!env.ADMIN_TOKEN) {
      set.status = 404;
      return { message: "Not found" };
    }
    if (!tokenMatches(headers["x-admin-token"])) {
      set.status = 401;
      return { message: "Unauthorized" };
    }
  })

  // GET /admin/reports?status=pending — คิว report ที่รอตรวจ
  .get(
    "/reports",
    async ({ query }) => ({
      reports: await listReports(query.status ?? "pending", 100),
    }),
    {
      query: t.Object({
        status: t.Optional(
          t.Union([
            t.Literal("pending"),
            t.Literal("reviewed"),
            t.Literal("dismissed"),
          ]),
        ),
      }),
    },
  )

  // PATCH /admin/reports/:id — ปิดงาน report (reviewed / dismissed)
  .patch(
    "/reports/:id",
    async ({ params, body, set }) => {
      const ok = await setReportStatus(Number(params.id), body.status);
      if (!ok) {
        set.status = 404;
        return { message: "Report not found" };
      }
      return { message: "Report updated" };
    },
    {
      params: t.Object({ id: t.Numeric() }),
      body: t.Object({
        status: t.Union([t.Literal("reviewed"), t.Literal("dismissed")]),
      }),
    },
  )

  // GET /admin/bans — รายชื่อที่ยังโดนแบนอยู่
  .get("/bans", async () => ({
    bans: await listBans(200),
    cache: banCacheStats(),
  }))

  // POST /admin/bans — แบนด้วยมือ (ระบุ userId หรือ ip อย่างน้อยหนึ่งอย่าง)
  .post(
    "/bans",
    async ({ body, set }) => {
      if (body.userId === undefined && body.ip === undefined) {
        set.status = 400;
        return { message: "ต้องระบุ userId หรือ ip อย่างน้อยหนึ่งอย่าง" };
      }
      const id = await createBan({
        userId: body.userId ?? null,
        ip: body.ip ?? null,
        reason: body.reason,
        createdBy: "admin",
        hours: body.hours ?? null,
      });
      if (id === null) {
        set.status = 500;
        return { message: "สร้างแบนไม่สำเร็จ" };
      }
      set.status = 201;
      return { message: "Banned", id };
    },
    {
      body: t.Object({
        userId: t.Optional(t.Number()),
        ip: t.Optional(t.String({ maxLength: 64 })),
        reason: t.String({ minLength: 1, maxLength: 200 }),
        // ไม่ระบุ = แบนถาวร
        hours: t.Optional(t.Number({ minimum: 1 })),
      }),
    },
  )

  // DELETE /admin/bans/:id — ปลดแบน
  .delete(
    "/bans/:id",
    async ({ params, set }) => {
      const ok = await liftBan(Number(params.id));
      if (!ok) {
        set.status = 404;
        return { message: "Ban not found" };
      }
      return { message: "Ban lifted" };
    },
    { params: t.Object({ id: t.Numeric() }) },
  );
