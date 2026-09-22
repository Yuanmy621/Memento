#!/bin/bash
# 启动一个「可见的」（非无头）Chrome，开启 CDP 调试端口 9222，并打开五子棋页面。
# 通过 launchd(open -na) 启动，进程不挂在调用它的 shell 上，Abort/退出终端都不会杀掉它。
set -e
PROFILE="/Users/yuanmingyuan/YuanMy/.tmp/jev-pk/chrome-profile"
URL="${1:-http://localhost:5173/}"

if curl -s -o /dev/null --max-time 1 http://127.0.0.1:9222/json/version; then
  echo "CDP 9222 已在运行，直接复用。"
else
  open -na "Google Chrome" --args \
    --remote-debugging-port=9222 \
    --remote-allow-origins='*' \
    --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check --disable-features=Translate \
    --window-size=1440,960 --window-position=40,40 \
    "$URL"
  for i in $(seq 1 30); do
    if curl -s -o /dev/null --max-time 1 http://127.0.0.1:9222/json/version; then break; fi
    sleep 0.5
  done
fi

echo "--- CDP ---"
curl -s http://127.0.0.1:9222/json/version | head -3
echo "--- targets ---"
curl -s http://127.0.0.1:9222/json/list | python3 -c "import json,sys
for t in json.load(sys.stdin):
    if t['type']=='page': print(t['title'],'|',t['url'])"
