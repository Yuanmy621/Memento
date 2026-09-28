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
    """读工作流配置 `<stateDir>/draft/config.json`（整个文件都可选）。

    两个键：
      - `draftStore` —— 剪映草稿目录。**可以不写**，会自动去读剪映的配置；
      - `mediaDir` —— 素材目录，盘点阶段用；不写就是当前目录。
    """
    path = work_dir() / "config.json"
    if not path.exists():
        return {}
    value = load_json(path)
    if not isinstance(value, dict):
        fail(f"{path} 必须是一个 JSON 对象")
    return value


def draft_store() -> Path:
    """剪映草稿目录。

    取值顺序：
      1. `config.json` 里的 `draftStore`（人显式指定的，最权威）；
      2. **剪映自己的配置文件**里的 `currentCustomDraftPath` —— 即「全局设置 → 草稿位置」那一项；
      3. 都没有就报错，让人去剪映里查一下。

    第 2 条是 macOS 上的关键：剪映是沙盒应用，草稿在
    `~/Library/Containers/com.lemon.lvpro/Data/Movies/JianyingPro/User Data/` 下，
    而这个路径**会被用户在设置里改掉**，所以不能写死。
    """
    explicit = config().get("draftStore")
    if explicit:
        return Path(str(explicit)).expanduser().resolve()
    detected = detect_draft_store()
    if detected is not None:
        return detected
    fail(
        "定位不到剪映草稿目录。两种办法：\n"
        "  · 在 config.json 里写死 draftStore；\n"
        "  · 或在剪映「全局设置 → 草稿位置」里确认路径后重试。"
    )
    raise AssertionError


#: 剪映配置文件的可能位置（沙盒容器优先，其次是家目录下的软链视图）。
SETTING_FILES = (
    "~/Library/Containers/com.lemon.lvpro/Data/Movies/JianyingPro/User Data/Config/globalSetting",
    "~/Movies/JianyingPro/User Data/Config/globalSetting",
)

#: 配置里草稿位置的键名。
DRAFT_PATH_KEY = "currentCustomDraftPath"


def detect_draft_store() -> Path | None:
    """读剪映的 `globalSetting`，取它记的草稿位置。"""
    for pattern in SETTING_FILES:
        path = Path(pattern).expanduser()
        if not path.is_file():
            continue
        try:
            for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith(f"{DRAFT_PATH_KEY}="):
                    value = line.split("=", 1)[1].strip()
                    if value:
                        return Path(value).expanduser().resolve()
        except OSError:
            continue
    return None


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
