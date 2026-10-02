# JSON-LD Context Workbench

Local JSON-LD resource and document workbench. Resources are stored on disk; the browser client is served by the same Node.js process as the API.

Requires Node.js 18 or newer. Run `npm start` to serve the application on port 8080, or `npm test` to run the tests. Set `PORT` and `WORKBENCH_DATA` to select another port or data file.

## What it does

- **Local, immutable context resources.** Save a context body as a named resource (`local:<name>`). Updating a resource appends a new content-hashed revision; older revisions stay retrievable forever. Edits use optimistic concurrency (`baseRevision`) — there is no last-write-wins.
- **Sessions pin a snapshot.** A session binds each resource to a specific revision at creation time and never consults resource head afterwards, so its interpretations stay reproducible. New sessions/ad-hoc parses read the current revisions.
- **Expansion with provenance.** Parse a compact document to see the expanded tree, per-field source traces and the full context decision chain (including the exact resource revision behind every include and term).
- **Safe compaction (new).** From an expanded result, generate a compact document against an existing binding set or pinned session snapshot. The middle panel shows the original input, the expanded result and the compact result side by side. Clicking a compact field explains the choice: the resource revision that defined the chosen term, the readable name used, the shape chosen, and why every other candidate was or was not used.

### Compaction guarantees

Compaction is a review-and-edit workflow, not a "copy a shorter version" button:

1. It only ever uses terms, aliases, prefixes and relative IRIs from the **same pinned snapshot** and verifies each candidate against the engine's own IRI expansion before choosing it.
2. It never changes nodes, values, containers or keyword semantics. Containers (`@list`, `@language`, `@index`, `@id`, `@type`), datatype/IRI/`@vocab` coercion and language tags are only elided when re-expansion restores them exactly.
3. When a readable term cannot safely carry a value shape, the document keeps an explicit form that still expands correctly (full IRI key and/or an explicit value object) and the decision explains why.
4. Every compact result is **re-expanded against the same snapshot and compared** before it is returned (`verified: true`). If even the generic fallback cannot represent the data within the supported subset, the API returns an `unrepresentable compaction` (422) instead of a misleadingly short document.
5. Node-local `@context` blocks are placed back on exactly the node they came from; a node's context never leaks to its siblings.

Nothing is ever fetched from the public network: context references must be `local:<name>`; remote `http(s)` references are refused during both expansion and compaction verification.

## API

| Method & path | Purpose |
| --- | --- |
| `GET/PUT /api/resources[/<name>[/revisions/<rev>]]` | List/read resources and revisions; `PUT { body, baseRevision }` appends a revision |
| `GET/POST /api/sessions`, `GET/DELETE /api/sessions/<id>` | List/create/delete sessions (snapshots pinned on create) |
| `POST /api/sessions/<id>/parse` | Parse a document against the session's pinned revisions |
| `POST /api/sessions/<id>/compact` | Compact `{ expanded, rootContext?, scopes?, baseUrl? }` against the session's pinned revisions |
| `POST /api/parse` | Ad-hoc parse with `{ document, bindings, baseUrl }` |
| `POST /api/compact` | Ad-hoc compaction with `{ expanded, bindings, rootContext?, scopes?, baseUrl? }` |

For compaction you normally pass the `rootContext` and `scopes` returned by a parse so the output reuses the exact document and node contexts. If you hand in expanded data from another system without that provenance, omit both and every bound resource reference is used as the target vocabulary.
