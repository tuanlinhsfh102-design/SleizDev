// Shared types for translation service
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
