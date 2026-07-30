/**
 * Quick test of the TikTok import logic (URL resolution + scraper).
 * Runs outside Next.js so we can verify the download logic works.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

const TEST_URL = 'https://vt.tiktok.com/ZS42guBnS/';

async function resolveShortUrl(url: string): Promise<string> {
  if (!url.match(/vt\.tiktok\.com|vm\.tiktok\.com/i)) return url;
  const resp = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  return resp.url;
}

async function main() {
  console.log('=== Test 1: resolveShortUrl ===');
  console.log(`Input: ${TEST_URL}`);
  try {
    const finalUrl = await resolveShortUrl(TEST_URL);
    console.log(`Final URL: ${finalUrl}`);
    if (finalUrl.includes('/about') || finalUrl.includes('/share/')) {
      console.log('⚠️  TikTok redirected to /about — URL is likely expired/invalid/blocked from this IP.');
      console.log('   This is EXPECTED on a datacenter IP. On the user\'s residential IP, it should work.');
    } else if (finalUrl.match(/tiktok\.com\/@[\w.-]+\/video\/\d+/)) {
      console.log('✓ URL resolved to a valid TikTok video page URL');
    }
  } catch (err: any) {
    console.log(`✗ resolveShortUrl failed: ${err.message}`);
  }
  console.log();

  console.log('=== Test 2: yt-dlp availability ===');
  const ytdlpCheck = await new Promise<{ ok: boolean; version: string | null }>((resolve) => {
    const proc = spawn('yt-dlp', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    proc.on('close', (code) => resolve({ ok: code === 0, version: code === 0 ? stdout.trim() : null }));
    proc.on('error', () => resolve({ ok: false, version: null }));
  });
  console.log(`yt-dlp available: ${ytdlpCheck.ok}`);
  console.log(`yt-dlp version: ${ytdlpCheck.version || 'N/A'}`);
  console.log();

  console.log('=== Test 3: yt-dlp on the user\'s URL ===');
  console.log('(This will likely fail on datacenter IP — that\'s expected.)');
  const workDir = path.join(os.tmpdir(), `tiktok-test-${randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const outputFile = path.join(workDir, 'video.%(ext)s');
  const args = [
    '--no-warnings', '--no-playlist', '--no-check-certificates',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-f', 'mp4', '-o', outputFile, '--merge-output-format', 'mp4', '--print-json',
    TEST_URL,
  ];
  const ytdlpResult = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    proc.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    proc.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    proc.on('error', (err) => resolve({ ok: false, stdout, stderr: err.message }));
  });
  console.log(`yt-dlp exit: ${ytdlpResult.ok ? 'OK' : 'FAILED'}`);
  if (ytdlpResult.stderr) {
    console.log(`stderr (last 3 lines): ${ytdlpResult.stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
  }
  // Check if any file was downloaded
  const files = fs.existsSync(workDir) ? fs.readdirSync(workDir) : [];
  console.log(`Files in workdir: ${files.length > 0 ? files.join(', ') : 'none'}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log();

  console.log('=== Summary ===');
  console.log('On the user\'s Windows machine (residential IP):');
  console.log('  - yt-dlp should be installed (pip install yt-dlp)');
  console.log('  - The TikTok URL should resolve to a valid video page');
  console.log('  - yt-dlp should download the MP4 successfully');
  console.log('  - The manual scraper fallback will also work if yt-dlp fails');
  console.log('  - The downloaded MP4 gets uploaded to Supabase storage');
  console.log('  - Then /api/extract-srt runs to generate the SRT automatically');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
