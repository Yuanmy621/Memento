# 参与贡献

欢迎提交 Issue 与 Pull Request。特别欢迎以下两类贡献：

1. **`references/butian-rules.md` 的规则更新**——补天平台规则会不定期调整，
   发现官方规则（收录范围、奖励分档、忽略清单、提交模板）变化时，
   提 PR 更新对应小节并附官方页面链接与日期；
2. **`references/vuln-playbook.md` 的验证手法**——新的漏洞类型验证流程、
   误报特征、最小影响技巧。

## 提交约定

- 一个 PR 只做一件事，说明改动动机；
- 文档使用中文，语气专业克制（对齐现有文风）；
- 不提交任何真实目标的数据、报文、截图——示例一律使用自带靶场或虚构数据；
- 改动 `scripts/recon.py` 时保持三条合规设计：TLS 校验强制、敏感路径仅 HEAD、
  授权门禁（`--authorized`），不要提交绕过这些约束的代码。

## 本地验证

```bash
python -m py_compile scripts/recon.py assets/lab/app.py   # 语法
python assets/lab/app.py                                   # 起靶场 http://127.0.0.1:8899
```
