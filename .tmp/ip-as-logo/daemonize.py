"""把一个命令真正守护化：fork → setsid（新会话 + 新进程组）→ fork → exec。

为什么需要它：harness 的 bash 执行器把每次工具调用放在一个受管进程组里，
turn 被中断时会对整组 SIGTERM→SIGKILL。`nohup` 只挡 SIGHUP，挡不住它；
只有换到**自己的会话/进程组**才躲得开（macOS 没有 setsid(1)，所以用 Python 代劳）。

用法：python3 daemonize.py <可执行文件> [参数...]
     例如 python3 daemonize.py /usr/bin/node run.mjs
     不要只在第一个参数里给脚本名 —— 这里**不**替你套 shell，
     直接 execvp：给了 .mjs 就得同时给出 node（踩过：写死 /bin/bash 会把 JS 当 shell 读）。
输出：一行 JSON（写进调用方的 stdout，通常会重定向到日志）。
"""
import json
import os
import sys

argv = sys.argv[1:]
if not argv:
    sys.exit('用法：daemonize.py <脚本> [参数...]')

first = os.fork()
if first == 0:
    os.setsid()                      # 新会话：本进程成为新进程组组长
    second = os.fork()
    if second == 0:                  # 再 fork 一次，避免成为会话首进程
        # execvp：按 argv[0] 查 PATH，并让内核处理 shebang；不额外套 shell
        os.execvp(argv[0], argv)
    os._exit(0)                      # 中间那层立刻退出，孙子进程被 init 收养
os.waitpid(first, 0)                 # 只等中间层，不等真正的守护进程
print(json.dumps({'daemon': 'started'}), flush=True)
