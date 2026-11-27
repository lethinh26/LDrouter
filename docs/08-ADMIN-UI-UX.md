# 08 — Admin UI/UX

## Design direction

LateDev Router should look like a polished infrastructure control panel, not a generic CRUD template.

Mandatory UI stack:

- React
- shadcn/ui
- Tailwind CSS
- Lucide icons

Primary brand color:

```text
#d2004b
```

Use neutral surfaces and reserve the primary color for strong accents/actions. Error red should remain semantically distinguishable from the brand primary where possible.

Support light and dark theme with persisted preference and system-theme default.

## Layout

Desktop:

```text
+----------------+--------------------------------------+
| LateDev Router | Top bar / page title / actions       |
|                +--------------------------------------+
| Dashboard      |                                      |
| Providers      |              Page                    |
| Models         |                                      |
| Combos         |                                      |
| API Keys       |                                      |
| Requests       |                                      |
| Statistics     |                                      |
| Audit Logs     |                                      |
| Settings       |                                      |
+----------------+--------------------------------------+
```

Mobile: sidebar becomes shadcn Sheet/drawer.

The mobile drawer reuses the desktop navigation destinations and closes after
navigation. The top bar shows the current page title and exposes a searchable
command palette through the search action or `Ctrl+K` / `Cmd+K`.

## Dashboard

Show operational summary, not duplicated analytics overload:

- requests today
- success rate
- total tokens today
- active providers / unhealthy providers
- recent failures
- provider health compact list
- loading skeletons, recoverable error/retry, and first-run/empty states
- direct links from recent failures to the matching request

Quick actions:

- Add Provider
- Browse Models
- Create Combo
- Create API Key
- Browse Requests

## Providers page

Table/cards include:

- name
- protocol badge
- base host (not secret query values)
- enabled state
- health state
- model count
- recent error rate/latency summary
- actions

Provider create/edit form:

- name
- slug
- type
- base URL
- API key (write-only after save)
- custom headers editor
- timeouts
- retry settings
- circuit breaker settings
- enabled

Never re-display the existing provider API key. Provide a “Replace credential” workflow.

Actions:

- Test Connection
- Fetch Models
- Edit
- Enable/Disable
- Delete/Archive with dependency warning

### Fetch Models modal

Required UX:

- searchable list
- pagination/virtualized list if large
- checkbox per model
- existing imported models marked
- newly discovered models distinguishable
- Select All
- Clear selection
- selected count
- Import Selected primary action

Running discovery alone does not mutate the model table.

## Models page

Filter by:

- provider
- enabled
- upstream available
- capability

Columns:

- public ID
- provider
- upstream ID
- enabled
- availability
- capability badges
- last seen

Model detail/edit can override capability metadata.

## Combos page

List:

- public ID
- enabled
- member count
- available-member count, with degraded-workload reserves and recovery-probe counts shown separately

Create/edit form:

- name
- slug
- mode
- immutable combo type (standard or native Codex)
- max total attempts
- optional overall combo deadline in seconds (blank means no additional limit)
- fallback trigger policy
- total-timeout fallback toggle
- adaptive fallback and recovery toggle
- slow-response threshold in seconds (default 60)
- consecutive slow-response count before demotion (default 3)
- member picker

Member editor:

- drag/drop or explicit up/down ordering
- numbered priority

Show each member's per-workload latency kind, median, fresh sample count, absolute/relative slow
counts, comparator, degradation, and recovery state when editing a combo. Distinguish degraded
reserves from hard unavailability and never imply one globally preferred model. Provide an audited
reset of adaptive history. Warn when the attempt cap or overall deadline limits fallback/rescue.

Warn when member capability sets differ.

Native Codex shows configured eligibility rather than account-verified health.
Only distinct upstream Codex model IDs can be added. The 429/adaptive controls
and synthetic admin Test are disabled; direct the operator to the signed-in
client configuration. Warn about finite token caps when selecting a native
Codex model, combo or alias in API Keys.

## API Keys page

Table:

- name
- prefix
- status
- expires
- last used
- model scope summary
- RPM/TPM/concurrency summary

Create flow:

1. name
2. optional custom key value (or leave empty to auto-generate ld-…)
3. allowed models/combos/aliases or explicit Allow All
4. expiry
5. IP allow/deny CIDRs
6. rate/token/concurrency limits
7. create
8. show `ld-...` secret once in a high-attention dialog with Copy button (confirmation that it will not be shown again)

After creation, every key row has a **Copy** icon (copy full secret to clipboard) and an **Eye** icon (show full secret in a modal). Secrets are stored encrypted-at-rest and can be retrieved anytime via these actions.

## Requests page

Dense operational table with server-side filters/pagination.

Status indicators:

- success
- failed
- partial stream if distinguishable

Click or expand a row for details.

Failed request must have an obvious expandable **Error** section.

Attempts use an accordion/timeline so fallback is understandable visually.

Do not display raw secret-bearing headers.

The explorer supports search by model substring, exact request ID, or exact
client IP; status presets (success, failed, HTTP 4xx, HTTP 5xx); protocol and
streaming filters; and URL-backed filters/pagination for shareable deep links.
The current API sorts server pages newest-first. Alternate sorting is a
client-side view of the loaded page only and does not change server pagination.
Loading, transport error/retry, no-history, and no-match states must be distinct.

### Request notifications and sound

- Request notification cards and sound are independent persisted preferences.
- Cards are live SSE notifications for final persisted request outcomes; they
  are dismissible and auto-dismiss after five seconds.
- Generate short success, HTTP failure, upstream-unavailable/network, and
  timeout tones locally with Web Audio. Do not load external audio assets.
- Unlock audio only after a user gesture; keep visual notifications usable if
  the browser blocks audio. Settings provides success/failure preview actions.
- If a final request arrives while that explicit unlock is pending, retain at
  most four live outcomes and flush them after a successful resume. The queue
  keeps the newest outcomes, respects the 450 ms live-sound interval, and is
  cleared after a failed unlock or context disposal. Events before any user
  gesture are not queued.
- Disabling sound is optimistic in the UI, but an existing AudioContext is
  disposed only after the preference PATCH succeeds. A failed PATCH restores
  the enabled preference without losing the previously unlocked context.
- A manual preview waits for any queued live tones to finish, then plays
  independently of the live notification throttle.
- HTTP 499/client disconnects are neutral and silent. Intermediate upstream
  attempts, request-start events, polling, and prefetch must not trigger sound.
- Deduplicate by request ID, bound in-memory IDs, throttle closely spaced tones,
  and release AudioContext/listeners/timers when no longer needed.
- Persisted completion events use a strictly increasing `createdAt` timestamp
  (also copied to `completedAt`) so live delivery has a durable completion order
  even when multiple requests finish within one clock millisecond. This is an
  ordering guarantee, not a database schema or response-shape change.
- SSE reconnects carry both `createdAt` and request ID. Replay is keyset-paginated
  and capped per connection; when more history remains, the server closes before
  flushing newer live completions so the next connection resumes without skipping
  older rows. The numeric `since` form remains accepted for initial clients.
- `request_started` is a transient, best-effort route pulse, not a persisted
  completion. Its bounded queue may discard the oldest pulse during prolonged
  replay/backpressure; the final persisted `request` event remains replayable.

- If the bounded live-completion queue overflows during replay, close that stream
  rather than sending an incomplete backlog. The reconnect cursor recovers every
  persisted completion; a deterministic integration gate verifies overflow
  after the first replay page and checks for duplicates or omissions.

## Statistics page

Preset segmented control:

```text
Today | 7 days | 30 days
```

Cards + charts + ranking tables as defined in logging/statistics spec.

Keep charts readable in dark mode. Use semantic chart tokens; brand color can be the main series but not every series.

## Audit Logs

Read-only searchable/paginated table:

- timestamp
- action
- success/failure
- target
- IP
- metadata summary

Detail dialog for sanitized metadata.

## Settings

Sections:

### Logging

- content logging policy
- retention
- DB size guard
- Run cleanup now

### Security

- change password
- TOTP status/setup/disable
- recovery codes regeneration
- trusted proxies

### Backup & Restore

- Download DB Backup
- Upload/Restore DB

Restore requires strong warning/confirmation and validation result before destructive action.

### System

- version
- database/schema version
- data directory (safe display)
- encryption configured status, never the key

## UI quality rules

- loading states use skeletons where useful
- every mutation has success/error feedback
- destructive actions use confirmation dialogs
- forms have field-level validation
- keyboard focus is visible
- tables remain usable on medium screens
- copyable IDs have Copy buttons
- timestamps have exact tooltip/full form if compacted
- errors provide request ID for support/debugging
- do not use browser `alert()`/`confirm()` as the primary UI

Read next: `09-OPERATIONS-NPM-DOCKER.md`.
