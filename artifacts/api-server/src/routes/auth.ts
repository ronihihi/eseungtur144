import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { RegisterBody, LoginBody } from "@workspace/api-zod";
import type { Request, Response } from "express";

const router: IRouter = Router();

declare module "express-session" {
  interface SessionData {
    userId: string;
    userName: string;
    userEmail: string;
  }
}

router.post("/auth/register", async (req: Request, res: Response) => {
  try {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "All fields are required and password must be at least 6 characters" });
      return;
    }
    const { name, email, password } = parsed.data;

    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing.length > 0) {
      res.status(400).json({ error: "Email already registered" });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    await db.insert(usersTable).values({ id, name, email, password: hashed, role: "admin" });

    req.session.userId = id;
    req.session.userName = name;
    req.session.userEmail = email;

    res.json({ success: true, user: { id, name, email } });
  } catch (err) {
    req.log.error({ err }, "register error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/auth/login", async (req: Request, res: Response) => {
  try {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }
    const { email, password } = parsed.data;

    const users = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (users.length === 0) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const user = users[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;

    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    req.log.error({ err }, "login error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/auth/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

router.get("/auth/me", (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  if (!req.session.userId) {
    res.json({ user: null });
    return;
  }
  res.json({
    user: {
      id: req.session.userId,
      name: req.session.userName,
      email: req.session.userEmail,
    },
  });
});

export default router;
