#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""证据固定：把一次 HTTP 请求/响应对落成可提交的证据包（src-hunter Phase 5 的前置）。

为什么必须工具化：漏洞盒子《关于规范 AI 辅助漏洞报告提交标准》（帮助中心 150）明确
要求「可验证的 POC 或关键请求包」+「关键步骤截图及验证结果截图」，纯描述会被判无效；
而报告里**绝不能**出现自己的会话凭据。手工复制粘贴必然出错，所以固定成脚本。

产出（每个 case 一个目录）：

    .tmp/src-hunter/evidence/<case>/request.http    原始请求（凭据已打码）
    .tmp/src-hunter/evidence/<case>/response.http   状态行 + 响应头 + 响应体
    .tmp/src-hunter/evidence/<case>/manifest.json   时间、耗时、sha256、命令、脱敏说明

用法：

    # 最常用：带 Cookie 打一次（Cookie 会自动从 ~/.YuanMy/vulbox-cookie.txt 取并打码）
    python3 evidence.py --case idor-order --url 'https://vapi.vulbox.com/web/...' --cookie-file

    # 手工给 header / body
    python3 evidence.py --case x --url 'https://target/api' -H 'X-Foo: bar' --data '{"a":1}'

    # 完全离线（把已有的包存成证据包，不再发请求）
    python3 evidence.py --case x --from-file /tmp/captured.http

⚠️ 默认**打码**：`Cookie` / `Authorization` / `token` / `set-cookie` 的值只留前 6 位 + 长度。
   要留原文（仅本机排查用）加 `--keep-secrets`，但那份**不要**贴进报告。
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.parse

# 需要打码的头（大小写不敏感）与参数名
SECRET_HEADERS = ('cookie', 'set-cookie', 'set-cookie2', 'authorization', 'x-csrf-token', 'x-xsrf-token',
                  'proxy-authorization')
SECRET_FIELDS = ('token', 'password', 'passwd', 'secret', 'session', 'jwt', 'access_token', 'vulbox_token')


def redact_secret(value: str) -> str:
    """保留前 6 位便于对照，其余打码 —— 报告里要能看出「这是同一个凭据」，但不能被复用。"""
    text = value.strip()
    if len(text) <= 6:
        return '***'
    return f'{text[:6]}…（共 {len(text)} 字符，已打码）'


def redact_headers(raw: str) -> str:
    """按行打码请求/响应头。"""
    lines = []
    for line in raw.splitlines():
        matched = re.match(r'^([A-Za-z0-9-]+)\s*:\s*(.*)$', line)
        if matched and matched.group(1).lower() in SECRET_HEADERS:
            value = matched.group(2)
            # Cookie 里可能有好几个键，逐个打码但保留键名
            if matched.group(1).lower() == 'cookie' and '=' in value:
                parts = []
                for item in value.split(';'):
                    item = item.strip()
                    if '=' in item:
                        key, _, val = item.partition('=')
                        parts.append(f'{key}={redact_secret(val)}' if key.lower() in SECRET_FIELDS or True else item)
                    else:
                        parts.append(item)
                lines.append(f'{matched.group(1)}: ' + '; '.join(parts))
            else:
                lines.append(f'{matched.group(1)}: {redact_secret(value)}')
            continue
        lines.append(line)
    return '\n'.join(lines)


def redact_body(body: str) -> str:
    """把 JSON / 表单里明显的凭据值打码（保持结构可读）。"""
    def repl(matched: re.Match[str]) -> str:
        key, sep, value = matched.group(1), matched.group(2), matched.group(3)
        quote = '"' if value.startswith('"') else ''
        inner = value.strip('"')
        return f'{key}{sep}{quote}{redact_secret(inner)}{quote}'

    pattern = r'("?(?:' + '|'.join(SECRET_FIELDS) + r')"?\s*[:=]\s*)("?[^",}&\s]{4,}"?)'
    return re.sub(pattern, repl, body, flags=re.I)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8', 'replace')).hexdigest()


def run_curl(url: str, method: str, headers: list[str], data: str | None, timeout: int) -> tuple[str, str, float]:
    """用 curl 发一次请求，返回（请求原文、响应原文、耗时秒）。"""
    header_lines = [f'{h.split(":", 1)[0].strip()}: {h.split(":", 1)[1].strip()}' for h in headers if ':' in h]
    request = '\n'.join([
        f'{method} {url} HTTP/1.1',
        f'Host: {urllib.parse.urlparse(url).netloc}',
        *header_lines,
        '',
        data or '',
    ])
    args = ['curl', '-s', '-i', '-X', method, '--max-time', str(timeout),
            '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) YuanMy-agent/0.1']
    for line in header_lines:
        args += ['-H', line]
    if data:
        args += ['--data-binary', data]
    args.append(url)
    started = time.time()
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout + 10)
    elapsed = time.time() - started
    return request, result.stdout, elapsed


def main() -> int:
    parser = argparse.ArgumentParser(description='把一次 HTTP 交互固定成可提交的证据包')
    parser.add_argument('--case', required=True, help='证据包名字（如 idor-order-1234）')
    parser.add_argument('--url', help='请求 URL')
    parser.add_argument('--method', default='GET', help='HTTP 方法（默认 GET）')
    parser.add_argument('-H', '--header', action='append', default=[], help='请求头，可多次')
    parser.add_argument('--data', help='请求体')
    parser.add_argument('--cookie-file', action='store_true',
                        help='把 ~/.YuanMy/vulbox-cookie.txt 作为 Cookie 头发出去（会自动打码）')
    parser.add_argument('--from-file', help='不发请求：把一份已有的原始 HTTP 文本存成证据包')
    parser.add_argument('--note', default='', help='这一步在做什么（写进 manifest，报告里要引用）')
    parser.add_argument('--keep-secrets', action='store_true', help='不打码（仅本机排查，别贴报告）')
    parser.add_argument('--timeout', type=int, default=30)
    parser.add_argument('--out', default='.tmp/src-hunter/evidence')
    args = parser.parse_args()

    out = pathlib.Path(args.out) / args.case
    out.mkdir(parents=True, exist_ok=True)

    if args.from_file:
        raw = pathlib.Path(args.from_file).read_text(encoding='utf-8', errors='replace')
        split = re.split(r'\r?\n\r?\n', raw, maxsplit=1)
        request = split[0]
        response = split[1] if len(split) > 1 else ''
        elapsed = None
    else:
        if not args.url:
            parser.error('要么给 --url，要么用 --from-file')
        headers = list(args.header)
        if args.cookie_file:
            path = pathlib.Path.home() / '.YuanMy' / 'vulbox-cookie.txt'
            if not path.exists():
                print(f'找不到凭据文件 {path}', file=sys.stderr)
                return 1
            headers.append(f'Cookie: {path.read_text(encoding="utf-8").strip()}')
        request, response, elapsed = run_curl(args.url, args.method.upper(), headers, args.data, args.timeout)

    safe_request = request if args.keep_secrets else redact_headers(request)
    safe_response = response if args.keep_secrets else redact_headers(redact_body(response))

    (out / 'request.http').write_text(safe_request + '\n', encoding='utf-8')
    (out / 'response.http').write_text(safe_response + '\n', encoding='utf-8')
    status = (response.splitlines()[0] if response.splitlines() else '(无响应)')
    manifest = {
        'case': args.case,
        'time': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
        'note': args.note,
        'request_line': request.splitlines()[0] if request.splitlines() else '',
        'status': status,
        'elapsed_seconds': None if elapsed is None else round(elapsed, 3),
        'response_bytes': len(response.encode('utf-8', 'replace')),
        'sha256': {'request': sha256(safe_request), 'response': sha256(safe_response)},
        'redacted': not args.keep_secrets,
        'platform_requirement': '漏洞盒子帮助中心 150：AI 辅助报告必须附可验证的 POC / 关键请求包',
    }
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'证据包：{out}/  （{status}，{manifest["response_bytes"]} 字节'
          + ('，已打码' if manifest['redacted'] else '，⚠️ 未打码') + '）')
    if not args.keep_secrets:
        print('提醒：request.http / response.http 里的凭据已打码，可直接贴进报告。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
