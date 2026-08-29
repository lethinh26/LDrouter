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

## Dashboard

Show operational summary, not duplicated analytics overload:

- requests today
- success rate
- total tokens today
- active providers / unhealthy providers
- recent failures
- provider health compact list

Quick actions:

- Add Provider
- Create Combo
- Create API Key

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
- mode
- enabled
- member count
- health/eligible-member summary

Create/edit form:

- name
- slug
- mode
- max total attempts
- fallback trigger policy
- member picker

Fallback mode member editor:

- drag/drop or explicit up/down ordering
- numbered priority

Weighted RR member editor:

- weight numeric input
- show calculated percentage as informative only

Warn when member capability sets differ.

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
