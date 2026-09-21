<div align="center">

# Butian SRC Hunter

**AI + 补天SRC 漏洞挖掘全流程技能**
**AI-driven vulnerability hunting, verification & reporting for Butian SRC (China)**

![Version](https://img.shields.io/badge/version-1.1.0-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Platform](https://img.shields.io/badge/platform-ZCode%20%7C%20Claude%20Skills-orange) ![Python](https://img.shields.io/badge/python-3.8%2B-informational)

一个让 AI 按补天官方规范挖洞、验洞、写报告的 Agent Skill——
授权核实 → 资产侦察 → 漏洞发现 → **专业工具验证** → 规范报告 → 照表提交。

[安装](#安装) · [快速开始](#快速开始) · [示例输出](#示例输出) · [自带靶场](#自带演练靶场) · [English](#english)

</div>

## 它解决什么问题

用 AI 挖洞的人几乎都栽在三件事上：

1. **误报当洞交** —— 扫描器/AI 说有漏洞就直接交，结果"复现失败作忽略处理"，刷多了还有封号风险（补天官方规则原文：*未经人工验证的AI生成的漏洞，多次提交可能面临封号风险*）；
2. **报告不规范被驳回** —— 补天对标题格式、DREAD 定级、证据"四件套"、修复建议都有硬性要求，乱填扣分；
3. **流程没章法** —— 从授权确认到提交信息表没有固定产出物，每单全靠现场发挥。

本技能把这三个坑全部规则化：**未验证 = 不存在 = 禁止进报告**（第一不可违背原则），报告与提交表严格对齐官方模板，6 个阶段每段有放行条件。

## 工作流（6 阶段，每段有产出物与放行条件）

| 阶段 | 内容 | 产出 |
|---|---|---|
| 0 授权确认 | 补天收录核实、ICP 归属核验、测试边界 | `out/01-authorization.md` |
| 1 资产侦察 | crt.sh 子域、存活指纹、敏感路径（仅 HEAD） | `out/02-assets.md` |
| 2 漏洞发现 | 官方关注 10 类漏洞线索 + 避开官方忽略清单 | `out/03-candidates.md` |
| 3 真实性验证 | **验证授权关卡** + 专业工具验证链 + 误报淘汰 | `out/04-verified.md` `out/05-rejected.md` |
| 4 报告生成 | DREAD 双轨定级、A-B-C 危害闭环、四件套附录 | `out/report-*.md` |
| 5 提交信息表 | 字段对齐官方表单，照表复制粘贴即可 | `out/submit-info-*.md` |

## 核心特性

- **第一不可违背原则**：每个候选漏洞必须走"专业工具验证链"——sqlmap/nuclei → 定制 PoC → curl 取证 → 兜底手写，亲自复现完整利用链、产出可重复运行的 `poc.py`、独立会话重复验证 ≥2 次。验证不过关的候选直接进误报淘汰清单。
- **补天官方规则内化**：DREAD 五维打分 + 官方三档描述双轨定级；官方忽略清单（缺头、url 跳转、CORS、公开文件等 8 类）前置避坑；奖励按厂商权重分档估算。
- **证据"四件套"对齐官方**：漏洞URL截图、归属证明、首页截图、漏洞证明，报告附录直接按此组织。
- **ICP 归属核验前置**：先证明目标归属，再动手测试——避免测错厂商（误归属 = 白测 + 平台驳回）。
- **逐项授权机制**：sqlmap/nuclei/定制 PoC 每条命令执行前需用户单独确认；侦察脚本内置授权门禁（`--authorized`）、强制 TLS 证书校验、敏感路径仅 HEAD 探测——合规与安全默认值内建，不依赖使用者自觉。
- **AI 合规**：每份报告自动附"人工核验检查清单"，提醒提交者本人复现后再交。
- **自带演练靶场**：内置 127.0.0.1 靶场（2 个真漏洞 + 2 个误报陷阱），可当场验收技能全流程，也能用于练手教学。

## 目录结构

```
butian-src-hunter/
├── SKILL.md                        # 主流程：铁律 + 6 阶段工作流
├── references/
│   ├── butian-rules.md             # 补天官方规范汇总（DREAD、奖励分档、忽略清单、提交模板）
│   └── vuln-playbook.md            # 专业工具验证链 + 漏洞验证手法 + 误报特征
├── scripts/
│   └── recon.py                    # 侦察脚本（授权门禁 + TLS 校验 + 仅 HEAD 探测）
├── assets/
│   ├── report-template.md          # 报告模板
│   ├── submit-table-template.md    # 提交信息表模板
│   └── lab/app.py                  # 自带演练靶场（127.0.0.1:8899）
└── README / LICENSE / SECURITY / CONTRIBUTING / CHANGELOG
```

## 安装（ZCode）

1. 克隆或下载本仓库，得到 `butian-src-hunter/` 目录；
2. 放入技能目录（二选一）：
   - 全局可用：`~/.agents/skills/butian-src-hunter/`（Windows 即 `C:\Users\<你>\.agents\skills\`）
   - 仅当前项目：`<项目>\.agents\skills\butian-src-hunter/`
   - Claude Code 兼容：`~/.claude/skills/butian-src-hunter/`
3. 重启会话，技能列表出现 `butian-src-hunter` 即安装成功。

依赖：Python 3.8+（侦察脚本与靶场均用标准库实现，无第三方依赖）；sqlmap/nuclei/subfinder 装了更好，没装不影响——技能会自动降级到 curl + Python 标准库手写验证。

## 快速开始

安装后直接对 AI 说：

```
帮我在补天找一个公益SRC跑一遍，挖到漏洞按规范出报告
```

```
我有一条候选漏洞：<URL + 现象>，帮我做专业验证
```

```
启动自带靶场，完整跑一遍你的技能流程让我看看
```

## 示例输出

侦察脚本对自带靶场的真实运行结果（注意：敏感路径全部停在 HEAD 存在性探测，**不读取任何内容**）：

```
# 资产侦察结果

| 主机 | 状态 | 标题 | 敏感路径命中 |
|---|---|---|---|
| http://127.0.0.1:8899 | 200 | XX图书管理系统 测试站 | /.env -> 501(不支持HEAD，合规要求不回退GET) |
|  |  |  | /.git/HEAD -> 501(不支持HEAD，合规要求不回退GET) |
```

验证阶段的结论样例（`out/04-verified.md`，来自靶场验收）：

```
## V-20260828-001 基于布尔回显的 SQL 注入（/api/user?id=）
- 验证链：布尔对照（1 AND 1=2 → user not found）
  → UNION 取证（sqlite_version() = 3.45.3，满足官方"可取库名"门槛）
- 证据：poc.py（断言通过）/ request.txt / response.txt / 重现性矩阵 2/2 一致
```

误报淘汰同样有记录（`out/05-rejected.md`）：`/admin` 静态登录页（无功能，假阳性）、`/search?q=` 输出全编码（XSS 假阳性）——**假阳性处理能力与真漏洞同等重要**。

## 自带演练靶场

```bash
python assets/lab/app.py    # 启动后访问 http://127.0.0.1:8899
```

仅监听本机，数据全部虚构。埋点：`/.env` 信息泄露（真）、`/api/user?id=` SQL 注入（真）、`/admin` 登录页（假阳性）、`/search?q=` 全编码输出（假阳性）。合格的技能运行 = 2 个真漏洞出完整验证链 + 2 个假阳性被淘汰并写明理由。

## 使用边界

本技能仅用于**获得授权的安全测试**：补天平台收录目标、自有资产、明确授权的靶场。技能内置三道闸：目标不在收录范围立即终止、最小影响只读验证、主动验证工具逐项经用户授权。违规使用（未授权测试、破坏、数据窃取）责任由使用者自负，详见 [SECURITY.md](SECURITY.md) 与 [LICENSE.md](LICENSE.md)。

## 参与贡献

欢迎 PR！规则库更新（补天规则变化）与验证手法补充最有价值——见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## English

**Butian SRC Hunter** is an agent skill that runs the full bug-hunting workflow against Butian SRC (a major Chinese vulnerability disclosure platform): scope & ICP verification → passive/limited recon → candidate discovery → **mandatory tool-based verification** (no verified exploit = no report) → standard-compliant reports → submission sheets. Ships with a local test lab (127.0.0.1) containing 2 real vulnerabilities and 2 false-positive traps to validate the whole pipeline. MIT licensed; **for authorized security testing only** — see [SECURITY.md](SECURITY.md).

## 许可证

[MIT](LICENSE.md)（附授权使用附加条款）。更新日志见 [CHANGELOG.md](CHANGELOG.md)。
