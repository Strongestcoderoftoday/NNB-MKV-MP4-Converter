import test from "node:test";
import assert from "node:assert/strict";
import { validateConverterDispatchEvent } from "../cloudflare/transcoder/src/github-actions-converter-runner.js";
import { buildFfmpegArgs, classifyPlaybackInput, safePlaybackFilename } from "../cloudflare/transcoder/src/transcode-utils.js";

const jobId = "11111111-2222-4333-8444-555555555555";
const token = "signed-nnb-worker-token";

test("runner accepts only the expected signed-job dispatch shape and fixes the Media API host", () => {
  const job = validateConverterDispatchEvent({ action: "nnb-mkv-convert", client_payload: { jobId, token } });
  assert.deepEqual(job, { jobId, token, mediaApiUrl: "https://nnb-media-api.tmqdinh.workers.dev" });
});
test("runner rejects wrong event types, malformed IDs and missing tokens", () => {
  assert.throws(() => validateConverterDispatchEvent({ action: "anything", client_payload: { jobId, token } }));
  assert.throws(() => validateConverterDispatchEvent({ action: "nnb-mkv-convert", client_payload: { jobId: "nope", token } }));
  assert.throws(() => validateConverterDispatchEvent({ action: "nnb-mkv-convert", client_payload: { jobId, token: "" } }));
});
test("compatible H.264/AAC in Matroska is remuxed; HEVC/Opus is transcoded", () => {
  const mkvH264 = { format: { format_name: "matroska,webm" }, streams: [
    { codec_type: "video", codec_name: "h264", profile: "High", level: 41, pix_fmt: "yuv420p", width: 1920, height: 1080, avg_frame_rate: "24/1" },
    { codec_type: "audio", codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2 }
  ] };
  const mkvHevcOpus = { format: { format_name: "matroska,webm" }, streams: [
    { codec_type: "video", codec_name: "hevc", profile: "Main", level: 120, pix_fmt: "yuv420p", width: 1920, height: 1080, avg_frame_rate: "24/1" },
    { codec_type: "audio", codec_name: "opus", channels: 6, sample_rate: "48000" }
  ] };
  assert.equal(classifyPlaybackInput(mkvH264), "remux");
  assert.equal(classifyPlaybackInput(mkvHevcOpus), "transcode");
});
test("transcode output arguments enforce the NNB H.264/AAC-LC MP4 profile", () => {
  const args = buildFfmpegArgs("source.mkv", "output.mp4", "transcode");
  const joined = args.join(" ");
  for (const value of ["libx264", "veryfast", "-crf 22", "-profile:v high", "-level 4.1", "yuv420p", "aac_low", "-b:a 192k", "-ac 2", "-ar 48000", "+faststart"]) {
    assert.ok(joined.includes(value), "missing FFmpeg option: " + value);
  }
  assert.ok(joined.includes("-sn"), "subtitle streams must remain external");
});
test("output filename is safe and ends with the MP4 compatibility suffix", () => {
  assert.equal(safePlaybackFilename("よるしかー.mkv"), "よるしかー.compatible.mp4");
  assert.equal(safePlaybackFilename("../evil:name.mkv"), "evil_name.compatible.mp4");
});
