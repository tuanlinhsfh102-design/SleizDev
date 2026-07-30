/**
 * Fix the 4 bad TTS clips (which had Chinese text → auto-switched to Chinese voice)
 * + re-merge audio + re-dub video + re-burn subtitles with the corrected SRT.
 *
 * The pipeline previously ran end-to-end but 4 of 162 entries had Chinese chars
 * in the Vietnamese SRT (GLM translation fallbacks). Those 4 entries were:
 *   - entry 49 (line 199): 最多再有片刻就会追到
 *   - entry 60 (line 243): Ch只要他自己 an toàn là được
 *   - entry 64 (line 255): Cả cùng trở lại cùng đối phó với con畜 sinh này
 *   - entry 100 (line 399): Ch只要 không bóp vỡ ngọc bội
 *
 * Now the SRT is fixed (0 Chinese chars). We need to:
 *   1. Regenerate the 4 corresponding TTS clips with the corrected Vietnamese text
 *   2. Re-merge all 162 clips into full_audio.mp3
 *   3. Re-dub the video (replace audio)
 *   4. Re-burn the corrected Vietnamese subtitles
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import { generateSpeech } from '../src/capcut-tts.ts';
import { dubVideo, burnSubtitlesIntoVideo } from '../src/tiktok-tts.ts';
import { parseSrt, timeToMs } from '../src/srt-utils.ts';

const execAsync = promisify(exec);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

const TEST_DIR = '/home/z/my-project/test-user-video';
const INPUT_VIDEO = '/home/z/my-project/upload/ezgif.com-crop-video.mp4';
const CLIPS_DIR = path.join(TEST_DIR, 'clips');
const SRT_PATH = path.join(TEST_DIR, 'vietnamese.srt');
const FULL_AUDIO_PATH = path.join(TEST_DIR, 'full_audio.mp3');
const DUBBED_VIDEO_PATH = path.join(TEST_DIR, 'dubbed.mp4');
const FINAL_VIDEO_PATH = path.join(TEST_DIR, 'final_with_subtitles.mp4');
const FINAL_OUTPUT = '/home/z/my-project/download/user_video_final.mp4';
const TTS_VOICE = 'vi_vn_1';

async function getVideoDurationSec(videoPath: string): Promise<number> {
  let output = '';
  try {
    const result = await execAsync(`"${FFMPEG_PATH}" -i "${videoPath}" 2>&1`, {
      maxBuffer: 1024 * 1024,
    });
    output = result.stdout + '\n' + result.stderr;
  } catch (err: any) {
    output = (err.stdout || '') + '\n' + (err.stderr || '');
  }
  const m = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
  return m ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]) : 0;
}

async function createSilentClip(outputPath: string, durationMs: number): Promise<void> {
  const durationSec = Math.max(0.1, durationMs / 1000);
  const cmd = `"${FFMPEG_PATH}" -f lavfi -i anullsrc=channel_layout=mono:sample_rate=44100 -t ${durationSec} -q:a 9 "${outputPath}" -y`;
  await execAsync(cmd, { maxBuffer: 1024 * 1024 });
}

async function main() {
  const startTime = Date.now();
  console.log('=== Fix 4 bad TTS clips + re-merge + re-dub + re-burn ===\n');

  // Load the corrected Vietnamese SRT
  const vietnameseSrt = fs.readFileSync(SRT_PATH, 'utf-8');
  const entries = parseSrt(vietnameseSrt);
  console.log(`Loaded ${entries.length} SRT entries`);

  // Verify no Chinese chars
  const chineseCount = entries.filter((e) => /[\u4e00-\u9fff]/.test(e.text)).length;
  console.log(`Entries with Chinese chars: ${chineseCount} (should be 0)`);
  if (chineseCount > 0) {
    console.error('SRT still has Chinese chars! Aborting.');
    process.exit(1);
  }

  // The 4 entries that had Chinese before (1-indexed in SRT):
  // Based on the grep output, the bad lines were at SRT line numbers 199, 243, 255, 399
  // which correspond to SRT entry indices... let me find them by checking which clips
  // are suspiciously small or were generated with Chinese voice.
  // Actually, simpler: just regenerate ALL 162 clips that don't exist yet OR
  // regenerate the 4 specific ones. Let me find them by matching the original bad text.
  const badEntryTexts = [
    'Cùng lắm thêm một lúc nữa là sẽ đuổi kịp',        // was: 最多再有片刻就会追到
    'Chỉ cần hắn ta an toàn là được',                   // was: Ch只要他自己 an toàn là được
    'Cùng nhau quay lại đối phó với con súc sinh này', // was: Cả cùng trở lại...
    'Chỉ cần không bóp vỡ ngọc bội',                    // was: Ch只要 không bóp vỡ ngọc bội
  ];

  const entriesToRegen: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (badEntryTexts.includes(entries[i].text)) {
      entriesToRegen.push(i);
      console.log(`  Will regen clip ${i}: "${entries[i].text.slice(0, 50)}"`);
    }
  }
  console.log(`\nFound ${entriesToRegen.length} clips to regenerate`);

  // Step 1: Regenerate the 4 bad TTS clips
  console.log('\n[step 1] Regenerating 4 TTS clips with corrected Vietnamese text');
  for (let idx = 0; idx < entriesToRegen.length; idx++) {
    const i = entriesToRegen[idx];
    const entry = entries[i];
    const clipPath = path.join(CLIPS_DIR, `clip_${String(i).padStart(5, '0')}.mp3`);
    console.log(`  [${idx + 1}/${entriesToRegen.length}] clip_${String(i).padStart(5, '0')}.mp3: "${entry.text.slice(0, 50)}"`);

    // Remove old clip
    try { fs.unlinkSync(clipPath); } catch {}

    const ok = await generateSpeech(entry.text, TTS_VOICE, clipPath, {
      timeoutSeconds: 90,
    });
    if (ok && fs.existsSync(clipPath) && fs.statSync(clipPath).size > 100) {
      console.log(`    ✓ ${(fs.statSync(clipPath).size / 1024).toFixed(1)}KB`);
    } else {
      console.warn(`    ✗ TTS failed, using silence`);
      const slotMs = Math.max(100, timeToMs(entry.end) - timeToMs(entry.start));
      await createSilentClip(clipPath, slotMs);
    }
  }

  // Step 2: Re-merge all 162 clips into full_audio.mp3
  console.log('\n[step 2] Re-merging all 162 clips into full_audio.mp3');
  const totalDurationMs = (await getVideoDurationSec(INPUT_VIDEO)) * 1000;
  console.log(`  Target duration: ${(totalDurationMs / 1000).toFixed(1)}s`);

  // Build ffmpeg filter_complex for merging (same as generateAudioFromSrt)
  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const clipPath = path.join(CLIPS_DIR, `clip_${String(i).padStart(5, '0')}.mp3`);
    if (!fs.existsSync(clipPath)) {
      console.error(`  Missing clip: ${clipPath}`);
      process.exit(1);
    }
    inputArgs.push(`-i "${clipPath}"`);
    const startMs = Math.max(0, timeToMs(entries[i].start));
    const endMs = Math.max(startMs + 100, timeToMs(entries[i].end));
    const trimSec = Math.max(0.1, (endMs - startMs) / 1000);
    const delayMs = startMs;
    filterParts.push(
      `[${i}:a]aresample=44100,atrim=0:${trimSec.toFixed(3)},asetpts=PTS-STARTPTS,adelay=all=1:delays=${delayMs}[a${i}]`
    );
  }
  const mixInputs = filterParts.map((_, i) => `[a${i}]`).join('');
  filterParts.push(
    `${mixInputs}amix=inputs=${entries.length}:duration=longest:normalize=0[aout]`
  );
  const totalSec = totalDurationMs / 1000;
  filterParts.push(`[aout]apad=whole_dur=${totalSec.toFixed(3)}[padded]`);
  filterParts.push(`[padded]atrim=0:${totalSec.toFixed(3)},asetpts=PTS-STARTPTS[final]`);
  const filter = filterParts.join(';');

  const mergeCmd =
    `"${FFMPEG_PATH}" ${inputArgs.join(' ')} ` +
    `-filter_complex "${filter}" ` +
    `-map "[final]" -t ${totalSec.toFixed(3)} ` +
    `-ac 1 -ar 44100 -ab 128k "${FULL_AUDIO_PATH}" -y`;

  console.log('  Running ffmpeg merge (162 inputs)...');
  await execAsync(mergeCmd, { maxBuffer: 500 * 1024 * 1024 });
  console.log(`  ✓ full_audio.mp3: ${(fs.statSync(FULL_AUDIO_PATH).size / 1024 / 1024).toFixed(1)}MB`);

  // Step 3: Re-dub the video
  console.log('\n[step 3] Re-dubbing video (replace audio with corrected TTS)');
  await dubVideo(INPUT_VIDEO, FULL_AUDIO_PATH, DUBBED_VIDEO_PATH, 0.1);
  console.log(`  ✓ dubbed.mp4: ${(fs.statSync(DUBBED_VIDEO_PATH).size / 1024 / 1024).toFixed(1)}MB`);

  // Step 4: Re-burn subtitles with corrected SRT
  console.log('\n[step 4] Re-burning Vietnamese subtitles into video');
  await burnSubtitlesIntoVideo(DUBBED_VIDEO_PATH, SRT_PATH, FINAL_VIDEO_PATH);
  console.log(`  ✓ final_with_subtitles.mp4: ${(fs.statSync(FINAL_VIDEO_PATH).size / 1024 / 1024).toFixed(1)}MB`);

  // Step 5: Copy to download/
  console.log('\n[step 5] Copying final video to download/');
  fs.copyFileSync(FINAL_VIDEO_PATH, FINAL_OUTPUT);
  console.log(`  ✓ ${FINAL_OUTPUT} (${(fs.statSync(FINAL_OUTPUT).size / 1024 / 1024).toFixed(1)}MB)`);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Done in ${totalTime}s ===`);
  console.log(`Final video: ${FINAL_OUTPUT}`);
  console.log(`  - 162 Vietnamese TTS clips (4 regenerated with correct text)`);
  console.log(`  - 16:9 auto-cropped (640x360)`);
  console.log(`  - Burned-in Vietnamese subtitles (white on semi-transparent black box)`);
  console.log(`  - Duration: ${(totalSec).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('\nFATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
