import dns from "node:dns/promises";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../utilities/errors.js";
import { config } from "../config.js";

export function isPrivateOrReservedIp(address: string): boolean {
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.") ||
      lower.startsWith("::ffff:169.254.")
    );
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

async function assertPublicHttpsUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError("DOWNLOAD_FAILED", "The HD video URL is invalid.", 502);
  }

  if (parsed.protocol !== "https:") {
    throw new AppError("DOWNLOAD_FAILED", "The HD video URL must use HTTPS.", 502);
  }

  const addresses = await dns.lookup(parsed.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((entry) => isPrivateOrReservedIp(entry.address))) {
    throw new AppError("DOWNLOAD_FAILED", "The HD video URL points to a blocked network address.", 502);
  }

  return parsed;
}

export async function downloadVideo(sourceUrl: string, destinationPath: string, signal: AbortSignal): Promise<number> {
  let currentUrl = await assertPublicHttpsUrl(sourceUrl);
  const maxBytes = config.maxSourceSizeMb * 1024 * 1024;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; TikTokHDCompressor/1.0)",
          accept: "video/*,*/*;q=0.8"
        }
      });
    } catch {
      throw new AppError("DOWNLOAD_FAILED", "Could not download the HD source video.", 502);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new AppError("DOWNLOAD_FAILED", "The HD source redirected without a destination.", 502);
      currentUrl = await assertPublicHttpsUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok || !response.body) {
      throw new AppError("DOWNLOAD_FAILED", "Could not download the HD source video.", 502);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("video") && !contentType.includes("octet-stream")) {
      throw new AppError("DOWNLOAD_FAILED", "The HD source did not return a video file.", 502);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new AppError("SOURCE_TOO_LARGE", "The HD source video is too large.", 413);
    }

    let downloadedBytes = 0;
    const source = Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      if (downloadedBytes > maxBytes) {
        source.destroy(new AppError("SOURCE_TOO_LARGE", "The HD source video is too large.", 413));
      }
    });

    await pipeline(source, fs.createWriteStream(destinationPath)).catch((error) => {
      if (error instanceof AppError) throw error;
      throw new AppError("DOWNLOAD_FAILED", "Could not save the HD source video.", 502);
    });

    return downloadedBytes;
  }

  throw new AppError("DOWNLOAD_FAILED", "The HD source redirected too many times.", 502);
}
