import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../utilities/errors.js";
import { nullOutputPath } from "../utilities/files.js";
import { config } from "../config.js";

export const MIB = 1024 * 1024;

export interface ProbeInfo {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec?: string;
  audioCodec?: string;
  sizeBytes: number;
}

export interface EncodingSettings {
  targetBytes: number;
  totalBitrateBps: number;
  audioBitrateBps: number;
  videoBitrateBps: number;
  maxHeight: number;
}

export function calculateEncodingSettings(
  durationSeconds: number,
  sizePer20SecondsMb = 1
): Omit<EncodingSettings, "maxHeight"> {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AppError("PROBE_FAILED", "Invalid video duration.");
  }

  const targetBytes =
    Math.max(1, Math.ceil(durationSeconds / 20) * sizePer20SecondsMb) * MIB;
  const totalBitrateBps = Math.floor((targetBytes * 8 * 0.97) / durationSeconds);
  const audioBitrateBps = totalBitrateBps < 300_000 || durationSeconds > 120 ? 32_000 : 48_000;
  const videoBitrateBps = totalBitrateBps - audioBitrateBps;

  if (videoBitrateBps < 120_000) {
    throw new AppError(
      "TARGET_BITRATE_TOO_LOW",
      "The requested target size is too small for this video's duration."
    );
  }

  return { targetBytes, totalBitrateBps, audioBitrateBps, videoBitrateBps };
}

export function chooseAdaptiveMaxHeight(videoBitrateBps: number): number {
  const kbps = videoBitrateBps / 1000;
  if (kbps >= 1500) return 1080;
  if (kbps >= 900) return 720;
  if (kbps >= 500) return 540;
  if (kbps >= 250) return 480;
  return 360;
}

export function buildScaleFilter(mode: "adaptive" | "keep-1080p", sourceHeight: number, videoBitrateBps: number): string {
  const targetHeight =
    mode === "keep-1080p" ? Math.min(sourceHeight, 1080) : Math.min(sourceHeight, chooseAdaptiveMaxHeight(videoBitrateBps));
  return `scale='if(gt(ih,${targetHeight}),-2,iw)':'if(gt(ih,${targetHeight}),${targetHeight},ih)'`;
}

async function runProcess(command: string, args: string[], signal: AbortSignal, timeoutMs: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AppError("JOB_TIMEOUT", "The video job timed out.", 504));
    }, timeoutMs);

    const abort = () => {
      if (!settled) child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

export async function probeVideo(inputPath: string, signal: AbortSignal): Promise<ProbeInfo> {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=codec_type,codec_name,width,height",
    "-of",
    "json",
    inputPath
  ];

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve(stdout);
      else reject(new AppError("PROBE_FAILED", stderr || "Could not inspect the source video."));
    });
  });

  try {
    const parsed = JSON.parse(output) as {
      format?: { duration?: string; size?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
    const durationSeconds = Number(parsed.format?.duration);
    const sizeBytes = Number(parsed.format?.size);

    if (!video?.width || !video.height || !Number.isFinite(durationSeconds)) {
      throw new Error("missing video metadata");
    }

    return {
      durationSeconds,
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0
    };
  } catch {
    throw new AppError("PROBE_FAILED", "Could not inspect the source video.");
  }
}

async function encodeTwoPass(inputPath: string, outputPath: string, passLogPath: string, scaleFilter: string, settings: Omit<EncodingSettings, "maxHeight">, signal: AbortSignal): Promise<void> {
  const videoBitrate = `${Math.floor(settings.videoBitrateBps / 1000)}k`;
  const audioBitrate = `${Math.floor(settings.audioBitrateBps / 1000)}k`;
  const bufsize = `${Math.floor((settings.videoBitrateBps * 2) / 1000)}k`;
  const timeoutMs = config.jobTimeoutSeconds * 1000;

  const commonVideoArgs = [
    "-map",
    "0:v:0",
    "-c:v",
    "libx264",
    "-b:v",
    videoBitrate,
    "-maxrate",
    videoBitrate,
    "-bufsize",
    bufsize,
    "-preset",
    "medium",
    "-threads",
    String(config.ffmpegThreads),
    "-vf",
    scaleFilter,
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "main"
  ];

  await runProcess(
    "ffmpeg",
    ["-y", "-i", inputPath, ...commonVideoArgs, "-pass", "1", "-passlogfile", passLogPath, "-an", "-f", "mp4", nullOutputPath()],
    signal,
    timeoutMs
  ).catch((error) => {
    if (error instanceof AppError) throw error;
    throw new AppError("COMPRESSION_FAILED", "Video compression failed.");
  });

  await runProcess(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      ...commonVideoArgs,
      "-pass",
      "2",
      "-passlogfile",
      passLogPath,
      "-map",
      "0:a:0?",
      "-c:a",
      "aac",
      "-b:a",
      audioBitrate,
      "-ac",
      "2",
      "-ar",
      "44100",
      "-movflags",
      "+faststart",
      outputPath
    ],
    signal,
    timeoutMs
  ).catch((error) => {
    if (error instanceof AppError) throw error;
    throw new AppError("COMPRESSION_FAILED", "Video compression failed.");
  });
}

export async function compressVideo(inputPath: string, outputPath: string, jobDirectory: string, mode: "adaptive" | "keep-1080p", probe: ProbeInfo, sizePer20SecondsMb: number, signal: AbortSignal): Promise<EncodingSettings> {
  let settings = calculateEncodingSettings(probe.durationSeconds, sizePer20SecondsMb);
  let scaleFilter = buildScaleFilter(mode, probe.height, settings.videoBitrateBps);
  const passLogPath = path.join(jobDirectory, "ffmpeg-pass");

  await encodeTwoPass(inputPath, outputPath, passLogPath, scaleFilter, settings, signal);

  const stat = await fs.stat(outputPath);
  if (stat.size > settings.targetBytes * 1.08) {
    settings = {
      ...settings,
      videoBitrateBps: Math.max(120_000, Math.floor(settings.videoBitrateBps * (settings.targetBytes / stat.size)))
    };
    scaleFilter = buildScaleFilter(mode, probe.height, settings.videoBitrateBps);
    await encodeTwoPass(inputPath, outputPath, passLogPath, scaleFilter, settings, signal);
  }

  return { ...settings, maxHeight: mode === "keep-1080p" ? Math.min(probe.height, 1080) : chooseAdaptiveMaxHeight(settings.videoBitrateBps) };
}
