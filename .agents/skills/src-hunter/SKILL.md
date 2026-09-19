---
name: src-hunter
description: 实战 SRC / 众测 / Bug bounty 漏洞挖掘工作流。带强制 checkpoint 的 5 阶段流程（intake → recon → enum → hunt → report）、19 个攻击类 playbook（SQLi/XSS/RCE/SSRF/IDOR/CSRF/路径穿越/文件上传/SSTI/XXE/竞态/HTTP 走私/OAuth/JWT/SAML/GraphQL/移动端/LLM/DoS，payload 与绕过手法内联在各自 playbook 里）、国产 OA 与中间件指纹库、银行/电信行业垂直 playbook。当用户提到「src 挖洞 / 漏洞挖掘 / bug bounty / 众测 / hackerone / 漏洞赏金 / SRC / 渗透测试」，或给出一个 URL / API / APK 让你测，或问「怎么绕过 WAF / 如何测某个接口」时使用。
---

# SRC Hunter — 实战漏洞挖掘工作流

> **来源与许可**：本技能改编自 [MyuriKanao/src-hunter-skill](https://github.com/MyuriKanao/src-hunter-skill)（MIT License, Copyright (c) 2026 MyuriKanao），
> 完整许可证见同目录 `LICENSE`。本仓库只收录「能力内核」，未收录其 46MB H1 案例库与 3MB payloader ——
> 差异与补全方式见文末〈收录范围〉。

这是一个**带强制 checkpoint 的工作流**，不是参考手册。每个阶段有 MUST 输出，未通过不进下一阶段。
详细 payload / playbook **必须按需 Read**，不准凭记忆生成。

---

## 触发条件

命中任一即进入：

- 「src 挖洞 / 漏洞赏金 / bug bounty / 众测 / hackerone / Security Response Center」
- 「如何挖 / 怎么测 / 怎么打」+ 某目标 / 某接口 / 某参数
- 「WAF 绕过 / 任意账号 / 任意修改 / 密码重置 / 未授权访问 / 默认凭据」
- 用户给出一个 URL / API endpoint / APK 让你测

**不应触发**：纯白盒源码审计 → 常规代码审计；漏洞修复问答 → 通用对话；CTF → 通用对话。

**前置伦理**：本技能面向**已获授权**的众测 / SRC / 自有资产测试。用户没说清授权来源时，
Phase 1 的 in-scope 确认就是那道闸门 —— 过不了不进 Phase 2。

---

## 反幻觉硬约束（全程适用）

1. **不准凭记忆出 payload**。给 SQLi/RCE/SSRF/XSS 任何 payload 前，先 Read 对应
   `references/playbooks/<type>.md`（或 `<type>/00-index.md` + 具体子文件）。Phase 4 的 payload 必须能在文件里查到出处。
2. **不准引用具体案例编号**。本仓库**未收录** H1 / WooYun 案例库，所以不要写「参考 HackerOne #1234567」这类内容 ——
   没有文件可查的引用一律视为幻觉。要案例，先按文末〈收录范围〉把案例库挂上再说。
3. **无证据不下结论**。没有 HTTP 包 / 截图 / 视频时只能写「待验证 / 假设」，不写「已确认 / 发现漏洞」。
4. **出 scope 立即停**。任何时候发现要测的资产不在 Phase 1 已确认的 in-scope 列表 → 立即停手，回到 Phase 1 重核。

---

## Phase 1 · Intake（接单）

**进入条件**：用户首次给出目标 / 程序名 / URL。

**MUST 输出 checkpoint**（四项缺一不进 Phase 2，缺什么向用户问什么，不要假设）：

- [ ] **In-scope**：可测域名 / IP 段 / app / endpoint（逐条列）
- [ ] **Out-of-scope**：禁测项（逐条列）
- [ ] **规则**：payout tier / disclosure window / safe-harbor / 测试 header（如 `X-Bug-Bounty:<handle>`）
- [ ] **时间盒**：6h / 单日 / HVV / 月度

**仅当用户问「哪个最值得先测」** → Read `references/methodology/05-srctimebox-priority.md`。

---

## Phase 2 · Recon（被动侦察）

**进入条件**：Phase 1 checkpoint 四项全过。

**禁止**：任何主动发包（端口扫描 / 路径爆破 / payload 测试）。

**MUST 输出**：不发包给目标得到的资产清单 + 历史信息，来源 ≥3 种：

- CT 日志（crt.sh / Censys）
- Wayback / CommonCrawl 历史快照
- GitHub dorks（`org:target` + `password|api_key|SECRET|.env`）
- FOFA / Shodan favicon hash
- SecurityTrails / DNS 历史
- ASN / IP 段（bgp.he.net）

---

## Phase 3 · Enum（主动探测）

**进入条件**：Phase 2 资产清单非空。

**MUST 输出**：活资产矩阵 —— `域 → 端口 → 服务 → 指纹 → JS endpoint`。

**条件触发 Read**（命中就必读，不命中不读）：

| 命中信号 | MUST Read |
|---|---|
| 指纹含 `weaver/seeyon/tongda/landray/yongyou/kingdee/hikvision/dahua` | `references/dictionaries/chinese-srcfingerprints.md` + `references/dictionaries/default-credentials-cn.md` |
| 资产含 银行 / 支付 / 网银 / 第三方支付聚合 | `references/industry/banking-finance.md` |
| 资产含 运营商 / BOSS / 网管 / 物联网卡 | `references/industry/telecom-isp.md` |

---

## Phase 4 · Hunt（漏洞探测）

**进入条件**：Phase 3 矩阵 ≥1 个候选目标。

**强制流程**（每个候选目标走一遍）：

1. 看目标信号，从下表选 1 个 playbook
2. **Read 该 playbook 文件**（不准跳过、不准凭记忆替代）
3. 按 playbook 的「参数频率表」挑入口
4. 按 playbook 的「payload 库」探测 —— payload 来自文件，不来自训练记忆
5. 被 WAF 拦 → Read `references/methodology/02-bypass-toolkit.md` 决策树
6. 命中后立即保存 HTTP 包 / 截图 → 进 Phase 5 候选

| 入口信号 | MUST Read |
|---|---|
| Actuator / Swagger / 默认端口 / 弱密码 | `references/playbooks/unauth-access.md` |
| .git / .svn / .env / heapdump / 路径列举 | `references/playbooks/info-disclosure.md` |
| 用户态 ID 可遍历 / 任意 X 越权 | `references/playbooks/arbitrary-x-authz.md` |
| 密码重置 / 支付 / 验证码 / 订单 / 提现 | `references/playbooks/logic-flaws/00-index.md` |
| OAuth / SAML / JWT / redirect_uri | `references/playbooks/oauth-saml-jwt/00-index.md` |
| REST API / BOLA / Mass Assignment / 速率 | `references/playbooks/api-rest/00-index.md` |
| 任何用户输入进 DB | `references/playbooks/sqli.md` |
| 反序列化 / SSTI / XXE / 原型链 / 框架 RCE | `references/playbooks/rce/00-index.md` |
| URL 入参 / 缓存 / Host 注入 | `references/playbooks/ssrf-cache-host/00-index.md` |
| 文件路径入参 / LFI / RFI | `references/playbooks/path-traversal/00-index.md` |
| 上传点 + 解析漏洞 | `references/playbooks/file-upload/00-index.md` |
| 用户输入回显到 HTML / JS | `references/playbooks/xss/00-index.md` |
| 反代 + Content-Length / TE | `references/playbooks/http-smuggling.md` |
| GraphQL endpoint / introspection | `references/playbooks/graphql.md` |
| 并发 / TOCTOU | `references/playbooks/race-conditions.md` |
| ReDoS / 资源不限速 / 算法爆炸 | `references/playbooks/dos.md` |
| APK / IPA / 移动端 | `references/playbooks/mobile.md` |
| LLM agent / prompt 入口 / 工具调用 | `references/playbooks/llm-prompt-injection/00-index.md` |
| 已拿到 shell / 凭据 / 内网 | `references/playbooks/intranet-postexp/00-index.md` |

**两步 Read 模式**（目录形式的 playbook）：第一步只 Read `00-index.md` —— 它含**子文件路由表**和通用方法论。
**不要把 00-index 当 payload 库用**，据路由定位到具体场景后**再 Read 对应子文件**
（如 `rce/14-ssti.md` / `oauth-saml-jwt/12-jwt.md`）。单文件形式的 playbook（`sqli.md` 等）直接 Read。

**通用方法论**（仅在卡壳时 Read，不要预加载）：

- 不知道下一步打什么 → `references/methodology/01-attack-priority.md`
- 被 WAF / EDR 拦 → `references/methodology/02-bypass-toolkit.md`
- 怀疑自己幻觉 / 想检查证据链 → `references/methodology/03-evidence-discipline.md`
- 找不到漏洞点 → `references/methodology/04-control-gap-hunting.md`

---

## Phase 5 · Report（提交）

**进入条件**：Phase 4 至少一个 finding 已具备可重现 HTTP 包 / 截图 / 视频。

**MUST 流程**（顺序执行）：

1. Read `references/compliance.md` 核对合规红线（**不准跳**）
2. Read `references/templates/report-submission.md` 取模板
3. 三段式输出：
   - **标题**：≤80 字，精确到 endpoint + 漏洞类型
   - **重现步骤**：每步可执行，带 HTTP 包 / curl / 截图
   - **影响 + 修复建议**：CVSS 4.0 vector + 业务影响段

---

## 在本 harness（YuanMy）里怎么执行

与上游 skill 的差异必须知道，否则会去调不存在的东西：

| 上游假设 | YuanMy 实际情况 |
|---|---|
| 有 `mcp__jshook__search_tools` 等 MCP 工具 | **没有 MCP**。抓包/编码/爆破用 `bash`（`curl`、`python3`，一次一个全新 shell，状态不保留） |
| — | 长扫描用 `bash` 的 `run_in_background: true`，再用 `job_output` 轮询，别阻塞回合 |
| — | 读网页用 `fetch_url`（只接受 text/JSON），或 `bash` 里的 `curl` |
| — | 找资料用 `read` / `grep` / `glob` / `tree`，不要 `cat`/`find` |
| Claude Code 的 `argument-hint` / `level` frontmatter | DSH 不认这两个键，已移除 |

⚠️ **YuanMy 默认没有沙箱与审批**：本地 provider 意味着 agent 拥有当前用户的全部权限。
所以 `references/compliance.md` 的红线在这里更要当真 —— 尤其「不发 DoS 流量」
「只证明可达、不横向移动」「不下载他人 PII」。

`references/tools/mcp-jshook.md` 是本仓库保留的**工具生态参考**（Burp/Frida/adb 等怎么选型），
但其中列出的 MCP 工具在本 harness 里**不可直接调用**；要对应用法请自己用 `bash` 落地。

---

## 收录范围（与上游的差异）

**本仓库收录**（自包含，离线可用）：

```
SKILL.md                    本文件（已按 DSH/YuanMy 改写）
LICENSE                     上游 MIT 许可证（保留版权声明，必要）
references/methodology/     5 阶段方法论 + 攻击优先级 + 绕过决策树 + 证据纪律
references/playbooks/       19 个攻击类 playbook（payload / 绕过内联在文件里）
references/dictionaries/    国产 OA / 中间件指纹库、国产默认凭据
references/industry/        银行 / 电信行业垂直 playbook
references/templates/       报告模板
references/tools/           工具生态参考（MCP 工具在本 harness 不可直接调用）
references/compliance.md    合规红线（Phase 5 必读）
```

**未收录**（上游有，本仓库刻意不放）：

| 目录 | 上游体积 | 为什么没放 | 想要怎么办 |
|---|---|---|---|
| `references/h1-reports/` | 46 MB | 2887 份案例原始数据，只在「引用具体案例」时才需要，不值得进应用仓库 | 见下 |
| `references/payloader/` | 3.0 MB | 305 个结构化 payload 与 1.1MB `web.json`；playbook 已内联了实际要用的 payload | 见下 |

需要这两块时，把上游装到本机再用 `$YuanMy_SKILL_DIRS` 挂上（冒号分隔，可多个）：

```bash
git clone https://github.com/MyuriKanao/src-hunter-skill ~/.agents/skills/src-hunter-full
# 让 YuanMy 同时扫描它（技能按 <cwd> 定位，所以按需设置）
export YuanMy_SKILL_DIRS="$HOME/.agents/skills/src-hunter-full/references"
```

挂上之后，第 2 条反幻觉约束就恢复成上游版本：**引用案例前必须 Read
`h1-reports/by-weakness/` 下的实际文件，说不出文件路径就别引**。
