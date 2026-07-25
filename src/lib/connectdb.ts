import { Pool, types, type PoolConfig } from "pg";
import { env } from "../config/env";

// node-pg คืนค่า BIGINT เป็น string เสมอ (เพราะกลัวเกินช่วงของ JS number)
// ทำให้ id ที่ส่งออกไปทาง JSON เป็น "3" ไม่ใช่ 3 — client ที่เอาค่านั้นยิงกลับ
// เข้า endpoint ที่ประกาศ type เป็น number จะโดน validator ปฏิเสธ
// id ในระบบนี้ไม่มีทางเกิน 2^53 จึงแปลงเป็น number ได้อย่างปลอดภัย
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

// ใช้ DATABASE_URL ถ้ามี (มาตรฐานของ managed Postgres ส่วนใหญ่)
// ไม่งั้นประกอบจากค่ารายตัว
const baseConfig: PoolConfig = env.DATABASE_URL
  ? { connectionString: env.DATABASE_URL }
  : {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
    };

const pool = new Pool({
  ...baseConfig,
  // ทุกการจับคู่เขียน 2 แถว และทุกการกด next อัปเดต 2 แถว — เมื่อคนเยอะขึ้น
  // จำนวนนี้คือคอขวด ปรับผ่าน DB_POOL_MAX ให้พอดีกับ max_connections ของ Postgres
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30000, // ปิด idle connection หลัง 30 วินาที
  connectionTimeoutMillis: 5000, // timeout สำหรับการขอ connection
  // managed Postgres ส่วนใหญ่บังคับ SSL ใน production
  ssl: env.isProd ? { rejectUnauthorized: false } : undefined,
});

// Handle error จาก idle clients
// อย่า process.exit() — error ของ client ตัวเดียวไม่ควรล้มทั้งเซิร์ฟเวอร์
// pool จะสร้าง connection ใหม่ให้เองเมื่อมี query เข้ามา
pool.on("error", (err: Error) => {
  console.error("[db] Unexpected error on idle client:", err.message);
});

// ตรวจการเชื่อมต่อตอน boot เพื่อให้รู้ปัญหาเร็ว (ไม่ throw — แค่ log)
pool
  .query("SELECT 1")
  .then(() => console.log("[db] Connected to PostgreSQL"))
  .catch((err) =>
    console.error("[db] Initial connection check failed:", err.message),
  );

// ปิด pool ตอน shutdown
export async function closeDb() {
  await pool.end();
}

// ไม่ต้อง connect() แบบ manual ใช้ pool.query() ได้เลย
export { pool as db };
