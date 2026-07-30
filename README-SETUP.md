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
File `.env.local` is included:
```
NEXT_PUBLIC_SUPABASE_URL=https://okeyouuilaldknazzhkx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_kkTBJYylMxU2itNaXSdpsg_8LmNTyH2
SUPABASE_SECRET_KEY=sb_secret__prLx0suhRL4yJtj-k7e2A_gt9Em5Uj
SUPABASE_SERVICE_ROLE_KEY=sb_secret__prLx0suhRL4yJtj-k7e2A_gt9Em5Uj
SUPABASE_URL=https://okeyouuilaldknazzhkx.supabase.co
```

### 3. Run the app
```bash
# Terminal 1: Next.js
bun run dev

# Terminal 2: Translation service (Bun)
cd mini-services/translation-service
bun run dev
```

### 4. Setup Database (one-time)
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
- **TTS**: TikTok TTS API (fallback: Google Translate TTS)
- **Video**: ffmpeg-static (trích xuất audio, lồng tiếng)

### Features
- Đăng ký/đăng nhập (Supabase Auth)
- Sidebar: Kênh, API Keys
- Kênh: CRUD (tạo, sửa, xóa)
- Bộ phim: CRUD + upload thumbnail 16:9
- Dịch phim: 6 tabs (Upload, SRT gốc, SRT Việt, Video lồng tiếng, Mô tả AI, Thông tin)
- Realtime progress qua Socket.io
- AI description theo template Sleiz Vietsub
- API Keys management (Gemini)

### Notes
- ffmpeg-static binary (~107MB) is NOT included in zip - will be installed via `bun install`
- Storage buckets auto-created on first login
- Database tables require one-time SQL execution (security restriction)
- Model AI: `gemini-3.1-flash-lite-preview` (bắt buộc đúng tên model)
