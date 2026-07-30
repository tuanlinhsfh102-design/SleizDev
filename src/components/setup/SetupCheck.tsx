'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  CheckCircle2,
  AlertCircle,
  Copy,
  ExternalLink,
  Database,
  Loader2,
  RefreshCw,
  HardDrive,
  Table2,
  Shield,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

// SQL Schema - copy this to Supabase SQL Editor and run
const SQL_SCHEMA = `-- ============================================
-- Donghua Translation App - Database Schema
-- Run this entire script in Supabase SQL Editor
-- ============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. CHANNELS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own channels" ON public.channels;
CREATE POLICY "Users can view own channels" ON public.channels FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own channels" ON public.channels;
CREATE POLICY "Users can insert own channels" ON public.channels FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own channels" ON public.channels;
CREATE POLICY "Users can update own channels" ON public.channels FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own channels" ON public.channels;
CREATE POLICY "Users can delete own channels" ON public.channels FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 2. MOVIES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.movies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id UUID REFERENCES public.channels(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  episode TEXT,
  description TEXT,
  thumbnail_url TEXT,
  video_url TEXT,
  status TEXT DEFAULT 'draft',
  original_srt TEXT,
  vietnamese_srt TEXT,
  dubbed_video_url TEXT,
  ai_description TEXT,
  tts_voice TEXT DEFAULT 'vi_vn_1',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.movies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own movies" ON public.movies;
CREATE POLICY "Users can view own movies" ON public.movies FOR SELECT USING (EXISTS (SELECT 1 FROM public.channels WHERE channels.id = movies.channel_id AND channels.user_id = auth.uid()));
DROP POLICY IF EXISTS "Users can insert own movies" ON public.movies;
CREATE POLICY "Users can insert own movies" ON public.movies FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM public.channels WHERE channels.id = channel_id AND channels.user_id = auth.uid()));
DROP POLICY IF EXISTS "Users can update own movies" ON public.movies;
CREATE POLICY "Users can update own movies" ON public.movies FOR UPDATE USING (EXISTS (SELECT 1 FROM public.channels WHERE channels.id = movies.channel_id AND channels.user_id = auth.uid()));
DROP POLICY IF EXISTS "Users can delete own movies" ON public.movies;
CREATE POLICY "Users can delete own movies" ON public.movies FOR DELETE USING (EXISTS (SELECT 1 FROM public.channels WHERE channels.id = movies.channel_id AND channels.user_id = auth.uid()));

-- ============================================
-- 3. API KEYS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gemini',
  key_value TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own api_keys" ON public.api_keys;
CREATE POLICY "Users can view own api_keys" ON public.api_keys FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own api_keys" ON public.api_keys;
CREATE POLICY "Users can insert own api_keys" ON public.api_keys FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own api_keys" ON public.api_keys;
CREATE POLICY "Users can update own api_keys" ON public.api_keys FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own api_keys" ON public.api_keys;
CREATE POLICY "Users can delete own api_keys" ON public.api_keys FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 4. TRANSLATION JOBS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.translation_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  movie_id UUID REFERENCES public.movies(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  status TEXT DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  current_step TEXT,
  error TEXT,
  result TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.translation_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own jobs" ON public.translation_jobs;
CREATE POLICY "Users can view own jobs" ON public.translation_jobs FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own jobs" ON public.translation_jobs;
CREATE POLICY "Users can insert own jobs" ON public.translation_jobs FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own jobs" ON public.translation_jobs;
CREATE POLICY "Users can update own jobs" ON public.translation_jobs FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own jobs" ON public.translation_jobs;
CREATE POLICY "Users can delete own jobs" ON public.translation_jobs FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 5. STORAGE BUCKETS (auto-created by app, but ensure policies exist)
-- ============================================
INSERT INTO storage.buckets (id, name, public) VALUES
  ('thumbnails', 'thumbnails', true),
  ('videos', 'videos', true),
  ('dubbed-videos', 'dubbed-videos', true),
  ('channel-avatars', 'channel-avatars', true)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 6. STORAGE POLICIES (allow authenticated users to upload)
-- ============================================
DROP POLICY IF EXISTS "Auth users can upload thumbnails" ON storage.objects;
CREATE POLICY "Auth users can upload thumbnails" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'thumbnails' AND auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Anyone can view thumbnails" ON storage.objects;
CREATE POLICY "Anyone can view thumbnails" ON storage.objects FOR SELECT USING (bucket_id = 'thumbnails');
DROP POLICY IF EXISTS "Auth users can upload videos" ON storage.objects;
CREATE POLICY "Auth users can upload videos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'videos' AND auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Anyone can view videos" ON storage.objects;
CREATE POLICY "Anyone can view videos" ON storage.objects FOR SELECT USING (bucket_id = 'videos');
DROP POLICY IF EXISTS "Auth users can upload dubbed videos" ON storage.objects;
CREATE POLICY "Auth users can upload dubbed videos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'dubbed-videos' AND auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Anyone can view dubbed videos" ON storage.objects;
CREATE POLICY "Anyone can view dubbed videos" ON storage.objects FOR SELECT USING (bucket_id = 'dubbed-videos');
DROP POLICY IF EXISTS "Auth users can upload avatars" ON storage.objects;
CREATE POLICY "Auth users can upload avatars" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'channel-avatars' AND auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Anyone can view avatars" ON storage.objects;
CREATE POLICY "Anyone can view avatars" ON storage.objects FOR SELECT USING (bucket_id = 'channel-avatars');

-- ============================================
-- 7. REALTIME PUBLICATION
-- ============================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.translation_jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.movies;
ALTER PUBLICATION supabase_realtime ADD TABLE public.channels;

-- ============================================
-- 8. INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_channels_user_id ON public.channels(user_id);
CREATE INDEX IF NOT EXISTS idx_movies_channel_id ON public.movies(channel_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON public.api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_translation_jobs_movie_id ON public.translation_jobs(movie_id);

-- ============================================
-- 9. AUTO-UPDATE TRIGGERS
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS update_channels_updated_at ON public.channels;
CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS update_movies_updated_at ON public.movies;
CREATE TRIGGER update_movies_updated_at BEFORE UPDATE ON public.movies FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS update_api_keys_updated_at ON public.api_keys;
CREATE TRIGGER update_api_keys_updated_at BEFORE UPDATE ON public.api_keys FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS update_translation_jobs_updated_at ON public.translation_jobs;
CREATE TRIGGER update_translation_jobs_updated_at BEFORE UPDATE ON public.translation_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Done! The app will auto-detect when schema is ready.`;

interface SetupStatus {
  tables: boolean;
  storage: boolean;
  realtime: boolean;
}

interface SetupCheckProps {
  onSetupComplete: () => void;
}

export function SetupCheck({ onSetupComplete }: SetupCheckProps) {
  const supabase = createClient();
  const [status, setStatus] = useState<SetupStatus>({
    tables: false,
    storage: false,
    realtime: false,
  });
  const [checking, setChecking] = useState(true);
  const [copied, setCopied] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [sqlOpened, setSqlOpened] = useState(false);

  const checkSchema = useCallback(async () => {
    try {
      // Check tables
      const { error: channelsError } = await supabase
        .from('channels')
        .select('id')
        .limit(1);

      const tablesReady = !channelsError || (channelsError.code !== 'PGRST205' && !channelsError.message.includes('Could not find'));

      // Check storage buckets via our API route (which auto-creates if missing)
      let storageReady = false;
      try {
        // First, try to ensure buckets exist (auto-create)
        await fetch('/api/setup-storage', { method: 'POST' }).catch(() => {});

        // Then check status
        const res = await fetch('/api/setup-storage', { method: 'GET' });
        if (res.ok) {
          const data = await res.json() as { ready: boolean };
          storageReady = data.ready;
        }
      } catch {}

      const newStatus = {
        tables: tablesReady,
        storage: storageReady,
        realtime: tablesReady, // Realtime depends on tables
      };

      setStatus(newStatus);

      // If everything is ready, complete setup
      if (tablesReady && storageReady) {
        setAutoRefresh(false);
        toast.success('Database đã sẵn sàng! Đang chuyển vào ứng dụng...');
        setTimeout(() => onSetupComplete(), 1500);
      }

      return newStatus;
    } catch (e) {
      console.error('Schema check failed:', e);
      return status;
    }
  }, [supabase, onSetupComplete, status]);

  // Initial check - run once on mount
  useEffect(() => {
    let mounted = true;
    let active = true;

    const run = async () => {
      if (active) setChecking(true);
      await checkSchema();
      if (mounted && active) setChecking(false);
    };
    run();

    return () => {
      mounted = false;
      active = false;
    };
  }, []);

  // Auto-poll every 5 seconds when waiting for user to complete SQL setup
  useEffect(() => {
    if (!autoRefresh) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!active) return;
      const result = await checkSchema();
      if (!active) return;
      if (!result.tables || !result.storage) {
        timer = setTimeout(poll, 5000);
      }
    };

    // Start polling after a short delay (to not conflict with initial check)
    timer = setTimeout(poll, 5000);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [autoRefresh]);

  const copySql = () => {
    navigator.clipboard.writeText(SQL_SCHEMA);
    setCopied(true);
    toast.success('Đã sao chép SQL schema vào clipboard');
    setTimeout(() => setCopied(false), 3000);
  };

  const openSqlEditor = () => {
    window.open(
      'https://supabase.com/dashboard/project/okeyouuilaldknazzhkx/sql/new',
      '_blank',
      'noopener,noreferrer'
    );
    setSqlOpened(true);
    toast.info('Đã mở SQL Editor. Dán SQL và nhấn Run, sau đó đợi app tự kiểm tra.');
  };

  const manualCheck = async () => {
    setChecking(true);
    await checkSchema();
    setChecking(false);
  };

  const allReady = status.tables && status.storage;
  const progressPercent = (
    (status.tables ? 33 : 0) +
    (status.storage ? 33 : 0) +
    (status.realtime ? 34 : 0)
  );

  if (checking && !status.tables && !status.storage) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-rose-500" />
          <p className="text-slate-400 text-sm">Đang kiểm tra database...</p>
        </div>
      </div>
    );
  }

  if (allReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="flex flex-col items-center gap-3">
          <CheckCircle2 className="w-12 h-12 text-green-500" />
          <p className="text-white font-medium">Database đã sẵn sàng!</p>
          <p className="text-slate-400 text-sm">Đang chuyển vào ứng dụng...</p>
          <Loader2 className="w-5 h-5 animate-spin text-rose-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center py-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-rose-500/30">
            <Database className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold mb-2">Thiết lập Database</h1>
          <p className="text-slate-400">
            Chạy SQL schema một lần duy nhất để bắt đầu sử dụng ứng dụng
          </p>
        </div>

        {/* Progress Overview */}
        <Card className="border-slate-800 bg-slate-900/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-white">Tiến độ thiết lập</span>
              <span className="text-sm text-slate-400">{progressPercent}%</span>
            </div>
            <Progress value={progressPercent} className="h-2 bg-slate-800" />
            <div className="grid grid-cols-3 gap-3 mt-4">
              <StatusItem
                icon={Table2}
                label="Tables"
                ready={status.tables}
              />
              <StatusItem
                icon={HardDrive}
                label="Storage"
                ready={status.storage}
              />
              <StatusItem
                icon={Shield}
                label="Realtime"
                ready={status.realtime}
              />
            </div>
            {autoRefresh && !allReady && (
              <div className="flex items-center justify-center gap-2 mt-4 text-xs text-slate-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Tự động kiểm tra mỗi 5 giây — chạy SQL xong sẽ tự chuyển tiếp</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Alert */}
        <Alert className="border-yellow-500/30 bg-yellow-500/10">
          <AlertCircle className="h-4 w-4 text-yellow-500" />
          <AlertTitle className="text-yellow-200">Cần chạy SQL schema</AlertTitle>
          <AlertDescription className="text-yellow-100/80">
            Storage buckets đã được tự động tạo. Bạn chỉ cần chạy SQL để tạo các bảng dữ liệu (tables) và policies. App sẽ tự động phát hiện khi hoàn tất.
          </AlertDescription>
        </Alert>

        {/* Step 1: Open SQL Editor */}
        <Card className="border-slate-800 bg-slate-900/50">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-3">
              <span className="w-8 h-8 rounded-full bg-rose-500 text-white text-sm font-bold flex items-center justify-center shrink-0">1</span>
              Mở Supabase SQL Editor
            </CardTitle>
            <CardDescription className="text-slate-400">
              Đăng nhập vào Supabase Dashboard → SQL Editor → New query
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={openSqlEditor}
              className="bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              Mở SQL Editor trong tab mới
            </Button>
            {sqlOpened && (
              <p className="text-xs text-emerald-400 mt-2 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                Đã mở SQL Editor. Tiếp tục bước 2.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Step 2: Copy and Run SQL */}
        <Card className="border-slate-800 bg-slate-900/50">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-3">
              <span className="w-8 h-8 rounded-full bg-rose-500 text-white text-sm font-bold flex items-center justify-center shrink-0">2</span>
              Sao chép và dán SQL vào Editor
            </CardTitle>
            <CardDescription className="text-slate-400">
              Nhấn nút Copy bên dưới, dán vào SQL Editor và nhấn <kbd className="px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded text-xs">Run</kbd> (hoặc Ctrl+Enter)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative">
              <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs text-slate-300 font-mono overflow-x-auto max-h-80 overflow-y-auto">
                {SQL_SCHEMA}
              </pre>
              <Button
                onClick={copySql}
                className="absolute top-2 right-2 bg-slate-800 hover:bg-slate-700 border border-slate-700"
                size="sm"
              >
                {copied ? (
                  <>
                    <CheckCircle2 className="w-3 h-3 mr-1 text-green-400" />
                    Đã copy!
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 mr-1" />
                    Copy SQL
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Step 3: Auto-detect or Manual Check */}
        <Card className="border-slate-800 bg-slate-900/50">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-3">
              <span className="w-8 h-8 rounded-full bg-rose-500 text-white text-sm font-bold flex items-center justify-center shrink-0">3</span>
              Hoàn tất
            </CardTitle>
            <CardDescription className="text-slate-400">
              App sẽ tự động phát hiện khi SQL đã chạy xong. Hoặc nhấn nút để kiểm tra thủ công.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <Button
              onClick={manualCheck}
              disabled={checking}
              variant="outline"
              className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700"
            >
              {checking ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Đang kiểm tra...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Kiểm tra ngay
                </>
              )}
            </Button>
            <Button
              onClick={() => setAutoRefresh(!autoRefresh)}
              variant="ghost"
              className="text-slate-400 hover:text-white"
            >
              {autoRefresh ? 'Tạm dừng auto-check' : 'Bật auto-check'}
            </Button>
          </CardContent>
        </Card>

        {/* Help */}
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="p-4 flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5 text-blue-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-white mb-1">
                Lưu ý quan trọng
              </h3>
              <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
                <li>SQL này an toàn chạy nhiều lần (sử dụng IF NOT EXISTS và DROP POLICY IF EXISTS)</li>
                <li>Sau khi chạy xong, đợi 5-10 giây để Supabase cache refresh</li>
                <li>Nếu app không tự chuyển, nhấn "Kiểm tra ngay"</li>
                <li>Storage buckets đã được tự động tạo, không cần làm thủ công</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatusItem({
  icon: Icon,
  label,
  ready,
}: {
  icon: React.ElementType;
  label: string;
  ready: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-colors ${
        ready
          ? 'border-green-500/30 bg-green-500/10'
          : 'border-slate-800 bg-slate-800/30'
      }`}
    >
      <Icon className={`w-5 h-5 ${ready ? 'text-green-400' : 'text-slate-500'}`} />
      <span className={`text-xs font-medium ${ready ? 'text-green-400' : 'text-slate-500'}`}>
        {label}
      </span>
      {ready ? (
        <CheckCircle2 className="w-3 h-3 text-green-400" />
      ) : (
        <Loader2 className="w-3 h-3 text-slate-600 animate-spin" />
      )}
    </div>
  );
}
