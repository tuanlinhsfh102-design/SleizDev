// TypeScript types for the application

export interface Channel {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Movie {
  id: string;
  channel_id: string;
  title: string;
  episode: string | null;
  description: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  status: 'draft' | 'translating' | 'completed' | 'failed';
  original_srt: string | null;
  vietnamese_srt: string | null;
  dubbed_video_url: string | null;
  ai_description: string | null;
  tts_voice: string | null;
  /** TTS speech rate multiplier (e.g. "1.0" = normal, "0.9" = slower, "1.2" = faster). Default "1.0". */
  tts_rate: string | null;
  /** TTS audio volume in final mix (0.0 = silent, 1.0 = full, 1.5 = boosted). Default 1.0. */
  tts_volume: number | null;
  /** Original audio (background) volume in final mix (0.0 = muted, 0.03 = 3% ambience, 0.1 = 10%). Default 0.03. */
  bgm_volume: number | null;
  /** Optional logo image URL (PNG with transparency). If set, the logo is overlaid in the top-left corner of the dubbed video. */
  logo_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  provider: 'gemini' | 'capcut' | 'tiktok';
  key_value: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type JobStatus =
  | 'pending'
  | 'extracting_audio'
  | 'generating_srt'
  | 'translating'
  | 'generating_tts'
  | 'dubbing'
  | 'generating_description'
  | 'completed'
  | 'failed';

export interface TranslationJob {
  id: string;
  movie_id: string;
  user_id: string;
  status: JobStatus;
  progress: number;
  current_step: string | null;
  error: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface SrtEntry {
  index: number;
  start: string;
  end: string;
  text: string;
}

export interface SrtFile {
  entries: SrtEntry[];
}

export const TTS_VOICES = [
  { id: 'vi_vn_1', name: 'Việt Nam - Nữ 1 (Google TTS)' },
  { id: 'vi_vn_2', name: 'Việt Nam - Nam 1 (Google TTS)' },
  { id: 'vi_male', name: 'TikTok - Nam' },
  { id: 'vi_female', name: 'TikTok - Nữ' },
  { id: 'vi_female_sweet', name: 'TikTok - Nữ Ngọt Ngào' },
] as const;

export const JOB_STATUS_LABELS: Record<JobStatus, { label: string; color: string; progress: number }> = {
  pending: { label: 'Đang chờ', color: 'bg-gray-500', progress: 5 },
  extracting_audio: { label: 'Đang trích xuất âm thanh', color: 'bg-blue-500', progress: 15 },
  generating_srt: { label: 'Đang tạo SRT', color: 'bg-blue-500', progress: 30 },
  translating: { label: 'Đang dịch sang tiếng Việt', color: 'bg-yellow-500', progress: 50 },
  generating_tts: { label: 'Đang tạo âm thanh lồng tiếng', color: 'bg-purple-500', progress: 70 },
  dubbing: { label: 'Đang lồng tiếng vào video', color: 'bg-purple-500', progress: 85 },
  generating_description: { label: 'Đang tạo mô tả phim', color: 'bg-indigo-500', progress: 95 },
  completed: { label: 'Hoàn thành', color: 'bg-green-500', progress: 100 },
  failed: { label: 'Lỗi', color: 'bg-red-500', progress: 0 },
};
