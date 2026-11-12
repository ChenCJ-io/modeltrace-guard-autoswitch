#!/usr/bin/env python3
"""本机模拟中转，用来不花钱地把 live 流程跑通。

请求 http://127.0.0.1:18765/serve/<模型>/v1/chat/completions 时，不管请求里写的是什么模型，
都从仓库参考数据里随机挑一条 <模型> 的真实回答返回，相当于一个把模型偷偷换掉的中转。

注意：回答取自指纹库的训练数据，判得会比真实渠道更准，只能用来验证流程，不能当准确率。
"""

from __future__ import annotations

import argparse
import json
import random
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PATH = re.compile(r"^/serve/([^/]+)/v1/chat/completions$")


def load_answers() -> dict[str, list[str]]:
    answers: dict[str, list[str]] = {}
    for name in ("gpt_reference.jsonl", "claude_reference.jsonl"):
        for line in (REPO / "data" / name).read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row.get("strict_valid"):
                answers.setdefault(row["model_id"], []).append(row["text"])
    return answers


def make_handler(answers: dict[str, list[str]]):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - http.server 的固定方法名
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            match = PATH.match(self.path)
            if not match or match.group(1) not in answers:
                self.send_json(404, {"error": {"message": f"未知路径或模型：{self.path}"}})
                return
            text = random.choice(answers[match.group(1)])
            self.send_json(200, {"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]})

        def send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args) -> None:  # noqa: A002
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="本机模拟中转")
    parser.add_argument("--port", type=int, default=18765)
    args = parser.parse_args()
    answers = load_answers()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(answers))
    print(f"模拟中转已启动：http://127.0.0.1:{args.port}/serve/<模型>/v1，可选模型：{'、'.join(answers)}")
    server.serve_forever()


if __name__ == "__main__":
    main()
