/**
 * Smoke test for the ENAMETOOLONG fix in tiktok-tts.ts:
 * verify that ffmpeg accepts `-filter_complex_script <file>` and produces
 * the expected output. Mirrors the merge strategy in mergeClipsWithTiming
 * (adelay + atrim + amix + apad).
 *
 * Run: bun scripts/test_filter_script.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const FFMPEG = ffmpegStatic as unknown as string;

const TMP = path.join(os.tmpdir(), `sleiz-filter-test-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

const CLIPS = 250; // well past the Windows shell 8KB limit
const DURATION = 5; // total output duration in seconds

async function makeSilence(file: string, seconds: number) {
  await execFileAsync(FFMPEG, [
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=44100`,
    '-t', String(seconds),
    '-q:a', '9', '-acodec', 'libmp3lame',
    file, '-y',
  ]);
}

const filterParts: string[] = [];
const inputArgs: string[] = [];
const clipPaths: string[] = [];

for (let i = 0; i < CLIPS; i++) {
  const clip = path.join(TMP, `clip_${String(i).padStart(5, '0')}.mp3`);
  clipPaths.push(clip);
  inputArgs.push('-i', clip);

  const startMs = i * 10; // 10ms apart
  const trimSec = 0.05;
  filterParts.push(
    `[${i}:a]aresample=44100,atrim=0:${trimSec.toFixed(3)},asetpts=PTS-STARTPTS,adelay=all=1:delays=${startMs}[a${i}]`
  );
}

const mixInputs = filterParts.map((_, i) => `[a${i}]`).join('');
filterParts.push(`${mixInputs}amix=inputs=${CLIPS}:duration=longest:normalize=0[aout]`);
filterParts.push(`[aout]apad=whole_dur=${DURATION}[padded]`);
filterParts.push(`[padded]atrim=0:${DURATION},asetpts=PTS-STARTPTS[final]`);

const filter = filterParts.join(';');
const filterFile = path.join(TMP, 'filter.txt');
fs.writeFileSync(filterFile, filter, 'utf8');

console.log(`filter_complex length: ${filter.length} chars`);
console.log(`clip paths: ${CLIPS}`);
console.log(`total argv size: ~${inputArgs.reduce((s, v) => s + v.length + 1, 0)} chars`);

const output = path.join(TMP, 'out.mp3');
const args = [
  ...inputArgs,
  '-filter_complex_script', filterFile,
  '-map', '[final]',
  '-t', String(DURATION),
  '-ac', '1', '-ar', '44100', '-ab', '128k',
  output, '-y',
];

(async () => {
  // Only generate first/last clip (the rest don't need to exist on disk
  // for this smoke test — we just need the ffmpeg command to be parseable
  // and runnable. To fully simulate, generate all.)
  console.log('Generating clips...');
  // Generate in parallel batches to keep this fast
  const PAR = 20;
  for (let i = 0; i < CLIPS; i += PAR) {
    const batch = [];
    for (let j = i; j < Math.min(i + PAR, CLIPS); j++) {
      batch.push(makeSilence(clipPaths[j], 0.05));
    }
    await Promise.all(batch);
  }
  console.log('Clips ready. Running ffmpeg merge...');

  const t0 = Date.now();
  const { stderr } = await execFileAsync(FFMPEG, args, { maxBuffer: 100 * 1024 * 1024 });
  const elapsed = Date.now() - t0;
  console.log(`ffmpeg took ${elapsed}ms`);

  if (!fs.existsSync(output)) {
    console.error('FAIL: output file not created');
    console.error('stderr tail:', stderr.split('\n').slice(-10).join('\n'));
    process.exit(1);
  }
  const size = fs.statSync(output).size;
  console.log(`OK: output created, ${size} bytes`);
  console.log('stderr tail:', stderr.split('\n').filter(Boolean).slice(-3).join('\n'));

  // cleanup
  try {
    for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f));
    fs.rmdirSync(TMP);
  } catch {}
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
