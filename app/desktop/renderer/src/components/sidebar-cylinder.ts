/**
 * 侧栏背景：**整个侧栏是一段柱面**，被切成小块，向右滚动着消散 —— 纯模拟（不碰 DOM）。
 *
 * ## 它到底是什么
 *
 * 把侧栏看成一截**立着的圆柱**（轴垂直，我们看到的是它正面那一小段曲面）：
 *
 * ```
 *              光的来向
 *                 ↓
 *    ╭─────────────────────╮   ① 柱面：左右边缘转过去了 → 格子被投影压窄 + 变暗，
 *    │ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ │      中间最亮，光带略微偏左（高光）
 *    │ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ │   ② 网格：整段曲面按 13px 的小方块切开
 *    │ ▪▪▪▫▫▪▪▪▪▪▫▫▪▪▪▪▪▪▪ │   ③ 切下来：随机有小块脱离表面，底下的格子**留空**
 *    │ ▪▪▫▫▫▪▪▪▫▫▪▪▪▪▪▪▪▪▪ │      → 向右滚（自转 = 滚动）+ 略放大 + 渐隐（消散）
 *    │ ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ │   ④ 强度：越靠上越明显，向下平滑衰减到 0
 *    ╰─────────────────────╯
 * ```
 *
 * | 现象 | 由什么决定 |
 * | --- | --- |
 * | 柱面感 | 屏幕 x = R·sin θ（格子被投影压窄）+ {@link cylinderShade} 的明暗与高光 |
 * | 切成小块 | 曲面按 `cell` 切格子，每格有自己的「静止 / 被切下来」周期 |
 * | 整体向右滚动 | `drumSpeed`：整段曲面在转（网格与「哪块料在哪一格」一起右移） |
 * | 消散 | 被切下来的那块：`easeOut` 右移 + 滚动式自转 + 渐隐，最后什么都不剩 |
 * | 上强下弱 | {@link verticalIntensity}：同时乘在「表面亮度」和「消散幅度」上 |
 *
 * ## 为什么单独一个文件、而且不 import 任何 DOM
 *
 * 仓库老规矩（见 `rich-text-tokens.ts`）：**会自己演化的几何最该能被推演**。
 * 这里全是「状态 + dt + 随机源 → 新状态」，随机源是注入的，所以柱面投影宽度、
 * 强度曲线、切割周期、消散进度都能在 Node 里直接验（仓库里不放测试文件，跑临时脚本）。
 * 画布、rAF、`prefers-reduced-motion` 都在 `components/sidebar-backdrop.tsx`。
 *
 * @module Memento/desktop/renderer/src/components/sidebar-cylinder
 */

/** 可调参数。 */
export interface CylinderOptions {
  /** 小方块的边长（**弧长**，CSS px）。 */
  cell: number
  /** 方块之间的缝（px）—— 网格靠它才看得见。 */
  gap: number
  /** 柱面弯曲程度：左右边缘相对中心转过的角度（弧度）。0.95 ≈ 54°。 */
  curvature: number
  /** 光从哪个角度打过来（弧度，0 = 正前方）。 */
  light: number
  /** 静止表面的不透明度（顶部，未乘柱面明暗）。 */
  surfaceAlpha: number
  /** 被切下来那一小块的不透明度（顶部）。 */
  shardAlpha: number
  /** 「静止 → 切下来 → 滚走消散 → 回来」一轮的时长范围（ms）。 */
  cycleMs: readonly [number, number]
  /** 一轮里「静止」占的比例（0.6 = 任意时刻约 40% 的小块正在滚）。 */
  restRatio: number
  /** 切下来之后向右滚多远（px）。 */
  rollPx: number
  /** 滚动自转系数：位移 / 格宽 × 它 = 转角（0.55 ≈ 像方块在地上滚）。 */
  rollSpin: number
  /** 整段柱面向右转的速度（px/秒，弧长）。 */
  drumSpeed: number
  /** 强度衰减到 0 的相对高度（0.78 = 上面 78% 有特效，再往下就是纯背景）。 */
  fadeHeight: number
  /** 强度曲线的幂次（越大，衰减越快、特效越集中在上面）。 */
  fadePower: number
}

/** 一个小块的周期状态（位置由格子算，不存这里）。 */
export interface Tile {
  /** 周期进度 0..1。 */
  phase: number
  /** 这一格的周期时长（ms）—— 每格不同，节奏才不整齐。 */
  period: number
  /** 滚走距离的系数 0.7~1.3。 */
  drift: number
  /** 额外的随机转角（弧度），叠在「滚动自转」上。 */
  spin: number
  /** 0..1 的明暗微差：网格有小块的质感，而不是一块均匀的灰。 */
  tone: number
}

/** 整个场。 */
export interface Field {
  /** 逻辑尺寸（CSS 像素）。 */
  width: number
  height: number
  /** 柱面半径（让 ±curvature 的弧正好投满宽度）。 */
  radius: number
  /** 一圈有多少列（沿弧长切）。 */
  columns: number
  /** 一列有多少行（沿高度切）。 */
  rows: number
  /** 每列的角度跨度（弧度）。 */
  stepAngle: number
  /**
   * 要画的**稠密列数** = `columns + 2 × DENSE_PAD`。
   *
   * 为什么比 `columns` 多：鼓面一转，可见的那段弧就在「材料」上滑动了不到一格，
   * 最左/最右会露出「上一格的材料」——不把多出来的那一两列也画上，
   * 侧栏左边缘会出现一条会呼吸的空缝。
   */
  dense: number
  /** 鼓面已经转过多少**整格**（材料整体挪了几列）。 */
  shift: number
  /** 稠密列当前的角度（含鼓面位移）。 */
  geoTheta: number[]
  /** 稠密列的屏幕中心 x（每帧按鼓面位移更新）。 */
  geoX: number[]
  /** 稠密列的屏幕宽度（投影后，每帧更新）。 */
  geoWidth: number[]
  /** 稠密列的柱面明暗（每帧按屏幕角度更新：光是固定的，材料从光里转过去）。 */
  geoShade: number[]
  /** 稠密列此刻显示的是哪一块材料（`(j - shift) mod columns`）。 */
  geoMaterial: number[]
  /** 稠密列有多少露在柱面上（两侧各有一列是「转过去/转过来」的，会被裁掉）。 */
  geoVisible: boolean[]
  /** 小块状态，按 `row * columns + materialSlot` 索引。 */
  tiles: Tile[]
  /** 柱面累计转过的弧长（px，会按整圈取模以保持精度）。 */
  drum: number
  /** 累计时间（ms）。 */
  time: number
  /** 参数（建场时定下，之后只读）。 */
  readonly options: CylinderOptions
}

/** 一帧里「这一块该画成什么样」。 */
export interface TileFrame {
  /** 屏幕矩形（旋转前）。 */
  x: number
  y: number
  width: number
  height: number
  /** 不透明度（已经乘过柱面明暗与纵向强度）。 */
  alpha: number
  /** true = 已被切下来（要旋转、要放大，底下的格子留空）。 */
  detached: boolean
  /** 相对格子的位移（被切下来之后才不为 0）。 */
  dx: number
  dy: number
  /** 自转角度（弧度）。 */
  angle: number
  /** 缩放（被切下来时略微变大 = 离观察者更近）。 */
  scale: number
}

/** 默认参数：按「264px 宽的侧栏、只是一层会动的背景」调出来的。 */
export const DEFAULT_OPTIONS: CylinderOptions = {
  cell: 12,
  gap: 1,
  curvature: 0.95,
  light: -0.22,
  surfaceAlpha: 0.055,
  shardAlpha: 0.2,
  cycleMs: [1800, 4200],
  restRatio: 0.6,
  rollPx: 34,
  rollSpin: 0.55,
  drumSpeed: 7,
  fadeHeight: 0.78,
  // 幂次越大，特效越集中在上面：2.0 时 30% 高度处只剩 38%、50% 处 13%，
  // 「上面明显、往下安静」的层次才出来（1.5 时 30% 处还有 48%，看着是均匀铺满）。
  fadePower: 2.0,
}

/** 低于这个纵向强度就整行不画（底部那截是纯背景，别为它白算）。 */
export const MIN_INTENSITY = 0.02

/**
 * 稠密列在两侧各多铺几格。
 *
 * 鼓面位移不是整格时，可见的这段弧会在材料上滑动不到一格 —— 两侧各多一列就够了，
 * 这里给 2 是留冗余（浮点累积、极端尺寸下不会露缝）。
 */
const DENSE_PAD = 2

/** 均匀随机数（`[min, max)`）。 */
function between(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min)
}

/**
 * 柱面半径：让 ±curvature 的弧**正好**投到宽度 width 的两端。
 *
 * @param width - 逻辑宽度。
 * @param curvature - 半角（弧度）。
 * @returns 半径；`curvature` 为 0 时返回 `Infinity`（= 平面）。
 */
export function radiusOf(width: number, curvature: number): number {
  const sin = Math.sin(curvature)
  return sin <= 1e-6 ? Number.POSITIVE_INFINITY : (width / 2) / sin
}

/**
 * 柱面明暗：光从 `light` 方向来，边缘（|θ| 大）自然变暗。
 *
 * 这是「柱面感」的一半（另一半是投影压窄）：没有它，网格只是一张贴在平面上的图。
 *
 * @param theta - 这一列此刻的屏幕角度（弧度）。
 * @param light - 光源角度。
 * @returns 0.28~1.1 的亮度系数（边缘约 0.28，正对光时 1 + 高光）。
 */
export function cylinderShade(theta: number, light: number = DEFAULT_OPTIONS.light): number {
  const facing = Math.max(0, Math.cos(theta - light))
  // 两项：宽的是整体弧面（pow 1.1），窄的是高光带（pow 9）
  return 0.28 + 0.72 * Math.pow(facing, 1.1) + 0.10 * Math.pow(facing, 9)
}

/**
 * 纵向强度：上面 1，往下平滑衰减到 0。
 *
 * 它同时乘在「表面亮度」和「消散幅度」上，所以底部既没有网格、也不会动 ——
 * 侧栏下半部分是纯背景，那里的文字区安静。
 *
 * @param y - 逻辑 y（CSS px）。
 * @param height - 逻辑高度。
 * @param options - 取 `fadeHeight` / `fadePower`。
 * @returns 0..1。
 */
export function verticalIntensity(
  y: number,
  height: number,
  options: Pick<CylinderOptions, 'fadeHeight' | 'fadePower'> = DEFAULT_OPTIONS,
): number {
  const span = height * options.fadeHeight
  if (span <= 0) return 0
  const k = 1 - Math.max(0, y) / span
  if (k <= 0) return 0
  return Math.pow(Math.min(1, k), options.fadePower)
}

/** 造一个全新的小块状态（相位随机：不然整片会一起动）。 */
function newTile(rng: () => number, options: CylinderOptions): Tile {
  return {
    phase: rng(),
    period: between(rng, options.cycleMs[0], options.cycleMs[1]),
    drift: between(rng, 0.7, 1.3),
    spin: between(rng, -0.35, 0.35),
    tone: between(rng, 0.72, 1),
  }
}

/**
 * 重算几何：列数、行数、每列的角度跨度，以及小块数组（尽量保留原有状态）。
 *
 * @param field - 场（原地修改）。
 * @param rng - 随机源（补新格子用）。
 */
function layout(field: Field, rng: () => number): void {
  const { cell, gap, curvature } = field.options
  const step = cell + gap
  const radius = radiusOf(field.width, curvature)
  const arc = Number.isFinite(radius) ? 2 * curvature * radius : field.width
  const columns = Math.max(1, Math.round(arc / step))
  const rows = Math.max(1, Math.ceil(field.height / step))
  const oldColumns = field.columns
  const oldTiles = field.tiles

  field.radius = radius
  field.columns = columns
  field.rows = rows
  field.stepAngle = columns > 0 ? (2 * curvature) / columns : 0
  field.dense = columns + 2 * DENSE_PAD
  field.geoTheta = new Array<number>(field.dense).fill(0)
  field.geoX = new Array<number>(field.dense).fill(0)
  field.geoWidth = new Array<number>(field.dense).fill(0)
  field.geoShade = new Array<number>(field.dense).fill(1)
  field.geoMaterial = new Array<number>(field.dense).fill(0)
  field.geoVisible = new Array<boolean>(field.dense).fill(false)
  field.tiles = new Array<Tile>(rows * columns)
  for (let row = 0; row < rows; row += 1) {
    for (let slot = 0; slot < columns; slot += 1) {
      const previous = oldColumns > 0 ? oldTiles[row * oldColumns + slot] : undefined
      field.tiles[row * columns + slot] = previous ?? newTile(rng, field.options)
    }
  }
  updateColumns(field)
}

/**
 * 按当前鼓面位移，更新每一列在屏幕上的中心、宽度与明暗。
 *
 * 三件事都在这一步做完，是因为它们都只跟**角度**有关：
 *
 * - 位移用**角度**表达（而不是屏幕像素），柱面才整体一致 ——
 *   屏幕等距的位移在边缘会因为投影压缩而多走/少走，看起来会「跳一下」；
 * - 明暗跟着**屏幕角度**算：光固定在空间里，材质是从光里转过去的；
 * - 每帧只有 `columns`（≈23）次三角函数，格子的循环里一次都不用。
 *
 * @param field - 场（原地修改）。
 */
export function updateColumns(field: Field): void {
  const { cell, gap, curvature, light } = field.options
  const step = cell + gap
  // 转过多少**整格**：材料整体挪几列（材料是首尾相接的，所以取模就好）
  const shift = Math.floor(field.drum / step + 1e-9)
  const fraction = field.drum - shift * step
  const fractionAngle = Number.isFinite(field.radius) ? fraction / field.radius : 0
  const half = field.stepAngle / 2
  field.shift = shift
  for (let dense = 0; dense < field.dense; dense += 1) {
    const column = dense - DENSE_PAD
    const theta = -curvature + (column + 0.5) * field.stepAngle + fractionAngle
    field.geoTheta[dense] = theta
    field.geoX[dense] = field.width / 2 + field.radius * Math.sin(theta)
    field.geoWidth[dense] = field.radius * (Math.sin(theta + half) - Math.sin(theta - half))
    field.geoShade[dense] = cylinderShade(theta, light)
    field.geoMaterial[dense] = ((column - shift) % field.columns + field.columns) % field.columns
    // 这一列只要还有一部分落在 ±Θ 里就要画（两侧那两列会被画布裁掉一半）
    field.geoVisible[dense] = theta + half > -curvature && theta - half < curvature
  }
}

/**
 * 造一个场，并按当前尺寸算好几何与初始周期。
 *
 * @param width - 逻辑宽度。
 * @param height - 逻辑高度。
 * @param rng - 随机源（`Math.random` 或固定种子）。
 * @param options - 参数覆盖。
 * @returns 场。
 */
export function createField(
  width: number,
  height: number,
  rng: () => number,
  options: Partial<CylinderOptions> = {},
): Field {
  const field: Field = {
    width: Math.max(0, width),
    height: Math.max(0, height),
    radius: 0,
    columns: 0,
    rows: 0,
    stepAngle: 0,
    dense: 0,
    shift: 0,
    geoTheta: [],
    geoX: [],
    geoWidth: [],
    geoShade: [],
    geoMaterial: [],
    geoVisible: [],
    tiles: [],
    drum: 0,
    time: 0,
    options: { ...DEFAULT_OPTIONS, ...options },
  }
  layout(field, rng)
  return field
}

/**
 * 改尺寸（侧栏宽度固定，主要是窗口高度在变）。
 *
 * @param field - 场（原地修改）。
 * @param width - 新的逻辑宽度。
 * @param height - 新的逻辑高度。
 * @param rng - 随机源。
 */
export function resizeField(field: Field, width: number, height: number, rng: () => number): void {
  const nextWidth = Math.max(0, width)
  const nextHeight = Math.max(0, height)
  if (field.width === nextWidth && field.height === nextHeight) return
  field.width = nextWidth
  field.height = nextHeight
  layout(field, rng)
}

/**
 * 推进一帧：小块走自己的周期，整段柱面也在慢慢向右转。
 *
 * @param field - 场（原地修改）。
 * @param dtMs - 距上一帧的毫秒数（调用方要夹上限）。
 * @param rng - 随机源（周期轮回时重掷节奏）。
 */
export function stepField(field: Field, dtMs: number, rng: () => number): void {
  const dt = Math.max(0, dtMs)
  field.time += dt
  const { cell, gap, drumSpeed } = field.options
  const span = (cell + gap) * Math.max(1, field.columns)
  field.drum += (drumSpeed * dt) / 1000
  // 转满**一整圈**才取模：一圈对应 `columns` 格，也就是角度上正好 2Θ ——
  // 几何与材料映射都回到原样，所以画面看不出接缝，而浮点数不会一直涨。
  // ⚠️ 不能按「一格」取模：那样材料映射会突然错开一列，画面上是一次跳变。
  if (field.drum >= span) field.drum -= span
  for (const tile of field.tiles) {
    tile.phase += dt / tile.period
    if (tile.phase >= 1) {
      // 一轮走完：重掷节奏/漂移/转角，然后从「静止」重新开始。
      tile.phase -= 1
      tile.period = between(rng, field.options.cycleMs[0], field.options.cycleMs[1])
      tile.drift = between(rng, 0.7, 1.3)
      tile.spin = between(rng, -0.35, 0.35)
      tile.tone = between(rng, 0.72, 1)
    }
  }
  updateColumns(field)
}

/**
 * 屏幕上某一列（slot）现在显示的是哪一块料。
 *
 * 柱面每转过一整格，「料」就整体挪一列 —— 网格的移动因此是连续的，
 * 而每块料的周期状态也跟着一起走（看起来是**材质**在转，不是贴图在滑）。
 *
 * @param field - 场。
 * @param dense - 稠密列号（0..`columns + 2×DENSE_PAD`，含两侧多铺的那几列）。
 * @param row - 行号。
 * @returns 小块状态。
 */
export function tileAt(field: Field, dense: number, row: number): Tile {
  const materialSlot = field.geoMaterial[dense] ?? 0
  const tile = field.tiles[row * field.columns + materialSlot]
  // 尺寸刚变过、索引越界时兜一个（正常路径不会走到）
  return tile ?? field.tiles[0] ?? { phase: 0, period: 2000, drift: 1, spin: 0, tone: 1 }
}

/**
 * 算出一小块这一帧该画成什么样。
 *
 * 返回 `null` 表示「这一帧不画它」——只有一种情形：纵向强度已经衰减到看不出来。
 * 至于「正在滚」的那些块，**调用方要跳过它们**（`detached === true` 时不要画静止的
 * 格子）：底下的格子留空，才看得出这一块是从表面上被切走的。这是切割感的来源。
 *
 * @param field - 场（几何要是本帧 {@link updateColumns} 之后的状态）。
 * @param dense - 稠密列号（0..`columns + 2×DENSE_PAD`）。
 * @param row - 行号。
 * @param out - 复用的对象（组件每帧算上千次，别分配垃圾）。
 * @returns 这一帧的画法；不用画时为 `null`。
 */
export function tileFrame(field: Field, dense: number, row: number, out?: TileFrame): TileFrame | null {
  const { cell, gap, restRatio, shardAlpha, surfaceAlpha, rollPx, rollSpin } = field.options
  if (field.geoVisible[dense] !== true) return null
  const y = row * (cell + gap)
  const intensity = verticalIntensity(y, field.height, field.options)
  if (intensity <= MIN_INTENSITY) return null

  const width = Math.max(1, (field.geoWidth[dense] ?? cell) - gap)
  const frame: TileFrame = out ?? {
    x: 0, y: 0, width: 0, height: 0, alpha: 0, detached: false, dx: 0, dy: 0, angle: 0, scale: 1,
  }
  frame.x = (field.geoX[dense] ?? 0) - width / 2
  frame.y = y
  frame.width = width
  frame.height = cell
  frame.dx = 0
  frame.dy = 0
  frame.angle = 0
  frame.scale = 1

  const tile = tileAt(field, dense, row)
  const shade = field.geoShade[dense] ?? 1
  if (tile.phase < restRatio) {
    // 静止：留在柱面上，只有柱面明暗 + 小块自己的明暗微差
    frame.detached = false
    frame.alpha = surfaceAlpha * intensity * shade * tile.tone
    return frame
  }
  // 被切下来：向右滚 + 滚动式自转 + 略放大（离观察者更近）+ 渐隐（消散）
  const q = (tile.phase - restRatio) / (1 - restRatio)
  const eased = 1 - (1 - q) * (1 - q) // 起步快、后面缓：像被甩出去之后滚停
  const dx = rollPx * tile.drift * eased
  frame.detached = true
  frame.dx = dx
  // 向下分量很小：柱面转过去的碎屑基本是「向右侧滚」，加一点点下沉更自然
  frame.dy = 2.5 * eased
  frame.angle = (dx / Math.max(1, cell)) * rollSpin + tile.spin
  frame.scale = 1 + 0.1 * q
  frame.alpha = shardAlpha * intensity * shade * tile.tone * Math.pow(1 - q, 1.3)
  return frame
}

/**
 * 纵向强度还看得见的行数（底部的行整行不画）。
 *
 * @param field - 场。
 * @returns 行数。
 */
export function visibleRows(field: Field): number {
  const step = field.options.cell + field.options.gap
  let rows = 0
  for (let row = 0; row < field.rows; row += 1) {
    if (verticalIntensity(row * step, field.height, field.options) > MIN_INTENSITY) rows += 1
  }
  return rows
}
