# Donghua Translate - Setup Guide

## Quick Start

### 1. Install dependencies
```bash
# Main project
bun install

# Translation service
cd mini-services/translation-service
bun install
cd ../..
```

### 2. Environment Variables

The project ships with **documented default credentials** committed to the
repo (in `.env`) that work out of the box for testing — you do NOT need to
create `.env.local` to start the app. Next.js auto-loads `.env` on startup,
so the frontend works on first install with zero configuration. The
translation-service's env-loader also injects these same defaults if no
`.env.local` is found.

**To use your own Supabase project** (recommended for production), create a
`.env.local` file at the project root with your own values — Next.js loads
`.env.local` AFTER `.env`, so your values override the defaults:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxxxxxxxxxxxxxxxx
SUPABASE_SECRET_KEY=sb_secret__xxxxxxxxxxxxxxxxxxxxxxxxx
SUPABASE_SERVICE_ROLE_KEY=sb_secret__xxxxxxxxxxxxxxxxxxxxxxxxx
SUPABASE_URL=https://your-project.supabase.co
```

A template is provided as `.env.example` — copy it to `.env.local` and fill
in your values:

```bash
cp .env.example .env.local
# Then edit .env.local with your Supabase project's credentials
```

**Default credentials** (committed in `.env`, also auto-injected by
env-loader if `.env.local` is missing — these are the project's own
Supabase instance, already public via this README, so safe to use for
testing):

```
NEXT_PUBLIC_SUPABASE_URL=https://okeyouuilaldknazzhkx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_kkTBJYylMxU2itNaXSdpsg_8LmNTyH2
SUPABASE_SECRET_KEY=sb_secret__prLx0suhRL4yJtj-k7e2A_gt9Em5Uj
SUPABASE_SERVICE_ROLE_KEY=sb_secret__prLx0suhRL4yJtj-k7e2A_gt9Em5Uj
SUPABASE_URL=https://okeyouuilaldknazzhkx.supabase.co
```

### 3. Install yt-dlp (optional — for TikTok URL import)
If you want to import videos by pasting a TikTok URL (instead of uploading a
file), install yt-dlp — it handles TikTok's bot detection and short-URL
redirects:

```bash
pip install yt-dlp
```

Or download the binary from https://github.com/yt-dlp/yt-dlp/releases and
put it on your PATH. The app auto-detects yt-dlp; if it's missing, the
TikTok import falls back to a manual HTML scraper (less reliable).

You also need Python 3.9+ and the `requests` package for the CapCut STT/TTS
bridge:

```bash
pip install requests
```

### 4. Run the app
```bash
# Terminal 1: Next.js
bun run dev

# Terminal 2: Translation service (Bun)
cd mini-services/translation-service
bun run dev
```

### 5. Setup Database (one-time)
1. Open http://localhost:3000
2. Login: `admin@test.com` / `password123` (or register new account)
3. App shows Setup page → Click "Mở SQL Editor"
4. Click "Copy SQL" → paste in Supabase SQL Editor → Run
5. App auto-detects and redirects to main app

### Architecture
- **Frontend**: Next.js 16 + TypeScript + Tailwind CSS + shadcn/ui (port 3000)
- **Backend**: Bun + Socket.io translation service (port 3004)
- **Database**: Supabase (PostgreSQL + Auth + Storage + Realtime)
- **AI**: Gemini 3.1 Flash Lite Preview (dịch SRT + tạo mô tả)
- **TTS**: CapCut TTS API (50 parallel requests, 24 giọng Việt + 15 giọng Trung)
- **Video**: ffmpeg-static (trích xuất audio, lồng tiếng)
- **TikTok import**: yt-dlp + manual HTML scraper fallback

### Features
- Đăng ký/đăng nhập (Supabase Auth)
- Sidebar: Kênh, API Keys
- Kênh: CRUD (tạo, sửa, xóa)
- Bộ phim: CRUD + upload thumbnail 16:9
- Dịch phim: 6 tabs (Upload, SRT gốc, SRT Việt, Video lồng tiếng, Mô tả AI, Thông tin)
- **Tải video 2 cách**: upload file (kéo thả) HOẶC dán link TikTok (auto download)
- Tự động trích xuất SRT khi tải video (CapCut STT API)
- Realtime progress qua Socket.io
- AI description theo template Sleiz Vietsub
- API Keys management (Gemini)

### Notes
- ffmpeg-static binary (~107MB) is NOT included in zip - will be installed via `bun install`
- Storage buckets auto-created on first login
- Database tables require one-time SQL execution (security restriction)
- Model AI: `gemini-3.1-flash-lite-preview` (bắt buộc đúng tên model)
