"""阶段 1｜素材盘点：扫素材目录，用 ffprobe 读出每个素材的时长与分辨率，产出 survey.json。

产物 `<stateDir>/draft/survey.json` 是「离开盘点阶段」的凭据：`assets` 至少一项，
否则 `draft_stage` 会拒绝推进。

用法：
    python draft_survey.py [素材目录]
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import fail, media_dir, ok, save_json, work_dir  # noqa: E402

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".heic"}


def probe(path: Path) -> dict[str, object]:
    """用 ffprobe 读一个媒体文件的时长与视频尺寸。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        return {"error": (out.stderr or "ffprobe 失败").strip()[:200]}
    data = json.loads(out.stdout or "{}")
    fmt = data.get("format") or {}
    duration = float(fmt.get("duration") or 0.0)
    width = height = 0
    for stream in data.get("streams") or []:
        if stream.get("codec_type") == "video":
            width = int(stream.get("width") or 0)
            height = int(stream.get("height") or 0)
            break
    return {
        "durationUs": int(round(duration * 1_000_000)),
        "width": width,
        "height": height,
        "bytes": int(fmt.get("size") or 0),
    }


def kind_of(path: Path) -> str | None:
    """按扩展名判断素材类型。"""
    ext = path.suffix.lower()
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    if ext in IMAGE_EXT:
        return "image"
    return None


def main() -> int:
    """入口。"""
    if shutil.which("ffprobe") is None:
        fail("找不到 ffprobe，请先安装 ffmpeg")

    root = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else media_dir()
    if not root.is_dir():
        fail(f"{root} 不是目录")

    assets: list[dict[str, object]] = []
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        kind = kind_of(path)
        if kind is None:
            continue
        info = probe(path)
        assets.append({"path": str(path), "kind": kind, "name": path.name, **info})

    target = work_dir() / "survey.json"
    save_json(target, {"root": str(root), "assets": assets})
    usable = [a for a in assets if "error" not in a]
    ok(f"盘点完成：{len(assets)} 个素材（{len(usable)} 个可读）→ {target}")
    for asset in assets[:20]:
        if "error" in asset:
            ok(f"  ✗ {asset['name']}：{asset['error']}")
        else:
            seconds = int(asset["durationUs"]) / 1_000_000
            size = f"{asset['width']}x{asset['height']}" if asset["width"] else "—"
            ok(f"  · {asset['name']}  {asset['kind']}  {seconds:.2f}s  {size}")
    if len(assets) > 20:
        ok(f"  … 其余 {len(assets) - 20} 个见 {target}")
    if not usable:
        fail("一个能读的素材都没有，先确认素材目录与 ffprobe")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
