# `.agents/` —— 仓库级 agent 配置

这个目录放**给 agent 看的东西**，与 `src` / `app` 里的产品代码分开：产品代码是给用户跑的，
这里是给 agent（以及维护者）读的约定。

```
.agents/
  README.md          本文件：目录约定与技能格式
  skills/            技能存放地（本仓库的主体）
    <技能名>/
      SKILL.md       必需：YAML frontmatter(name/description) + 正文
      references/    可选：长参考资料，按需读取（可带路由表）
      templates/     可选：可复制到别处的模板
      scripts/       可选：技能自带的脚本
      LICENSE        可选：vendored 第三方技能必须带上游许可证
    <技能名>.md      也支持「单文件技能」，直接放在 skills/ 顶层
```

现有技能：

| 技能 | 来源 | 说明 |
| --- | --- | --- |
| `yuanmy-desktop-ui` | 自研 | 改桌面端界面的固定套路 |
| `src-hunter` | **vendored**（[MyuriKanao/src-hunter-skill](https://github.com/MyuriKanao/src-hunter-skill)，MIT） | SRC / 众测漏洞挖掘工作流：5 阶段 + 19 个 playbook + 指纹库 |

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

## 验证技能确实被发现了

```bash
node app/cli/main.ts --list-tools | grep '^skill'     # 工具存在
node app/cli/main.ts -p "回答两个字：收到"             # 跑一轮
# 然后看会话日志里投递的技能目录（首个请求前会 splice 进 agent inbox）：
grep -l 'yuanmy-desktop-ui' .YuanMy/sessions/*/*/session.v3.jsonl | tail -1
```

技能名出现在会话日志里 = 发现 + 目录投递都正常。
