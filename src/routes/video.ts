import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
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
