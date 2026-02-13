import { z } from "zod";
import { loadEnvUpwards } from "./utils/env.js";

loadEnvUpwards(import.meta.url);

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(5_000),
  MAX_SPREAD_PP: z.coerce.number().nonnegative().default(15),
  ENABLE_OPINION: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  OPINION_API_KEY: z.string().optional(),
  TELEGRAM_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_MODE: z.enum(["bot", "user"]).optional(),
  TELEGRAM_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_SESSION: z.string().optional(),
  TELEGRAM_TARGET: z.string().optional(),
  TELEGRAM_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(30)
});

export type Config = z.infer<typeof configSchema>;

export const config: Config = configSchema.parse(process.env);
