# System One 插件

模型只负责给**判断**，代码负责**决策**。

本插件只接 **TypeSafe 官方 Jev**（`POST /v1/systemone`）：一次请求回答全部问题，
返回**标定过**的概率与置信度。没有本地模型兜底 —— 没配 key 或调用失败时，
`sysone_ask` 直接报错，不会偷偷换成未标定的采样结果。

```bash
TYPESAFE_API_KEY=apikey_xxx npm start                       # 必配，否则 sysone_ask 直接报错
TYPESAFE_BASE_URL=... TYPESAFE_MODEL=jev-latest npm start   # 可选，默认官方地址/jev-latest
```

挂上之后工具表里多两个：`sysone_ask` / `sysone_compose`。

## 为什么接它（上游的设计逻辑，不是 API 包装）

Introduction 那篇的核心论点是**分工**，不是「又一个模型」：

> LLM 是给人读的文本生成器。当你要模型做一个**代码要消费**的判断时，就出现了错配 ——
> 你在把一个文本生成系统硬掰成结构化输出，再把结果解析回代码能依赖的东西。

Jev 把「判断」做成一等公民：给一份 **state** 和一组**带类型的问题**，拿回
**结构化的答案 + 概率分布 + 置信度**，代码直接分支、排序、路由。由此推出的工程约定，
本插件逐条落地：

| 上游约定（出处） | 本插件里的落点 |
| --- | --- |
| 一次问多个**原子**问题；并行、互相隔离；加问题几乎不增耗时 | `sysone_ask`：一次请求里全部问题独立评估 |
| 复杂判断要**拆**，再用代码里的权重合起来（Composite scoring） | `sysone_compose(mode=composite)`：权重与归一化都是确定性代码 |
| 置信度用来决定「行动 / 复核 / 升级」（Confidence-gated routing） | `sysone_compose(mode=route)`：三个出口 + `alsoNotify` |
| **代码拥有工作流**，模型只提供判断 | 组合/阈值/权重全在 `primitives.ts`（纯函数，不花 token） |
| `confidence` 只描述这次回答的分布有多集中，不代表答案正确 | 输出保留 `confidence`；路由把「散」当成升级信号而不是硬选 |
| 阈值要在**自己的数据**上调 | 阈值是工具参数/常量，改一行即可，不用重跑推理 |

## 三个 primitives（与上游字段一一对应）

| 类型 | 问什么 | 答案 |
| --- | --- | --- |
| `choice` | 从固定选项里选一个（`criteria` 是「选项 → 描述」映射） | `choice` + `probabilities` + `confidence` |
| `score` | 落在一条有序标尺的哪一格（`criteria` 是有序档位数组，2~10 档） | `score`（可为小数）+ `probabilities` + `legend` + `confidence` |
| `noul` | 这个陈述成立吗 | `noul`（0~1 概率） |

`score` 的算法与上游一致：`score = Σ 档位号 × 该档位概率`；不同长度的标尺要先
`score / (档位数-1)` 归一化才能互相加权（`normalizeScore`，组合工具里自动做）。

## 只有一个后端：TypeSafe 官方

- 调用形态：`POST {baseUrl}/v1/systemone`，一次请求答全部问题（上游：加问题几乎不增耗时）；
- 概率含义：**标定过**（calibration 是训练目标），所以输出恒为 `calibrated=true`；
- 配置：`TYPESAFE_API_KEY` 必配；`TYPESAFE_BASE_URL` / `TYPESAFE_MODEL` 可选；
- 失败语义：没配 key、401/403、429、网络错误、上游结构异常 → 工具**直接报错**，
  并把原因和下一步提示原样给模型；没有重试、没有降级、没有本地兜底。

> 没配 key 时插件仍会挂载，启动日志打一条警告；`sysone_ask` 第一次被调用时报
> 「TYPESAFE_API_KEY 是空的……本插件没有本地兜底」。这是刻意的：未标定概率不冒充 Jev。

## 工具

### `sysone_ask`

```
state:     要判断的内容（文本；多个部分就传 JSON 字符串，后端会按对象发出去）
questions: [{id, type, instructions, criteria}]   // 一次给全，别一个一个问
```

输出里每题一行：`choice/score/noul` + `confidence` + `probabilities` + `calibrated`，
外加 `backend` / `model` / `elapsed_ms` / `calls`（官方后端恒为 1）与结构化 `answers`。

### `sysone_compose`

```
mode=composite  // 加权总分：score 自动归一化，noul 直接用；输出 0~1 与逐项贡献
mode=route      // 置信度门控：恰好一个 choice 答案 → act / review / escalate
```

`route` 的三个出口（阈值默认 `min_confidence=0.4` / `act_at=0.7` / `notify_at=0.25`）：

- `escalate`：置信度低于门槛 —— **别硬选**，交人或强推理模型；
- `review`：能用但不放心 —— 让人过一眼；
- `act`：直接用，并把概率也不低的其它分支列进 `alsoNotify`。

`composite` 只接受 `score` / `noul`：`choice` 是无序选项，先 `route` 决定走哪条路，
再对那条路里的有序维度加权 —— 这正是上游说的「拆开、用代码组合」。

## 验证

| 验证 | 结果 |
| --- | --- |
| 纯逻辑（校验、归一化、组合、路由） | ✅ 真值表断言全通过；`composite=0.664 → review` 与上游文档手算一致 |
| TypeSafe 请求契约（本地 stub） | ✅ 请求体与文档逐字一致（`state`/`model`/`questions`，choice 用映射、score 用数组、noul 无 criteria）、`Bearer` 头正确、答案解析正确、`calibrated=true` |
| 无 key 行为（真实调用） | ✅ 工具直接报错并提示配置哪个环境变量；不发起任何本地模型调用 |
| 官方失败行为 | ✅ 401/429/网络/HTTP 错误原样报给模型；不降级 |
| 工具表 | ✅ `node app/cli/main.ts --list-tools` 出现两个工具；CLI 与桌面端共用同一装配 |

## 目录

```
primitives.ts         问题类型、校验、加权组合、置信度路由（纯函数，无 IO）
typesafe.ts           官方 API 客户端（契约见文件头注释）
index.ts              插件本体：注册两个工具
```

## 与上游的差距（诚实清单）

- 没有 `model jaggedness`、`speculative fan-out` 的自动展开；投机问题要调用方自己加。
- 没有做 hierarchical classification / beam search 这类 cookbook 级模式，只有最基础的两个组合。
- 官方后端的 SDK 没接（用 HTTP；Python/JS SDK 都是薄封装）。
- 没有重试/退避策略：官方失败就是失败，由调用方决定重试还是换路径。
