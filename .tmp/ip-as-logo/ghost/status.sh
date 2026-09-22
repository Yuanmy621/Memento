#!/bin/bash
# 看生成进度：先看进程是否还在，再打 run.log 尾部与 run-log 摘要。
# 刻意不依赖 harness 的 job 表 —— 那张表会随 turn 中断一起被回收。
set -u
here="$(cd "$(dirname "$0")" && pwd)"
pid="$(pgrep -f "${here}/run.mjs" | head -1 || true)"
echo "进程：${pid:-（没有在跑）}"
echo "--- run.log 尾部 ---"
tail -6 "${here}/run.log" 2>/dev/null || echo "(还没有日志)"
echo "--- 进度 ---"
node "${here}/run.mjs" --status
