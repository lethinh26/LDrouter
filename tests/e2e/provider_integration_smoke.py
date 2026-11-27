"""CI browser regression for provider identity, discovery, config and key ACLs.

Run after pnpm build: python tests/e2e/provider_integration_smoke.py
The fixture uses a fresh SQLite database, loopback upstream and synthetic keys.
No signed-in client or external provider endpoint is contacted.
"""

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


class ProviderFixture(BaseHTTPRequestHandler):
    hold_catalog = threading.Event()
    release_catalog = threading.Event()
    calls = []

    def log_message(self, *_args):
        pass

    def respond(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/v1/models":
            self.respond(404, {"error": {"message": "Unexpected fixture path"}})
            return
        if self.hold_catalog.is_set():
            self.release_catalog.wait(timeout=10)
        self.respond(200, {"object": "list", "data": [
            {"id": model, "object": "model"} for model in ("fixture-a", "fixture-b", "fixture-c")
        ]})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.respond(404, {"error": {"message": "Unexpected fixture path"}})
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        model = body["model"]
        self.calls.append(model)
        self.respond(200, {
            "id": "provider-smoke", "object": "chat.completion", "created": 0,
            "model": model, "choices": [{"index": 0, "message": {
                "role": "assistant", "content": "answer-" + model}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6},
        })


def smoke(base, upstream):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(base_url=base, viewport={"width": 1440, "height": 1200},
                                reduced_motion="reduce")
        page.set_default_timeout(15000)

        def get(path, headers=None):
            response = page.request.get(path, headers=headers)
            assert response.ok, f"GET {path}: {response.status}"
            return response.json()

        def admin_post(path, data):
            csrf = get("/api/admin/csrf")["csrfToken"]
            response = page.request.post(path, data=data, headers={"x-csrf-token": csrf})
            assert response.ok, f"POST {path}: {response.status}"
            return response.json()

        def providers():
            return {row["name"]: row for row in get("/api/admin/providers")["providers"]}

        def models():
            return {row["publicModelId"]: row for row in get("/api/admin/models")["models"]}

        def choose(dialog, option):
            dialog.get_by_role("combobox").click()
            page.get_by_role("option", name=option, exact=True).click()

        def new_provider(name, slug):
            page.get_by_role("button", name="Add provider").click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_label("Name", exact=True).fill(name)
            dialog.get_by_label("Slug (optional)", exact=True).fill(slug)
            return dialog

        def open_edit(name):
            row = page.get_by_role("row").filter(has_text=name)
            row.get_by_role("button", name="✎", exact=True).click()
            return page.get_by_role("dialog")

        credentials = {"username": "admin", "password": "ci-only-provider-admin-password"}
        for path in ("/api/admin/setup", "/api/admin/login"):
            response = page.request.post(path, data=credentials)
            assert response.ok, f"POST {path}: {response.status}"
        page.goto("/providers")
        dialog = new_provider("Compatible fixture", "codex")
        dialog.get_by_label("Base URL", exact=True).fill(upstream)
        dialog.get_by_label("API key", exact=True).fill("fixture-compatible-key")
        dialog.get_by_role("button", name="Create", exact=True).click()
        expect(dialog).not_to_be_visible()
        row = page.get_by_role("row").filter(has_text="Compatible fixture")
        expect(row.get_by_text("openai", exact=True)).to_be_visible()
        row.get_by_title("Test connection").click()
        expect(page.get_by_text("Connection OK:", exact=False)).to_be_visible()
        compatible_id = providers()["Compatible fixture"]["id"]
        assert providers()["Compatible fixture"]["providerKind"] == "compatible"

        # A pre-existing compatible provider using the codex prefix keeps its
        # identity; the new integration must explicitly choose another slug.
        dialog = new_provider("Native Codex fixture", " CODEX ")
        choose(dialog, "Codex (client sign-in)")
        expect(dialog.get_by_label("Base URL", exact=True)).to_be_disabled()
        expect(dialog.get_by_label("API key", exact=True)).to_have_count(0)
        expect(dialog.get_by_label("Custom headers (JSON)")).to_have_count(0)
        with page.expect_response(lambda r: r.url.endswith("/api/admin/providers")
                                  and r.request.method == "POST") as conflict:
            dialog.get_by_role("button", name="Create", exact=True).click()
        assert conflict.value.status == 409
        expect(page.get_by_text("Try 'codex-oauth'", exact=False)).to_be_visible()
        expect(dialog).to_be_visible()
        dialog.get_by_label("Slug (optional)", exact=True).fill("codex-oauth")
        dialog.get_by_role("button", name="Create", exact=True).click()
        expect(dialog).not_to_be_visible()
        native = providers()["Native Codex fixture"]
        assert native["providerKind"] == "codex" and native["authMode"] == "client_oauth"
        assert providers()["Compatible fixture"]["id"] == compatible_id
        row = page.get_by_role("row").filter(has_text="Native Codex fixture")
        expect(row.get_by_title("Test from signed-in Codex client")).to_be_disabled()

        dialog = open_edit("Native Codex fixture")
        expect(dialog.get_by_role("combobox")).to_be_disabled()
        expect(dialog.locator("input[type=password]")).to_have_count(0)
        expect(dialog.get_by_label("Slug", exact=True)).to_be_enabled()
        dialog.get_by_label("Slug", exact=True).fill("coding-ci")
        dialog.get_by_role("button", name="Save changes", exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(row.get_by_text("coding-ci", exact=True)).to_be_visible()
        assert providers()["Native Codex fixture"]["id"] == native["id"]
        dialog = open_edit("Native Codex fixture")
        config = dialog.locator("pre")
        expect(config).to_contain_text('model = "coding-ci/YOUR_IMPORTED_MODEL"')
        expect(config).to_contain_text(base + "/backend-api/codex")
        expect(config).to_contain_text('env_http_headers = { "X-API-Key" = "LATEDEV_API_KEY" }')
        dialog.get_by_role("button", name="Cancel", exact=True).click()

        # Create the Claude Code config only: its origin is fixed and this
        # test intentionally never discovers or tests an external endpoint.
        dialog = new_provider("Claude Code fixture", "claude-ci")
        choose(dialog, "Claude Code (API key)")
        expect(dialog.get_by_label("Base URL", exact=True)).to_have_value("https://api.anthropic.com")
        expect(dialog.get_by_label("Base URL", exact=True)).to_be_disabled()
        expect(dialog.get_by_label("Custom headers (JSON)")).to_have_count(0)
        dialog.get_by_label("API key", exact=True).fill("sk-ant-api-fixture-only")
        dialog.get_by_role("button", name="Create", exact=True).click()
        expect(dialog).not_to_be_visible()
        claude = providers()["Claude Code fixture"]
        assert claude["providerKind"] == "claude_code" and claude["authMode"] == "api_key"
        dialog = open_edit("Claude Code fixture")
        expect(dialog.locator("input[type=password]")).to_have_value("")
        expect(dialog.locator("pre")).to_contain_text("ANTHROPIC_BASE_URL=" + base)
        expect(dialog.locator("pre")).to_contain_text("ANTHROPIC_MODEL=claude-ci/YOUR_IMPORTED_MODEL")
        dialog.get_by_role("button", name="Cancel", exact=True).click()
        assert "fixture-compatible-key" not in json.dumps(providers())
        assert "sk-ant-api-fixture-only" not in json.dumps(providers())

        page.goto("/models")
        page.get_by_role("button", name="Fetch models").click()
        dialog = page.get_by_role("dialog")
        choose(dialog, "Compatible fixture")
        # Keep the real discovery response pending so the provider-switch race
        # cannot be hidden by a fast mock. Closing/reopening must also be blocked.
        ProviderFixture.hold_catalog.set()
        try:
            with page.expect_response(lambda r: r.url.endswith("/discover")) as result:
                try:
                    dialog.get_by_role("button", name="Fetch", exact=True).click()
                    expect(dialog.get_by_role("combobox")).to_be_disabled()
                    expect(dialog.get_by_role("button", name="Cancel", exact=True)).to_be_disabled()
                    expect(dialog.get_by_role("button", name="Import", exact=True)).to_be_disabled()
                    page.keyboard.press("Escape")
                    expect(dialog).to_be_visible()
                finally:
                    ProviderFixture.release_catalog.set()
            assert result.value.ok
        finally:
            ProviderFixture.hold_catalog.clear()
            ProviderFixture.release_catalog.set()
        expect(dialog.get_by_text("fixture-a", exact=True)).to_be_visible()
        assert not models(), "Discovery must not import models"
        for model in ("fixture-a", "fixture-b"):
            dialog.locator("label").filter(has_text=model).get_by_role("checkbox").click()
        dialog.get_by_role("button", name="Import 2", exact=True).click()
        expect(dialog).not_to_be_visible()
        assert set(models()) == {"codex/fixture-a", "codex/fixture-b"}

        page.get_by_role("button", name="Fetch models").click()
        dialog = page.get_by_role("dialog")
        choose(dialog, "Native Codex fixture")
        expect(dialog.get_by_role("button", name="Fetch", exact=True)).to_have_count(0)
        dialog.get_by_label("Codex upstream model IDs").fill("fixture-a, fixture-a\nfixture-b")
        dialog.get_by_role("button", name="Import 2", exact=True).click()
        expect(dialog).not_to_be_visible()
        catalog = models()
        assert set(catalog) == {"codex/fixture-a", "codex/fixture-b", "coding-ci/fixture-a", "coding-ci/fixture-b"}
        assert catalog["coding-ci/fixture-a"]["id"] != catalog["codex/fixture-a"]["id"]
        assert catalog["coding-ci/fixture-a"]["providerKind"] == "codex"
        page.get_by_role("button", name="Expand all").click()
        native_row = page.get_by_role("row").filter(has_text="coding-ci/fixture-a")
        expect(native_row.get_by_role("button", name="Test", exact=True)).to_be_disabled()
        expect(native_row.get_by_text("Account unverified", exact=True)).to_be_visible()

        page.goto("/providers")
        for provider in ("Compatible fixture", "Native Codex fixture"):
            dialog = open_edit(provider)
            expect(dialog.get_by_label("Slug", exact=True)).to_be_disabled()
            dialog.get_by_role("button", name="Cancel", exact=True).click()

        # Seed a second Codex configuration to verify that duplicate upstream
        # IDs are excluded across provider UUIDs, not just within one provider.
        peer = admin_post("/api/admin/providers", {
            "name": "Native Codex peer", "slug": "coding-peer", "type": "openai",
            "providerKind": "codex",
        })
        admin_post("/api/admin/models/import", {
            "providerId": peer["id"], "modelIds": ["fixture-a", "fixture-c"],
        })
        catalog = models()

        page.goto("/combos")
        page.get_by_role("button", name="New combo").click()
        dialog = page.get_by_role("dialog", name="New combo")
        kind = dialog.get_by_role("combobox", name="Combo type")
        expect(kind).to_have_text("Standard")
        expect(dialog.get_by_role("switch", name="HTTP 429")).to_be_checked()
        expect(dialog.get_by_role("switch", name="Adaptive fallback and recovery")).to_be_checked()
        expect(dialog.get_by_role("button", name="Add coding-ci/fixture-a", exact=True)).to_have_count(0)
        dialog.get_by_role("button", name="Add codex/fixture-a", exact=True).click()
        expect(dialog.get_by_role("button", name="Reorder codex/fixture-a")).to_be_visible()
        kind.click()
        page.get_by_role("option", name="Codex native", exact=True).click()
        expect(dialog.get_by_role("button", name="Reorder codex/fixture-a")).to_have_count(0)
        expect(dialog.get_by_role("button", name="Add codex/fixture-a", exact=True)).to_have_count(0)
        for switch in ("HTTP 429", "Adaptive fallback and recovery"):
            control = dialog.get_by_role("switch", name=switch)
            expect(control).to_be_disabled()
            expect(control).not_to_be_checked()
        dialog.get_by_label("Name", exact=True).fill("Native fallback fixture")
        dialog.get_by_role("button", name="Add coding-ci/fixture-a", exact=True).click()
        expect(dialog.get_by_role("button", name="Add coding-peer/fixture-a", exact=True)).to_have_count(0)
        dialog.get_by_role("button", name="Add coding-peer/fixture-c", exact=True).click()
        with page.expect_response(lambda r: r.url.endswith("/api/admin/combos")
                                  and r.request.method == "POST") as combo_created:
            dialog.get_by_role("button", name="Create", exact=True).click()
        assert combo_created.value.ok
        combo_id = combo_created.value.json()["id"]
        expect(dialog).not_to_be_visible()
        combo_path = "/api/admin/combos/" + combo_id
        native_combo = get(combo_path)["combo"]
        native_public_id = native_combo["publicModelId"]
        assert native_combo["comboKind"] == "codex_native"
        assert not native_combo["fallbackOn429"] and not native_combo["slowResponseFallbackEnabled"]
        assert [m["modelId"] for m in native_combo["members"]] == [
            catalog["coding-ci/fixture-a"]["id"], catalog["coding-peer/fixture-c"]["id"],
        ]
        assert next(c for c in get("/api/admin/combos")["combos"] if c["id"] == combo_id)["comboKind"] == "codex_native"
        combo_row = page.get_by_role("row").filter(has_text="Native fallback fixture")
        expect(combo_row.get_by_text("Codex native", exact=True)).to_be_visible()
        expect(combo_row.get_by_role("button", name="Test", exact=True)).to_be_disabled()
        combo_row.get_by_role("button", name="Sửa", exact=True).click()
        dialog = page.get_by_role("dialog", name="Edit combo")
        expect(dialog.get_by_role("combobox", name="Combo type")).to_be_disabled()
        expect(dialog.get_by_role("combobox", name="Combo type")).to_have_text("Codex native")
        expect(dialog.get_by_text("Type is locked after creation.", exact=False)).to_be_visible()
        expect(dialog.get_by_text(native_public_id, exact=True)).to_be_visible()
        expect(dialog.get_by_text("Adaptive routing by workload", exact=True)).to_have_count(0)
        for switch in ("HTTP 429", "Adaptive fallback and recovery"):
            expect(dialog.get_by_role("switch", name=switch)).to_be_disabled()
            expect(dialog.get_by_role("switch", name=switch)).not_to_be_checked()
        dialog.get_by_role("button", name="Move coding-peer/fixture-c up", exact=True).click()
        dialog.get_by_role("button", name="Save", exact=True).click()
        expect(dialog).not_to_be_visible()
        saved = get(combo_path)["combo"]
        assert saved["comboKind"] == "codex_native" and saved["publicModelId"] == native_public_id
        assert [m["modelId"] for m in saved["members"]] == [
            catalog["coding-peer/fixture-c"]["id"], catalog["coding-ci/fixture-a"]["id"],
        ]
        page.get_by_role("button", name="New combo").click()
        dialog = page.get_by_role("dialog", name="New combo")
        expect(dialog.get_by_role("combobox", name="Combo type")).to_have_text("Standard")
        dialog.get_by_role("button", name="Cancel", exact=True).click()

        admin_post("/api/admin/aliases", {
            "alias": "native-combo-ci-alias", "targetKind": "combo", "targetId": combo_id,
        })
        admin_post("/api/admin/aliases", {
            "alias": "native-model-ci-alias", "targetKind": "model", "targetId": catalog["coding-ci/fixture-a"]["id"],
        })

        # ACL must distinguish identical upstream IDs in different namespaces.
        page.goto("/api-keys")
        page.get_by_role("button", name="New key").click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_label("Name", exact=True).fill("Provider scoped fixture")
        warning = dialog.get_by_text("Native Codex rejects finite token limits", exact=False)
        dialog.get_by_label("TPM limit", exact=True).fill("1000")
        expect(warning).to_be_visible()  # Allow All includes Codex.
        dialog.get_by_role("switch", name="Allow all current and future models").click()
        expect(warning).to_have_count(0)
        route_filter = dialog.get_by_role("combobox", name="Filter routes by type")
        route_filter.click()
        page.get_by_role("option", name="Standard", exact=True).click()
        dialog.get_by_role("checkbox", name="codex/fixture-a", exact=True).click()
        expect(dialog.get_by_role("checkbox", name="coding-ci/fixture-a", exact=True)).to_have_count(0)
        expect(warning).to_have_count(0)
        route_filter.click()
        page.get_by_role("option", name="Codex native", exact=True).click()
        expect(dialog.get_by_role("checkbox", name="codex/fixture-a", exact=True)).to_have_count(0)
        # The alias of a native combo must trigger the same token-cap warning.
        dialog.get_by_role("checkbox", name="native-combo-ci-alias", exact=True).click()
        expect(warning).to_be_visible()
        dialog.get_by_role("checkbox", name="native-combo-ci-alias", exact=True).click()
        expect(warning).to_have_count(0)
        dialog.get_by_role("checkbox", name="native-model-ci-alias", exact=True).click()
        expect(warning).to_be_visible()
        dialog.get_by_role("checkbox", name="native-model-ci-alias", exact=True).click()
        expect(warning).to_have_count(0)
        dialog.get_by_role("checkbox", name="coding-ci/fixture-a", exact=True).click()
        expect(warning).to_be_visible()
        dialog.get_by_role("checkbox", name="coding-ci/fixture-a", exact=True).click()
        expect(warning).to_have_count(0)
        dialog.get_by_role("checkbox", name=native_public_id, exact=True).click()
        expect(warning).to_be_visible()
        dialog.get_by_role("checkbox", name="coding-ci/fixture-a", exact=True).click()
        dialog.get_by_label("TPM limit", exact=True).fill("")
        expect(warning).to_have_count(0)
        expect(dialog.get_by_text("Scope (3 selected)", exact=True)).to_be_visible()
        with page.expect_response(lambda r: r.url.endswith("/api/admin/api-keys")
                                  and r.request.method == "POST") as created:
            dialog.get_by_role("button", name="Create", exact=True).click()
        assert created.value.ok
        key = created.value.json()
        reveal = page.get_by_role("dialog").filter(has_text="API key created")
        expect(reveal.get_by_text(key["secret"], exact=True)).to_be_visible()
        reveal.get_by_role("button", name="I have saved it").click()
        detail = get("/api/admin/api-keys/" + key["id"])["apiKey"]
        assert not detail["allowAllModels"]
        assert {(p["targetKind"], p["targetId"]) for p in detail["permissions"]} == {
            ("model", catalog["codex/fixture-a"]["id"]), ("model", catalog["coding-ci/fixture-a"]["id"]),
            ("combo", combo_id),
        }
        auth = {"Authorization": "Bearer " + key["secret"]}
        assert [m["id"] for m in get("/v1/models", auth)["data"]] == ["codex/fixture-a"]
        for model, status in (("codex/fixture-a", 200), ("codex/fixture-b", 403)):
            response = page.request.post("/v1/chat/completions", headers=auth, data={
                "model": model, "max_tokens": 64, "messages": [{"role": "user", "content": "fixture"}],
            })
            assert response.status == status
            if status == 200:
                assert response.json()["choices"][0]["message"]["content"] == "answer-fixture-a"
        assert ProviderFixture.calls == ["fixture-a"]
        # Missing signed-in credential is rejected locally.
        assert page.request.get("/backend-api/codex/models", headers={"X-API-Key": key["secret"]}).status == 401

        page.goto("/requests")
        row = page.get_by_role("row").filter(has_text="codex/fixture-a")
        row.get_by_role("button", name="View request", exact=False).click()
        expect(page.get_by_role("tab", name="Attempts (1)")).to_be_visible()
        page.goto("/statistics")
        for period, preset in (("Today", "today"), ("30 days", "30d"), ("7 days", "7d")):
            with page.expect_response(lambda r: r.url.endswith("/api/admin/stats?preset=" + preset)) as stats:
                page.get_by_role("tab", name=period, exact=True).click()
            assert stats.value.ok
            expect(page.get_by_role("tab", name=period, exact=True)).to_have_attribute("aria-selected", "true")
            top_models = page.get_by_role("table").filter(has=page.get_by_role("columnheader", name="Req", exact=True))
            expect(top_models.get_by_role("cell", name="codex/fixture-a", exact=True)).to_be_visible()
        browser.close()


def main():
    ProviderFixture.calls.clear()
    ProviderFixture.hold_catalog.clear()
    ProviderFixture.release_catalog.clear()
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), ProviderFixture)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="ldrouter-provider-e2e-") as temp:
            data = Path(temp).resolve()
            with socket.socket() as port_socket:
                port_socket.bind(("127.0.0.1", 0))
                port = port_socket.getsockname()[1]
            base = f"http://127.0.0.1:{port}"
            # Do not inherit application-specific configuration from the developer.
            env = {k: v for k, v in os.environ.items() if not k.startswith("LATEDEV_")}
            env.update({"LATEDEV_HOST": "127.0.0.1", "LATEDEV_PORT": str(port),
                        "LATEDEV_DATA_DIR": str(data), "LATEDEV_DB_URL": str(data / "data.sqlite"),
                        "LATEDEV_MASTER_KEY": "0123456789abcdef0123456789abcdef", "LATEDEV_LOG_LEVEL": "error"})
            with (data / "gateway.log").open("w+") as log:
                proc = subprocess.Popen(["node", "dist/cli.js", "--no-tui"], env=env,
                                        stdout=log, stderr=subprocess.STDOUT)
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
                    print("Provider integration browser smoke passed")
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
    finally:
        ProviderFixture.release_catalog.set()
        upstream.shutdown()
        upstream.server_close()


if __name__ == "__main__":
    main()
