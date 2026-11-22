# Admin UX and Request Sound Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve LateDev Router administration with responsive navigation, actionable dashboard and request workflows, and reliable, distinct sound feedback for completed gateway requests.

**Architecture:** Keep the existing React/Vite admin app, Fastify API, SQLite preferences, SSE request events, and Radix-based shadcn components. Add small reusable UI primitives and a local Web Audio sound service; map request filters to existing server query parameters so the backend route and API contract remain unchanged.

**Tech Stack:** Node.js >= 22, TypeScript strict, pnpm, React 19, Vite, React Router, Fastify, SQLite, Drizzle ORM, Tailwind CSS, shadcn/Radix, Lucide, Vitest.

## Global Constraints

- Runtime: **Node.js >= 22**.
- Language: **TypeScript**, strict mode.
- Package manager during development: **pnpm**.
- HTTP server: **Fastify**; database: **SQLite**, WAL mode; ORM/query layer: **Drizzle ORM** + migrations.
- Web UI: **React + Vite + TypeScript**; UI components: **shadcn/ui + Tailwind CSS + Lucide icons**.
- The runtime deployment must be a single application process by default.
- Preserve streaming end-to-end; security-sensitive values must never be written to logs.
- Do not introduce Redis, PostgreSQL, Kafka, Kubernetes, Next.js, NestJS, or another external cache service.
- Keep `#d2004b` as the primary brand color and preserve light/dark theme behavior.
- Do not change routing, fallback, streaming, business logic, RBAC, database schema, or API contracts.
- Do not add runtime dependencies or external audio assets.
- Do not commit, push, merge, tag, or deploy.

---

### Task 1: Reusable UI primitives and navigation

**Files:**
- Create: `src/web/components/ui/sheet.tsx`
- Create: `src/web/components/command-palette.tsx`
- Modify: `src/web/components/ui/skeleton.tsx`
- Modify: `src/web/components/sidebar.tsx`
- Modify: `src/web/components/top-bar.tsx`
- Modify: `src/web/app/App.tsx`

**Interfaces:**
- `Sheet`, `SheetContent`, `SheetHeader`, `SheetTitle`, and `SheetDescription` wrap the existing Radix Dialog primitives.
- `Skeleton` is a reusable loading placeholder exported from `components/ui/skeleton.tsx`.
- `CommandPalette({ open, onOpenChange })` filters page commands and navigates with React Router.
- `TopBar({ onOpenNavigation })` owns the command-palette shortcut and exposes the mobile navigation trigger.
- `SidebarLinks({ onNavigate })` renders the same route list in the desktop sidebar and mobile Sheet.

- [x] **Step 1: Add the Sheet and Skeleton primitives**

Implement `Sheet` with `@radix-ui/react-dialog`, a portal overlay, a left-side panel, a required `SheetTitle`, and a close control. Export a `Skeleton` component using `cn('animate-pulse rounded-md bg-muted', className)`.

- [x] **Step 2: Extract shared sidebar links**

Export `SidebarLinks({ onNavigate })` from `sidebar.tsx`; render the existing links and icons and invoke `onNavigate` after selecting a link. Keep the desktop sidebar structure and version footer intact.

- [x] **Step 3: Add the command palette**

Create a Dialog with an accessible title, a controlled search input, and a filtered list for Dashboard, Providers, Models, Combos, API Keys, Requests, Statistics, Audit Logs, and Settings. Use `Link` for navigation and close the dialog after selection.

- [x] **Step 4: Wire responsive navigation and shortcut**

In `Shell`, own `mobileNavigationOpen`, render the Sheet using `SidebarLinks`, and pass its opener to `TopBar`. In `TopBar`, open the command palette on Ctrl+K/Cmd+K and display the current route title. Change the main content padding to `p-3 sm:p-4 lg:p-6`.

- [x] **Step 5: Verify navigation behavior**

`pnpm typecheck` and `pnpm lint` pass. Browser/Computer Use and Playwright are not available in this environment, so desktop/mobile visual and keyboard interaction checks remain unverified.

---

### Task 2: Distinct request sound feedback

**Files:**
- Create: `src/web/lib/sound-feedback.ts`
- Create: `tests/unit/request-sound.test.ts`
- Modify: `src/web/lib/request-events.ts`
- Modify: `src/web/components/request-notifications.tsx`
- Modify: `src/web/app/pages/settings.tsx`

**Interfaces:**
- `RequestSoundKind = 'success' | 'http-error' | 'network-error' | 'timeout'`.
- `classifyRequestSound(event): RequestSoundKind | null` returns `null` for client cancellation/disconnect.
- `unlockRequestAudio(): Promise<boolean>` creates/resumes the single AudioContext from a user gesture.
- `playRequestSound(kind): void` plays a short generated tone only after audio is unlocked.
- `previewRequestSound(kind): Promise<boolean>` unlocks and plays a preview from a direct Settings click.

- [x] **Step 1: Test sound classification**

Add Vitest cases asserting: successful 200 → `success`; ordinary 4xx/5xx → `http-error`; `upstream_unavailable` → `network-error`; `timeout_error` → `timeout`; HTTP 499 or a disconnect/cancel error type → `null`.

- [x] **Step 2: Implement the local sound service**

Use one lazily created `AudioContext` and oscillator/gain nodes. Define short, distinct note patterns for the four kinds. Unlock only from pointer/touch/keyboard interaction; preview controls call `unlockRequestAudio()` directly. Do not fetch audio assets or create an AudioContext per event. Throttle tones to avoid overlap.

- [x] **Step 3: Update the SSE notification hook**

Add `httpStatus` to the notification item. Subscribe while `notificationsEnabled || notificationSoundEnabled`; show cards only when the first preference is enabled and play sounds only when the second is enabled. Keep request-ID deduplication and cap the seen-ID set at 2,000 entries. The SSE event is emitted after the final persisted request, so no per-attempt retry sound is added.

- [x] **Step 4: Improve notification cards and Settings**

Render HTTP 499 as a neutral “Cancelled” card with no sound. Keep success and failure styling distinct, add an accessible live region and dismiss labels, and avoid nesting a button inside a link. Add “Test success” and “Test failure” preview buttons. Catch preference-save errors and show a Sonner error toast.

- [x] **Step 5: Verify sound behavior**

Classifier tests, full Vitest suite, typecheck, and lint pass. Backend payload/error types and SSE event timing were checked in source. Actual browser audio playback, autoplay behavior, and physical sound quality could not be verified because no browser/Computer Use runner is available.

---

### Task 3: Request explorer filters and states

**Files:**
- Create: `src/web/lib/request-filters.ts`
- Create: `tests/unit/request-filters.test.ts`
- Modify: `src/web/app/pages/requests.tsx`

**Interfaces:**
- URL filters: `status=all|success|failed|4xx|5xx`, `searchBy=model|id|ip`, `search=<value>`, plus existing `protocol` and `streaming` values.
- Model search maps to `requestedModel`; request ID search maps to `id`; client IP search maps to `ip`.
- Status filters map to existing `success`, `minStatus`, and `maxStatus` query parameters.

- [x] **Step 1: Add reusable request filter helpers**

Create pure URL parsing/serialization, API-query mapping, live-row matching, and current-page sorting helpers with focused Vitest coverage. Use existing card and skeleton primitives for empty/loading presentation rather than adding another UI abstraction.

- [x] **Step 2: Add URL-backed filter state**

Initialize filters from `useSearchParams`, serialize changes back with `{ replace: true }`, and reset pagination on changes. Keep all filtering on the existing `/api/admin/requests` endpoint.

- [x] **Step 3: Add search and status presets**

Add the search-field selector and input, status selector for All/Success/Failed/HTTP 4xx/HTTP 5xx, existing protocol and streaming selectors, and a Clear filters action. Apply the same search/status logic to incoming SSE rows.

- [x] **Step 4: Add explicit loading, error, and empty states**

Search applies on Enter or the Search action to avoid a request per keystroke. Effect cleanup ignores stale fetch results. Render Skeleton rows while loading, an error message with Retry on request failure, distinct empty results for no traffic versus no filter matches, and loading/error/retry feedback in the request detail dialog. Sort is explicitly limited to the loaded page because the backend API remains newest-first.

- [x] **Step 5: Verify filter behavior**

The focused request-filter tests and full suite pass. Direct-link parsing, status ranges, model/IP/ID API mapping, URL serialization, and sorting are covered by unit tests. Browser navigation/visual checks remain unavailable.

---

### Task 4: Dashboard operational states and quick links

**Files:**
- Modify: `src/web/app/pages/dashboard.tsx`
- Reuse: `src/web/components/ui/skeleton.tsx`

- [x] **Step 1: Add explicit dashboard loading and failure state**

Track `loading` and `error` separately from the data object. Render metric and list skeletons while loading. On failure, show an actionable error state and Retry button; do not leave the page on an endless loading message.

- [x] **Step 2: Add actionable failure links**

Link recent failure rows to `/requests?searchBy=id&search=<request-id>` and add a “View failed requests” action to `/requests?status=failed`. Keep existing Add Provider, Create Combo, and Create API Key actions.

- [x] **Step 3: Add dashboard empty states**

When no providers or no request traffic exist, explain the next action and link to the relevant setup or request page.

- [x] **Step 4: Verify dashboard behavior**

Typecheck, lint, and full tests pass; browser rendering and responsive visual states remain unverified because no browser runner is available.

---

### Task 5: Documentation and version metadata

**Files:**
- Modify: `docs/08-ADMIN-UI-UX.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [x] **Step 1: Document the implemented UX**

Update the mobile layout, command palette, dashboard states, request filters, and notification sound behavior in `docs/08-ADMIN-UI-UX.md`.

- [x] **Step 2: Record the release notes and version**

Set `package.json` to `1.22.0` and add a `2026-11-22` Keep a Changelog entry describing the navigation, dashboard, request explorer, and sound feedback changes.

- [x] **Step 3: Run final verification**

`pnpm verify` passes on the current tree (703 passed, 41 skipped across 83 passing and 7 skipped test files). `build:server` passes; `build:web` passes with `--target esnext --minify=false`. The minified/default Vite build was not re-run in this continuation; a previous Windows run hit esbuild temporary-file `Access is denied`. Built-server smoke checks against a fresh temporary data directory returned HTTP 200 for `/health`, `/ready`, `/api/admin/setup/status`, `/`, and the generated JS asset; the server was stopped and temporary data removed. No browser/Playwright runner is available.

---

### Task 6: Final quality review and handoff

- [x] Review backend/API contract, RBAC, database, and request route registration: unchanged; the HIGH-risk `registerRequestRoutes` registration function was not modified.
- [x] Review sound event semantics: the hook consumes only final `request` SSE events; `request_started` and intermediate attempts are ignored; 499/cancel is silent; preferences are loaded before listening; audio context/listeners/timers are cleaned up.
- [x] Review i18n: this repository has no i18n framework or locale catalogs; the existing admin UI is mixed-language (English navigation alongside Vietnamese legacy labels), so new feature copy follows the English navigation convention. Full localization remains outside this scope.
- [x] Review repository state: all work remains uncommitted on `feat/admin-ux-sound-20261122`; no push, merge, tag, production data change, or deployment was performed.

## Post-review regression closure

- [x] Make the SSE overflow integration deterministic: pause after the first 100-row replay page, emit 101 persisted live completions, assert the original stream closes after exactly 100 replay frames, verify listener cleanup, then recover all 5,101 rows in cursor order without duplicates or omissions.
- [x] Queue at most four request sounds only during an explicit pending user-gesture unlock; retain the newest outcomes, clear on failed unlock/disposal/replacement, and preserve the 450 ms live throttle.
- [x] Assert the actual oscillator frequency sequence for the four retained outcomes, not only the total number of generated nodes.
- [x] Defer AudioContext disposal until a sound-disable PATCH succeeds. Failed disable rolls the preference back without disposing the existing context; failed enable disposes the context created by that gesture.
- [x] Keep manual preview independent of the live throttle and wait until queued live tones finish before playing.
- [x] Re-review command palette/mobile focus with worker-2: no remaining confirmed focus-restoration finding. Worker-1 confirmed the two audio races above and found no rapid-toggle/stale-resume corruption in the Settings flow.
