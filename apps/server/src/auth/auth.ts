import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  account,
  session as sessionTable,
  user,
  verification,
} from "../database/schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });
const production = process.env.NODE_ENV === "production";
const secret = process.env.BETTER_AUTH_SECRET;
if (production && (!secret || secret.length < 32)) {
  throw new Error(
    "BETTER_AUTH_SECRET must contain at least 32 characters in production."
  );
}

async function writeAuthAudit(
  action: string,
  actorId: string | null,
  statusCode: number
) {
  await pool.query(
    "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,$2,'AUTH',NULL,$3::jsonb)",
    [actorId, action, JSON.stringify({ method: "email", statusCode })]
  );
}

export const recordFailedLogin = (statusCode: number) =>
  writeAuthAudit("LOGIN_FAILED", null, statusCode);

export const createAuth = (disableSignUp: boolean) =>
  betterAuth({
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { account, session: sessionTable, user, verification },
    }),
    databaseHooks: {
      session: {
        create: {
          after: async (session, context) => {
            if (context?.path === "/sign-in/email") {
              await writeAuthAudit("LOGIN_SUCCEEDED", session.userId, 200);
            }
          },
        },
        delete: {
          after: async (session, context) => {
            if (context?.path === "/sign-out") {
              await writeAuthAudit("LOGOUT_SUCCEEDED", session.userId, 200);
            }
          },
        },
      },
    },
    emailAndPassword: { disableSignUp, enabled: true, minPasswordLength: 12 },
    rateLimit: {
      customRules: { "/sign-in/email": { max: 5, window: 60 } },
      enabled: true,
      max: 100,
      window: 60,
    },
    secret: secret || "development-only-change-me-at-least-32-characters",
    trustedOrigins: (
      process.env.TRUSTED_ORIGINS ??
      "http://localhost:5176,http://localhost:3000"
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    user: {
      additionalFields: {
        role: {
          defaultValue: "PRESALES",
          input: false,
          required: false,
          type: "string",
        },
      },
    },
    useSecureCookies: production,
  });

export const auth = createAuth(true);
export const adminAuth = createAuth(false);
