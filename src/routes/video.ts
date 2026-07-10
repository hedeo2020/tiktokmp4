import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { fetchTikwmVideo } from "../services/tikwm.js";
import { downloadVideo } from "../services/downloader.js";
import {
  buildScaleFilter,
  calculateEncodingSettings,
  chooseAdaptiveMaxHeight,
  compressVideo,
  probeVideo
} from "../services/compressor.js";
import { AppError, sendError } from "../utilities/errors.js";
import { createJobDirectory, removeDirectoryQuietly, temporaryVideoPath } from "../utilities/files.js";
import {
  sanitizeFilenamePart,
  validateCompressionMode,
  validateSizePer20Seconds,
  validateTikTokUrl
} from "../utilities/validation.js";

export const videoRouter = express.Router();

let activeJobs = 0;
interface QueuedJob {
  start: () => void;
  reject: (error: AppError) => void;
}

const queuedJobs: QueuedJob[] = [];

async function acquireCompressionSlot(signal: AbortSignal): Promise<() => void> {
  if (activeJobs < config.maxConcurrentJobs) {
    activeJobs += 1;
    return releaseCompressionSlot;
  }

  if (queuedJobs.length >= config.maxQueuedJobs) {
    throw new AppError("SERVER_BUSY", "The server has too many videos waiting. Please try again soon.", 429);
  }

  await new Promise<void>((resolve, reject) => {
    let queuedJob: QueuedJob;
    const removeFromQueue = () => {
      const index = queuedJobs.indexOf(queuedJob);
      if (index !== -1) queuedJobs.splice(index, 1);
      reject(new AppError("JOB_TIMEOUT", "The video job was cancelled.", 499));
    };

    signal.addEventListener("abort", removeFromQueue, { once: true });
    queuedJob = {
      start: () => {
        signal.removeEventListener("abort", removeFromQueue);
        resolve();
      },
      reject
    };
    queuedJobs.push(queuedJob);
  });

  activeJobs += 1;
  return releaseCompressionSlot;
}

function releaseCompressionSlot(): void {
  activeJobs = Math.max(0, activeJobs - 1);
  const nextJob = queuedJobs.shift();
  if (nextJob) nextJob.start();
}

async function streamMp4File(res: express.Response, filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

type JobStatus = "queued" | "running" | "done" | "error";

interface CompressionJob {
  id: string;
  status: JobStatus;
  percent: number;
  message: string;
  filename?: string;
  outputPath?: string;
  jobDirectory?: string;
  error?: { code: string; message: string };
  subscribers: Set<express.Response>;
  cleanupTimer?: NodeJS.Timeout;
}

const compressionJobs = new Map<string, CompressionJob>();

function serializeJob(job: CompressionJob) {
  return {
    id: job.id,
    status: job.status,
    percent: Math.round(job.percent),
    message: job.message,
    error: job.error
  };
}

function emitJob(job: CompressionJob): void {
  const payload = `data: ${JSON.stringify(serializeJob(job))}\n\n`;
  for (const subscriber of job.subscribers) {
    subscriber.write(payload);
  }
}

function updateJob(job: CompressionJob, percent: number, message: string, status: JobStatus = job.status): void {
  job.percent = Math.max(job.percent, Math.min(100, percent));
  job.message = message;
  job.status = status;
  emitJob(job);
}

function scheduleJobCleanup(job: CompressionJob): void {
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(async () => {
    compressionJobs.delete(job.id);
    if (job.jobDirectory) await removeDirectoryQuietly(job.jobDirectory);
  }, 15 * 60 * 1000);
}

function failJob(job: CompressionJob, error: unknown): void {
  const appError =
    error instanceof AppError
      ? error
      : new AppError("COMPRESSION_FAILED", "Video compression failed.", 500);
  job.error = { code: appError.code, message: appError.message };
  updateJob(job, 100, appError.message, "error");
  scheduleJobCleanup(job);
}

videoRouter.post("/info", async (req, res) => {
  try {
    const url = validateTikTokUrl(req.body?.url);
    const video = await fetchTikwmVideo(url);
    const settings = calculateEncodingSettings(video.duration, 1);
    const adaptiveHeight = chooseAdaptiveMaxHeight(settings.videoBitrateBps);

    res.json({
      success: true,
      video: {
        id: video.id,
        title: video.title,
        duration: video.duration,
        cover: video.cover,
        sourceSizeBytes: video.hdSize,
        estimatedOutputSizeBytes: settings.targetBytes,
        warning:
          adaptiveHeight < 720
            ? "The target size is very small, so adaptive mode may reduce resolution for better quality."
            : undefined
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

videoRouter.post("/original", async (req, res) => {
  const controller = new AbortController();
  const abortIfDisconnected = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", abortIfDisconnected);

  let jobDirectory: string | undefined;
  try {
    const url = validateTikTokUrl(req.body?.url);
    const video = await fetchTikwmVideo(url, controller.signal);

    jobDirectory = await createJobDirectory(config.tempDirectory);
    const sourcePath = temporaryVideoPath(jobDirectory);

    await downloadVideo(video.hdplay, sourcePath, controller.signal);
    const stat = await fsp.stat(sourcePath);
    const filename = `tiktok-${sanitizeFilenamePart(video.id)}-original-hd.mp4`;

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");

    await streamMp4File(res, sourcePath);
  } catch (error) {
    sendError(res, error);
  } finally {
    res.off("close", abortIfDisconnected);
    if (jobDirectory) await removeDirectoryQuietly(jobDirectory);
  }
});

videoRouter.post("/jobs", async (req, res) => {
  try {
    const url = validateTikTokUrl(req.body?.url);
    const mode = validateCompressionMode(req.body?.mode);
    const sizePer20SecondsMb = validateSizePer20Seconds(req.body?.sizePer20SecondsMb);
    const job: CompressionJob = {
      id: crypto.randomUUID(),
      status: "queued",
      percent: 0,
      message: "Waiting for compressor",
      subscribers: new Set()
    };

    compressionJobs.set(job.id, job);
    res.status(202).json({ success: true, job: serializeJob(job) });

    void runCompressionJob(job, url, mode, sizePer20SecondsMb);
  } catch (error) {
    sendError(res, error);
  }
});

videoRouter.post("/original-jobs", async (req, res) => {
  try {
    const url = validateTikTokUrl(req.body?.url);
    const job: CompressionJob = {
      id: crypto.randomUUID(),
      status: "queued",
      percent: 0,
      message: "Starting original HD download",
      subscribers: new Set()
    };

    compressionJobs.set(job.id, job);
    res.status(202).json({ success: true, job: serializeJob(job) });

    void runOriginalJob(job, url);
  } catch (error) {
    sendError(res, error);
  }
});

videoRouter.get("/jobs/:jobId/events", (req, res) => {
  const job = compressionJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({
      success: false,
      error: { code: "VIDEO_NOT_FOUND", message: "The compression job was not found." }
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  job.subscribers.add(res);
  emitJob(job);

  req.on("close", () => {
    job.subscribers.delete(res);
  });
});

videoRouter.get("/original-jobs/:jobId/events", (req, res) => {
  const job = compressionJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({
      success: false,
      error: { code: "VIDEO_NOT_FOUND", message: "The original HD job was not found." }
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  job.subscribers.add(res);
  emitJob(job);

  req.on("close", () => {
    job.subscribers.delete(res);
  });
});

videoRouter.get("/jobs/:jobId/download", async (req, res) => {
  const job = compressionJobs.get(req.params.jobId);
  if (!job || job.status !== "done" || !job.outputPath || !job.filename) {
    res.status(404).json({
      success: false,
      error: { code: "VIDEO_NOT_FOUND", message: "The compressed video is not ready." }
    });
    return;
  }

  const stat = await fsp.stat(job.outputPath);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${job.filename}"`);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "no-store");
  await streamMp4File(res, job.outputPath);
  compressionJobs.delete(job.id);
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  if (job.jobDirectory) await removeDirectoryQuietly(job.jobDirectory);
});

videoRouter.get("/original-jobs/:jobId/download", async (req, res) => {
  const job = compressionJobs.get(req.params.jobId);
  if (!job || job.status !== "done" || !job.outputPath || !job.filename) {
    res.status(404).json({
      success: false,
      error: { code: "VIDEO_NOT_FOUND", message: "The original HD video is not ready." }
    });
    return;
  }

  const stat = await fsp.stat(job.outputPath);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${job.filename}"`);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "no-store");
  await streamMp4File(res, job.outputPath);
  compressionJobs.delete(job.id);
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  if (job.jobDirectory) await removeDirectoryQuietly(job.jobDirectory);
});

async function runOriginalJob(job: CompressionJob, url: string): Promise<void> {
  const controller = new AbortController();
  try {
    updateJob(job, 5, "Fetching metadata", "running");
    const video = await fetchTikwmVideo(url, controller.signal);

    job.jobDirectory = await createJobDirectory(config.tempDirectory);
    const sourcePath = temporaryVideoPath(job.jobDirectory);

    updateJob(job, 10, "Downloading original HD source");
    await downloadVideo(video.hdplay, sourcePath, controller.signal, (downloadedBytes, totalBytes) => {
      if (totalBytes && totalBytes > 0) {
        updateJob(job, 10 + Math.min(downloadedBytes / totalBytes, 1) * 85, "Downloading original HD source");
      }
    });

    job.outputPath = sourcePath;
    job.filename = `tiktok-${sanitizeFilenamePart(video.id)}-original-hd.mp4`;
    updateJob(job, 100, "Original HD download ready", "done");
    scheduleJobCleanup(job);
  } catch (error) {
    failJob(job, error);
  }
}

async function runCompressionJob(job: CompressionJob, url: string, mode: "adaptive" | "keep-1080p", sizePer20SecondsMb: number): Promise<void> {
  const controller = new AbortController();
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireCompressionSlot(controller.signal);
    updateJob(job, 5, "Fetching metadata", "running");
    const video = await fetchTikwmVideo(url, controller.signal);

    job.jobDirectory = await createJobDirectory(config.tempDirectory);
    const sourcePath = temporaryVideoPath(job.jobDirectory);
    const outputPath = path.join(job.jobDirectory, "compressed.mp4");

    updateJob(job, 12, "Downloading HD source");
    await downloadVideo(video.hdplay, sourcePath, controller.signal, (downloadedBytes, totalBytes) => {
      if (totalBytes && totalBytes > 0) {
        updateJob(job, 12 + Math.min(downloadedBytes / totalBytes, 1) * 18, "Downloading HD source");
      }
    });

    updateJob(job, 31, "Inspecting source video");
    const probe = await probeVideo(sourcePath, controller.signal);
    if (probe.durationSeconds > config.maxDurationSeconds) {
      throw new AppError("VIDEO_TOO_LONG", `Videos must be ${config.maxDurationSeconds} seconds or shorter.`, 413);
    }

    const initialSettings = calculateEncodingSettings(probe.durationSeconds, sizePer20SecondsMb);
    buildScaleFilter(mode, probe.height, initialSettings.videoBitrateBps);
    await compressVideo(sourcePath, outputPath, job.jobDirectory, mode, probe, sizePer20SecondsMb, controller.signal, (percent, message) => {
      updateJob(job, percent, message);
    });

    job.outputPath = outputPath;
    job.filename = `tiktok-${sanitizeFilenamePart(video.id)}-compressed.mp4`;
    updateJob(job, 100, "Download ready", "done");
    scheduleJobCleanup(job);
  } catch (error) {
    failJob(job, error);
  } finally {
    releaseSlot?.();
  }
}

videoRouter.post("/download", async (req, res) => {
  const controller = new AbortController();
  const abortIfDisconnected = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", abortIfDisconnected);

  let jobDirectory: string | undefined;
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireCompressionSlot(controller.signal);
    const url = validateTikTokUrl(req.body?.url);
    const mode = validateCompressionMode(req.body?.mode);
    const sizePer20SecondsMb = validateSizePer20Seconds(req.body?.sizePer20SecondsMb);
    const video = await fetchTikwmVideo(url, controller.signal);

    jobDirectory = await createJobDirectory(config.tempDirectory);
    const sourcePath = temporaryVideoPath(jobDirectory);
    const outputPath = path.join(jobDirectory, "compressed.mp4");

    await downloadVideo(video.hdplay, sourcePath, controller.signal);
    const probe = await probeVideo(sourcePath, controller.signal);
    if (probe.durationSeconds > config.maxDurationSeconds) {
      throw new AppError("VIDEO_TOO_LONG", `Videos must be ${config.maxDurationSeconds} seconds or shorter.`, 413);
    }

    const initialSettings = calculateEncodingSettings(probe.durationSeconds, sizePer20SecondsMb);
    buildScaleFilter(mode, probe.height, initialSettings.videoBitrateBps);
    await compressVideo(sourcePath, outputPath, jobDirectory, mode, probe, sizePer20SecondsMb, controller.signal);
    const stat = await fsp.stat(outputPath);
    const filename = `tiktok-${sanitizeFilenamePart(video.id)}-compressed.mp4`;

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");

    await streamMp4File(res, outputPath);
  } catch (error) {
    sendError(res, error);
  } finally {
    res.off("close", abortIfDisconnected);
    releaseSlot?.();
    if (jobDirectory) await removeDirectoryQuietly(jobDirectory);
  }
});
