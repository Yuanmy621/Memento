---
description: 把一个产品或品牌收敛成极简可爱的方形 IP 吉祥物形象（logo/图标用）：先提三个方向，再一次性批量出六个候选（内联完整《IP as Logo》方法论，仅本回合生效）
args: '[产品或品牌描述] [可选：主体形象/动物、背景色、方向偏好]'
include:
  - ../skills/ip-as-logo/SKILL.md
---
用户用 `/ip-as-logo` 触发了「极简方形 IP 吉祥物」出图流程。下面内联的
《ip-as-logo》是这次任务的**唯一执行标准**，请完整遵守它（复杂度预算、三色规则、
左下/右下角构图、提示词骨架、批量交付与不筛选不重试），不要凭印象另起一套画法。

执行顺序（与方法论一致）：

1. **先读懂上下文，再问人**：如果用户没说主体形象，而当前工作目录是一个产品仓库，
   先只读地看 README、产品文档、package 元数据、落地页文案、设计 token，能推断出
   「做什么、给谁用、什么气质」就不要问；确实不够时，**只问一轮**背景问题。
2. **先给方向，别直接出图**：三个方向各写成一行「`<IP 主体> — <与产品的关联> — <定义性剪影>`」，
   并明确提议**一次性生成六个候选**（三左三右）。用户没点头之前不要开始生成。
3. **生成**：严格按方法论里的提示词骨架与约束；六个候选**分别独立生成**（有子代理就并行），
   不要拼成九宫格，不要用旧图当参考。提示词里**不许出现** logo / 品牌标记 / 应用图标
   这类用途词 —— 只描述一张图。
4. **需要图像模型**：优先 GPT Image 2，其次 Seedance 5.0 Pro / Nano Banana Pro / Nano Banana 2。
   当前会话里没有可用图像工具时，**先告诉用户并索要工具或 API key**；绝不用 SVG 顶替，
   也不要编造生成结果。
5. **交付**：每个候选都报标签（A1…）、方向与理由、所属角、保存路径、提示词/配色映射、尺寸；
   一次交付全部结果，**不做筛选、不自动重试、不事后修补**。用户明确要求再来一轮时才重画。

---

## 已经接过一个可用的图像工具：SenseAudio 同步出图（2026-09 实测）

同一个工作目录里已经有一整套**跑通过**的脚本（`.tmp/ip-as-logo/`，`.tmp/` 是 scratch，
交付物另存 `~/.Memento/ip-as-logo/<日期>/`）：

| 文件 | 作用 |
| --- | --- |
| `prompts.json` | 六个候选的 `{label, direction, corner, palette, model, size, prompt}` |
| `build-prompts.mjs` | 按提示词骨架拼 6 条提示词，并**校验码位数**（该模型上限 2048，实测压到 1955–1967） |
| `run.mjs` | 独立请求 → 原子落盘 → `sips` 独立解码校验 → 增量写 `run-log.json`；**可续跑** |
| `start.sh` / `daemonize.py` | 守护化启动（见下），`status.sh` 看进度 |

接口与约束（**每次动手前先读文档确认，别照抄这段当契约**）：
`POST https://api.senseaudio.cn/v1/image/sync`，body `{model, prompt, size}` → `{url}`；
模型 `doubao-seedream-5-0-260128`；`prompt` ≤ 2048 码位；方形尺寸从 `2048x2048` 起。
key 放 `~/.Memento/senseaudio.key`（600）或 `SENSEAUDIO_API_KEY`。

### ⚠️ 长任务必须守护化启动，否则会被 harness 连坐杀掉

harness 的 bash 执行器把**每次工具调用**放进一个受管进程组，turn 被中断
（用户点停止 / 会话 teardown）时对整组 `SIGTERM→SIGKILL`。`nohup ... &` 只挡 SIGHUP，
**挡不住这个清理**。实测对照（同一分钟、同样的心跳脚本）：

| 启动方式 | 子进程 pgid | 杀掉工具调用那一组之后 |
| --- | --- | --- |
| `nohup ./hb.sh &` | **= 工具调用的 pgid** | 立刻死（心跳停在 19 行） |
| `setsid` 等价物（fork→setsid→fork→exec） | 自己的新 pgid | 继续活（心跳 19 → 32 行） |

所以：**别用 `nohup`，也别用 `job_output(wait: true)` 阻塞等**（后台任务记录会随 turn
中断一起被回收）。用 `./start.sh [--only X]` 守护化启动，然后每 10–20 秒用
`./status.sh`（或 `node run.mjs --status`）看一眼即可 —— 单次工具调用也就几十毫秒，
不会触发任何超时。macOS 没有 `setsid(1)`，所以 `daemonize.py` 用 Python 做
fork→`os.setsid()`→fork→`execvp`。

出图本身一发约 40–50 秒，六张按并发 3 分两波；**只要没被连坐杀掉，续跑不会重画**
（`run-log.json` 里已 ok 且文件还在的直接认），所以中途被打断最多损失正在飞的那几发。
