'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Movie, TTS_VOICES } from '@/types';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AspectRatio } from '@/components/ui/aspect-ratio';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Gauge,
  ImagePlus,
  Loader2,
  Music,
  RefreshCw,
  Trash2,
  Volume2,
} from 'lucide-react';

interface MovieEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  movie?: Movie | null;
  onSaved?: (movie: Movie) => void | Promise<void>;
}

interface MovieFormData {
  title: string;
  episode: string;
  description: string;
  thumbnail_url: string;
  tts_voice: string;
  tts_rate: string;
  tts_volume: number;
  bgm_volume: number;
  logo_url: string | null;
}

const DEFAULT_FORM_DATA: MovieFormData = {
  title: '',
  episode: '',
  description: '',
  thumbnail_url: '',
  tts_voice: 'vi_vn_1',
  tts_rate: '1.0',
  tts_volume: 1.0,
  bgm_volume: 0.03,
  logo_url: null,
};

export function MovieEditorDialog({
  open,
  onOpenChange,
  channelId,
  movie,
  onSaved,
}: MovieEditorDialogProps) {
  const isEditing = !!movie;
  const supabase = createClient();
  const [formData, setFormData] = useState<MovieFormData>(DEFAULT_FORM_DATA);
  const [submitting, setSubmitting] = useState(false);
  const [thumbnailUploading, setThumbnailUploading] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);

  useEffect(() => {
    if (!open) return;

    const nextFormData = movie
      ? {
        title: movie.title,
        episode: movie.episode || '',
        description: movie.description || '',
        thumbnail_url: movie.thumbnail_url || '',
        tts_voice: movie.tts_voice || 'vi_vn_1',
        tts_rate: movie.tts_rate || '1.0',
        tts_volume: movie.tts_volume ?? 1.0,
        bgm_volume: movie.bgm_volume ?? 0.03,
        logo_url: movie.logo_url || null,
      }
      : DEFAULT_FORM_DATA;

    const timer = window.setTimeout(() => {
      setFormData(nextFormData);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [open, movie]);

  const handleThumbnailUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Vui lòng chọn file ảnh');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Kích thước ảnh không được vượt quá 5MB');
      return;
    }

    setThumbnailUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Chưa đăng nhập');

      const ext = file.name.split('.').pop();
      const fileName = `${user.id}/${channelId}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from('thumbnails')
        .upload(fileName, file, { upsert: true });
      if (error) throw error;

      const { data: urlData } = supabase.storage
        .from('thumbnails')
        .getPublicUrl(fileName);

      setFormData((prev) => ({ ...prev, thumbnail_url: urlData.publicUrl }));
      toast.success('Tải ảnh lên thành công');
    } catch (error: any) {
      toast.error(error.message || 'Tải ảnh thất bại');
    } finally {
      setThumbnailUploading(false);
    }
  };

  const handleLogoUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Vui lòng chọn file ảnh (PNG khuyến nghị)');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Kích thước logo không được vượt quá 5MB');
      return;
    }

    setLogoUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Chưa đăng nhập');

      const ext = file.name.split('.').pop();
      const fileName = `${user.id}/${channelId}/logo-${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from('thumbnails')
        .upload(fileName, file, { upsert: true });
      if (error) throw error;

      const { data: urlData } = supabase.storage
        .from('thumbnails')
        .getPublicUrl(fileName);

      setFormData((prev) => ({ ...prev, logo_url: urlData.publicUrl }));
      toast.success('Tải logo lên thành công');
    } catch (error: any) {
      toast.error(error.message || 'Tải logo thất bại');
    } finally {
      setLogoUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) {
      toast.error('Vui lòng nhập tên phim');
      return;
    }

    setSubmitting(true);
    try {
      let savedMovie: Movie | null = null;

      if (movie) {
        const { data, error } = await supabase
          .from('movies')
          .update({
            title: formData.title,
            episode: formData.episode,
            description: formData.description,
            thumbnail_url: formData.thumbnail_url,
            tts_voice: formData.tts_voice,
            tts_rate: formData.tts_rate,
            tts_volume: formData.tts_volume,
            bgm_volume: formData.bgm_volume,
            logo_url: formData.logo_url || null,
          })
          .eq('id', movie.id)
          .select('*')
          .single();
        if (error) throw error;
        savedMovie = data;
        toast.success('Cập nhật phim thành công!');
      } else {
        const { data, error } = await supabase
          .from('movies')
          .insert({
            title: formData.title,
            episode: formData.episode,
            description: formData.description,
            thumbnail_url: formData.thumbnail_url,
            tts_voice: formData.tts_voice,
            tts_rate: formData.tts_rate,
            tts_volume: formData.tts_volume,
            bgm_volume: formData.bgm_volume,
            logo_url: formData.logo_url || null,
            channel_id: channelId,
            status: 'draft',
          })
          .select('*')
          .single();
        if (error) throw error;
        savedMovie = data;
        toast.success('Tạo phim thành công!');
      }

      onOpenChange(false);
      if (savedMovie) {
        await onSaved?.(savedMovie);
      }
    } catch (error: any) {
      toast.error(error.message || 'Có lỗi xảy ra');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Chỉnh sửa phim' : 'Tạo bộ phim mới'}</DialogTitle>
          <DialogDescription className="text-slate-400">
            {isEditing
              ? 'Cập nhật thông tin, thumbnail và cấu hình lồng tiếng của phim.'
              : 'Chỉ cần nhập tên phim và tải thumbnail trước. Các phần khác chỉnh sau khi bấm vào phim.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label className="text-slate-200">Thumbnail (16:9)</Label>
            <div className="relative">
              <AspectRatio ratio={16 / 9} className="bg-slate-800 rounded-lg overflow-hidden border border-slate-700 border-dashed">
                {formData.thumbnail_url ? (
                  <>
                    <img
                      src={formData.thumbnail_url}
                      alt="Thumbnail"
                      className="w-full h-full object-cover"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="absolute top-2 right-2 bg-slate-900/80 hover:bg-slate-900"
                      onClick={() => document.getElementById('thumbnail-input')?.click()}
                    >
                      Đổi ảnh
                    </Button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => document.getElementById('thumbnail-input')?.click()}
                    className="w-full h-full flex flex-col items-center justify-center text-slate-500 hover:text-slate-300 transition-colors"
                    disabled={thumbnailUploading}
                  >
                    {thumbnailUploading ? (
                      <Loader2 className="w-6 h-6 animate-spin mb-2" />
                    ) : (
                      <ImagePlus className="w-8 h-8 mb-2" />
                    )}
                    <span className="text-xs">
                      {thumbnailUploading ? 'Đang tải...' : 'Click để tải lên (16:9)'}
                    </span>
                  </button>
                )}
              </AspectRatio>
              <input
                id="thumbnail-input"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleThumbnailUpload(file);
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className={isEditing ? 'col-span-2 space-y-2' : 'col-span-3 space-y-2'}>
              <Label htmlFor="movie-title" className="text-slate-200">
                Tên phim <span className="text-red-400">*</span>
              </Label>
              <Input
                id="movie-title"
                placeholder="VD: Vua Đồng Nát"
                value={formData.title}
                onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                className="bg-slate-800 border-slate-700 text-white"
                required
              />
            </div>
          </div>

          {isEditing && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="movie-episode" className="text-slate-200">Tập</Label>
                  <Input
                    id="movie-episode"
                    placeholder="VD: 1224"
                    value={formData.episode}
                    onChange={(e) => setFormData((prev) => ({ ...prev, episode: e.target.value }))}
                    className="bg-slate-800 border-slate-700 text-white"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="movie-description" className="text-slate-200">Mô tả</Label>
                <Textarea
                  id="movie-description"
                  placeholder="Mô tả ngắn về tập phim..."
                  value={formData.description}
                  onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                  className="bg-slate-800 border-slate-700 text-white min-h-[60px]"
                />
              </div>

              <div className="space-y-3 p-3 bg-slate-800/50 rounded-lg border border-slate-700">
                <div className="flex items-center gap-2 text-sm text-slate-200 font-medium">
                  <Volume2 className="w-4 h-4 text-rose-400" />
                  Cài đặt âm thanh lồng tiếng
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-400">Giọng đọc</Label>
                  <Select
                    value={formData.tts_voice}
                    onValueChange={(value) => setFormData((prev) => ({ ...prev, tts_voice: value }))}
                  >
                    <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                      <SelectValue placeholder="Chọn giọng đọc" />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-700 text-white">
                      {TTS_VOICES.map((voice) => (
                        <SelectItem key={voice.id} value={voice.id}>
                          {voice.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-slate-400 flex items-center gap-1">
                      <Gauge className="w-3 h-3" />
                      Tốc độ giọng đọc
                    </Label>
                    <span className="text-xs text-white font-mono">
                      {parseFloat(formData.tts_rate).toFixed(1)}x
                    </span>
                  </div>
                  <Slider
                    value={[parseFloat(formData.tts_rate)]}
                    onValueChange={(value) => setFormData((prev) => ({ ...prev, tts_rate: value[0].toFixed(2) }))}
                    min={0.5}
                    max={2.0}
                    step={0.1}
                    className="w-full"
                  />
                  <div className="flex justify-between text-[10px] text-slate-500">
                    <span>0.5x (chậm)</span>
                    <span>1.0x (bình thường)</span>
                    <span>2.0x (nhanh)</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-slate-400 flex items-center gap-1">
                      <Volume2 className="w-3 h-3" />
                      Âm lượng giọng đọc Việt
                    </Label>
                    <span className="text-xs text-white font-mono">
                      {Math.round(formData.tts_volume * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[formData.tts_volume]}
                    onValueChange={(value) => setFormData((prev) => ({ ...prev, tts_volume: value[0] }))}
                    min={0}
                    max={1.5}
                    step={0.05}
                    className="w-full"
                  />
                  <div className="flex justify-between text-[10px] text-slate-500">
                    <span>0% (tắt)</span>
                    <span>100% (mặc định)</span>
                    <span>150% (to)</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-slate-400 flex items-center gap-1">
                      <Music className="w-3 h-3" />
                      Âm lượng âm thanh gốc (nền)
                    </Label>
                    <span className="text-xs text-white font-mono">
                      {Math.round(formData.bgm_volume * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[formData.bgm_volume]}
                    onValueChange={(value) => setFormData((prev) => ({ ...prev, bgm_volume: value[0] }))}
                    min={0}
                    max={0.5}
                    step={0.01}
                    className="w-full"
                  />
                  <div className="flex justify-between text-[10px] text-slate-500">
                    <span>0% (tắt hẳn)</span>
                    <span>3% (nền nhẹ - mặc định)</span>
                    <span>50% (to)</span>
                  </div>
                </div>
              </div>

              <div className="space-y-3 p-3 bg-slate-800/50 rounded-lg border border-slate-700">
                <div className="flex items-center gap-2 text-sm text-slate-200 font-medium">
                  <ImagePlus className="w-4 h-4 text-rose-400" />
                  Logo (tùy chọn)
                </div>
                <p className="text-xs text-slate-400">
                  Tải logo PNG (nền trong suốt) để chèn ở góc trên bên trái video lồng tiếng.
                </p>

                {formData.logo_url ? (
                  <div className="flex items-center gap-3">
                    <div className="w-24 h-12 bg-slate-900 border border-slate-700 rounded flex items-center justify-center overflow-hidden">
                      <img
                        src={formData.logo_url}
                        alt="Logo preview"
                        className="max-w-full max-h-full object-contain"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => document.getElementById('logo-input-replace')?.click()}
                        disabled={logoUploading}
                        className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
                      >
                        {logoUploading ? (
                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3 h-3 mr-1" />
                        )}
                        Đổi logo
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setFormData((prev) => ({ ...prev, logo_url: null }))}
                        disabled={logoUploading}
                        className="bg-slate-800 border-slate-700 text-red-400 hover:bg-slate-700"
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Xóa logo
                      </Button>
                    </div>
                    <input
                      id="logo-input-replace"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleLogoUpload(file);
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className="border-2 border-dashed border-slate-700 rounded-lg p-4 text-center hover:border-rose-500/50 transition-colors cursor-pointer"
                    onClick={() => document.getElementById('logo-input')?.click()}
                  >
                    {logoUploading ? (
                      <>
                        <Loader2 className="w-6 h-6 mx-auto mb-1 text-rose-400 animate-spin" />
                        <p className="text-xs text-slate-400">Đang tải...</p>
                      </>
                    ) : (
                      <>
                        <ImagePlus className="w-6 h-6 mx-auto mb-1 text-slate-600" />
                        <p className="text-xs text-slate-400">Click để chọn logo (PNG khuyến nghị)</p>
                      </>
                    )}
                    <input
                      id="logo-input"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleLogoUpload(file);
                      }}
                    />
                  </div>
                )}
              </div>
            </>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
            >
              Hủy
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : isEditing ? (
                'Lưu thay đổi'
              ) : (
                'Tạo phim'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
