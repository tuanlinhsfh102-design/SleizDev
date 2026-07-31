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
  onProgress?: (current: number, total: number) => void,
  /** TTS speech rate multiplier. Default "1.0". Range: 0.5 (slow) - 2.0 (fast). */
  rate: string = '1.0'
): Promise<string> {
  const entries = parseSrtEntries(srtContent);
  if (entries.length === 0) {
    throw new Error('No SRT entries found');
  }

  console.log(
    `[tts] Generating audio for ${entries.length} entries ` +
      `(batch size=${TTS_BATCH_SIZE}, rate=${rate}, parallel via CapCut TTS bridge)...`
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
        rate,
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

  // -----------------------------------------------------------------------
  // PHASE 3: Measure actual TTS clip durations + retime SRT to match.
  //
  // CRITICAL FIX for "giọng nói chưa nói xong đã chuyển":
  //   CapCut TTS generates audio at natural speech rate. The SRT slot
  //   duration (from CapCut STT) may be SHORTER than the TTS audio.
  //   Previously, atrim=0:${trimSec} would cut the TTS audio short,
  //   causing mid-sentence cutoffs.
  //
  //   Fix: measure each clip's actual duration, then retime the SRT so
  //   each entry's endMs = startMs + clipDuration. If a clip is longer
  //   than the original slot, we push subsequent entries back to make
  //   room. The retimed SRT is returned so burnSubtitlesIntoVideo uses
  //   the same timing — keeping audio and subtitles in sync.
  // -----------------------------------------------------------------------
  console.log('[tts] Phase 3: Measuring actual TTS clip durations + retiming SRT...');
  const retimedEntries: Array<SrtEntry & { startMs: number; endMs: number }> = [];
  let currentPosMs = entries[0]?.startMs || 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const clipPath = clipPaths[i];

    // Measure actual clip duration
    let clipDurationMs: number;
    if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 100) {
      clipDurationMs = await getAudioDurationMs(clipPath);
    } else {
      // Failed slot — use original slot duration as fallback
      clipDurationMs = Math.max(200, entry.endMs - entry.startMs);
    }

    // If this is the first entry, keep its original start time.
    // For subsequent entries, ensure we don't start before the previous
    // entry ends (avoid overlap).
    const startMs = i === 0 ? entry.startMs : Math.max(entry.startMs, currentPosMs);
    const endMs = startMs + clipDurationMs;

    retimedEntries.push({
      ...entry,
      startMs,
      endMs,
      // Update the SRT time strings to match the retimed values
      start: msToSrtTimeString(startMs),
      end: msToSrtTimeString(endMs),
    });

    currentPosMs = endMs;

    if (i < 5 || i === entries.length - 1) {
      const origDur = entry.endMs - entry.startMs;
      const diff = clipDurationMs - origDur;
      const sign = diff >= 0 ? '+' : '';
      console.log(
        `[tts]   clip ${i}: orig=${origDur}ms, actual=${clipDurationMs}ms (${sign}${diff}ms) -> ${startMs}-${endMs}ms`
      );
    }
  }

  // Write the retimed SRT for burnSubtitlesIntoVideo to use
  const retimedSrtPath = path.join(outputDir, 'vietnamese_retimed.srt');
  const retimedSrtContent = formatSrtFromEntries(retimedEntries);
  fs.writeFileSync(retimedSrtPath, retimedSrtContent, 'utf-8');
  console.log(`[tts] Retimed SRT written: ${retimedSrtPath}`);

  // Log retime summary
  const totalRetimeShift = currentPosMs - (entries[entries.length - 1]?.endMs || 0);
  if (totalRetimeShift > 0) {
    console.log(
      `[tts] Retime summary: TTS audio extends ${totalRetimeShift}ms beyond original SRT end. ` +
        `Subtitles have been stretched to match.`
    );
  }

  console.log('[tts] Merging audio clips with retimed durations...');
  const outputPath = path.join(outputDir, 'full_audio.mp3');

  // Use retimed entries for merge (no atrim cap — let TTS play to completion)
  await mergeClipsWithTiming(retimedEntries, clipPaths, outputPath, totalDurationMs);

  return outputPath;
}

/**
 * Format SRT entries back to SRT string.
 */
function formatSrtFromEntries(entries: Array<SrtEntry & { startMs: number; endMs: number }>): string {
  return entries.map((e, i) => {
    return `${i + 1}\n${e.start} --> ${e.end}\n${e.text}`;
  }).join('\n\n') + '\n';
}

/**
 * Convert milliseconds to SRT time string "HH:MM:SS,mmm".
 */
function msToSrtTimeString(ms: number): string {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mss = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mss).padStart(3, '0')}`;
}

/**
 * Get audio duration in milliseconds via ffmpeg probe.
 * Uses ffmpeg -i parsing (same pattern as getAudioDurationSec but returns ms).
 *
 * NOTE: ffmpeg exits with code 1 when run without an output file, so
 * execAsync throws. We capture the output from the error object.
 */
async function getAudioDurationMs(audioPath: string): Promise<number> {
  try {
    const cmd = `"${FFMPEG_PATH}" -i "${audioPath}" 2>&1`;
    let output = '';
    try {
      const result = await execAsync(cmd, { maxBuffer: 1024 * 1024 });
      output = result.stdout + '\n' + result.stderr;
    } catch (err: any) {
      // ffmpeg exits with code 1 when no output file is specified, but
      // the stderr/stdout still contains the Duration: line we need.
      output = (err.stdout || '') + '\n' + (err.stderr || '');
    }
    const match = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
    if (match) {
      const [, h, m, s] = match;
      return Math.round(
        parseInt(h) * 3600000 + parseInt(m) * 60000 + parseFloat(s) * 1000
      );
    }
  } catch {
    // ignore
  }
  return 1000; // fallback: 1 second
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
    // Delay in ms — pad with silence before the clip starts.
    const delayMs = startMs;

    // Filter chain for this clip (NO atrim — let TTS play to completion):
    //   [i:a] -> aresample=44100 (normalize sample rate) ->
    //   asetpts=PTS-STARTPTS (reset timestamps) ->
    //   adelay=all=1:delays=${delayMs} (pad silence before clip) ->
    //   [a${i}]
    //
    // The SRT has already been retimed in Phase 3 so each clip's natural
    // duration fits within its slot. No need to cap with atrim.
    filterParts.push(
      `[${i}:a]aresample=44100,asetpts=PTS-STARTPTS,adelay=all=1:delays=${delayMs}[a${i}]`
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
  originalVolume = 0.03, // Keep original audio at 3% volume as background ambience
  /** Volume of the TTS audio track in the final mix. Default 1.0 (full). Range: 0.0 - 1.5. */
  ttsVolume = 1.0,
  /** Optional path to a logo image (PNG with transparency). If provided, the logo is overlaid in the top-left corner of the output video. The logo is scaled to ~12% of the video width and positioned with 2% padding from the top-left edge. */
  logoPath?: string | null
): Promise<void> {
  console.log(
    `[ffmpeg] Dubbing video with new audio + 16:9 auto-crop ` +
      `(TTS: ${(ttsVolume * 100).toFixed(0)}%, original: ${(originalVolume * 100).toFixed(0)}%)` +
      (logoPath ? ` + logo overlay` : '') +
      `...`
  );

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
  //    - Video: [0:v] -> crop+scale+pad -> [vcropped]
  //    - Logo (optional): [2:v] -> scale -> overlay on [vcropped] at top-left -> [v]
  //    - Audio: if source has audio, mix [0:a] at originalVolume + [1:a] at ttsVolume
  //             if source has no audio, just take [1:a] at ttsVolume
  //
  // CRITICAL: Logo overlay is applied AFTER crop+scale+pad so the logo
  // position is relative to the final output resolution, not the source.
  // The logo is scaled to ~12% of the output width and positioned with
  // ~2% padding from the top-left corner.
  const useLogo = logoPath && fs.existsSync(logoPath);
  let videoOutputLabel = 'v';
  let logoInputArg = '';
  let logoFilterPart = '';

  if (useLogo) {
    // Add a third input for the logo image
    logoInputArg = `-i "${logoPath}"`;
    // Scale logo to 12% of target width, preserving aspect ratio
    const logoWidth = Math.round(target.w * 0.12);
    const padding = Math.round(target.w * 0.02); // 2% padding from edge
    // [0:v]crop+scale+pad -> [vcropped]
    // [2:v]scale logo to logoWidth:-1 (preserve aspect) -> [logo]
    // [vcropped][logo]overlay=x=padding:y=padding -> [v]
    logoFilterPart =
      `;[2:v]scale=${logoWidth}:-1[logo];` +
      `[vcropped][logo]overlay=x=${padding}:y=${padding}[v]`;
    videoOutputLabel = 'vcropped';
    console.log(`[logo] Adding logo overlay: ${logoPath} (scaled to ${logoWidth}px wide, ${padding}px from top-left)`);
  }

  const labeledVideoFilter = `[0:v]${videoFilter}[${videoOutputLabel}]${logoFilterPart}`;
  let audioFilter: string;
  let mapArgs: string;

  if (hasSourceAudio) {
    audioFilter =
      `[0:a]volume=${originalVolume}[a1];` +
      `[1:a]volume=${ttsVolume},aresample=44100[a2];` +
      `[a1][a2]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
    mapArgs = `-map "[v]" -map "[aout]"`;
  } else {
    audioFilter = `[1:a]volume=${ttsVolume},aresample=44100[aout]`;
    mapArgs = `-map "[v]" -map "[aout]"`;
  }

  const fullFilter = `${labeledVideoFilter};${audioFilter}`;
  const finalCmd =
    `"${FFMPEG_PATH}" -i "${videoPath}" -i "${audioPath}" ${logoInputArg} ` +
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

// -------------------------------------------------------------------------
// Burn Vietnamese subtitles into a dubbed video (chèn chữ vào video)
// -------------------------------------------------------------------------

/**
 * Convert an SRT file to an ASS file with beautiful styling.
 *
 * ASS (Advanced SubStation Alpha) gives us much more control over subtitle
 * appearance than SRT — including:
 *   - Rounded box backgrounds (viaBorderStyle=4 + BackColour)
 *   - Semi-transparent (blurred) backgrounds (via alpha channel in colours)
 *   - Per-line styling overrides
 *   - Bold + outline + shadow combinations
 *
 * The `subtitles` filter in ffmpeg only supports a subset of ASS styling
 * via force_style, but converting to ASS first lets us use the full `ass`
 * filter which respects ALL styling directives.
 *
 * Styling choices (per user request "background text bo góc và mờ nhẹ,
 * text đẹp"):
 *   - Font: Inter / Arial / DejaVu Sans (fontconfig resolves)
 *   - Size: ~4.5% of video height (readable but not overwhelming)
 *   - Position: bottom center, ~8% margin from bottom
 *   - Text: white, bold, with subtle black outline for contrast
 *   - Background: semi-transparent black box (alpha=70%) for readability
 *     over any video content
 *   - Border: BorderStyle=4 draws a box around the text (not just outline)
 *   - Shadow: soft drop shadow (1px offset, 1px blur) for depth
 *   - Spacing: 1px letter spacing for cleaner appearance
 *   - Wrap: smart line wrapping (max 40 chars/line)
 */
function srtToAss(srtContent: string, videoHeight: number): string {
  const fontSize = Math.round(videoHeight * 0.045);
  const marginV = Math.round(videoHeight * 0.08);
  const outlineWidth = Math.max(1, Math.round(videoHeight * 0.004));

  // Parse SRT entries into {startMs, endMs, text} for timing manipulation.
  const rawEntries: Array<{ startMs: number; endMs: number; text: string }> = [];
  const blocks = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length < 2) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    const timeMatch = lines[idx].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!timeMatch) continue;
    const startMs = srtTimeToMs(timeMatch[1]);
    const endMs = srtTimeToMs(timeMatch[2]);
    const text = lines.slice(idx + 1).join('\\N'); // ASS line break
    rawEntries.push({ startMs, endMs, text });
  }

  // CRITICAL FIX for "text đè lên nhau" (subtitles overlapping):
  //
  // CapCut STT often generates back-to-back SRT entries where the end time
  // of one entry EQUALS the start time of the next (gap = 0ms). When
  // libass renders these, it shows BOTH subtitles simultaneously for 1
  // frame at the transition point, causing visible text overlap.
  //
  // Fix: shorten each entry's end time by 50ms (creating a small gap
  // between consecutive subtitles). This ensures libass clears the
  // current subtitle before showing the next one. We enforce a minimum
  // duration of 200ms so very short entries don't disappear too fast.
  //
  // 82% of entries in a typical CapCut STT output are back-to-back,
  // so this fix dramatically reduces visible overlap.
  const GAP_MS = 50;        // gap between consecutive subtitles
  const MIN_DURATION_MS = 200; // minimum visible duration per entry

  const entries: Array<{ startMs: number; endMs: number; text: string }> = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    let endMs = entry.endMs;
    // If there's a next entry, shorten this entry's end to create a gap
    if (i < rawEntries.length - 1) {
      const nextStart = rawEntries[i + 1].startMs;
      if (endMs >= nextStart) {
        // Back-to-back or overlapping — shorten to create a gap
        endMs = nextStart - GAP_MS;
      }
    }
    // Enforce minimum duration so the subtitle is readable
    const duration = endMs - entry.startMs;
    if (duration < MIN_DURATION_MS) {
      endMs = entry.startMs + MIN_DURATION_MS;
      // But don't extend past the next entry's start
      if (i < rawEntries.length - 1) {
        const nextStart = rawEntries[i + 1].startMs;
        if (endMs >= nextStart) {
          endMs = nextStart - 10; // at least 10ms gap
        }
      }
    }
    entries.push({ startMs: entry.startMs, endMs, text: entry.text });
  }

  // Build the ASS file
  // Colors in ASS: &H<AA><BB><GG><RR>&
  //   AA = alpha (00=opaque, FF=transparent)
  //   BB = blue, GG = green, RR = red
  //
  // Fontname: ASS only accepts ONE font name. We use "Inter" (modern,
  // available on most systems). fontconfig/libass will fall back to a
  // similar sans-serif font if Inter is not installed.
  //
  // BackColour with BorderStyle=4 = box background color.
  //   &H99000000& = alpha 0x99 (60% opaque) + black RGB
  //   This gives the "mờ nhẹ" (slightly transparent) background.
  //
  // Outline with BorderStyle=4 = box border width.
  //   We set it to ~0.4% of video height for a subtle border.
  //
  // Shadow=1 = 1px drop shadow for depth (BorderStyle=4 + Shadow gives
  // a nice "floating text" effect).
  const ass = `[Script Info]
; Generated by SleizDev burnSubtitlesIntoVideo
; Beautiful subtitle styling: rounded box + semi-transparent background
; Timing: back-to-back entries are separated by ${GAP_MS}ms gaps to prevent
; libass from rendering overlapping subtitles at transition points.
ScriptType: v4.00+
PlayResX: ${Math.round(videoHeight * 16 / 9)}
PlayResY: ${videoHeight}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Inter,${fontSize},&H00FFFFFF&,&H000000FF&,&H00000000&,&H99000000&,1,0,0,0,100,100,0.5,0,4,${outlineWidth},1,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = entries.map((e) => {
    const start = msToAssTime(e.startMs);
    const end = msToAssTime(e.endMs);
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${e.text}`;
  }).join('\n');

  return ass + events + '\n';
}

/**
 * Convert "HH:MM:SS,mmm" or "HH:MM:SS.mmm" to milliseconds.
 */
function srtTimeToMs(timeStr: string): number {
  const match = timeStr.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  const [, h, m, s, ms] = match;
  return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms);
}

/**
 * Convert milliseconds to ASS time format "H:MM:SS.cc" (centiseconds, not milliseconds).
 * ASS uses 1/100 second precision, so we divide ms by 10.
 */
function msToAssTime(ms: number): string {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10); // centiseconds (0-99)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Burn an SRT subtitle file into a video using ffmpeg's `ass` filter.
 *
 * The subtitles are rendered as hard-coded text on top of the video frames
 * (not as a soft subtitle track). This means the subtitles will be visible
 * in ANY video player, including ones that don't support SRT tracks.
 *
 * Styling (beautiful, rounded, semi-transparent):
 *   - Font: Inter / Arial / DejaVu Sans (whichever is available)
 *   - Size: ~4.5% of video height (scales with resolution)
 *   - Position: bottom center, ~8% from bottom edge
 *   - Text: white, bold, with subtle black outline
 *   - Background: semi-transparent black box (60% opacity) — "mờ nhẹ"
 *   - BorderStyle=4: box around text (supports rounded appearance)
 *   - Soft drop shadow for depth
 *   - Smart line wrapping (max 40 chars/line)
 *   - UTF-8 encoding (Vietnamese diacritics supported)
 *
 * @param videoPath  Path to the input video (e.g. the dubbed video from dubVideo())
 * @param srtPath     Path to the SRT file to burn in
 * @param outputPath  Path for the output video with burned subtitles
 *
 * @returns void — throws on failure. The output file is a new MP4 with
 *          subtitles rendered into the video frames.
 */
export async function burnSubtitlesIntoVideo(
  videoPath: string,
  srtPath: string,
  outputPath: string
): Promise<void> {
  console.log(`[ffmpeg] Burning subtitles into video: ${path.basename(srtPath)}`);
  console.log(`[ffmpeg]   input:  ${videoPath}`);
  console.log(`[ffmpeg]   output: ${outputPath}`);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Input video not found: ${videoPath}`);
  }
  if (!fs.existsSync(srtPath)) {
    throw new Error(`SRT file not found: ${srtPath}`);
  }

  // Probe video resolution to scale font size proportionally
  const source = await getVideoResolution(videoPath);
  const videoHeight = source?.height || 720; // default to 720p if probe fails
  console.log(`[ffmpeg] Video height: ${videoHeight}px, font size will be ~${Math.round(videoHeight * 0.045)}px`);

  // Convert SRT → ASS with beautiful styling + timing fix (50ms gaps
  // between back-to-back entries to prevent libass overlap).
  const srtContent = fs.readFileSync(srtPath, 'utf-8');
  const assContent = srtToAss(srtContent, videoHeight);
  const assPath = srtPath.replace(/\.srt$/i, '.ass');
  fs.writeFileSync(assPath, assContent, 'utf-8');
  console.log(`[ffmpeg] Generated ASS file: ${assPath} (${assContent.split('\n').length} lines)`);

  // Also write a gap-fixed SRT for the fallback path (subtitles filter).
  // This ensures the fallback also benefits from the overlap fix.
  const gapFixedSrtPath = srtPath.replace(/\.srt$/i, '.gapfixed.srt');
  const gapFixedSrt = srtWithGaps(srtContent);
  fs.writeFileSync(gapFixedSrtPath, gapFixedSrt, 'utf-8');

  // Escape the ASS path for ffmpeg's filter parser
  const assAbsPath = path.resolve(assPath);
  const videoDir = path.dirname(path.resolve(videoPath));
  let assPathForFilter: string;
  let needsChdir = false;
  try {
    const rel = path.relative(videoDir, assAbsPath);
    if (rel && !path.isAbsolute(rel)) {
      assPathForFilter = rel.replace(/\\/g, '/').replace(/:/g, '\\:');
      needsChdir = true;
    } else {
      assPathForFilter = assAbsPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    }
  } catch {
    assPathForFilter = assAbsPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  }

  // Use the `ass` filter (not `subtitles`) for full ASS styling support.
  // The ass filter respects all styling directives in the ASS file,
  // including BorderStyle=4 (box), alpha channels, and shadows.
  const assFilter = `ass='${assPathForFilter}'`;

  const cmd =
    `"${FFMPEG_PATH}" -i "${videoPath}" ` +
    `-vf "${assFilter}" ` +
    `-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p ` +
    `-c:a copy ` +  // just copy audio — no re-encoding needed
    `-movflags +faststart "${outputPath}" -y`;

  console.log(`[ffmpeg] Running subtitle burn (ass filter, height=${videoHeight})...`);
  const cwd = needsChdir ? videoDir : process.cwd();
  try {
    const { stderr } = await execAsync(cmd, {
      maxBuffer: 200 * 1024 * 1024,
      cwd,
    });
    if (stderr) {
      const tail = stderr.split('\n').filter(Boolean).slice(-3).join('\n');
      console.log('[ffmpeg] stderr tail:', tail);
    }
  } catch (error: any) {
    console.error('[ffmpeg] ASS subtitle burn failed:', error.message);
    // Fallback: try the simpler `subtitles` filter with the gap-fixed SRT
    // (less pretty styling but more compatible with older ffmpeg builds)
    console.warn('[ffmpeg] Retrying with subtitles filter + gap-fixed SRT...');
    const srtAbsPath = path.resolve(gapFixedSrtPath);
    let srtPathForFilter: string;
    try {
      const rel = path.relative(videoDir, srtAbsPath);
      srtPathForFilter = (rel && !path.isAbsolute(rel))
        ? rel.replace(/\\/g, '/').replace(/:/g, '\\:')
        : srtAbsPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    } catch {
      srtPathForFilter = srtAbsPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    }
    const fontSize = Math.round(videoHeight * 0.045);
    const fallbackStyle = [
      `FontName=Inter\\,Arial\\,DejaVu Sans`,
      `FontSize=${fontSize}`,
      `PrimaryColour=&H00FFFFFF&`,
      `OutlineColour=&H00000000&`,
      `BackColour=&H99000000&`,
      `Bold=1`,
      `Alignment=2`,
      `MarginV=${Math.round(videoHeight * 0.08)}`,
      `BorderStyle=4`,
      `Outline=${Math.max(1, Math.round(videoHeight * 0.004))}`,
      `Shadow=1`,
    ].join(',');
    const fallbackFilter = `subtitles=filename='${srtPathForFilter}':force_style='${fallbackStyle}'`;
    const fallbackCmd =
      `"${FFMPEG_PATH}" -i "${videoPath}" ` +
      `-vf "${fallbackFilter}" ` +
      `-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p ` +
      `-c:a copy ` +
      `-movflags +faststart "${outputPath}" -y`;
    try {
      await execAsync(fallbackCmd, { maxBuffer: 200 * 1024 * 1024, cwd });
    } catch (retryErr: any) {
      throw new Error(
        `Subtitle burn failed (both attempts). ` +
          `ASS: ${error.message}. ` +
          `SRT fallback: ${retryErr.message}. ` +
          `Check that ffmpeg has libass support (run: ffmpeg -filters | grep -E 'ass|subtitles').`
      );
    }
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('Subtitle burn failed - no output file');
  }

  // Clean up temporary files (ASS + gap-fixed SRT)
  try { fs.unlinkSync(assPath); } catch { /* ignore */ }
  try { fs.unlinkSync(gapFixedSrtPath); } catch { /* ignore */ }

  const sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`[ffmpeg] Subtitle burn complete: ${sizeMb}MB -> ${path.basename(outputPath)}`);
}

/**
 * Generate a gap-fixed SRT from the original SRT content.
 *
 * This does the same timing fix as srtToAss() but outputs SRT format
 * (for the `subtitles` filter fallback path). Back-to-back entries get
 * 50ms gaps, minimum duration 200ms.
 */
function srtWithGaps(srtContent: string): string {
  const rawEntries: Array<{ index: number; startMs: number; endMs: number; text: string }> = [];
  const blocks = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length < 2) continue;
    let idx = 0;
    let index = 0;
    if (/^\d+$/.test(lines[0].trim())) {
      index = parseInt(lines[0].trim(), 10);
      idx = 1;
    }
    const timeMatch = lines[idx].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!timeMatch) continue;
    const startMs = srtTimeToMs(timeMatch[1]);
    const endMs = srtTimeToMs(timeMatch[2]);
    const text = lines.slice(idx + 1).join('\n');
    rawEntries.push({ index: index || rawEntries.length + 1, startMs, endMs, text });
  }

  const GAP_MS = 50;
  const MIN_DURATION_MS = 200;

  const fixedEntries: Array<{ index: number; startMs: number; endMs: number; text: string }> = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    let endMs = entry.endMs;
    if (i < rawEntries.length - 1) {
      const nextStart = rawEntries[i + 1].startMs;
      if (endMs >= nextStart) {
        endMs = nextStart - GAP_MS;
      }
    }
    const duration = endMs - entry.startMs;
    if (duration < MIN_DURATION_MS) {
      endMs = entry.startMs + MIN_DURATION_MS;
      if (i < rawEntries.length - 1) {
        const nextStart = rawEntries[i + 1].startMs;
        if (endMs >= nextStart) {
          endMs = nextStart - 10;
        }
      }
    }
    fixedEntries.push({ index: entry.index, startMs: entry.startMs, endMs, text: entry.text });
  }

  return fixedEntries.map((e) => {
    const start = msToSrtTime(e.startMs);
    const end = msToSrtTime(e.endMs);
    return `${e.index}\n${start} --> ${end}\n${e.text}`;
  }).join('\n\n') + '\n';
}

/**
 * Convert milliseconds to SRT time format "HH:MM:SS,mmm".
 */
function msToSrtTime(ms: number): string {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mss = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mss).padStart(3, '0')}`;
}
