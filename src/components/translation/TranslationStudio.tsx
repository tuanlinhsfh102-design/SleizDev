'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import {
  Video,
  Upload,
  FileText,
  Languages,
  Volume2,
  Film,
  Sparkles,
  Loader2,
  Play,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Wand2,
  Copy,
  Link as LinkIcon,
} from 'lucide-react';
import { Movie, TranslationJob, JOB_STATUS_LABELS } from '@/types';
import { toast } from 'sonner';
import { io, Socket } from 'socket.io-client';

interface TranslationStudioProps {
  movieId: string;
  movieTitle: string;
  channelId: string;
}

export function TranslationStudio({ movieId, movieTitle }: TranslationStudioProps) {
  const supabase = createClient();
  const [movie, setMovie] = useState<Movie | null>(null);
  const [job, setJob] = useState<TranslationJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [videoUploading, setVideoUploading] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [tiktokUrl, setTiktokUrl] = useState('');
  const [tiktokImporting, setTiktokImporting] = useState(false);
  const [tiktokImportStage, setTiktokImportStage] = useState('');
  const [activeTab, setActiveTab] = useState('upload');
  const [editedVietnameseSrt, setEditedVietnameseSrt] = useState('');
  const [editedDescription, setEditedDescription] = useState('');
  const [processing, setProcessing] = useState(false);
  const [apiKeys, setApiKeys] = useState<{ gemini?: string; capcut?: string; tiktok?: string }>({});
  const socketRef = useRef<Socket | null>(null);
  // Queue a start-translation payload so it can be re-emitted on reconnect
  // when the service is down at the moment the user clicks Start.
  const pendingStartRef = useRef<any>(null);

  const fetchMovie = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('movies')
      .select('*')
      .eq('id', movieId)
      .single();
    if (error) {
      toast.error('Không thể tải thông tin phim');
    } else if (data) {
      setMovie(data);
      setEditedVietnameseSrt(data.vietnamese_srt || '');
      setEditedDescription(data.ai_description || '');
      if (data.video_url) {
        setActiveTab((prev) => (prev === 'upload' ? 'original-srt' : prev));
      }
      if (data.status === 'completed') {
        setActiveTab('dubbed-video');
      }
    }
    setLoading(false);
  }, [supabase, movieId]);

  const fetchJob = useCallback(async () => {
    const { data } = await supabase
      .from('translation_jobs')
      .select('*')
      .eq('movie_id', movieId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      setJob(data);
      if (data.status === 'completed' || data.status === 'failed') {
        setProcessing(false);
      }
    }
  }, [supabase, movieId]);

  const fetchApiKeys = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('api_keys')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true);
    if (data) {
      const keys: { gemini?: string; capcut?: string; tiktok?: string } = {};
      data.forEach((k) => {
        if (k.provider === 'gemini') keys.gemini = k.key_value;
        if (k.provider === 'capcut') keys.capcut = k.key_value;
        if (k.provider === 'tiktok') keys.tiktok = k.key_value;
      });
      setApiKeys(keys);
    }
  }, [supabase]);

  useEffect(() => {
    fetchMovie();
    fetchJob();
    fetchApiKeys();
  }, [fetchMovie, fetchJob, fetchApiKeys]);

  // Realtime subscription
  useEffect(() => {
    // Connect to translation-service websocket.
    // In dev: connect directly to the Bun service on port 3004.
    // In prod: NEXT_PUBLIC_TRANSLATION_SERVICE_URL is set to the Caddy/gateway path (e.g. "/?XTransformPort=3004").
    const serviceUrl =
      process.env.NEXT_PUBLIC_TRANSLATION_SERVICE_URL || 'http://localhost:3004';
    const socket = io(serviceUrl, {
      path: '/',
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join-movie', { movieId });
      // If a start-translation was queued while disconnected, fire it now.
      if (pendingStartRef.current) {
        const payload = pendingStartRef.current;
        pendingStartRef.current = null;
        socket.emit('start-translation', payload, (response: any) => {
          if (response?.status === 'accepted') {
            toast.success('Đã bắt đầu quá trình dịch phim');
          } else {
            toast.error(response?.error || 'Không thể bắt đầu dịch');
            setProcessing(false);
          }
        });
      }
    });

    socket.on('job-progress', (data: { movieId: string; job: TranslationJob }) => {
      if (data.movieId === movieId) {
        setJob(data.job);
        if (data.job.status === 'completed') {
          setProcessing(false);
          toast.success('Hoàn thành quá trình dịch phim!');
          fetchMovie();
          setActiveTab('dubbed-video');
        } else if (data.job.status === 'failed') {
          setProcessing(false);
          toast.error('Quá trình dịch thất bại: ' + (data.job.error || ''));
        } else {
          // Auto switch to relevant tab based on step
          const status = data.job.status;
          if (status === 'extracting_audio' || status === 'generating_srt') {
            setActiveTab('original-srt');
          } else if (status === 'translating') {
            setActiveTab('vietnamese-srt');
          } else if (status === 'generating_tts' || status === 'dubbing') {
            setActiveTab('dubbed-video');
          } else if (status === 'generating_description') {
            setActiveTab('description');
          }
        }
      }
    });

    // Also subscribe to Supabase realtime for movie updates
    const channel = supabase
      .channel(`movie-${movieId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'movies', filter: `id=eq.${movieId}` },
        (payload) => {
          const updated = payload.new as Movie;
          setMovie(updated);
          if (updated.vietnamese_srt && !editedVietnameseSrt) {
            setEditedVietnameseSrt(updated.vietnamese_srt);
          }
          if (updated.ai_description && !editedDescription) {
            setEditedDescription(updated.ai_description);
          }
        }
      )
      .subscribe();

    return () => {
      socket.disconnect();
      supabase.removeChannel(channel);
    };
  }, [movieId]);

  const handleVideoUpload = async (file: File) => {
    if (!file.type.startsWith('video/')) {
      toast.error('Vui lòng chọn file video');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      toast.error('Kích thước video không được vượt quá 500MB');
      return;
    }
    setVideoFile(file);
    setVideoUploading(true);
    let videoUploaded = false;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Chưa đăng nhập');

      const ext = file.name.split('.').pop();
      const fileName = `${user.id}/${movieId}/original.${ext}`;
      const { error } = await supabase.storage
        .from('videos')
        .upload(fileName, file, { upsert: true });
      if (error) throw error;

      const { data: urlData } = supabase.storage
        .from('videos')
        .getPublicUrl(fileName);

      const { error: updateError } = await supabase
        .from('movies')
        .update({ video_url: urlData.publicUrl, status: 'draft' })
        .eq('id', movieId);
      if (updateError) throw updateError;
      videoUploaded = true;

      const extractResponse = await fetch('/api/extract-srt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          movieId,
          movieTitle,
          originalFileName: file.name,
          videoUrl: urlData.publicUrl,
        }),
      });

      const extractResult = await extractResponse.json();
      if (!extractResponse.ok || !extractResult.success) {
        throw new Error(extractResult.error || 'Tạo SRT thất bại');
      }

      const { error: srtUpdateError } = await supabase
        .from('movies')
        .update({ original_srt: extractResult.srt })
        .eq('id', movieId);
      if (srtUpdateError) throw srtUpdateError;

      toast.success(`Đã tạo SRT và lưu vào test\\${extractResult.fileName}`);
      fetchMovie();
      setActiveTab('original-srt');
    } catch (error: any) {
      if (videoUploaded) {
        toast.error(`Video đã tải lên nhưng tạo SRT thất bại: ${error.message || 'Lỗi không xác định'}`);
        fetchMovie();
        setActiveTab('original-srt');
      } else {
        toast.error(error.message || 'Tải video thất bại');
      }
    } finally {
      setVideoUploading(false);
    }
  };

  /**
   * Import a TikTok video via URL. The server downloads the MP4 (using
   * yt-dlp or a manual scraper), uploads it to Supabase storage at the
   * same path as a regular upload, then triggers SRT extraction.
   *
   * The UI shows a live stage indicator (downloading → uploading →
   * extracting SRT) so the user knows what's happening. The whole flow
   * can take 30-120 seconds depending on video length and network.
   */
  const handleTiktokImport = async () => {
    const url = tiktokUrl.trim();
    if (!url) {
      toast.error('Vui lòng dán link TikTok');
      return;
    }
    if (!url.match(/^https?:\/\/(www\.|vt\.|vm\.)?tiktok\.com/i)) {
      toast.error('URL phải là link TikTok (tiktok.com, vt.tiktok.com, vm.tiktok.com)');
      return;
    }

    setTiktokImporting(true);
    setTiktokImportStage('Đang tải video từ TikTok...');
    let videoUploaded = false;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Chưa đăng nhập');

      // Step 1: Download the TikTok video server-side + upload to Supabase.
      // The server returns the public URL of the uploaded video.
      setTiktokImportStage('Đang tải video từ TikTok (yt-dlp + scraper)...');
      const importResponse = await fetch('/api/import-tiktok', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, movieId, userId: user.id }),
      });

      const importResult = await importResponse.json();
      if (!importResponse.ok || !importResult.success) {
        throw new Error(importResult.error || 'Tải video TikTok thất bại');
      }

      videoUploaded = true;
      setTiktokImportStage('Đã tải video. Đang trích xuất SRT...');

      // Step 2: Update the movie record with the new video URL.
      // (The import-tiktok route already uploads to Supabase, but we still
      // need to update the movies table — the route doesn't do this so it
      // can stay stateless and reusable.)
      const { error: updateError } = await supabase
        .from('movies')
        .update({ video_url: importResult.videoUrl, status: 'draft' })
        .eq('id', movieId);
      if (updateError) throw updateError;

      // Step 3: Trigger SRT extraction (same flow as file upload).
      setTiktokImportStage('Đang nhận diện giọng nói thành SRT (CapCut API)...');
      const extractResponse = await fetch('/api/extract-srt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          movieId,
          movieTitle,
          originalFileName: importResult.filename || 'tiktok-video.mp4',
          videoUrl: importResult.videoUrl,
        }),
      });

      const extractResult = await extractResponse.json();
      if (!extractResponse.ok || !extractResult.success) {
        throw new Error(extractResult.error || 'Tạo SRT thất bại');
      }

      // Step 4: Save the extracted SRT to the movie record.
      const { error: srtUpdateError } = await supabase
        .from('movies')
        .update({ original_srt: extractResult.srt })
        .eq('id', movieId);
      if (srtUpdateError) throw srtUpdateError;

      toast.success(
        `Đã tải video TikTok và tạo SRT${importResult.title ? `: "${importResult.title.slice(0, 50)}"` : ''}`
      );
      setTiktokUrl('');
      fetchMovie();
      setActiveTab('original-srt');
    } catch (error: any) {
      const msg = error.message || 'Lỗi không xác định';
      if (videoUploaded) {
        // Video was downloaded + uploaded to Supabase, but SRT extraction failed.
        // Don't lose the video — show a partial-success toast and switch to SRT tab.
        toast.error(`Video đã tải lên nhưng tạo SRT thất bại: ${msg}`);
        fetchMovie();
        setActiveTab('original-srt');
      } else {
        // Download itself failed — most likely TikTok blocked the URL or
        // the video is private/deleted. Show the full error.
        toast.error(msg, { duration: 8000 });
      }
    } finally {
      setTiktokImporting(false);
      setTiktokImportStage('');
    }
  };

  const startTranslation = async () => {
    if (!movie?.video_url) {
      toast.error('Vui lòng tải lên video trước');
      return;
    }
    if (!apiKeys.gemini) {
      toast.error('Vui lòng thêm Gemini API key trong tab API Keys');
      return;
    }
    setProcessing(true);
    try {
      // Create a new job
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Chưa đăng nhập');

      const { data: jobData, error: jobError } = await supabase
        .from('translation_jobs')
        .insert({
          movie_id: movieId,
          user_id: user.id,
          status: 'pending',
          progress: 0,
          current_step: 'Đang khởi tạo',
        })
        .select()
        .single();
      if (jobError) throw jobError;

      setJob(jobData);

      // Update movie status
      await supabase
        .from('movies')
        .update({ status: 'translating' })
        .eq('id', movieId);

      // Trigger the translation service via Socket.io.
      // If the socket is up, emit directly. If not, queue the payload and let
      // the service's startup recovery (or our reconnect handler) pick it up.
      const startPayload = {
        movieId,
        jobId: jobData.id,
        videoUrl: movie.video_url,
        userId: user.id,
        apiKeys,
        ttsVoice: movie.tts_voice || 'vi_vn_1',
        movieTitle: movie.title,
        episode: movie.episode || '',
        channelName: movieTitle,
      };
      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit('start-translation', startPayload, (response: any) => {
          if (response.status === 'accepted') {
            toast.success('Đã bắt đầu quá trình dịch phim');
          } else {
            toast.error(response.error || 'Không thể bắt đầu dịch');
            setProcessing(false);
          }
        });
      } else {
        // Queue payload; it will be re-emitted on socket 'connect',
        // and the service's startup recovery will also pick it up
        // if the service was down and is now starting.
        pendingStartRef.current = startPayload;
        toast.warning(
          'Server dịch chưa sẵn sàng. Job đã lưu, sẽ tự chạy khi server online.'
        );
        if (socketRef.current) {
          socketRef.current.connect();
        }
      }
    } catch (error: any) {
      setProcessing(false);
      toast.error(error.message || 'Có lỗi xảy ra');
    }
  };

  const saveVietnameseSrt = async () => {
    try {
      const { error } = await supabase
        .from('movies')
        .update({ vietnamese_srt: editedVietnameseSrt })
        .eq('id', movieId);
      if (error) throw error;
      toast.success('Đã lưu SRT tiếng Việt');
    } catch (error: any) {
      toast.error(error.message || 'Lưu thất bại');
    }
  };

  const saveDescription = async () => {
    try {
      const { error } = await supabase
        .from('movies')
        .update({ ai_description: editedDescription })
        .eq('id', movieId);
      if (error) throw error;
      toast.success('Đã lưu mô tả');
    } catch (error: any) {
      toast.error(error.message || 'Lưu thất bại');
    }
  };

  const regenerateDescription = async () => {
    if (!apiKeys.gemini) {
      toast.error('Cần Gemini API key');
      return;
    }
    if (!movie?.vietnamese_srt) {
      toast.error('Cần SRT tiếng Việt trước');
      return;
    }
    if (!socketRef.current?.connected) {
      toast.error('Không có kết nối tới server dịch');
      return;
    }
    setProcessing(true);
    try {
      socketRef.current.emit('generate-description', {
        movieId,
        srt: movie.vietnamese_srt,
        movieTitle: movie.title,
        episode: movie.episode || '',
        apiKey: apiKeys.gemini,
      }, (response: any) => {
        if (response.success) {
          setEditedDescription(response.description);
          toast.success('Đã tạo mô tả mới');
        } else {
          toast.error(response.error || 'Tạo mô tả thất bại');
        }
        setProcessing(false);
      });
    } catch (error: any) {
      setProcessing(false);
      toast.error(error.message || 'Tạo mô tả thất bại');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Đã sao chép vào clipboard');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  if (!movie) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <AlertCircle className="w-8 h-8 mb-2" />
        <p>Không tìm thấy phim</p>
      </div>
    );
  }

  const currentStatus = job?.status;
  const progressInfo = currentStatus ? JOB_STATUS_LABELS[currentStatus] : null;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{movie.title}</h1>
          {movie.episode && (
            <p className="text-sm text-slate-400 mt-1">Tập {movie.episode}</p>
          )}
        </div>
        {movie.video_url && (
          <Button
            onClick={startTranslation}
            disabled={processing}
            className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
          >
            {processing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Đang xử lý...
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4 mr-2" />
                {movie.status === 'completed' ? 'Dịch lại' : 'Bắt đầu dịch phim'}
              </>
            )}
          </Button>
        )}
      </div>

      {/* Progress Bar */}
      {(processing || (currentStatus && currentStatus !== 'completed' && currentStatus !== 'failed')) && (
        <Card className="border-slate-800 bg-slate-900/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {currentStatus === 'failed' ? (
                  <AlertCircle className="w-4 h-4 text-red-500" />
                ) : currentStatus === 'completed' ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : (
                  <Loader2 className="w-4 h-4 animate-spin text-rose-400" />
                )}
                <span className="text-sm font-medium text-white">
                  {progressInfo?.label || job?.current_step || 'Đang xử lý'}
                </span>
              </div>
              <span className="text-sm text-slate-400">
                {job?.progress || 0}%
              </span>
            </div>
            <Progress
              value={job?.progress || 0}
              className="h-2 bg-slate-800"
            />
            {job?.current_step && (
              <p className="text-xs text-slate-500 mt-2">{job.current_step}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Video Preview - Always visible at top if video exists */}
      {movie.video_url && (
        <Card className="border-slate-800 bg-slate-900/50 overflow-hidden">
          <CardContent className="p-0">
            <div className="aspect-video bg-black">
              <video
                src={movie.dubbed_video_url || movie.video_url}
                controls
                className="w-full h-full"
                poster={movie.thumbnail_url || undefined}
              />
            </div>
            <div className="p-3 flex items-center justify-between bg-slate-900/80 border-t border-slate-800">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Video className="w-4 h-4" />
                <span>{movie.dubbed_video_url ? 'Video lồng tiếng' : 'Video gốc'}</span>
              </div>
              <div className="flex items-center gap-2">
                {movie.dubbed_video_url && (
                  <>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={movie.dubbed_video_url} download className="text-slate-300 hover:text-white">
                        <Download className="w-3 h-3 mr-1" />
                        Tải video
                      </a>
                    </Button>
                  </>
                )}
                {movie.vietnamese_srt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => copyToClipboard(movie.vietnamese_srt!)}
                    className="text-slate-300 hover:text-white"
                  >
                    <Copy className="w-3 h-3 mr-1" />
                    Sao chép SRT
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3 sm:grid-cols-6 bg-slate-900/50 h-auto">
          <TabTrigger
            value="upload"
            icon={Upload}
            label="Upload"
            disabled={false}
          />
          <TabTrigger
            value="original-srt"
            icon={FileText}
            label="SRT Gốc"
            disabled={!movie.video_url}
          />
          <TabTrigger
            value="vietnamese-srt"
            icon={Languages}
            label="SRT Việt"
            disabled={!movie.original_srt}
          />
          <TabTrigger
            value="dubbed-video"
            icon={Volume2}
            label="Lồng Tiếng"
            disabled={!movie.vietnamese_srt}
          />
          <TabTrigger
            value="description"
            icon={Sparkles}
            label="Mô Tả"
            disabled={!movie.vietnamese_srt}
          />
          <TabTrigger
            value="info"
            icon={Film}
            label="Thông tin"
            disabled={false}
          />
        </TabsList>

        {/* Upload Tab */}
        <TabsContent value="upload" className="mt-4">
          <Card className="border-slate-800 bg-slate-900/50">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Upload className="w-5 h-5 text-rose-400" />
                Tải lên video
              </CardTitle>
              <CardDescription className="text-slate-400">
                Tải lên video từ máy hoặc dán link TikTok để tự động tải về
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!movie.video_url ? (
                <div className="space-y-4">
                  {/* File upload (drag-drop + click) */}
                  <div
                    className="border-2 border-dashed border-slate-700 rounded-lg p-8 text-center hover:border-rose-500/50 transition-colors cursor-pointer"
                    onClick={() => document.getElementById('video-input')?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.add('border-rose-500', 'bg-rose-500/5');
                    }}
                    onDragLeave={(e) => {
                      e.currentTarget.classList.remove('border-rose-500', 'bg-rose-500/5');
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove('border-rose-500', 'bg-rose-500/5');
                      const file = e.dataTransfer.files[0];
                      if (file) handleVideoUpload(file);
                    }}
                  >
                    {videoUploading ? (
                      <>
                        <Loader2 className="w-12 h-12 mx-auto mb-3 text-rose-400 animate-spin" />
                        <p className="text-white font-medium">Đang tải lên...</p>
                        <p className="text-xs text-slate-500 mt-1">Vui lòng đợi</p>
                      </>
                    ) : (
                      <>
                        <Video className="w-12 h-12 mx-auto mb-3 text-slate-600" />
                        <p className="text-white font-medium mb-1">
                          Kéo thả video hoặc click để chọn
                        </p>
                        <p className="text-xs text-slate-500">
                          MP4, WebM, MOV - Tối đa 500MB
                        </p>
                      </>
                    )}
                    <input
                      id="video-input"
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleVideoUpload(file);
                      }}
                    />
                  </div>

                  {/* OR divider */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-slate-700" />
                    <span className="text-xs text-slate-500 uppercase tracking-wider">Hoặc</span>
                    <div className="flex-1 h-px bg-slate-700" />
                  </div>

                  {/* TikTok URL import */}
                  <div className="border border-slate-700 rounded-lg p-4 bg-slate-800/30">
                    <div className="flex items-center gap-2 mb-3">
                      <LinkIcon className="w-4 h-4 text-rose-400" />
                      <p className="text-sm text-white font-medium">Tải video từ link TikTok</p>
                    </div>
                    <p className="text-xs text-slate-400 mb-3">
                      Dán link TikTok (vt.tiktok.com/..., www.tiktok.com/@user/video/...) —
                      server sẽ tự tải video, lưu vào storage, và trích xuất SRT.
                    </p>
                    {tiktokImporting ? (
                      <div className="flex items-center gap-3 p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg">
                        <Loader2 className="w-5 h-5 text-rose-400 animate-spin flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white font-medium truncate">
                            {tiktokImportStage || 'Đang xử lý...'}
                          </p>
                          <p className="text-xs text-slate-400 mt-0.5">
                            Có thể mất 30-120 giây tùy độ dài video
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="url"
                          value={tiktokUrl}
                          onChange={(e) => setTiktokUrl(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && tiktokUrl.trim()) {
                              e.preventDefault();
                              handleTiktokImport();
                            }
                          }}
                          placeholder="https://vt.tiktok.com/ZS42guBnS/"
                          className="flex-1 px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-md text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500"
                          disabled={tiktokImporting || videoUploading}
                        />
                        <Button
                          onClick={handleTiktokImport}
                          disabled={!tiktokUrl.trim() || tiktokImporting || videoUploading}
                          className="bg-rose-600 hover:bg-rose-700 text-white"
                        >
                          <LinkIcon className="w-4 h-4 mr-1" />
                          Tải video
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                    <div className="flex-1">
                      <p className="text-sm text-white font-medium">Đã tải lên video</p>
                      <p className="text-xs text-slate-400">Sẵn sàng để bắt đầu dịch</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => document.getElementById('video-input-replace')?.click()}
                      className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Đổi video
                    </Button>
                    <input
                      id="video-input-replace"
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleVideoUpload(file);
                      }}
                    />
                  </div>
                  {!apiKeys.gemini && (
                    <div className="flex items-center gap-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                      <AlertCircle className="w-5 h-5 text-yellow-500" />
                      <div className="flex-1">
                        <p className="text-sm text-white font-medium">Chưa có Gemini API key</p>
                        <p className="text-xs text-slate-400">
                          Vui lòng thêm API key trong tab API Keys để dịch phim
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Original SRT Tab */}
        <TabsContent value="original-srt" className="mt-4">
          <Card className="border-slate-800 bg-slate-900/50">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <FileText className="w-5 h-5 text-blue-400" />
                Phụ đề gốc (SRT)
              </CardTitle>
              <CardDescription className="text-slate-400">
                Phụ đề được trích xuất tự động từ video bằng CapCut API
              </CardDescription>
            </CardHeader>
            <CardContent>
              {movie.original_srt ? (
                <Textarea
                  readOnly
                  value={movie.original_srt}
                  className="font-mono text-xs bg-slate-950 border-slate-700 text-slate-300 min-h-[400px]"
                />
              ) : (
                <div className="text-center py-12 text-slate-500">
                  <FileText className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    {processing
                      ? 'Đang trích xuất phụ đề từ video...'
                      : 'Chưa có phụ đề. Bấm "Bắt đầu dịch phim" để trích xuất.'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Vietnamese SRT Tab */}
        <TabsContent value="vietnamese-srt" className="mt-4">
          <Card className="border-slate-800 bg-slate-900/50">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-white flex items-center gap-2">
                    <Languages className="w-5 h-5 text-rose-400" />
                    Phụ đề tiếng Việt
                  </CardTitle>
                  <CardDescription className="text-slate-400">
                    Dịch tự động bằng Gemini 3.1 Flash Lite Preview - có thể chỉnh sửa
                  </CardDescription>
                </div>
                {movie.vietnamese_srt && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copyToClipboard(editedVietnameseSrt)}
                      className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
                    >
                      <Copy className="w-3 h-3 mr-1" />
                      Sao chép
                    </Button>
                    <Button
                      size="sm"
                      onClick={saveVietnameseSrt}
                      className="bg-rose-500 hover:bg-rose-600"
                    >
                      Lưu
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {movie.vietnamese_srt || editedVietnameseSrt ? (
                <Textarea
                  value={editedVietnameseSrt}
                  onChange={(e) => setEditedVietnameseSrt(e.target.value)}
                  className="font-mono text-xs bg-slate-950 border-slate-700 text-slate-300 min-h-[400px]"
                />
              ) : (
                <div className="text-center py-12 text-slate-500">
                  <Languages className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    {processing
                      ? 'Đang dịch phụ đề sang tiếng Việt...'
                      : 'Chưa có phụ đề tiếng Việt. Bấm "Bắt đầu dịch phim" để dịch.'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Dubbed Video Tab */}
        <TabsContent value="dubbed-video" className="mt-4">
          <Card className="border-slate-800 bg-slate-900/50">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Volume2 className="w-5 h-5 text-purple-400" />
                Video lồng tiếng
              </CardTitle>
              <CardDescription className="text-slate-400">
                Video đã được lồng tiếng tiếng Việt bằng TikTok TTS
              </CardDescription>
            </CardHeader>
            <CardContent>
              {movie.dubbed_video_url ? (
                <div className="space-y-3">
                  <div className="aspect-video bg-black rounded-lg overflow-hidden">
                    <video
                      src={movie.dubbed_video_url}
                      controls
                      className="w-full h-full"
                      poster={movie.thumbnail_url || undefined}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button asChild variant="outline" className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700">
                      <a href={movie.dubbed_video_url} download>
                        <Download className="w-4 h-4 mr-2" />
                        Tải video xuống
                      </a>
                    </Button>
                    <Button variant="outline" className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700">
                      <Play className="w-4 h-4 mr-2" />
                      Xem toàn màn hình
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 text-slate-500">
                  <Volume2 className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    {processing
                      ? 'Đang tạo âm thanh lồng tiếng và ghép vào video...'
                      : 'Chưa có video lồng tiếng. Bấm "Bắt đầu dịch phim" để tạo.'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Description Tab */}
        <TabsContent value="description" className="mt-4">
          <Card className="border-slate-800 bg-slate-900/50">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-white flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-amber-400" />
                    Mô tả phim (AI)
                  </CardTitle>
                  <CardDescription className="text-slate-400">
                    Tạo tự động từ SRT bằng Gemini AI - có thể chỉnh sửa
                  </CardDescription>
                </div>
                {movie.ai_description && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={regenerateDescription}
                      disabled={processing}
                      className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Tạo lại
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copyToClipboard(editedDescription)}
                      className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
                    >
                      <Copy className="w-3 h-3 mr-1" />
                      Sao chép
                    </Button>
                    <Button
                      size="sm"
                      onClick={saveDescription}
                      className="bg-amber-500 hover:bg-amber-600 text-white"
                    >
                      Lưu
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {movie.ai_description || editedDescription ? (
                <Textarea
                  value={editedDescription}
                  onChange={(e) => setEditedDescription(e.target.value)}
                  className="bg-slate-950 border-slate-700 text-slate-300 min-h-[500px]"
                />
              ) : (
                <div className="text-center py-12 text-slate-500">
                  <Sparkles className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    {processing
                      ? 'Đang tạo mô tả phim bằng AI...'
                      : 'Chưa có mô tả. Bấm "Bắt đầu dịch phim" để tạo.'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Info Tab */}
        <TabsContent value="info" className="mt-4">
          <Card className="border-slate-800 bg-slate-900/50">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Film className="w-5 h-5 text-slate-400" />
                Thông tin phim
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <InfoRow label="Tên phim" value={movie.title} />
              <InfoRow label="Tập" value={movie.episode || '—'} />
              <InfoRow label="Trạng thái" value={movie.status} />
              <InfoRow label="Giọng TTS" value={movie.tts_voice || 'vi_vn_1'} />
              <InfoRow
                label="Ngày tạo"
                value={new Date(movie.created_at).toLocaleString('vi-VN')}
              />
              <InfoRow
                label="Cập nhật"
                value={new Date(movie.updated_at).toLocaleString('vi-VN')}
              />
              <InfoRow
                label="Có video gốc"
                value={movie.video_url ? 'Có' : 'Chưa'}
              />
              <InfoRow
                label="Có SRT gốc"
                value={movie.original_srt ? 'Có' : 'Chưa'}
              />
              <InfoRow
                label="Có SRT Việt"
                value={movie.vietnamese_srt ? 'Có' : 'Chưa'}
              />
              <InfoRow
                label="Có video lồng tiếng"
                value={movie.dubbed_video_url ? 'Có' : 'Chưa'}
              />
              <InfoRow
                label="Có mô tả AI"
                value={movie.ai_description ? 'Có' : 'Chưa'}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TabTrigger({
  value,
  icon: Icon,
  label,
  disabled,
}: {
  value: string;
  icon: React.ElementType;
  label: string;
  disabled: boolean;
}) {
  return (
    <TabsTrigger
      value={value}
      disabled={disabled}
      className="flex flex-col items-center gap-1 py-2 data-[state=active]:bg-rose-500/20 data-[state=active]:text-rose-300"
    >
      <Icon className="w-4 h-4" />
      <span className="text-xs">{label}</span>
    </TabsTrigger>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-sm text-white font-medium">{value}</span>
    </div>
  );
}
