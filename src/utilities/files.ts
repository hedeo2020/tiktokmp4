import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function createJobDirectory(baseDirectory: string): Promise<string> {
  await ensureDirectory(baseDirectory);
  return fs.mkdtemp(path.join(baseDirectory, `job-${crypto.randomUUID()}-`));
}

export async function removeDirectoryQuietly(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

export async function cleanupOldJobDirectories(baseDirectory: string, olderThanMs: number): Promise<void> {
  await ensureDirectory(baseDirectory);
  const entries = await fs.readdir(baseDirectory, { withFileTypes: true }).catch(() => []);
  const now = Date.now();

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("job-"))
      .map(async (entry) => {
        const fullPath = path.join(baseDirectory, entry.name);
        const stat = await fs.stat(fullPath).catch(() => undefined);
        if (stat && now - stat.mtimeMs > olderThanMs) {
          await removeDirectoryQuietly(fullPath);
        }
      })
  );
}

export function temporaryVideoPath(jobDirectory: string, extension = ".mp4"): string {
  return path.join(jobDirectory, `${crypto.randomUUID()}${extension}`);
}

export function nullOutputPath(): string {
  return os.platform() === "win32" ? "NUL" : "/dev/null";
}
