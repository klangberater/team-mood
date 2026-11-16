#!/usr/bin/env python3
"""Team Mood's dashboard server: the panel as a web page, for sessions that draw no panel.

The mod starts it, posts the team's state to it, and collects the presses people make on the
page. Standard library only. It stops by itself once the mod has been quiet for --idle seconds,
so it never outlives the session by long.

  GET  /          the page (index.html beside this file, with the page token filled in)
  GET  /state     the latest state the mod posted
  POST /action    a press on the page: {"kind": "fix"|"checkup"|"refresh", "target": "..."}
  POST /state     the mod's new state            (mod token)
  GET  /actions   the presses since the last ask (mod token)
"""

import argparse
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
KINDS = {"fix", "checkup", "refresh"}
MAX_BODY = 4 * 1024 * 1024
MAX_PENDING = 20

parser = argparse.ArgumentParser()
parser.add_argument("--host", action="append", help="an address to listen on; repeatable")
parser.add_argument("--port", type=int, default=4873)
parser.add_argument("--info", required=True, help="where to write {port, pid, token}")
parser.add_argument("--idle", type=int, default=120)
args = parser.parse_args()

MOD_TOKEN = secrets.token_urlsafe(24)
PAGE_TOKEN = secrets.token_urlsafe(24)
lock = threading.Lock()
state = b"{}"
pending = []
last_seen = time.time()


def page():
    with open(os.path.join(HERE, "index.html"), "rb") as f:
        return f.read().replace(b"__TEAM_MOOD_TOKEN__", PAGE_TOKEN.encode())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, body=b"", kind="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def token_is(self, token):
        return secrets.compare_digest(self.headers.get("X-Team-Mood-Token", ""), token)

    def body(self):
        size = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(size) if 0 < size <= MAX_BODY else b""

    def do_GET(self):
        global last_seen, pending
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            return self.send(200, page(), "text/html; charset=utf-8")
        if path == "/state":
            with lock:
                return self.send(200, state)
        if path == "/actions":
            if not self.token_is(MOD_TOKEN):
                return self.send(403)
            with lock:
                last_seen = time.time()
                taken, pending = pending, []
            return self.send(200, json.dumps(taken).encode())
        self.send(404)

    def do_POST(self):
        global state, last_seen
        path = self.path.split("?")[0]
        if path == "/state":
            if not self.token_is(MOD_TOKEN):
                return self.send(403)
            raw = self.body()
            try:
                json.loads(raw)
            except ValueError:
                return self.send(400)
            with lock:
                state, last_seen = raw, time.time()
            return self.send(204)
        if path == "/action":
            if not self.token_is(PAGE_TOKEN):
                return self.send(403)
            try:
                action = json.loads(self.body())
                kind, target = action["kind"], str(action.get("target", ""))[:100]
            except (ValueError, KeyError, TypeError):
                return self.send(400)
            if kind not in KINDS:
                return self.send(400)
            with lock:
                if len(pending) >= MAX_PENDING:
                    return self.send(429)
                pending.append({"kind": kind, "target": target})
            return self.send(202, b'{"ok":true}')
        self.send(404)


def bind(hosts):
    """One server per address, all on the same port: the preferred one, else one the first picks."""
    try:
        first = ThreadingHTTPServer((hosts[0], args.port), Handler)
    except OSError:
        first = ThreadingHTTPServer((hosts[0], 0), Handler)
    port = first.server_address[1]
    return [first] + [ThreadingHTTPServer((host, port), Handler) for host in hosts[1:]]


def main():
    hosts = args.host or ["127.0.0.1"]
    servers = bind(hosts)
    info = {
        "port": servers[0].server_address[1],
        "pid": os.getpid(),
        "token": MOD_TOKEN,
        "hosts": hosts,
    }
    fd = os.open(args.info, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(info, f)

    def watchdog():
        while time.time() - last_seen < args.idle:
            time.sleep(5)
        for server in servers:
            server.shutdown()

    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()
    servers[0].serve_forever()
    try:
        os.remove(args.info)
    except OSError:
        pass


if __name__ == "__main__":
    sys.exit(main())
