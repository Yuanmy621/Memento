---
name: jianying-draft
description: 用 pyJianYingDraft 把素材做成剪映草稿：盘点素材、设计分镜、生成草稿、校验、交付导出。产物是可在剪映里继续编辑的工程。当用户说「剪映 / 草稿 / 剪辑 / 剪一条片子 / 加字幕 / 混剪 / 卡点 / JianYing / 批量出片」，或要给一批视频素材做自动剪辑时使用。
---

# 剪映草稿工作流

**产出的是草稿，不是成片。** 你在剪映的草稿目录里生成/修改一份工程，人打开剪映继续调整并点导出。
把这条记牢：任何「已经剪好了」的说法都是错的，除非人已经导出。

内核为这条工作流挂了闸门：阶段推进由 `draft_stage` 工具负责，跳阶段会被拒绝，
不该跑的脚本会被 `tools/pre-execute` 拦住（理由会直接告诉你现在缺什么）。

## 五个阶段

```
素材盘点 → 分镜设计 → 草稿构建 → 成片校验 → 导出交付
 survey     plan       build      review     export
```

阶段**是产物换来的**，不是声明的。每一步的产物落在 `<stateDir>/draft/`：

| 阶段 | 离开它需要 | 谁产出 |
| --- | --- | --- |
| 素材盘点 | `survey.json`，`assets` 至少一项 | `scripts/draft_survey.py` |
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

## 开工前：写一份 config.json

`<stateDir>/draft/config.json`（`stateDir` 默认是 `<工作目录>/.Memento`）：

```json
{
  "draftStore": "~/Movies/JianyingPro Drafts",
  "mediaDir": "/绝对路径/素材目录"
}
```

`draftStore` 是**剪映的草稿目录**，在剪映的「全局设置 → 草稿位置」里能查到。
写错的表现是「剪映里找不到这份草稿」，所以先用 `ls` 确认这个目录真的存在、里面有别的草稿。

## 1. 素材盘点

```bash
python <技能目录>/scripts/draft_survey.py [素材目录]
```

用 `ffprobe` 逐个读出时长/分辨率，汇总成 `survey.json` 并把摘要打给人看。
**先把清单念给用户确认**：哪个是主素材、哪些是废镜头、要不要按文件名排序。

## 2. 分镜设计

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

## 3. 草稿构建

```bash
python <技能目录>/scripts/draft_build.py
```

生成草稿并 `save()`。脚本最后会打印草稿路径与一行 `draft_stage` 命令，照着登记：

```
draft_stage action=advance draft=<草稿名> draftStore=<草稿目录>
```

## 4. 成片校验

结构检查是自动的，**「剪得对不对」必须由人看** —— 当前模型看不到画面。
所以先把草稿路径给用户，请他在剪映里过一遍，认可后再跑：

```bash
python <技能目录>/scripts/draft_review.py <草稿名> --confirm
```

脚本会检查：正文文件在不在、轨道数、片段数、总时长、有没有过短片段、有没有空文本素材。
**剪映 6+ 的正文可能是加密的**，那时结构检查会跳过并给一条警告 —— 这不算失败，
更重要的是人的确认。

## 5. 导出交付

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
- **素材与草稿都用绝对路径**。脚本的工作目录不保证是你以为的那个。
- **改草稿前先备份**：`draft_build.py` 用 `allow_replace=True` 覆盖同名草稿。
- 剪映里动画/字体首次使用可能显示「加载失败」，**再打开一次草稿**通常就好。

## 脚本清单

| 脚本 | 阶段 | 干什么 |
| --- | --- | --- |
| `scripts/draft_survey.py` | survey | ffprobe 盘点素材 → `survey.json` |
| `scripts/draft_build.py` | build | `plan.json` → 剪映草稿 |
| `scripts/draft_review.py` | review | 结构检查 + 人工确认 → `review.json` |
| `scripts/draft_export.py` | export | 平台判定；非 Windows 打印人工导出清单 |
| `scripts/_common.py` | — | 路径与 JSON 共用工具（不被闸门识别为阶段脚本） |

## 参考

- `references/pyjianyingdraft-api.md` —— pyJianYingDraft 的完整 API（片段/特效/关键帧/模板/导出）与已知边界。改脚本或要用手写 Python 时读它。
