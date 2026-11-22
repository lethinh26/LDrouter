# Admin UX and Request Sound Feedback Design

## Goal

Improve the daily administration experience in LateDev Router with clearer navigation, more actionable request operations, reliable page states, and distinct request completion sounds.

## Current state

- The desktop sidebar is hidden below the medium breakpoint and there is no mobile navigation drawer.
- The top bar has no global navigation search or keyboard command entry point.
- The dashboard treats a failed initial load like an unfinished load and can remain on its loading message indefinitely.
- The Requests page supports server-side filtering by model, success, protocol, and streaming, but its filters are not deep-linkable and it does not distinguish loading, failure, and no-match states.
- Request notifications already use the final persisted request event over SSE. Preferences for visible notifications and sound are already stored in SQLite. The browser currently plays one MP3 for every outcome and does not explicitly unlock audio after a user gesture.
- A downstream client disconnect is recorded with HTTP 499. The gateway emits one request-logged event after the final request is persisted, so upstream retry attempts do not produce separate notification events.

## Design

### 1. Navigation and responsive shell

- Keep the existing desktop sidebar.
- On narrow screens, expose a left-side shadcn Sheet containing the same navigation links. Close it after navigation and retain visible focus states.
- Add a searchable command dialog opened by Ctrl+K / Cmd+K and by a top-bar search button. It searches the existing page destinations and navigates on selection.
- Show the current page in the top bar and reduce main-content padding on small screens.
- Reuse the existing Radix-based shadcn wrappers. Add only the missing Sheet primitive; do not introduce another component system or dependency.

### 2. Request sound feedback

- Keep the existing SSE request-completion stream and the two persisted preferences.
- Generate short tones locally with the Web Audio API. No external audio URL or new sound package is required.
- Classify final request outcomes as `success`, `http-error`, `network-error`, or `timeout`. Suppress sound for client disconnect/cancellation (HTTP 499).
- Unlock one AudioContext after the first pointer, touch, or keyboard interaction. If the browser does not permit audio, keep all visual notifications working.
- Keep request cards and sound independently configurable: subscribe while either preference is enabled, show cards only when visible notifications are enabled, and play tones only when sound is enabled.
- Deduplicate request IDs, bound the in-memory seen-ID set, and throttle closely spaced tones to prevent overlapping noise. The event stream remains the source of final request outcomes; polling, prefetch, and intermediate provider attempts do not enter the sound path.
- Add explicit success and failure preview controls in Settings. A preview is a direct user gesture and remains available even when live sound is disabled.
- Render cancelled requests as neutral “Cancelled” notifications without a tone.

Sound lifecycle and replay reliability refinements:

- If a final request arrives while an explicit gesture-driven resume is pending, queue at most four outcomes (retaining the newest) and flush only after that same context resumes successfully. Do not queue before a user gesture; clear the queue on failed unlock, disposal, or context replacement. Apply the 450 ms live throttle while queueing and draining.
- A preview waits until queued live tones have drained, but does not consume the live notification throttle. A sound-disable preference update remains optimistic; dispose the AudioContext only after its PATCH succeeds so rollback preserves the unlocked context. Failed opt-in must dispose the context it created.
- Deterministically pause the SSE replay after its first page, emit 101 live completions against the 100-event test queue, assert the original stream closes after that page, verify listener cleanup, and recover all 5,101 persisted rows by reconnect cursor without duplicates or omissions.

### 3. Request explorer

- Add one search field with a field selector for model, request ID, or client IP. Map each mode to the existing `requestedModel`, `id`, or `ip` query parameter.
- Add status presets: All, Success, Failed, HTTP 4xx, and HTTP 5xx. Map them to the existing `success`, `minStatus`, and `maxStatus` filters.
- Keep protocol and streaming filters, reset pagination on filter changes, and mirror active filters into URL query parameters so dashboard links can open a pre-filtered request list.
- Add clear-filter behavior and distinct loading, request-error/retry, no-requests, and no-matches states. Handle detail-dialog loading and errors explicitly.
- Support alternate sorting only within the loaded page because the current backend contract always sorts pages newest-first. Apply search on Enter or an explicit Search action rather than issuing one request per keystroke.
- Do not change the admin request endpoint or its API contract. GitNexus reports HIGH impact for `registerRequestRoutes` because it participates in admin registration, application startup, and Auth/Logging flows; all request filtering will use the existing query parameters.

### 4. Dashboard operational states

- Preserve the existing metrics and health information.
- Add skeleton loading placeholders, a recoverable error state with Retry, and useful empty states.
- Add links from recent failures and the failure summary to the Requests page with the corresponding filter already selected.
- Keep existing quick actions for Providers, Combos, and API Keys.

## Accessibility and visual direction

- Continue using the existing shadcn/Radix components, Tailwind semantic tokens, and Lucide icons.
- Keep `#d2004b` for primary actions and active navigation; retain semantic error colors for failures.
- Ensure the mobile drawer and command dialog have accessible titles, labels, focus behavior, and keyboard activation.
- Preserve light and dark themes and support reduced motion through existing Tailwind motion conventions.

## Constraints

- Do not change gateway routing, fallback, streaming, provider behavior, business logic, database schema, or existing API contracts.
- Do not add runtime dependencies or external sound assets.
- Do not write secrets to logs.
- Do not commit, push, merge, tag, or deploy this work.
- Keep the main branch unchanged; implementation takes place in `feat/admin-ux-sound-20261122`.

## Verification

- Unit-test sound classification for success, HTTP errors, network failures, timeouts, and HTTP 499 cancellation.
- Run lint, typecheck, unit tests, integration tests, and production build.
- Run the app with a temporary isolated SQLite data directory and exercise setup/login, mobile navigation, command search, dashboard retry/empty states, request filters/deep links, notification preferences, sound previews, and cancelled request behavior in a browser when a browser runner is available.
- Inspect console and network failures and review the final diff for accessibility, cleanup, and regressions.
