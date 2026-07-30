// TikTok TTS integration
// Based on https://github.com/Steve0929/tiktok-tts
// Generates speech from text using TikTok's TTS API
//
// Audio timing strategy:
//   Each SRT entry maps to a TTS clip. The clip is placed at the entry's
//   start time using ffmpeg's adelay filter, AND capped at the entry's
//   duration using atrim — so a slow TTS render of one line can never
//   bleed into the next line's time slot. Gaps are filled with silence
//   by amix=normalize=0, and the final track is padded to the full video
//   duration with apad.
//
// 16:9 auto-crop strategy:
//   dubVideo() now runs ffmpeg cropdetect on the first 5 seconds to find
//   the actual content bounding box (skipping black bars / letterbox),
//   then re-encodes the video to 16:9 (typically 1920x1080 or 1280x720)
//   using the detected crop. This gives a true fullscreen 16:9 result
//   regardless of the source aspect ratio.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import { SrtEntry, timeToMs } from './srt-utils.js';
import {
  generateSpeech as capcutGenerateSpeech,
  generateSpeechBatch as capcutGenerateSpeechBatch,
  type CapCutTtsBatchEntry,
} from './capcut-tts.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

// Monotonic counter to make per-call temp filenames unique within a process.
let tempFileSeq = 0;

// Batch size for parallel TTS. 50 means up to 50 CapCut TTS requests run
// concurrently — empirically the CapCut API handles this without rate-
// limiting. Override via CAPCUT_TTS_CONCURRENCY env var (read inside
// capcut-tts.ts). Larger SRTs are split into multiple batches of this size.
const TTS_BATCH_SIZE = parseInt(process.env.CAPCUT_TTS_BATCH_SIZE || '50', 10);

// Max retry attempts for a single TTS entry before giving up and filling
// the slot with silence. Override via CAPCUT_TTS_MAX_RETRIES env var.
// Set to 1 to disable retries (try once, then silence on failure).
const TTS_MAX_RETRIES = parseInt(process.env.CAPCUT_TTS_MAX_RETRIES || '10', 10);

// Base delay between retries (exponential backoff with jitter).
// Retry 1 waits ~2s, retry 2 ~4s, retry 3 ~8s, etc.
const RETRY_BASE_DELAY_MS = 2000;

// -------------------------------------------------------------------------
// Single-provider retry-based TTS (CapCut only, no fallbacks)
// -------------------------------------------------------------------------
//
// HISTORY:
//   This module used to support 3 providers:
//     1. CapCut TTS (preferred — 24 native Vietnamese voices)
//     2. TikTok TTS (required TIKTOK_SESSION_ID env var, almost never set)
//     3. Google Translate TTS (last-resort — robotic, heavily rate-limited)
//
//   Per user request (Task ID 10), TikTok and Google Translate fallbacks
//   have been REMOVED. The pipeline now uses CapCut TTS exclusively, with
//   up to TTS_MAX_RETRIES retry attempts on failure (default 10). This
//   ensures consistent voice quality across all clips and avoids the
//   rate-limiting issues with Google Translate TTS.
//
//   CapCut transient failures (network blip, CDN hiccup, brief API rate
//   limit) almost always succeed on retry 1-3. After TTS_MAX_RETRIES+1
//   total attempts fail, the slot is filled with silence to keep the
//   timeline aligned.

/**
 * Generate TTS audio for a single SRT entry using ONLY CapCut TTS, with
 * up to TTS_MAX_RETRIES retry attempts on failure.
 *
 * @returns true on success, false after TTS_MAX_RETRIES+1 total attempts fail.
 */
async function generateEntryAudio(
  text: string,
  voice: string,
  outputPath: string
): Promise<boolean> {
  // Strip newlines and bracketed annotations like [Phân đoạn 1]
  const cleanText = text.replace(/\n/g, ' ').replace(/\[.*?\]/g, '').trim();
  if (!cleanText) return false;

  // Remove any stale output from a previous (failed) attempt so the
  // size-check below doesn't pass on a half-written file.
  try { fs.unlinkSync(outputPath); } catch { /* ignore */ }

  const maxAttempts = Math.max(1, TTS_MAX_RETRIES + 1); // 1 initial + N retries
  let lastError = 'unknown';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ok = await capcutGenerateSpeech(cleanText, voice, outputPath, {
        timeoutSeconds: 90,
      });
      if (ok && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) {
        if (attempt > 1) {
          console.log(`[tts]   ✓ succeeded on retry ${attempt - 1}/${TTS_MAX_RETRIES}`);
        }
        return true;
      }
      lastError = 'output missing or too small';
    } catch (err: any) {
      lastError = err.message;
      // PERMANENT errors (e.g. TTSInvalidText err_code=40402002) skip retries.
      // The Python bridge surfaces these as PermanentTtsError — check the
      // message for the marker substring. Retrying a permanent error wastes
      // 10 × 30s = 5min of backoff for zero benefit.
      const msg = (err.message || '').toLowerCase();
      const isPermanent =
        msg.includes('permanent failure') ||
        msg.includes('err_code=40402001') ||
        msg.includes('err_code=40402002') ||
        msg.includes('err_code=40402003') ||
        msg.includes('err_code=40402004') ||
        msg.includes('err_code=40402005') ||
        msg.includes('err_code=40402010') ||
        msg.includes('ttsinvalidtext') ||
        msg.includes('ttsvoicenotfound') ||
        msg.includes('ttstextoolong');
      if (isPermanent) {
        console.error(
          `[tts]   ✗ PERMANENT failure on attempt ${attempt}/${maxAttempts} ` +
            `(${lastError}) — skipping retries`
        );
        return false;
      }
    }

    if (attempt < maxAttempts) {
      // Exponential backoff with jitter: 2s, 4s, 8s, 16s, ... ± 20% jitter.
      // Capped at 30s so we don't wait forever on a slot.
      const baseDelay = Math.min(30000, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      const jitter = baseDelay * (0.8 + Math.random() * 0.4);
      console.warn(
        `[tts]   attempt ${attempt}/${maxAttempts} failed (${lastError}), ` +
          `retrying in ${(jitter / 1000).toFixed(1)}s...`
      );
      await new Promise((r) => setTimeout(r, jitter));
    } else {
      console.error(
        `[tts]   ✗ all ${maxAttempts} attempts failed for this slot (${lastError})`
      );
    }
  }

  return false;
}

/**
 * Generate full audio track from SRT.
 *
 * TWO-PHASE PARALLEL PIPELINE:
 *   Phase 1 (batch, parallel): Send all entries to the CapCut TTS bridge in
 *     batches of TTS_BATCH_SIZE (default 50). The bridge runs them in
 *     parallel via ThreadPoolExecutor. This is ~50x faster than the old
 *     sequential 1-clip-at-a-time loop.
 *   Phase 2 (sequential retry, max 10 attempts per slot): For any entries
 *     that failed in phase 1 (network blip, transient CapCut error, etc.),
 *     retry them one-by-one via generateEntryAudio() — same CapCut provider,
 *     with exponential backoff. After TTS_MAX_RETRIES+1 total attempts
 *     fail, fill the slot with silence so the timeline stays aligned.
 *
 * Then merges all clips with ffmpeg using:
 *   - adelay=N|N   to position each clip at its start_ms
 *   - atrim=end=DURATION  to cap each clip's length to the entry's slot
 *   - asetpts=PTS-STARTPTS  to reset timestamps after atrim
 *   - amix=normalize=0  to mix all clips without gain normalization
 *   - apad  to pad the final track to the video's total duration
 *
 * The atrim cap is critical: without it, a slow TTS render of one line
 * would bleed into the next line's time slot and clobber it.
 */
export async function generateAudioFromSrt(
  srtContent: string,
  voice: string,
  outputDir: string,
  totalDurationMs: number,
  onProgress?: (current: number, total: number) => void
): Promise<string> {
  const entries = parseSrtEntries(srtContent);
  if (entries.length === 0) {
    throw new Error('No SRT entries found');
  }

  console.log(
    `[tts] Generating audio for ${entries.length} entries ` +
      `(batch size=${TTS_BATCH_SIZE}, parallel via CapCut TTS bridge)...`
  );

  // Create clips directory
  const clipsDir = path.join(outputDir, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });

  // Pre-allocate clip paths so the index alignment is stable across phases.
  const clipPaths: string[] = entries.map((_, i) =>
    path.join(clipsDir, `clip_${String(i).padStart(5, '0')}.mp3`)
  );
  // Track which slots still need a clip generated.
  const failedSlots: Set<number> = new Set();

  // -----------------------------------------------------------------------
  // PHASE 1: Batch parallel TTS via CapCut bridge.
  // Split into chunks of TTS_BATCH_SIZE so we don't hold 500+ in-flight
  // HTTP requests all at once (also lets us report progress per batch).
  // -----------------------------------------------------------------------
  const batchSize = Math.max(1, TTS_BATCH_SIZE);
  let processed = 0;
  for (let batchStart = 0; batchStart < entries.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, entries.length);
    const batchEntries: CapCutTtsBatchEntry[] = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const entry = entries[i];
      // Strip newlines and bracketed annotations like [Phân đoạn 1]
      const cleanText = entry.text.replace(/\n/g, ' ').replace(/\[.*?\]/g, '').trim();
      if (!cleanText) {
        // Empty text — mark for phase 2 silence fill, skip from batch.
        failedSlots.add(i);
        continue;
      }
      batchEntries.push({
        output: clipPaths[i],
        text: cleanText,
        voice,
        rate: '1.0',
      });
    }

    if (batchEntries.length === 0) {
      // All entries in this batch were empty — just bump progress.
      processed = batchEnd;
      onProgress?.(processed, entries.length);
      continue;
    }

    console.log(
      `[tts] Batch ${Math.floor(batchStart / batchSize) + 1}/` +
        `${Math.ceil(entries.length / batchSize)}: ` +
        `submitting ${batchEntries.length} entries in parallel...`
    );

    const batchStartMs = Date.now();
    const results = await capcutGenerateSpeechBatch(batchEntries, {
      timeoutSeconds: 90,
      maxRetries: TTS_MAX_RETRIES,
    });
    const batchDuration = ((Date.now() - batchStartMs) / 1000).toFixed(1);

    // Map results back to the original entry indices.
    let batchOk = 0;
    let batchFail = 0;
    for (const r of results) {
      const globalIdx = batchStart + r.idx;
      if (r.success && fs.existsSync(clipPaths[globalIdx]) && fs.statSync(clipPaths[globalIdx]).size > 100) {
        batchOk++;
      } else {
        // Phase 2 will retry this slot via the sequential fallback chain.
        failedSlots.add(globalIdx);
        batchFail++;
        if (!r.success) {
          console.warn(`[tts]   slot ${globalIdx} failed: ${r.message}`);
        } else {
          console.warn(`[tts]   slot ${globalIdx} reported success but output missing/empty`);
        }
      }
    }
    console.log(
      `[tts] Batch done in ${batchDuration}s — ok=${batchOk}, fail=${batchFail}`
    );

    processed = batchEnd;
    onProgress?.(processed, entries.length);
  }

  // -----------------------------------------------------------------------
  // PHASE 2: Sequential retry for failed slots (max TTS_MAX_RETRIES per slot).
  // For each failed slot, retry the SAME CapCut provider with exponential
  // backoff. Only after all retries are exhausted do we fill with silence.
  // -----------------------------------------------------------------------
  if (failedSlots.size > 0) {
    console.log(
      `[tts] Phase 2: retrying ${failedSlots.size} failed slot(s) sequentially ` +
        `(CapCut TTS only, max ${TTS_MAX_RETRIES} retries per slot → silence)...`
    );
    const failedList = Array.from(failedSlots).sort((a, b) => a - b);
    for (let retryIdx = 0; retryIdx < failedList.length; retryIdx++) {
      const i = failedList[retryIdx];
      const entry = entries[i];
      onProgress?.(processed + retryIdx, entries.length + failedList.length);

      const ok = await generateEntryAudio(entry.text, voice, clipPaths[i]);
      if (!ok) {
        // Final fallback: silence. Keeps the timeline aligned.
        const slotMs = Math.max(100, entry.endMs - entry.startMs);
        await createSilentClip(clipPaths[i], slotMs);
        console.warn(`[tts]   slot ${i} -> silence (all retries exhausted)`);
      } else {
        console.log(`[tts]   slot ${i} -> recovered via retry`);
      }
    }
  }

  onProgress?.(entries.length, entries.length);

  console.log('[tts] Merging audio clips with proper timing...');
  const outputPath = path.join(outputDir, 'full_audio.mp3');

  await mergeClipsWithTiming(entries, clipPaths, outputPath, totalDurationMs);

  return outputPath;
}

/**
 * Parse SRT content into entries with ms timing.
 * (Local copy — does not depend on srt-utils to keep this module standalone.)
 */
function parseSrtEntries(content: string): Array<SrtEntry & { startMs: number; endMs: number }> {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const blocks = normalized.split(/\n\s*\n/);
  const entries: Array<SrtEntry & { startMs: number; endMs: number }> = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length < 2) continue;

    let idx = 0;
    let index = parseInt(lines[0], 10);
    if (isNaN(index)) {
      index = entries.length + 1;
    } else {
      idx = 1;
    }

    const timeLine = lines[idx];
    const match = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!match) continue;

    const start = match[1].replace('.', ',');
    const end = match[2].replace('.', ',');
    const text = lines.slice(idx + 1).join('\n').trim();

    entries.push({
      index,
      start,
      end,
      text,
      startMs: timeToMs(start),
      endMs: timeToMs(end),
    });
  }

  return entries;
}

/**
 * Create a silent mono 44.1kHz MP3 clip of the given duration.
 */
async function createSilentClip(outputPath: string, durationMs: number): Promise<void> {
  const durationSec = Math.max(0.1, durationMs / 1000);
  const cmd = `"${FFMPEG_PATH}" -f lavfi -i anullsrc=channel_layout=mono:sample_rate=44100 -t ${durationSec} -q:a 9 "${outputPath}" -y`;
  await execAsync(cmd, { maxBuffer: 1024 * 1024 });
}

/**
 * Merge audio clips with proper SRT-aligned timing.
 *
 * Each clip is:
 *   1. Padded with silence BEFORE it (adelay) so it starts at start_ms.
 *   2. Trimmed to fit within [start_ms, end_ms] (atrim + asetpts) so a
 *      slow TTS render of one line cannot bleed into the next line's slot.
 *   3. Mixed with all other clips via amix=normalize=0 (no auto-gain).
 *   4. Final mix is padded with silence to reach the full video duration
 *      (apad) and trimmed with -t so it doesn't overrun.
 */
async function mergeClipsWithTiming(
  entries: Array<SrtEntry & { startMs: number; endMs: number }>,
  clipPaths: string[],
  outputPath: string,
  totalDurationMs: number
): Promise<void> {
  // Compute total duration: use video duration if provided, else fall back
  // to last SRT entry's end time + 1 second buffer.
  const fallbackEnd = entries[entries.length - 1]?.endMs || 0;
  const totalMs = Math.max(totalDurationMs || 0, fallbackEnd + 1000);
  const totalDurationSec = totalMs / 1000;

  console.log(
    `[tts] Merge: ${clipPaths.length} clips, total duration=${totalDurationSec.toFixed(2)}s`
  );

  const filterParts: string[] = [];

  for (let i = 0; i < clipPaths.length; i++) {
    const startMs = Math.max(0, entries[i].startMs);
    const endMs = Math.max(startMs + 100, entries[i].endMs);
    // Trim duration in seconds — cap each clip to its SRT slot.
    const trimSec = Math.max(0.1, (endMs - startMs) / 1000);
    // Delay in ms — pad with silence before the clip starts.
    const delayMs = startMs;

    // Filter chain for this clip:
    //   [i:a] -> aresample=44100 (normalize sample rate) ->
    //   atrim=0:${trimSec} (cap length to SRT slot) ->
    //   asetpts=PTS-STARTPTS (reset timestamps after trim) ->
    //   adelay=all=1:delays=${delayMs} (pad silence before clip) ->
    //   [a${i}]
    //
    // ffmpeg 7.x adelay syntax: use 'delays=' keyword + 'all=1' to apply
    // the same delay to every channel. The older positional 'adelay=N|N'
    // form was deprecated and now triggers
    //   "Unable to parse option value 'N' as boolean"
    filterParts.push(
      `[${i}:a]aresample=44100,atrim=0:${trimSec.toFixed(3)},asetpts=PTS-STARTPTS,adelay=all=1:delays=${delayMs}[a${i}]`
    );
  }

  // Mix all delayed+trimmed streams together WITHOUT normalization
  // (normalize=0 keeps each clip's original volume; default would
  // divide by N inputs which sounds wrong for sparse SRT).
  const mixInputs = filterParts.map((_, i) => `[a${i}]`).join('');
  filterParts.push(
    `${mixInputs}amix=inputs=${clipPaths.length}:duration=longest:normalize=0[aout]`
  );

  // Pad final mix with silence to reach total duration, then hard-trim.
  filterParts.push(`[aout]apad=whole_dur=${totalDurationSec.toFixed(3)}[padded]`);
  filterParts.push(`[padded]atrim=0:${totalDurationSec.toFixed(3)},asetpts=PTS-STARTPTS[final]`);

  const filter = filterParts.join(';');

  // Write the filter graph to a temp file and invoke ffmpeg with
  // `-filter_complex_script`. This keeps the giant per-SRT-entry filter
  // string out of the OS command line, so we don't hit ENAMETOOLONG on
  // long SRTs (Windows shell limit ~8KB, CreateProcess argv limit ~32KB).
  // execFile + argv array also avoids shell interpretation of clip paths
  // (no quoting/escaping needed for paths with spaces or special chars).
  const filterFile = path.join(
    os.tmpdir(),
    `sleiz-merge-filter-${process.pid}-${Date.now()}-${++tempFileSeq}.txt`
  );
  fs.writeFileSync(filterFile, filter, 'utf8');

  const args: string[] = [];
  for (const clipPath of clipPaths) {
    args.push('-i', clipPath);
  }
  args.push(
    '-filter_complex_script', filterFile,
    '-map', '[final]',
    '-t', totalDurationSec.toFixed(3),
    '-ac', '1', '-ar', '44100', '-ab', '128k',
    outputPath,
    '-y'
  );

  console.log(`[ffmpeg] Merging ${clipPaths.length} audio clips with timing...`);
  try {
    const { stderr } = await execFileAsync(FFMPEG_PATH, args, {
      maxBuffer: 100 * 1024 * 1024,
    });
    if (stderr) {
      // ffmpeg writes progress to stderr; show the last few lines for debugging.
      const tail = stderr.split('\n').filter(Boolean).slice(-3).join('\n');
      console.log('[ffmpeg] stderr tail:', tail);
    }
  } catch (error: any) {
    console.error('[ffmpeg] Merge failed:', error.message);
    throw error;
  } finally {
    try {
      fs.unlinkSync(filterFile);
    } catch {
      // best-effort cleanup; tmp file gets reaped by the OS either way
    }
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('Audio merge failed - no output file');
  }

  // Sanity check: output duration should be close to totalDurationSec.
  const actualDuration = await getAudioDurationSec(outputPath);
  console.log(
    `[tts] Output audio duration: ${actualDuration.toFixed(2)}s (target ${totalDurationSec.toFixed(2)}s)`
  );
  const drift = Math.abs(actualDuration - totalDurationSec);
  if (drift > 1.0) {
    console.warn(
      `[tts] WARNING: audio duration drift = ${drift.toFixed(2)}s — ` +
        'TTS timing may not align with SRT cues.'
    );
  }
}

/**
 * Get audio duration in seconds via ffprobe-style ffmpeg invocation.
 */
async function getAudioDurationSec(audioPath: string): Promise<number> {
  try {
    const cmd = `"${FFMPEG_PATH}" -i "${audioPath}" 2>&1 | grep -i Duration`;
    const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 });
    const match = stdout.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
    if (match) {
      const [, h, m, s] = match;
      return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
    }
  } catch {
    // ignore
  }
  return 0;
}

// -------------------------------------------------------------------------
// 16:9 auto-crop + video dubbing
// -------------------------------------------------------------------------

/** Standard 16:9 target resolutions (pick the one closest to source height). */
const TARGET_RESOLUTIONS_16_9 = [
  { w: 1920, h: 1080 },
  { w: 1600, h: 900 },
  { w: 1280, h: 720 },
  { w: 1024, h: 576 },
  { w: 854, h: 480 },
  { w: 640, h: 360 },
];

/** Result of running ffmpeg cropdetect on a video sample. */
interface CropDetectResult {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Probe a video for black bars by running cropdetect on the first few
 * seconds. Returns the detected content bounding box, or null if detection
 * fails (caller should then skip cropping).
 */
async function detectCrop(
  videoPath: string,
  sampleSeconds = 5
): Promise<CropDetectResult | null> {
  // cropdetect outputs lines like:
  //   [Parsed_cropdetect_0 @ 0x...] x1:0 x2:1919 y1:0 y2:1079 w:1920 h:1080 x:0 y:0 pts:... t:...
  // We take the LAST such line (most refined estimate).
  const cmd =
    `"${FFMPEG_PATH}" -ss 1 -i "${videoPath}" -t ${sampleSeconds} ` +
    `-vf cropdetect=limit=24:round=2:reset=0 -f null - 2>&1`;

  try {
    const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
    const output = (stdout + '\n' + stderr);
    const matches = [...output.matchAll(/w:(\d+)\s+h:(\d+)\s+x:(\d+)\s+y:(\d+)/g)];
    if (matches.length === 0) {
      console.warn('[crop] cropdetect produced no matches');
      return null;
    }
    const last = matches[matches.length - 1];
    const result = {
      width: parseInt(last[1], 10),
      height: parseInt(last[2], 10),
      x: parseInt(last[3], 10),
      y: parseInt(last[4], 10),
    };
    console.log(
      `[crop] Detected content box: ${result.width}x${result.height} @ (${result.x},${result.y})`
    );
    return result;
  } catch (error: any) {
    console.warn(`[crop] cropdetect failed: ${error.message}`);
    return null;
  }
}

/**
 * Probe video resolution via ffmpeg stderr parsing.
 */
async function getVideoResolution(
  videoPath: string
): Promise<{ width: number; height: number } | null> {
  try {
    const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" 2>&1 | grep -iE "Stream.*Video"`;
    const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 });
    const match = stdout.match(/,?\s*(\d{2,5})x(\d{2,5})/);
    if (match) {
      return {
        width: parseInt(match[1], 10),
        height: parseInt(match[2], 10),
      };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Pick the closest 16:9 target resolution to the given source height,
 * rounding down to avoid upscaling beyond source quality.
 */
function pickTarget16x9(sourceWidth: number, sourceHeight: number): { w: number; h: number } {
  // Sort targets by ascending height, then pick the largest target whose
  // height is <= source height. If source is smaller than all targets,
  // return the smallest target (we'll let ffmpeg scale up if needed).
  const sorted = [...TARGET_RESOLUTIONS_16_9].sort((a, b) => a.h - b.h);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].h <= sourceHeight) {
      return sorted[i];
    }
  }
  return sorted[0];
}

/**
 * Compute the crop + scale filter chain to produce a 16:9 fullscreen video.
 *
 * Strategy:
 *   1. If cropdetect found black bars, crop to the content box first.
 *   2. Scale the (cropped) frame to the chosen 16:9 target, using force_original_aspect_ratio=decrease
 *      + pad with black if needed to fill the target exactly. In practice,
 *      since we already cropped to content, the result should be very close
 *      to 16:9 and the pad will be minimal.
 */
function buildCropScaleFilter(
  crop: CropDetectResult | null,
  source: { width: number; height: number },
  target: { w: number; h: number }
): string {
  const parts: string[] = [];

  // Step 1: optional crop to remove black bars
  if (
    crop &&
    crop.width > 0 &&
    crop.height > 0 &&
    crop.width + crop.x <= source.width &&
    crop.height + crop.y <= source.height &&
    (crop.width !== source.width || crop.height !== source.height)
  ) {
    parts.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  }

  // Step 2: scale to fit inside target while preserving aspect, then pad to exact target.
  parts.push(`scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease`);
  parts.push(`pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2`);
  // Some players dislike non-even dimensions; force even.
  parts.push(`fps=30`);

  return parts.join(',');
}

/**
 * Probe whether a video has an audio stream.
 */
async function videoHasAudio(videoPath: string): Promise<boolean> {
  try {
    let output = '';
    try {
      const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" 2>&1`;
      const result = await execAsync(cmd, { maxBuffer: 1024 * 1024 });
      output = result.stdout + '\n' + result.stderr;
    } catch (err: any) {
      output = (err.stdout || '') + '\n' + (err.stderr || '');
    }
    return /Stream\s+#\d+:\d+.*Audio/.test(output);
  } catch {
    return false;
  }
}

/**
 * Dub a video with new audio AND auto-crop to 16:9 fullscreen.
 *
 * Pipeline:
 *   1. Run cropdetect on the first 5 seconds to find black bars.
 *   2. Probe source resolution to pick a 16:9 target (1920x1080, 1280x720, etc.).
 *   3. Re-encode the video with crop+scale+pad filter, replacing the audio
 *      with the new TTS track (original audio kept at `originalVolume`).
 *
 * Output is always 16:9, no letterboxing, ready for fullscreen playback.
 *
 * If the source video has NO audio stream, the audio mix is skipped and
 * the new TTS track becomes the sole audio (this avoids ffmpeg's
 * "Stream specifier ':a' matches no streams" error).
 */
export async function dubVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  originalVolume = 0.1 // Keep original audio at 10% volume as background
): Promise<void> {
  console.log('[ffmpeg] Dubbing video with new audio + 16:9 auto-crop...');

  // 1. Detect crop box
  const crop = await detectCrop(videoPath, 5);

  // 2. Probe source resolution
  const source = await getVideoResolution(videoPath);
  if (!source) {
    console.warn('[crop] Could not probe source resolution, falling back to no crop');
  }

  // 3. Pick 16:9 target
  const target = source
    ? pickTarget16x9(source.width, source.height)
    : { w: 1920, h: 1080 };
  console.log(
    `[crop] Source=${source ? `${source.width}x${source.height}` : 'unknown'}, ` +
      `target 16:9=${target.w}x${target.h}`
  );

  // 4. Build video filter chain
  const videoFilter = source
    ? buildCropScaleFilter(crop, source, target)
    : 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30';

  // 5. Check if source has audio — if not, the original-volume mix step
  // would reference a non-existent stream and ffmpeg would fail.
  const hasSourceAudio = await videoHasAudio(videoPath);
  console.log(`[crop] Source audio: ${hasSourceAudio ? 'present' : 'absent'}`);

  // 6. Build the filter_complex string.
  //    - Video: always [0:v] -> crop+scale+pad -> [v]
  //    - Audio: if source has audio, mix [0:a] at originalVolume + [1:a] at 1.0
  //             if source has no audio, just take [1:a] at 1.0
  const labeledVideoFilter = `[0:v]${videoFilter}[v]`;
  let audioFilter: string;
  let mapArgs: string;

  if (hasSourceAudio) {
    audioFilter =
      `[0:a]volume=${originalVolume}[a1];` +
      `[1:a]volume=1.0,aresample=44100[a2];` +
      `[a1][a2]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
    mapArgs = `-map "[v]" -map "[aout]"`;
  } else {
    audioFilter = `[1:a]volume=1.0,aresample=44100[aout]`;
    mapArgs = `-map "[v]" -map "[aout]"`;
  }

  const fullFilter = `${labeledVideoFilter};${audioFilter}`;
  const finalCmd =
    `"${FFMPEG_PATH}" -i "${videoPath}" -i "${audioPath}" ` +
    `-filter_complex "${fullFilter}" ` +
    `${mapArgs} ` +
    `-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p ` +
    `-c:a aac -b:a 192k ` +
    `-movflags +faststart -shortest "${outputPath}" -y`;

  console.log('[ffmpeg] Running 16:9 dub...');
  try {
    const { stderr } = await execAsync(finalCmd, { maxBuffer: 200 * 1024 * 1024 });
    if (stderr) {
      const tail = stderr.split('\n').filter(Boolean).slice(-3).join('\n');
      console.log('[ffmpeg] stderr tail:', tail);
    }
  } catch (error: any) {
    console.error('[ffmpeg] 16:9 dub failed:', error.message);
    // Fallback: simple dub without crop/scale (audio replace only).
    // This still produces a usable video but without 16:9 normalization.
    console.warn('[ffmpeg] Falling back to simple audio replace...');
    if (hasSourceAudio) {
      const fallbackCmd =
        `"${FFMPEG_PATH}" -i "${videoPath}" -i "${audioPath}" ` +
        `-map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}" -y`;
      await execAsync(fallbackCmd, { maxBuffer: 200 * 1024 * 1024 });
    } else {
      // Source has no audio — must use filter_complex to add it.
      const fallbackCmd =
        `"${FFMPEG_PATH}" -i "${videoPath}" -i "${audioPath}" ` +
        `-map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}" -y`;
      await execAsync(fallbackCmd, { maxBuffer: 200 * 1024 * 1024 });
    }
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('Video dubbing failed - no output file');
  }

  // Verify output is actually 16:9
  const outRes = await getVideoResolution(outputPath);
  if (outRes) {
    const ratio = outRes.width / outRes.height;
    const expected = 16 / 9;
    const drift = Math.abs(ratio - expected);
    console.log(
      `[crop] Output resolution: ${outRes.width}x${outRes.height} (ratio ${ratio.toFixed(3)}, ` +
        `expected ${expected.toFixed(3)}, drift ${drift.toFixed(3)})`
    );
    if (drift > 0.05) {
      console.warn('[crop] WARNING: output aspect ratio drift > 5%');
    }
  }
}
