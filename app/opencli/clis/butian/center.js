/**
 * `opencli butian center` —— 我在补天个人中心的概览。
 *
 * 数据源：`POST /WhiteHat/Center/spaceData`（需要 Cookie + 该页的 token）。
 * 这条接口是个人中心的「一次性汇总」，等级、积分、荣誉币、漏洞数、认证状态都在里面，
 * 所以一个命令就能看清账号现状。
 *
 * @module Memento/opencli/clis/butian/center
 */

import { cli, Strategy } from '@jackwener/opencli/registry'
import { CommandExecutionError } from '@jackwener/opencli/errors'
import { DOMAIN, ORIGIN, apiPost, pageToken } from './utils.js'

cli({
  site: 'butian',
  name: 'center',
  description: '我在补天个人中心的概览：昵称、等级、称号、积分、荣誉币、漏洞数、排名、认证状态',
  access: 'read',
  example: 'opencli butian center',
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  // 纯 Node fetch：不需要 opencli 的 Chrome 扩展（凭据来自本地文件）。
  browser: false,
  args: [],
  columns: ['user_name', 'level', 'team', 'honor_count', 'price', 'total_loo', 'rank', 'medal_count', 'cert_status', 'register_day'],
  func: async () => {
    const token = await pageToken('/WhiteHat/Center')
    const data = await apiPost('/WhiteHat/Center/spaceData', { token }, `${ORIGIN}/WhiteHat/Center`)
    if (data === null || typeof data !== 'object') {
      throw new CommandExecutionError('spaceData 返回的结构不是对象（补天改版了？）')
    }
    const cert = data.combat_cert_info ?? {}
    return [{
      user_name: data.user_name ?? '',
      level: data.level ?? '',
      team: data.team?.title ?? '',
      honor_count: data.honor_count ?? 0,
      price: data.price ?? 0,
      total_loo: data.total_loo ?? '0',
      rank: data.rank ?? '-',
      medal_count: data.medal_count ?? 0,
      cert_status: cert.status_text ?? '',
      register_day: data.register_day ?? 0,
    }]
  },
})
