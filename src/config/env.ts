import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  REDIS_URL: z.string().default("redis://localhost:6379"),
  CACHE_TTL_SECONDS: z.coerce.number().default(300),

  BROWSER_HEADLESS: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  BROWSER_POOL_SIZE: z.coerce.number().min(1).max(10).default(2),
  BROWSER_TIMEOUT_MS: z.coerce.number().default(30000),

  REQUEST_DELAY_MS: z.coerce.number().default(2000),
  MAX_RETRIES: z.coerce.number().default(3),

  PROXY_URL: z.string().optional(),

  RATE_LIMIT_MAX: z.coerce.number().default(30),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten());
  process.exit(1);
}

export const env = parsed.data;
