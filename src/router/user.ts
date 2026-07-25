import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { Usercontroller } from "../controller/user";
import { env } from "../config/env";
import { TokenBucket, startSweeper } from "../lib/ratelimit";
import { clientIp } from "../lib/clientip";

// schema ใช้ร่วมกันทั้ง signup/signin พร้อมจำกัดความยาว
const credentialsBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 32 }),
  password: t.String({ minLength: 8, maxLength: 128 }),
});

// การ hash รหัสผ่านใช้เวลา ~190ms ต่อครั้ง ถึงจะย้ายไปรันบน thread pool แล้ว
// (ไม่บล็อก event loop) แต่ก็ยังเป็นงานหนักที่ยิงถล่มได้ และ signup ยังสร้างแถวใหม่
// ได้ไม่จำกัดด้วย จึงต้องจำกัดต่อ IP
// signup: burst 5 ครั้ง เติมคืน 1 ครั้ง/นาที
const signupBucket = new TokenBucket(5, 1 / 60);
// signin: ผ่อนกว่าเพราะพิมพ์รหัสผิดเป็นเรื่องปกติ — burst 10 ครั้ง เติมคืน 1 ครั้ง/6 วินาที
const signinBucket = new TokenBucket(10, 1 / 6);

startSweeper([signupBucket, signinBucket], 5 * 60_000);

const limitBy = (bucket: TokenBucket, message: string) =>
  ({ headers, server, request, set }: any) => {
    const ip = clientIp(headers, server?.requestIP(request)?.address);
    if (!bucket.allow(ip)) {
      set.status = 429;
      return { message };
    }
  };

export const Auth = new Elysia()
  .use(
    jwt({
      name: "jwt",
      secret: env.JWT_SECRET,
      exp: env.JWT_EXPIRES_IN,
    }),
  )
  .group("/auth", (app) =>
    app
      .post("/signup", Usercontroller.signup, {
        body: credentialsBody,
        beforeHandle: limitBy(
          signupBucket,
          "สมัครสมาชิกถี่เกินไป กรุณารอสักครู่",
        ),
      })
      .post("/signin", Usercontroller.signin, {
        body: credentialsBody,
        beforeHandle: limitBy(
          signinBucket,
          "เข้าสู่ระบบถี่เกินไป กรุณารอสักครู่",
        ),
      }),
  );
