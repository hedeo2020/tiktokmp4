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
let analyzedDuration = 0;

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

function startOriginalDownloadProgress() {
  stopProgress();
  let percent = 10;
  setProgress(percent, "Preparing original HD download");
  progressTimer = window.setInterval(() => {
    if (percent < 88) {
      percent += 4;
      setProgress(percent, "Downloading original HD source");
      return;
    }

    setProgress(percent, "Finalizing download");
  }, 700);
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

function calculateQualityTargetBytes(durationSeconds, sizePer20SecondsMb) {
  const mib = 1024 * 1024;
  return Math.max(1, Math.ceil(durationSeconds / 20) * sizePer20SecondsMb) * mib;
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
  downloadButton.hidden = true;
  originalButton.disabled = true;
  originalButton.hidden = true;
  showStatus("Fetching metadata");

  try {
    const payload = await fetch("/api/video/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: urlInput.value })
    }).then(readJsonResponse);

    analyzedUrl = urlInput.value;
    analyzedDuration = payload.video.duration;
    document.querySelector("#cover").src = payload.video.cover || "";
    document.querySelector("#title").textContent = payload.video.title || "TikTok video";
    document.querySelector("#duration").textContent = formatDuration(payload.video.duration);
    document.querySelector("#source-size").textContent = formatBytes(payload.video.sourceSizeBytes);
    document.querySelector("#estimated-size").textContent = formatBytes(
      calculateQualityTargetBytes(payload.video.duration, Number(sizeInput.value))
    );

    warning.hidden = true;
    warning.textContent = "";
    result.hidden = false;
    downloadButton.disabled = false;
    downloadButton.hidden = false;
    originalButton.disabled = false;
    originalButton.hidden = false;
    showStatus("Ready to download or compress");
  } catch (error) {
    showError(error.message);
  }
});

modeInput.addEventListener("change", () => {
  warning.hidden = true;
  warning.textContent = "";
});

sizeInput.addEventListener("change", () => {
  if (analyzedDuration > 0) {
    document.querySelector("#estimated-size").textContent = formatBytes(
      calculateQualityTargetBytes(analyzedDuration, Number(sizeInput.value))
    );
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

async function downloadBlobFromUrl(endpoint, fallbackFilename, failureMessage) {
  const response = await fetch(endpoint);

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

function triggerDirectDownload(endpoint) {
  const link = document.createElement("a");
  link.href = endpoint;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function startCompressionJob() {
  const payload = await fetch("/api/video/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: analyzedUrl || urlInput.value,
      mode: modeInput.value,
      sizePer20SecondsMb: Number(sizeInput.value)
    })
  }).then(readJsonResponse);

  return payload.job.id;
}

async function startOriginalJob() {
  const payload = await fetch("/api/video/original-jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: analyzedUrl || urlInput.value
    })
  }).then(readJsonResponse);

  return payload.job.id;
}

async function waitForJobProgress(eventsEndpoint, fallbackErrorMessage) {
  return await new Promise((resolve, reject) => {
    const events = new EventSource(eventsEndpoint);

    events.onmessage = (event) => {
      const job = JSON.parse(event.data);
      setProgress(job.percent, job.message);

      if (job.status === "done") {
        events.close();
        resolve();
      }

      if (job.status === "error") {
        events.close();
        reject(new Error(job.error?.message || fallbackErrorMessage));
      }
    };

    events.onerror = () => {
      events.close();
      reject(new Error("Lost connection to live progress."));
    };
  });
}

originalButton.addEventListener("click", async () => {
  clearMessages();
  originalButton.disabled = true;

  try {
    showStatus("Starting Original HD download");
    setProgress(1, "Starting Original HD download");
    const jobId = await startOriginalJob();
    await waitForJobProgress(
      `/api/video/original-jobs/${encodeURIComponent(jobId)}/events`,
      "Original HD download failed."
    );
    triggerDirectDownload(`/api/video/original-jobs/${encodeURIComponent(jobId)}/download`);
    setProgress(100, "Browser download started");
    showStatus("Browser download started");
  } catch (error) {
    stopProgress();
    showError(error.message);
  } finally {
    originalButton.disabled = false;
  }
});

downloadButton.addEventListener("click", async () => {
  clearMessages();
  downloadButton.disabled = true;

  try {
    showStatus("Starting compression job");
    setProgress(1, "Starting compression job");
    const jobId = await startCompressionJob();
    await waitForJobProgress(
      `/api/video/jobs/${encodeURIComponent(jobId)}/events`,
      "Compression failed."
    );
    triggerDirectDownload(`/api/video/jobs/${encodeURIComponent(jobId)}/download`);
    setProgress(100, "Browser download started");
    showStatus("Browser download started");
  } catch (error) {
    showError(error.message);
  } finally {
    downloadButton.disabled = false;
  }
});
