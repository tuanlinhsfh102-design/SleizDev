/**
 * Translate the already-extracted SRT using GLM (z-ai-web-dev-sdk) instead
 * of Gemini, then continue the pipeline: TTS → dub → burn subtitles.
 *
 * This is needed because Gemini is geo-restricted from this datacenter IP.
 * On the user's residential machine, Gemini will work normally.
 *
 * Input:
 *   - SRT: /home/z/my-project/test-user-video/original.srt (162 entries, from CapCut STT)
 *   - Video: /home/z/my-project/upload/ezgif.com-crop-video.mp4 (5:21, 706x396)
 *
 * Output:
 *   - Final video: /home/z/my-project/download/user_video_final.mp4
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import ZAI from 'z-ai-web-dev-sdk';
import { getVideoDuration } from '../src/capcut.ts';
import { generateAudioFromSrt, dubVideo, burnSubtitlesIntoVideo } from '../src/tiktok-tts.ts';
import { parseSrt, formatSrt, SrtEntry } from '../src/srt-utils.ts';

const execAsync = promisify(exec);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

const INPUT_VIDEO = '/home/z/my-project/upload/ezgif.com-crop-video.mp4';
const ORIGINAL_SRT = '/home/z/my-project/test-user-video/original.srt';
const TEST_DIR = '/home/z/my-project/test-user-video';
const TTS_VOICE = 'vi_vn_1';
const FINAL_OUTPUT = '/home/z/my-project/download/user_video_final.mp4';
const BATCH_SIZE = 50; // entries per GLM request

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

/**
 * Translate SRT entries from Chinese to Vietnamese using GLM.
 * Batches entries to stay within token limits.
 */
async function translateWithGLM(entries: SrtEntry[]): Promise<SrtEntry[]> {
  console.log(`[glm] Translating ${entries.length} entries in batches of ${BATCH_SIZE}...`);
  const zai = await ZAI.create();
  const translated: SrtEntry[] = [];

  for (let batchStart = 0; batchStart < entries.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, entries.length);
    const batch = entries.slice(batchStart, batchEnd);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(entries.length / BATCH_SIZE);
    console.log(`[glm] Batch ${batchNum}/${totalBatches}: entries ${batchStart + 1}-${batchEnd}`);

    // Build the prompt — same style as the Gemini prompt in gemini.ts
    const segmentsJson = batch.map((e, i) => ({
      index: i + 1,
      text: e.text,
    }));

    const systemPrompt = `You are a professional Vietnamese subtitle translator. Your task is to translate Chinese subtitles into natural, fluent Vietnamese that matches the tone and context of a Chinese drama/donghua.

Rules:
1. Translate each Chinese segment into Vietnamese
2. Remove all Chinese characters from the output — output ONLY Vietnamese text
3. Keep the translation natural and conversational, not literal
4. Maintain character names consistently (use Vietnamese transliteration when appropriate)
5. Never return empty strings — if unsure, provide a best-effort translation
6. The number of output segments must equal the number of input segments
7. Output format: JSON with segments array, each having index and text fields

Output format:
{"segments":[{"index":1,"text":"Vietnamese translation"},...]}`;

    const userPrompt = `Translate these ${batch.length} Chinese subtitle segments to Vietnamese:

${JSON.stringify(segmentsJson, null, 2)}

Return ONLY the JSON object, no other text.`;

    try {
      const completion = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        thinking: { type: 'disabled' },
      });

      const responseText = completion.choices[0]?.message?.content || '';

      // Parse the JSON response — GLM might wrap it in markdown code blocks
      let jsonStr = responseText.trim();
      // Remove markdown code fences if present
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      // Find the JSON object
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const parsed = JSON.parse(jsonStr);
      const segs = parsed.segments || [];

      // Map translations back to entries
      for (let i = 0; i < batch.length; i++) {
        const seg = segs.find((s: any) => s.index === i + 1) || segs[i];
        const viText = seg?.text || batch[i].text; // fallback to original if missing
        translated.push({
          index: batch[i].index,
          start: batch[i].start,
          end: batch[i].end,
          text: String(viText).trim(),
        });
      }

      console.log(`  ✓ Batch ${batchNum} done: ${segs.length} translations`);
    } catch (err: any) {
      console.error(`  ✗ Batch ${batchNum} failed: ${err.message}`);
      // Fallback: keep original Chinese text for this batch
      for (const entry of batch) {
        translated.push({ ...entry });
      }
      console.log(`  ⚠ Using original text as fallback for batch ${batchNum}`);
    }

    // Small delay between batches to avoid rate limiting
    if (batchEnd < entries.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return translated;
}

async function main() {
  const startTime = Date.now();
  console.log('=== Full Pipeline with GLM Translation ===');
  console.log(`Input video: ${INPUT_VIDEO}`);
  console.log(`Original SRT: ${ORIGINAL_SRT}`);
  console.log(`TTS voice: ${TTS_VOICE}`);
  console.log();

  // Load the already-extracted SRT
  const originalSrt = fs.readFileSync(ORIGINAL_SRT, 'utf-8');
  const srtEntries = parseSrt(originalSrt);
  console.log(`Loaded ${srtEntries.length} SRT entries from CapCut STT`);
  console.log('First 3:');
  for (const e of srtEntries.slice(0, 3)) {
    console.log(`  ${e.index}: ${e.start} --> ${e.end}  ${e.text.slice(0, 60)}`);
  }
  console.log('Last 3:');
  for (const e of srtEntries.slice(-3)) {
    console.log(`  ${e.index}: ${e.start} --> ${e.end}  ${e.text.slice(0, 60)}`);
  }
  console.log();

  // --- Step 1: Translate with GLM ---
  console.log('[pipeline] Step 1/4: Translate SRT → Vietnamese (GLM)');
  const t1 = Date.now();
  const viEntries = await translateWithGLM(srtEntries);
  const vietnameseSrt = formatSrt(viEntries);
  fs.writeFileSync(path.join(TEST_DIR, 'vietnamese.srt'), vietnameseSrt, 'utf-8');
  console.log(`  Translated ${viEntries.length} entries (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  console.log('First 5 Vietnamese entries:');
  for (const e of viEntries.slice(0, 5)) {
    console.log(`  ${e.index}: ${e.start} --> ${e.end}  ${e.text.slice(0, 60)}`);
  }
  // Check for Chinese characters (indicates untranslated fallbacks)
  const chineseCount = viEntries.filter((e) => /[\u4e00-\u9fff]/.test(e.text)).length;
  console.log(`  Entries with Chinese chars (untranslated fallbacks): ${chineseCount}/${viEntries.length}`);
  console.log();

  // --- Step 2: Generate TTS audio ---
  console.log('[pipeline] Step 2/4: Generate TTS audio (CapCut TTS, 50 parallel)');
  const t2 = Date.now();
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
  console.log(`  TTS audio: ${fmtDuration(ttsInfo.durationSec)}, ${(fs.statSync(fullAudioPath).size / 1024 / 1024).toFixed(1)}MB (${((Date.now() - t2) / 1000).toFixed(1)}s)`);
  console.log();

  // --- Step 3: Dub video ---
  console.log('[pipeline] Step 3/4: Dub video (replace audio + auto-crop 16:9)');
  const t3 = Date.now();
  const dubbedVideoPath = path.join(TEST_DIR, 'dubbed.mp4');
  await dubVideo(INPUT_VIDEO, fullAudioPath, dubbedVideoPath, 0.1);
  const dubbedInfo = await getVideoInfo(dubbedVideoPath);
  console.log(`  Dubbed: ${dubbedInfo.width}x${dubbedInfo.height}, ${fmtDuration(dubbedInfo.durationSec)}, ${(fs.statSync(dubbedVideoPath).size / 1024 / 1024).toFixed(1)}MB (${((Date.now() - t3) / 1000).toFixed(1)}s)`);
  console.log();

  // --- Step 4: Burn subtitles ---
  console.log('[pipeline] Step 4/4: Burn Vietnamese subtitles into video');
  const t4 = Date.now();
  const srtPath = path.join(TEST_DIR, 'vietnamese.srt');
  const finalVideoPath = path.join(TEST_DIR, 'final_with_subtitles.mp4');
  await burnSubtitlesIntoVideo(dubbedVideoPath, srtPath, finalVideoPath);
  const finalInfo = await getVideoInfo(finalVideoPath);
  console.log(`  Final: ${finalInfo.width}x${finalInfo.height}, ${fmtDuration(finalInfo.durationSec)}, ${(fs.statSync(finalVideoPath).size / 1024 / 1024).toFixed(1)}MB (${((Date.now() - t4) / 1000).toFixed(1)}s)`);
  console.log();

  // --- Copy to download/ ---
  fs.copyFileSync(finalVideoPath, FINAL_OUTPUT);
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('=== Pipeline Complete ===');
  console.log(`  Total time: ${fmtDuration(parseFloat(totalSec))}`);
  console.log(`  STT:       ${srtEntries.length} entries (CapCut STT)`);
  console.log(`  Translate: ${viEntries.length} entries (GLM, ${chineseCount} fallbacks)`);
  console.log(`  TTS:       ${fmtDuration(ttsInfo.durationSec)} Vietnamese audio`);
  console.log(`  Dubbed:    ${dubbedInfo.width}x${dubbedInfo.height}, ${fmtDuration(dubbedInfo.durationSec)}`);
  console.log(`  Final:     ${finalInfo.width}x${finalInfo.height}, ${fmtDuration(finalInfo.durationSec)}, with subtitles`);
  console.log(`  Output:    ${FINAL_OUTPUT} (${(fs.statSync(FINAL_OUTPUT).size / 1024 / 1024).toFixed(1)}MB)`);
}

main().catch((err) => {
  console.error('\n=== FATAL ERROR ===');
  console.error(err.message);
  console.error(err.stack);
  process.exit(1);
});
