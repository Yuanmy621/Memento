/**
 * `opencli butian vulns` —— 我的补天漏洞列表。
 *
 * 数据源：`POST /WhiteHat/Center/loo`（需要 Cookie + 漏洞列表页的 token）。
 * 参数与字段全部取自该页自身的筛选表单与行渲染代码：
 * 筛选是 `title` / `level` / `status` / `p`，行里有
 * `level, title, company_name, create_time, amount, extcredits, number, status` 等。
 *
 * 做 SRC 时的典型用法：`opencli butian vulns --status 4`（看已完结的）、
 * `--status 1`（看还在审核的）、`--title 某厂商`（按厂商筛）。
 *
 * @module Memento/opencli/clis/butian/vulns
 */

import { cli, Strategy } from '@jackwener/opencli/registry'
import { EmptyResultError } from '@jackwener/opencli/errors'
import { DOMAIN, ORIGIN, apiPost, levelLabel, pageToken, statusLabel } from './utils.js'

cli({
  site: 'butian',
  name: 'vulns',
  description: '我的补天漏洞列表（可按名称/级别/状态筛选）：级别、漏洞名、厂商、状态、提交时间、奖金、积分',
  access: 'read',
  example: 'opencli butian vulns --status 1',
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  browser: false,
  args: [
    { name: 'title', help: '按漏洞名称或厂商关键字筛选' },
    { name: 'level', type: 'int', help: '级别：0=低 1=中 2=高 3=严重' },
    { name: 'status', type: 'int', help: '状态：1=待审核 6=待补充 7=处理中 3=待打款 4=已完结 5=已忽略' },
    { name: 'page', type: 'int', default: 1, help: '页码（从 1 开始）' },
  ],
  columns: ['level', 'title', 'company_name', 'status', 'create_time', 'amount', 'extcredits', 'number'],
  func: async (args) => {
    const token = await pageToken('/WhiteHat/Center/loo')
    const data = await apiPost('/WhiteHat/Center/loo', {
      title: args.title ?? '',
      level: args.level ?? '',
      status: args.status ?? '',
      p: args.page ?? 1,
      token,
    }, `${ORIGIN}/WhiteHat/Center/loo`)

    // 没有漏洞时补天返回的是空字符串而不是空数组，这里统一成数组。
    const list = Array.isArray(data?.list) ? data.list : []
    if (list.length === 0) {
      throw new EmptyResultError(
        'butian vulns',
        `没有符合条件的漏洞（该账号共 ${String(data?.count ?? 0)} 条）。换个筛选条件试试。`,
      )
    }
    return list.map((item) => ({
      level: levelLabel(item.level),
      title: item.title ?? '',
      company_name: item.company_name ?? '',
      status: statusLabel(item.status),
      create_time: item.create_time ?? '',
      amount: item.amount ?? '',
      extcredits: item.extcredits ?? '',
      number: item.number ?? '',
    }))
  },
})
