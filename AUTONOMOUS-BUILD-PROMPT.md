# Prompt to Start the Autonomous Build

Use the following instruction when handing this repository/spec pack to the coding agent:

---

Build **LateDev Router** completely and autonomously.

Start by reading `AGENTS.md`, then read every numbered Markdown document under `docs/` in ascending order. Treat those files as the authoritative product and engineering specification.

Mandatory workflow:

1. Use the **Superpowers** skill to create your implementation plan and use its debugging/testing workflows throughout the build.
2. Use **GitNexus** before non-trivial code changes to understand the repository graph and affected modules; refresh its understanding after major structural changes when needed.
3. Use **shadcn/ui** and Lucide icons for the administration interface. Follow the specified LateDev Router design system with primary color `#d2004b`.
4. Implement the real product, not a mockup. Continue through backend, frontend, database migrations, security, compatibility APIs, routing, logging, statistics, caching, backup/restore, tests, npm packaging, Dockerfile, and Docker Compose.
5. Do not ask for developer intervention for decisions already covered by the specification. For small unspecified details, choose the simplest secure production-sensible option and document it.
6. If real upstream credentials are unavailable, use mock upstream servers for automated tests, but implement the real OpenAI-compatible and Anthropic-compatible network paths.
7. Keep iterating until the acceptance criteria in `docs/10-TESTING-AND-ACCEPTANCE.md` pass. Do not stop at scaffolding or leave required TODOs.
8. Do not add monetary cost tracking or multi-user/RBAC features.
9. Before declaring completion, run the complete lint, typecheck, test, build, npm-pack, Docker-build, and Docker-Compose verification described in the spec.
10. At the end, provide the completion report required by the acceptance document, including exact run commands and any unavoidable limitations.

Begin now and work continuously until LateDev Router satisfies the specification.

---
