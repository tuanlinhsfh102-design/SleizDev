// CapCut Speech-to-Text integration
// Based on https://github.com/K07VN/capcut-tts-api
//
// This module:
//   1. Extracts audio from a video file via ffmpeg (libmp3lame, 16kHz mono).
//   2. Spawns a vendored Python helper (`scripts/capcut_stt.py`) that drives
//      CapCut's official /lv/v1/common_task workflow (VOD upload + STT task +
//      poll) and emits a real SRT document on stdout.
//
// The previous implementation called fictional endpoints
// (us-api.capcut.com/api/asr/task, /api/auth/device) which never existed, so
// every transcription silently fell back to a silence-based stub that produced
// placeholder subtitles like "[Phân đoạn 1]". That is why SRT extraction
// always returned junk. This rewrite talks to the real CapCut API through the
// Python SDK (capcut-tts-api), which is vendored under ../vendor/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { spawn } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';

const execAsync = promisify(exec);

const FFMPEG_PATH = ffmpegStatic as unknown as string;

// Resolve the Python bridge script and vendored library locations relative to
// this source file so the integration works whether the project is run via
// `node dev`, `next dev`, or a compiled Next.js standalone build.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.resolve(MODULE_DIR, '..', 'scripts', 'capcut_stt.py');
const VENDOR_DIR = path.resolve(MODULE_DIR, '..', 'vendor');
const DEVICE_JSON = path.resolve(MODULE_DIR, '..', 'device.json');

// Allow overriding the Python interpreter via env (defaults to `python3`).
const PYTHON_BIN = process.env.CAPCUT_PYTHON || process.env.PYTHON || 'python3';

/**
 * Extract audio from video file.
 * Output: <outputDir>/audio.mp3 (16 kHz mono, 64 kbps — best for CapCut ASR).
 */
export async function extractAudio(
  videoPath: string,
  outputDir: string
): Promise<string> {
  const audioPath = path.join(outputDir, 'audio.mp3');

  const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" -vn -acodec libmp3lame -ac 1 -ar 16000 -ab 64k "${audioPath}" -y`;

  console.log('[ffmpeg] Extracting audio...');
  const { stderr } = await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
  if (stderr) {
    console.log('[ffmpeg] stderr (info):', stderr.substring(0, 200));
  }

  if (!fs.existsSync(audioPath)) {
    throw new Error('Audio extraction failed');
  }

  return audioPath;
}

/**
 * Get video duration in milliseconds (best-effort, parses ffmpeg stderr).
 */
export async function getVideoDuration(videoPath: string): Promise<number> {
  const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" 2>&1 | grep "Duration"`;
  try {
    const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 });
    const match = stdout.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
    if (match) {
      const [, h, m, s] = match;
      return (
        parseInt(h, 10) * 3600000 +
        parseInt(m, 10) * 60000 +
        parseFloat(s) * 1000
      );
    }
  } catch {
    // ignore — duration is informational
  }
  return 0;
}

export interface AudioToSrtOptions {
  /** Optional CapCut device.json profile path. */
  devicePath?: string;
  /** Optional translation target language (e.g. "vi-VN"). */
  translationLanguage?: string;
  /** Request translation alongside transcription. */
  useTranslation?: boolean;
  /** Max seconds to wait for the STT task to finish. */
  timeoutSeconds?: number;
}

/**
 * Convert audio to SRT using CapCut's official STT API via the vendored
 * Python bridge. Returns the raw SRT document on success.
 *
 * Throws on any failure (upload error, task failure, timeout, missing
 * Python). Does NOT silently fall back to fake subtitles — the previous
 * behavior of returning placeholder "[Phân đoạn N]" cues is what masked
 * the bug for so long.
 */
export async function audioToSrt(
  audioPath: string,
  _outputDir: string,
  language = 'zh-CN',
  options: AudioToSrtOptions = {}
): Promise<string> {
  console.log('[capcut] Starting STT via Python bridge...');

  // Normalize short language codes to CapCut's expected IETF form.
  const langMap: Record<string, string> = {
    zh: 'zh-CN',
    en: 'en-US',
    vi: 'vi-VN',
    ja: 'ja-JP',
    ko: 'ko-KR',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
  };
  const normalizedLang = langMap[language] || language;

  if (!fs.existsSync(BRIDGE_SCRIPT)) {
    throw new Error(
      `CapCut STT bridge script not found at: ${BRIDGE_SCRIPT}. ` +
        'Make sure the vendored mini-services/translation-service/scripts/capcut_stt.py is committed.'
    );
  }
  if (!fs.existsSync(VENDOR_DIR)) {
    throw new Error(
      `Vendored capcut-tts-api library not found at: ${VENDOR_DIR}. ` +
        'Run `git pull` or restore mini-services/translation-service/vendor/.'
    );
  }

  const devicePath = options.devicePath || (fs.existsSync(DEVICE_JSON) ? DEVICE_JSON : undefined);

  const args: string[] = [
    BRIDGE_SCRIPT,
    '--audio', audioPath,
    '--language', normalizedLang,
    '--timeout', String(options.timeoutSeconds ?? 240),
  ];
  if (options.translationLanguage) {
    args.push('--translation-language', options.translationLanguage);
  }
  if (options.useTranslation) {
    args.push('--use-translation');
  }
  if (devicePath) {
    args.push('--device', devicePath);
  }

  const srt = await runPythonBridge(args, options.timeoutSeconds ?? 240);
  if (!srt || !srt.trim()) {
    throw new Error('CapCut STT returned an empty SRT (no speech detected or API error).');
  }
  return srt;
}

/**
 * Spawn the Python bridge and collect stdout (SRT) + stderr (logs).
 * Rejects on non-zero exit code with a combined error message.
 */
function runPythonBridge(args: string[], timeoutSeconds: number): Promise<string> {
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

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Python STT bridge timed out after ${timeoutSeconds}s`));
    }, (timeoutSeconds + 30) * 1000);

    proc.stdout.on('data', (chunk: Buffer | string) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
    });
    proc.stderr.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
      stderr += text;
      // Stream bridge logs to our own console for live debugging.
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[capcut-py] ${line}`);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to spawn Python STT bridge (${PYTHON_BIN}). ` +
            `Install Python 3.9+ and the 'requests' package, or set CAPCUT_PYTHON. ` +
            `Underlying error: ${err.message}`
        )
      );
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const tail = stderr.split('\n').slice(-12).join('\n');
      reject(
        new Error(
          `CapCut STT bridge exited with code ${code}.\n` +
            `Python: ${PYTHON_BIN}\n` +
            `Script: ${BRIDGE_SCRIPT}\n` +
            `Last logs:\n${tail}`
        )
      );
    });
  });
}
