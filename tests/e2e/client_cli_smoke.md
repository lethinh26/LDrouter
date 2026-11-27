# Official CLI mock-upstream smoke

Run only on a disposable, credential-free Linux GitHub-hosted CI runner with Node.js 22, the project's installed dependencies and built server, util-linux (`unshare`, `setpriv`), iproute2 (`ip`), coreutils and passwordless sudo. Do not run on a developer workstation or a shared/self-hosted runner. The namespace isolates networking and process lifetime, not the entire host filesystem. No live credentials should exist on the runner.

From the repository root, after the normal frozen-lockfile dependency install and build, run:

```bash
cli_prefix="$(mktemp -d /tmp/ldrouter-cli-packages.XXXXXXXX)"
trap 'rm -rf -- "$cli_prefix"' EXIT
(cd "$cli_prefix" && npm install --registry=https://registry.npmjs.org --save-exact --no-audit --no-fund @openai/codex@0.172.0 @anthropic-ai/claude-code@2.1.326)
bash tests/e2e/client_cli_smoke.sh "$cli_prefix"
```

Package installation happens before isolation. No CLI execution happens until the launcher creates a network namespace containing only loopback and a fresh PID namespace, drops privilege/capabilities, and checks the kernel state. Failure to create either namespace is a test failure; there is no host-network fallback. The harness requires the real built `dist/server/app.js` and `dist/server/db/index.js`. All fixture state is temporary, and the launcher bounds total runtime and cleans up the process namespace and fixture directory.

Codex uses the supported custom-provider API-key configuration (`env_key`, `env_http_headers`, `model_catalog_url`, HTTP Responses). The fixture derives the catalog shape from the pinned binary's own bundled model metadata, then verifies the actual CLI's alias-scoped catalog and a real native combo turn. Claude Code uses a gateway auth token and a separate synthetic Anthropic provider key, restricted print mode, no tools or MCP servers, and a single Messages turn. Neither client uses an actual account or fabricated login state. Upstream `fetch` is stubbed only in this process before importing the built app, with exact destination/path/method checks; it never delegates to the network. No production endpoint override is introduced.

Assertions cover fixture prompt and credential forwarding, ACL-filtered Codex catalog, final model, native stream completion and actual CLI result, request/attempt rows, daily and monthly quota accounting (including additional Anthropic cache-read input), and no persisted native Codex content or fixture credentials in request/attempt history. A successful run is **mock wire/catalog compatibility evidence**, not live OAuth, real account entitlement, or provider acceptance evidence. CLI output is bounded; failures report classification, exit status and mock call counts without dumping raw client responses or credential-bearing headers.

References: [Codex configuration](https://developers.openai.com/codex/config-reference/), [Codex CLI reference](https://developers.openai.com/codex/cli/reference/), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference), [Claude Code LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway).
