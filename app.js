import { sha256 } from "https://esm.sh/@noble/hashes@2.4.0/sha2.js";

const SUPABASE = "https://ffejfkoqnastynooilvs.supabase.co";
const SUPABASE_KEY = "sb_publishable_-IYeO2mCbPn6NQczGg6poQ_f7LhOT89";
const MEDIA = "https://nnb-media-api.tmqdinh.workers.dev";
const AUTH_KEY = "nnb-converter-auth-v1";
const ACTIVE_KEY = "nnb-converter-active-job";
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const CHUNK = 32 * 1024 * 1024;
const $ = id => document.getElementById(id);
const el = {
  login: $("loginPanel"), app: $("appPanel"), form: $("loginForm"), loginError: $("loginError"),
  email: $("email"), password: $("password"), emailLabel: $("accountEmail"), logout: $("signOutButton"),
  driveStatus: $("driveStatus"), driveButton: $("driveButton"), input: $("videoFile"), drop: $("dropZone"),
  selected: $("selectedFile"), fileName: $("fileName"), fileSize: $("fileSize"), remove: $("removeFile"),
  convert: $("convertButton"), feedback: $("mainFeedback"), progress: $("progressPanel"),
  progressTitle: $("progressTitle"), progressPercent: $("progressPercent"), bar: $("progressBar"),
  phase: $("progressPhase"), bytes: $("progressBytes"), steps: $("steps"), result: $("downloadResult"),
  outputInfo: $("outputInfo"), download: $("downloadButton"), history: $("jobHistory"),
  refresh: $("refreshJobs"), toast: $("toast")
};
let selected = null;
let driveReady = false;
let busy = false;
let toastTimer = null;

function session() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); }
  catch { return null; }
}
function saveSession(value) { localStorage.setItem(AUTH_KEY, JSON.stringify(value)); }
function clearSession() { localStorage.removeItem(AUTH_KEY); }
function bytesText(value) {
  let size = Number(value) || 0;
  if (size < 1024) return size + " B";
  const units = ["KB", "MB", "GB", "TB"];
  size /= 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(size >= 10 ? 1 : 2) + " " + units[i];
}
function feedback(node, message, error = false) {
  node.textContent = message || "";
  node.hidden = !message;
  node.classList.toggle("error", Boolean(error));
}
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 3000);
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function formatDate(value) {
  try { return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
  catch { return ""; }
}
async function authRequest(path, options = {}) {
  const response = await fetch(SUPABASE + "/auth/v1/" + path, {
    method: options.method || "GET",
    headers: { apikey: SUPABASE_KEY, "content-type": "application/json", ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || data.error || "Supabase Auth error (" + response.status + ").");
  return data;
}
async function accessToken() {
  const current = session();
  if (!current?.access_token || !current?.refresh_token) throw new Error("Phiên đăng nhập hết hạn. Đăng nhập lại.");
  if (Number(current.expires_at || 0) > Math.floor(Date.now() / 1000) + 90) return current.access_token;
  const next = await authRequest("token?grant_type=refresh_token", { method: "POST", body: { refresh_token: current.refresh_token } });
  saveSession({ ...next, expires_at: Math.floor(Date.now() / 1000) + Number(next.expires_in || 3600) });
  return next.access_token;
}
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!options.public) headers.authorization = "Bearer " + await accessToken();
  if (options.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  const response = await fetch(MEDIA + path, {
    method: options.method || "GET",
    headers,
    body: options.raw !== undefined ? options.raw : options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error && typeof data.error === "object" ? data.error : {};
    const error = new Error(detail.message || "Media API error (" + response.status + ").");
    error.status = response.status;
    error.code = detail.code || "NNB_MEDIA_API_ERROR";
    throw error;
  }
  return data;
}
function setProgress(value, message, byteMessage = "") {
  const n = Math.max(0, Math.min(100, Math.floor(Number(value) || 0)));
  el.progressPercent.textContent = n + "%";
  el.bar.style.width = n + "%";
  el.phase.textContent = message || "Đang xử lý";
  el.bytes.textContent = byteMessage;
  el.progress.hidden = false;
}
function markSteps(active, done = []) {
  for (const item of el.steps.querySelectorAll("li")) {
    item.classList.toggle("active", item.dataset.step === active);
    item.classList.toggle("done", done.includes(item.dataset.step));
  }
}
function setBusy(value) {
  busy = value;
  el.input.disabled = value;
  el.remove.disabled = value;
  el.convert.disabled = value || !selected || !driveReady;
  el.convert.textContent = value ? "Đang xử lý…" : "Upload & Convert";
}
function selectFile(file) {
  if (!file) return;
  if (!/\.mkv$/i.test(file.name)) return feedback(el.feedback, "Chỉ nhận file .mkv.", true);
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_BYTES) return feedback(el.feedback, "File vượt giới hạn 4 GiB.", true);
  selected = file;
  el.fileName.textContent = file.name;
  el.fileSize.textContent = bytesText(file.size);
  el.selected.hidden = false;
  el.drop.hidden = true;
  feedback(el.feedback, "");
  setBusy(false);
}
function clearFile() {
  selected = null;
  el.input.value = "";
  el.selected.hidden = true;
  el.drop.hidden = false;
  setBusy(false);
}
async function refreshDrive() {
  el.driveButton.disabled = true;
  el.driveStatus.textContent = "Đang kiểm tra Google Drive…";
  try {
    const status = await api("/v1/storage/google/status");
    driveReady = status.connected === true && status.authorizationReady === true;
    if (driveReady) {
      el.driveStatus.textContent = "Đã kết nối" + (status.email ? " · " + status.email : "");
      el.driveButton.textContent = "Drive đã kết nối";
      el.driveButton.disabled = true;
    } else {
      el.driveStatus.textContent = status.reauthorizationRequired ? "Cần cấp quyền lại Google Drive." : "Chưa kết nối Google Drive.";
      el.driveButton.textContent = status.connected ? "Kết nối lại Drive" : "Kết nối Drive";
      el.driveButton.disabled = false;
    }
  } catch (error) {
    driveReady = false;
    el.driveStatus.textContent = error.message;
    el.driveButton.textContent = "Thử kết nối Drive";
    el.driveButton.disabled = false;
  }
  setBusy(busy);
}
async function connectDrive() {
  try {
    el.driveButton.disabled = true;
    const result = await api("/v1/storage/google/connect", { method: "POST", body: { returnTo: location.origin } });
    if (!result.authorizationUrl) throw new Error("Google OAuth URL không hợp lệ.");
    location.assign(result.authorizationUrl);
  } catch (error) {
    el.driveButton.disabled = false;
    toast(error.message);
  }
}
async function showApp() {
  el.login.hidden = true;
  el.app.hidden = false;
  el.emailLabel.textContent = session()?.user?.email || "NNB account";
  await refreshDrive();
  await refreshHistory();
}
async function hashFile(file) {
  const hash = sha256.create();
  const count = Math.ceil(file.size / CHUNK);
  for (let i = 0; i < count; i++) {
    const start = i * CHUNK;
    const bytes = new Uint8Array(await file.slice(start, Math.min(file.size, start + CHUNK)).arrayBuffer());
    hash.update(bytes);
    setProgress(0, "Tính SHA-256 · " + Math.floor((i + 1) / count * 100) + "%", bytesText(Math.min(file.size, start + bytes.byteLength)) + " / " + bytesText(file.size));
    markSteps("hash");
  }
  return Array.from(hash.digest(), value => value.toString(16).padStart(2, "0")).join("");
}
async function uploadPart(assetId, part, chunk) {
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await api("/v1/uploads/" + assetId + "/parts/" + part, {
        method: "PUT",
        raw: chunk,
        headers: { "content-type": "application/octet-stream", "x-nnb-part-bytes": String(chunk.byteLength) }
      });
      return;
    } catch (error) {
      last = error;
      if ((error.status && error.status < 500 && error.status !== 408 && error.status !== 429) || attempt === 5) break;
      await delay(Math.min(8000, 500 * (2 ** (attempt - 1))));
    }
  }
  throw last || new Error("Upload part " + part + " failed.");
}
async function uploadSource(file) {
  const hash = await hashFile(file);
  markSteps("upload", ["hash"]);
  setProgress(0, "Đang tạo upload session…");
  const init = await api("/v1/converter/sources/init", { method: "POST", body: {
    mediaType: "video", fileName: file.name, byteSize: file.size, sha256: hash, mimeType: "video/x-matroska"
  }});
  const assetId = init?.asset?.id;
  if (!assetId) throw new Error("Media API không trả về source asset ID.");
  if (init.asset.status === "ready" || init.deduplicated === true) {
    setProgress(100, "File đã có sẵn trong Drive.", bytesText(file.size));
    return assetId;
  }
  const upload = init.upload || {};
  const partSize = Number(upload.partSize);
  const total = Number(upload.totalParts);
  if (!Number.isSafeInteger(partSize) || partSize < 5 * 1024 * 1024 || !Number.isSafeInteger(total) || total < 1) throw new Error("Upload layout không hợp lệ.");
  const complete = new Set((upload.completedParts || []).map(p => Number(p.partNumber)));
  let sent = (upload.completedParts || []).reduce((sum, p) => sum + Number(p.byteSize || 0), 0);
  for (let part = 1; part <= total; part++) {
    if (complete.has(part)) continue;
    const start = (part - 1) * partSize;
    const chunk = await file.slice(start, Math.min(file.size, start + partSize)).arrayBuffer();
    await uploadPart(assetId, part, chunk);
    sent += chunk.byteLength;
    setProgress(sent / file.size * 100, "Upload MKV · part " + part + "/" + total, bytesText(sent) + " / " + bytesText(file.size));
  }
  setProgress(100, "Đang xác nhận file trên Drive…", bytesText(file.size) + " / " + bytesText(file.size));
  await api("/v1/uploads/" + assetId + "/complete", { method: "POST", body: {} });
  return assetId;
}
function phaseLabel(job) {
  const map = {
    queued: "Đang chờ FFmpeg runner",
    "downloading-source": "Runner đang tải MKV từ Drive",
    "probing-source": "FFprobe đang phân tích codec",
    remuxing: "Đang remux sang MP4",
    transcoding: "Đang encode H.264 + AAC",
    "verifying-output": "Đang xác minh MP4",
    "uploading-output": "Đang lưu MP4 lên Drive",
    completed: "Hoàn tất",
    dispatch_failed: "Không khởi chạy được runner",
    failed: "Convert thất bại"
  };
  return map[job.phase] || job.phase || job.status;
}
async function outputUrl(assetId) {
  const result = await api("/v1/assets/" + assetId + "/download-url", { method: "POST", body: {} });
  const url = result.url || (result.path ? MEDIA + result.path : "");
  if (!url) throw new Error("Không lấy được link MP4.");
  return url;
}
async function pollJob(id) {
  while (true) {
    const data = await api("/v1/converter/jobs/" + id);
    const job = data.job;
    if (!job) throw new Error("Không tìm thấy converter job.");
    setProgress(job.progress, phaseLabel(job));
    if (job.status === "ready" && job.outputAssetId) {
      el.download.href = await outputUrl(job.outputAssetId);
      el.outputInfo.textContent = job.fileName + " · " + formatDate(job.updatedAt);
      el.result.hidden = false;
      setProgress(100, "MP4 đã sẵn sàng trong Google Drive.");
      markSteps("download", ["hash", "upload", "convert", "verify", "download"]);
      localStorage.removeItem(ACTIVE_KEY);
      await refreshHistory();
      toast("Convert hoàn tất.");
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") throw new Error(job.errorMessage || job.errorCode || "Convert thất bại.");
    await delay(7000);
  }
}
async function startConvert() {
  if (!selected || !driveReady || busy) return;
  setBusy(true);
  feedback(el.feedback, "");
  el.result.hidden = true;
  el.progressTitle.textContent = selected.name;
  el.progress.hidden = false;
  try {
    const sourceId = await uploadSource(selected);
    setProgress(100, "Đang đưa job vào hàng đợi FFmpeg…");
    const result = await api("/v1/converter/jobs", { method: "POST", body: { sourceAssetId: sourceId } });
    const job = result.job;
    if (!job?.id) throw new Error("Converter API không trả về job ID.");
    localStorage.setItem(ACTIVE_KEY, job.id);
    markSteps("convert", ["hash", "upload"]);
    await pollJob(job.id);
  } catch (error) {
    feedback(el.feedback, error.message || "Convert thất bại.", true);
    setProgress(0, "Có lỗi xảy ra.");
    toast(error.message || "Convert thất bại.");
  } finally {
    setBusy(false);
  }
}
async function refreshHistory() {
  try {
    const data = await api("/v1/converter/jobs");
    el.history.replaceChildren();
    if (!(data.jobs || []).length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Chưa có job convert.";
      el.history.append(empty);
      return;
    }
    for (const job of data.jobs) {
      const row = document.createElement("div");
      row.className = "history-item";
      const info = document.createElement("div");
      info.className = "history-info";
      const name = document.createElement("b");
      name.textContent = job.fileName || "Video";
      const meta = document.createElement("span");
      meta.textContent = formatDate(job.createdAt) + " · " + phaseLabel(job);
      info.append(name, meta);
      row.append(info);
      const status = document.createElement("span");
      status.className = "status-pill " + job.status;
      status.textContent = job.status === "ready" ? "Xong" : job.status === "failed" ? "Lỗi" : job.status === "queued" ? "Đang chờ" : (job.progress || 0) + "%";
      row.append(status);
      if (job.status === "ready" && job.outputAssetId) {
        const link = document.createElement("a");
        link.className = "secondary";
        link.textContent = "MP4";
        link.href = await outputUrl(job.outputAssetId);
        link.target = "_blank";
        link.rel = "noopener";
        row.append(link);
      }
      el.history.append(row);
    }
  } catch (error) {
    console.warn("Could not load converter history:", error);
  }
}
async function signIn(event) {
  event.preventDefault();
  feedback(el.loginError, "");
  const button = el.form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "Đang đăng nhập…";
  try {
    const data = await authRequest("token?grant_type=password", { method: "POST", body: { email: el.email.value.trim(), password: el.password.value } });
    saveSession({ ...data, expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600) });
    el.password.value = "";
    await showApp();
  } catch (error) {
    feedback(el.loginError, error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Đăng nhập";
  }
}
async function signOut() {
  try {
    const token = await accessToken();
    await authRequest("logout", { method: "POST", headers: { authorization: "Bearer " + token } });
  } catch {}
  clearSession();
  localStorage.removeItem(ACTIVE_KEY);
  location.reload();
}
function events() {
  el.form.addEventListener("submit", signIn);
  el.logout.addEventListener("click", signOut);
  el.driveButton.addEventListener("click", connectDrive);
  el.input.addEventListener("change", event => selectFile(event.target.files?.[0]));
  el.remove.addEventListener("click", () => { if (!busy) clearFile(); });
  el.convert.addEventListener("click", startConvert);
  el.refresh.addEventListener("click", refreshHistory);
  ["dragenter", "dragover"].forEach(name => el.drop.addEventListener(name, event => { event.preventDefault(); el.drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(name => el.drop.addEventListener(name, event => { event.preventDefault(); el.drop.classList.remove("drag"); }));
  el.drop.addEventListener("drop", event => selectFile(event.dataTransfer?.files?.[0]));
}
async function boot() {
  events();
  const url = new URL(location.href);
  const driveStatus = url.searchParams.get("nnb_google_drive");
  if (driveStatus) {
    url.searchParams.delete("nnb_google_drive");
    history.replaceState({}, "", url.toString());
    toast(driveStatus === "connected" ? "Google Drive đã kết nối." : "Google Drive chưa kết nối được.");
  }
  if (!session()?.access_token) { el.login.hidden = false; return; }
  try {
    const token = await accessToken();
    const user = await authRequest("user", { headers: { authorization: "Bearer " + token } });
    saveSession({ ...session(), user });
    await showApp();
    const id = localStorage.getItem(ACTIVE_KEY);
    if (id) {
      el.progress.hidden = false;
      el.progressTitle.textContent = "Đang khôi phục job…";
      setBusy(true);
      pollJob(id).catch(error => feedback(el.feedback, error.message, true)).finally(() => setBusy(false));
    }
  } catch {
    clearSession();
    el.login.hidden = false;
  }
}
boot();
