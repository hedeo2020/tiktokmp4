import type { Response } from "express";

export type ErrorCode =
  | "INVALID_URL"
  | "API_ERROR"
  | "VIDEO_NOT_FOUND"
  | "HD_LINK_MISSING"
  | "VIDEO_TOO_LONG"
  | "SOURCE_TOO_LARGE"
  | "DOWNLOAD_FAILED"
  | "PROBE_FAILED"
  | "COMPRESSION_FAILED"
  | "TARGET_BITRATE_TOO_LOW"
  | "SERVER_BUSY"
  | "JOB_TIMEOUT";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

export function sendError(res: Response, error: unknown): void {
  const appError =
    error instanceof AppError
      ? error
      : new AppError("API_ERROR", "Something went wrong.", 500);

  if (res.headersSent) return;
  res.status(appError.status).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message
    }
  });
}
