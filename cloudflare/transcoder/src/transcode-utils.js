function parseFrameRate(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const ratio = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(raw);
  if (ratio) {
    const numerator = Number(ratio[1]);
    const denominator = Number(ratio[2]);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : null;
  }
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}
function isJapaneseAudioStream(stream) {
  const tags = stream?.tags && typeof stream.tags === "object" ? stream.tags : {};
  const language = String(tags.language || "").trim().toLowerCase().replace(/_/g, "-");
  if (/^(?:jpn|ja|jp|japanese)(?:$|-)/i.test(language)) return true;
  return /japanese|日本語|日本の音声/i.test(String(tags.title || "").trim());
}
export function findPreferredJapaneseAudioIndex(probe) {
  const audio = (Array.isArray(probe?.streams) ? probe.streams : []).filter(stream => stream?.codec_type === "audio");
  const candidates = audio.map((stream, index) => ({ stream, index })).filter(candidate => isJapaneseAudioStream(candidate.stream));
  if (!candidates.length) return null;
  return (candidates.find(candidate => Number(candidate.stream?.disposition?.default) === 1) || candidates[0]).index;
}
function needsJapaneseDefaultRewrite(probe, preferredAudioIndex) {
  if (!Number.isInteger(preferredAudioIndex)) return false;
  const audio = (Array.isArray(probe?.streams) ? probe.streams : []).filter(stream => stream?.codec_type === "audio");
  const selected = audio[preferredAudioIndex];
  if (!selected) return false;
  const language = String(selected?.tags?.language || "").trim().toLowerCase();
  return preferredAudioIndex !== 0 || Number(selected?.disposition?.default) !== 1 ||
    audio.some((stream, index) => index !== preferredAudioIndex && Number(stream?.disposition?.default) === 1) || language !== "jpn";
}
export function buildFfprobeArgs(inputPath) {
  return ["-v", "error", "-show_entries",
    "stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,channel_layout:stream_tags=language,title:stream_disposition=default:format=format_name,duration",
    "-of", "json", inputPath];
}
export function classifyPlaybackInput(probe, options = {}) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find(stream => stream.codec_type === "video");
  if (!video) throw new Error("The uploaded file does not contain a video stream.");
  if (options.forceTranscode === true) return "transcode";
  const audio = streams.filter(stream => stream.codec_type === "audio");
  const formatNames = String(probe?.format?.format_name || "").toLowerCase().split(",");
  const mp4 = formatNames.some(name => ["mp4", "mov", "m4a"].includes(name));
  const preferred = options.preferJapaneseAudio ? findPreferredJapaneseAudioIndex(probe) : null;
  const rewriteJapaneseDefault = options.preferJapaneseAudio === true && needsJapaneseDefaultRewrite(probe, preferred);
  const codec = String(video.codec_name || "").toLowerCase() === "h264";
  const pixel = ["yuv420p", "yuvj420p"].includes(String(video.pix_fmt || "").toLowerCase());
  const profile = String(video.profile || "").trim().toLowerCase();
  const profileOk = !profile || ["baseline", "constrained baseline", "main", "high"].includes(profile);
  const level = Number(video.level);
  const levelOk = !Number.isFinite(level) || level <= 41;
  const width = Number(video.width || 0), height = Number(video.height || 0);
  const sizeOk = (!width || width <= 1920) && (!height || height <= 1080);
  const fps = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);
  const fpsOk = fps == null || fps <= 30.1;
  const audioOk = audio.every(stream => {
    if (String(stream.codec_name || "").toLowerCase() !== "aac") return false;
    const aProfile = String(stream.profile || "").trim().toLowerCase();
    if (aProfile && aProfile !== "lc") return false;
    const channels = stream.channels == null || stream.channels === "" ? null : Number(stream.channels);
    if (channels != null && (!Number.isFinite(channels) || channels > 2)) return false;
    const rate = stream.sample_rate == null || stream.sample_rate === "" ? null : Number(stream.sample_rate);
    return rate == null || (Number.isFinite(rate) && rate <= 48000);
  });
  if (codec && pixel && profileOk && levelOk && sizeOk && fpsOk && audioOk) {
    if (!mp4 || rewriteJapaneseDefault) return "remux";
    return "passthrough";
  }
  return "transcode";
}
function preferredAudioMapping(options = {}) {
  const index = options.preferredAudioIndex == null ? -1 : Number(options.preferredAudioIndex);
  const count = Number(options.audioStreamCount);
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(count) || count < 1 || index >= count) return null;
  return [index, ...Array.from({ length: count }, (_, i) => i).filter(i => i !== index)];
}
function appendAudioMappings(args, options = {}) {
  const mapping = preferredAudioMapping(options);
  if (!mapping) { args.push("-map", "0:a?"); return; }
  for (const index of mapping) args.push("-map", "0:a:" + index);
}
function applyJapaneseAudioDefault(args, options = {}) {
  const mapping = preferredAudioMapping(options);
  if (!mapping) return args;
  for (let i = 0; i < mapping.length; i++) args.push("-disposition:a:" + i, i === 0 ? "+default" : "-default");
  args.push("-metadata:s:a:0", "language=jpn");
  return args;
}
export function buildFfmpegArgs(inputPath, outputPath, mode, options = {}) {
  if (mode === "remux") {
    const args = ["-nostdin", "-y", "-i", inputPath, "-map", "0:v:0", "-c", "copy",
      "-movflags", "+faststart", "-f", "mp4", "-stats_period", "5", "-progress", "pipe:1", "-nostats"];
    appendAudioMappings(args, options);
    applyJapaneseAudioDefault(args, options);
    args.push(outputPath);
    return args;
  }
  if (mode !== "transcode") throw new TypeError("Only remux and transcode modes produce a new MP4.");
  const args = ["-nostdin", "-y", "-i", inputPath, "-map", "0:v:0", "-sn",
    "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p,fps='min(30,source_fps)'",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-profile:v", "high", "-level", "4.1",
    "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "192k", "-ac", "2", "-ar", "48000",
    "-movflags", "+faststart", "-f", "mp4", "-stats_period", "5", "-progress", "pipe:1", "-nostats"];
  appendAudioMappings(args, options);
  applyJapaneseAudioDefault(args, options);
  args.push(outputPath);
  return args;
}
export function safePlaybackFilename(value) {
  const raw = Array.from(String(value || "episode").normalize("NFKC"), ch =>
    ch === "\\" || "/:*?\"<>|".includes(ch) || ch.charCodeAt(0) < 32 ? "_" : ch).join("");
  const base = raw.replace(/^[._\s]+/, "").replace(/\.[^.]+$/, "").trim().slice(0, 180) || "episode";
  return base + ".compatible.mp4";
}
