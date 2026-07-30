/**
 * End-to-end test for the new PARALLEL CapCut TTS pipeline.
 *
 * Verifies that:
 *   1. generateSpeechBatch() runs entries in parallel (timing check)
 *   2. All entries produce valid MP3s
 *   3. generateAudioFromSrt() uses the batch path end-to-end
 *   4. Final merged audio has the correct duration
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import {
  generateSpeechBatch,
  type CapCutTtsBatchEntry,
} from '../src/capcut-tts.ts';
import { generateAudioFromSrt } from '../src/tiktok-tts.ts';

const execAsync = promisify(exec);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

const TEST_DIR = path.resolve('./test-batch-tts');
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

async function testBatchParallelism() {
  console.log('\n=== Test 1: generateSpeechBatch() — 10 entries in parallel ===');

  const entries: CapCutTtsBatchEntry[] = [
    'Xin chào mọi người, hôm nay chúng ta sẽ xem một bộ phim rất hay.',
    'Câu chuyện bắt đầu vào một buổi sáng mùa thu năm ấy.',
    'Nhân vật chính là một cô gái trẻ với ước mơ trở thành ca sĩ.',
    'Cô ấy đã phải vượt qua rất nhiều khó khăn và thử thách.',
    'Trong suốt hành trình, cô gặp được những người bạn tuyệt vời.',
    'Họ cùng nhau chia sẻ niềm vui và nỗi buồn trong cuộc sống.',
    'Bộ phim mang đến cho người xem những bài học sâu sắc.',
    'Đạo diễn đã rất thành công trong việc xây dựng kịch bản.',
    'Diễn viên đã thể hiện xuất sắc cảm xúc của nhân vật.',
    'Đây thực sự là một tác phẩm điện ảnh đáng để thưởng thức.',
  ].map((text, i) => ({
    output: path.join(TEST_DIR, `batch_clip_${i}.mp3`),
    text,
    voice: 'vi_vn_1',
    rate: '1.0',
  }));

  const startMs = Date.now();
  const results = await generateSpeechBatch(entries, {
    timeoutSeconds: 60,
    concurrency: 10,
  });
  const durationSec = (Date.now() - startMs) / 1000;

  console.log(`  batch took ${durationSec.toFixed(1)}s for ${entries.length} entries`);
  assert(results.length === entries.length, `got ${results.length} results (expected ${entries.length})`);

  let okCount = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const outPath = entries[i].output;
    const exists = fs.existsSync(outPath);
    const size = exists ? fs.statSync(outPath).size : 0;
    if (r.success && exists && size > 100) {
      okCount++;
    } else {
      console.warn(`  slot ${i}: success=${r.success}, exists=${exists}, size=${size}, msg=${r.message}`);
    }
  }
  assert(okCount === entries.length, `all ${entries.length} clips generated (got ${okCount})`);

  // Parallelism check: 10 entries × ~2s per clip = ~20s sequential.
  // With 10-way parallelism we expect < 15s total. If it took > 18s, the
  // parallelism isn't working.
  assert(
    durationSec < 18,
    `parallel batch ran in < 18s (got ${durationSec.toFixed(1)}s) — parallelism confirmed`
  );

  // Verify each clip is a valid MP3
  for (let i = 0; i < entries.length; i++) {
    const dur = await getAudioDurationSec(entries[i].output);
    assert(dur > 0.5, `clip ${i} has audio (duration ${dur.toFixed(2)}s > 0.5s)`);
  }
}

async function testFullPipelineWithSrt() {
  console.log('\n=== Test 2: generateAudioFromSrt() with 12-entry SRT (batch mode) ===');

  // 12-entry SRT — bigger than typical batch size for a real movie, but
  // small enough to test quickly. Total duration ~24s.
  const srtLines: string[] = [];
  const sentences = [
    'Xin chào mọi người, chào mừng các bạn đến với kênh của chúng tôi.',
    'Hôm nay chúng ta sẽ cùng nhau khám phá một câu chuyện rất thú vị.',
    'Câu chuyện bắt đầu vào một buổi sáng mùa thu năm ấy.',
    'Khi mặt trời vừa ló rạng, cô gái trẻ đã thức dậy từ giường.',
    'Cô ấy đã chuẩn bị sẵn sàng cho một ngày mới đầy những hy vọng.',
    'Bước ra khỏi nhà, cô cảm nhận được hơi thở tươi mát của buổi sáng.',
    'Những tia nắng ban mai chiếu qua kẽ lá tạo nên bức tranh tuyệt đẹp.',
    'Cô gái trẻ bắt đầu đi trên con đường quen thuộc đến trường học.',
    'Trên đường đi, cô gặp được những người bạn thân thiết của mình.',
    'Họ cùng nhau trò chuyện vui vẻ về những dự định trong tương lai.',
    'Cả nhóm cùng nhau bước vào lớp học với tâm trạng đầy phấn khích.',
    'Và đó là khởi đầu cho một ngày đầy những điều bất ngờ đang chờ đợi.',
  ];
  for (let i = 0; i < sentences.length; i++) {
    const startSec = i * 2;
    const endSec = startSec + 2;
    srtLines.push(
      `${i + 1}`,
      `00:00:${String(startSec).padStart(2, '0')},000 --> 00:00:${String(endSec).padStart(2, '0')},000`,
      sentences[i],
      ''
    );
  }
  const srt = srtLines.join('\n');

  const workDir = path.join(TEST_DIR, 'pipeline');
  fs.mkdirSync(workDir, { recursive: true });

  console.log('[test] Running generateAudioFromSrt with 12-entry SRT...');
  const startMs = Date.now();
  let audioPath: string;
  try {
    audioPath = await generateAudioFromSrt(srt, 'vi_vn_1', workDir, 24000);
  } catch (err: any) {
    console.error('[test] Pipeline threw:', err.message);
    audioPath = path.join(workDir, 'full_audio.mp3');
  }
  const durationSec = (Date.now() - startMs) / 1000;
  console.log(`  pipeline took ${durationSec.toFixed(1)}s`);

  assert(fs.existsSync(audioPath), 'pipeline output MP3 exists');
  const dur = await getAudioDurationSec(audioPath);
  console.log(`  pipeline output duration: ${dur.toFixed(2)}s (target ~24s)`);
  assert(Math.abs(dur - 24.0) < 3.0, `pipeline output ~24s long (got ${dur.toFixed(2)}s)`);

  // Parallelism check: 12 entries × ~2s per clip = ~24s sequential.
  // With 50-way parallelism (all 12 fit in one batch) we expect < 15s.
  assert(
    durationSec < 20,
    `pipeline ran in < 20s (got ${durationSec.toFixed(1)}s) — batch parallelism confirmed`
  );

  // Count generated clips
  const clipsDir = path.join(workDir, 'clips');
  if (fs.existsSync(clipsDir)) {
    const clips = fs.readdirSync(clipsDir).filter((f) => f.endsWith('.mp3'));
    console.log(`  generated ${clips.length} clips in ${clipsDir}`);
    assert(clips.length === 12, `12 clips generated (got ${clips.length})`);
  }
}

async function main() {
  console.log('=== CapCut TTS Batch Parallelism Tests ===');
  console.log(`Test dir: ${TEST_DIR}`);
  console.log(`CAPCUT_TTS_CONCURRENCY env: ${process.env.CAPCUT_TTS_CONCURRENCY || '(unset, default 50)'}`);

  await testBatchParallelism();
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
