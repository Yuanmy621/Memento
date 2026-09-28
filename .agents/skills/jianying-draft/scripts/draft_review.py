"""阶段 4｜成片校验：检查草稿结构，并在人确认后产出 review.json。

两件事分开看：
  - **结构检查**是自动的：草稿在不在、有几条轨道几个片段、总时长、有没有过短片段、文本是否为空。
  - **是否认可**必须由人给（`--confirm`）：当前模型看不到画面，只有人能判断「这条剪得对不对」。

两者都通过才写 `passed: true`，`draft_stage` 才会放你进导出阶段。

用法：
    python draft_review.py <草稿名> [--confirm] [--min-clip 0.3]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import draft_store, fail, ok, save_json, work_dir  # noqa: E402

#: 片段的默认最短时长（秒）：比这更短的片段在成片里几乎看不见。
DEFAULT_MIN_CLIP = 0.3

#: 草稿正文的可能文件名（不同剪映版本不一样）。
CONTENT_FILES = ("draft_content.json", "draft_info.json")


def find_content(draft_dir: Path) -> Path | None:
    """在草稿目录里找可以解析的正文文件。"""
    for name in CONTENT_FILES:
        candidate = draft_dir / name
        if candidate.is_file():
            return candidate
    return None


def collect(raw: dict[str, Any], min_clip: float) -> tuple[list[Any], list[Any], int, int, int]:
    """从草稿正文里取出轨道、片段、过短片段数、空文本素材数与总时长（微秒）。"""
    tracks = list(raw.get("tracks") or [])
    segments = [segment for track in tracks for segment in (track.get("segments") or [])]

    end = 0
    short = 0
    for segment in segments:
        timerange = segment.get("target_timerange") or {}
        duration = int(timerange.get("duration") or 0)
        start = int(timerange.get("start") or 0)
        end = max(end, start + duration)
        if 0 < duration < min_clip * 1_000_000:
            short += 1

    empty_text = 0
    for material in (raw.get("materials") or {}).get("texts") or []:
        content = material.get("content")
        text = ""
        if isinstance(content, str):
            try:
                text = str(json.loads(content).get("text") or "")
            except Exception:  # noqa: BLE001 —— content 的形态随剪映版本变化
                text = content
        if text.strip() == "":
            empty_text += 1

    return tracks, segments, short, empty_text, end


def main() -> int:
    """入口。"""
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    confirmed = "--confirm" in sys.argv
    min_clip = DEFAULT_MIN_CLIP
    if "--min-clip" in sys.argv:
        index = sys.argv.index("--min-clip")
        try:
            min_clip = float(sys.argv[index + 1])
        except (IndexError, ValueError):
            fail("--min-clip 后面要跟一个秒数")

    if not argv:
        fail("用法：python draft_review.py <草稿名> [--confirm] [--min-clip 0.3]")
    name = argv[0]
    draft_dir = draft_store() / name
    if not draft_dir.is_dir():
        fail(f"草稿目录不存在：{draft_dir}")

    checks: list[dict[str, object]] = []
    warnings: list[str] = []

    content = find_content(draft_dir)
    raw: dict[str, Any] | None = None
    if content is None:
        checks.append({"name": "正文文件", "ok": False, "detail": f"{draft_dir} 里没有 {' / '.join(CONTENT_FILES)}"})
    else:
        checks.append({"name": "正文文件", "ok": True, "detail": content.name})
        try:
            raw = json.loads(content.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 —— 剪映 6+ 可能写入非明文，异常类型由版本决定
            warnings.append(f"{content.name} 不是明文 JSON（剪映 6+ 的草稿可能被加密），结构检查已跳过")

    if raw is not None:
        tracks, segments, short, empty_text, end = collect(raw, min_clip)
        checks.append({"name": "轨道数", "ok": len(tracks) > 0, "detail": f"{len(tracks)} 条"})
        checks.append({"name": "片段数", "ok": len(segments) > 0, "detail": f"{len(segments)} 个"})
        checks.append({"name": "总时长", "ok": end > 0, "detail": f"{end / 1_000_000:.2f}s"})
        checks.append({"name": f"过短片段（<{min_clip}s）", "ok": short == 0, "detail": f"{short} 个"})
        checks.append({"name": "空文本素材", "ok": empty_text == 0, "detail": f"{empty_text} 个"})

    checks.append({
        "name": "人工确认",
        "ok": confirmed,
        "detail": "已确认" if confirmed else "未确认 —— 在剪映里看过成片后再加 --confirm",
    })

    passed = all(bool(check["ok"]) for check in checks)
    target = work_dir() / "review.json"
    save_json(target, {"draft": name, "passed": passed, "checks": checks, "warnings": warnings})

    for check in checks:
        ok(f"  {'✓' if check['ok'] else '✗'} {check['name']}：{check['detail']}")
    for warning in warnings:
        ok(f"  ! {warning}")
    ok(f"passed={passed} → {target}")
    if not passed:
        fail("校验未通过；补齐上面的项再跑一次")
    ok("校验通过。下一步：draft_stage action=advance，然后 draft_export.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
