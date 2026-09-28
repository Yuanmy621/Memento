/**
 * 剪映草稿工作流的阶段表：五个阶段的顺序、前置产物，以及脚本与阶段的对应关系。
 *
 * 这里只有纯函数与常量，不碰文件系统，所以可以在 Node 里直接 import 跑真值表。
 * 阶段推进的判定、hook 的闸门判定都读这一份表 —— 两处口径不会漂。
 *
 * @module Memento/plugins/draft-workflow/stages
 */

/** 工作流的五个阶段，顺序即推进方向。 */
export const STAGES = ['survey', 'plan', 'build', 'review', 'export'] as const

/** 阶段 id。 */
export type Stage = (typeof STAGES)[number]

/** 一个阶段的说明。 */
export interface StageSpec {
  /** 阶段 id。 */
  readonly id: Stage
  /** 给人看的中文名。 */
  readonly label: string
  /**
   * 推进到**下一**阶段所需的产物（相对 `<stateDir>/draft/`）。
   * 最后阶段没有下一阶段，故为空串。
   */
  readonly gate: string
  /** 该产物要满足什么才算数。 */
  readonly gateHint: string
}

/** 阶段表。`gate` 是离开该阶段的凭据，缺了就不许推进。 */
export const STAGE_SPECS: readonly StageSpec[] = [
  {
    id: 'survey',
    label: '素材盘点',
    gate: 'survey.json',
    gateHint: '{ "assets": [ { "path": "...", "kind": "video|audio|image", "durationUs": 0 } ] }，assets 至少一项',
  },
  {
    id: 'plan',
    label: '分镜设计',
    gate: 'plan.json',
    gateHint: '{ "approved": true, "segments": [ ... ] }，approved 必须为 true（人确认过）',
  },
  {
    id: 'build',
    label: '草稿构建',
    gate: 'draft',
    gateHint: '已在剪映草稿目录里生成该草稿（state.draft 有名字，且草稿目录存在）',
  },
  {
    id: 'review',
    label: '成片校验',
    gate: 'review.json',
    gateHint: '{ "passed": true, "notes": "..." }，passed 必须为 true',
  },
  {
    id: 'export',
    label: '导出交付',
    gate: '',
    gateHint: '终点：导出由人在剪映里完成，或按平台能力自动导出',
  },
]

/** 阶段在表里的序号；未知阶段返回 -1。 */
export function stageIndex(stage: string): number {
  return (STAGES as readonly string[]).indexOf(stage)
}

/** 下一个阶段；已是最后阶段时返回 `undefined`。 */
export function nextStage(stage: Stage): Stage | undefined {
  return STAGES[stageIndex(stage) + 1]
}

/** 上一个阶段；已是第一个阶段时返回 `undefined`。 */
export function prevStage(stage: Stage): Stage | undefined {
  return stageIndex(stage) > 0 ? STAGES[stageIndex(stage) - 1] : undefined
}

/** 取阶段说明；未知阶段返回 `undefined`。 */
export function stageSpec(stage: string): StageSpec | undefined {
  return STAGE_SPECS[stageIndex(stage)]
}

/**
 * 工作流脚本要求的**最低**阶段。
 *
 * 技能自己的脚本按这个规则命名，hook 据此判断「现在这个阶段能不能跑它」——
 * 不做命令字符串的模糊匹配，只认脚本名。
 * @param scriptName - 脚本文件名，例如 `draft_build.py`。
 * @returns 要求的最低阶段；不属于本工作流的脚本返回 `undefined`。
 */
export function scriptRequirement(scriptName: string): Stage | undefined {
  const match = /^draft_(survey|plan|build|review|export)\b/.exec(scriptName)
  if (match === null) return undefined
  return match[1] as Stage
}

/** 阶段链的文本表示，形如 `survey → plan → build`。 */
export function renderChain(current: Stage): string {
  return STAGES.map(id => (id === current ? `[${stageSpec(id)?.label ?? id}]` : (stageSpec(id)?.label ?? id))).join(' → ')
}
