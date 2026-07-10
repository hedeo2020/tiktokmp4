import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { videoRouter } from "./routes/video.js";
import { cleanupOldJobDirectories, ensureDirectory } from "./utilities/files.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDirectory = path.resolve(__dirname, "../public");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "16kb" }));

app.use(express.static(publicDirectory));
app.use(
  "/api",
  rateLimit({
    windowMs: config.rateLimitWindowMinutes * 60 * 1000,
    limit: config.rateLimitRequests,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) =>
      req.method === "GET" &&
      (/^\/api\/video\/jobs\/[^/]+\/events$/.test(req.path) ||
        /^\/api\/video\/jobs\/[^/]+\/download$/.test(req.path) ||
        /^\/api\/video\/original-jobs\/[^/]+\/events$/.test(req.path) ||
        /^\/api\/video\/original-jobs\/[^/]+\/download$/.test(req.path)),
    message: {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please wait a few minutes and try again."
      }
    }
  })
);
app.use("/api/video", videoRouter);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: "Not found." }
  });
});

await ensureDirectory(config.tempDirectory);
await cleanupOldJobDirectories(config.tempDirectory, 2 * 60 * 60 * 1000);

app.listen(config.port, () => {
  console.log(`TikTok HD Compressor listening on port ${config.port}`);
});
