import type { Context } from "elysia";
import { db } from "../lib/connectdb";
import { hashPassword, verifyPassword, verifyDummy } from "../lib/password";
import { isBanned } from "../lib/moderation";

interface AuthBody {
  username: string;
  password: string;
}

// jwt ถูก inject เข้ามาจาก @elysiajs/jwt plugin
// ระบุ payload เป็นรูปธรรม (ไม่ใช่ Record<string, unknown>) เพื่อให้ตรงกับ signature
// ของ plugin ที่ไม่รับค่า unknown
type JwtSigner = {
  sign: (payload: { sub: string; username: string }) => Promise<string>;
};

export const Usercontroller = {
  signup: async ({
    body,
    set,
  }: {
    body: AuthBody;
    set: Context["set"];
  }) => {
    const username = body.username?.trim();
    const { password } = body;

    if (!username || !password) {
      set.status = 400;
      return { message: "All fields are required" };
    }

    try {
      const existing = await db.query(
        "SELECT id FROM users WHERE username = $1",
        [username],
      );
      if (existing.rows.length > 0) {
        set.status = 409;
        return { message: "User already exists" };
      }

      const hashedPassword = await hashPassword(password);

      // ส่งค่าผ่าน parameterized query + RETURNING เฉพาะ field ที่ปลอดภัย
      // (ห้าม return password hash กลับไปเด็ดขาด)
      const result = await db.query(
        "INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username, created_at",
        [username, hashedPassword],
      );

      set.status = 201;
      return { message: "Successfully registered", user: result.rows[0] };
    } catch (err) {
      console.error("[signup] error:", err);
      set.status = 500;
      return { message: "Internal server error" };
    }
  },

  signin: async ({
    body,
    set,
    jwt,
  }: {
    body: AuthBody;
    set: Context["set"];
    jwt: JwtSigner;
  }) => {
    const username = body.username?.trim();
    const { password } = body;

    if (!username || !password) {
      set.status = 400;
      return { message: "All fields are required" };
    }

    try {
      const result = await db.query(
        "SELECT id, username, password FROM users WHERE username = $1",
        [username],
      );
      const user = result.rows[0];

      // ใช้ข้อความ error เดียวกันทั้งกรณีไม่มี user และรหัสผิด
      // เพื่อไม่ให้เดาได้ว่า username ไหนมีอยู่จริง (user enumeration)
      // ถ้าไม่มี user ก็ยัง verify กับ dummy hash เพื่อให้เวลาตอบสนองเท่ากัน
      let valid = false;
      if (user) {
        valid = await verifyPassword(password, user.password);
      } else {
        await verifyDummy(password);
      }

      if (!user || !valid) {
        set.status = 401;
        return { message: "Invalid username or password" };
      }

      // ไม่ออก token ให้บัญชีที่ถูกแบน — ไม่งั้นเอา token ไปใช้ต่อกับ /me/* ได้
      if (isBanned(Number(user.id), "")) {
        set.status = 403;
        return { message: "บัญชีนี้ถูกระงับการใช้งาน" };
      }

      const token = await jwt.sign({ sub: String(user.id), username: user.username });

      return {
        message: "Login successful",
        token,
        user: { id: user.id, username: user.username },
      };
    } catch (err) {
      console.error("[signin] error:", err);
      set.status = 500;
      return { message: "Internal server error" };
    }
  },
};
