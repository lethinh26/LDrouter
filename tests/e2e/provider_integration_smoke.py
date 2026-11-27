"""CI browser regression for provider identity, discovery, config and key ACLs.

Run after pnpm build: python tests/e2e/provider_integration_smoke.py
The fixture uses a fresh SQLite database, loopback upstream and synthetic keys.
No signed-in client or external provider endpoint is contacted.
"""

import base64
import hashlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit
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
        page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
        page.set_default_timeout(15000)

        def get(path, headers=None):
            response = page.request.get(path, headers=headers)
            assert response.ok, f"GET {path}: {response.status}"
            return response.json()

        def admin_request(method, path, data):
            csrf = get("/api/admin/csrf")["csrfToken"]
            return page.request.fetch(path, method=method, data=data, headers={"x-csrf-token": csrf})

        def admin_post(path, data):
            response = admin_request("POST", path, data)
            assert response.ok, f"POST {path}: {response.status}"
            return response.json()

        def providers():
            return {row["name"]: row for row in get("/api/admin/providers")["providers"]}

        def models():
            return {row["publicModelId"]: row for row in get("/api/admin/models")["models"]}

        def builtins():
            return {row["kind"]: row for row in get("/api/admin/builtin-providers")["providers"]}

        def connection(kind, connection_id):
            return next(c for c in builtins()[kind]["connections"] if c["id"] == connection_id)

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
        builtin = page.get_by_role("region", name="Built-in Providers")
        custom = page.get_by_role("region", name="Custom Providers")
        expect(builtin.get_by_role("button", name="Manage Codex", exact=True)).to_be_enabled()
        expect(builtin.get_by_role("button", name="Manage Claude Code", exact=True)).to_be_enabled()
        expect(builtin.get_by_text("cx/", exact=True)).to_be_visible()
        expect(builtin.get_by_text("cc/", exact=True)).to_be_visible()
        expect(custom.get_by_text("No custom providers yet.")).to_be_visible()
        fresh = builtins()
        assert set(fresh) == {"codex", "claude_code"}
        for kind, name, slug, mode in (("codex", "Codex", "cx", "client_oauth"),
                                       ("claude_code", "Claude Code", "cc", "api_key")):
            entry = fresh[kind]
            assert (entry["name"], entry["slug"], entry["authMode"]) == (name, slug, mode)
            assert entry["namespaceAvailable"] and not entry["conflicts"] and not entry["connections"]
        assert not providers() and not models()

        # Exercise real browser creation on a fresh database. Codex profiles
        # are not stored accounts: no token/key/base URL/custom-header fields.
        def add_connection(kind, name, api_key=None):
            codex = kind == "codex"
            builtin.get_by_role("button", name="Add profile" if codex else "Add connection", exact=True).click()
            dialog = page.get_by_role("dialog", name="Create Codex profile" if codex else "Add Claude Code connection")
            dialog.get_by_label("Name", exact=True).fill(name)
            expect(dialog.get_by_label("Base URL", exact=True)).to_have_count(0)
            expect(dialog.get_by_label("Custom headers (JSON)")).to_have_count(0)
            create = dialog.get_by_role("button", name="Create", exact=True)
            if codex:
                expect(dialog.locator("input[type=password]")).to_have_count(0)
                expect(dialog.get_by_label("Anthropic API key", exact=True)).to_have_count(0)
            else:
                key_input = dialog.get_by_label("Anthropic API key", exact=True)
                expect(key_input).to_have_attribute("type", "password")
                key_input.fill("sk-ant-oat-fixture-not-supported")
                expect(create).to_be_disabled()
                key_input.fill(api_key)
            with page.expect_response(lambda r: r.url.endswith(f"/api/admin/builtin-providers/{kind}/connections")
                                      and r.request.method == "POST") as created:
                create.click()
            assert created.value.ok
            result = created.value.json()
            assert result["slug"] == ("cx" if codex else "cc")
            expect(dialog).not_to_be_visible()
            expect(builtin.get_by_label("Connection name", exact=True)).to_have_value(name)
            expect(builtin.get_by_role("button", name="Disable connection", exact=True)).to_be_enabled()
            current = connection(kind, result["id"])
            assert current["namespaceMode"] == "canonical" and current["slug"] == result["slug"]
            assert current["enabled"] and current["modelCount"] == 0
            assert current["usage"] == {"requests": 0, "totalTokens": 0}
            assert providers()[name]["id"] == result["id"]
            assert providers()[name]["baseUrl"] == ("https://chatgpt.com" if codex else "https://api.anthropic.com")
            return result["id"]

        def manage_connection(name):
            builtin.get_by_role("button", name=f"Manage connection {name}", exact=True).click()
            expect(builtin.get_by_label("Connection name", exact=True)).to_have_value(name)

        def rename_connection(kind, connection_id, name):
            builtin.get_by_label("Connection name", exact=True).fill(name)
            builtin.get_by_role("button", name="Save name", exact=True).click()
            expect(builtin.get_by_role("button", name="Save name", exact=True)).to_be_disabled()
            expect(builtin.get_by_text(name, exact=True).first).to_be_visible()
            assert connection(kind, connection_id)["name"] == name

        def disable_connection(kind, connection_id):
            builtin.get_by_role("button", name="Disable connection", exact=True).click()
            alert = page.get_by_role("alertdialog", name="Disable connection?")
            expect(alert).to_be_visible()
            alert.get_by_role("button", name="Disable", exact=True).click()
            expect(alert).not_to_be_visible()
            expect(builtin.get_by_role("button", name="Enable connection", exact=True)).to_be_enabled()
            expect(builtin.get_by_text("Connection status", exact=True).locator("..").get_by_text("Disabled", exact=True)).to_be_visible()
            expect(builtin.get_by_role("button", name="Test connection", exact=True)).to_be_disabled()
            assert not connection(kind, connection_id)["enabled"]

        def enable_connection(kind, connection_id):
            builtin.get_by_role("button", name="Enable connection", exact=True).click()
            expect(builtin.get_by_role("button", name="Disable connection", exact=True)).to_be_enabled()
            assert connection(kind, connection_id)["enabled"]

        def check_config(kind, prefix, copy=False):
            config = builtin.locator('pre[aria-label="API key client configuration"]')
            if kind == "codex":
                expect(config).to_contain_text(f'model = "{prefix}/YOUR_IMPORTED_MODEL"')
                expect(config).to_contain_text(base + "/backend-api/codex")
                expect(config).to_contain_text(base + "/backend-api/codex/models")
                expect(config).to_contain_text('env_http_headers = { "X-API-Key" = "LATEDEV_API_KEY" }')
                oauth_config = builtin.locator('pre[aria-label="Gateway OAuth client configuration"]')
                expect(oauth_config).to_contain_text(f'model = "{prefix}/YOUR_IMPORTED_MODEL"')
                expect(oauth_config).to_contain_text(f'authorization_url = "{base}/oauth/authorize"')
                expect(oauth_config).to_contain_text(f'token_url = "{base}/api/oauth/token"')
                expect(oauth_config).to_contain_text('client_id = "ldrouter-codex"')
                expect(oauth_config).not_to_contain_text('env_http_headers')
            else:
                expect(config).to_contain_text("ANTHROPIC_BASE_URL=" + base)
                expect(config).to_contain_text(f"ANTHROPIC_MODEL={prefix}/YOUR_IMPORTED_MODEL")
                expect(config).to_contain_text("ANTHROPIC_AUTH_TOKEN=YOUR_GATEWAY_API_KEY")
            if copy:
                builtin.get_by_role("button", name="Copy configuration", exact=True).click()
                expect(page.get_by_text("Configuration copied", exact=True).last).to_be_visible()
                page.wait_for_function("async expected => await navigator.clipboard.readText() === expected",
                                       arg=config.inner_text())

        builtin.get_by_role("button", name="Manage Codex", exact=True).click()
        expect(builtin.get_by_text("No profile configured.", exact=True)).to_be_visible()
        canonical_codex_id = add_connection("codex", "Canonical Codex fixture")
        expect(builtin.get_by_role("button", name="Test connection", exact=True)).to_be_disabled()
        expect(builtin.get_by_text("Client account unverified", exact=True)).to_be_visible()
        check_config("codex", "cx", copy=True)
        canonical_codex_name = "Canonical Codex renamed"
        rename_connection("codex", canonical_codex_id, canonical_codex_name)
        disable_connection("codex", canonical_codex_id)
        builtin.get_by_role("button", name="Back to Codex", exact=True).click()
        expect(builtin.get_by_role("button", name="Add profile", exact=True)).to_be_disabled()
        manage_connection(canonical_codex_name)
        enable_connection("codex", canonical_codex_id)
        check_config("codex", "cx")
        assert admin_request("POST", "/api/admin/builtin-providers/codex/connections", {"name": "Duplicate canonical profile"}).status == 409
        assert admin_request("PATCH", "/api/admin/providers", {"id": canonical_codex_id, "slug": "changed-cx"}).status == 409
        builtin.get_by_role("button", name="Back to Codex", exact=True).click()
        builtin.get_by_role("button", name="All built-in providers", exact=True).click()

        builtin.get_by_role("button", name="Manage Claude Code", exact=True).click()
        expect(builtin.get_by_text("No connections configured.", exact=True)).to_be_visible()
        claude_key_a, claude_key_b = "sk-ant-api-ci-first-fixture", "sk-ant-api-ci-second-fixture"
        canonical_claude_a = add_connection("claude_code", "Canonical Claude first", claude_key_a)
        check_config("claude_code", "cc", copy=True)
        expect(builtin.locator("input[type=password]")).to_have_count(0)
        builtin.get_by_role("button", name="Back to Claude Code", exact=True).click()
        canonical_claude_b = add_connection("claude_code", "Canonical Claude second", claude_key_b)
        assert canonical_claude_a != canonical_claude_b
        check_config("claude_code", "cc")
        disable_connection("claude_code", canonical_claude_b)
        assert connection("claude_code", canonical_claude_a)["enabled"]
        enable_connection("claude_code", canonical_claude_b)
        assert len(builtins()["claude_code"]["connections"]) == 2
        for key_value in (claude_key_a, claude_key_b):
            assert key_value not in json.dumps(builtins()) and key_value not in json.dumps(providers())
            assert key_value not in builtin.inner_text()
        # These synthetic keys are intentionally never used for discovery or
        # Test connection. All network-backed generation remains loopback.
        builtin.get_by_role("button", name="Back to Claude Code", exact=True).click()
        builtin.get_by_role("button", name="All built-in providers", exact=True).click()
        expect(custom.get_by_text("No custom providers yet.")).to_be_visible()

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

        # Keep the old namespace collision/rename coverage using the legacy
        # creation API; the custom provider form no longer creates native kinds.
        legacy_codex = {"name": "Native Codex fixture", "slug": " CODEX ",
                        "type": "openai", "providerKind": "codex"}
        conflict = admin_request("POST", "/api/admin/providers", legacy_codex)
        assert conflict.status == 409
        assert "Try 'codex-oauth'" in conflict.json()["error"]["message"]
        assert "Native Codex fixture" not in providers()
        legacy_codex["slug"] = "codex-oauth"
        legacy = admin_post("/api/admin/providers", legacy_codex)
        native = providers()["Native Codex fixture"]
        assert native["providerKind"] == "codex" and native["authMode"] == "client_oauth"
        assert native["id"] == legacy["id"] and native["baseUrl"] == "https://chatgpt.com"
        assert providers()["Compatible fixture"]["id"] == compatible_id
        assert connection("codex", native["id"])["namespaceMode"] == "legacy"
        for forbidden in ({"providerKind": "compatible"}, {"apiKey": "fixture-not-stored"},
                          {"baseUrl": upstream}, {"customHeaders": {"X-Fixture": "invalid"}}):
            assert admin_request("PATCH", "/api/admin/providers", {"id": native["id"], **forbidden}).status == 400
        assert admin_request("PATCH", "/api/admin/providers", {"id": native["id"], "slug": "coding-ci"}).ok
        assert providers()["Native Codex fixture"]["id"] == native["id"]
        assert providers()["Native Codex fixture"]["slug"] == "coding-ci"

        # Retain a legacy Claude Code config without calling its fixed origin.
        admin_post("/api/admin/providers", {"name": "Claude Code fixture", "slug": "claude-ci",
                   "type": "anthropic", "providerKind": "claude_code", "apiKey": "sk-ant-api-fixture-only"})
        claude = providers()["Claude Code fixture"]
        assert claude["providerKind"] == "claude_code" and claude["authMode"] == "api_key"
        assert claude["baseUrl"] == "https://api.anthropic.com"
        assert connection("claude_code", claude["id"])["namespaceMode"] == "legacy"
        for forbidden in ({"baseUrl": upstream}, {"customHeaders": {"X-Fixture": "invalid"}},
                          {"apiKey": "sk-ant-oat-fixture-not-supported"}):
            assert admin_request("PATCH", "/api/admin/providers", {"id": claude["id"], **forbidden}).status == 400
        page.goto("/providers")
        expect(custom.get_by_role("row").filter(has_text="Native Codex fixture")).to_have_count(0)
        expect(custom.get_by_role("row").filter(has_text="Claude Code fixture")).to_have_count(0)
        builtin.get_by_role("button", name="Manage Codex", exact=True).click()
        manage_connection("Native Codex fixture")
        expect(builtin.get_by_text("Legacy", exact=True)).to_be_visible()
        expect(builtin.get_by_title("Test from signed-in Codex client")).to_be_disabled()
        expect(builtin.locator("input[type=password]")).to_have_count(0)
        check_config("codex", "coding-ci")
        builtin.get_by_role("button", name="Back to Codex", exact=True).click()
        builtin.get_by_role("button", name="All built-in providers", exact=True).click()
        builtin.get_by_role("button", name="Manage Claude Code", exact=True).click()
        manage_connection("Claude Code fixture")
        expect(builtin.get_by_text("Legacy", exact=True)).to_be_visible()
        expect(builtin.locator("input[type=password]")).to_have_count(0)
        check_config("claude_code", "claude-ci")
        assert "fixture-compatible-key" not in json.dumps(providers())
        assert "sk-ant-api-fixture-only" not in json.dumps(providers())
        assert "sk-ant-api-fixture-only" not in json.dumps(builtins())

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

        # Canonical imports use cx/, not a user-supplied or legacy slug.
        # Exercise the actual per-connection importer before checking the
        # same models on the global Models page.
        page.goto("/providers")
        dialog = open_edit("Compatible fixture")
        expect(dialog.get_by_label("Slug", exact=True)).to_be_disabled()
        dialog.get_by_role("button", name="Cancel", exact=True).click()
        locked = admin_request("PATCH", "/api/admin/providers", {"id": native["id"], "slug": "coding-ci-renamed"})
        assert locked.status == 409 and locked.json()["error"]["code"] == "provider_slug_locked"
        builtin.get_by_role("button", name="Manage Codex", exact=True).click()
        manage_connection(canonical_codex_name)
        check_config("codex", "cx")
        builtin.get_by_label("Codex upstream model IDs").fill("fixture-a, fixture-a\nfixture-b")
        with page.expect_response(lambda r: r.url.endswith("/api/admin/models/import") and r.request.method == "POST") as imported:
            builtin.get_by_role("button", name="Import models (2)", exact=True).click()
        assert imported.value.ok
        expect(builtin.get_by_text("cx/fixture-a", exact=True)).to_be_visible()
        expect(builtin.get_by_text("cx/fixture-b", exact=True)).to_be_visible()
        canonical_catalog = models()
        assert set(canonical_catalog) == set(catalog) | {"cx/fixture-a", "cx/fixture-b"}
        assert canonical_catalog["cx/fixture-a"]["providerId"] == canonical_codex_id
        assert canonical_catalog["cx/fixture-a"]["providerKind"] == "codex"
        assert canonical_catalog["cx/fixture-a"]["providerSlug"] == "cx"
        assert canonical_catalog["cx/fixture-a"]["id"] not in {
            catalog["codex/fixture-a"]["id"], catalog["coding-ci/fixture-a"]["id"],
        }
        builtin.get_by_role("link", name="Manage models", exact=True).click()
        expect(page).to_have_url(base + "/models")
        page.get_by_role("button", name="Expand all").click()
        canonical_row = page.get_by_role("row").filter(has_text="cx/fixture-a")
        expect(canonical_row.get_by_role("button", name="Test", exact=True)).to_be_disabled()
        expect(canonical_row.get_by_text("Account unverified", exact=True)).to_be_visible()
        page.goto("/providers")
        builtin.get_by_role("button", name="Manage Codex", exact=True).click()
        manage_connection(canonical_codex_name)
        assert connection("codex", canonical_codex_id)["modelCount"] == 2
        disable_connection("codex", canonical_codex_id)
        disabled_catalog = models()
        assert disabled_catalog["cx/fixture-a"]["id"] == canonical_catalog["cx/fixture-a"]["id"]
        assert not disabled_catalog["cx/fixture-a"]["providerEnabled"]
        assert disabled_catalog["coding-ci/fixture-a"]["providerEnabled"]
        enable_connection("codex", canonical_codex_id)
        assert models()["cx/fixture-a"]["providerEnabled"]
        assert models()["cx/fixture-a"]["id"] == canonical_catalog["cx/fixture-a"]["id"]

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
        expect(dialog.get_by_role("button", name="Add cx/fixture-a", exact=True)).to_have_count(0)
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
        expect(dialog.get_by_role("button", name="Add cx/fixture-a", exact=True)).to_have_count(0)
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
        navigation = page.goto("/api-keys")
        assert navigation is not None and navigation.ok
        assert "text/html" in navigation.headers.get("content-type", "")
        for path in ("/api/missing-fixture", "/v1/missing-fixture", "/backend-api/codex/missing-fixture"):
            missing = page.request.get(path)
            assert missing.status == 404 and "application/json" in missing.headers.get("content-type", "")
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
            # Verify the actual snapshot before locating the rendered row. The
            # model label is publicId, not the provider name or bare upstream ID.
            # This distinguishes missing server data from a DOM locator failure.
            snapshot = stats.value.json()
            expected = next((m for m in snapshot["topModels"] if m["publicId"] == "codex/fixture-a"), None)
            assert expected is not None, f"{preset}: missing fixture in topModels: {snapshot['topModels']}"
            assert expected["requests"] == 1 and expected["totalTokens"] == 6 and expected["errorRate"] == 0
            expect(page.get_by_role("tab", name=period, exact=True)).to_have_attribute("aria-selected", "true")
            # Anchor the table to its real card heading, not an inferred ARIA
            # role on a scope-less <th>. Keep exact visible label and totals.
            heading = page.get_by_role("heading", name="Top Models", exact=True)
            expect(heading).to_be_visible()
            top_models = heading.locator("xpath=../..").locator("table")
            expect(top_models).to_have_count(1)
            row = top_models.locator("tbody tr").filter(has=page.get_by_text(expected["publicId"], exact=True))
            expect(row).to_have_count(1)
            expect(row.locator("td")).to_have_text(["codex/fixture-a", "1", "0.0%", "6"])
            expect(row.locator("td").first).to_be_visible()

        # Exercise LDrouter's own gateway OAuth consent and revocation with the
        # already-created scoped fixture key. No upstream account is involved.
        redirect_uri = "http://127.0.0.1:43127/callback"
        verifier = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
        state = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
        authorize_path = "/api/admin/gateway-oauth/authorize"
        grants_path = "/api/admin/gateway-oauth/grants"
        prior_grant_ids = {grant["id"] for grant in get(grants_path)["grants"]}
        callback_pattern = re.compile(r"^http://127\.0\.0\.1:43127/callback\?[^#]*$")
        intercepted = []
        authorized_urls = []

        def capture_authorize(route):
            response = route.fetch()
            assert response.ok, f"Gateway authorization: {response.status}"
            authorized_urls.append(response.json()["redirectUrl"])
            # Capture the real server response before the callback navigation
            # can evict the browser's Network.getResponseBody resource.
            route.fulfill(response=response)

        def intercept_callback(route):
            assert route.request.method == "GET" and route.request.is_navigation_request()
            intercepted.append(route.request.url)
            # Fulfill locally: never contact a callback listener or echo the code.
            route.fulfill(status=200, content_type="text/plain", body="Fixture callback received")

        page.route(callback_pattern, intercept_callback)
        page.route(base + authorize_path, capture_authorize)
        try:
            navigation = page.goto("/oauth/authorize?" + urlencode({
                "client_id": "ldrouter-codex", "response_type": "code",
                "redirect_uri": redirect_uri, "code_challenge_method": "S256",
                "code_challenge": challenge, "state": state,
            }))
            assert navigation is not None and navigation.ok
            expect(page.get_by_text("Authorize Codex gateway access", exact=True)).to_be_visible()
            approve = page.get_by_role("button", name="Authorize gateway access", exact=True)
            selection = page.get_by_role("radio", name=re.compile(r"^Provider scoped fixture"))
            expect(selection).to_be_enabled()
            expect(selection).not_to_be_checked()
            expect(approve).to_be_disabled()
            assert {grant["id"] for grant in get(grants_path)["grants"]} == prior_grant_ids
            selection.check()
            expect(approve).to_be_enabled()
            approve.click()
            page.wait_for_url(callback_pattern, wait_until="domcontentloaded")
            assert len(intercepted) == 1
            assert authorized_urls == intercepted
            parsed = urlsplit(intercepted[0])
            assert (parsed.scheme, parsed.netloc, parsed.path, parsed.fragment) == (
                "http", "127.0.0.1:43127", "/callback", "",
            )
            params = parse_qs(parsed.query, strict_parsing=True, keep_blank_values=True)
            assert set(params) == {"code", "state"} and params["state"] == [state]
            assert len(params["code"]) == 1 and re.fullmatch(r"ldo-c-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]", params["code"][0])
            expect(page.get_by_text("Fixture callback received", exact=True)).to_be_visible()
        finally:
            page.unroute(callback_pattern, intercept_callback)
            page.unroute(base + authorize_path, capture_authorize)

        # Use an independent unauthenticated HTTP context for the public token
        # endpoint, not the browser's admin session or a mocked token response.
        public_client = p.request.new_context(base_url=base, timeout=15000)
        try:
            token = public_client.post("/api/oauth/token", form={
                "grant_type": "authorization_code", "client_id": "ldrouter-codex",
                "redirect_uri": redirect_uri, "code": params["code"][0],
                "code_verifier": verifier,
            })
            assert token.ok, f"Gateway token exchange: {token.status}"
            tokens = token.json()
            assert tokens["token_type"] == "Bearer" and 0 < tokens["expires_in"] <= 900
            assert re.fullmatch(r"ldo-a-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]", tokens["access_token"])
            assert re.fullmatch(r"ldo-r-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]", tokens["refresh_token"])
            grants = [grant for grant in get(grants_path)["grants"] if grant["id"] not in prior_grant_ids]
            assert len(grants) == 1
            grant = grants[0]
            assert set(grant) == {
                "id", "apiKeyId", "apiKeyName", "createdAt", "accessExpiresAt",
                "refreshExpiresAt", "absoluteExpiresAt", "lastRefreshedAt", "status",
            }
            assert grant["apiKeyId"] == key["id"] and grant["apiKeyName"] == "Provider scoped fixture"
            assert grant["status"] == "active" and grant["lastRefreshedAt"] is None
            assert grant["createdAt"] < grant["accessExpiresAt"] < grant["refreshExpiresAt"] < grant["absoluteExpiresAt"]
            page.goto("/providers")
            grant_card = page.locator('[aria-label="Gateway OAuth grants"]')
            grant_row = grant_card.get_by_role("row").filter(has_text=grant["id"])
            expect(grant_row.get_by_text("active", exact=True)).to_be_visible()
            expect(grant_row.get_by_text("Provider scoped fixture", exact=True)).to_be_visible()
            revoke = grant_row.get_by_role("button", name="Revoke grant " + grant["id"], exact=True)
            revoke.click()
            confirmation = page.get_by_role("alertdialog", name="Revoke gateway OAuth grant?")
            expect(confirmation).to_be_visible()
            with page.expect_response(lambda r: r.url == base + grants_path + "/" + grant["id"]
                                      and r.request.method == "DELETE") as revoked:
                confirmation.get_by_role("button", name="Revoke grant", exact=True).click()
            assert revoked.value.ok, f"Gateway grant revoke: {revoked.value.status}"
            expect(grant_row.get_by_text("revoked", exact=True)).to_be_visible()
            expect(revoke).to_be_disabled()
            assert next(g for g in get(grants_path)["grants"] if g["id"] == grant["id"])["status"] == "revoked"
            refresh = public_client.post("/api/oauth/token", form={
                "grant_type": "refresh_token", "client_id": "ldrouter-codex",
                "refresh_token": tokens["refresh_token"],
            })
            assert refresh.status == 400 and refresh.json() == {"error": "invalid_grant"}
            assert get("/api/admin/api-keys/" + key["id"])["apiKey"]["enabled"]
            assert ProviderFixture.calls == ["fixture-a"]
        finally:
            public_client.dispose()
        quota_card = page.locator('[aria-label="Subscription quotas"]')
        expect(quota_card.get_by_text("No quota accounts yet.", exact=True)).to_be_visible()
        for provider_kind, account_name in [("codex", "Codex quota fixture"), ("claude_code", "Claude quota fixture")]:
            quota_card.get_by_role("button", name="Add quota account", exact=True).click()
            dialog = page.get_by_role("dialog", name="Add quota account")
            dialog.get_by_label("Provider", exact=True).select_option(provider_kind)
            dialog.get_by_label("Account name", exact=True).fill(account_name)
            dialog.get_by_role("button", name="Save quota record", exact=True).click()
            expect(dialog).not_to_be_visible()
            expect(quota_card.get_by_role("region", name="Quota account " + account_name)).to_be_visible()
        codex_quota = quota_card.get_by_role("region", name="Quota account Codex quota fixture")
        claude_quota = quota_card.get_by_role("region", name="Quota account Claude quota fixture")
        codex_quota.get_by_role("button", name="Update observation", exact=True).click()
        dialog = page.get_by_role("dialog", name="Update quota observation")
        dialog.get_by_label("Observation source").select_option("codex_app_server")
        dialog.get_by_label("Codex rate-limit result JSON").fill(json.dumps({
            "rateLimits": {"limitId": "codex", "planType": "plus", "primary": {
                "usedPercent": 41, "windowDurationMins": 300,
                "resetsAt": int(time.time()) + 3600,
            }},
            "accountId": "quota-fixture-account",
        }))
        dialog.get_by_role("button", name="Save quota record", exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(codex_quota.get_by_text("41% used · 59% remaining", exact=True)).to_be_visible()
        expect(claude_quota.get_by_text("Usage and reset times are unknown.", exact=True)).to_be_visible()
        claude_quota.get_by_role("button", name="Update observation", exact=True).click()
        dialog = page.get_by_role("dialog", name="Update quota observation")
        dialog.get_by_label("Window label", exact=True).fill("Weekly")
        dialog.get_by_label("Used %", exact=True).fill("75")
        dialog.get_by_role("button", name="Save quota record", exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(claude_quota.get_by_text("75% used · 25% remaining", exact=True)).to_be_visible()
        expect(codex_quota.get_by_text("41% used · 59% remaining", exact=True)).to_be_visible()
        assert len(get("/api/admin/subscription-quotas")["accounts"]) == 2
        codex_record = next(a for a in get("/api/admin/subscription-quotas")["accounts"] if a["providerKind"] == "codex")
        expect(claude_quota.get_by_role("button", name="Set up sync", exact=True)).to_have_count(0)
        codex_quota.get_by_role("button", name="Set up sync", exact=True).click()
        dialog = page.get_by_role("dialog", name="Pair local Codex quota sync")
        dialog.get_by_role("button", name="Generate sync token", exact=True).click()
        token_input = dialog.get_by_label("Pairing token", exact=True)
        expect(token_input).to_have_attribute("type", "password")
        expect(token_input).to_have_value(re.compile(r"^ldq-[A-Za-z0-9_-]{43}$"))
        sync_token = token_input.input_value()
        expect(dialog.get_by_text("ldrouter-quota-sync --gateway " + base + " --account " + codex_record["id"] + " --interval 300", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Done", exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(codex_quota.get_by_text("Paired", exact=True)).to_be_visible()
        sync_payload = {"observedAt": datetime.now(timezone.utc).isoformat(),
                        "accountFingerprint": hashlib.sha256(b"quota-fixture-account").hexdigest(),
                        "result": {"rateLimits": {"limitId": "codex", "primary": {"usedPercent": 64}}}}
        quota_client = p.request.new_context(base_url=base, timeout=15000)
        try:
            sync_path = "/api/quota-sync/" + codex_record["id"]
            sync_headers = {"Authorization": "Bearer " + sync_token}
            response = quota_client.post(sync_path, headers=sync_headers, data=sync_payload)
            assert response.ok, f"Quota client upload: {response.status}"
            quota_card.get_by_role("button", name="Refresh records", exact=True).click()
            expect(codex_quota.get_by_text("64% used · 36% remaining", exact=True)).to_be_visible()
            expect(codex_quota.get_by_text("Synced from local Codex client", exact=False)).to_be_visible()
            codex_quota.get_by_role("button", name="Revoke sync", exact=True).click()
            expect(codex_quota.get_by_text("Not paired", exact=True)).to_be_visible()
            assert quota_client.post(sync_path, headers=sync_headers, data=sync_payload).status == 401
            expect(claude_quota.get_by_text("75% used · 25% remaining", exact=True)).to_be_visible()
        finally:
            quota_client.dispose()
        assert ProviderFixture.calls == ["fixture-a"]
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
