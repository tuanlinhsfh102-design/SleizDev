/**
 * End-to-end test for the new CapCut TTS integration.
 *
 * Verifies that:
 *   1. generateSpeech() returns true for valid Vietnamese text
 *   2. The output MP3 file exists and is non-empty
 *   3. The output MP3 is a valid audio file (ffmpeg can probe it)
 *   4. Both female (vi_vn_1) and male (vi_vn_2) voices work
 *   5. The full generateAudioFromSrt() pipeline produces a valid MP3
 *      with the correct duration
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import { generateSpeech, SUPPORTED_VOICES } from '../src/capcut-tts.ts';
import { generateAudioFromSrt } from '../src/tiktok-tts.ts';

const execAsync = promisify(exec);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

const TEST_DIR = path.resolve('./test-capcut-tts');
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

async function getAudioDurationSec(audioPath: string): Promise<number> {
  let output = '';
  try {
    const result = await execAsync(`"${FFMPEG_PATH}" -i "${audioPath}" 2>&1`, {
      maxBuffer: 1024 * 1024,
    });
    output = result.stdout + '\n' + result.stderr;
  } catch (err: any) {
    output = (err.stdout || '') + '\n' + (err.stderr || '');
  }
  const m = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
  return m ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]) : 0;
}

async function testBasicFemaleVoice() {
  console.log('\n=== Test 1: Basic CapCut TTS (vi_vn_1 = female sweet) ===');
  const outPath = path.join(TEST_DIR, 'female.mp3');
  const ok = await generateSpeech(
    'Xin chào bạn, đây là một đoạn văn bản thử nghiệm tiếng Việt.',
    'vi_vn_1',
    outPath,
    { timeoutSeconds: 60 }
  );
  assert(ok, 'generateSpeech returned true');
  assert(fs.existsSync(outPath), 'output MP3 file exists');
  assert(fs.statSync(outPath).size > 1000, `output MP3 is non-trivial size (${fs.statSync(outPath).size} bytes)`);
  const dur = await getAudioDurationSec(outPath);
  console.log(`  duration: ${dur.toFixed(2)}s`);
  assert(dur > 1.0, `output MP3 has audio content (duration > 1s, got ${dur.toFixed(2)}s)`);
}

async function testBasicMaleVoice() {
  console.log('\n=== Test 2: CapCut TTS (vi_vn_2 = male deep) ===');
  const outPath = path.join(TEST_DIR, 'male.mp3');
  const ok = await generateSpeech(
    'Hôm nay chúng ta sẽ cùng nhau khám phá một câu chuyện rất thú vị.',
    'vi_vn_2',
    outPath,
    { timeoutSeconds: 60 }
  );
  assert(ok, 'generateSpeech returned true for male voice');
  assert(fs.existsSync(outPath), 'male output MP3 file exists');
  assert(fs.statSync(outPath).size > 1000, `male MP3 is non-trivial size (${fs.statSync(outPath).size} bytes)`);
  const dur = await getAudioDurationSec(outPath);
  console.log(`  duration: ${dur.toFixed(2)}s`);
  assert(dur > 1.0, `male MP3 has audio content (duration > 1s, got ${dur.toFixed(2)}s)`);
}

async function testEmptyText() {
  console.log('\n=== Test 3: Empty text is handled gracefully ===');
  const outPath = path.join(TEST_DIR, 'empty.mp3');
  const ok = await generateSpeech('', 'vi_vn_1', outPath, { timeoutSeconds: 10 });
  assert(!ok, 'empty text returns false (no API call made)');
  assert(!fs.existsSync(outPath), 'no output file created for empty text');
}

async function testFullPipelineWithSrt() {
  console.log('\n=== Test 4: Full generateAudioFromSrt pipeline ===');
  // 3-entry SRT, ~6 seconds total
  const srt = [
    '1', '00:00:00,000 --> 00:00:02,000', 'Xin chào mọi người.', '',
    '2', '00:00:02,000 --> 00:00:04,000', 'Hôm nay thời tiết rất đẹp.', '',
    '3', '00:00:04,000 --> 00:00:06,000', 'Chúc các bạn một ngày tốt lành.', '',
  ].join('\n');

  const workDir = path.join(TEST_DIR, 'pipeline-work');
  fs.mkdirSync(workDir, { recursive: true });

  console.log('[test] Running generateAudioFromSrt with 3-entry SRT...');
  let audioPath: string;
  try {
    audioPath = await generateAudioFromSrt(srt, 'vi_vn_1', workDir, 6000);
  } catch (err: any) {
    console.error('[test] Pipeline threw:', err.message);
    audioPath = path.join(workDir, 'full_audio.mp3');
  }
  assert(fs.existsSync(audioPath), 'pipeline output MP3 exists');
  const dur = await getAudioDurationSec(audioPath);
  console.log(`  pipeline output duration: ${dur.toFixed(2)}s (target ~6s)`);
  assert(Math.abs(dur - 6.0) < 1.5, `pipeline output ~6s long (got ${dur.toFixed(2)}s)`);
}

async function main() {
  console.log('=== CapCut TTS Integration Tests ===');
  console.log(`Supported voices: ${SUPPORTED_VOICES.length}`);
  for (const v of SUPPORTED_VOICES) {
    console.log(`  - ${v.id} -> ${v.capcutVoice} (${v.label})`);
  }

  await testBasicFemaleVoice();
  await testBasicMaleVoice();
  await testEmptyText();
  await testFullPipelineWithSrt();

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
