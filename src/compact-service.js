// Compact service: run the safe compactor against a pinned resource snapshot.
// The same snapshot the expander used is the compaction target, so session
// pins and ad-hoc pins stay fully reproducible and never consult head.

import { expandDocument } from './jsonld/expand.js';
import { compactDocument } from './jsonld/compact.js';
import { createSnapshotLoader } from './jsonld/loader.js';
import { JsonLdError, ERR } from './jsonld/errors.js';

/**
 * Compact an expanded document against a pinned snapshot.
 *
 * @param {object} args
 * @param {Array} args.expanded  expanded document (array of nodes)
 * @param {Map} args.snapshotMap name -> { revision, body }
 * @param {*} [args.rootContext] target document @context (defaults to every
 *   bound resource reference in binding order — used when the expanded input
 *   arrives without parse provenance, e.g. hand-pasted expansion data)
 * @param {Array} [args.scopes]  scope provenance from expandDocument
 * @param {string|null} [args.baseUrl]
 * @param {string|null} [args.sessionId]
 */
export function runCompact({ expanded, snapshotMap, rootContext, scopes = null, baseUrl = null, sessionId = null }) {
  if (!Array.isArray(expanded)) {
    throw new JsonLdError(ERR.VALIDATION, 'Compaction expects { expanded: [...] }');
  }
  const loader = createSnapshotLoader(snapshotMap, { sessionId });

  let effectiveRoot = rootContext;
  let effectiveScopes = scopes;
  if ((effectiveRoot === undefined || effectiveRoot === null) && !effectiveScopes) {
    // No parse provenance: target vocabulary = all bound resources.
    effectiveRoot = [...snapshotMap.keys()].map(name => `local:${name}`);
    if (!effectiveRoot.length) effectiveRoot = null;
    effectiveScopes = [];
  }
  if (effectiveScopes === null || effectiveScopes === undefined) effectiveScopes = [];

  const result = compactDocument(expanded, {
    loader,
    rootContext: effectiveRoot,
    scopes: effectiveScopes,
    baseUrl
  });

  // Re-expand the compacted form once more for the response payload, so the UI
  // can show the verification without another round trip.
  const reexpanded = expandDocument(result.compacted, { loader, baseUrl });

  const pinned = {};
  for (const [name, { revision }] of snapshotMap.entries()) pinned[name] = revision;

  return {
    compacted: result.compacted,
    compactDecisions: result.decisions,
    scopeLayout: result.scopeLayout,
    verified: result.verified,
    reexpanded: reexpanded.expanded,
    pinnedResources: pinned
  };
}
