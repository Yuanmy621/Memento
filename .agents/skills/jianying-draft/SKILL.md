---
name: jianying-draft
description: 用 pyJianYingDraft 把素材做成剪映草稿：盘点素材、分析风格并选模板、设计分镜、生成草稿、校验、交付导出。节奏与模板选择由 Jev 的标定概率 + 置信度门控决定，不靠猜。产物是可在剪映里继续编辑的工程。当用户说「剪映 / 草稿 / 剪辑 / 剪一条片子 / 加字幕 / 混剪 / 卡点 / 套模板 / 这条片子怎么剪 / JianYing / 批量出片」，或要给一批视频素材做自动剪辑时使用。
---

# 剪映草稿工作流

**产出的是草稿，不是成片。** 你在剪映的草稿目录里生成/修改一份工程，人打开剪映继续调整并点导出。
把这条记牢：任何「已经剪好了」的说法都是错的，除非人已经导出。

内核为这条工作流挂了闸门：阶段推进由 `draft_stage` 工具负责，跳阶段会被拒绝，
不该跑的脚本会被 `tools/pre-execute` 拦住（理由会直接告诉你现在缺什么）。

## 六个阶段

```
素材盘点 → 风格分析 → 分镜设计 → 草稿构建 → 成片校验 → 导出交付
 survey    analyze     plan       build      review     export
```

阶段**是产物换来的**，不是声明的。每一步的产物落在 `<stateDir>/draft/`：

| 阶段 | 离开它需要 | 谁产出 |
| --- | --- | --- |
| 素材盘点 | `survey.json`，`assets` 至少一项 | `scripts/draft_survey.py` |
| 风格分析 | `style.json`（测量 + Jev 判断 + 模板路由） | `scripts/draft_analyze.py` + 你调 Jev |
| 分镜设计 | `plan.json`，`approved: true` | 你写，**人确认后**才置 true |
| 草稿构建 | 草稿真的出现在草稿目录里 | `scripts/draft_build.py` |
| 成片校验 | `review.json`，`passed: true` | `scripts/draft_review.py --confirm` |
| 导出交付 | （终点） | 人工导出 |

随时可以问当前在哪：

```
draft_stage action=status
```

推进与回退（`note` 会被记进状态文件的历史）：

```
draft_stage action=advance note="素材已盘点，开始设计分镜"
draft_stage action=back    note="结尾字幕时长不对，退回重建"
```

## 开工前：确认草稿目录

`<stateDir>/draft/config.json`（`stateDir` 默认是 `<工作目录>/.Memento`）**整个文件都是可选的**：

```json
{
  "draftStore": "/剪映草稿目录（可省略，会自动探测）",
  "mediaDir": "/素材目录（可省略，默认当前目录）"
}
```

**`draftStore` 一般不用写**：脚本会去读剪映自己的配置文件
（`Config/globalSetting` 里的 `currentCustomDraftPath`），那就是「全局设置 → 草稿位置」记的值。
只有自动探测失败、或你想写到别处时才显式指定。

macOS 上剪映是**沙盒应用**，草稿实际在容器里：

```
~/Library/Containers/com.lemon.lvpro/Data/Movies/JianyingPro/User Data/Projects/com.lveditor.draft
```

`~/Movies/JianyingPro/User Data/...` 与它是同一个目录（系统做的路径映射），两个写法都能用。

## 与剪映 App 的关系

**这是文件级投递，不是 App 连接。** 说清楚边界，免得预期错位：

| 能 | 不能 |
| --- | --- |
| 往草稿库里写草稿，剪映刷新列表后就能看到并编辑 | 控制正在运行的剪映（播放、导出、切页面） |
| 读剪映的配置（自动定位草稿库） | 实时同步时间轴（改了草稿，App 里不会自动变） |
| 读草稿文件做结构校验 | 读取 App 当前打开的内容 |

剪映**没有可编程接口**：没有 AppleScript 字典、没有开放的 CEF 调试端口、导出也只能人工点。
所以「生成草稿 → 人在剪映里确认 → 人点导出」是这个平台上唯一稳的链路。

**刷新时机**：剪映启动时扫草稿库。新草稿写进去后，需要**重启剪映**，或在草稿页进出一次别的草稿，
它才会出现在列表里。这不是脚本能控制的 —— 交付时要把这句告诉用户。

## 1. 素材盘点

```bash
python <技能目录>/scripts/draft_survey.py [素材目录]
```

用 `ffprobe` 逐个读出时长/分辨率，汇总成 `survey.json` 并把摘要打给人看。
**先把清单念给用户确认**：哪个是主素材、哪些是废镜头、要不要按文件名排序。

## 2. 风格分析：测量 → Jev 判断 → 代码决策

这一步决定「这条片子该怎么剪、套哪个模板」。三层分工，**不要让模型自己拍一个答案**：

| 层 | 谁做 | 产出 |
| --- | --- | --- |
| 测量 | `draft_analyze.py measure`（ffmpeg，确定性、不花 token） | 镜头长度分布、切点密度、静音间隙、语速、亮度/饱和度 |
| 判断 | **Jev**（`sysone_ask`，返回**标定概率 + 置信度**） | 节奏档位、内容类型、信息密度、情绪能量 |
| 决策 | **`sysone_compose mode=route`**（纯算术） | act / review / escalate |

### 第一步：测量

```bash
python <技能目录>/scripts/draft_analyze.py measure [--srt 已有字幕.srt]
```

产出 `measures.json` 与 `questions.json`（后者是**给你照着问 Jev 的问题集**）。
`--srt` 可选：有转写就用它算语速（剪映自己识别出的字幕导成 SRT 即可）。

### 第二步：问 Jev（两次 `sysone_ask` + 一次 `sysone_compose`）

脚本不能调 Jev，这一步由你来做。**照抄 `questions.json` 里的字段，别自己改问题**：

```
sysone_ask(
  state     = questions.json 的 profile.state,
  questions = questions.json 的 profile.questions,
)
```

拿到答案后，第二个 ask 把「第一轮的答案摘要」并进 state（模板匹配要看风格画像）：

```
sysone_ask(
  state     = 候选模板说明 + 第一轮判定的节奏/内容/密度/能量,
  questions = questions.json 的 template.questions,
)
sysone_compose(
  mode    = "route",
  answers = [ 第二轮 template 那一问的答案 ],
)
```

`route` 的返回值就是决策，**不要自己解释置信度**：

| decision | 含义 | 你该做什么 |
| --- | --- | --- |
| `act` | 置信度 ≥ `act_at`（默认 0.7） | 直接用选中的模板，把 `alsoNotify` 里概率也不低的候选一并讲给用户 |
| `review` | 0.4~0.7 | **不自动选**：把建议的模板和理由讲给用户，等他点头再往下 |
| `escalate` | < 0.4 | 分布太散，**别硬选**：列出候选让人定，或改从零构建 |

把这三次调用的**原始输出原样**存成 `jev.json` —— 直接粘文本，**不要归纳、不要换算、不要重排**：

```json
{ "profile": "<第一次 sysone_ask 的原文>",
  "template": "<第二次 sysone_ask 的原文>",
  "route": "<sysone_compose 的原文>" }
```

脚本会自己解析这种文本（模型只看得到渲染后的文本，结构化字段拿不到，所以解析放在脚本里做）。
自己「整理」成结构化 JSON 反而容易把 `score/scaleMax` 换算错、或把 `decision` 写成 `null`。

### 第三步：落成 style.json

```bash
python <技能目录>/scripts/draft_analyze.py decide jev.json
```

合并成 `style.json` —— 这就是离开本阶段的凭据。`escalate` 时脚本会拒绝收尾，
要你先把人的决定写进 `decision.chosen` 再跑一次。

### 不想做分析？显式留下记录

```bash
python <技能目录>/scripts/draft_analyze.py skip --reason "用户要求直接按原片拼接"
```

跳过也是一条要留痕的决定，闸门靠这条记录放行（而不是靠你绕过它）。

### 模板注册表

候选模板放在 `<stateDir>/draft/templates/<名字>/template.json`，每个模板对应一份**真实的剪映草稿**：

```json
{
  "name": "竖屏口播",
  "summary": "真人出镜口播，大字幕，节奏偏快，适合知识与观点输出",
  "aspect": "9:16",
  "idealPacing": "fast",
  "idealContent": ["talking_head"],
  "draftName": "TPL-竖屏口播"
}
```

`name` 会作为 Jev 的选项名，`summary` 等字段拼成它的描述 —— **描述写得越具体，Jev 的判断越有依据**。
目录不存在或没有模板时，脚本会跳过错模板选择，`style.json` 里的决策是「按素材自行构建」。

## 3. 分镜设计

读 `survey.json`，写出 `plan.json`。**先跟用户讲清意图再落笔**：成片多长、什么节奏、
哪些片段要、字幕从哪来。然后写文件，并把 `approved` 留成 `false` 请用户确认 ——
用户点头后才改 `true`（这是硬要求，`draft_build.py` 会拒绝未确认的 plan）。

```json
{
  "approved": false,
  "draftName": "launch-video",
  "width": 1920, "height": 1080, "fps": 30,
  "template": "某个已有草稿名",
  "tracks": [
    { "type": "video", "name": "主轨" },
    { "type": "audio", "name": "bgm" },
    { "type": "text",  "name": "字幕" }
  ],
  "clips": [
    {
      "track": "主轨", "kind": "video", "path": "/绝对路径/a.mp4",
      "start": 0, "duration": 4.0,
      "sourceStart": 2.0, "speed": 1.25, "volume": 0.8,
      "fadeIn": "0.5s", "fadeOut": "0.5s",
      "intro": "渐显", "outro": "渐隐",
      "effect": { "name": "全息扫描", "params": [null, null, 100] },
      "filter": { "name": "原生肤", "intensity": 10 },
      "keyframes": [ { "property": "alpha", "at": 0, "value": 1.0 },
                     { "property": "alpha", "at": 4.0, "value": 0.0 } ]
    },
    { "track": "bgm", "kind": "audio", "path": "/绝对路径/bgm.mp3",
      "start": 0, "duration": 12.0, "volume": 0.35, "fadeOut": "2s" },
    { "track": "字幕", "kind": "text", "text": "标题",
      "start": 0.5, "duration": 2.5, "intro": "复古打字机",
      "transform_y": -0.7, "style": { "size": 8.0, "color": [1, 1, 1] } }
  ],
  "subtitles": { "srt": "/绝对路径/captions.srt", "track": "字幕", "offset": 0.5 }
}
```

写法约定：

- **时间**：数字 = 秒（可为小数）；字符串走剪映语法（`"1.5s"`、`"1m30s"`）。
- `start` 是**在时间轴上的位置**，`sourceStart` 是**从素材里截哪一段**，`duration` 是成片里占多久。
- `kind` 只支持 `video` / `image` / `audio` / `text`。
- `intro` / `outro` / `effect` / `filter` 都按**中文名**解析（`from_name`，忽略大小写与空格）；
  名字不对会报错并提示去查 `references/pyjianyingdraft-api.md`。
- 效果参数（`params`）的顺序与枚举注释一致，且**不一定**与剪映界面里的顺序一致。

## 4. 草稿构建

```bash
python <技能目录>/scripts/draft_build.py
```

生成草稿并 `save()`。脚本最后会打印草稿路径与一行 `draft_stage` 命令，照着登记：

```
draft_stage action=advance draft=<草稿名> draftStore=<草稿目录>
```

## 5. 成片校验

结构检查是自动的，**「剪得对不对」必须由人看** —— 当前模型看不到画面。
所以先把草稿路径给用户，请他在剪映里过一遍，认可后再跑：

```bash
python <技能目录>/scripts/draft_review.py <草稿名> --confirm
```

脚本会检查：正文文件在不在、轨道数、片段数、总时长、有没有过短片段、有没有空文本素材。
**剪映 6+ 的正文可能是加密的**，那时结构检查会跳过并给一条警告 —— 这不算失败，
更重要的是人的确认。

## 6. 导出交付

```bash
python <技能目录>/scripts/draft_export.py <草稿名>
```

macOS 与 Linux 上**没有自动导出**：桌面版剪映没有可编程接口，脚本会打印人工导出清单。
Windows + 剪映 6 及以下才会尝试 `JianyingController` 自动导出。

导出后把成片路径告诉用户，并明确问一句「要不要再改」—— 剪辑很少一次到位。

## 硬约束

- **不要把「已生成草稿」说成「已剪好」**。草稿要人在剪映里打开、确认、导出。
- **不要跳过阶段**。闸门会拒绝，而且理由是具体的（缺哪个文件、要先去哪个阶段）。
- **`plan.json` 的 `approved` 只能由人的确认来置 true**，不要自己改成 true 蒙过闸门。
- **风格判断交给 Jev，不要自己拍**。标定概率与置信度就是为了让「选哪个模板」这件事可复现；
  自己给一个答案等于把这个设计作废。`escalate` 时更不能硬选。
- **问 Jev 的问题照抄 `questions.json`**。问题集是按现有测量维度设计的，临时改问法会破坏可比性。
- **素材与草稿都用绝对路径**。脚本的工作目录不保证是你以为的那个。
- **改草稿前先备份**：`draft_build.py` 用 `allow_replace=True` 覆盖同名草稿。
- 剪映里动画/字体首次使用可能显示「加载失败」，**再打开一次草稿**通常就好。

## 脚本清单

| 脚本 | 阶段 | 干什么 |
| --- | --- | --- |
| `scripts/draft_survey.py` | survey | ffprobe 盘点素材 → `survey.json` |
| `scripts/draft_analyze.py` | analyze | ffmpeg 测量 → `measures.json`/`questions.json`；合并 Jev 输出 → `style.json` |
| `scripts/draft_build.py` | build | `plan.json` → 剪映草稿 |
| `scripts/draft_review.py` | review | 结构检查 + 人工确认 → `review.json` |
| `scripts/draft_export.py` | export | 平台判定；非 Windows 打印人工导出清单 |
| `scripts/_common.py` | — | 路径与 JSON 共用工具（不被闸门识别为阶段脚本） |

## 参考

- `references/pyjianyingdraft-api.md` —— pyJianYingDraft 的完整 API（片段/特效/关键帧/模板/导出）与已知边界。改脚本或要用手写 Python 时读它。
