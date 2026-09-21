#!/usr/bin/env python3
"""butian-src-hunter 自带演练靶场 —— 本机测试夹具（test fixture）。

【用途限制】本文件是技能的离线演练夹具，仅限在本机 127.0.0.1 上运行演练；
禁止部署到任何服务器、容器或对外网络。所有数据均为虚构，不代表任何真实系统。
（127.0.0.1 仅本机监听，数据全部为虚构测试数据。）

埋点：
  [真] /.env                 信息泄露（伪造的测试配置，含虚构 DB 口令）
  [真] /api/user?id=<n>      SQLite 字符串拼接注入（布尔差异 + UNION 可取 sqlite_version/表名）
  [假] /admin                静态登录页，无任何漏洞（用于检验误报淘汰关卡）
  [假] /search?q=<x>         输出被 html.escape 完全编码（用于检验 XSS 误报淘汰）
"""
import html
import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

DB = ":memory:"
_CONN = None


def get_db():
    global _CONN
    if _CONN is None:
        _CONN = sqlite3.connect(DB, check_same_thread=False)
    return _CONN


def init_db():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, phone TEXT, role TEXT)")
    cur.executemany(
        "INSERT INTO users VALUES (?,?,?,?)",
        [(1, "testuser01", "138****5678", "user"),
         (2, "testuser02", "139****1234", "user"),
         (3, "testadmin", "137****0000", "admin")],
    )
    conn.commit()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Server", "TestLab/1.0")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/":
            self._send(200, "<html><head><title>XX图书管理系统 测试站</title></head>"
                            "<body><h1>XX图书管理系统</h1><p>用户查询：<a href='/api/user?id=1'>/api/user?id=1</a></p>"
                            "<p>搜索：<form action='/search'><input name='q'><input type='submit'></form></p>"
                            "<p><a href='/admin'>管理后台</a></p></body></html>")
        elif path == "/.env":
            self._send(200,
                       "APP_ENV=test\n"
                       "DB_HOST=127.0.0.1\n"
                       "DB_NAME=testlab_db\n"
                       "DB_USER=testlab\n"
                       "DB_PASS=TestLab_Fake_Pass_2026\n",
                       ctype="text/plain; charset=utf-8")
        elif path == "/api/user":
            uid = qs.get("id", ["1"])[0]
            # 故意字符串拼接 —— SQL 注入埋点
            sql = f"SELECT id, username, phone FROM users WHERE id = {uid}"
            try:
                conn = get_db()
                rows = conn.execute(sql).fetchall()
                if rows:
                    body = "".join(
                        f"<div>id={r[0]} user={html.escape(str(r[1]))} phone={html.escape(str(r[2]))}</div>"
                        for r in rows)
                    self._send(200, f"<html><body>{body}</body></html>")
                else:
                    self._send(200, "<html><body>user not found</body></html>")
            except sqlite3.Error as e:
                self._send(500, f"<html><body>DB error: {e}</body></html>")
        elif path == "/search":
            q = qs.get("q", [""])[0]
            # html.escape 完全编码 —— XSS 假阳性埋点
            self._send(200, f"<html><body><p>搜索结果: {html.escape(q)}</p></body></html>")
        elif path == "/admin":
            # 静态登录页 —— "后台暴露"假阳性埋点，无任何功能
            self._send(200, "<html><head><title>管理后台登录</title></head>"
                            "<body><h1>管理后台</h1><form><input placeholder='账号'><input placeholder='密码' type='password'>"
                            "<button type='button'>登录（测试环境未开通）</button></form></body></html>")
        elif path == "/robots.txt":
            self._send(200, "User-agent: *\nDisallow: /admin/\n", ctype="text/plain")
        else:
            self._send(404, "<html><body>404 Not Found</body></html>")

    def log_message(self, fmt, *args):
        pass  # 静默访问日志


if __name__ == "__main__":
    init_db()
    server = HTTPServer(("127.0.0.1", 8899), Handler)
    print("[lab] 演练夹具已启动: http://127.0.0.1:8899 （仅限本机 127.0.0.1，禁止对外部署/暴露）")
    server.serve_forever()
