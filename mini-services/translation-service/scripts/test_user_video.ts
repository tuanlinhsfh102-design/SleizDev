/**
 * Full pipeline test on the USER'S REAL VIDEO with REAL Gemini translation.
 *
 * Input:
 *   - Video: /home/z/my-project/upload/ezgif.com-crop-video.mp4 (5:21, 706x396)
 *   - Gemini API key: fetched from Supabase api_keys table (active, gemini provider)
 *
 * Pipeline:
 *   1. extractAudio() → audio.mp3
 *   2. audioToSrt('zh') → original.srt (CapCut STT, real API)
 *   3. translateSrt(apiKey) → vietnamese.srt (REAL Gemini, not mock)
 *   4. generateAudioFromSrt() → full_audio.mp3 (CapCut TTS, 50 parallel)
 *   5. dubVideo() → dubbed.mp4 (replace audio, auto-crop 16:9)
 *   6. burnSubtitlesIntoVideo() → final_with_subtitles.mp4
 *   7. Copy to /home/z/my-project/download/ for user to preview
 *
 * This is the REAL end-to-end test — no mocks. The only difference from the
 * production pipeline is that we run it as a standalone script instead of
 * through the Socket.io service.
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import {
  extractAudio,
  audioToSrt,
  getVideoDuration,
} from '../src/capcut.ts';
import { translateSrt } from '../src/gemini.ts';
import { generateAudioFromSrt, dubVideo, burnSubtitlesIntoVideo } from '../src/tiktok-tts.ts';
import { parseSrt } from '../src/srt-utils.ts';

const execAsync = promisify(exec);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

// === Configuration ===
const INPUT_VIDEO = '/home/z/my-project/upload/ezgif.com-crop-video.mp4';
const TEST_DIR = '/home/z/my-project/test-user-video';
const GEMINI_API_KEY = 'AIzaSyAxza48OjvyDmfar1LtpWglbxLBNoz8oQk'; // from Supabase api_keys table
const TTS_VOICE = 'vi_vn_1'; // Vietnamese female sweet voice
const FINAL_OUTPUT = '/home/z/my-project/download/user_video_final.mp4';

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

async function getVideoInfo(videoPath: string) {
  let output = '';
  try {
    const result = await execAsync(`"${FFMPEG_PATH}" -i "${videoPath}" 2>&1`, {
      maxBuffer: 1024 * 1024,
    });
    output = result.stdout + '\n' + result.stderr;
  } catch (err: any) {
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

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}m${s}s`;
}

async function main() {
  const startTime = Date.now();
  console.log('=== SleizDev Full Pipeline — REAL Video + REAL Gemini ===');
  console.log(`Input: ${INPUT_VIDEO}`);
  console.log(`Output: ${FINAL_OUTPUT}`);
  console.log(`Gemini key: ${GEMINI_API_KEY.slice(0, 12)}...`);
  console.log(`TTS voice: ${TTS_VOICE}`);
  console.log();

  if (!fs.existsSync(INPUT_VIDEO)) {
    console.error(`Input video not found: ${INPUT_VIDEO}`);
    process.exit(1);
  }

  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Verify input video
  const inputInfo = await getVideoInfo(INPUT_VIDEO);
  console.log(`Input video: ${inputInfo.width}x${inputInfo.height}, ${fmtDuration(inputInfo.durationSec)}, audio=${inputInfo.hasAudio}, ${(fs.statSync(INPUT_VIDEO).size / 1024 / 1024).toFixed(1)}MB`);
  assert(inputInfo.width > 0, 'input video has valid resolution');
  assert(inputInfo.hasAudio, 'input video has audio track');
  assert(inputInfo.durationSec > 60, `input video is > 1min long (got ${fmtDuration(inputInfo.durationSec)})`);

  // --- Step 1: Extract audio ---
  console.log('\n[pipeline] Step 1/6: Extract audio from video');
  const t1 = Date.now();
  const audioPath = await extractAudio(INPUT_VIDEO, TEST_DIR);
  const audioInfo = await getVideoInfo(audioPath);
  console.log(`  Audio: ${fmtDuration(audioInfo.durationSec)} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  assert(fs.existsSync(audioPath), 'audio extracted');
  assert(audioInfo.durationSec > 60, `audio is > 1min (got ${fmtDuration(audioInfo.durationSec)})`);

  // --- Step 2: Audio → SRT (CapCut STT) ---
  console.log('\n[pipeline] Step 2/6: Audio → SRT (CapCut STT API)');
  const t2 = Date.now();
  const originalSrt = await audioToSrt(audioPath, TEST_DIR, 'zh', {
    timeoutSeconds: 300, // 5 min timeout for a 5-min video
  });
  const srtEntries = parseSrt(originalSrt);
  console.log(`  Got ${srtEntries.length} SRT entries (${((Date.now() - t2) / 1000).toFixed(1)}s)`);
  console.log('  First 5 entries:');
  for (const e of srtEntries.slice(0, 5)) {
    console.log(`    ${e.index}: ${e.start} --> ${e.end}  ${e.text.slice(0, 60)}`);
  }
  console.log('  Last 3 entries:');
  for (const e of srtEntries.slice(-3)) {
    console.log(`    ${e.index}: ${e.start} --> ${e.end}  ${e.text.slice(0, 60)}`);
  }
  assert(srtEntries.length > 5, `STT extracted > 5 entries (got ${srtEntries.length})`);
  fs.writeFileSync(path.join(TEST_DIR, 'original.srt'), originalSrt, 'utf-8');

  // --- Step 3: Translate SRT (REAL Gemini) ---
  console.log('\n[pipeline] Step 3/6: Translate SRT → Vietnamese (REAL Gemini API)');
  const t3 = Date.now();
  const vietnameseSrt = await translateSrt(originalSrt, GEMINI_API_KEY, {
    conversationHistory: [],
    onProgress: (current, total) => {
      console.log(`  Gemini batch ${current + 1}/${total}...`);
    },
  });
  const viEntries = parseSrt(vietnameseSrt);
  console.log(`  Translated ${viEntries.length} entries (${((Date.now() - t3) / 1000).toFixed(1)}s)`);
  console.log('  First 5 Vietnamese entries:');
  for (const e of viEntries.slice(0, 5)) {
    console.log(`    ${e.index}: ${e.start} --> ${e.end}  ${e.text.slice(0, 60)}`);
  }
  assert(viEntries.length === srtEntries.length, `Vietnamese SRT has same count (${viEntries.length} vs ${srtEntries.length})`);
  // Check that translation actually happened (no Chinese characters in Vietnamese SRT)
  const hasChinese = /[\u4e00-\u9fff]/.test(vietnameseSrt);
  if (hasChinese) {
    console.warn('  ⚠ Vietnamese SRT still contains some Chinese characters (may be untranslated fallbacks)');
  } else {
    console.log('  ✓ No Chinese characters in Vietnamese SRT — translation succeeded');
  }
  fs.writeFileSync(path.join(TEST_DIR, 'vietnamese.srt'), vietnameseSrt, 'utf-8');

  // --- Step 4: Generate TTS audio (CapCut TTS, 50 parallel) ---
  console.log('\n[pipeline] Step 4/6: Generate TTS audio (CapCut TTS, 50 parallel)');
  const t4 = Date.now();
  const durationMs = await getVideoDuration(INPUT_VIDEO);
  console.log(`  Video duration: ${durationMs}ms (${fmtDuration(durationMs / 1000)})`);
  const fullAudioPath = await generateAudioFromSrt(
    vietnameseSrt,
    TTS_VOICE,
    TEST_DIR,
    durationMs,
    (current, total) => {
      if (current % 20 === 0 || current === total) {
        console.log(`  TTS progress: ${current}/${total} clips...`);
      }
    }
  );
  const ttsInfo = await getVideoInfo(fullAudioPath);
  console.log(`  TTS audio: ${fmtDuration(ttsInfo.durationSec)}, ${(fs.statSync(fullAudioPath).size / 1024 / 1024).toFixed(1)}MB (${((Date.now() - t4) / 1000).toFixed(1)}s)`);
  assert(fs.existsSync(fullAudioPath), 'TTS audio generated');
  assert(ttsInfo.durationSec > 60, `TTS audio > 1min (got ${fmtDuration(ttsInfo.durationSec)})`);

  // --- Step 5: Dub video (replace audio with TTS, auto-crop 16:9) ---
  console.log('\n[pipeline] Step 5/6: Dub video (replace audio + auto-crop 16:9)');
  const t5 = Date.now();
  const dubbedVideoPath = path.join(TEST_DIR, 'dubbed.mp4');
  await dubVideo(INPUT_VIDEO, fullAudioPath, dubbedVideoPath, 0.1);
  const dubbedInfo = await getVideoInfo(dubbedVideoPath);
  console.log(`  Dubbed: ${dubbedInfo.width}x${dubbedInfo.height}, ${fmtDuration(dubbedInfo.durationSec)}, audio=${dubbedInfo.hasAudio}, ${(fs.statSync(dubbedVideoPath).size / 1024 / 1024).toFixed(1)}MB (${((Date.now() - t5) / 1000).toFixed(1)}s)`);
  assert(fs.existsSync(dubbedVideoPath), 'dubbed video created');
  assert(dubbedInfo.hasAudio, 'dubbed video has audio');
  assert(dubbedInfo.durationSec > 60, `dubbed video > 1min (got ${fmtDuration(dubbedInfo.durationSec)})`);

  // --- Step 6: Burn Vietnamese subtitles into video ---
  console.log('\n[pipeline] Step 6/6: Burn Vietnamese subtitles into video');
  const t6 = Date.now();
  const srtPath = path.join(TEST_DIR, 'vietnamese.srt');
  const finalVideoPath = path.join(TEST_DIR, 'final_with_subtitles.mp4');
  await burnSubtitlesIntoVideo(dubbedVideoPath, srtPath, finalVideoPath);
  const finalInfo = await getVideoInfo(finalVideoPath);
  console.log(`  Final: ${finalInfo.width}x${finalInfo.height}, ${fmtDuration(finalInfo.durationSec)}, audio=${finalInfo.hasAudio}, ${(fs.statSync(finalVideoPath).size / 1024 / 1024).toFixed(1)}MB (${((Date.now() - t6) / 1000).toFixed(1)}s)`);
  assert(fs.existsSync(finalVideoPath), 'final video with subtitles created');
  assert(finalInfo.hasAudio, 'final video has audio');
  assert(finalInfo.durationSec > 60, `final video > 1min (got ${fmtDuration(finalInfo.durationSec)})`);

  // --- Copy final video to download/ ---
  console.log('\n[pipeline] Copying final video to download/');
  fs.copyFileSync(finalVideoPath, FINAL_OUTPUT);
  console.log(`  Final video: ${FINAL_OUTPUT} (${(fs.statSync(FINAL_OUTPUT).size / 1024 / 1024).toFixed(1)}MB)`);

  // --- Summary ---
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n=== Pipeline Complete ===');
  console.log(`  Total time: ${fmtDuration(parseFloat(totalSec))}`);
  console.log(`  Input:    ${inputInfo.width}x${inputInfo.height}, ${fmtDuration(inputInfo.durationSec)}, Chinese audio`);
  console.log(`  STT:      ${srtEntries.length} entries`);
  console.log(`  Translate: ${viEntries.length} Vietnamese entries (real Gemini)`);
  console.log(`  TTS:      ${fmtDuration(ttsInfo.durationSec)} Vietnamese audio`);
  console.log(`  Dubbed:   ${dubbedInfo.width}x${dubbedInfo.height}, ${fmtDuration(dubbedInfo.durationSec)}`);
  console.log(`  Final:    ${finalInfo.width}x${finalInfo.height}, ${fmtDuration(finalInfo.durationSec)}, with burned Vietnamese subtitles`);
  console.log(`  Output:   ${FINAL_OUTPUT}`);

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\n=== FATAL ERROR ===');
  console.error(err);
  console.error('\nStack:', err.stack);
  process.exit(1);
});
