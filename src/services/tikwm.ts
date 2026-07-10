import { config, requireTikwmApiKey } from "../config.js";
import { AppError } from "../utilities/errors.js";

export interface TikwmVideo {
  id: string;
  title: string;
  duration: number;
  cover?: string;
  hdplay: string;
  hdSize?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function fetchTikwmVideo(url: string, signal?: AbortSignal): Promise<TikwmVideo> {
  requireTikwmApiKey();
  const endpoint = new URL(config.tikwmApiBase);
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("hd", "1");

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        "x-tikwmapi-key": config.tikwmApiKey,
        "user-agent": "TikTokHDCompressor/1.0"
      },
      signal
    });
  } catch {
    throw new AppError("API_ERROR", "Could not contact the video metadata service.", 502);
  }

  if (!response.ok) {
    throw new AppError("API_ERROR", "The video metadata service returned an error.", 502);
  }

  const payload = (await response.json().catch(() => undefined)) as unknown;
  if (!isRecord(payload) || payload.code !== 0) {
    throw new AppError("VIDEO_NOT_FOUND", "The TikTok video could not be found.", 404);
  }

  const data = payload.data;
  if (!isRecord(data)) {
    throw new AppError("VIDEO_NOT_FOUND", "The TikTok video could not be found.", 404);
  }

  const hdplay = data.hdplay;
  const duration = Number(data.duration);
  if (typeof hdplay !== "string" || hdplay.length === 0) {
    throw new AppError("HD_LINK_MISSING", "This video does not have an HD download link.", 404);
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError("VIDEO_NOT_FOUND", "The TikTok video duration could not be read.", 404);
  }

  if (duration > config.maxDurationSeconds) {
    throw new AppError("VIDEO_TOO_LONG", `Videos must be ${config.maxDurationSeconds} seconds or shorter.`, 413);
  }

  return {
    id: typeof data.id === "string" ? data.id : "video",
    title: typeof data.title === "string" ? data.title : "TikTok video",
    duration,
    cover: typeof data.cover === "string" ? data.cover : undefined,
    hdplay,
    hdSize: Number.isFinite(Number(data.hd_size)) ? Number(data.hd_size) : undefined
  };
}
