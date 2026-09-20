/**
 * `opencli butian missions` —— 补天的任务进度。
 *
 * 数据源：`GET /WhiteHat/Mission/lists`（需要 Cookie，不需要 token）。
 * 返回是按分类分组的对象（如「邀请好友」「日常任务」），每类下面一组任务，
 * 所以这里摊平成一张表，分类作为一列。
 *
 * 任务的 `status` 是补天自己的一套码，这里**原样显示**（不猜）—— 想按状态筛
 * 就看输出里的数字，或去页面上对照。
 *
 * @module YuanMy/opencli/clis/butian/missions
 */

import { cli, Strategy } from '@jackwener/opencli/registry'
import { EmptyResultError } from '@jackwener/opencli/errors'
import { DOMAIN, ORIGIN, apiGet } from './utils.js'

cli({
  site: 'butian',
  name: 'missions',
  description: '补天任务/成就的进度（按分类摊平）：任务名、进度、奖励、状态',
  access: 'read',
  example: 'opencli butian missions',
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  browser: false,
  args: [
    { name: 'page', type: 'int', default: 1, help: '页码（从 1 开始）' },
  ],
  columns: ['category', 'title', 'progress', 'reward', 'status'],
  func: async (args) => {
    const data = await apiGet('/WhiteHat/Mission/lists', { p: args.page ?? 1 }, `${ORIGIN}/WhiteHat/Center`)
    const grouped = data?.list
    if (grouped === null || typeof grouped !== 'object') {
      throw new EmptyResultError('butian missions', '这次没拿到任务列表（该账号可能还没有可领的任务）。')
    }
    const rows = []
    for (const [category, items] of Object.entries(grouped)) {
      if (!Array.isArray(items)) continue
      for (const item of items) {
        rows.push({
          category,
          title: item.title ?? '',
          progress: `${String(item.current ?? 0)}/${String(item.target ?? 0)}`,
          reward: item.reward ?? '',
          status: item.status ?? '',
        })
      }
    }
    if (rows.length === 0) {
      throw new EmptyResultError('butian missions', '该账号当前没有任务。')
    }
    return rows
  },
})
