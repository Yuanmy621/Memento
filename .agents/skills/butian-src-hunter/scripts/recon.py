#!/usr/bin/env python3
"""butian-src-hunter 资产侦察辅助脚本（阶段 1 用）——授权门禁版

合规约束（三条硬性设计，修改前先读 SKILL.md 铁律）：
  1. TLS 证书与主机名校验保持开启（默认 ssl.create_default_context()）。
     自签/过期/域名不匹配的证书会直接报错并在结果中标注——这本身是有价值的
     指纹线索，不允许为"跑通"而静默关闭校验。
  2. 敏感路径探测只发 HEAD，不做 GET 回退：只确认存在性，绝不读取任何内容。
  3. 必须显式传 --authorized 才会运行：表示调用方已按 SKILL.md 阶段 0 在补天
     核实目标收录。对未收录目标的探测属非法越权测试，本脚本拒绝参与。

用法:
  python recon.py example.com --authorized                # 完整侦察
  python recon.py example.com --authorized --no-sub       # 跳过子域枚举，只探测主域
  python recon.py example.com --authorized --delay 2      # 每个请求间隔秒数（默认 1.5）
  python recon.py example.com --authorized --out 02-assets.md   # 输出 markdown，默认打印

仅用 Python 标准库，无需安装依赖。
"""
import argparse
import json
import ssl
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) butian-src-recon/1.0"

# TLS：严格校验证书链与主机名（默认行为）。不允许为了绕过自签证书而关闭校验。
CTX = ssl.create_default_context()

# 只探测存在性（HEAD/GET 状态码），不读取、不利用
SENSITIVE_PATHS = [
    "/.git/HEAD", "/.env", "/.svn/entries", "/backup.zip", "/web.config",
    "/phpinfo.php", "/test.php", "/admin/", "/manager/html",
    "/actuator/env", "/swagger.json", "/api-docs", "/druid/index.html",
    "/server-status", "/.DS_Store", "/robots.txt",
]

INTERESTING_HEADERS = ("server", "x-powered-by", "set-cookie", "content-security-policy",
                       "strict-transport-security", "via", "x-cache")


def fetch(url, method="GET", timeout=10, retries=2):
    """带重试的请求。瞬时 DNS/连接抖动很常见，重试 2 次（间隔 1s）再判失败。"""
    last_err = ""
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={"User-Agent": UA}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
                body = resp.read(65536) if method == "GET" else b""
                return resp.status, dict(resp.headers), body
        except urllib.error.HTTPError as e:
            try:
                body = e.read(4096) if method == "GET" else b""
            except Exception:
                body = b""  # 错误响应体本身可能超时/截断，状态码已足够
            return e.code, dict(e.headers or {}), body
        except urllib.error.URLError as e:
            reason = getattr(e, "reason", None)
            if isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
                # 证书校验失败：如实上报，绝不关闭校验重试
                return None, {}, f"TLS证书校验失败(自签/过期/域名不匹配): {reason}".encode()
            last_err = str(e)
            if attempt < retries:
                time.sleep(1)
        except Exception as e:
            last_err = str(e)
            if attempt < retries:
                time.sleep(1)
    return None, {}, last_err.encode()


def subdomains_crtsh(domain, delay):
    url = f"https://crt.sh/?q=%25.{domain}&output=json"
    try:
        status, _, body = fetch(url, timeout=25)
        if status != 200:
            return []
        names = set()
        for row in json.loads(body.decode("utf-8", "ignore")):
            for n in row.get("name_value", "").splitlines():
                n = n.strip().lstrip("*.").lower()
                if n.endswith(domain) and n != domain:
                    names.add(n)
        return sorted(names)
    except Exception:
        return []


def probe_host(host, scheme, delay):
    base = f"{scheme}://{host}"
    status, headers, body = fetch(base, timeout=10)
    if status is None:
        err = body.decode("utf-8", "ignore")
        if "TLS证书校验失败" in err:
            return {"url": base, "status": "TLS失败", "title": "", "fingerprint": {}, "hits": [err[:120]]}
        return None
    title = ""
    low = body.decode("utf-8", "ignore").lower()
    if "<title" in low:
        s = low.find(">", low.find("<title")) + 1
        e = low.find("</title>", s)
        title = body.decode("utf-8", "ignore")[s:e].strip()[:100] if e > s else ""
    fp = {h: headers.get(h, "")[:120] for h in INTERESTING_HEADERS if headers.get(h)}
    time.sleep(delay)
    hits = []
    for p in SENSITIVE_PATHS:
        # 合规设计：只发 HEAD，不做 GET 回退——只确认存在性，绝不读取内容
        code, _, _ = fetch(base + p, method="HEAD", timeout=8)
        if code in (200, 301, 302, 401, 403):
            hits.append(f"{p} -> {code}")
        elif code in (501, 405):
            hits.append(f"{p} -> {code}(不支持HEAD，合规要求不回退GET)")
        time.sleep(delay)
    return {"url": base, "status": status, "title": title, "fingerprint": fp, "hits": hits}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("domain")
    ap.add_argument("--no-sub", action="store_true", help="跳过 crt.sh 子域枚举")
    ap.add_argument("--delay", type=float, default=1.5, help="请求间隔秒数")
    ap.add_argument("--out", help="输出 markdown 文件路径")
    ap.add_argument("--authorized", action="store_true",
                    help="授权声明：已按 SKILL.md 阶段 0 在补天核实目标收录（必填，缺失则拒绝运行）")
    args = ap.parse_args()

    if not args.authorized:
        print("[!] 拒绝运行：缺少 --authorized。请先按 SKILL.md 阶段 0 在补天平台核实目标收录"
              "（公益 SRC 厂商列表 / 专属 SRC 范围 / 通用漏洞范围），确认目标在授权范围内后，"
              "加 --authorized 重新运行。对未收录目标的探测属非法越权测试。", file=sys.stderr)
        sys.exit(2)
    print("[ok] 已声明授权：目标应在补天收录范围内（若尚未核实，请立即停止）。", file=sys.stderr)

    domain = args.domain.strip().lower().replace("https://", "").replace("http://", "").rstrip("/")
    print(f"[*] 目标: {domain} (仅限补天授权范围内资产)", file=sys.stderr)

    targets = {domain}
    if not args.no_sub:
        print("[*] crt.sh 子域枚举 ...", file=sys.stderr)
        subs = subdomains_crtsh(domain, args.delay)
        print(f"[*] 获取子域 {len(subs)} 个", file=sys.stderr)
        targets.update(subs[:50])  # 限速前提下限制探测量

    rows = []
    for host in sorted(targets):
        for scheme in ("https", "http"):
            r = probe_host(host, scheme, args.delay)
            if r:
                rows.append(r)
                break
        time.sleep(args.delay)

    lines = ["# 资产侦察结果", "", "| 主机 | 状态 | 标题 | 指纹 | 敏感路径命中 |", "|---|---|---|---|---|"]
    for r in rows:
        fp = "; ".join(f"{k}={v}" for k, v in r["fingerprint"].items()) or "-"
        hits = "<br>".join(r["hits"]) if r["hits"] else "-"
        title = r["title"].replace("|", "/")
        lines.append(f"| {r['url']} | {r['status']} | {title} | {fp} | {hits} |")
    lines += ["", "> 敏感路径命中仅为存在性线索，进入阶段 3 前必须按 vuln-playbook 完整验证。"]
    out = "\n".join(lines)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out)
        print(f"[*] 已写入 {args.out}", file=sys.stderr)
    else:
        print(out)


if __name__ == "__main__":
    main()
