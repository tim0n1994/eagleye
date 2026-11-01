"""Eagleye X Following 2h 触发脚本运行时行为测试（R2.1 一致性）.

覆盖 deploy/thinkpad/eagleye-x-following.py 的四类守卫/行为：
  1. 模式守卫：unset -> feed（跟随 connector 默认）触发；feed/hybrid 触发；
     per-user / 其他显式值跳过。
  2. overlap 守卫：full-pipeline/fetch-all queued|running 时跳过。
  3. 无可用 admin key -> 退出码 1。
  4. 正常触发：对 /api/x-following/sync?background=true 发一次 POST。

全 hermetic：fixture sqlite（只读使用）、临时 env 文件、本地随机端口
ThreadingHTTPServer 假服务端（不触碰任何真实后端/Twitter）。零抓取。
"""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "deploy" / "thinkpad" / "eagleye-x-following.py"


class FakeSyncServer:
    """记录 POST /api/x-following/sync 请求的本地假服务端."""

    def __init__(self):
        self.hits = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                outer.hits.append({
                    "path": self.path,
                    "auth": self.headers.get("Authorization", ""),
                })
                body = json.dumps({"status": "ok", "job_id": "job-fixture-1"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # 静音测试输出
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    @property
    def base(self):
        host, port = self.server.server_address
        return f"http://127.0.0.1:{port}"


class TriggerBehaviorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp.name, "fixture.sqlite")
        con = sqlite3.connect(self.db_path)
        con.executescript("""
            CREATE TABLE background_jobs (
                id INTEGER PRIMARY KEY, job_type TEXT, status TEXT
            );
            CREATE TABLE users (
                id INTEGER PRIMARY KEY, status TEXT, role TEXT
            );
            CREATE TABLE api_keys (
                key TEXT PRIMARY KEY, user_id INTEGER, active INTEGER, expires_at TEXT
            );
        """)
        con.execute("INSERT INTO users (id, status, role) VALUES (1, 'active', 'admin')")
        con.execute(
            "INSERT INTO api_keys (key, user_id, active, expires_at) "
            "VALUES ('fixture-admin-key', 1, 1, NULL)")
        con.commit()
        con.close()
        self.env_file = os.path.join(self.tmp.name, "pipeline.env")

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, mode_env=None, pipeline_busy=False, with_key=True):
        con = sqlite3.connect(self.db_path)
        if pipeline_busy:
            con.execute(
                "INSERT INTO background_jobs (id, job_type, status) "
                "VALUES (1, 'full-pipeline', 'running')")
        if not with_key:
            con.execute("DELETE FROM api_keys")
        con.commit()
        con.close()

        if mode_env is not None:
            with open(self.env_file, "w") as f:
                f.write(f"X_FOLLOWING_MODE={mode_env}\n")
        elif os.path.exists(self.env_file):
            os.remove(self.env_file)

        env = {k: v for k, v in os.environ.items() if "proxy" not in k.lower()}
        env.update({
            "EAGLEYE_DB_PATH": self.db_path,
            "EAGLEYE_API_BASE_URL": self.server.base,
            "EAGLEYE_PIPELINE_ENV_FILE": self.env_file,
            "no_proxy": "*",
            "NO_PROXY": "*",
        })
        return subprocess.run(
            [sys.executable, str(SCRIPT)],
            capture_output=True, text=True, timeout=30, env=env,
        )

    def assert_fired(self, proc, server):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload.get("fired"), "job-fixture-1")
        self.assertEqual(len(server.hits), 1)
        self.assertEqual(server.hits[0]["path"], "/api/x-following/sync?background=true")
        self.assertTrue(server.hits[0]["auth"].startswith("Bearer "))

    def assert_skipped(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload.get("skipped"))

    def test_unset_mode_defaults_to_feed_and_fires(self):
        with FakeSyncServer() as server:
            self.server = server
            proc = self.run_script(mode_env=None)
            self.assert_fired(proc, server)

    def test_explicit_feed_fires(self):
        with FakeSyncServer() as server:
            self.server = server
            proc = self.run_script(mode_env="feed")
            self.assert_fired(proc, server)

    def test_explicit_hybrid_fires(self):
        with FakeSyncServer() as server:
            self.server = server
            proc = self.run_script(mode_env="hybrid")
            self.assert_fired(proc, server)

    def test_explicit_per_user_skips(self):
        with FakeSyncServer() as server:
            self.server = server
            proc = self.run_script(mode_env="per-user")
            self.assert_skipped(proc)
            self.assertEqual(server.hits, [])
            payload = json.loads(proc.stdout)
            self.assertEqual(payload.get("mode"), "per-user")

    def test_unknown_mode_skips(self):
        with FakeSyncServer() as server:
            self.server = server
            proc = self.run_script(mode_env="per_user")
            self.assert_skipped(proc)
            self.assertEqual(server.hits, [])

    def test_pipeline_active_skips(self):
        with FakeSyncServer() as server:
            self.server = server
            proc = self.run_script(mode_env=None, pipeline_busy=True)
            self.assert_skipped(proc)
            self.assertEqual(server.hits, [])
            self.assertEqual(json.loads(proc.stdout).get("reason"), "pipeline active")

    def test_no_admin_key_fails(self):
        with FakeSyncServer() as server:
            self.server = server
            proc = self.run_script(mode_env=None, with_key=False)
            self.assertEqual(proc.returncode, 1)
            self.assertEqual(json.loads(proc.stdout).get("error"), "no admin key")
            self.assertEqual(server.hits, [])


if __name__ == "__main__":
    unittest.main()
