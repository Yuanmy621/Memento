#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 ip-as-logo 出的方片派生 `app/desktop/assets/` 下的两份图标资产。

这个脚本**不参与每次构建**（图标是设计资产，不是编译产物），改图时才手动跑一次：

    python3 app/desktop/scripts/make-icons.py

依赖：本机 Python 3 + Pillow（macOS 自带 Python 没有 Pillow 时 `pip3 install --user pillow`）。

产出两档，尺寸规范不同，别互相替换：

1. `icon.png` / `icon.icns` —— 给系统看（Dock、Finder、Windows/Linux 窗口图标）。
   按 Apple 的 macOS 图标网格切：**画布留白 + 方片本体**。
   画布 1024²，方片本体 824² 居中（80.47%），圆角取本体的 22.45%（≈185）。
   本体外面是**透明**的 —— macOS 上所有 App 图标都是这个留白比例，
   铺满画布的图标（本体 100%）在 Dock 里会明显比邻居「胖一圈」。
   注意：透明的只是**方片外面**；方片本体仍然是不透明的浅紫底，
   别把背景抠掉（那样图案会在浅色桌面上「浮」着）。

2. `logo.png` —— 给渲染进程用（侧栏品牌行那枚小方片）。
   **铺满画布**：本体就是整张图，尺寸与圆角由 CSS（16px / 4px）决定。
   这里再留白的话，CSS 的 16px 盒子里实际图案只有 ~13px，和旁边的文字对不齐。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# ── 参数 ────────────────────────────────────────────────────────────────

HERE = Path(__file__).resolve().parent              # app/desktop/scripts
ASSETS = (HERE / ".." / "assets").resolve()         # app/desktop/assets
SRC = Path(
    os.environ.get(
        "Memento_ICON_SRC",
        Path.home() / ".Memento" / "ip-as-logo" / "20260921-ghost" / "B1.jpg",
    )
)

CANVAS = 1024          # icon.png 画布
BODY_RATIO = 824 / 1024          # Apple 网格：方片本体占画布 80.47%
RADIUS_RATIO = 0.2245            # 圆角占本体比例（824 → 185）
LOGO_PX = 128                    # logo.png 边长（侧栏按 16px 显示，8 倍留够 Retina）


def rounded_tile(img: Image.Image, side: int, radius_ratio: float) -> Image.Image:
    """把 img 缩放成 side² 的圆角方片（RGBA，四角透明）。"""
    tile = img.convert("RGB").resize((side, side), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, side - 1, side - 1), radius=round(side * radius_ratio), fill=255
    )
    tile.putalpha(mask)
    return tile


def macos_icon(src: Image.Image, canvas: int = CANVAS) -> Image.Image:
    """按 Apple 网格把 src 做成 canvas² 的图标（本体居中留白，外侧透明）。"""
    body = round(canvas * BODY_RATIO)
    offset = (canvas - body) // 2
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.paste(rounded_tile(src, body, RADIUS_RATIO), (offset, offset))
    return out


def main() -> int:
    if not SRC.exists():
        print(f"找不到源图：{SRC}", file=sys.stderr)
        print("可以用 Memento_ICON_SRC=<路径> 换一张。", file=sys.stderr)
        return 1

    src = Image.open(SRC)
    print(f"源图 {SRC.name} {src.size[0]}×{src.size[1]}")

    # 1) 系统图标：Dock / Finder / 窗口
    icon = macos_icon(src)
    icon.save(ASSETS / "icon.png")
    body = round(CANVAS * BODY_RATIO)
    print(
        f"icon.png {CANVAS}²：本体 {body}²（{BODY_RATIO * 100:.2f}%），"
        f"圆角 {round(body * RADIUS_RATIO)}，外侧透明"
    )

    # 2) 侧栏 logo：铺满画布，圆角比例与图标本体一致
    logo = rounded_tile(src, LOGO_PX, RADIUS_RATIO)
    logo.save(ASSETS / "logo.png")
    print(f"logo.png {LOGO_PX}²：铺满画布，圆角 {round(LOGO_PX * RADIUS_RATIO)}")

    # 3) icns：每个尺寸都从源图直接画，避免逐级缩放把圆角磨花
    iconset = Path("/tmp/Memento.iconset")
    subprocess.run(["rm", "-rf", str(iconset)], check=True)
    iconset.mkdir(parents=True)
    for px in (16, 32, 128, 256, 512):
        macos_icon(src, px * 2).resize((px * 2, px * 2), Image.LANCZOS).save(
            iconset / f"icon_{px}x{px}@2x.png"
        )
        macos_icon(src, px).save(iconset / f"icon_{px}x{px}.png")
    # 512@2x = 1024，直接用主图
    icon.save(iconset / "icon_512x512@2x.png")
    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(ASSETS / "icon.icns")],
        check=True,
    )
    print(f"icon.icns {(ASSETS / 'icon.icns').stat().st_size} 字节（16…1024 共 10 档）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
