'use client';

import { useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Mail, Lock, User, Film } from 'lucide-react';
import { toast } from 'sonner';

interface AuthFormProps {
  onSuccess: () => void;
}

export function AuthForm({ onSuccess }: AuthFormProps) {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error('Vui lòng nhập đầy đủ thông tin');
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      toast.success('Đăng nhập thành công!');
      onSuccess();
    } catch (error: any) {
      toast.error(error.message || 'Đăng nhập thất bại');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !fullName) {
      toast.error('Vui lòng nhập đầy đủ thông tin');
      return;
    }
    if (password.length < 6) {
      toast.error('Mật khẩu phải có ít nhất 6 ký tự');
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
          },
        },
      });
      if (error) throw error;
      if (data.user && !data.session) {
        toast.success('Đăng ký thành công! Vui lòng kiểm tra email để xác thực.');
      } else {
        toast.success('Đăng ký thành công!');
        onSuccess();
      }
    } catch (error: any) {
      toast.error(error.message || 'Đăng ký thất bại');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center mb-4 shadow-lg shadow-rose-500/30">
            <Film className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white">Donghua Translate</h1>
          <p className="text-slate-400 mt-2 text-center">
            Hệ thống dịch và lồng tiếng phim hoạt hình Trung Quốc
          </p>
        </div>

        <Card className="border-slate-700 bg-slate-800/50 backdrop-blur">
          <CardHeader>
            <CardTitle className="text-white">Tài khoản</CardTitle>
            <CardDescription className="text-slate-400">
              Đăng nhập hoặc tạo tài khoản để bắt đầu
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'login' | 'register')}>
              <TabsList className="grid w-full grid-cols-2 bg-slate-900/50">
                <TabsTrigger value="login" className="data-[state=active]:bg-rose-500 data-[state=active]:text-white">
                  Đăng nhập
                </TabsTrigger>
                <TabsTrigger value="register" className="data-[state=active]:bg-rose-500 data-[state=active]:text-white">
                  Đăng ký
                </TabsTrigger>
              </TabsList>

              <TabsContent value="login" className="mt-4">
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="login-email" className="text-slate-300">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                      <Input
                        id="login-email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="pl-9 bg-slate-900/50 border-slate-700 text-white placeholder:text-slate-500"
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="login-password" className="text-slate-300">Mật khẩu</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                      <Input
                        id="login-password"
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="pl-9 bg-slate-900/50 border-slate-700 text-white placeholder:text-slate-500"
                        required
                      />
                    </div>
                  </div>
                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600 text-white"
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Đăng nhập'}
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="register" className="mt-4">
                <form onSubmit={handleRegister} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="register-name" className="text-slate-300">Họ và tên</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                      <Input
                        id="register-name"
                        type="text"
                        placeholder="Nguyễn Văn A"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        className="pl-9 bg-slate-900/50 border-slate-700 text-white placeholder:text-slate-500"
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="register-email" className="text-slate-300">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                      <Input
                        id="register-email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="pl-9 bg-slate-900/50 border-slate-700 text-white placeholder:text-slate-500"
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="register-password" className="text-slate-300">Mật khẩu</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                      <Input
                        id="register-password"
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="pl-9 bg-slate-900/50 border-slate-700 text-white placeholder:text-slate-500"
                        required
                      />
                    </div>
                  </div>
                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600 text-white"
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Đăng ký tài khoản'}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-slate-500 mt-6">
          Bằng việc sử dụng dịch vụ, bạn đồng ý với điều khoản sử dụng
        </p>
      </div>
    </div>
  );
}
