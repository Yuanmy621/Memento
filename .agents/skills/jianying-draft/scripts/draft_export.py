"""阶段 5｜导出交付：把草稿渲染成 mp4。

导出**不是纯软件问题**：桌面版剪映没有可编程的导出接口，pyJianYingDraft 的自动导出
依赖剪映可见控件，只在 Windows + 剪映 6 及以下有效。所以本脚本按平台分两路：

  - **Windows 且装了 uiautomation**：调 `JianyingController` 自动导出；
  - **其它平台（含 macOS）**：打印人工导出清单并正常退出 —— 这一步必须由人完成。

用法：
    python draft_export.py <草稿名> [输出路径]
"""

from __future__ import annotations

import platform
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import draft_store, fail, ok  # noqa: E402

#: 人工导出清单（非 Windows 平台打印这些）。
MANUAL_STEPS = (
    "1. 打开剪映专业版，在「草稿」列表里找到这份草稿（没有就先进出一次别的草稿刷新列表）",
    "2. 从头到尾看一遍：转场、字幕、音量、结尾是否干净",
    "3. 点「导出」，选分辨率与帧率，导出到目标目录",
    "4. 确认导出成功后再跑：draft_stage action=advance",
)


def main() -> int:
    """入口。"""
    if len(sys.argv) < 2:
        fail("用法：python draft_export.py <草稿名> [输出路径]")
    name = sys.argv[1].strip()
    output = Path(sys.argv[2]).expanduser().resolve() if len(sys.argv) > 2 else None
    draft_dir = draft_store() / name
    if not draft_dir.is_dir():
        fail(f"草稿目录不存在：{draft_dir}")

    if platform.system() == "Windows":
        try:
            import pyJianYingDraft as draft
            controller = draft.JianyingController()
            target = str(output or (Path.cwd() / f"{name}.mp4"))
            controller.export_draft(name, target)
            ok(f"已调用剪映导出：{target}")
            return 0
        except Exception as exc:  # noqa: BLE001 —— uiautomation 缺失、剪映版本过新都会在这里失败
            ok(f"自动导出不可用（{type(exc).__name__}: {exc}），改走人工导出。")

    ok(f"当前平台（{platform.system()}）不支持自动导出 —— 桌面版剪映没有可编程的导出接口。")
    ok(f"草稿位置：{draft_dir}")
    ok("请在剪映里手动导出：")
    for step in MANUAL_STEPS:
        ok(f"  {step}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
