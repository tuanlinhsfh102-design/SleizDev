# CapCut STT Integration

This module transcribes audio/video files to SRT using CapCut's official
Speech-to-Text API.

## Architecture

```
TypeScript (capcut.ts)
    │
    │  spawn python3
    ▼
Python bridge (scripts/capcut_stt.py)
    │
    │  uses vendored SDK
    ▼
capcut-tts-api library (vendor/capcut_tts_api/)
    │
    │  HTTPS calls
    ▼
CapCut /lv/v1/common_task API
   - VOD chunked upload (AWS SigV4)
   - STT task creation
   - Status polling
   - Subtitle parsing
```

## Requirements

- **Python 3.9+** on the host running the translation service.
- **`requests` Python package** — install with `pip3 install requests`.
- **ffmpeg** (already required by `extractAudio`).

To override the Python binary, set `CAPCUT_PYTHON=/path/to/python3` in the
environment before starting the service.

## Why a Python bridge?

The original `capcut.ts` tried to call CapCut's STT API directly using
fictional endpoints (`us-api.capcut.com/api/asr/task`, `/api/auth/device`)
that don't exist. Every transcription silently fell back to a silence-based
stub that produced placeholder cues like `[Phân đoạn 1]`, so SRT extraction
always returned junk.

CapCut's real STT flow is non-trivial:

1. Apply for VOD upload credentials (`/lv/v1/upload_sign`).
2. Apply for upload address (`ApplyUploadInner` on the VOD host, AWS SigV4).
3. Transfer the binary (`/upload/v1/{store_uri}`).
4. Finish upload.
5. Commit upload (`CommitUploadInner`) → returns `vid` + `md5` + duration.
6. Create the STT task (`/lv/v1/common_task/new`, signed).
7. Poll the task (`/lv/v1/common_task/query`, signed) until status is
   `success` (TTS) or `succeed` (STT — note the extra `d`).
8. Parse the JSON payload of utterances + word-level timings.

Implementing all of this (RSA PKCS#1 v1.5 sign, AWS SigV4 sign, MD5 stub
header, custom trace IDs) in TypeScript would require porting ~500 lines of
cryptography and protocol logic. Vendoring the upstream Python SDK and
spawning it as a subprocess is simpler, easier to maintain, and gets bug
fixes from upstream automatically.

## Quick test

```bash
cd mini-services/translation-service
PYTHONPATH=vendor python3 scripts/capcut_stt.py \
  --audio /path/to/audio.mp3 \
  --language zh-CN \
  --timeout 120
```

Stdout: pure SRT. Stderr: log lines prefixed `[stage] ...`.

## Custom device identity

CapCut rate-limits by `device_id`. To rotate the device, drop a
`device.json` next to this README (see `vendor/device.json.example`) and
restart the service. The bridge auto-detects it.

## Credits

Upstream Python SDK: <https://github.com/K07VN/capcut-tts-api> (MIT).
