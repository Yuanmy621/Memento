#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""被动侦察（src-hunter Phase 2）：只读公开数据源，**不向目标发任何包**。

为什么单独写一个脚本而不是让模型现编 curl：Phase 2 的产出要可复核 ——
同一个域名列表跑两次应该得到同样的清单，所以查询口径（URL、分页、去重规则）
必须固定下来，写进文件比写在提示词里可靠。

数据源（≥3 种，全部是第三方公开数据，不打目标）：
  1. CT 日志          crt.sh           —— 证书里出现过的域名（含子域、通配符）
  2. 历史快照         Wayback CDX      —— 曾经的 URL（能翻出已下线的老路径/接口）
  3. DNS 记录         dig              —— A/AAAA/CNAME/MX/TXT/NS（含 SPF 里的第三方）
  4. HackerTarget     hostsearch       —— 免费额度，扫过的子域记录

用法：
    python3 recon-passive.py example.com [另一个域名 ...]
    python3 recon-passive.py --file scope-domains.txt        # 一行一个域名
    python3 recon-passive.py --out .tmp/src-hunter/recon example.com

产出：`<out>/<domain>.json`（原始数据）+ `<out>/inventory.md`（给人看的资产清单）。

⚠️ 合规：本脚本只查 CT/快照/DNS 这类公开数据。平台规则明确禁止大流量/大规模扫描，
   所以**主动探测（Phase 3）另走一套**：低速率、只打 in-scope 清单里的资产。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 YuanMy-recon/0.1'
TIMEOUT = 30


def fetch(url: str, retries: int = 2) -> str:
    """取一个 URL 的文本；失败重试（这些公开源偶尔 502）。"""
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return response.read().decode('utf-8', 'replace')
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last = error
            time.sleep(2 + attempt * 3)
    raise RuntimeError(f'{url} 取不到：{last}')


# ── 数据源 ──────────────────────────────────────────────────────────────────

def ct_logs(domain: str) -> list[str]:
    """CT 日志里的域名（crt.sh 的 JSON 接口）。"""
    url = f'https://crt.sh/?q=%25.{urllib.parse.quote(domain)}&output=json'
    try:
        rows = json.loads(fetch(url))
    except Exception as error:
        return [f'（crt.sh 失败：{error}）']
    names: set[str] = set()
    for row in rows if isinstance(rows, list) else []:
        for field in ('common_name', 'name_value'):
            value = str(row.get(field, ''))
            for line in value.split('\n'):
                line = line.strip().lower().lstrip('*.')
                # 只认「就是它」或「是它的子域」—— crt.sh 的 %.example.com 会带出
                # testexample.com 这类同名尾巴，宽松的 endswith 会把它算进来
                if (line == domain or line.endswith('.' + domain)) and re.fullmatch(r'[a-z0-9._-]+', line):
                    names.add(line)
    return sorted(names)


def wayback(domain: str, limit: int = 2000) -> dict[str, object]:
    """Wayback 历史 URL（CDX）。返回条数 + 去重后的路径样本。"""
    url = ('http://web.archive.org/cdx/search/cdx?url=*.' + urllib.parse.quote(domain)
           + f'&output=json&collapse=urlkey&fl=original,statuscode,mimetype&limit={limit}')
    try:
        rows = json.loads(fetch(url))
    except Exception as error:
        return {'error': str(error)}
    if not isinstance(rows, list) or len(rows) <= 1:
        return {'count': 0, 'paths': [], 'params': []}
    header, *body = rows
    index = {name: i for i, name in enumerate(header)}
    paths: set[str] = set()
    params: set[str] = set()
    for row in body:
        original = str(row[index.get('original', 0)])
        parsed = urllib.parse.urlparse(original)
        path = parsed.path or '/'
        # 参数名比参数值有用：翻历史接口时先看有哪些参数
        for key in urllib.parse.parse_qs(parsed.query):
            params.add(key)
        if re.search(r'\.(png|jpe?g|gif|css|woff2?|svg|ico|js|map)$', path, re.I):
            continue
        paths.add(path)
    return {
        'count': len(body),
        'paths': sorted(paths)[:400],
        'params': sorted(params)[:200],
    }


def common_crawl(domain: str, limit: int = 1000) -> dict[str, object]:
    """Common Crawl 的索引（Internet Archive 整站 503 时的替代历史来源）。"""
    try:
        collections = json.loads(fetch('https://index.commoncrawl.org/collinfo.json'))
        newest = str(collections[0]['id'])
    except Exception as error:
        return {'error': f'拿索引列表失败：{error}'}
    url = (f'https://index.commoncrawl.org/{newest}-index?url=*.{urllib.parse.quote(domain)}'
           f'&output=json&limit={limit}')
    try:
        text = fetch(url)
    except Exception as error:
        return {'error': str(error)}
    paths: set[str] = set()
    params: set[str] = set()
    count = 0
    for line in text.splitlines():
        line = line.strip()
        if line == '' or not line.startswith('{'):
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        count += 1
        parsed = urllib.parse.urlparse(str(row.get('url', '')))
        path = parsed.path or '/'
        for key in urllib.parse.parse_qs(parsed.query):
            params.add(key)
        if not re.search(r'\.(png|jpe?g|gif|css|woff2?|svg|ico|js|map)$', path, re.I):
            paths.add(path)
    return {'index': newest, 'count': count, 'paths': sorted(paths)[:400], 'params': sorted(params)[:200]}


def dns(domain: str) -> dict[str, list[str]]:
    """DNS 记录（dig 是本机命令；没有就跳过）。"""
    out: dict[str, list[str]] = {}
    for record in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'):
        try:
            result = subprocess.run(['dig', '+short', domain, record], capture_output=True, text=True, timeout=20)
            values = [line.strip().strip('"') for line in result.stdout.splitlines() if line.strip() != '']
            if values:
                out[record] = values
        except Exception:
            continue
    return out


def hackertarget(domain: str) -> list[str]:
    """HackerTarget 的免费子域接口（有限额，失败就当没有）。"""
    try:
        text = fetch(f'https://api.hackertarget.com/hostsearch/?q={urllib.parse.quote(domain)}')
    except Exception:
        return []
    if 'API count exceeded' in text or 'error' in text.lower()[:40]:
        return []
    hosts = set()
    for line in text.splitlines():
        host = line.split(',')[0].strip().lower()
        if host.endswith(domain):
            hosts.add(host)
    return sorted(hosts)


# ── 汇总 ────────────────────────────────────────────────────────────────────

def recon(domain: str) -> dict[str, object]:
    print(f'  → CT 日志 …', flush=True)
    ct = ct_logs(domain)
    print(f'     {len(ct)} 个域名', flush=True)
    print(f'  → Wayback …', flush=True)
    wb = wayback(domain)
    print(f'     {wb.get("count", "?")} 条历史 URL', flush=True)
    print(f'  → Common Crawl …', flush=True)
    cc = common_crawl(domain)
    print(f'     {cc.get("count", cc.get("error", "?"))}', flush=True)
    print(f'  → DNS …', flush=True)
    records = dns(domain)
    print(f'     {", ".join(records.keys()) or "无"}', flush=True)
    print(f'  → HackerTarget …', flush=True)
    ht = hackertarget(domain)
    print(f'     {len(ht)} 个子域', flush=True)
    return {'domain': domain, 'ct': ct, 'wayback': wb, 'common_crawl': cc,
            'dns': records, 'hackertarget': ht}


def subdomains_of(result: dict[str, object]) -> list[str]:
    """把各来源的子域合并去重。"""
    names: set[str] = set()
    for value in result.get('ct', []):
        if isinstance(value, str) and not value.startswith('（'):
            names.add(value)
    for value in result.get('hackertarget', []):
        if isinstance(value, str):
            names.add(value)
    return sorted(names)


def main() -> int:
    parser = argparse.ArgumentParser(description='被动侦察：CT 日志 + Wayback + DNS + HackerTarget')
    parser.add_argument('domains', nargs='*', help='要侦察的域名（in-scope 的根域）')
    parser.add_argument('--file', help='从文件读域名（一行一个，# 开头是注释）')
    parser.add_argument('--out', default='.tmp/src-hunter/recon', help='输出目录')
    args = parser.parse_args()

    domains = list(args.domains)
    if args.file:
        text = pathlib.Path(args.file).read_text(encoding='utf-8')
        domains += [line.strip() for line in text.splitlines()
                    if line.strip() != '' and not line.strip().startswith('#')]
    domains = sorted({d.strip().lower().removeprefix('http://').removeprefix('https://').strip('/')
                      for d in domains if d.strip() != ''})
    if not domains:
        parser.error('至少要给一个域名（或用 --file）')

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for domain in domains:
        print(f'[{domain}]', flush=True)
        result = recon(domain)
        (out / f'{domain}.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
        results.append(result)

    lines = ['# 被动侦察资产清单', '']
    for result in results:
        domain = str(result['domain'])
        subs = subdomains_of(result)
        dns_records = result.get('dns', {})
        wayback_data = result.get('wayback', {})
        cc_data = result.get('common_crawl', {})
        lines += [
            f'## {domain}', '',
            f'- 子域：{len(subs)} 个（{", ".join(subs[:40])}{"…" if len(subs) > 40 else ""}）'
            if subs else '- 子域：没有第三方来源',
            f'- DNS：{"; ".join(f"{k}={",".join(v)}" for k, v in dns_records.items()) or "无记录"}'
            if isinstance(dns_records, dict) else '- DNS：n/a',
            f'- 历史 URL（Wayback）：{wayback_data.get("count", "?")} 条，'
            f'可读路径 {len(wayback_data.get("paths", []))} 个，参数名 {len(wayback_data.get("params", []))} 个'
            if isinstance(wayback_data, dict) and 'error' not in wayback_data
            else f'- 历史 URL（Wayback）：不可用（{wayback_data.get("error", "?") if isinstance(wayback_data, dict) else "?"}）',
            f'- 历史 URL（Common Crawl {cc_data.get("index", "?")}）：{cc_data.get("count", "?")} 条，'
            f'可读路径 {len(cc_data.get("paths", []))} 个，参数名 {len(cc_data.get("params", []))} 个'
            if isinstance(cc_data, dict) and 'error' not in cc_data
            else f'- 历史 URL（Common Crawl）：不可用（{cc_data.get("error", "?") if isinstance(cc_data, dict) else "?"}）',
            '',
        ]
        merged_params: list[str] = []
        for source in (wayback_data, cc_data):
            if isinstance(source, dict):
                for name in source.get('params', []):
                    if name not in merged_params:
                        merged_params.append(str(name))
        if merged_params:
            lines.append(f'- 历史参数名（挑接口用，来自 Wayback + Common Crawl）：{", ".join(merged_params[:40])}')
            lines.append('')
    (out / 'inventory.md').write_text('\n'.join(lines), encoding='utf-8')
    print(f'\n产出：{out}/inventory.md 与每个域名一份 JSON')
    print('注意：Phase 3 的主动探测要另起（低速率、只打 in-scope 清单 —— 平台禁止大规模扫描）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
