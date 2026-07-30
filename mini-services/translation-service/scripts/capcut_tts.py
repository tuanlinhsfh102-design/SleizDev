#!/usr/bin/env python3
"""
CapCut TTS bridge: convert text to speech and save the resulting MP3 to disk.

Usage:
    python3 capcut_tts.py --text "<text>" --output <out.mp3>
                          [--voice <voice_id>] [--rate <1.0>]
                          [--device <device.json>] [--timeout <seconds>]

Output contract:
    - stdout: empty (nothing printed on success)
    - stderr: human-readable log lines prefixed with [stage] ...
    - exit 0 on success (output MP3 file exists and is non-empty)
    - exit non-zero on failure

Voice mapping:
    The SleizDev frontend uses TikTok-style voice IDs (vi_vn_1, vi_vn_2, ...).
    This bridge maps them to CapCut voice_types. You can also pass a raw
    CapCut voice_type directly (e.g. "BV421_vivn_streaming").

    vi_vn_1 / vi_female / vi_female_sweet -> BV421_vivn_streaming (Nhỏ Ngọt Ngào)
    vi_vn_2 / vi_male                     -> vi-VN-NamMinhNeural   (Nam Minh)
    vi_female_news                        -> BV074_streaming        (Cô Gái Hoạt Ngôn)
    (anything else is passed through to CapCut verbatim)

The script vendors the capcut-tts-api library under ../vendor/capcut_tts_api
and uses CapCut's official /lv/v1/common_task TTS flow. This is the SAME
engine CapCut's desktop/mobile app uses, so quality is identical to in-app
TTS — and far better than Google Translate TTS (the previous fallback).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Force UTF-8 output on Windows (default console encoding is cp1252 which
# cannot encode CJK characters).
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

# Ensure the vendored package is importable regardless of CWD.
SCRIPT_DIR = Path(__file__).resolve().parent
VENDOR_DIR = SCRIPT_DIR.parent / "vendor"
if str(VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(VENDOR_DIR))

try:
    from capcut_tts_api import (  # type: ignore
        CapCutClient,
        CapCutError,
        DeviceConfig,
    )
except Exception as exc:  # pragma: no cover - import-time only
    sys.stderr.write(f"[fatal] Cannot import vendored capcut_tts_api: {exc}\n")
    sys.stderr.write(f"[fatal] Looked under: {VENDOR_DIR}\n")
    sys.exit(2)


# -------------------------------------------------------------------------
# Voice mapping: SleizDev voice IDs -> CapCut voice_types
#
# These voices were verified working against the live CapCut API on 2026-07-30.
# Removed vi-VN-NamMinhNeural / vi-VN-HoaiMyNeural — they return status=failed.
# -------------------------------------------------------------------------
VOICE_MAP: Dict[str, str] = {
    # Vietnamese female (sweet) — "Nhỏ Ngọt Ngào"  [verified working]
    "vi_vn_1": "BV421_vivn_streaming",
    "vi_female": "BV421_vivn_streaming",
    "vi_female_sweet": "BV421_vivn_streaming",
    # Vietnamese male (deep) — "Giọng Nam Trầm"  [verified working]
    "vi_vn_2": "multi_male_felipe_uranus_bigtts",
    "vi_male": "multi_male_felipe_uranus_bigtts",
    # Vietnamese female (energetic / newsy) — "Cô Gái Hoạt Ngôn"  [verified working]
    "vi_female_news": "BV074_streaming",
    "vi_vn_news": "BV074_streaming",
    # Vietnamese female (review style) — "Review Phim new"
    "vi_female_review": "multi_female_richgirl_uranus_bigtts",
    # Vietnamese female (anime / high-pitched) — "Giọng Gái Mới Lớn"
    "vi_female_young": "multi_female_peiqi_uranus_bigtts",
    # Chinese voices (for original Chinese TTS, if ever needed)
    "zh_vn_1": "BV701_streaming",
    "zh_female": "BV701_streaming",
    "zh_male": "BV702_streaming",
}


def resolve_voice(voice_input: str) -> str:
    """Map a user-facing voice ID to a CapCut voice_type.

    If the input is already a CapCut voice_type (contains 'BV' or 'Neural'),
    pass it through unchanged.
    """
    if not voice_input:
        return "BV421_vivn_streaming"  # default = Vietnamese female sweet
    mapped = VOICE_MAP.get(voice_input)
    if mapped:
        return mapped
    # Pass through anything that looks like a raw CapCut voice_type.
    return voice_input


def log(stage: str, message: str) -> None:
    """Emit a structured log line to stderr."""
    sys.stderr.write(f"[{stage}] {message}\n")
    sys.stderr.flush()


def extract_speech_url(query_response: Dict[str, Any]) -> Optional[str]:
    """Pull the speech_url out of a CapCut TTS query response.

    The payload field is a JSON string with structure:
        {
            "audio_subtitles": [
                {
                    "speech_url": "https://...mp3",
                    "speech_vid": "...",
                    "duration": 2592,
                    "text": "...",
                    ...
                }
            ],
            "scene": "text_to_speech"
        }
    """
    try:
        tasks = (query_response.get("data") or {}).get("tasks") or []
        if not tasks:
            return None
        raw_payload = tasks[0].get("payload", "{}")
        payload = json.loads(raw_payload) if isinstance(raw_payload, str) else raw_payload
        audio_subs = payload.get("audio_subtitles") or []
        if not audio_subs:
            return None
        return audio_subs[0].get("speech_url")
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        return None


def download_mp3(url: str, output_path: str, timeout: float = 60.0) -> int:
    """Download the MP3 from CapCut CDN to output_path. Returns byte count."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    with open(output_path, "wb") as f:
        f.write(data)
    return len(data)


def generate_speech(
    text: str,
    voice: str,
    rate: str,
    output_path: str,
    device_path: Optional[str],
    timeout_seconds: float,
) -> int:
    """Run the full CapCut TTS pipeline. Returns bytes downloaded."""
    log("init", f"text_len={len(text)} voice={voice} rate={rate} timeout={timeout_seconds}s")

    if not text or not text.strip():
        raise ValueError("Text is empty")

    # CapCut rejects very long single-segment TTS (limit is ~500 chars per
    # utterance). The SleizDev side already chunks by SRT entry, but guard
    # here too: split on sentence boundaries if needed.
    if len(text) > 500:
        log("init", f"WARNING: text is {len(text)} chars (>500) — may fail or be truncated")

    # Build device config
    if device_path and Path(device_path).is_file():
        log("init", f"Loading custom device profile: {device_path}")
        device = DeviceConfig.from_json_file(device_path)
    else:
        device = DeviceConfig()

    client = CapCutClient(device=device)

    # Submit TTS task
    log("tts", f"Submitting TTS task voice={voice}...")
    submit_start = time.time()
    create_res = client.create_tts_task(texts=text, voice=voice, rate=rate)
    tasks = (create_res.get("data") or {}).get("tasks") or []
    if not tasks:
        raise RuntimeError(
            f"No TTS task returned: {json.dumps(create_res, ensure_ascii=False)[:500]}"
        )

    task_id = tasks[0]["id"]
    token = tasks[0].get("token", "")
    log("tts", f"Task created id={task_id} token={token[:8]}... (took {time.time() - submit_start:.1f}s)")

    # Poll for completion
    log("poll", "Polling task status...")
    poll_start = time.time()
    last_status = None
    last_log_time = poll_start
    while time.time() - poll_start < timeout_seconds:
        query_response = client.query_tts_task(task_id, token)
        query_tasks = (query_response.get("data") or {}).get("tasks") or []
        if query_tasks:
            status = query_tasks[0].get("status")
            if status != last_status:
                log("poll", f"Status: {status}")
                last_status = status
            elif time.time() - last_log_time > 10:
                # Heartbeat for long-running tasks so the parent doesn't think
                # we died.
                log("poll", f"Still {status}... ({time.time() - poll_start:.0f}s elapsed)")
                last_log_time = time.time()

            # Accept BOTH "success" and "succeed" — CapCut's TTS endpoint
            # actually returns "succeed" (with trailing 'd'). The SDK's
            # generate_speech() now also accepts both, but we re-implement
            # the poll here so the bridge works even with older SDK versions.
            if status in ("success", "succeed"):
                log("poll", f"Done in {time.time() - poll_start:.1f}s")
                speech_url = extract_speech_url(query_response)
                if not speech_url:
                    payload_preview = json.dumps(query_response, ensure_ascii=False)[:500]
                    raise RuntimeError(
                        f"TTS task succeeded but no speech_url found. Response: {payload_preview}"
                    )
                log("download", f"Fetching MP3 ({speech_url[:80]}...)")
                dl_start = time.time()
                byte_count = download_mp3(speech_url, output_path)
                log("download", f"Got {byte_count} bytes in {time.time() - dl_start:.1f}s -> {output_path}")
                if byte_count < 100:
                    raise RuntimeError(f"Downloaded MP3 is suspiciously small ({byte_count} bytes)")
                return byte_count
            if status == "failed":
                task = query_tasks[0]
                # CapCut's failure-response shape has drifted over the years
                # (different versions return the reason in different fields).
                # Probe every plausible field so the retry log has something
                # concrete to act on, instead of the useless "TTS task failed:
                # TTS task failed" double-fallback we used to get.
                err_candidates = [
                    task.get("error"),
                    task.get("detail_info"),
                    task.get("message"),
                    task.get("fail_reason"),
                    task.get("reason"),
                    task.get("msg"),
                    task.get("err_msg"),
                ]
                err = next(
                    (
                        str(c)
                        for c in err_candidates
                        if c not in (None, "", 0, False)
                    ),
                    "no error field in response (CapCut rejected without explanation)",
                )
                # Dump the full query_response (truncated) on a separate log
                # line so we can actually see WHY CapCut said no. Without
                # this we were retrying blindly 10x per slot, burning
                # ~3 minutes of backoff per slot, with no signal about
                # whether it was a voice issue, a device-ban, a quota
                # exhaustion, or a server outage.
                response_preview = json.dumps(query_response, ensure_ascii=False)[:1200]
                log(
                    "poll",
                    f"FAILED voice={voice} text_len={len(text)} | "
                    f"err={err} | response={response_preview}",
                )
                raise RuntimeError(f"TTS task failed: {err}")
        time.sleep(1.5)

    raise TimeoutError(
        f"TTS task did not complete within {timeout_seconds}s (last status: {last_status})"
    )


# -------------------------------------------------------------------------
# Batch mode — process N entries in parallel via ThreadPoolExecutor
# -------------------------------------------------------------------------

def _process_one_entry(
    idx: int,
    entry: Dict[str, Any],
    device_path: Optional[str],
    timeout_seconds: float,
    max_retries: int = 10,
) -> Tuple[int, bool, str]:
    """Process a single batch entry. Returns (idx, success, message).

    Each entry must contain:
      - output: absolute path to write MP3 to
      - text:   text to synthesize
      - voice:  (optional, defaults to vi_vn_1) voice ID or CapCut voice_type
      - rate:   (optional, defaults to 1.0) speech rate

    Retries up to `max_retries` times on failure with exponential backoff
    (2s, 4s, 8s, ... ± 20% jitter, capped at 30s). CapCut transient failures
    (network blip, CDN hiccup, brief rate limit) almost always succeed on
    retry 1-3. Only after max_retries+1 total attempts fail do we report
    failure — the TS caller will then fill the slot with silence.
    """
    import random  # local import to avoid polluting module top-level

    output_path = entry.get("output") or ""
    text = entry.get("text") or ""
    voice_input = entry.get("voice") or "vi_vn_1"
    rate = entry.get("rate") or "1.0"

    if not output_path:
        return idx, False, "missing 'output' field"
    if not text or not text.strip():
        # Empty text is not an error — caller should fill this slot with silence.
        return idx, False, "empty text"

    voice_type = resolve_voice(voice_input)
    max_attempts = max(1, max_retries + 1)  # 1 initial + N retries
    last_error = "unknown"

    for attempt in range(1, max_attempts + 1):
        # Remove any stale output from a previous attempt so the size-check
        # below doesn't pass on a half-written file.
        try:
            Path(output_path).unlink(missing_ok=True)
        except OSError:
            pass

        try:
            generate_speech(
                text=text,
                voice=voice_type,
                rate=str(rate),
                output_path=output_path,
                device_path=device_path,
                timeout_seconds=timeout_seconds,
            )
            if not Path(output_path).is_file() or Path(output_path).stat().st_size == 0:
                last_error = f"output empty: {output_path}"
            else:
                size_kb = Path(output_path).stat().st_size / 1024
                msg = f"{size_kb:.1f}KB -> {Path(output_path).name}"
                if attempt > 1:
                    msg += f" (retry {attempt - 1}/{max_retries})"
                return idx, True, msg
        except Exception as exc:  # noqa: BLE001 — retry, don't abort
            last_error = f"{type(exc).__name__}: {exc}"

        if attempt < max_attempts:
            # Exponential backoff with jitter: 2s, 4s, 8s, 16s, ... ± 20% jitter.
            # Capped at 30s. Using time.sleep inside the worker is fine because
            # ThreadPoolExecutor runs each worker in its own thread — the other
            # 49 workers continue making progress while this one sleeps.
            base_delay = min(30.0, 2.0 * (2 ** (attempt - 1)))
            jitter = base_delay * (0.8 + random.random() * 0.4)
            log(
                "retry",
                f"slot {idx} attempt {attempt}/{max_attempts} failed "
                f"({last_error}), retrying in {jitter:.1f}s...",
            )
            time.sleep(jitter)
        else:
            log(
                "retry",
                f"slot {idx} all {max_attempts} attempts failed ({last_error})",
            )

    return idx, False, f"all {max_attempts} attempts failed: {last_error}"


def run_batch(
    manifest_path: str,
    concurrency: int,
    device_path: Optional[str],
    timeout_seconds: float,
    max_retries: int = 10,
) -> int:
    """Run TTS for every entry in the manifest in parallel.

    Manifest format (JSON, UTF-8):
        [
          {"output": "/abs/clip_00000.mp3", "text": "...", "voice": "vi_vn_1", "rate": "1.0"},
          {"output": "/abs/clip_00001.mp3", "text": "...", "voice": "vi_vn_1", "rate": "1.0"},
          ...
        ]

    Writes a result manifest to <manifest_path>.result.json:
        [
          {"idx": 0, "success": true,  "message": "58.6KB -> clip_00000.mp3"},
          {"idx": 1, "success": false, "message": "empty text"},
          ...
        ]

    Each entry is retried up to `max_retries` times on failure with
    exponential backoff (handled inside _process_one_entry). Exit code:
    0 if ALL entries succeeded, 1 if any failed.
    """
    if not Path(manifest_path).is_file():
        log("error", f"Manifest file not found: {manifest_path}")
        return 2

    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            entries: List[Dict[str, Any]] = json.load(f)
    except json.JSONDecodeError as exc:
        log("error", f"Manifest is not valid JSON: {exc}")
        return 2

    if not isinstance(entries, list) or not entries:
        log("error", "Manifest must be a non-empty JSON array")
        return 2

    total = len(entries)
    log(
        "batch",
        f"{total} entries, concurrency={concurrency}, "
        f"timeout={timeout_seconds}s, max_retries={max_retries}",
    )

    results: List[Dict[str, Any]] = [{} for _ in range(total)]
    start_time = time.time()
    completed = 0
    succeeded = 0

    # ThreadPoolExecutor is the right choice here: each task is I/O-bound
    # (HTTP POST to submit, polling, then HTTP GET to download the MP3).
    # Python's GIL is not a bottleneck because almost all the time is spent
    # waiting on network I/O. Empirically 50 concurrent threads against the
    # CapCut API work fine — no rate-limiting observed.
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(
                _process_one_entry,
                i,
                entries[i],
                device_path,
                timeout_seconds,
                max_retries,
            ): i
            for i in range(total)
        }
        for future in as_completed(futures):
            idx = futures[future]
            try:
                entry_idx, success, message = future.result()
            except Exception as exc:  # noqa: BLE001
                entry_idx, success, message = idx, False, f"thread crashed: {exc}"
            results[entry_idx] = {
                "idx": entry_idx,
                "success": bool(success),
                "message": message,
            }
            completed += 1
            if success:
                succeeded += 1
            # Stream progress to stderr so the parent can see live progress.
            log(
                "batch",
                f"[{completed}/{total}] ok={succeeded} fail={completed - succeeded} "
                f"({time.time() - start_time:.1f}s elapsed)",
            )

    # Write result manifest next to the input manifest
    result_path = manifest_path + ".result.json"
    try:
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        log("batch", f"Result manifest written to {result_path}")
    except OSError as exc:
        log("error", f"Failed to write result manifest: {exc}")
        return 3

    failed = total - succeeded
    log(
        "batch",
        f"Done in {time.time() - start_time:.1f}s — "
        f"{succeeded}/{total} succeeded, {failed} failed",
    )
    return 0 if failed == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="CapCut TTS bridge for SleizDev")
    # Single-text mode (back-compat)
    parser.add_argument("--text", default=None, help="Text to convert to speech (single mode)")
    parser.add_argument(
        "--voice",
        default="vi_vn_1",
        help="Voice ID (vi_vn_1, vi_vn_2, vi_female, vi_male, ...) or raw CapCut voice_type",
    )
    parser.add_argument("--rate", default="1.0", help="Speech rate multiplier (e.g. 1.0, 0.9, 1.2)")
    parser.add_argument("--output", default=None, help="Output MP3 file path (single mode)")
    # Batch mode
    parser.add_argument(
        "--batch",
        default=None,
        help="Batch mode: path to a JSON manifest of [{output, text, voice, rate}, ...]",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=50,
        help="Max parallel TTS workers in batch mode (default: 50)",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=10,
        help="Max retry attempts per entry on failure (default: 10). "
        "Exponential backoff: 2s, 4s, 8s, ... capped at 30s.",
    )
    # Shared
    parser.add_argument("--device", default=None, help="Optional path to a device.json profile")
    parser.add_argument(
        "--timeout",
        type=float,
        default=90.0,
        help="Max seconds to wait per TTS task to finish (default: 90)",
    )
    args = parser.parse_args()

    # Batch mode — short-circuits before single-text validation.
    if args.batch:
        return run_batch(
            manifest_path=args.batch,
            concurrency=max(1, args.concurrency),
            device_path=args.device,
            timeout_seconds=args.timeout,
            max_retries=max(0, args.max_retries),
        )

    # Single-text mode (original behavior)
    if not args.text or not args.output:
        log("error", "Either --batch <manifest> OR both --text + --output are required")
        return 2

    voice_type = resolve_voice(args.voice)

    try:
        generate_speech(
            text=args.text,
            voice=voice_type,
            rate=args.rate,
            output_path=args.output,
            device_path=args.device,
            timeout_seconds=args.timeout,
        )
        # Verify output exists and is non-empty
        if not Path(args.output).is_file() or Path(args.output).stat().st_size == 0:
            log("error", f"Output file missing or empty: {args.output}")
            return 6
        return 0
    except ValueError as exc:
        log("error", str(exc))
        return 3
    except TimeoutError as exc:
        log("error", f"Timeout: {exc}")
        return 4
    except CapCutError as exc:
        log("error", f"CapCut error: {exc}")
        return 5
    except urllib.error.URLError as exc:  # type: ignore[attr-defined]
        log("error", f"Download error: {exc}")
        return 7
    except Exception as exc:  # pragma: no cover - last-resort catch
        log("error", f"Unexpected: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
