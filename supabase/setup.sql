-- ============================================
-- Donghua Translation App - Database Schema
-- Run this entire script in Supabase SQL Editor
-- Project: okeyouuilaldknazzhkx.supabase.co
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
-- 5. STORAGE BUCKETS
-- ============================================
INSERT INTO storage.buckets (id, name, public) VALUES
  ('thumbnails', 'thumbnails', true),
  ('videos', 'videos', true),
  ('dubbed-videos', 'dubbed-videos', true),
  ('channel-avatars', 'channel-avatars', true)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 6. STORAGE POLICIES
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
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;
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
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_channels_updated_at ON public.channels;
CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS update_movies_updated_at ON public.movies;
CREATE TRIGGER update_movies_updated_at BEFORE UPDATE ON public.movies FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS update_api_keys_updated_at ON public.api_keys;
CREATE TRIGGER update_api_keys_updated_at BEFORE UPDATE ON public.api_keys FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS update_translation_jobs_updated_at ON public.translation_jobs;
CREATE TRIGGER update_translation_jobs_updated_at BEFORE UPDATE ON public.translation_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at();
