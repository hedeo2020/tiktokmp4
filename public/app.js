const form = document.querySelector("#video-form");
const urlInput = document.querySelector("#url");
const modeInput = document.querySelector("#mode");
const sizeInput = document.querySelector("#size");
const downloadButton = document.querySelector("#download");
const originalButton = document.querySelector("#download-original");
const result = document.querySelector("#result");
const statusBox = document.querySelector("#status");
const errorBox = document.querySelector("#error");
const warning = document.querySelector("#warning");
const progressBox = document.querySelector("#progress");
const progressMessage = document.querySelector("#progress-message");
const progressPercent = document.querySelector("#progress-percent");
const progressBar = document.querySelector("#progress-bar");

let analyzedUrl = "";
let progressTimer = null;

function showStatus(message) {
  statusBox.textContent = message;
  statusBox.hidden = false;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearMessages() {
  statusBox.hidden = true;
  errorBox.hidden = true;
  progressBox.hidden = true;
  statusBox.textContent = "";
  errorBox.textContent = "";
  stopProgress();
}

function setProgress(percent, message) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  progressBox.hidden = false;
  progressMessage.textContent = message;
  progressPercent.textContent = `${safePercent}%`;
  progressBar.style.width = `${safePercent}%`;
}

function startProcessingProgress() {
  stopProgress();
  let percent = 8;
  setProgress(percent, "Preparing video");
  progressTimer = window.setInterval(() => {
    if (percent < 35) {
      percent += 3;
      setProgress(percent, "Downloading HD source");
      return;
    }

    if (percent < 92) {
      percent += 1;
      setProgress(percent, "Compressing video");
      return;
    }

    setProgress(percent, "Finalizing download");
  }, 900);
}

function stopProgress() {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unknown";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

async function readJsonResponse(response) {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error?.message || "Request failed.");
  }
  return payload;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  result.hidden = true;
  downloadButton.disabled = true;
  originalButton.disabled = true;
  showStatus("Fetching metadata");

  try {
    const payload = await fetch("/api/video/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: urlInput.value })
    }).then(readJsonResponse);

    analyzedUrl = urlInput.value;
    document.querySelector("#cover").src = payload.video.cover || "";
    document.querySelector("#title").textContent = payload.video.title || "TikTok video";
    document.querySelector("#duration").textContent = formatDuration(payload.video.duration);
    document.querySelector("#source-size").textContent = formatBytes(payload.video.sourceSizeBytes);
    document.querySelector("#estimated-size").textContent = formatBytes(payload.video.estimatedOutputSizeBytes);

    warning.hidden = !payload.video.warning;
    warning.textContent = payload.video.warning || "";
    result.hidden = false;
    downloadButton.disabled = false;
    originalButton.disabled = false;
    showStatus("Ready to download or compress");
  } catch (error) {
    showError(error.message);
  }
});

modeInput.addEventListener("change", () => {
  if (modeInput.value === "keep-1080p") {
    warning.hidden = false;
    warning.textContent = "Keeping 1080p at very small file sizes may produce visible compression artifacts.";
  }
});

async function downloadBlobFromEndpoint(endpoint, body, fallbackFilename, failureMessage) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(payload?.error?.message || failureMessage);
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] || fallbackFilename;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

originalButton.addEventListener("click", async () => {
  clearMessages();
  originalButton.disabled = true;

  try {
    showStatus("Fetching original HD source");
    await downloadBlobFromEndpoint(
      "/api/video/original",
      { url: analyzedUrl || urlInput.value },
      "tiktok-original-hd.mp4",
      "Original HD download failed."
    );
    showStatus("Original HD download ready");
  } catch (error) {
    showError(error.message);
  } finally {
    originalButton.disabled = false;
  }
});

downloadButton.addEventListener("click", async () => {
  clearMessages();
  downloadButton.disabled = true;

  try {
    showStatus("Processing your compressed download");
    startProcessingProgress();

    await downloadBlobFromEndpoint(
      "/api/video/download",
      {
        url: analyzedUrl || urlInput.value,
        mode: modeInput.value,
        sizePer20SecondsMb: Number(sizeInput.value)
      },
      "tiktok-compressed.mp4",
      "Compression failed."
    );
    stopProgress();
    setProgress(100, "Download ready");
    showStatus("Download ready");
  } catch (error) {
    stopProgress();
    showError(error.message);
  } finally {
    downloadButton.disabled = false;
  }
});
