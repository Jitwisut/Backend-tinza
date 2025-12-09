import { Elysia, t } from "elysia";
import { Usercontroller } from "../controller/user";

export const Auth = (app: Elysia) => {
  app.group("/auth", (app) => {
    app
      .post("/signup", Usercontroller.signup, {
        body: t.Object({
          username: t.String(),
          password: t.String(),
        }),
      })
      .post("/signin", Usercontroller.signin, {
        body: t.Object({
          username: t.String(),
          password: t.String(),
        }),
      });
    return app;
  });
  return app;
};
