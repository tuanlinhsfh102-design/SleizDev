// CapCut Text-to-Speech integration
// Based on https://github.com/K07VN/capcut-tts-api
//
// This module spawns the vendored Python bridge (`scripts/capcut_tts.py`)
// which drives CapCut's official /lv/v1/common_task TTS workflow:
//   1. POST /lv/v1/common_task/new with req_key=sami_text_to_speech
//   2. POST /lv/v1/common_task/query (poll until status=succeed)
//   3. Extract speech_url from payload.audio_subtitles[0]
//   4. Download the MP3 from CapCut CDN to the requested output path
//
// WHY: The previous pipeline used TikTok TTS (requires TIKTOK_SESSION_ID
// env var, almost never set) and fell back to Google Translate TTS (heavily
// rate-limited, robotic voice, no proper Vietnamese male voice). CapCut
// provides 24 native Vietnamese voices — same engine as the CapCut app —
// and the SDK was already vendored for STT, so we just plug in the TTS side.
//
// ROOT CAUSE OF PREVIOUS TTS FAILURES:
//   The vendored SDK's generate_speech() polled for status=="success", but
//   CapCut's TTS endpoint actually returns status=="succeed" (with the
//   trailing 'd') — same as the STT endpoint. So every TTS task timed out.
//   This is now fixed in vendor/capcut_tts_api/client.py and the bridge
//   also accepts both strings, so it works even with older SDK versions.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.resolve(MODULE_DIR, '..', 'scripts', 'capcut_tts.py');
const VENDOR_DIR = path.resolve(MODULE_DIR, '..', 'vendor');
const DEVICE_JSON = path.resolve(MODULE_DIR, '..', 'device.json');

// Allow overriding the Python interpreter via env (defaults to `python3`).
const PYTHON_BIN = process.env.CAPCUT_PYTHON || process.env.PYTHON || 'python3';

export interface CapCutTtsOptions {
  /** Optional CapCut device.json profile path. */
  devicePath?: string;
  /** Speech rate multiplier (e.g. "1.0", "0.9", "1.2"). */
  rate?: string;
  /** Max seconds to wait for the TTS task to finish. */
  timeoutSeconds?: number;
}

/**
 * Generate an MP3 file from text using CapCut's TTS API.
 *
 * @param text   Text to convert to speech (CapCut limit ~500 chars per call).
 * @param voice  Voice ID — either a SleizDev alias (vi_vn_1, vi_vn_2,
 *               vi_female, vi_male, ...) or a raw CapCut voice_type
 *               (BV421_vivn_streaming, BV074_streaming, ...).
 * @param outputPath  Absolute path where the MP3 will be written.
 * @param options     Optional device profile, rate, timeout.
 *
 * Returns true on success (output file exists and is non-empty), false on
 * any failure. Errors are logged to console.error but not thrown — callers
 * can fall back to other TTS providers.
 */
export async function generateSpeech(
  text: string,
  voice: string,
  outputPath: string,
  options: CapCutTtsOptions = {}
): Promise<boolean> {
  // Strip bracketed annotations like [Phân đoạn 1] and trim whitespace.
  const cleanText = text.replace(/\n/g, ' ').replace(/\[.*?\]/g, '').trim();
  if (!cleanText) {
    console.warn('[capcut-tts] Empty text, skipping');
    return false;
  }

  if (!fs.existsSync(BRIDGE_SCRIPT)) {
    console.error(
      `[capcut-tts] Bridge script not found: ${BRIDGE_SCRIPT}. ` +
        'Make sure mini-services/translation-service/scripts/capcut_tts.py is committed.'
    );
    return false;
  }
  if (!fs.existsSync(VENDOR_DIR)) {
    console.error(
      `[capcut-tts] Vendored capcut-tts-api library not found: ${VENDOR_DIR}. ` +
        'Run `git pull` or restore mini-services/translation-service/vendor/.'
    );
    return false;
  }

  const devicePath =
    options.devicePath || (fs.existsSync(DEVICE_JSON) ? DEVICE_JSON : undefined);

  const args: string[] = [
    BRIDGE_SCRIPT,
    '--text', cleanText,
    '--voice', voice,
    '--rate', options.rate ?? '1.0',
    '--output', outputPath,
    '--timeout', String(options.timeoutSeconds ?? 90),
  ];
  if (devicePath) {
    args.push('--device', devicePath);
  }

  try {
    const exitCode = await runPythonBridge(args, options.timeoutSeconds ?? 90);
    if (exitCode !== 0) {
      console.error(`[capcut-tts] Bridge exited with code ${exitCode}`);
      return false;
    }
    // Verify output file exists and is non-empty
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      console.error(`[capcut-tts] Output file missing or empty: ${outputPath}`);
      return false;
    }
    const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
    console.log(`[capcut-tts] Generated ${sizeKb}KB MP3 -> ${path.basename(outputPath)}`);
    return true;
  } catch (error: any) {
    console.error(`[capcut-tts] Bridge spawn error: ${error.message}`);
    return false;
  }
}

/**
 * Spawn the Python TTS bridge and stream stderr to console for live debugging.
 * Resolves with the process exit code (0 = success).
 */
function runPythonBridge(args: string[], timeoutSeconds: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, args, {
      env: {
        ...process.env,
        // Make sure the vendored library is importable even if the Python
        // helper is invoked from a different CWD.
        PYTHONPATH: [VENDOR_DIR, process.env.PYTHONPATH].filter(Boolean).join(':'),
        PYTHONUNBUFFERED: '1',
        // Force UTF-8 I/O on Windows (default is cp1252 which breaks CJK output)
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
    });

    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      // Give it a moment to clean up, then SIGKILL if still alive.
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 2000);
      reject(new Error(`Python TTS bridge timed out after ${timeoutSeconds}s`));
    }, (timeoutSeconds + 30) * 1000);

    // Bridge writes nothing to stdout on success — only stderr logs.
    proc.stdout.on('data', () => { /* discard */ });

    proc.stderr.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
      stderr += text;
      // Stream bridge logs to our own console for live debugging.
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[capcut-tts-py] ${line}`);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to spawn Python TTS bridge (${PYTHON_BIN}). ` +
            `Install Python 3.9+ and the 'requests' package, or set CAPCUT_PYTHON. ` +
            `Underlying error: ${err.message}`
        )
      );
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.split('\n').slice(-8).join('\n');
        console.error(`[capcut-tts] Bridge failed (exit ${code}). Last logs:\n${tail}`);
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * List of voices supported by the bridge. Useful for the frontend to
 * render a voice picker without hitting the CapCut API.
 */
export const SUPPORTED_VOICES = [
  { id: 'vi_vn_1', label: 'Nữ ngọt ngào (Nhỏ Ngọt Ngào)', capcutVoice: 'BV421_vivn_streaming' },
  { id: 'vi_vn_2', label: 'Nam trầm (Giọng Nam Trầm)', capcutVoice: 'multi_male_felipe_uranus_bigtts' },
  { id: 'vi_female_news', label: 'Nữ năng động (Cô Gái Hoạt Ngôn)', capcutVoice: 'BV074_streaming' },
  { id: 'vi_female_review', label: 'Nữ review phim', capcutVoice: 'multi_female_richgirl_uranus_bigtts' },
  { id: 'vi_female_young', label: 'Nữ trẻ (Giọng Gái Mới Lớn)', capcutVoice: 'multi_female_peiqi_uranus_bigtts' },
] as const;
