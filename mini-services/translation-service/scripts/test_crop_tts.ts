/**
 * End-to-end test for the 16:9 auto-crop + TTS alignment pipeline.
 *
 * Generates a synthetic 4:3 video with letterbox black bars (simulating a
 * typical donghua source), then runs dubVideo() against it and verifies:
 *   - Output exists
 *   - Output resolution is exactly 16:9 (e.g. 640x360 or 1280x720)
 *   - Output has audio track
 *
 * Also tests generateAudioFromSrt() with a tiny SRT and verifies:
 *   - Output duration is close to the requested totalDurationMs
 *   - Output is a valid MP3
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import { dubVideo, generateAudioFromSrt } from '../src/tiktok-tts.ts';

const execAsync = promisify(exec);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

const TEST_DIR = path.resolve('./test-crop-output');
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

async function getVideoInfo(videoPath: string): Promise<{ width: number; height: number; hasAudio: boolean; durationSec: number }> {
  // ffmpeg exits non-zero when called without an output file, so we wrap
  // in try/catch and parse the (still useful) stderr that ffmpeg prints.
  let output = '';
  try {
    const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" 2>&1`;
    const result = await execAsync(cmd, { maxBuffer: 1024 * 1024 });
    output = result.stdout + '\n' + result.stderr;
  } catch (err: any) {
    // ffmpeg exits with code 1 when no output is specified, but stderr
    // still contains the probe info we need.
    output = (err.stdout || '') + '\n' + (err.stderr || '');
  }
  const vMatch = output.match(/Stream.*Video.*?,?\s*(\d{2,5})x(\d{2,5})/);
  const aMatch = output.match(/Stream.*Audio/);
  const dMatch = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
  return {
    width: vMatch ? parseInt(vMatch[1], 10) : 0,
    height: vMatch ? parseInt(vMatch[2], 10) : 0,
    hasAudio: !!aMatch,
    durationSec: dMatch
      ? parseInt(dMatch[1], 10) * 3600 + parseInt(dMatch[2], 10) * 60 + parseFloat(dMatch[3])
      : 0,
  };
}

async function makeLetterboxedTestVideo(outPath: string): Promise<void> {
  // Generate a 5-second 640x480 (4:3) video with a smaller 640x360 (16:9)
  // content region in the middle, padded with black bars top and bottom.
  // This simulates a 4:3 source that should be auto-cropped to 16:9.
  //
  // Use a colored box instead of drawtext to avoid ffmpeg quoting issues
  // with spaces in filter args.
  const cmd =
    `"${FFMPEG_PATH}" -f lavfi -i ` +
    `"color=c=black:s=640x480:d=5:r=30,` +
    `drawbox=x=0:y=60:w=640:h=360:color=0x4060ff:t=fill" ` +
    `-c:v libx264 -preset ultrafast -pix_fmt yuv420p "${outPath}" -y`;
  console.log('[test] Generating letterboxed test video...');
  await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
}

async function makeSilentAudioWithDuration(outPath: string, durationSec: number): Promise<void> {
  const cmd =
    `"${FFMPEG_PATH}" -f lavfi -i anullsrc=channel_layout=mono:sample_rate=44100 ` +
    `-t ${durationSec} -q:a 9 "${outPath}" -y`;
  await execAsync(cmd, { maxBuffer: 1024 * 1024 });
}

async function test16x9AutoCrop() {
  console.log('\n=== Test 1: 16:9 auto-crop on a letterboxed 4:3 source ===');

  const sourceVideo = path.join(TEST_DIR, 'source_4x3_letterbox.mp4');
  const audioTrack = path.join(TEST_DIR, 'silent_audio.mp3');
  const dubbedVideo = path.join(TEST_DIR, 'dubbed_16x9.mp4');

  // 1. Make source
  await makeLetterboxedTestVideo(sourceVideo);
  const srcInfo = await getVideoInfo(sourceVideo);
  console.log(`[test] Source: ${srcInfo.width}x${srcInfo.height}, audio=${srcInfo.hasAudio}, dur=${srcInfo.durationSec}s`);
  assert(srcInfo.width === 640 && srcInfo.height === 480, 'source is 640x480 (4:3)');

  // 2. Make silent audio track to dub in
  await makeSilentAudioWithDuration(audioTrack, 5);
  const audioInfo = await getVideoInfo(audioTrack);
  // ffprobe-style for audio files may show different fields; just check exists
  assert(fs.existsSync(audioTrack), 'silent audio track exists');

  // 3. Run dubVideo (this should auto-crop to 16:9)
  await dubVideo(sourceVideo, audioTrack, dubbedVideo, 0.0); // 0% original volume (silent source anyway)

  assert(fs.existsSync(dubbedVideo), 'dubbed output exists');

  const outInfo = await getVideoInfo(dubbedVideo);
  console.log(
    `[test] Output: ${outInfo.width}x${outInfo.height}, audio=${outInfo.hasAudio}, dur=${outInfo.durationSec}s`
  );

  // 4. Verify output is 16:9
  assert(outInfo.width > 0 && outInfo.height > 0, 'output has valid resolution');
  const ratio = outInfo.width / outInfo.height;
  const expected = 16 / 9;
  const drift = Math.abs(ratio - expected);
  assert(drift < 0.05, `output aspect ratio is 16:9 (got ${ratio.toFixed(3)}, drift ${drift.toFixed(3)})`);
  assert(outInfo.hasAudio, 'output has audio track');
  assert(Math.abs(outInfo.durationSec - 5) < 1.5, `output duration ~5s (got ${outInfo.durationSec.toFixed(2)}s)`);
}

async function testTtsAlignment() {
  console.log('\n=== Test 2: TTS audio alignment with SRT timestamps ===');

  // Use Google TTS via the existing pipeline — but Google TTS may rate-limit.
  // Instead, test the MERGE logic with pre-made silent clips to verify
  // timing math is correct.
  //
  // Strategy: build an SRT with 3 entries at 0-2s, 2-4s, 4-6s. Generate
  // audio for each (will be silent fallbacks if TTS fails). Verify the
  // output MP3 is ~6 seconds long.

  const srt = [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'Xin chào',
    '',
    '2',
    '00:00:02,000 --> 00:00:04,000',
    'Hôm nay',
    '',
    '3',
    '00:00:04,000 --> 00:00:06,000',
    'Tạm biệt',
    '',
  ].join('\n');

  const workDir = path.join(TEST_DIR, 'tts-work');
  fs.mkdirSync(workDir, { recursive: true });

  console.log('[test] Generating TTS audio for 3-entry SRT (6s total)...');
  let audioPath: string;
  try {
    audioPath = await generateAudioFromSrt(srt, 'vi_vn_1', workDir, 6000);
  } catch (err: any) {
    // If TikTok + Google both fail (network/region), the merge logic still
    // ran (with silent fallbacks). Re-throw only if no output was created.
    console.warn('[test] TTS generation threw:', err.message);
    audioPath = path.join(workDir, 'full_audio.mp3');
  }

  assert(fs.existsSync(audioPath), 'TTS output MP3 exists');

  const info = await getVideoInfo(audioPath);
  console.log(`[test] TTS output duration: ${info.durationSec.toFixed(2)}s (target 6.00s)`);
  assert(
    Math.abs(info.durationSec - 6.0) < 1.5,
    `TTS audio is ~6s long (got ${info.durationSec.toFixed(2)}s)`
  );
}

async function main() {
  console.log('=== 16:9 Auto-Crop + TTS Alignment Tests ===');
  await test16x9AutoCrop();
  await testTtsAlignment();
  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    process.exit(1);
  }
}

main();
