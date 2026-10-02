# JSON-LD Context Workbench

Local JSON-LD resource and document workbench. Resources are stored on disk; the browser client is served by the same Node.js process as the API.

Requires Node.js 18 or newer. Run `npm start` to serve the application on port 8080, or `npm test` to run the tests. Set `PORT` and `WORKBENCH_DATA` to select another port or data file.

## Editing / review workflow

The workbench supports two inverse operations against the **same** pinned resource snapshot:

- **Expand (展开)** turns a compact document into the fully expanded form, with per-field provenance traces.
- **Compact (压缩)** takes one parse's expanded result and generates a compact document suited to the vocabulary of the current bindings or a chosen session snapshot. It is a separate editing/review flow (a third tree pane), not a copy of the expanded view.

### How compaction stays safe

Compaction never trusts a readable name. For every field it enumerates the candidate keys/values available in the active context (direct terms, keyword aliases, `prefix:suffix` compact IRIs, `@vocab` suffixes, `@base`-relative ids, absolute IRIs), ranks them, and **verifies each choice by re-expanding a probe with the same active context**. A candidate that would re-expand to different data is rejected — its reason is shown — and the field keeps an explicit form known to expand correctly (absolute IRI key, explicit value object, etc.). After assembly the whole compact document is re-expanded once more and compared to the source; the result is returned only when the two are identical. If a field cannot be expressed within the supported semantics (e.g. a datatyped literal whose type conflicts with the term's coercion), compaction fails with a classified `compaction conflict` (`inexpressible-value`) rather than emitting a shorter but meaning-changing field; the original input and expanded result remain on screen.

Clicking a field in the compact tree (or in the expanded tree) opens the decision panel: the resource **revision** used, the readable name adopted, and why each alternative candidate was or was not used. Node-scoped `@context` is re-emitted locally on the node (never hoisted to the root), so sibling scopes stay isolated.

### Target context and revision pinning

- **Ad-hoc compaction** (`POST /api/compact`) binds exactly the revisions requested, mirroring ad-hoc parsing.
- **Session compaction** (`POST /api/sessions/:id/compact`) uses the session's immutable snapshot; saving a newer resource revision never changes how an existing session expands or compacts. A new session reads the new head.

Both flows use the same snapshot loader, so ad-hoc and session interpretations of the same pinned revisions can never diverge. No public network access occurs: only `local:<name>` references bound in the target snapshot are used; an unbound root reference is refused, and an unbound node scope is dropped rather than fetched.

### API

- `POST /api/parse` — `{ document, bindings, baseUrl }` → `{ expanded, traces, decisionChain, ... }`
- `POST /api/compact` — `{ expanded, rootContext, scopes, bindings, baseUrl }` → `{ compact, decisions, verification, pinnedResources, ... }`
- `POST /api/sessions/:id/parse` — expand with the session snapshot
- `POST /api/sessions/:id/compact` — compact `{ expanded, rootContext?, scopes?, baseUrl? }` with the session snapshot
