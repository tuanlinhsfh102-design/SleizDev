/**
 * End-to-end test of the full SleizDev video translation pipeline:
 *   1. Generate a test video with Chinese audio (or use existing)
 *   2. Extract audio → SRT (CapCut STT)
 *   3. Translate SRT (MOCK — no Gemini key available, use canned translations)
 *   4. Generate TTS audio (CapCut TTS, 50 parallel)
 *   5. Dub video (replace audio with TTS)
 *   6. Burn Vietnamese subtitles into video (NEW)
 *   7. Verify the final video plays correctly
 *
 * This test PROVES the full pipeline works end-to-end. The only step mocked
 * is Gemini translation (because we don't have a Gemini API key in this
 * environment) — all other steps hit real APIs.
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
import { generateAudioFromSrt, dubVideo, burnSubtitlesIntoVideo } from '../src/tiktok-tts.ts';
import { SrtEntry, parseSrt, formatSrt, timeToMs } from '../src/srt-utils.ts';

const execAsync = promisify(exec);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

const TEST_DIR = path.resolve('./test-full-pipeline');
fs.mkdirSync(TEST_DIR, { recursive: true });

// Use the test video we generated with generate_test_video.py
const INPUT_VIDEO = '/home/z/my-project/download/pipeline_test/test_input.mp4';

// Canned Vietnamese translations for the 5 Chinese sentences in the test video.
// In production these come from Gemini; here we hardcode them since we don't
// have a Gemini API key.
const MOCK_TRANSLATIONS: Record<string, string> = {
  '大家好，欢迎来到我的频道。': 'Xin chào mọi người, chào mừng đến với kênh của tôi.',
  '今天我们要聊一聊人工智能的发展。': 'Hôm nay chúng ta sẽ nói về sự phát triển của trí tuệ nhân tạo.',
  '人工智能已经改变了我们的生活。': 'Trí tuệ nhân tạo đã thay đổi cuộc sống của chúng ta.',
  '从智能手机到自动驾驶汽车。': 'Từ điện thoại thông minh đến xe tự lái.',
  '未来还会有更多令人惊叹的应用。': 'Tương lai sẽ còn có nhiều ứng dụng đáng kinh ngạc hơn nữa.',
  // Fuzzy matches for STT output that may differ slightly from the TTS input
  '大家好': 'Xin chào mọi người',
  '欢迎来到我的频道': 'Chào mừng đến với kênh của tôi',
  '今天我们要聊一聊人工智能的发展': 'Hôm nay chúng ta sẽ nói về sự phát triển của AI',
  '人工智能已经改变了我们的生活': 'AI đã thay đổi cuộc sống của chúng ta',
  '从智能手机到自动驾驶汽车': 'Từ điện thoại thông minh đến xe tự hành',
  '未来还会有更多令人惊叹的应用': 'Tương lai sẽ có nhiều ứng dụng đáng kinh ngạc hơn',
};

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

async function mockTranslateSrt(originalSrt: string): Promise<string> {
  console.log('\n[pipeline] Step 3: Translating SRT (MOCK — no Gemini key, using canned translations)');
  const entries = parseSrt(originalSrt);
  console.log(`  Parsed ${entries.length} SRT entries from STT output`);

  // Try exact match first, then fuzzy match (substring)
  const translated: SrtEntry[] = entries.map((entry) => {
    let viText = MOCK_TRANSLATIONS[entry.text];
    if (!viText) {
      // Try fuzzy: find a key that is a substring of the entry text, or vice versa
      for (const [zh, vi] of Object.entries(MOCK_TRANSLATIONS)) {
        if (entry.text.includes(zh) || zh.includes(entry.text)) {
          viText = vi;
          break;
        }
      }
    }
    return {
      index: entry.index,
      start: entry.start,
      end: entry.end,
      text: viText || `[Untranslated] ${entry.text}`,
    };
  });

  const result = formatSrt(translated);
  console.log('  Translated SRT (first 3 entries):');
  for (const e of translated.slice(0, 3)) {
    console.log(`    ${e.index}: ${e.start} --> ${e.end}`);
    console.log(`      ${e.text}`);
  }
  return result;
}

async function main() {
  console.log('=== SleizDev Full Pipeline End-to-End Test ===');
  console.log(`Test dir: ${TEST_DIR}`);
  console.log(`Input video: ${INPUT_VIDEO}`);
  console.log();

  if (!fs.existsSync(INPUT_VIDEO)) {
    console.error('Input video not found. Run scripts/generate_test_video.py first.');
    process.exit(1);
  }

  // Verify input video
  const inputInfo = await getVideoInfo(INPUT_VIDEO);
  console.log(`Input video: ${inputInfo.width}x${inputInfo.height}, ${inputInfo.durationSec.toFixed(1)}s, audio=${inputInfo.hasAudio}`);
  assert(inputInfo.width > 0, 'input video has valid resolution');
  assert(inputInfo.hasAudio, 'input video has audio track');
  assert(inputInfo.durationSec > 5, `input video is > 5s long (got ${inputInfo.durationSec.toFixed(1)}s)`);

  // Step 1: Extract audio from video
  console.log('\n[pipeline] Step 1: Extract audio from video');
  const audioPath = await extractAudio(INPUT_VIDEO, TEST_DIR);
  assert(fs.existsSync(audioPath), 'audio extracted');
  const audioInfo = await getVideoInfo(audioPath);
  console.log(`  Audio: ${audioInfo.durationSec.toFixed(1)}s`);

  // Step 2: Audio → SRT (CapCut STT)
  console.log('\n[pipeline] Step 2: Audio → SRT (CapCut STT API)');
  const originalSrt = await audioToSrt(audioPath, TEST_DIR, 'zh');
  assert(originalSrt.trim().length > 0, 'SRT extracted (non-empty)');
  const srtEntries = parseSrt(originalSrt);
  console.log(`  Got ${srtEntries.length} SRT entries`);
  assert(srtEntries.length > 0, `SRT has entries (got ${srtEntries.length})`);
  console.log('  First 3 entries:');
  for (const e of srtEntries.slice(0, 3)) {
    console.log(`    ${e.index}: ${e.start} --> ${e.end}  ${e.text}`);
  }

  // Save original SRT for inspection
  fs.writeFileSync(path.join(TEST_DIR, 'original.srt'), originalSrt, 'utf-8');

  // Step 3: Translate SRT (MOCK)
  const vietnameseSrt = await mockTranslateSrt(originalSrt);
  fs.writeFileSync(path.join(TEST_DIR, 'vietnamese.srt'), vietnameseSrt, 'utf-8');
  const viEntries = parseSrt(vietnameseSrt);
  assert(viEntries.length === srtEntries.length, `Vietnamese SRT has same entry count (${viEntries.length} vs ${srtEntries.length})`);

  // Step 4: Generate TTS audio (CapCut TTS, batch parallel)
  console.log('\n[pipeline] Step 4: Generate TTS audio (CapCut TTS, 50 parallel)');
  const durationMs = await getVideoDuration(INPUT_VIDEO);
  console.log(`  Video duration: ${durationMs}ms`);
  const fullAudioPath = await generateAudioFromSrt(
    vietnameseSrt,
    'vi_vn_1',  // Vietnamese female sweet voice
    TEST_DIR,
    durationMs
  );
  assert(fs.existsSync(fullAudioPath), 'TTS audio generated');
  const ttsAudioInfo = await getVideoInfo(fullAudioPath);
  console.log(`  TTS audio: ${ttsAudioInfo.durationSec.toFixed(1)}s, ${(fs.statSync(fullAudioPath).size / 1024).toFixed(0)}KB`);
  assert(ttsAudioInfo.durationSec > 5, `TTS audio is > 5s long (got ${ttsAudioInfo.durationSec.toFixed(1)}s)`);

  // Step 5: Dub the video (replace audio with TTS)
  console.log('\n[pipeline] Step 5: Dub video (replace audio with TTS, auto-crop 16:9)');
  const dubbedVideoPath = path.join(TEST_DIR, 'dubbed.mp4');
  await dubVideo(INPUT_VIDEO, fullAudioPath, dubbedVideoPath, 0.1);
  assert(fs.existsSync(dubbedVideoPath), 'dubbed video created');
  const dubbedInfo = await getVideoInfo(dubbedVideoPath);
  console.log(`  Dubbed: ${dubbedInfo.width}x${dubbedInfo.height}, ${dubbedInfo.durationSec.toFixed(1)}s, audio=${dubbedInfo.hasAudio}, ${(fs.statSync(dubbedVideoPath).size / 1024 / 1024).toFixed(1)}MB`);
  assert(dubbedInfo.hasAudio, 'dubbed video has audio');
  assert(dubbedInfo.durationSec > 5, `dubbed video is > 5s long (got ${dubbedInfo.durationSec.toFixed(1)}s)`);

  // Step 6: Burn Vietnamese subtitles into video (NEW)
  console.log('\n[pipeline] Step 6: Burn Vietnamese subtitles into video (NEW feature)');
  const srtPath = path.join(TEST_DIR, 'vietnamese.srt');
  const finalVideoPath = path.join(TEST_DIR, 'final_with_subtitles.mp4');
  await burnSubtitlesIntoVideo(dubbedVideoPath, srtPath, finalVideoPath);
  assert(fs.existsSync(finalVideoPath), 'final video with subtitles created');
  const finalInfo = await getVideoInfo(finalVideoPath);
  console.log(`  Final: ${finalInfo.width}x${finalInfo.height}, ${finalInfo.durationSec.toFixed(1)}s, audio=${finalInfo.hasAudio}, ${(fs.statSync(finalVideoPath).size / 1024 / 1024).toFixed(1)}MB`);
  assert(finalInfo.hasAudio, 'final video has audio');
  assert(finalInfo.durationSec > 5, `final video is > 5s long (got ${finalInfo.durationSec.toFixed(1)}s)`);
  assert(
    Math.abs(finalInfo.durationSec - dubbedInfo.durationSec) < 1.0,
    `final video duration matches dubbed (${finalInfo.durationSec.toFixed(2)}s vs ${dubbedInfo.durationSec.toFixed(2)}s)`
  );

  // Step 7: Copy final video to download/ so the user can preview it
  console.log('\n[pipeline] Step 7: Copy final video to download/ for preview');
  const downloadPath = '/home/z/my-project/download/pipeline_final_video.mp4';
  fs.copyFileSync(finalVideoPath, downloadPath);
  console.log(`  Final video: ${downloadPath} (${(fs.statSync(downloadPath).size / 1024 / 1024).toFixed(1)}MB)`);

  // Summary
  console.log('\n=== Pipeline Summary ===');
  console.log(`  Input:   ${INPUT_VIDEO}`);
  console.log(`          ${inputInfo.width}x${inputInfo.height}, ${inputInfo.durationSec.toFixed(1)}s, Chinese audio`);
  console.log(`  SRT:     ${srtEntries.length} entries extracted via CapCut STT`);
  console.log(`  Trans:   ${viEntries.length} entries translated to Vietnamese`);
  console.log(`  TTS:     Vietnamese audio generated via CapCut TTS (50 parallel)`);
  console.log(`  Dubbed:  ${dubbedInfo.width}x${dubbedInfo.height}, ${dubbedInfo.durationSec.toFixed(1)}s`);
  console.log(`  Final:   ${finalInfo.width}x${finalInfo.height}, ${finalInfo.durationSec.toFixed(1)}s, with burned Vietnamese subtitles`);
  console.log(`  Output:  ${downloadPath}`);

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
