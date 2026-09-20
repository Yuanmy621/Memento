# `.agents/` —— 仓库级 agent 配置

这个目录放**给 agent 看的东西**，与 `src` / `app` 里的产品代码分开：产品代码是给用户跑的，
这里是给 agent（以及维护者）读的约定。

```
.agents/
  README.md          本文件：目录约定、技能格式、技能与命令怎么分
  skills/            **全局长期技能**：进模型的会话目录，模型可自行按需加载
    <技能名>/
      SKILL.md       必需：YAML frontmatter(name/description) + 正文
      references/    可选：长参考资料，按需读取（可带路由表）
      templates/     可选：可复制到别处的模板
      scripts/       可选：技能自带的脚本
      LICENSE        可选：vendored 第三方技能必须带上游许可证
    <技能名>.md      也支持「单文件技能」，直接放在 skills/ 顶层
  commands/          **命令**：用户敲 `/名字` 触发，指令只在那一个回合注入
    <名字>.md        frontmatter(description/args/include) + 指令正文
    <名字>/          可选：该命令自带的资产（模板、脚本、参考文件）
```

## 技能 vs 命令：两类东西，别混

判据只有一条：**谁触发它**。触发方式决定了上下文成本，也决定了该放哪。

| | 全局长期技能 | 命令 |
| --- | --- | --- |
| 放哪 | `skills/<名字>/SKILL.md` | `commands/<名字>.md` |
| 谁触发 | **模型**（看到目录描述后自己决定加载） | **用户**（敲 `/名字`） |
| 上下文成本 | 目录常驻：`description` 一直在会话里 | **零**：只有敲了才把正文注入那一回合 |
| 适合什么 | 能力包：怎么挖洞、怎么改这个仓库、某个平台怎么用 | 一次性流程：写报告、发版、整理素材、固定格式的排查 |
| 写法 | 正文写「什么时候用 + 怎么做」 | 正文写「这一回合要 agent 做什么」，可 `include` 内联别的文件 |

**两种之间可以转换**，而且不用搬家 —— 技能 frontmatter 里那两行就是开关：

```yaml
disable-model-invocation: true   # 不进模型目录 → 变成「命令专用技能」（长期成本归零）
user-invocable: true             # 仍然允许人工入口（默认就是 true）
```

> 这是内核 `SkillInvocationPolicy` 的原生能力，不是本仓库自己造的约定。
> 反向转换：删掉 `disable-model-invocation` 那行，它就回到「全局长期」。

桌面端的**设置界面**（左下角「设置」）把这件事可视化了：技能列表上会标
`全局` / `命令专用`，点开就能改 frontmatter 保存。

现有技能：

| 技能 | 来源 | 调用方式 | 说明 |
| --- | --- | --- | --- |
| `yuanmy-desktop-ui` | 自研 | 全局 | 改桌面端界面的固定套路 |
| `yuanmy-mcp` | 自研 | 全局 | 往 YuanMy 上接 MCP 服务器的固定套路 |
| `report` | **vendored**（[v-yun/vuln-report-skill](https://github.com/v-yun/vuln-report-skill)，MIT） | **命令专用**（`/report`） | 已确认漏洞 → 可提交的 DOCX 报告：分层验证门 + 固定版式 + Step 式 PoC + 截图铁律 |
| `src-hunter` | **vendored**（[MyuriKanao/src-hunter-skill](https://github.com/MyuriKanao/src-hunter-skill)，MIT） | 全局 | SRC / 众测漏洞挖掘工作流：5 阶段 + 19 个 playbook + 指纹库 |

现有命令：

| 命令 | 说明 |
| --- | --- |
| `/report` | 内联 `report` 技能正文（约 27KB）+ 执行顺序与配套资产清单，仅本回合生效 |

`report` 是「命令专用技能」的范例：正文大、只在成稿时用，所以不让它常驻目录；
`commands/report.md` 是它的入口（写法见下）。

### vendored 第三方技能的规矩

1. **保留许可证**：上游是 MIT 就必须把 `LICENSE` 一起带上（含版权行），并在 SKILL.md 顶部写明来源与「本仓库做了哪些改写」。
2. **只落地「能力内核」**：`src-hunter` 上游共 50MB，其中 46MB 是 H1 案例原始数据、3MB 是 payloader —— 那些只在「引用具体案例」时才需要，不进应用仓库。选择标准是**自包含性**：playbook 把 payload 内联在文件里，所以砍掉 payloader 不影响可用。
3. **改写而不是照抄**：上游假设的环境（MCP 工具、Claude Code 的 frontmatter 键、案例库路径）在本 harness 里并不成立，照抄会让模型去 Read 不存在的文件。`src-hunter` 里做了三处必要改写，见其 SKILL.md 的〈收录范围〉。
4. **描述必须与内容一致**：上游 description 宣传「305 payload / 2887 案例 / 88,636 WooYun 统计」，这些数据没落地就不能留着 —— 否则模型会按描述去找不存在的东西。

`.claude/skills` 是指向 `.agents/skills` 的**符号链接**（与 DSH 仓库同样的做法），
这样 Claude Code 之类的工具也能发现同一批技能，不用维护两份。

---

## 技能格式

`SKILL.md` 以 YAML frontmatter 开头，`name` 与 `description` **必填**：

```markdown
---
name: yuanmy-desktop-ui
description: 在这个仓库里改完代码怎么验证 —— 从便宜的静态检查到真窗口 E2E 的顺序、
             什么算「验证过了」、以及三个踩过的坑。当你说「验证一下 / 跑测试 / 确认没坏」时用。
---

# 正文……

正文是把「怎么做」写成可执行步骤，不是背景介绍。
```

可选字段（由 `@deepseek-ai/dsh-skill-filesystem` 解析）：

| 字段 | 作用 |
| --- | --- |
| `whenToUse` | 补充触发时机，帮助路由 |
| `metadata` | 自由键值，仅供人看 |
| `disable-model-invocation` | `true` 时**不进**模型目录（只能人工 `/name` 调用） |
| `user-invocable` | `false` 时不出现在人工命令里 |

⚠️ `skills/` 顶层任何 `.md` 都会被当成**单文件技能**。所以说明性文档不要放在这里
（本文件才放在 `.agents/` 而不是 `.agents/skills/`），否则会被当作缺 frontmatter 的技能而报warning。

---

## 技能是怎么被发现的

`app/cli/kernel.ts` 挂了 DSH 的三个技能插件：

| 插件 | 作用 |
| --- | --- |
| `@deepseek-ai/dsh-skill` | 技能注册表（`ctx.skills`），本身不含内容 |
| `@deepseek-ai/dsh-skill-filesystem` | 从磁盘发现 `SKILL.md` 的 provider |
| `@deepseek-ai/dsh-tool-skill` | 面向模型的入口：首个请求前投递「可用技能目录」+ 注册 `skill` 工具 |

扫描的根目录（本项目显式指定，见 `skillDirs()`）：

1. `<cwd>/.agents/skills` —— **本目录，主用**
2. `<cwd>/.dsh/skills` —— DSH 约定的项目级目录（优先级更高，保留兼容）
3. `$YuanMy_SKILL_DIRS`（冒号分隔）追加的目录 —— 放个人 / 团队共享技能

> 这里**没有**开启 DSH 的默认根（`~/.dsh/skills`、`~/.agents/skills`）。
> 那些是 DSH CLI 的全局技能库（几十个飞书 / 记忆类技能），对编码 agent 是噪声，
> 还会把会话目录撑大。想要 DSH 那套默认行为，把 `kernel.ts` 里
> `includeDefaultRoots` 改成 `true`、去掉 `customSkillDirs` 即可。

技能按 **`<cwd>`** 定位，所以 `--cwd`（或桌面端「更换工作目录」）会连带切换技能集。
目录变化会被监听，新增 / 改名 / 删除技能在下一次请求就能用，不需要重启。

## 命令怎么写

`commands/<名字>.md`，frontmatter 只有三个可选字段：

```markdown
---
description: 一句话说明（`/help`、`/commands`、设置界面里显示）
args: '[厂商] [标题]'          # 纯提示，不参与解析
include:                       # 可选：把哪些文件内联进这一回合
  - ../skills/report/SKILL.md
---
用户触发了 /report。请按下面内联的方法论执行……
```

- **`include` 的路径相对命令文件所在目录**，上例指到 `skills/report/SKILL.md`；
  内联时会**剥掉 frontmatter**（那是给 provider 看的，给模型白占 token）。
- 命令自带的资产（模板、脚本、参考图）放进同名子目录 `commands/<名字>/`，
  扫命令时不会把子目录里的东西当成命令。
- 展开后的消息结构固定为三段：**命令正文 → 内联文件 → 本次输入**。
  顺序有意为之：规则在前，素材居中，用户这次的具体要求放最后（离生成最近）。
- 名字冲突时**项目目录优先**（`.agents/commands` > `.dsh/commands` > `$YuanMy_COMMAND_DIRS`）。

在哪敲：

| 入口 | 用法 |
| --- | --- |
| CLI REPL | `/help` 看全部、`/commands` 只看用户命令、`/名字 参数` 执行 |
| 桌面端 | 输入框里直接打 `/名字 参数` 回车（host 侧展开，界面照原样显示你输入的内容） |
| 设置界面 | 左下角「设置」→ 命令标签：看列表、改正文、看它内联了哪些文件 |

⚠️ 命令表在**内核启动时读一次**（CLI 每次进 REPL、桌面端每次启动/重启内核）。
改完命令文件要重开 REPL，或在设置界面点「重启内核」。

## 验证技能确实被发现了

**最快的办法：桌面端左下角「设置」** —— 技能列表直接标出每个技能的调用方式
（`全局` / `命令专用`），frontmatter 写坏的那种会带 ⚠ 并说明原因。
比下面翻会话日志快得多。


```bash
node app/cli/main.ts --list-tools | grep '^skill'     # 工具存在
node app/cli/main.ts -p "回答两个字：收到"             # 跑一轮
# 然后看会话日志里投递的技能目录（首个请求前会 splice 进 agent inbox）：
grep -l 'yuanmy-desktop-ui' .YuanMy/sessions/*/*/session.v3.jsonl | tail -1
```

技能名出现在会话日志里 = 发现 + 目录投递都正常。
