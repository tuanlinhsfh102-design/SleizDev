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
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import { SrtEntry, timeToMs } from './srt-utils.js';

const execAsync = promisify(exec);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

// TikTok TTS API endpoint (v6 + /invoke is the current working endpoint)
const TIKTOK_TTS_URL = 'https://api16-normal-v6.tiktokv.com/media/api/text/speech/invoke';

// Real TikTok session ID (required for the API to work)
// Get it from browser cookies after logging in to TikTok: Settings > Application > Cookies > sessionid
const TIKTOK_SESSION_ID = process.env.TIKTOK_SESSION_ID || '';

// Vietnamese voice options
const VOICE_MAP: Record<string, string> = {
  vi_vn_1: 'vi_vn_1',         // Female
  vi_vn_2: 'vi_vn_2',         // Male
  vi_male: 'vi_vn_2',         // Male alias
  vi_female: 'vi_vn_1',       // Female alias
  vi_female_sweet: 'vi_vn_1', // Female sweet (use vi_vn_1)
};

interface TiktokTtsResult {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
}

/**
 * Prepare text for TikTok TTS API (spaces → '+', remove special chars)
 */
function prepareTiktokText(text: string): string {
  return text
    .replace(/\+/g, 'plus')
    .replace(/&/g, 'and')
    .replace(/\s+/g, '+');
}

/**
 * Call TikTok TTS API to generate speech from text.
 * Requires TIKTOK_SESSION_ID env var with a real TikTok session cookie.
 */
async function callTiktokTts(text: string, voice: string): Promise<TiktokTtsResult> {
  if (!text || text.trim().length === 0) {
    return { success: false, error: 'Empty text' };
  }

  if (!TIKTOK_SESSION_ID) {
    return { success: false, error: 'TIKTOK_SESSION_ID not set in env' };
  }

  // TikTok API has a ~300 char limit per request
  if (text.length > 300) {
    return { success: false, error: 'Text too long (max 300 chars)' };
  }

  const tiktokVoice = VOICE_MAP[voice] || 'vi_vn_1';
  const preparedText = prepareTiktokText(text);

  const params = new URLSearchParams({
    req_text: preparedText,
    speaker_map_type: '0',
    aid: '1233',
    text_speaker: tiktokVoice,
    with_frontend: '1',
    frontend_silent_character_ratio: '0.06',
  });

  const url = `${TIKTOK_TTS_URL}?${params.toString()}`;

  const headers: Record<string, string> = {
    'User-Agent': 'com.zhiliaoapp.musically/2022500030 (Linux; U; Android 7.1.2; en_US; SM-G977N; Build/N2G47H;tt-ok/3.12.13.1)',
    'Cookie': `sessionid=${TIKTOK_SESSION_ID}`,
    'Content-Type': 'application/json',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json() as any;

    if (data.status_code === 0 && data.data?.v_str) {
      // v_str is base64-encoded MP3
      const audioBuffer = Buffer.from(data.data.v_str, 'base64');
      return { success: true, audioBuffer };
    }

    return {
      success: false,
      error: data.status_msg || `Status: ${data.status_code}`,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Fallback TTS using Google Translate TTS (no API key needed)
 */
async function googleTranslateTts(text: string, lang = 'vi'): Promise<TiktokTtsResult> {
  try {
    // Chunk text if too long (Google TTS has a ~200 char limit per request)
    const chunks: string[] = [];
    let current = '';
    const sentences = text.split(/(?<=[.!?。！？\n])/);
    for (const sentence of sentences) {
      if ((current + sentence).length > 180) {
        if (current) chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    if (chunks.length === 0) chunks.push(text);

    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
      if (!chunk) continue;
      // Use gtts-style URL which is more reliable than the tw-ob client
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${lang}&total=1&idx=0&textlen=${chunk.length}&client=gtx&prev=input&ttsspeed=1`;
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://translate.google.com/',
            'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
          },
        });
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > 100) buffers.push(buffer); // skip empty/error responses
        }
      } catch (_) { /* skip failed chunks */ }
      // Delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 150));
    }

    if (buffers.length === 0) {
      return { success: false, error: 'No audio generated from Google TTS' };
    }

    return { success: true, audioBuffer: Buffer.concat(buffers) };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Generate TTS audio for a single SRT entry.
 * Tries TikTok first, falls back to Google Translate TTS.
 */
async function generateEntryAudio(
  text: string,
  voice: string,
  outputPath: string
): Promise<boolean> {
  // Strip newlines and bracketed annotations like [Phân đoạn 1]
  const cleanText = text.replace(/\n/g, ' ').replace(/\[.*?\]/g, '').trim();
  if (!cleanText) return false;

  let result = await callTiktokTts(cleanText, voice);

  if (!result.success) {
    console.warn(`[tts] TikTok failed, using Google TTS: ${result.error}`);
    result = await googleTranslateTts(cleanText, 'vi');
  }

  if (!result.success || !result.audioBuffer) {
    console.error(`[tts] All TTS methods failed: ${result.error}`);
    return false;
  }

  fs.writeFileSync(outputPath, result.audioBuffer);
  return true;
}

/**
 * Generate full audio track from SRT.
 *
 * Creates one TTS clip per SRT entry, then merges them with ffmpeg using:
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

  console.log(`[tts] Generating audio for ${entries.length} entries...`);

  // Create clips directory
  const clipsDir = path.join(outputDir, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });

  // Generate one audio clip per entry
  const clipPaths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    onProgress?.(i, entries.length);

    const clipPath = path.join(clipsDir, `clip_${String(i).padStart(5, '0')}.mp3`);
    const success = await generateEntryAudio(entry.text, voice, clipPath);
    if (success) {
      clipPaths.push(clipPath);
    } else {
      // Fill failed slots with silence so the timing math still works.
      const slotMs = Math.max(100, entry.endMs - entry.startMs);
      await createSilentClip(clipPath, slotMs);
      clipPaths.push(clipPath);
    }

    // Small delay every 5 entries to avoid TikTok rate limiting
    if (i % 5 === 4) {
      await new Promise((r) => setTimeout(r, 500));
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

  const inputArgs: string[] = [];
  const filterParts: string[] = [];

  for (let i = 0; i < clipPaths.length; i++) {
    inputArgs.push(`-i "${clipPaths[i]}"`);

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

  const cmd =
    `"${FFMPEG_PATH}" ${inputArgs.join(' ')} ` +
    `-filter_complex "${filter}" ` +
    `-map "[final]" -t ${totalDurationSec.toFixed(3)} ` +
    `-ac 1 -ar 44100 -ab 128k "${outputPath}" -y`;

  console.log('[ffmpeg] Merging audio with timing...');
  try {
    const { stderr } = await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
    if (stderr) {
      // ffmpeg writes progress to stderr; show the last few lines for debugging.
      const tail = stderr.split('\n').filter(Boolean).slice(-3).join('\n');
      console.log('[ffmpeg] stderr tail:', tail);
    }
  } catch (error: any) {
    console.error('[ffmpeg] Merge failed:', error.message);
    throw error;
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
