// Translation Service - Bun + Socket.io
// Handles video → SRT → Vietnamese → TTS → dubbed video → AI description pipeline
// Port: 3004
// Uses Socket.io for ALL communication (HTTP routes conflict with Socket.io path '/')

// Load env variables first
import './env-loader.js';

import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { nanoid } from 'nanoid';

import { extractAudio, audioToSrt, getVideoDuration } from './capcut.js';
import { translateSrt, generateMovieDescription, testGeminiApiKey } from './gemini.js';
import { generateAudioFromSrt, dubVideo } from './tiktok-tts.js';
import { JobStatus } from './types.js';

const PORT = 3004;

// Supabase admin client (uses service role key)
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[FATAL] Missing Supabase credentials');
}

const supabase = createSupabaseClient(supabaseUrl!, supabaseKey!, {
  auth: { persistSession: false },
});

// HTTP server (only for Socket.io handshake, no custom routes)
const httpServer = createServer((req, res) => {
  // Basic health check that doesn't conflict with Socket.io
  if (req.url === '/health-check') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. Use Socket.io for communication.' }));
});

// Socket.io for realtime updates - path must be '/' for Caddy gateway
const io = new Server(httpServer, {
  path: '/',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

interface TranslationParams {
  movieId: string;
  jobId: string;
  videoUrl: string;
  userId: string;
  apiKeys: { gemini?: string; capcut?: string; tiktok?: string };
  ttsVoice: string;
  movieTitle: string;
  episode: string;
  channelName: string;
}

io.on('connection', (socket: Socket) => {
  console.log(`[socket] Client connected: ${socket.id}`);

  // Join a movie's room to receive updates
  socket.on('join-movie', (data: { movieId: string }) => {
    socket.join(`movie:${data.movieId}`);
    console.log(`[socket] ${socket.id} joined movie:${data.movieId}`);
  });

  // Start translation pipeline
  socket.on('start-translation', async (params: TranslationParams, ack?: (response: any) => void) => {
    console.log(`[socket] start-translation for movie ${params.movieId}`);

    // Acknowledge receipt
    if (ack) {
      ack({ status: 'accepted', message: 'Translation started' });
    }

    // Process in background
    processTranslation(params, socket).catch((error) => {
      console.error('[translation] Pipeline failed:', error);
      socket.emit('translation-error', {
        movieId: params.movieId,
        error: error.message,
      });
    });
  });

  // Generate description only (for regeneration)
  socket.on('generate-description', async (params: {
    movieId: string;
    srt: string;
    movieTitle: string;
    episode: string;
    apiKey: string;
  }, ack?: (response: any) => void) => {
    console.log(`[socket] generate-description for movie ${params.movieId}`);
    try {
      const description = await generateMovieDescription(
        params.srt,
        params.movieTitle,
        params.episode,
        params.apiKey
      );
      if (ack) {
        ack({ success: true, description });
      }
      socket.emit('description-generated', {
        movieId: params.movieId,
        description,
      });
    } catch (error: any) {
      console.error('[socket] generate-description failed:', error);
      if (ack) {
        ack({ success: false, error: error.message });
      }
    }
  });

  // Test API key
  socket.on('test-api-key', async (params: { apiKey: string }, ack?: (response: any) => void) => {
    try {
      const valid = await testGeminiApiKey(params.apiKey);
      if (ack) {
        ack({ success: valid });
      }
    } catch (error: any) {
      if (ack) {
        ack({ success: false, error: error.message });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[socket] Client disconnected: ${socket.id}`);
  });
});

/**
 * Send job progress update via socket.io and update database
 */
async function updateJobProgress(
  jobId: string,
  movieId: string,
  status: JobStatus,
  progress: number,
  currentStep: string,
  socket?: Socket
) {
  const job = {
    id: jobId,
    movie_id: movieId,
    status,
    progress,
    current_step: currentStep,
  };

  // Update database
  try {
    await supabase
      .from('translation_jobs')
      .update({
        status,
        progress,
        current_step: currentStep,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  } catch (e) {
    console.warn('[db] Failed to update job:', e);
  }

  // Emit to all clients in the movie room
  io.to(`movie:${movieId}`).emit('job-progress', {
    movieId,
    job,
  });

  console.log(`[job] ${jobId} - ${status} (${progress}%) - ${currentStep}`);
}

/**
 * Fetch up to 3 most recent Vietnamese SRTs from earlier episodes of the
 * same channel as `movieId`. Used as Gemini conversation history so names,
 * nicknames, and tone stay consistent across episodes.
 *
 * Returns an empty array if anything goes wrong — translation proceeds
 * without history rather than failing.
 */
async function fetchPreviousTranslations(movieId: string): Promise<string[]> {
  try {
    // First, look up which channel this movie belongs to.
    const { data: movie, error: movieErr } = await supabase
      .from('movies')
      .select('channel_id, created_at')
      .eq('id', movieId)
      .single();
    if (movieErr || !movie?.channel_id) {
      console.warn('[history] Could not resolve channel for movie, skipping history');
      return [];
    }

    // Then fetch the 3 most recent earlier movies in that channel that have
    // a Vietnamese SRT already.
    const { data: prevMovies, error: prevErr } = await supabase
      .from('movies')
      .select('vietnamese_srt, title, episode')
      .eq('channel_id', movie.channel_id)
      .not('vietnamese_srt', 'is', null)
      .neq('id', movieId)
      .order('created_at', { ascending: true })
      .limit(3);

    if (prevErr || !prevMovies?.length) {
      console.log('[history] No previous Vietnamese translations found');
      return [];
    }

    console.log(
      `[history] Found ${prevMovies.length} previous translation(s) for conversation history`
    );
    return prevMovies
      .map((m: any) => m.vietnamese_srt as string)
      .filter((s: string) => s && s.trim().length > 0);
  } catch (err: any) {
    console.warn('[history] Failed to fetch conversation history:', err.message);
    return [];
  }
}

/**
 * Main translation pipeline
 */
async function processTranslation(params: TranslationParams, socket?: Socket) {
  const { movieId, jobId, videoUrl, userId, apiKeys, ttsVoice, movieTitle, episode } = params;

  // Create temp working directory
  const workDir = path.join(os.tmpdir(), `translation-${movieId}-${nanoid(8)}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    console.log(`[pipeline] Starting translation for movie ${movieId}, job ${jobId}`);

    // Step 1: Download video
    await updateJobProgress(jobId, movieId, 'extracting_audio', 10, 'Đang tải video xuống...', socket);
    const videoPath = path.join(workDir, 'original.mp4');
    await downloadFile(videoUrl, videoPath);

    // Step 2: Extract audio
    await updateJobProgress(jobId, movieId, 'extracting_audio', 15, 'Đang trích xuất âm thanh từ video...', socket);
    const audioPath = await extractAudio(videoPath, workDir);

    // Get video duration
    const durationMs = await getVideoDuration(videoPath);
    console.log(`[pipeline] Video duration: ${durationMs}ms`);

    // Step 3: Convert audio to SRT
    await updateJobProgress(jobId, movieId, 'generating_srt', 25, 'Đang nhận diện giọng nói thành SRT (CapCut API)...', socket);
    const originalSrt = await audioToSrt(audioPath, workDir, 'zh');

    // Save original SRT to database
    await supabase
      .from('movies')
      .update({ original_srt: originalSrt })
      .eq('id', movieId);

    // Step 4: Translate SRT to Vietnamese
    await updateJobProgress(jobId, movieId, 'translating', 40, 'Đang dịch SRT sang tiếng Việt (Gemini)...', socket);

    // Fetch up to 3 previous Vietnamese SRTs from the same channel for
    // conversation history — this keeps character names, nicknames, and
    // tone consistent across episodes.
    const conversationHistory = await fetchPreviousTranslations(movieId);

    const vietnameseSrt = await translateSrt(originalSrt, apiKeys.gemini!, {
      conversationHistory,
      onProgress: async (current, total) => {
        const progress = 40 + Math.floor((current / total) * 10);
        await updateJobProgress(jobId, movieId, 'translating', progress, `Đang dịch batch ${current + 1}/${total}...`, socket);
      },
    });

    // Save Vietnamese SRT to database
    await supabase
      .from('movies')
      .update({ vietnamese_srt: vietnameseSrt })
      .eq('id', movieId);

    // Step 5: Generate TTS audio
    await updateJobProgress(jobId, movieId, 'generating_tts', 60, 'Đang tạo âm thanh lồng tiếng (TikTok TTS)...', socket);
    const fullAudioPath = await generateAudioFromSrt(
      vietnameseSrt,
      ttsVoice,
      workDir,
      durationMs,
      async (current, total) => {
        const progress = 60 + Math.floor((current / total) * 15);
        await updateJobProgress(jobId, movieId, 'generating_tts', progress, `Đang tạo giọng nói ${current + 1}/${total}...`, socket);
      }
    );

    // Step 6: Dub the video
    await updateJobProgress(jobId, movieId, 'dubbing', 80, 'Đang lồng tiếng vào video...', socket);
    const dubbedVideoPath = path.join(workDir, 'dubbed.mp4');
    await dubVideo(videoPath, fullAudioPath, dubbedVideoPath, 0.1);

    // Upload dubbed video to Supabase storage
    await updateJobProgress(jobId, movieId, 'dubbing', 88, 'Đang tải video lồng tiếng lên...', socket);
    const dubbedVideoUrl = await uploadToSupabase(dubbedVideoPath, userId, movieId, 'dubbed-videos', 'dubbed.mp4');

    // Update movie with dubbed video URL
    await supabase
      .from('movies')
      .update({
        dubbed_video_url: dubbedVideoUrl,
        status: 'translating',
      })
      .eq('id', movieId);

    // Step 7: Generate AI description
    await updateJobProgress(jobId, movieId, 'generating_description', 92, 'Đang tạo mô tả phim bằng AI (Gemini)...', socket);
    try {
      const description = await generateMovieDescription(
        vietnameseSrt,
        movieTitle,
        episode,
        apiKeys.gemini!
      );

      await supabase
        .from('movies')
        .update({ ai_description: description })
        .eq('id', movieId);
    } catch (descError: any) {
      console.warn('[pipeline] Description generation failed:', descError.message);
    }

    // Step 8: Complete
    await updateJobProgress(jobId, movieId, 'completed', 100, 'Hoàn thành!', socket);

    // Update movie status
    await supabase
      .from('movies')
      .update({ status: 'completed' })
      .eq('id', movieId);

    console.log(`[pipeline] Translation completed for movie ${movieId}`);
  } catch (error: any) {
    console.error(`[pipeline] Translation failed for movie ${movieId}:`, error);

    await updateJobProgress(jobId, movieId, 'failed', 0, `Lỗi: ${error.message}`, socket);

    await supabase
      .from('movies')
      .update({ status: 'failed' })
      .eq('id', movieId);
  } finally {
    // Cleanup temp directory
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log(`[pipeline] Cleaned up ${workDir}`);
    } catch (e) {
      console.warn('[pipeline] Failed to cleanup temp dir:', e);
    }
  }
}

/**
 * Download a file from URL to local path
 */
async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  console.log(`[download] Saved ${buffer.length} bytes to ${outputPath}`);
}

/**
 * Upload file to Supabase storage
 */
async function uploadToSupabase(
  filePath: string,
  userId: string,
  movieId: string,
  bucket: string,
  fileName: string
): Promise<string> {
  const fullPath = `${userId}/${movieId}/${fileName}`;
  const fileBuffer = fs.readFileSync(filePath);

  const { error } = await supabase.storage
    .from(bucket)
    .upload(fullPath, fileBuffer, {
      upsert: true,
      contentType: fileName.endsWith('.mp4') ? 'video/mp4' : 'audio/mpeg',
    });

  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(fullPath);
  return data.publicUrl;
}

// Start server
httpServer.listen(PORT, () => {
  console.log(`[translation-service] Running on port ${PORT}`);
  console.log(`[translation-service] WebSocket path: /?XTransformPort=${PORT}`);
  console.log(`[translation-service] Supabase URL: ${supabaseUrl ? '✓' : '✗'}`);
  console.log(`[translation-service] Using Socket.io for all communication`);

  // Recover orphaned pending jobs (created while service was down or disconnected)
  recoverPendingJobs().catch((e) =>
    console.error('[startup] Failed to recover pending jobs:', e)
  );
});

/**
 * Startup recovery: pick up jobs stuck in 'pending' state (e.g. service was
 * down when the user clicked Start). For each, re-fetch movie/api_keys and
 * resume the pipeline. We only pick up jobs created in the last 10 minutes
 * so we never silently restart ancient jobs the user has moved on from.
 */
async function recoverPendingJobs() {
  if (!supabaseUrl || !supabaseKey) return;

  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: pendingJobs, error } = await supabase
    .from('translation_jobs')
    .select('id, movie_id, user_id, created_at')
    .eq('status', 'pending')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[startup] recoverPendingJobs query failed:', error);
    return;
  }
  if (!pendingJobs || pendingJobs.length === 0) {
    console.log('[startup] No orphaned pending jobs to recover.');
    return;
  }

  console.log(`[startup] Recovering ${pendingJobs.length} orphaned pending job(s)...`);

  for (const job of pendingJobs) {
    try {
      // Fetch the movie to get video_url, tts_voice, title, episode
      const { data: movie } = await supabase
        .from('movies')
        .select('id, title, episode, video_url, tts_voice, channel_id')
        .eq('id', job.movie_id)
        .single();
      if (!movie?.video_url) {
        console.warn(`[startup] Skip job ${job.id}: movie missing or no video_url`);
        continue;
      }

      // Fetch the user's active API keys
      const { data: apiKeyRows } = await supabase
        .from('api_keys')
        .select('provider, key_value')
        .eq('user_id', job.user_id)
        .eq('is_active', true);
      const apiKeys: { gemini?: string; capcut?: string; tiktok?: string } = {};
      (apiKeyRows || []).forEach((k: any) => {
        if (k.provider === 'gemini') apiKeys.gemini = k.key_value;
        if (k.provider === 'capcut') apiKeys.capcut = k.key_value;
        if (k.provider === 'tiktok') apiKeys.tiktok = k.key_value;
      });
      if (!apiKeys.gemini) {
        console.warn(`[startup] Skip job ${job.id}: no active Gemini key for user`);
        continue;
      }

      console.log(`[startup] Resuming job ${job.id} for movie ${movie.id}`);
      // Broadcast to anyone listening on the movie room (no originating socket)
      io.to(`movie:${movie.id}`).emit('job-resumed', { jobId: job.id, movieId: movie.id });

      processTranslation(
        {
          movieId: movie.id,
          jobId: job.id,
          videoUrl: movie.video_url,
          userId: job.user_id,
          apiKeys,
          ttsVoice: movie.tts_voice || 'vi_vn_1',
          movieTitle: movie.title,
          episode: movie.episode || '',
          channelName: '',
        },
        undefined
      ).catch((err) =>
        console.error(`[startup] Resume job ${job.id} failed:`, err)
      );
    } catch (e) {
      console.error(`[startup] Failed to recover job ${job.id}:`, e);
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[translation-service] Shutting down...');
  httpServer.close(() => {
    io.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[translation-service] Received SIGINT...');
  httpServer.close(() => {
    io.close();
    process.exit(0);
  });
});
