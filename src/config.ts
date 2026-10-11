import { z } from "zod";

const ConfigSchema = z.object({
  PENNY_TRANSPORT: z.enum(["imessage", "terminal"]).default("imessage"),
  PENNY_INTERPRETER: z.enum(["gemini", "local"]).default("gemini"),
  SPECTRUM_PROJECT_ID: z.string().optional(),
  SPECTRUM_PROJECT_SECRET: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  GEMINI_FALLBACK_MODELS: z.string().default("gemini-3.6-flash"),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(12_000),
  GEMINI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(4).default(2),
  AUTH0_DOMAIN: z.string().optional(),
  AUTH0_CLIENT_ID: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  CONSENT_VERSION: z.string().default("2026-10-11"),
});

export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(environment: NodeJS.ProcessEnv): Config {
  return ConfigSchema.parse(environment);
}
export function validateRuntimeConfig(config: Config): void {
  if (config.PENNY_TRANSPORT === "imessage" && !config.DATABASE_URL)
    throw new Error("DATABASE_URL is required for the iMessage deployment");
}
export function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
