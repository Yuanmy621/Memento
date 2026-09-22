# ip-as-logo · 批次锁定稿（YuanMy）

状态：**方向已确认（A/B/C 全做，六张）**，提示词已定稿；**尚未生成** —— 本会话没有可用图像模型。

- 目标模型（优先级）：GPT Image 2 → Seedance 5.0 Pro / Nano Banana Pro / Nano Banana 2
- 约束投递方式：`main-prompt constraints`（现代指令遵循模型，把 `Constraints:` 行写进主提示词，不另开 negative 参数）
- 输出：每张独立生成，1:1，约 `1536 × 1536`（服务上限为 `1254 × 1254` 时原样保留，不重采样）
- 落盘：`.tmp/ip-as-logo/out/<label>.png`
- 禁止：拼图 / 九宫格、拿旧图当参考、提示词里出现 logo / 品牌标记 / 应用图标 等用途词

## 角位与配色分配

| 标签 | 方向 | 角 | IP 色 1 | IP 色 2 | 背景色 |
| --- | --- | --- | --- | --- | --- |
| A1 | 方头小机器人「元」 | 左下 | 深蓝紫 `#7E86DE`（头部主体块） | 冷雾白 `#E8EAF2`（双圆盘耳 + 身体块） | 柔和灰青 `#9FBFBF` |
| A2 | 方头小机器人「元」 | 右下 | 冷雾白 `#E8EAF2`（头部主体块） | 深蓝紫 `#7E86DE`（双圆盘耳 + 一整块圆胸板） | 柔和灰青 `#9FBFBF` |
| B1 | 背壳小寄居蟹 | 左下 | 暖杏橙 `#F0B27A`（圆角方壳） | 深可可 `#5A3B2E`（头 / 身体 / 双圆钳） | 柔和淡紫 `#BFAFD4` |
| B2 | 背壳小寄居蟹 | 右下 | 深可可 `#5A3B2E`（圆角方壳） | 暖杏橙 `#F0B27A`（头 / 双圆钳 / 露出的身体） | 柔和淡紫 `#BFAFD4` |
| C1 | 抱方块的小水獭 | 左下 | 深墨青 `#2F4F52`（头 / 身体 / 双圆耳） | 奶白 `#F2EDE2`（怀里的大圆角方块 + 肚皮块） | 柔和暖沙 `#D8C3A1` |
| C2 | 抱方块的小水獭 | 右下 | 奶白 `#F2EDE2`（头 / 身体） | 深墨青 `#2F4F52`（怀里的大圆角方块 + 双圆耳） | 柔和暖沙 `#D8C3A1` |

---

## A1 — 左下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted cool teal. Keep muted cool teal visible in every open area and in the corners not occupied by the character; the lower-left corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing square-headed little robot IP character on the background, reduced to one soft rounded continuous silhouette and one defining feature: a pair of large round disc ears, with both members fully visible.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP base colors are deep blue-violet and cool mist white; deep blue-violet carries the head mass, cool mist white carries both round disc ears and the compact rounded body mass, and the same two colors are reused for the facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated. Treat any example palette as optional inspiration, never as an allowlist.
Composition: keep the character upright and emerging from the lower-left, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or assigned side is welcome when it strengthens the corner emergence. Preserve both paired identifying features. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

## A2 — 右下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted cool teal. Keep muted cool teal visible in every open area and in the corners not occupied by the character; the lower-right corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing square-headed little robot IP character on the background, reduced to one soft rounded continuous silhouette and one defining feature: a pair of large round disc ears, with both members fully visible.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP base colors are cool mist white and deep blue-violet; cool mist white carries the head mass, deep blue-violet carries both round disc ears and one continuous rounded chest panel, and the same two colors are reused for the facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated. Treat any example palette as optional inspiration, never as an allowlist.
Composition: keep the character upright and emerging from the lower-right, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or assigned side is welcome when it strengthens the corner emergence. Preserve both paired identifying features. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

## B1 — 左下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted dusty lilac. Keep muted dusty lilac visible in every open area and in the corners not occupied by the character; the lower-left corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing hermit crab IP character on the background, reduced to one soft rounded continuous silhouette and one defining feature: one large rounded-square shell merged onto its back, with both rounded claws fully visible.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP base colors are warm apricot orange and deep cocoa brown; warm apricot orange carries the single large rounded-square shell, deep cocoa brown carries the head, the compact body, and both rounded claws, and the same two colors are reused for the facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated. Treat any example palette as optional inspiration, never as an allowlist.
Composition: keep the character upright and emerging from the lower-left, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or assigned side is welcome when it strengthens the corner emergence. Preserve both paired identifying features. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

## B2 — 右下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted dusty lilac. Keep muted dusty lilac visible in every open area and in the corners not occupied by the character; the lower-right corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing hermit crab IP character on the background, reduced to one soft rounded continuous silhouette and one defining feature: one large rounded-square shell merged onto its back, with both rounded claws fully visible.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP base colors are deep cocoa brown and warm apricot orange; deep cocoa brown carries the single large rounded-square shell, warm apricot orange carries the head, both rounded claws, and the compact body, and the same two colors are reused for the facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated. Treat any example palette as optional inspiration, never as an allowlist.
Composition: keep the character upright and emerging from the lower-right, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or assigned side is welcome when it strengthens the corner emergence. Preserve both paired identifying features. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

## C1 — 左下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted warm sand. Keep muted warm sand visible in every open area and in the corners not occupied by the character; the lower-left corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby sea otter IP character on the background, reduced to one soft rounded continuous silhouette and one defining feature: one large soft rounded square block hugged to its chest and merged into the same silhouette, with both small round ears fully visible.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP base colors are deep pine teal and soft cream white; deep pine teal carries the head, the compact seated body, and both small round ears, soft cream white carries the single large rounded square block and one broad belly region, and the same two colors are reused for the facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated. Treat any example palette as optional inspiration, never as an allowlist.
Composition: keep the character upright and emerging from the lower-left, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or assigned side is welcome when it strengthens the corner emergence. Preserve both paired identifying features. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

## C2 — 右下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted warm sand. Keep muted warm sand visible in every open area and in the corners not occupied by the character; the lower-right corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby sea otter IP character on the background, reduced to one soft rounded continuous silhouette and one defining feature: one large soft rounded square block hugged to its chest and merged into the same silhouette, with both small round ears fully visible.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP base colors are soft cream white and deep pine teal; soft cream white carries the head and the compact seated body, deep pine teal carries the single large rounded square block and both small round ears, and the same two colors are reused for the facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated. Treat any example palette as optional inspiration, never as an allowlist.
Composition: keep the character upright and emerging from the lower-right, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or assigned side is welcome when it strengthens the corner emergence. Preserve both paired identifying features. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```
