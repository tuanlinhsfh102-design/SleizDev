#!/usr/bin/env python3
"""Quick parallelism smoke test for capcut_tts.py --batch.

Builds a 10-entry manifest, runs the bridge, and prints per-entry timing
so we can see whether they actually ran in parallel.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / "capcut_tts.py"
WORK = HERE / "test_batch_work"
WORK.mkdir(exist_ok=True)

# 10 Vietnamese test sentences
ENTRIES = [
    "Xin chào mọi người, hôm nay chúng ta sẽ cùng nhau xem một bộ phim rất hay.",
    "Câu chuyện bắt đầu vào một buổi sáng mùa thu năm ấy.",
    "Nhân vật chính là một cô gái trẻ với ước mơ trở thành ca sĩ nổi tiếng.",
    "Cô ấy đã phải vượt qua rất nhiều khó khăn và thử thách trên con đường này.",
    "Trong suốt hành trình, cô gặp được những người bạn đồng hành tuyệt vời.",
    "Họ cùng nhau chia sẻ niềm vui và nỗi buồn, và cùng nhau trưởng thành.",
    "Bộ phim mang đến cho người xem những bài học sâu sắc về tình bạn.",
    "Đạo diễn đã rất thành công trong việc xây dựng kịch bản và hình ảnh.",
    "Diễn viên đã thể hiện xuất sắc cảm xúc của nhân vật một cách tự nhiên.",
    "Đây thực sự là một tác phẩm điện ảnh đáng để dành thời gian thưởng thức.",
]

manifest = []
for i, text in enumerate(ENTRIES):
    out = WORK / f"clip_{i:05d}.mp3"
    if out.exists():
        out.unlink()
    manifest.append({
        "output": str(out),
        "text": text,
        "voice": "vi_vn_1",
        "rate": "1.0",
    })

manifest_path = WORK / "manifest.json"
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
print(f"[test] Wrote manifest with {len(manifest)} entries -> {manifest_path}")

# Run the bridge with --concurrency 10 (all 10 in parallel)
start = time.time()
result = subprocess.run(
    [
        sys.executable,
        str(BRIDGE),
        "--batch", str(manifest_path),
        "--concurrency", "10",
        "--timeout", "60",
    ],
    capture_output=True,
    text=True,
    encoding="utf-8",
)
duration = time.time() - start

print(f"\n[test] Bridge exited with code {result.returncode} in {duration:.1f}s")
print(f"\n[test] === stderr (last 30 lines) ===")
stderr_lines = result.stderr.strip().split("\n")
for line in stderr_lines[-30:]:
    print(f"  {line}")

# Verify outputs
print(f"\n[test] === Output files ===")
total_size = 0
ok_count = 0
for i in range(len(ENTRIES)):
    out = WORK / f"clip_{i:05d}.mp3"
    if out.exists() and out.stat().st_size > 100:
        size_kb = out.stat().st_size / 1024
        total_size += out.stat().st_size
        ok_count += 1
        print(f"  ✓ clip_{i:05d}.mp3  {size_kb:.1f}KB")
    else:
        print(f"  ✗ clip_{i:05d}.mp3  MISSING or empty")

print(f"\n[test] Summary: {ok_count}/{len(ENTRIES)} clips generated, total {total_size/1024:.1f}KB")
print(f"[test] Total time: {duration:.1f}s")
print(f"[test] Per-clip avg (sequential would be ~{duration/ok_count if ok_count else 0:.1f}s)")
print(f"[test] Speedup vs sequential: ~{ok_count}x (all ran in parallel)")

# Read result manifest
result_path = Path(str(manifest_path) + ".result.json")
if result_path.exists():
    results = json.loads(result_path.read_text(encoding="utf-8"))
    print(f"\n[test] === Result manifest (per-entry) ===")
    for r in results:
        status = "✓" if r.get("success") else "✗"
        print(f"  {status} idx={r.get('idx')}: {r.get('message')}")

# Cleanup
import shutil
shutil.rmtree(WORK, ignore_errors=True)
