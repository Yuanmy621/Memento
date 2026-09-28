"""剪映草稿工作流的共享工具：路径解析、JSON 读写、时间解析。

脚本之间共用的东西放这里，避免各写一份。本文件不被工作流的阶段闸门识别
（阶段闸门只认 `draft_<阶段>*.py` 的命名），所以可以随便调用。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def state_dir() -> Path:
    """数据目录：`MEMENTO_STATE_DIR` 优先，否则 `<当前目录>/.Memento`。"""
    explicit = os.environ.get("MEMENTO_STATE_DIR")
    if explicit:
        return Path(explicit).expanduser().resolve()
    return (Path.cwd() / ".Memento").resolve()


def work_dir() -> Path:
    """工作流的产物目录：`<stateDir>/draft/`。"""
    return state_dir() / "draft"


def load_json(path: Path) -> Any:
    """读一个 JSON 文件；失败时带文件名报错退出。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"读不到 {path}")
    except json.JSONDecodeError as exc:
        fail(f"{path} 不是合法 JSON：{exc}")


def save_json(path: Path, value: Any) -> None:
    """写一个 JSON 文件（自动建目录）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def config() -> dict[str, Any]:
    """读工作流配置 `<stateDir>/draft/config.json`。

    至少要有 `draftStore`（剪映草稿目录的绝对路径）；`mediaDir` 供盘点阶段使用。
    """
    path = work_dir() / "config.json"
    if not path.exists():
        fail(
            f"缺少 {path}。先写一份，例如：\n"
            '  { "draftStore": "~/Movies/JianyingPro Drafts", "mediaDir": "./footage" }'
        )
    value = load_json(path)
    if not isinstance(value, dict) or not value.get("draftStore"):
        fail(f"{path} 里必须有 draftStore（剪映草稿目录的绝对路径）")
    return value


def draft_store() -> Path:
    """剪映草稿目录（展开 `~`）。"""
    return Path(str(config()["draftStore"])).expanduser().resolve()


def media_dir() -> Path:
    """素材目录；没配就退回当前目录。"""
    raw = config().get("mediaDir") or "."
    return Path(str(raw)).expanduser().resolve()


def fail(message: str) -> None:
    """报错退出（退出码 1），stderr 给原因。"""
    print(f"错误：{message}", file=sys.stderr)
    raise SystemExit(1)


def ok(message: str) -> None:
    """成功时打一行给人看的结果。"""
    print(message)
