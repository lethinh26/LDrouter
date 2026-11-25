"""CI-only browser smoke against the built app and a local mock upstream."""

import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright


class MockUpstream(BaseHTTPRequestHandler):
    calls = []
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def respond(self, status, body):
        data = json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The gateway deliberately cancelled a slow attempt.

    def do_GET(self):
        self.respond(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in ["a", "b"]]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        model = body["model"]
        with self.lock:
            self.calls.append(model)
            nth = self.calls.count(model)
        if model == "a" and nth == 1:
            time.sleep(1.8)
        if model == "b" and nth == 1:
            self.respond(503, {"error": {"message": "fixture unavailable"}})
            return
        self.respond(200, {"id": "mock", "object": "chat.completion", "created": 0, "model": model,
                           "choices": [{"index": 0, "message": {"role": "assistant", "content": f"answer-{model}"}, "finish_reason": "stop"}],
                           "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6}})


def smoke(base, upstream):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(base_url=base)
        page.set_default_timeout(15000)

        def post(path, data, headers=None):
            response = page.request.post(path, data=data, headers=headers)
            assert response.ok, f"POST {path}: {response.status} {response.text()}"
            return response.json()

        credentials = {"username": "admin", "password": "ci-only-admin-password-1234"}
        post("/api/admin/setup", credentials)
        post("/api/admin/login", credentials)
        csrf = {"x-csrf-token": page.request.get("/api/admin/csrf").json()["csrfToken"]}
        provider = {"type": "openai", "name": "CI", "slug": "ci", "baseUrl": upstream,
                    "apiKey": "fixture-key", "totalTimeoutMs": 8000, "maxRetries": 0, "cbFailureThreshold": 10}
        for legacy in ["codex", "qoder"]:
            assert page.request.post("/api/admin/providers", data={**provider, "type": legacy}, headers=csrf).status == 400
        provider_id = post("/api/admin/providers", provider, csrf)["id"]
        post("/api/admin/models/import", {"providerId": provider_id, "modelIds": ["a", "b"]}, csrf)
        models = {m["upstreamModelId"]: m["id"] for m in page.request.get("/api/admin/models").json()["models"]}
        combo = post("/api/admin/combos", {"name": "Adaptive CI", "maxTotalAttempts": 3,
                     "slowResponseThresholdSeconds": 1, "slowResponseMaxCount": 1,
                     "members": [{"modelId": models[m], "position": i} for i, m in enumerate(["a", "b"])]}, csrf)
        key = post("/api/admin/api-keys", {"name": "CI", "allowAllModels": True}, csrf)["secret"]
        result = post("/v1/chat/completions", {"model": combo["publicModelId"], "max_tokens": 64,
                      "messages": [{"role": "user", "content": "fixture"}]}, {"Authorization": f"Bearer {key}"})
        assert result["choices"][0]["message"]["content"] == "answer-a"
        assert MockUpstream.calls == ["a", "b", "a"], MockUpstream.calls

        page.goto("/requests")
        request_row = page.get_by_role("row").filter(has_text=combo["publicModelId"])
        request_row.get_by_role("button", name="View request", exact=False).click()
        page.get_by_role("tab", name="Attempts (3)").click()
        expect(page.get_by_role("cell", name="rescue_replay", exact=True)).to_be_visible()

        page.goto("/combos")
        row = page.get_by_role("row").filter(has_text="Adaptive CI")
        row.get_by_role("button", name="Sửa").click()
        dialog = page.get_by_role("dialog")
        expect(dialog.get_by_text("Adaptive routing by workload")).to_be_visible()
        expect(dialog.get_by_text("Degraded · reserve", exact=True)).to_be_visible()
        handle = dialog.get_by_role("button", name="Reorder ci/b")
        handle.focus()
        handle.press("Space")
        handle.press("ArrowUp")
        handle.press("Space")
        dialog.get_by_role("button", name="Save", exact=True).click()
        expect(dialog).not_to_be_visible()

        detail_path = f"/api/admin/combos/{combo['id']}"
        def detail():
            return page.request.get(detail_path).json()["combo"]
        assert [m["modelId"] for m in detail()["members"]] == [models["b"], models["a"]]
        before = [m["adaptiveStates"] for m in detail()["members"]]
        row.get_by_role("button", name="Test", exact=True).click()
        expect(page.get_by_role("dialog").get_by_text("Combo test result")).to_be_visible()
        expect(page.get_by_role("dialog").get_by_text("answer-b", exact=False)).to_be_visible()
        page.get_by_role("dialog").get_by_role("button", name="Close", exact=True).last.click()
        assert [m["adaptiveStates"] for m in detail()["members"]] == before, "Admin test trained adaptive state"
        row.get_by_role("button", name="Sửa").click()
        page.get_by_role("dialog").get_by_role("button", name="Reset history").click()
        expect(page.get_by_text("No measured workload history yet.", exact=False)).to_be_visible()
        assert all(not m["adaptiveStates"] for m in detail()["members"])
        browser.close()


def main():
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), MockUpstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="ldrouter-ci-e2e-") as temp:
        data = Path(temp).resolve()
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        env = {**os.environ, "LATEDEV_HOST": "127.0.0.1", "LATEDEV_PORT": str(port),
               "LATEDEV_DATA_DIR": str(data), "LATEDEV_DB_URL": str(data / "data.sqlite"),
               "LATEDEV_MASTER_KEY": "0123456789abcdef0123456789abcdef", "LATEDEV_LOG_LEVEL": "error"}
        with (data / "gateway.log").open("w+") as log:
            proc = subprocess.Popen(["node", "dist/cli.js", "--no-tui"], env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    if proc.poll() is not None:
                        raise RuntimeError("Gateway exited before readiness")
                    try:
                        with urlopen(base + "/ready", timeout=0.5) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        pass
                    time.sleep(0.2)
                else:
                    raise RuntimeError("Gateway did not become ready")
                smoke(base, f"http://127.0.0.1:{upstream.server_port}")
                print("Adaptive combo browser smoke passed")
            except Exception:
                log.seek(0)
                print(log.read()[-12000:])
                raise
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                upstream.shutdown()
                upstream.server_close()


if __name__ == "__main__":
    main()
