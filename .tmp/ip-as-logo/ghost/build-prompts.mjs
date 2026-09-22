// 幽灵批次（2026-09-21）→ 六份提示词
// 模型 doubao-seedream-5-0-260128（SenseAudio 同步图片生成），prompt 上限 2000 码位。
//
// 用户指定的三色角色（不引入第四色）：
//   IP 色 1 = 纯白 #FFFFFF        主体的全部大面积
//   IP 色 2 = 淡紫，一个色族      浅档 #C9C4EE 给点缀块，深档 #8E86DA 给五官
//   背景    = 白灰偏冷 #E7E7EF    白灰底，带一丝淡紫调，避免发脏
//
// 白主体 + 白灰底分离度弱 → 按方法论「背景是用户指定的，先调主体色」：
// 身体用纯白、背景压到低一档冷白灰（真实明度差），淡紫点缀块压在下缘剪影边界上。
//
// 变体规则（可一行说清）：
//   1（左下）= 淡紫压在**定义性特征**上（下摆波浪 / 卷尾 / 双手）+ 双眼
//   2（右下）= 淡紫改到**胸口一块圆润内核块** + 双眼，定义性特征保持纯白

const TEMPLATE = (p) => `Create one full-bleed 1:1 square image.
Background: solid white-gray fills the square, every open area and unoccupied corner; the ${p.corner} corner holds the character.
Subject: one extremely simplified, cute, endearing ${p.subject} — one soft rounded continuous silhouette, one defining feature: ${p.feature}.
Complexity: only 4–7 large shapes, at most two internal color regions, two simple eyes, a tiny mouth only if needed. Remove nonessential outline, anatomy, texture. Readable at 32 × 32.
Color: exactly three semantic colors — pure white and light purple as the two IP colors, plus the background. Light purple carries ${p.accent}; the eyes use a deeper tone of the same purple. Pure white carries the rest of the body, brighter than the background so the silhouette reads. Mute the background saturation slightly: clearly chromatic, not gray or muddy. Keep IP, facial marks, and background clearly separated.
Composition: upright, emerging from the ${p.corner}, filling 85–95% of the square, staying dominant. Cropping at the bottom or assigned side is welcome to strengthen the corner. Preserve both paired identifying features. Never center or bottom-center the character.
Style: simplification, cuteness, and lovable baby-like appeal are strongest; large soft forms, compact proportions, thick rounded contours, ultra-clean graphics. Add an extremely, extremely subtle, almost imperceptible depth through a barely-there neo-skeuomorphic treatment.
Finish: only the character, clean surfaces, square corners.
Constraints: no text or watermark, no borders, frames, cards, or masks, one character only, no extra subjects, no fragile lines, sharp tips, outlines, tiny details, or decorations, no photorealistic material or strong 3D rendering, no bevel, glossy hotspot, deep occlusion, extrusion, or cast shadow, no background texture, vignette, or lighting.`;

const SHEET = {
  subject: 'sheet ghost IP character',
  feature: 'one bell-shaped dome with three blunt rounded waves along the hem, all three visible',
};
const ROUND = {
  subject: 'round-headed little ghost IP character',
  feature: 'one perfectly round head tapering into a single thick blunt rounded curl tail',
};
const SQUARE = {
  subject: 'rounded-square little ghost IP character',
  feature: 'a pair of small blunt rounded hands, both fully visible',
};

const CORE = 'one rounded core panel on the chest plus both eyes';
const PALETTE = { ip_color_1: '#FFFFFF 纯白', ip_color_2: '#C9C4EE 淡紫(浅档) / #8E86DA 淡紫(深档)', background: '#E7E7EF 白灰偏冷' };

const SPECS = [
  { label: 'A1', direction: 'A · 床单小幽灵「小幽」', corner: 'lower-left', ...SHEET, accent: 'the bottom hem wave band plus both eyes' },
  { label: 'A2', direction: 'A · 床单小幽灵「小幽」', corner: 'lower-right', ...SHEET, accent: CORE },
  { label: 'B1', direction: 'B · 圆头小幽灵「圆尾」', corner: 'lower-left', ...ROUND, accent: 'the single curl tail plus both eyes' },
  { label: 'B2', direction: 'B · 圆头小幽灵「圆尾」', corner: 'lower-right', ...ROUND, accent: CORE },
  { label: 'C1', direction: 'C · 方形小幽灵「窗灵」', corner: 'lower-left', ...SQUARE, accent: 'both blunt rounded hands plus both eyes' },
  { label: 'C2', direction: 'C · 方形小幽灵「窗灵」', corner: 'lower-right', ...SQUARE, accent: CORE },
];

const out = SPECS.map((s) => ({
  ...s,
  model: 'doubao-seedream-5-0-260128',
  size: '2048x2048',
  palette: PALETTE,
  prompt: TEMPLATE(s),
}));

let fail = false;
for (const c of out) {
  const n = [...c.prompt].length;
  const bad = /\b(logo|brand mark|app icon|icon asset)\b/i.test(c.prompt);
  console.log(`${c.label}\t${c.corner}\tcodepoints=${String(n)}\tuse-case-words=${bad ? 'YES' : 'no'}`);
  if (n > 2000 || bad) fail = true;
}
if (fail) { console.error('FAIL：超码位或有用途词'); process.exit(1); }

const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./prompts.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('OK → prompts.json');
