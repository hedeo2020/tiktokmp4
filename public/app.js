const form = document.querySelector("#video-form");
const urlInput = document.querySelector("#url");
const modeInput = document.querySelector("#mode");
const sizeInput = document.querySelector("#size");
const downloadButton = document.querySelector("#download");
const result = document.querySelector("#result");
const statusBox = document.querySelector("#status");
const errorBox = document.querySelector("#error");
const warning = document.querySelector("#warning");

let analyzedUrl = "";

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
  statusBox.textContent = "";
  errorBox.textContent = "";
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
    showStatus("Ready to compress");
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

downloadButton.addEventListener("click", async () => {
  clearMessages();
  downloadButton.disabled = true;

  try {
    showStatus("Fetching metadata");
    await new Promise((resolve) => setTimeout(resolve, 200));
    showStatus("Downloading HD source");
    await new Promise((resolve) => setTimeout(resolve, 200));
    showStatus("Compressing video");

    const response = await fetch("/api/video/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: analyzedUrl || urlInput.value,
        mode: modeInput.value,
        sizePer20SecondsMb: Number(sizeInput.value)
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => undefined);
      throw new Error(payload?.error?.message || "Compression failed.");
    }

    showStatus("Preparing download");
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] || "tiktok-compressed.mp4";
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    showStatus("Download ready");
  } catch (error) {
    showError(error.message);
  } finally {
    downloadButton.disabled = false;
  }
});
