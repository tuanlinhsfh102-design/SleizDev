'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  KeyRound,
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  Loader2,
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { ApiKey } from '@/types';
import { toast } from 'sonner';

const PROVIDERS = [
  {
    id: 'gemini' as const,
    name: 'Gemini API',
    description: 'Dùng để dịch SRT và tạo mô tả phim',
    placeholder: 'AIza...',
    link: 'https://aistudio.google.com/apikey',
    color: 'from-blue-500 to-cyan-500',
    icon: Sparkles,
  },
];

export function ApiKeyManager() {
  const supabase = createClient();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [deleteKey, setDeleteKey] = useState<ApiKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [formData, setFormData] = useState({
    name: '',
    provider: 'gemini' as ApiKey['provider'],
    key_value: '',
  });

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) {
      toast.error('Không thể tải API keys');
    } else {
      setApiKeys(data || []);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleOpenCreate = () => {
    setEditingKey(null);
    setFormData({ name: '', provider: 'gemini', key_value: '' });
    setDialogOpen(true);
  };

  const handleOpenEdit = (key: ApiKey) => {
    setEditingKey(key);
    setFormData({ name: key.name, provider: key.provider, key_value: key.key_value });
    setDialogOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.key_value.trim()) {
      toast.error('Vui lòng nhập đầy đủ thông tin');
      return;
    }
    setSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Chưa đăng nhập');

      if (editingKey) {
        const { error } = await supabase
          .from('api_keys')
          .update({
            name: formData.name,
            provider: formData.provider,
            key_value: formData.key_value,
          })
          .eq('id', editingKey.id);
        if (error) throw error;
        toast.success('Cập nhật API key thành công');
      } else {
        const { error } = await supabase
          .from('api_keys')
          .insert({
            name: formData.name,
            provider: formData.provider,
            key_value: formData.key_value,
            user_id: user.id,
            is_active: true,
          });
        if (error) throw error;
        toast.success('Thêm API key thành công');
      }
      setDialogOpen(false);
      fetchKeys();
    } catch (error: any) {
      toast.error(error.message || 'Có lỗi xảy ra');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteKey) return;
    try {
      const { error } = await supabase
        .from('api_keys')
        .delete()
        .eq('id', deleteKey.id);
      if (error) throw error;
      toast.success('Đã xóa API key');
      fetchKeys();
    } catch (error: any) {
      toast.error(error.message || 'Không thể xóa');
    } finally {
      setDeleteKey(null);
    }
  };

  const toggleShowKey = (id: string) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    toast.success('Đã sao chép');
  };

  const maskKey = (key: string) => {
    if (key.length <= 8) return '••••••••';
    return key.substring(0, 4) + '••••••••••••••••' + key.substring(key.length - 4);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">API Keys</h1>
          <p className="text-sm text-slate-400 mt-1">
            Quản lý các API key để sử dụng cho dịch phim
          </p>
        </div>
        <Button
          onClick={handleOpenCreate}
          className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
        >
          <Plus className="w-4 h-4 mr-2" />
          Thêm API key
        </Button>
      </div>

      {/* Info Banner */}
      <Card className="border-blue-500/30 bg-blue-500/5">
        <CardContent className="p-4 flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
            <KeyRound className="w-5 h-5 text-blue-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-white mb-1">
              Cách lấy Gemini API Key
            </h3>
            <p className="text-xs text-slate-400 mb-2">
              Truy cập Google AI Studio để tạo API key miễn phí. Key này sẽ được dùng để dịch SRT và tạo mô tả phim.
            </p>
            <Button
              size="sm"
              variant="outline"
              asChild
              className="h-7 text-xs bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
            >
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-3 h-3 mr-1" />
                Mở Google AI Studio
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* API Keys List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
        </div>
      ) : apiKeys.length === 0 ? (
        <Card className="border-dashed border-slate-700 bg-slate-900/30">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center mb-4">
              <KeyRound className="w-8 h-8 text-slate-600" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-1">Chưa có API key</h3>
            <p className="text-sm text-slate-400 mb-4">
              Thêm Gemini API key để bắt đầu dịch phim
            </p>
            <Button
              onClick={handleOpenCreate}
              className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
            >
              <Plus className="w-4 h-4 mr-2" />
              Thêm API key
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {apiKeys.map((key) => {
            const provider = PROVIDERS.find((p) => p.id === key.provider);
            const Icon = provider?.icon || KeyRound;
            return (
              <Card
                key={key.id}
                className="border-slate-800 bg-slate-900/50 hover:border-slate-700 transition-colors"
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${provider?.color || 'from-slate-600 to-slate-700'} flex items-center justify-center shrink-0`}>
                      <Icon className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-white text-sm truncate">{key.name}</h3>
                        {key.is_active && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-green-500/20 text-green-400">
                            <CheckCircle2 className="w-3 h-3" />
                            Hoạt động
                          </span>
                        )}
                        <span className="px-1.5 py-0.5 rounded text-xs bg-slate-800 text-slate-400">
                          {key.provider}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <code className="text-xs text-slate-500 font-mono">
                          {showKeys[key.id] ? key.key_value : maskKey(key.key_value)}
                        </code>
                        <button
                          onClick={() => toggleShowKey(key.id)}
                          className="text-slate-500 hover:text-slate-300"
                        >
                          {showKeys[key.id] ? (
                            <EyeOff className="w-3.5 h-3.5" />
                          ) : (
                            <Eye className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => copyKey(key.key_value)}
                          className="text-slate-500 hover:text-slate-300"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-slate-900 border-slate-700">
                        <DropdownMenuItem
                          onClick={() => handleOpenEdit(key)}
                          className="text-slate-200 hover:bg-slate-800 focus:bg-slate-800"
                        >
                          <Pencil className="w-4 h-4 mr-2" />
                          Chỉnh sửa
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setDeleteKey(key)}
                          className="text-red-400 hover:bg-red-500/10 focus:bg-red-500/10"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Xóa
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>{editingKey ? 'Chỉnh sửa API key' : 'Thêm API key mới'}</DialogTitle>
            <DialogDescription className="text-slate-400">
              {editingKey
                ? 'Cập nhật thông tin API key'
                : 'Thêm API key để sử dụng cho dịch phim'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key-name" className="text-slate-200">
                Tên <span className="text-red-400">*</span>
              </Label>
              <Input
                id="key-name"
                placeholder="VD: Gemini API chính"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="bg-slate-800 border-slate-700 text-white"
                required
              />
            </div>
            <div className="space-y-2">
              <Label className="text-slate-200">Provider</Label>
              <div className="grid grid-cols-3 gap-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setFormData({ ...formData, provider: p.id })}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                      formData.provider === p.id
                        ? 'border-rose-500 bg-rose-500/10 text-rose-300'
                        : 'border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="key-value" className="text-slate-200">
                API Key <span className="text-red-400">*</span>
              </Label>
              <Input
                id="key-value"
                type="password"
                placeholder={PROVIDERS.find((p) => p.id === formData.provider)?.placeholder}
                value={formData.key_value}
                onChange={(e) => setFormData({ ...formData, key_value: e.target.value })}
                className="bg-slate-800 border-slate-700 text-white font-mono"
                required
              />
              <p className="text-xs text-slate-500">
                Key được lưu trữ an toàn trong database của bạn
              </p>
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
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : editingKey ? 'Cập nhật' : 'Thêm key'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteKey} onOpenChange={(open) => !open && setDeleteKey(null)}>
        <AlertDialogContent className="bg-slate-900 border-slate-700 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa API key "{deleteKey?.name}"?</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              Hành động này không thể hoàn tác.
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
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
