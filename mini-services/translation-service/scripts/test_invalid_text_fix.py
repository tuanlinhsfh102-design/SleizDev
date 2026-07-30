#!/usr/bin/env python3
"""Test the fix for the user's TTSInvalidText error.

The user reported:
  [poll] FAILED voice=BV421_vivn_streaming text_len=12 | err=TTSInvalidText | err_code=40402002
  [retry] slot 5 attempt 4/11 failed (InvalidTextError: CapCut rejected text as invalid
          (err_code=40402002): voice=BV421_vivn_streaming text_len=12 text='而且他也掌握着双奥运出行')

Root cause: BV421_vivn_streaming is a VIETNAMESE voice. It cannot synthesize
CHINESE text. The bridge was mapping the user's voice alias (vi_vn_1) to a
Vietnamese voice regardless of the text's script.

Fix: detect_script() in capcut_tts.py now switches to a same-gender Chinese
voice when the text is CJK. The retry loop also skips retries for permanent
errors (err_code=40402002 TTSInvalidText) so we don't waste 10 × 30s = 5min
of backoff on a request that will never succeed.

This test verifies:
  1. detect_script() correctly identifies Chinese text
  2. resolve_voice("vi_vn_1", chinese_text) auto-switches to a Chinese voice
  3. The bridge successfully synthesizes the previously-failing text
  4. A deliberately-permanent error (TTSVoiceNotFound) skips retries
"""
import sys, json, time, subprocess
from pathlib import Path

# Bootstrap vendored SDK
VENDOR_DIR = Path(__file__).resolve().parent.parent / 'vendor'
sys.path.insert(0, str(VENDOR_DIR))

# Import the bridge module so we can test its functions directly
BRIDGE = Path(__file__).resolve().parent / 'capcut_tts.py'
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Load capcut_tts as a module
import importlib.util
spec = importlib.util.spec_from_file_location("capcut_tts_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

PASS = 0
FAIL = 0

def assert_eq(actual, expected, msg):
    global PASS, FAIL
    if actual == expected:
        print(f"  OK  {msg}")
        PASS += 1
    else:
        print(f"  XX  {msg}")
        print(f"       expected: {expected!r}")
        print(f"       actual:   {actual!r}")
        FAIL += 1

def assert_true(cond, msg):
    global PASS, FAIL
    if cond:
        print(f"  OK  {msg}")
        PASS += 1
    else:
        print(f"  XX  {msg}")
        FAIL += 1


# Test 1: detect_script() correctly identifies CJK vs Latin
print("=== Test 1: detect_script() ===")
assert_eq(bridge.detect_script("而且他也掌握着双奥运出行"), "cjk", "Chinese text -> cjk")
assert_eq(bridge.detect_script("Xin chào bạn, hôm nay thế nào?"), "latin", "Vietnamese text -> latin")
assert_eq(bridge.detect_script("Hello world"), "latin", "English text -> latin")
assert_eq(bridge.detect_script("こんにちは世界"), "cjk", "Japanese text -> cjk")
assert_eq(bridge.detect_script("안녕하세요"), "cjk", "Korean text -> cjk")
assert_eq(bridge.detect_script("12345"), "unknown", "Numbers only -> unknown")
assert_eq(bridge.detect_script(""), "unknown", "Empty -> unknown")
assert_eq(bridge.detect_script("你好世界这是测试 hello"), "cjk", "Mixed CJK+Latin (8 CJK + 5 Latin) -> cjk")
assert_eq(bridge.detect_script("hello 你好"), "latin", "Mixed CJK+Latin (5 Latin + 2 CJK) -> latin")
print()


# Test 2: resolve_voice() auto-switches language when text script doesn't match
print("=== Test 2: resolve_voice() auto-switches ===")
# Vietnamese voice + Chinese text -> should switch to Chinese female voice
result = bridge.resolve_voice("vi_vn_1", "而且他也掌握着双奥运出行")
assert_true(result != "BV421_vivn_streaming", f"vi_vn_1 + CJK text does NOT stay as BV421 (got {result})")
assert_eq(result, "zh_female_xiaoyue", "vi_vn_1 + CJK text -> zh_female_xiaoyue")

# Vietnamese male voice + Chinese text -> should switch to Chinese male voice
result = bridge.resolve_voice("vi_vn_2", "而且他也掌握着双奥运出行")
assert_eq(result, "DiT_zh_male_xionger", "vi_vn_2 + CJK text -> DiT_zh_male_xionger")

# Chinese voice + Latin text -> should switch to Vietnamese voice
result = bridge.resolve_voice("zh_vn_1", "Xin chào bạn")
assert_eq(result, "BV421_vivn_streaming", "zh_vn_1 + Latin text -> BV421_vivn_streaming")

# Same-language: no switch needed
result = bridge.resolve_voice("vi_vn_1", "Xin chào")
assert_eq(result, "BV421_vivn_streaming", "vi_vn_1 + Latin text stays as BV421")

result = bridge.resolve_voice("zh_vn_1", "你好")
assert_eq(result, "zh_female_xiaoyue", "zh_vn_1 + CJK text stays as zh_female_xiaoyue")

# No text -> legacy behavior (no script detection)
result = bridge.resolve_voice("vi_vn_1", None)
assert_eq(result, "BV421_vivn_streaming", "vi_vn_1 + no text -> BV421 (legacy)")
print()


# Test 3: actually run the bridge on the EXACT failing text from the user's log
print("=== Test 3: bridge synthesizes previously-failing text ===")
TEST_DIR = Path(__file__).resolve().parent.parent / "test_invalid_text_work"
TEST_DIR.mkdir(exist_ok=True)
output = TEST_DIR / "chinese_clip.mp3"
if output.exists():
    output.unlink()

# Use the EXACT text and voice from the user's error log
cmd = [
    sys.executable,
    str(BRIDGE),
    "--text", "而且他也掌握着双奥运出行",
    "--voice", "vi_vn_1",  # Vietnamese alias — bridge should auto-switch to Chinese
    "--output", str(output),
    "--timeout", "30",
]
start = time.time()
result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
duration = time.time() - start

print(f"  bridge exited with code {result.returncode} in {duration:.1f}s")
# Show last 10 lines of stderr
for line in result.stderr.strip().split("\n")[-10:]:
    print(f"    {line}")

assert_eq(result.returncode, 0, "bridge exit code 0 (success)")
assert_true(output.exists() and output.stat().st_size > 100, f"output MP3 created ({output.stat().st_size if output.exists() else 0} bytes)")
assert_true(duration < 15, f"completed in < 15s (got {duration:.1f}s) — no retry storm")

# Cleanup
import shutil
shutil.rmtree(TEST_DIR, ignore_errors=True)
print()


# Test 4: permanent error (TTSVoiceNotFound) skips retries
print("=== Test 4: permanent error skips retries ===")
TEST_DIR2 = Path(__file__).resolve().parent.parent / "test_permanent_error"
TEST_DIR2.mkdir(exist_ok=True)
output2 = TEST_DIR2 / "should_fail.mp3"

# Use a deliberately-invalid voice_type that doesn't exist in CapCut's catalog
cmd = [
    sys.executable,
    str(BRIDGE),
    "--text", "Hello world",
    "--voice", "BV_TOTALLY_NONEXISTENT_VOICE_xyz123",  # invalid voice_type
    "--output", str(output2),
    "--timeout", "20",
    "--max-retries", "10",  # bridge SHOULD skip all 10 retries
]
start = time.time()
result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
duration = time.time() - start

print(f"  bridge exited with code {result.returncode} in {duration:.1f}s")
# Show all stderr lines mentioning retry/permanent
for line in result.stderr.strip().split("\n"):
    if "retry" in line.lower() or "permanent" in line.lower() or "failed" in line.lower():
        print(f"    {line}")

# KEY assertion: with --max-retries 10 and 2s minimum backoff, if the bridge
# retried 10 times we'd see at least 2+4+8+16+30+30+30+30+30+30 = ~210s.
# With permanent-error skipping, we should be done in < 15s.
assert_true(result.returncode != 0, "bridge exit code non-zero (failure expected)")
assert_true(duration < 20, f"completed in < 20s (got {duration:.1f}s) — retries were SKIPPED")
assert_true(
    "permanent" in result.stderr.lower() or "err_code" in result.stderr.lower(),
    "stderr mentions 'permanent' or 'err_code' (typed error surfaced)"
)
assert_true(
    not output2.exists() or output2.stat().st_size == 0,
    "no output MP3 created for permanent failure"
)

# Cleanup
shutil.rmtree(TEST_DIR2, ignore_errors=True)
print()


print(f"=== Results: {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL > 0 else 0)
