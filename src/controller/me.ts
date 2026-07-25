import type { Context } from "elysia";
import { db } from "../lib/connectdb";

// คอลัมน์ profile ที่ปลอดภัยจะส่งกลับ client (ห้ามมี password)
const PUBLIC_COLUMNS =
  "id, username, display_name, bio, avatar_seed, gender, created_at";

type MeArgs = {
  userId: number;
  set: Context["set"];
};

export const Mecontroller = {
  // GET /me — ข้อมูลโปรไฟล์ตัวเอง
  get: async ({ userId, set }: MeArgs) => {
    try {
      const result = await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`,
        [userId],
      );
      if (result.rows.length === 0) {
        set.status = 404;
        return { message: "User not found" };
      }
      return { user: result.rows[0] };
    } catch (err) {
      console.error("[me.get] error:", err);
      set.status = 500;
      return { message: "Internal server error" };
    }
  },

  // PATCH /me — แก้ display_name / bio / avatar_seed / gender
  update: async ({
    userId,
    body,
    set,
  }: MeArgs & {
    body: {
      display_name?: string;
      bio?: string;
      avatar_seed?: string;
      gender?: string;
    };
  }) => {
    // อัปเดตเฉพาะ field ที่ส่งมา (build query แบบ dynamic แต่ใช้ whitelist กัน injection)
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    const allowed: Array<[keyof typeof body, string]> = [
      ["display_name", "display_name"],
      ["bio", "bio"],
      ["avatar_seed", "avatar_seed"],
      ["gender", "gender"],
    ];

    for (const [key, column] of allowed) {
      if (body[key] !== undefined) {
        fields.push(`${column} = $${i++}`);
        values.push(body[key]);
      }
    }

    if (fields.length === 0) {
      set.status = 400;
      return { message: "No fields to update" };
    }

    values.push(userId);
    try {
      const result = await db.query(
        `UPDATE users SET ${fields.join(", ")} WHERE id = $${i} RETURNING ${PUBLIC_COLUMNS}`,
        values,
      );
      if (result.rows.length === 0) {
        set.status = 404;
        return { message: "User not found" };
      }
      return { message: "Profile updated", user: result.rows[0] };
    } catch (err) {
      console.error("[me.update] error:", err);
      set.status = 500;
      return { message: "Internal server error" };
    }
  },

  // GET /me/likes — คนที่เรากดถูกใจ
  likes: async ({ userId, set }: MeArgs) => {
    try {
      const result = await db.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_seed, l.created_at
           FROM likes l
           JOIN users u ON u.id = l.to_user_id
          WHERE l.from_user_id = $1
          ORDER BY l.created_at DESC`,
        [userId],
      );
      return { likes: result.rows };
    } catch (err) {
      console.error("[me.likes] error:", err);
      set.status = 500;
      return { message: "Internal server error" };
    }
  },

  // GET /me/friends — เพื่อน (mutual like)
  friends: async ({ userId, set }: MeArgs) => {
    try {
      const result = await db.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_seed, f.since
           FROM friends f
           JOIN users u ON u.id = f.friend_id
          WHERE f.user_id = $1
          ORDER BY f.since DESC`,
        [userId],
      );
      return { friends: result.rows };
    } catch (err) {
      console.error("[me.friends] error:", err);
      set.status = 500;
      return { message: "Internal server error" };
    }
  },

  // GET /me/calls — ประวัติการคุยของตัวเอง
  calls: async ({ userId, set }: MeArgs) => {
    try {
      const result = await db.query(
        `SELECT c.id,
                c.started_at,
                c.ended_at,
                u.id AS peer_user_id,
                u.username AS peer_username,
                u.display_name AS peer_display_name,
                u.avatar_seed AS peer_avatar_seed
           FROM calls c
      LEFT JOIN users u ON u.id = c.peer_user_id
          WHERE c.user_id = $1
          ORDER BY c.started_at DESC
          LIMIT 100`,
        [userId],
      );
      return { calls: result.rows };
    } catch (err) {
      console.error("[me.calls] error:", err);
      set.status = 500;
      return { message: "Internal server error" };
    }
  },
};
