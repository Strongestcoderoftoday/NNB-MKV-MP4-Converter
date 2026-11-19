import { readFile, mkdtemp, rm, stat, statfs, open, copyFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { buildFfprobeArgs, buildFfmpegArgs, classifyPlaybackInput, safePlaybackFilename } from "./transcode-utils.js";

const MEDIA_API_URL = "https://nnb-media-api.tmqdinh.workers.dev";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

// The signed token is verified by the NNB Worker on the first /prepare call.
// This keeps TRANSCODE_INTERNAL_SECRET out of the public GitHub repository.
export function validateConverterDispatchEvent(event) {
  if (event?.action !== "nnb-mkv-convert") throw new Error("Unexpected NNB converter dispatch event.");
  const payload = event?.client_payload || {};
  const jobId = String(payload.jobId || "");
  const token = String(payload.token || "");
  if (!UUID.test(jobId) || !token || token.length > 8192) throw new Error("Converter dispatch payload is incomplete.");
  return { jobId, token, mediaApiUrl: MEDIA_API_URL };
}
async function callInternal(job, action, options = {}) {
  const url = new URL("/internal/converter/jobs/" + encodeURIComponent(job.jobId) + "/" + action, job.mediaApiUrl);
  const headers = { authorization: "Bearer " + job.token };
  let body;
  if (options.bytes) {
    headers["content-type"] = "application/octet-stream";
    headers["x-nnb-part-bytes"] = String(options.bytes.byteLength);
    body = options.bytes;
  } else if (options.payload !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.payload);
  }
  const response = await fetch(url, {
    method: options.method || "POST", headers, body,
    signal: AbortSignal.timeout(options.timeout || 15 * 60 * 1000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error && typeof data.error === "object" ? data.error : {};
    const error = new Error(String(detail.message || "NNB converter API failed (" + response.status + ")."));
    error.status = response.status;
    error.code = String(detail.code || "NNB_CONVERTER_HTTP_" + response.status);
    throw error;
  }
  return data;
}
async function progress(job, value, phase, mode) {
  try { await callInternal(job, "progress", { payload: { progress: Math.max(1, Math.min(98, Math.floor(value))), phase, mode } }); }
  catch (error) { process.stderr.write("Progress update warning: " + String(error?.message || error) + "\n"); }
}
function probe(path) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", buildFfprobeArgs(path), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-5000); });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error("ffprobe failed: " + stderr.slice(-1200)));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("ffprobe returned invalid JSON.")); }
    });
  });
}
function runFfmpeg(args, duration, job, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", buffer = "";
    child.stdout.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const match = /^out_time_ms=(\d+)/.exec(line.trim());
        if (match && duration > 0) {
          const seconds = Number(match[1]) / 1_000_000;
          void progress(job, 20 + seconds / duration * 58, mode === "remux" ? "remuxing" : "transcoding", mode);
        }
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-9000); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("ffmpeg failed (" + code + "): " + stderr.slice(-1600))));
  });
}
async function downloadAndVerify(job, prepared, path) {
  const response = await fetch(prepared.sourceUrl, { redirect: "follow", signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error("Source download failed (HTTP " + response.status + ").");
  const expected = Number(prepared.byteSize);
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_BYTES) throw new Error("Source exceeds the 4 GiB converter limit.");
  const hash = createHash("sha256");
  let bytes = 0, latest = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.byteLength;
      if (bytes > expected || bytes > MAX_BYTES) return done(new Error("Source download exceeded its declared size."));
      hash.update(chunk);
      const value = 2 + bytes / expected * 12;
      if (Math.floor(value) > latest) {
        latest = Math.floor(value);
        void progress(job, value, "downloading-source");
      }
      done(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(path, { flags: "wx" }));
  if (bytes !== expected) throw new Error("Downloaded source size does not match Google Drive metadata.");
  if (hash.digest("hex") !== String(prepared.sha256 || "").toLowerCase()) throw new Error("Source SHA-256 mismatch. Conversion was blocked.");
  return bytes;
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function uploadOutput(job, outputPath, sourceName) {
  const info = await stat(outputPath);
  if (!info.size || info.size > MAX_BYTES) throw new Error("Generated MP4 is empty or larger than 4 GiB.");
  const name = safePlaybackFilename(sourceName).replace(/\.compatible\.mp4$/i, ".nnb-compatible.mp4");
  const init = await callInternal(job, "output/init", {
    payload: { mediaType: "video", fileName: name, byteSize: info.size, sha256: await hashFile(outputPath), mimeType: "video/mp4" }
  });
  if (init.completed === true && init.asset?.id) return { assetId: init.asset.id, deduplicated: true };
  const assetId = String(init?.asset?.id || "");
  const partSize = Number(init?.upload?.partSize), count = Number(init?.upload?.totalParts);
  if (!UUID.test(assetId) || !Number.isSafeInteger(partSize) || partSize < 5 * MiB || !Number.isSafeInteger(count) || count < 1 || count > 10000) {
    throw new Error("Media API returned an invalid MP4 upload session.");
  }
  const file = await open(outputPath, "r");
  try {
    for (let part = 1; part <= count; part++) {
      const start = (part - 1) * partSize;
      const length = Math.min(partSize, info.size - start);
      const buffer = Buffer.allocUnsafe(length);
      const read = await file.read(buffer, 0, length, start);
      if (read.bytesRead !== length) throw new Error("Could not read MP4 output part " + part + ".");
      let lastError;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await callInternal(job, "output/" + assetId + "/parts/" + part, { method: "PUT", bytes: buffer });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt === 5 || (error.status && error.status < 500 && error.status !== 408 && error.status !== 429)) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(10000, 500 * (2 ** (attempt - 1)))));
        }
      }
      if (lastError) throw lastError;
      await progress(job, 80 + part / count * 18, "uploading-output");
    }
  } finally { await file.close(); }
  const complete = await callInternal(job, "output/" + assetId + "/complete", { payload: {} });
  if (complete.completed !== true || complete.outputAssetId !== assetId) throw new Error("Google Drive did not confirm the completed MP4.");
  return { assetId, deduplicated: false };
}
export async function runConverterJob(job) {
  // The Worker validates the HMAC, owner, source asset and workflow instance here.
  const prepared = await callInternal(job, "prepare", { payload: {} });
  const sourceSize = Number(prepared.byteSize);
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 1 || sourceSize > MAX_BYTES) throw new Error("Source exceeds the 4 GiB converter limit.");
  const work = await mkdtemp(join(tmpdir(), "nnb-converter-"));
  const input = join(work, "source.mkv"), output = join(work, "output.mp4");
  try {
    const disk = await statfs(work);
    if (Number(disk.bavail) * Number(disk.bsize) < sourceSize * 2 + 512 * MiB) throw new Error("Runner has insufficient temporary disk space.");
    await downloadAndVerify(job, prepared, input);
    await progress(job, 15, "probing-source");
    const sourceProbe = await probe(input);
    const mode = classifyPlaybackInput(sourceProbe);
    const duration = Number(sourceProbe?.format?.duration || 0);
    if (mode === "passthrough") {
      await progress(job, 72, "verifying-output", mode);
      await copyFile(input, output);
    } else {
      await progress(job, 20, mode === "remux" ? "remuxing" : "transcoding", mode);
      await runFfmpeg(buildFfmpegArgs(input, output, mode), duration, job, mode);
    }
    await progress(job, 79, "verifying-output", mode);
    const outputProbe = await probe(output);
    if (classifyPlaybackInput(outputProbe) !== "passthrough") throw new Error("Output failed the NNB H.264/AAC playback profile.");
    const result = await uploadOutput(job, output, prepared.fileName);
    return { ...result, mode, outputBytes: Number((await stat(output)).size) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH || "";
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is missing.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const job = validateConverterDispatchEvent(event);
  process.stdout.write("::add-mask::" + job.token + "\nAccepted NNB converter job " + job.jobId + ".\n");
  try {
    const result = await runConverterJob(job);
    process.stdout.write("Converter completed: " + result.mode + ", output asset " + result.assetId + ".\n");
  } catch (error) {
    try { await callInternal(job, "failed", { payload: { code: String(error?.code || "NNB_CONVERTER_FAILED"), message: String(error?.message || error).slice(0, 700) } }); }
    catch (reportError) { process.stderr.write("Could not report failure: " + String(reportError?.message || reportError) + "\n"); }
    throw error;
  }
}
if (process.argv[1]?.endsWith("github-actions-converter-runner.js")) {
  main().catch(error => { process.stderr.write("NNB converter failed: " + String(error?.message || error) + "\n"); process.exitCode = 1; });
}
