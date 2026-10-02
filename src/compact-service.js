// Compact service: turn one parse's expanded result back into a compact
// document, against an explicitly chosen target context — a pinned snapshot
// (same mechanism as parsing, so ad-hoc and session interpretations can never
// diverge). Node-scoped contexts are reconstructed from the originating
// parse's provenance traces; only local: refs that are actually bound in the
// target snapshot at their pinned revision are eligible.

import { compactDocument, norm } from './jsonld/compact.js';
import { createSnapshotLoader } from './jsonld/loader.js';
import { JsonLdError, ERR } from './jsonld/errors.js';

/**
 * @param {object} args
 *   expanded     expanded result array from a parse
 *   snapshotMap  Map<name, {revision, body}> — target context
 *   rootRefs     ordered local refs for the compact document's root @context
 *   scopes       client/derived Map|object: normalized shape -> local refs
 *                (scoped contexts observed during the originating parse)
 *   baseUrl      document base IRI
 *   maxContextDepth
 */
export function runCompact({ expanded, snapshotMap, rootRefs, scopes = {}, baseUrl = null,
                             maxContextDepth = 32 }) {
  if (!Array.isArray(expanded)) {
    throw new JsonLdError(ERR.VALIDATION,
      'Compact input must be an expanded document (array of expanded nodes)');
  }
  const loader = createSnapshotLoader(snapshotMap);

  // Root refs must be bound in the target snapshot; otherwise the compact
  // document could not be re-expanded here, and we refuse it up front.
  const root = [];
  for (const ref of rootRefs ?? []) {
    if (typeof ref !== 'string' || !ref.startsWith('local:')) {
      throw new JsonLdError(ERR.VALIDATION,
        `Root @context entries must be local: references, got ${JSON.stringify(ref)}`);
    }
    const name = ref.slice('local:'.length);
    if (!snapshotMap.has(name)) {
      throw new JsonLdError(ERR.UNKNOWN_RESOURCE,
        `Target context does not bind ${ref}; cannot produce a compact document ` +
        `that re-expands in this session. Bind the resource (or choose another target context).`,
        { ref, name, knownResources: [...snapshotMap.keys()] });
    }
    root.push(ref);
  }

  // Sanitize scoped refs: keep only refs bound in THIS snapshot. A scope
  // sourced from a resource that is not part of the target context simply
  // does not exist there; its terms are not used, and its @context is not
  // emitted (the node falls back to root terms / explicit IRIs).
  const scopeMap = new Map();
  const droppedScopes = [];
  const scopeInput = scopes instanceof Map ? [...scopes.entries()] : Object.entries(scopes);
  for (const [shape, refs] of scopeInput) {
    if (shape === '$') continue; // merged into root by the compactor itself
    const kept = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (typeof ref !== 'string' || !ref.startsWith('local:')) continue;
      if (snapshotMap.has(ref.slice('local:'.length))) kept.push(ref);
      else droppedScopes.push({ shape, ref });
    }
    if (kept.length) scopeMap.set(norm(String(shape)), kept);
  }

  const result = compactDocument(expanded, {
    loader, rootRefs: root, scopes: scopeMap, baseUrl, maxContextDepth
  });

  const pinned = {};
  for (const [name, { revision }] of snapshotMap.entries()) pinned[name] = revision;

  return {
    compact: result.compact,
    decisions: result.decisions,
    warnings: result.warnings,
    rootContext: result.rootContext,
    // The compactor already re-expanded and compared the full document; only
    // the verdict + any mismatch locations need to cross the wire.
    verification: {
      ok: result.verification.ok,
      mismatches: result.verification.mismatches
    },
    droppedScopes,
    pinnedResources: pinned
  };
}
