import { Pool } from "pg";

const pool = new Pool({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: process.env.DB_Password,
  database: "tinza",
  max: 20, // จำนวน connections สูงสุดใน pool
  idleTimeoutMillis: 30000, // ปิด idle connection หลัง 30 วินาที
  connectionTimeoutMillis: 2000, // timeout สำหรับการเชื่อมต่อ
});

// Handle error จาก idle clients
pool.on("error", (err: Error, client: any) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

// ไม่ต้อง connect() แบบ manual
// ใช้ pool.query() ได้เลย
export { pool as db };
