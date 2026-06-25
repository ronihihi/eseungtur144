import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { RegisterBody, LoginBody } from "@workspace/api-zod";
import type { Request, Response } from "express";
import { authRateLimit } from "../lib/rateLimiters.js";

const router: IRouter = Router();

const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const AZURE_REDIRECT_URI = process.env.AZURE_REDIRECT_URI;

declare module "express-session" {
  interface SessionData {
    userId: string;
    userName: string;
    userEmail: string;
    userRole: string;
    hasSavedSignature: boolean;
    emailVerified: boolean;
    oauthState?: string;
  }
}

function azureConfigured(): boolean {
  return !!(AZURE_TENANT_ID && AZURE_CLIENT_ID && AZURE_CLIENT_SECRET);
}

function getAzureRedirectUri(req: Request): string {
  return AZURE_REDIRECT_URI || `${req.protocol}://${req.get("host")}/api/auth/azure/callback`;
}

function parseJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
}

// SEC-1: Rotate session ID before writing identity fields — prevents session fixation.
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve()))
  );
}

// SEC-7: Pre-computed dummy hash to equalise timing for unknown-email login paths.
const DUMMY_HASH = "$2a$10$abcdefghijklmnopqrstuuJK3fWxKT3kpVGCUB2gTR6cVMl3Nh9O";

router.post("/auth/register", authRateLimit, async (req: Request, res: Response) => {
  try {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "All fields are required and password must be at least 6 characters" });
      return;
    }
    const { name, password } = parsed.data;
    const email = parsed.data.email.toLowerCase();

    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing.length > 0) {
      res.status(400).json({ error: "Email already registered" });
      return;
    }

    // SEC-6: First-user admin bootstrap — require BOOTSTRAP_ADMIN_TOKEN when set in env.
    const firstUser = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    let role = "user";
    if (firstUser.length === 0) {
      const bootstrapToken = process.env.BOOTSTRAP_ADMIN_TOKEN;
      const provided = (req.body as { bootstrapToken?: string }).bootstrapToken;
      if (!bootstrapToken || provided === bootstrapToken) {
        role = "admin";
      }
    }

    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    await db.insert(usersTable).values({ id, name, email, password: hashed, role, provider: "local", emailVerified: false });

    // SEC-1: Rotate session ID before writing identity to prevent session fixation.
    await regenerateSession(req);
    req.session.userId = id;
    req.session.userName = name;
    req.session.userEmail = email;
    req.session.userRole = role;
    req.session.hasSavedSignature = false;
    req.session.emailVerified = false;

    res.json({ success: true, user: { id, name, email, role, hasSavedSignature: false } });
  } catch (err) {
    req.log.error({ err }, "register error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/auth/login", authRateLimit, async (req: Request, res: Response) => {
  try {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }
    // BUG-1: Normalise case — registration always lowercases; login must match.
    const email = parsed.data.email.toLowerCase();
    const { password } = parsed.data;

    const users = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    const user = users[0];

    // SEC-7: Run dummy bcrypt to equalise response time regardless of whether
    // the account exists or uses a non-local provider.
    if (!user || user.provider !== "local" || !user.password) {
      await bcrypt.compare(password, DUMMY_HASH);
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // SEC-1: Rotate session ID before writing identity to prevent session fixation.
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;
    req.session.userRole = user.role;
    req.session.hasSavedSignature = !!user.signatureData;
    req.session.emailVerified = user.emailVerified ?? false;

    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, hasSavedSignature: !!user.signatureData } });
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
      role: req.session.userRole ?? "user",
      hasSavedSignature: !!req.session.hasSavedSignature,
    },
  });
});

router.get("/auth/me/signature", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  try {
    const users = await db.select({ signatureData: usersTable.signatureData }).from(usersTable).where(eq(usersTable.id, req.session.userId)).limit(1);
    res.json({ signatureData: users[0]?.signatureData ?? null });
  } catch (err) {
    req.log.error({ err }, "get signature error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/auth/me/signature", async (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const { signatureData } = req.body as { signatureData?: string };
  // HARD-4: Cap stored signature size to prevent oversized DB rows.
  if (!signatureData || signatureData.length > 300_000) {
    res.status(400).json({ error: "signatureData is required and must be under ~200 KB" });
    return;
  }
  try {
    await db.update(usersTable).set({ signatureData }).where(eq(usersTable.id, req.session.userId));
    req.session.hasSavedSignature = true;
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "save signature error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Azure SSO ─────────────────────────────────────────────────────────────────

router.get("/auth/azure-enabled", (_req: Request, res: Response) => {
  res.json({ enabled: azureConfigured() });
});

router.get("/auth/azure", authRateLimit, (req: Request, res: Response) => {
  if (!azureConfigured()) {
    res.status(503).json({ error: "Azure SSO is not configured" });
    return;
  }
  const state = uuidv4();
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: AZURE_CLIENT_ID!,
    response_type: "code",
    redirect_uri: getAzureRedirectUri(req),
    scope: "openid profile email",
    state,
    response_mode: "query",
  });
  res.redirect(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/authorize?${params}`);
});

router.get("/auth/azure/callback", async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.redirect(`/auth?error=${encodeURIComponent(error)}`);
    return;
  }
  if (!state || state !== req.session.oauthState) {
    res.redirect("/auth?error=invalid_state");
    return;
  }
  delete req.session.oauthState;

  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: AZURE_CLIENT_ID!,
          client_secret: AZURE_CLIENT_SECRET!,
          code,
          redirect_uri: getAzureRedirectUri(req),
          grant_type: "authorization_code",
        }),
      }
    );

    const tokens = (await tokenRes.json()) as Record<string, unknown>;
    if (tokens.error) {
      throw new Error((tokens.error_description as string) || (tokens.error as string));
    }

    const idToken = parseJwt(tokens.id_token as string);
    const azureId = idToken.oid as string;
    const rawEmail = ((idToken.email ?? idToken.preferred_username) as string) ?? "";
    const email = rawEmail.toLowerCase();
    const name = (idToken.name as string) || email;

    // Find only by azureId — never auto-link by email to prevent pre-account takeover
    let users = await db.select().from(usersTable).where(eq(usersTable.azureId, azureId)).limit(1);

    if (users.length === 0) {
      // Refuse if another account already owns this email address.
      // Without verified proof of prior ownership we must not silently merge identities.
      const byEmail = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (byEmail.length > 0) {
        res.redirect("/auth?error=account_conflict");
        return;
      }
      const firstUser = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
      const role = firstUser.length === 0 ? "admin" : "user";
      const id = uuidv4();
      await db.insert(usersTable).values({ id, name, email, role, provider: "azure", azureId });
      users = [{ id, name, email, role, provider: "azure", azureId, password: null, signatureData: null, emailVerified: true, createdAt: new Date() }];
    }

    const user = users[0];
    // SEC-1: Rotate session ID before writing identity to prevent session fixation.
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;
    req.session.userRole = user.role;
    req.session.hasSavedSignature = !!user.signatureData;
    req.session.emailVerified = true;

    res.redirect("/");
  } catch (err) {
    req.log.error({ err }, "azure callback error");
    res.redirect("/auth?error=azure_failed");
  }
});

export default router;
