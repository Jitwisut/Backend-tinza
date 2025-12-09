import bcrypt from "bcryptjs";
import { Context } from "elysia";
import { db } from "../lib/connectdb";
interface Loginbody {
  username: string;
  password: string;
}
export const Usercontroller = {
  signup: async ({
    body,
    set,
  }: {
    body: { username: string; password: string };
    set: Context["set"];
  }) => {
    const { username, password } = body;
    if (!username || !password) {
      set.status = 401;
      return { message: "All fields are required" };
    }
    const query = "SELECT username FROM users WHERE username=$1";
    const exituser = await db.query(query, [username]);
    if (exituser.rows.length > 0) {
      set.status = 400;
      return { message: "User already exists" };
    }
    const hasspass = await bcrypt.hash(password, 20);
    const user = await db.query(
      "INSERT INTO users (username,password) VALUES ($1,$2)"
    );
    return { message: "Succesfully", user: user.rows[0] };
  },
  signin: async ({ body, set }: { body: Loginbody; set: Context["set"] }) => {
    const { username, password } = body;

    if (!username || !password) {
      throw new Error("Please Enter All input");
    }
  },
};
