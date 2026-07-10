import { AppError } from "./errors.js";

const ALLOWED_TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com"
]);

export function validateTikTokUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new AppError("INVALID_URL", "Enter a valid public TikTok video URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new AppError("INVALID_URL", "Enter a valid public TikTok video URL.");
  }

  if (parsed.protocol !== "https:" || !ALLOWED_TIKTOK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new AppError("INVALID_URL", "Enter a valid public TikTok video URL.");
  }

  return parsed.toString();
}

export function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "video";
}

export function validateCompressionMode(value: unknown): "adaptive" | "keep-1080p" {
  return value === "keep-1080p" ? "keep-1080p" : "adaptive";
}

export function validateSizePer20Seconds(value: unknown): number {
  const parsed = Number(value ?? 1);
  if (![1, 2, 3].includes(parsed)) return 1;
  return parsed;
}
