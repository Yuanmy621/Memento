// ip-as-logo 批次参数 → 六份提示词
// 模型 doubao-seedream-5-0-260128（SenseAudio 同步图片生成），prompt 硬上限 2000 码位。
// 骨架取自 SKILL.md 的 Prompt skeleton；因 2000 码位硬限制，措辞被压缩到极限，
// 保留全部必需元素：背景填充+角位 / 主体+唯一定义性特征 / 复杂度预算(4–7 形状、≤2 色区、
// 两眼、必要才加小嘴、32×32 可读) / 三色规则+背景降饱和+分离度 / 构图(竖直、85–95%、
// 允许裁切、成对特征齐全、禁止居中) / 风格 + 那一句 barely-there 立体感 / 收尾 / Constraints 行。
// 仅省略一句与本批次无关的元说明（example palette as optional inspiration），因为它不描述画面。

const BG_A = 'muted cool teal';
const BG_B = 'muted dusty lilac';
const BG_C = 'muted warm sand';

const T = (p) => `Create one full-bleed 1:1 square image.
Background: solid ${p.bg} fills the square, every open area and unoccupied corner; the ${p.corner} corner is occupied by the character.
Subject: one extremely simplified, cute, endearing ${p.subject}, one soft rounded continuous silhouette, one defining feature — ${p.feature}.
Complexity: only 4–7 large shapes, at most two internal color regions, two simple eyes, one tiny mouth only if needed. Remove nonessential line, outline, anatomical detail, texture. Readable at 32 × 32.
Color: exactly three semantic colors — two IP base colors plus the background. ${p.colors} Mute the background saturation slightly: clearly chromatic, intentional, not gray or muddy. Keep IP, facial marks, and background clearly separated.
Composition: upright, emerging from the ${p.corner}, filling 85–95% of the square, staying dominant. Cropping at the bottom or assigned side is welcome to strengthen corner emergence. Preserve both paired identifying features. Never center or bottom-center the character.
Style: simplification, cuteness, and lovable baby-like appeal are strongest; large soft forms, compact proportions, thick rounded contours, ultra-clean graphics. Add an extremely, extremely subtle, almost imperceptible depth through a barely-there neo-skeuomorphic treatment.
Finish: only the character, clean surfaces, square outer corners.
Constraints: No text or watermark, no borders, frames, cards, or presentation masks, one character only, no extra subjects, no fragile lines, sharp tips, outlines, tiny details, or decorative marks, no photorealistic material or strong 3D rendering, no bevel, glossy hotspot, deep occlusion, extrusion, or cast shadow, no background texture, vignette, or lighting variation.`;

const ROBOT = {
  subject: 'square-headed little robot IP character',
  feature: 'a pair of large round disc ears, with both members fully visible',
};
const CRAB = {
  subject: 'hermit crab IP character',
  feature: 'one large rounded-square shell merged onto its back, both claws visible',
};
const OTTER = {
  subject: 'baby sea otter IP character',
  feature: 'one large soft rounded square block hugged at its chest, both round ears visible',
};

const SPECS = [
  {
    label: 'A1', direction: 'A · 方头小机器人「元」', corner: 'lower-left', bg: BG_A, ...ROBOT,
    colors: 'IP colors: deep blue-violet (head mass), cool mist white (both round disc ears, the rounded body mass); both reused for facial marks.',
    palette: { ip_color_1: '#7E86DE 深蓝紫', ip_color_2: '#E8EAF2 冷雾白', background: '#9FBFBF 柔和灰青' },
  },
  {
    label: 'A2', direction: 'A · 方头小机器人「元」', corner: 'lower-right', bg: BG_A, ...ROBOT,
    colors: 'IP colors: cool mist white (head mass), deep blue-violet (both round disc ears, one rounded chest panel); reuse both for facial marks.',
    palette: { ip_color_1: '#7E86DE 深蓝紫', ip_color_2: '#E8EAF2 冷雾白', background: '#9FBFBF 柔和灰青' },
  },
  {
    label: 'B1', direction: 'B · 背壳小寄居蟹', corner: 'lower-left', bg: BG_B, ...CRAB,
    colors: 'IP colors: warm apricot orange (the rounded-square shell), deep cocoa brown (head, compact body, both claws); reuse both for facial marks.',
    palette: { ip_color_1: '#F0B27A 暖杏橙', ip_color_2: '#5A3B2E 深可可', background: '#BFAFD4 柔和淡紫' },
  },
  {
    label: 'B2', direction: 'B · 背壳小寄居蟹', corner: 'lower-right', bg: BG_B, ...CRAB,
    colors: 'IP colors: deep cocoa brown (the rounded-square shell), warm apricot orange (head, both claws, compact body); reuse both for facial marks.',
    palette: { ip_color_1: '#F0A76A 暖杏橙', ip_color_2: '#5A3B2E 深可可', background: '#BFAFD4 柔和淡紫' },
  },
  {
    label: 'C1', direction: 'C · 抱方块的小水獭', corner: 'lower-left', bg: BG_C, ...OTTER,
    colors: 'IP colors: deep pine teal (head, body, both round ears), soft cream white (the square block, one belly region); reuse both for facial marks.',
    palette: { ip_color_1: '#2F4F52 深墨青', ip_color_2: '#F2EDE2 奶白', background: '#D8C3A1 柔和暖沙' },
  },
  {
    label: 'C2', direction: 'C · 抱方块的小水獭', corner: 'lower-right', bg: BG_C, ...OTTER,
    colors: 'IP colors: soft cream white (head, seated body), deep pine teal (the square block, both round ears); reuse both for facial marks.',
    palette: { ip_color_1: '#F2EDE2 奶白', ip_color_2: '#2F4F52 深墨青', background: '#D8C3A1 柔和暖沙' },
  },
];

const out = SPECS.map((s) => ({ ...s, model: 'doubao-seedream-5-0-260128', size: '2048x2048', prompt: T(s) }));

const bad = out.filter((c) => /\b(logo|brand mark|app icon|icon asset)\b/i.test(c.prompt));
for (const c of out) console.log(`${c.label}\tcorner=${c.corner}\tcodepoints=${[...c.prompt].length}`);
console.log('forbidden use-case words in prompts:', bad.length);

const over = out.filter((c) => [...c.prompt].length > 2000);
if (over.length || bad.length) {
  console.error('FAIL:', over.map((c) => `${c.label}=${[...c.prompt].length}`).join(' '));
  process.exit(1);
}

const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./prompts.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('OK → prompts.json');
