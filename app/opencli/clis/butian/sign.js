/**
 * `opencli butian sign` —— 补天签到状态。
 *
 * 数据源：`POST /WhiteHat/Sign/continue_days`（需要 Cookie，不需要 token）。
 * 这个接口直接返回一个数字：连续签到天数。
 *
 * 只读：**不**调用签到接口本身（`/WhiteHat/Sign/userCheckin`）——
 * 那会真实改变账号数据，要加的话请自己确认清楚再加。
 *
 * @module Memento/opencli/clis/butian/sign
 */

import { cli, Strategy } from '@jackwener/opencli/registry'
import { DOMAIN, ORIGIN, apiPost } from './utils.js'

cli({
  site: 'butian',
  name: 'sign',
  description: '我在补天的连续签到天数（只读，不会替你签到）',
  access: 'read',
  example: 'opencli butian sign',
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  browser: false,
  args: [],
  columns: ['consecutive_days'],
  func: async () => {
    const days = await apiPost('/WhiteHat/Sign/continue_days', {}, `${ORIGIN}/WhiteHat/Center`)
    return [{ consecutive_days: typeof days === 'number' ? days : Number(days ?? 0) }]
  },
})
