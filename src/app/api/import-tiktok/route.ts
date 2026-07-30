/**
 * POST /api/import-tiktok
 *
 * Downloads a TikTok video from a URL (short link or full URL), saves it to
 * Supabase storage, and returns the public URL so the frontend can update
 * the movie record and trigger SRT extraction.
 *
 * Request body:
 *   { url: string, movieId: string, userId: string }
 *
 * Response (200):
 *   { success: true, videoUrl: string, title: string, filename: string, method: string }
 *
 * Response (400/500):
 *   { success: false, error: string }
 *
 * Download strategy (two methods, tried in order):
 *   1. yt-dlp (preferred) — spawns the `yt-dlp` binary if installed.
 *      Handles TikTok short URLs, bot detection, redirects, and format
 *      selection. This works on residential IPs (the user's machine).
 *   2. Manual HTML scraper (fallback) — fetches the TikTok page HTML,
 *      extracts the video URL from the `__UNIVERSAL_DATA_FOR_REHYDRATION__`
 *      JSON blob, and downloads the MP4 directly. Used when yt-dlp is not
 *      installed or fails.
 *
 * Both methods write the MP4 to a temp file, then upload it to Supabase
 * storage at `${userId}/${movieId}/original.mp4` (same path pattern as the
 * browser upload flow, so the rest of the pipeline doesn't need to know
 * whether the video came from upload or TikTok import).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes — enough for most TikTok downloads

interface ImportRequest {
  url: string;
  movieId: string;
  userId: string;
}

interface DownloadResult {
  filePath: string;
  title: string;
  filename: string;
}

/**
 * Resolve a TikTok short URL (vt.tiktok.com/xxx) to its final destination.
 * TikTok sometimes redirects to /hk/about when it detects a bot — we throw
 * a clear error so the user knows the URL might be expired/invalid.
 */
async function resolveShortUrl(url: string): Promise<string> {
  // Only resolve if it's a short URL
  if (!url.match(/vt\.tiktok\.com|vm\.tiktok\.com/i)) {
    return url;
  }

  const resp = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const finalUrl = resp.url;
  console.log(`[import-tiktok] Short URL ${url} -> ${finalUrl}`);

  // TikTok redirects blocked URLs to /about — detect this and warn
  if (finalUrl.includes('/about') || finalUrl.includes('/share/')) {
    throw new Error(
      `TikTok redirected the short URL to "${finalUrl}" — this usually means ` +
        'the video has been deleted, is geo-restricted, or TikTok is blocking ' +
        'this server. Try a different URL or download the video manually and ' +
        'upload the file.'
    );
  }

  return finalUrl;
}

/**
 * Method 1: Download via yt-dlp binary.
 *
 * yt-dlp is the most reliable TikTok downloader — it handles short URLs,
 * bot detection, format selection, and CDN redirects. Requires the `yt-dlp`
 * binary on PATH (install with `pip install yt-dlp` or download from
 * https://github.com/yt-dlp/yt-dlp/releases).
 *
 * Returns the path to the downloaded MP4 + metadata, or throws if yt-dlp
 * is not available / fails.
 */
function downloadWithYtDlp(url: string, outputDir: string): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const outputFile = path.join(outputDir, 'video.%(ext)s');
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-f',
      'mp4',
      '-o',
      outputFile,
      '--merge-output-format',
      'mp4',
      '--print-json',
      url,
    ];

    console.log(`[import-tiktok] Spawning yt-dlp for ${url}`);
    const proc = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
      // Stream yt-dlp progress to our logs for debugging
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (line.trim()) console.log(`[import-tiktok] yt-dlp: ${line}`);
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('yt-dlp timed out after 180 seconds'));
    }, 180000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT means the binary doesn't exist — caller should try fallback
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('yt-dlp binary not found on PATH'));
      } else {
        reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `yt-dlp exited with code ${code}. ` +
              `stderr: ${stderr.split('\n').slice(-5).join(' | ')}`
          )
        );
        return;
      }

      // yt-dlp --print-json writes a JSON line to stdout with metadata
      let title = 'TikTok Video';
      let filename = 'video.mp4';
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        if (lines.length > 0) {
          const meta = JSON.parse(lines[lines.length - 1]);
          if (meta.title) title = String(meta.title).slice(0, 100);
          if (meta.ext) filename = `video.${meta.ext}`;
        }
      } catch {
        // --print-json might not be supported in older yt-dlp; use defaults
      }

      // yt-dlp may have written to a different extension if it merged formats.
      // Look for the actual output file in the output dir.
      const files = fs.readdirSync(outputDir).filter((f) => f.startsWith('video'));
      if (files.length === 0) {
        reject(new Error('yt-dlp succeeded but no output file was found'));
        return;
      }
      const actualFile = path.join(outputDir, files[0]);
      if (!fs.existsSync(actualFile) || fs.statSync(actualFile).size < 1000) {
        reject(new Error('yt-dlp output file is missing or too small'));
        return;
      }

      console.log(
        `[import-tiktok] yt-dlp success: ${fs.statSync(actualFile).size} bytes, title="${title}"`
      );
      resolve({ filePath: actualFile, title, filename });
    });
  });
}

/**
 * Method 2: Manual HTML scraper (fallback when yt-dlp is not available).
 *
 * Fetches the TikTok page HTML, extracts the video download URL from the
 * `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON blob, and downloads the MP4
 * directly. Less reliable than yt-dlp (TikTok may block the request or
 * change their page structure) but no binary dependency.
 */
async function downloadWithScraper(url: string, outputDir: string): Promise<DownloadResult> {
  console.log(`[import-tiktok] Fallback: manual scraper for ${url}`);

  const fullUrl = await resolveShortUrl(url);

  // Fetch the TikTok page HTML with browser-like headers
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Referer': 'https://www.tiktok.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };

  const pageResp = await fetch(fullUrl, { headers, redirect: 'follow' });
  if (!pageResp.ok) {
    throw new Error(`Failed to fetch TikTok page: HTTP ${pageResp.status}`);
  }
  const html = await pageResp.text();
  console.log(`[import-tiktok] Page HTML size: ${html.length} bytes`);

  // Extract video URL from __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON blob.
  // TikTok embeds all video data in a script tag like:
  //   <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{...}</script>
  const universalDataMatch = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  let videoUrl: string | null = null;
  let title = 'TikTok Video';

  if (universalDataMatch) {
    try {
      const data = JSON.parse(universalDataMatch[1]);
      // Navigate the nested structure: webapp.video-detail.itemInfo.itemStruct
      const itemStruct =
        data?.webapp?.['video-detail']?.itemInfo?.itemStruct ||
        data?.webapp?.['video-detail']?.itemStruct;
      if (itemStruct) {
        const video = itemStruct.video || {};
        // playAddr is usually an array of URLs with different quality
        const playAddr = video.playAddr || video.play_addr || video.downloadAddr;
        if (Array.isArray(playAddr) && playAddr.length > 0) {
          videoUrl = playAddr[0].url || playAddr[0].src;
        } else if (typeof playAddr === 'string') {
          videoUrl = playAddr;
        }
        if (itemStruct.desc) title = String(itemStruct.desc).slice(0, 100);
      }
    } catch (err) {
      console.warn(`[import-tiktok] Failed to parse __UNIVERSAL_DATA__: ${err}`);
    }
  }

  // Fallback: look for og:video meta tag
  if (!videoUrl) {
    const ogMatch = html.match(/<meta[^>]+property="og:video:url"[^>]+content="([^"]+)"/);
    if (ogMatch) videoUrl = ogMatch[1].replace(/&amp;/g, '&');
  }
  if (!videoUrl) {
    const ogMatch2 = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"/);
    if (ogMatch2) videoUrl = ogMatch2[1].replace(/&amp;/g, '&');
  }

  if (!videoUrl) {
    throw new Error(
      'Could not extract video URL from TikTok page. ' +
        'TikTok may have changed their page structure, or the video is ' +
        'private/deleted. Try installing yt-dlp for better compatibility.'
    );
  }

  console.log(`[import-tiktok] Extracted video URL: ${videoUrl.slice(0, 80)}...`);

  // Download the MP4 with proper Referer header (TikTok CDN requires it)
  const videoResp = await fetch(videoUrl, {
    headers: {
      'User-Agent': headers['User-Agent'],
      'Referer': 'https://www.tiktok.com/',
      'Accept': '*/*',
      'Range': 'bytes=0-',
    },
  });

  if (!videoResp.ok) {
    throw new Error(`Failed to download video: HTTP ${videoResp.status}`);
  }

  const buffer = Buffer.from(await videoResp.arrayBuffer());
  if (buffer.length < 1000) {
    throw new Error(`Downloaded video is too small (${buffer.length} bytes)`);
  }

  const outputFile = path.join(outputDir, 'video.mp4');
  fs.writeFileSync(outputFile, buffer);

  console.log(`[import-tiktok] Scraper success: ${buffer.length} bytes, title="${title}"`);
  return { filePath: outputFile, title, filename: 'video.mp4' };
}

/**
 * Upload a local file to Supabase storage using the service role key.
 * Server-side only — never expose the service role key to the browser.
 */
async function uploadToSupabase(
  filePath: string,
  userId: string,
  movieId: string
): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      'Missing Supabase credentials (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)'
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Same path pattern as the browser upload flow: ${userId}/${movieId}/original.mp4
  const storagePath = `${userId}/${movieId}/original.mp4`;
  const fileBuffer = fs.readFileSync(filePath);

  const { error } = await supabase.storage
    .from('videos')
    .upload(storagePath, fileBuffer, {
      upsert: true,
      contentType: 'video/mp4',
    });

  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from('videos').getPublicUrl(storagePath);
  console.log(`[import-tiktok] Uploaded to Supabase: ${storagePath} -> ${data.publicUrl}`);
  return data.publicUrl;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as ImportRequest;
  const { url, movieId, userId } = body;

  // --- Validate input ---
  if (!url || typeof url !== 'string') {
    return NextResponse.json(
      { success: false, error: 'Missing "url" field' },
      { status: 400 }
    );
  }
  if (!movieId || !userId) {
    return NextResponse.json(
      { success: false, error: 'Missing "movieId" or "userId"' },
      { status: 400 }
    );
  }

  // Basic URL validation — accept tiktok.com, vt.tiktok.com, vm.tiktok.com
  const trimmedUrl = url.trim();
  if (!trimmedUrl.match(/^https?:\/\/(www\.|vt\.|vm\.)?tiktok\.com/i)) {
    return NextResponse.json(
      {
        success: false,
        error: 'URL must be a TikTok URL (tiktok.com, vt.tiktok.com, or vm.tiktok.com)',
      },
      { status: 400 }
    );
  }

  console.log(
    `[import-tiktok] Import request: url=${trimmedUrl} movieId=${movieId} userId=${userId}`
  );

  // --- Download the video ---
  const workDir = path.join(os.tmpdir(), `tiktok-import-${movieId}-${randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });

  let downloadResult: DownloadResult;
  let downloadMethod: string;

  try {
    // Method 1: yt-dlp (preferred — works on residential IPs, handles bot detection)
    try {
      downloadResult = await downloadWithYtDlp(trimmedUrl, workDir);
      downloadMethod = 'yt-dlp';
    } catch (ytDlpErr: any) {
      const ytDlpMsg = ytDlpErr?.message || String(ytDlpErr);
      console.warn(
        `[import-tiktok] yt-dlp failed (${ytDlpMsg}), falling back to manual scraper`
      );
      // Method 2: manual HTML scraper (fallback — no binary dependency)
      try {
        downloadResult = await downloadWithScraper(trimmedUrl, workDir);
        downloadMethod = 'scraper';
      } catch (scraperErr: any) {
        const scraperMsg = scraperErr?.message || String(scraperErr);
        throw new Error(
          `Both download methods failed.\n` +
            `  yt-dlp: ${ytDlpMsg}\n` +
            `  scraper: ${scraperMsg}\n\n` +
            `Common causes:\n` +
            `  - The video has been deleted or is private\n` +
            `  - TikTok is blocking this server's IP (try from a residential connection)\n` +
            `  - The URL is not a valid TikTok video link\n` +
            `  - yt-dlp is outdated (run: pip install -U yt-dlp)`
        );
      }
    }

    // --- Upload to Supabase storage ---
    const publicUrl = await uploadToSupabase(downloadResult.filePath, userId, movieId);

    console.log(
      `[import-tiktok] Success via ${downloadMethod}: ${publicUrl} ` +
        `(title="${downloadResult.title}")`
    );

    return NextResponse.json({
      success: true,
      videoUrl: publicUrl,
      title: downloadResult.title,
      filename: downloadResult.filename,
      method: downloadMethod,
    });
  } catch (error: any) {
    console.error(`[import-tiktok] Failed: ${error.message}`);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Unknown error during TikTok import',
      },
      { status: 500 }
    );
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * GET /api/import-tiktok — health check + yt-dlp availability probe.
 * Useful for the frontend to show a warning if yt-dlp is not installed.
 */
export async function GET() {
  let ytDlpAvailable = false;
  let ytDlpVersion: string | null = null;

  try {
    const result = await new Promise<{ ok: boolean; version: string | null }>(
      (resolve) => {
        const proc = spawn('yt-dlp', ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        proc.on('close', (code) => {
          resolve({ ok: code === 0, version: code === 0 ? stdout.trim() : null });
        });
        proc.on('error', () => resolve({ ok: false, version: null }));
      }
    );
    ytDlpAvailable = result.ok;
    ytDlpVersion = result.version;
  } catch {
    // ignore — ytDlpAvailable stays false
  }

  return NextResponse.json({
    ok: true,
    ytDlpAvailable,
    ytDlpVersion,
    message: ytDlpAvailable
      ? 'TikTok import is ready (yt-dlp + manual scraper fallback)'
      : 'TikTok import is ready (manual scraper only — install yt-dlp for better reliability)',
  });
}
