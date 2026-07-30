import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';

import { extractAudio, audioToSrt } from '../../../../mini-services/translation-service/src/capcut';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function sanitizeFileNameSegment(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function resolveVideoExtension(originalFileName?: string, videoUrl?: string) {
  const fromOriginal = originalFileName ? path.extname(originalFileName) : '';
  if (fromOriginal) return fromOriginal;

  if (videoUrl) {
    try {
      const parsedUrl = new URL(videoUrl);
      const fromUrl = path.extname(parsedUrl.pathname);
      if (fromUrl) return fromUrl;
    } catch {
      // Ignore invalid URL parsing here and use the default below.
    }
  }

  return '.mp4';
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    movieId?: string;
    movieTitle?: string;
    originalFileName?: string;
    videoUrl?: string;
  };

  if (!body.movieId || !body.videoUrl) {
    return NextResponse.json(
      { success: false, error: 'Thiếu movieId hoặc videoUrl' },
      { status: 400 }
    );
  }

  const workDir = path.join(os.tmpdir(), `extract-srt-${body.movieId}-${nanoid(6)}`);
  const testDir = path.resolve(process.cwd(), 'test');

  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    const extension = resolveVideoExtension(body.originalFileName, body.videoUrl);
    const videoPath = path.join(workDir, `original${extension}`);

    const response = await fetch(body.videoUrl);
    if (!response.ok) {
      throw new Error(`Không tải được video: ${response.status}`);
    }

    const videoBuffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(videoPath, videoBuffer);

    const audioPath = await extractAudio(videoPath, workDir);
    const originalSrt = await audioToSrt(audioPath, workDir, 'zh');

    if (!originalSrt.trim()) {
      throw new Error('Không tạo được nội dung SRT');
    }

    const preferredBaseName =
      sanitizeFileNameSegment(body.movieTitle || '') ||
      sanitizeFileNameSegment(path.parse(body.originalFileName || '').name) ||
      body.movieId;
    const outputFileName = `${preferredBaseName}-${body.movieId}.srt`;
    const outputPath = path.join(testDir, outputFileName);

    fs.writeFileSync(outputPath, originalSrt, 'utf-8');

    return NextResponse.json({
      success: true,
      fileName: outputFileName,
      outputPath,
      srt: originalSrt,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Tạo SRT thất bại' },
      { status: 500 }
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
