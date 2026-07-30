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
  DialogTrigger,
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
import { Plus, Tv, MoreVertical, Pencil, Trash2, Film, Loader2, Search } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { Channel } from '@/types';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ChannelsManager() {
  const supabase = createClient();
  const { setView } = useAppStore();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [deleteChannel, setDeleteChannel] = useState<Channel | null>(null);
  const [formData, setFormData] = useState({ name: '', description: '' });
  const [submitting, setSubmitting] = useState(false);

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('channels')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) {
      toast.error('Không thể tải danh sách kênh: ' + error.message);
    } else {
      setChannels(data || []);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  const handleOpenCreate = () => {
    setEditingChannel(null);
    setFormData({ name: '', description: '' });
    setDialogOpen(true);
  };

  const handleOpenEdit = (channel: Channel) => {
    setEditingChannel(channel);
    setFormData({ name: channel.name, description: channel.description || '' });
    setDialogOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast.error('Vui lòng nhập tên kênh');
      return;
    }
    setSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Chưa đăng nhập');

      if (editingChannel) {
        const { error } = await supabase
          .from('channels')
          .update({
            name: formData.name,
            description: formData.description,
          })
          .eq('id', editingChannel.id);
        if (error) throw error;
        toast.success('Cập nhật kênh thành công!');
      } else {
        const { error } = await supabase
          .from('channels')
          .insert({
            name: formData.name,
            description: formData.description,
            user_id: user.id,
          });
        if (error) throw error;
        toast.success('Tạo kênh thành công!');
      }
      setDialogOpen(false);
      fetchChannels();
    } catch (error: any) {
      toast.error(error.message || 'Có lỗi xảy ra');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteChannel) return;
    try {
      const { error } = await supabase
        .from('channels')
        .delete()
        .eq('id', deleteChannel.id);
      if (error) throw error;
      toast.success('Đã xóa kênh');
      fetchChannels();
    } catch (error: any) {
      toast.error(error.message || 'Không thể xóa kênh');
    } finally {
      setDeleteChannel(null);
    }
  };

  const filteredChannels = channels.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Kênh của tôi</h1>
          <p className="text-sm text-slate-400 mt-1">
            Quản lý các kênh dịch phim của bạn
          </p>
        </div>
        <Button
          onClick={handleOpenCreate}
          className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
        >
          <Plus className="w-4 h-4 mr-2" />
          Tạo kênh mới
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
        <Input
          placeholder="Tìm kiếm kênh..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 bg-slate-900 border-slate-700 text-white placeholder:text-slate-500"
        />
      </div>

      {/* Channels Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
        </div>
      ) : filteredChannels.length === 0 ? (
        <Card className="border-dashed border-slate-700 bg-slate-900/30">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center mb-4">
              <Tv className="w-8 h-8 text-slate-600" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-1">
              {search ? 'Không tìm thấy kênh' : 'Chưa có kênh nào'}
            </h3>
            <p className="text-sm text-slate-400 mb-4">
              {search ? 'Thử từ khóa khác' : 'Tạo kênh đầu tiên để bắt đầu dịch phim'}
            </p>
            {!search && (
              <Button
                onClick={handleOpenCreate}
                className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
              >
                <Plus className="w-4 h-4 mr-2" />
                Tạo kênh mới
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredChannels.map((channel) => (
            <Card
              key={channel.id}
              className="group relative border-slate-800 bg-slate-900/50 hover:border-rose-500/50 transition-all cursor-pointer overflow-hidden"
              onClick={() => setView({ type: 'channel-detail', channelId: channel.id, channelName: channel.name })}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-rose-500/20 to-orange-500/20 border border-rose-500/30 flex items-center justify-center">
                    <Tv className="w-6 h-6 text-rose-400" />
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="bg-slate-900 border-slate-700">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenEdit(channel);
                        }}
                        className="text-slate-200 hover:bg-slate-800 focus:bg-slate-800"
                      >
                        <Pencil className="w-4 h-4 mr-2" />
                        Chỉnh sửa
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteChannel(channel);
                        }}
                        className="text-red-400 hover:bg-red-500/10 focus:bg-red-500/10"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Xóa
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <CardTitle className="text-base text-white mt-3 truncate">
                  {channel.name}
                </CardTitle>
                <CardDescription className="text-xs text-slate-500 line-clamp-2 min-h-[2rem]">
                  {channel.description || 'Chưa có mô tả'}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="flex items-center gap-1">
                    <Film className="w-3 h-3" />
                    Xem bộ phim
                  </span>
                  <span>{new Date(channel.created_at).toLocaleDateString('vi-VN')}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>{editingChannel ? 'Chỉnh sửa kênh' : 'Tạo kênh mới'}</DialogTitle>
            <DialogDescription className="text-slate-400">
              {editingChannel
                ? 'Cập nhật thông tin kênh của bạn'
                : 'Điền thông tin để tạo kênh mới'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="channel-name" className="text-slate-200">
                Tên kênh <span className="text-red-400">*</span>
              </Label>
              <Input
                id="channel-name"
                placeholder="VD: Sleiz Vietsub"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="bg-slate-800 border-slate-700 text-white"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-description" className="text-slate-200">
                Mô tả
              </Label>
              <Textarea
                id="channel-description"
                placeholder="Mô tả ngắn về kênh của bạn..."
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="bg-slate-800 border-slate-700 text-white min-h-[80px]"
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
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : editingChannel ? 'Cập nhật' : 'Tạo kênh'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteChannel} onOpenChange={(open) => !open && setDeleteChannel(null)}>
        <AlertDialogContent className="bg-slate-900 border-slate-700 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa kênh "{deleteChannel?.name}"?</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              Hành động này không thể hoàn tác. Tất cả bộ phim và dữ liệu dịch trong kênh sẽ bị xóa vĩnh viễn.
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
