#!/usr/bin/env python3
"""Generate a test video for the full pipeline end-to-end test.

Creates a 15-second 1280x720 video with:
  - A colored background with text overlay (so we can see subtitle burn-in)
  - Chinese speech audio generated via CapCut TTS (so STT has something to transcribe)

The video is saved to /home/z/my-project/download/test_pipeline_video.mp4
and used as input for the full SleizDev pipeline:
  audio→SRT→translate→TTS→merge→burn-subtitles→export
"""
import sys
import subprocess
from pathlib import Path

# Bootstrap vendored SDK
VENDOR_DIR = Path(__file__).resolve().parent.parent / 'vendor'
sys.path.insert(0, str(VENDOR_DIR))

from capcut_tts_api import CapCutClient

# Chinese test sentences (will be spoken in the video)
SENTENCES = [
    "大家好，欢迎来到我的频道。",
    "今天我们要聊一聊人工智能的发展。",
    "人工智能已经改变了我们的生活。",
    "从智能手机到自动驾驶汽车。",
    "未来还会有更多令人惊叹的应用。",
]

OUTPUT_DIR = Path('/home/z/my-project/download/pipeline_test')
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
FINAL_VIDEO = OUTPUT_DIR / 'test_input.mp4'

print(f'=== Generating test video at {FINAL_VIDEO} ===')
print(f'Sentences ({len(SENTENCES)}):')
for i, s in enumerate(SENTENCES, 1):
    print(f'  {i}. {s}')
print()

# Step 1: Generate Chinese TTS audio for each sentence
print('=== Step 1: Generate Chinese TTS audio ===')
client = CapCutClient()
clips_dir = OUTPUT_DIR / 'clips'
clips_dir.mkdir(exist_ok=True)
clip_paths = []
for i, sentence in enumerate(SENTENCES):
    clip_path = clips_dir / f'clip_{i:03d}.mp3'
    print(f'  [{i+1}/{len(SENTENCES)}] Generating: {sentence}')
    result = client.generate_speech(
        texts=sentence,
        voice='zh_female_xiaoyue',  # Chinese female voice
        rate='1.0',
        wait=True,
        timeout=60.0,
    )
    # Extract URL and download
    import json, urllib.request
    tasks = (result.get('data') or {}).get('tasks') or []
    if not tasks:
        raise RuntimeError(f'No task returned for sentence {i}')
    payload = json.loads(tasks[0].get('payload', '{}'))
    audio_url = (payload.get('audio_subtitles') or [{}])[0].get('speech_url')
    if not audio_url:
        raise RuntimeError(f'No speech_url for sentence {i}')
    req = urllib.request.Request(audio_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        clip_path.write_bytes(resp.read())
    clip_paths.append(clip_path)
    print(f'    -> {clip_path.stat().st_size} bytes')

# Step 2: Concatenate all clips into one audio track
print()
print('=== Step 2: Concatenate audio clips ===')
concat_file = OUTPUT_DIR / 'concat.txt'
concat_file.write_text('\n'.join(f"file '{p}'" for p in clip_paths))
full_audio = OUTPUT_DIR / 'original_audio.mp3'
subprocess.run([
    'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
    '-i', str(concat_file),
    '-c', 'copy',
    str(full_audio),
], check=True, capture_output=True)
print(f'  Full audio: {full_audio.stat().st_size} bytes')

# Step 3: Get audio duration
probe = subprocess.run(
    ['ffmpeg', '-i', str(full_audio), '-f', 'null', '-'],
    capture_output=True, text=True
)
import re
dur_match = re.search(r'Duration:\s*(\d+):(\d+):(\d+\.\d+)', probe.stderr)
if dur_match:
    h, m, s = dur_match.groups()
    duration_sec = int(h) * 3600 + int(m) * 60 + float(s)
else:
    duration_sec = 15
print(f'  Audio duration: {duration_sec:.1f}s')

# Step 4: Generate a video with colored background + text overlay,
# then mux with the audio track.
print()
print('=== Step 3: Generate video with background + audio ===')
# Use ffmpeg to generate a video:
#   - 1280x720, 30fps, solid color background
#   - Title text "Test Video - Donghua Pipeline" at top
#   - Mux with the Chinese audio track
#   - Duration matches the audio
subprocess.run([
    'ffmpeg', '-y',
    '-f', 'lavfi', '-i', f'color=c=0x1a1a2e:s=1280x720:d={duration_sec}:r=30',
    '-i', str(full_audio),
    '-vf', (
        "drawtext=text='SleizDev Pipeline Test':"
        "fontcolor=white:fontsize=48:x=(w-text_w)/2:y=80:"
        "box=1:boxcolor=0x16213e@0.8:boxborderw=20,"
        "drawtext=text='Chinese Audio → SRT → Translate → TTS → Subtitles':"
        "fontcolor=0xe94560:fontsize=24:x=(w-text_w)/2:y=160"
    ),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    str(FINAL_VIDEO),
], check=True, capture_output=True)
print(f'  Final video: {FINAL_VIDEO.stat().st_size} bytes ({FINAL_VIDEO.stat().st_size / 1024 / 1024:.1f}MB)')

# Verify the video
print()
print('=== Verification ===')
probe2 = subprocess.run(
    ['ffmpeg', '-i', str(FINAL_VIDEO), '-f', 'null', '-'],
    capture_output=True, text=True
)
for line in probe2.stderr.split('\n'):
    if 'Duration' in line or 'Stream' in line:
        print(f'  {line.strip()}')

print()
print(f'=== DONE ===')
print(f'Test video ready: {FINAL_VIDEO}')
print(f'Use this as input for the full pipeline.')
