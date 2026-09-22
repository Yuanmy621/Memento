#!/bin/bash
# 守护化启动生成器：脱离 harness 的受管进程组，turn 被打断也不会被带走。
#
# 用法：./start.sh [run.mjs 的额外参数...]
#   ./start.sh                 # 续跑没拿到的
#   ./start.sh --only C2       # 只重画 C2
# 然后用 ./status.sh 看进度 —— **不要**用 job_output 阻塞等（那会连后台任务一起被回收）。
#
# ⚠️ 变量一律写成 ${var} 形式：中文文本紧跟 $var 时，bash 会把全角字符并进变量名
#    （`"$log）"` 会被当成变量 `log）`，set -u 下直接报 unbound variable —— 踩过）。
set -u
here="$(cd "$(dirname "$0")" && pwd)"
log="${here}/run.log"
: > "${log}"
# 守护进程会继承这里的 stdout/stderr，所以重定向到 run.log（daemonize.py 的 JSON 也在里面）
python3 "${here}/daemonize.py" node "${here}/run.mjs" "$@" > "${log}" 2>&1
sleep 1
pid="$(pgrep -f "${here}/run.mjs" | head -1 || true)"
echo "已守护化启动（日志 ${log}）"
if [ -n "${pid}" ]; then
  echo "pid=${pid} pgid=$(ps -o pgid= -p "${pid}" | tr -d ' ')   本工具调用的 pgid=$(ps -o pgid= -p $$ | tr -d ' ')"
else
  echo "进程已结束（多半是全部就绪，见日志末尾）"
fi
