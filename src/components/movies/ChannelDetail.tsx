'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Plus,
  Film,
  MoreVertical,
  Pencil,
  Trash2,
  Loader2,
  Search,
  ImagePlus,
  Play,
  CheckCircle2,
  Clock,
  AlertCircle,
} from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { Movie } from '@/types';
import { toast } from 'sonner';
import { AspectRatio } from '@/components/ui/aspect-ratio';

interface ChannelDetailProps {
  channelId: string;
  channelName: string;
}

export function ChannelDetail({ channelId, channelName }: ChannelDetailProps) {
  const supabase = createClient();
  const { setView } = useAppStore();
  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMovie, setEditingMovie] = useState<Movie | null>(null);
  const [deleteMovie, setDeleteMovie] = useState<Movie | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [thumbnailUploading, setThumbnailUploading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    episode: '',
    description: '',
    thumbnail_url: '',
    tts_voice: 'vi_vn_1',
  });

  const fetchMovies = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('movies')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false });
    if (error) {
      toast.error('Không thể tải danh sách phim: ' + error.message);
    } else {
      setMovies(data || []);
    }
    setLoading(false);
  }, [supabase, channelId]);

  useEffect(() => {
    fetchMovies();
  }, [fetchMovies]);

  const handleOpenCreate = () => {
    setEditingMovie(null);
    setFormData({ title: '', episode: '', description: '', thumbnail_url: '', tts_voice: 'vi_vn_1' });
    setDialogOpen(true);
  };

  const handleOpenEdit = (movie: Movie) => {
    setEditingMovie(movie);
    setFormData({
      title: movie.title,
      episode: movie.episode || '',
      description: movie.description || '',
      thumbnail_url: movie.thumbnail_url || '',
      tts_voice: movie.tts_voice || 'vi_vn_1',
    });
    setDialogOpen(true);
  };

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) {
      toast.error('Vui lòng nhập tên phim');
      return;
    }
    setSubmitting(true);
    try {
      if (editingMovie) {
        const { error } = await supabase
          .from('movies')
          .update({
            title: formData.title,
            episode: formData.episode,
            description: formData.description,
            thumbnail_url: formData.thumbnail_url,
            tts_voice: formData.tts_voice,
          })
          .eq('id', editingMovie.id);
        if (error) throw error;
        toast.success('Cập nhật phim thành công!');
      } else {
        const { error } = await supabase
          .from('movies')
          .insert({
            title: formData.title,
            episode: formData.episode,
            description: formData.description,
            thumbnail_url: formData.thumbnail_url,
            tts_voice: formData.tts_voice,
            channel_id: channelId,
            status: 'draft',
          });
        if (error) throw error;
        toast.success('Tạo phim thành công!');
      }
      setDialogOpen(false);
      fetchMovies();
    } catch (error: any) {
      toast.error(error.message || 'Có lỗi xảy ra');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteMovie) return;
    try {
      const { error } = await supabase
        .from('movies')
        .delete()
        .eq('id', deleteMovie.id);
      if (error) throw error;
      toast.success('Đã xóa phim');
      fetchMovies();
    } catch (error: any) {
      toast.error(error.message || 'Không thể xóa phim');
    } finally {
      setDeleteMovie(null);
    }
  };

  const filteredMovies = movies.filter(
    (m) =>
      m.title.toLowerCase().includes(search.toLowerCase()) ||
      (m.episode || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{channelName}</h1>
          <p className="text-sm text-slate-400 mt-1">
            Quản lý bộ phim trong kênh
          </p>
        </div>
        <Button
          onClick={handleOpenCreate}
          className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
        >
          <Plus className="w-4 h-4 mr-2" />
          Thêm bộ phim
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
        <Input
          placeholder="Tìm kiếm phim..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 bg-slate-900 border-slate-700 text-white placeholder:text-slate-500"
        />
      </div>

      {/* Movies Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
        </div>
      ) : filteredMovies.length === 0 ? (
        <Card className="border-dashed border-slate-700 bg-slate-900/30">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center mb-4">
              <Film className="w-8 h-8 text-slate-600" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-1">
              {search ? 'Không tìm thấy phim' : 'Chưa có phim nào'}
            </h3>
            <p className="text-sm text-slate-400 mb-4">
              {search ? 'Thử từ khóa khác' : 'Thêm bộ phim đầu tiên vào kênh'}
            </p>
            {!search && (
              <Button
                onClick={handleOpenCreate}
                className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
              >
                <Plus className="w-4 h-4 mr-2" />
                Thêm bộ phim
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredMovies.map((movie) => (
            <Card
              key={movie.id}
              className="group relative border-slate-800 bg-slate-900/50 hover:border-rose-500/50 transition-all cursor-pointer overflow-hidden"
              onClick={() =>
                setView({
                  type: 'movie-detail',
                  movieId: movie.id,
                  movieTitle: movie.title,
                  channelId,
                })
              }
            >
              <div className="relative">
                <AspectRatio ratio={16 / 9} className="bg-slate-800">
                  {movie.thumbnail_url ? (
                    <img
                      src={movie.thumbnail_url}
                      alt={movie.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Film className="w-10 h-10 text-slate-700" />
                    </div>
                  )}
                </AspectRatio>
                {/* Status badge */}
                <div className="absolute top-2 left-2">
                  <StatusBadge status={movie.status} />
                </div>
                {/* Hover play overlay */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center">
                    <Play className="w-5 h-5 text-slate-900 ml-0.5" fill="currentColor" />
                  </div>
                </div>
                {/* Actions */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      className="absolute top-2 right-2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-900/80 hover:bg-slate-900 border border-slate-700"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreVertical className="w-4 h-4 text-white" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-slate-900 border-slate-700">
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenEdit(movie);
                      }}
                      className="text-slate-200 hover:bg-slate-800 focus:bg-slate-800"
                    >
                      <Pencil className="w-4 h-4 mr-2" />
                      Chỉnh sửa
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteMovie(movie);
                      }}
                      className="text-red-400 hover:bg-red-500/10 focus:bg-red-500/10"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Xóa
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <CardContent className="p-3">
                <h3 className="font-semibold text-white text-sm truncate">
                  {movie.title}
                </h3>
                {movie.episode && (
                  <p className="text-xs text-slate-400 mt-0.5">Tập {movie.episode}</p>
                )}
                <p className="text-xs text-slate-500 mt-1">
                  {new Date(movie.created_at).toLocaleDateString('vi-VN')}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingMovie ? 'Chỉnh sửa phim' : 'Thêm bộ phim mới'}</DialogTitle>
            <DialogDescription className="text-slate-400">
              {editingMovie
                ? 'Cập nhật thông tin phim'
                : 'Điền thông tin và tải lên thumbnail (tỷ lệ 16:9)'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Thumbnail Upload */}
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
              <div className="col-span-2 space-y-2">
                <Label htmlFor="movie-title" className="text-slate-200">
                  Tên phim <span className="text-red-400">*</span>
                </Label>
                <Input
                  id="movie-title"
                  placeholder="VD: Vua Đồng Nát"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  className="bg-slate-800 border-slate-700 text-white"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="movie-episode" className="text-slate-200">Tập</Label>
                <Input
                  id="movie-episode"
                  placeholder="VD: 1224"
                  value={formData.episode}
                  onChange={(e) => setFormData({ ...formData, episode: e.target.value })}
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
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="bg-slate-800 border-slate-700 text-white min-h-[60px]"
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
              >
                Hủy
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : editingMovie ? 'Cập nhật' : 'Thêm phim'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteMovie} onOpenChange={(open) => !open && setDeleteMovie(null)}>
        <AlertDialogContent className="bg-slate-900 border-slate-700 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa phim "{deleteMovie?.title}"?</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              Hành động này không thể hoàn tác. Tất cả dữ liệu dịch, SRT và video lồng tiếng sẽ bị xóa.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700">
              Hủy
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              Xóa vĩnh viễn
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusBadge({ status }: { status: Movie['status'] }) {
  const config = {
    draft: { label: 'Bản nháp', icon: Clock, color: 'bg-slate-700 text-slate-200' },
    translating: { label: 'Đang dịch', icon: Loader2, color: 'bg-yellow-500/90 text-yellow-950' },
    completed: { label: 'Hoàn thành', icon: CheckCircle2, color: 'bg-green-500/90 text-green-950' },
    failed: { label: 'Lỗi', icon: AlertCircle, color: 'bg-red-500/90 text-red-950' },
  };
  const { label, icon: Icon, color } = config[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium ${color}`}>
      <Icon className={`w-3 h-3 ${status === 'translating' ? 'animate-spin' : ''}`} />
      {label}
    </span>
  );
}
