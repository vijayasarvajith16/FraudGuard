import csv
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from creditcard import FEATURES, LABEL

FRAUD_MARKER = 9.0  # fixture fraud rows have V1 = 9; the fakes use it to decide outcomes


def make_row(label: int, amount: float, seq: int) -> dict:
    row = {name: 0.0 for name in FEATURES}
    row.update(Time=float(seq), V2=seq / 100, Amount=amount, V1=FRAUD_MARKER if label else 0.0)
    row[LABEL] = label
    return row


@pytest.fixture
def dataset(tmp_path):
    """12 normal rows, 4 fraud rows, 2 rows with Amount 0 (one of each label)."""
    rows = [make_row(0, 10.0 + i, i) for i in range(12)]
    rows += [make_row(1, 50.0 + i, 100 + i) for i in range(4)]
    rows += [make_row(0, 0.0, 200), make_row(1, 0.0, 201)]
    path = tmp_path / "creditcard.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=[*FEATURES, LABEL])
        writer.writeheader()
        for row in rows:
            writer.writerow({**row, LABEL: f"{row[LABEL]}"})
    return path


class FakeServer:
    """Run a BaseHTTPRequestHandler subclass on an ephemeral port for one test."""

    def __init__(self, handler_cls):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class JsonHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive, like the real services

    def log_message(self, *_):
        pass

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length)) if length else None

    def reply(self, status, body, headers=None):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)


@pytest.fixture
def serve():
    servers = []

    def start(handler_cls):
        server = FakeServer(handler_cls)
        servers.append(server)
        return server

    yield start
    for server in servers:
        server.close()
