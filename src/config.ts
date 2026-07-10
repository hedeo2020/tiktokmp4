import "dotenv/config";
import path from "node:path";

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: numberFromEnv("PORT", 3000),
  tikwmApiBase: process.env.TIKWM_API_BASE ?? "https://api.tikwmapi.com",
  tikwmApiKey: process.env.TIKWM_API_KEY ?? "",
  maxDurationSeconds: numberFromEnv("MAX_DURATION_SECONDS", 180),
  maxSourceSizeMb: numberFromEnv("MAX_SOURCE_SIZE_MB", 500),
  maxConcurrentJobs: numberFromEnv("MAX_CONCURRENT_JOBS", 1),
  tempDirectory:
    process.env.TEMP_DIRECTORY ?? path.join(process.cwd(), "temp"),
  jobTimeoutSeconds: numberFromEnv("JOB_TIMEOUT_SECONDS", 600),
  rateLimitRequests: numberFromEnv("RATE_LIMIT_REQUESTS", 60),
  rateLimitWindowMinutes: numberFromEnv("RATE_LIMIT_WINDOW_MINUTES", 15),
  ffmpegThreads: numberFromEnv("FFMPEG_THREADS", 1)
} as const;

export function requireTikwmApiKey(): void {
  if (!config.tikwmApiKey || config.tikwmApiKey === "replace_this") {
    throw new Error("TIKWM_API_KEY is not configured.");
  }
}
