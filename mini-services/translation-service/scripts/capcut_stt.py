#!/usr/bin/env python3
"""
CapCut STT bridge: transcribe a local audio/video file and emit SRT to stdout.

Usage:
    python3 capcut_stt.py --audio <path> --language <code> [--device <device.json>]
                          [--translation-language <code>] [--timeout <seconds>]

Output contract:
    - stdout: pure SRT content (empty if transcription failed)
    - stderr: human-readable log lines prefixed with [stage] ...
    - exit 0 on success (with non-empty SRT)
    - exit non-zero on failure

The script vendors the capcut-tts-api library under ../vendor/capcut_tts_api
and uses CapCut's official /lv/v1/common_task API flow (VOD upload + STT task +
poll). No fictional endpoints.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

# Force UTF-8 output on Windows (default console encoding is cp1252 which
# cannot encode CJK characters returned by CapCut STT).
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
    sys.stderr.write(
        f"[fatal] Looked under: {VENDOR_DIR}\n"
    )
    sys.exit(2)


def log(stage: str, message: str) -> None:
    """Emit a structured log line to stderr."""
    sys.stderr.write(f"[{stage}] {message}\n")
    sys.stderr.flush()


def ms_to_srt_time(ms: int) -> str:
    """Convert milliseconds to SRT timestamp HH:MM:SS,mmm."""
    if ms < 0:
        ms = 0
    hours = ms // 3_600_000
    minutes = (ms % 3_600_000) // 60_000
    seconds = (ms % 60_000) // 1000
    millis = ms % 1000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def build_srt(utterances: List[Dict[str, Any]]) -> str:
    """Render utterances to SRT string."""
    lines: List[str] = []
    for idx, utt in enumerate(utterances, start=1):
        text = (utt.get("text") or "").strip()
        if not text:
            continue
        start_ms = int(utt.get("start_time") or 0)
        end_ms = int(utt.get("end_time") or start_ms)
        if end_ms <= start_ms:
            end_ms = start_ms + 500
        lines.append(str(idx))
        lines.append(f"{ms_to_srt_time(start_ms)} --> {ms_to_srt_time(end_ms)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def transcribe(
    audio_path: str,
    language: str,
    translation_language: str | None,
    use_translation: bool,
    device_path: str | None,
    timeout_seconds: float,
) -> str:
    """Run the full CapCut STT pipeline and return the SRT string."""
    log("init", f"audio={audio_path} language={language} timeout={timeout_seconds}s")

    if not Path(audio_path).is_file():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    # Build device config (optional custom device.json)
    if device_path and Path(device_path).is_file():
        log("init", f"Loading custom device profile: {device_path}")
        device = DeviceConfig.from_json_file(device_path)
    else:
        device = DeviceConfig()

    client = CapCutClient(device=device)

    log("upload", "Uploading media to CapCut VOD...")
    upload_start = time.time()
    upload_result = client.upload_audio(audio_path)
    log(
        "upload",
        f"Done in {time.time() - upload_start:.1f}s "
        f"vid={upload_result.vid} md5={upload_result.md5} "
        f"duration_ms={upload_result.duration_ms}",
    )

    log("stt", "Creating STT task...")
    stt_response = client.create_stt_task(
        audio_vid=upload_result.vid,
        audio_md5=upload_result.md5,
        duration_ms=upload_result.duration_ms or 10_000,
        language=language,
        translation_language=translation_language or "vi-VN",
        use_translation=use_translation,
    )

    tasks = (stt_response.get("data") or {}).get("tasks") or []
    if not tasks:
        raise RuntimeError(f"No STT task returned: {json.dumps(stt_response)[:500]}")

    task_id = tasks[0]["id"]
    token = tasks[0].get("token", "")
    log("stt", f"Task created id={task_id} token={token[:8]}...")

    # Poll for completion
    log("poll", "Polling task status...")
    poll_start = time.time()
    last_status = None
    while time.time() - poll_start < timeout_seconds:
        query_response = client.query_stt_task(task_id, token)
        query_tasks = (query_response.get("data") or {}).get("tasks") or []
        if query_tasks:
            status = query_tasks[0].get("status")
            if status != last_status:
                log("poll", f"Status: {status}")
                last_status = status
            # CapCut TTS tasks return status="success" while STT tasks return
            # status="succeed" — accept both so we don't loop forever waiting
            # for a string that never arrives.
            if status in ("success", "succeed"):
                log("poll", f"Done in {time.time() - poll_start:.1f}s")
                subtitles = client.extract_subtitles(query_response)
                utterances = [
                    {
                        "text": u.text,
                        "start_time": u.start_time,
                        "end_time": u.end_time,
                    }
                    for u in subtitles.utterances
                ]
                log("parse", f"Got {len(utterances)} utterance(s)")
                srt = build_srt(utterances)
                if not srt.strip():
                    log("parse", "WARNING: subtitles were empty")
                return srt
            if status == "failed":
                err_msg = query_tasks[0].get("error") or "STT task failed"
                raise RuntimeError(f"STT task failed: {err_msg}")
        time.sleep(2.0)

    raise TimeoutError(
        f"STT task did not complete within {timeout_seconds}s (last status: {last_status})"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="CapCut STT bridge for SleizDev")
    parser.add_argument("--audio", required=True, help="Path to local audio/video file")
    parser.add_argument(
        "--language",
        default="zh-CN",
        help="Source language code (e.g. zh-CN, vi-VN, en-US)",
    )
    parser.add_argument(
        "--translation-language",
        default=None,
        help="Optional translation target language (e.g. vi-VN)",
    )
    parser.add_argument(
        "--use-translation",
        action="store_true",
        help="Request translation alongside transcription",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Optional path to a device.json profile",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=180.0,
        help="Max seconds to wait for the STT task to finish (default: 180)",
    )
    args = parser.parse_args()

    try:
        srt = transcribe(
            audio_path=args.audio,
            language=args.language,
            translation_language=args.translation_language,
            use_translation=args.use_translation,
            device_path=args.device,
            timeout_seconds=args.timeout,
        )
        # Pure SRT to stdout, nothing else.
        sys.stdout.write(srt)
        sys.stdout.flush()
        return 0
    except FileNotFoundError as exc:
        log("error", str(exc))
        return 3
    except TimeoutError as exc:
        log("error", f"Timeout: {exc}")
        return 4
    except CapCutError as exc:
        log("error", f"CapCut error: {exc}")
        return 5
    except Exception as exc:  # pragma: no cover - last-resort catch
        log("error", f"Unexpected: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
