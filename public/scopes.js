// Browser-side scope derivation from parse traces. Mirrors the algorithm in
// src/jsonld/compact.js (deriveScopes / ownerShapeFor) without Node imports,
// so the frontend can tell the compactor which node-scoped local contexts
// were active during the originating parse. No network access here.

// Normalize array indices: "$.a[0].b" -> "$.a[].b"
export function norm(path) {
  return String(path).replace(/\[\d+\]/g, '[]');
}

/**
 * @param {Array} expanded  expanded document the traces were produced from
 * @param {Array} traces    parse traces
 * @param {Array} rootChain document-level decision chain
 * @returns {Map<string,string[]>} normalized node shape -> scoped local refs
 */
export function deriveScopes(expanded, traces, rootChain) {
  // Ordered document-level include sequence. A node's visible chain is the
  // root sequence followed by one include per node-scoped @context (a scoped
  // resource may itself nest further includes, which stay attached to it).
  const rootSeq = (rootChain ?? []).filter(c => c.kind === 'include').map(c => c.ref);
  const scopes = new Map();
  for (const t of traces ?? []) {
    if (!t.outPath || !Array.isArray(t.decisionChain)) continue;
    const refs = t.decisionChain.filter(c => c.kind === 'include').map(c => c.ref);
    if (!startsWithSeq(refs, rootSeq)) continue;
    const tail = refs.slice(rootSeq.length);
    if (!tail.length) continue;
    const owner = ownerShapeFor(expanded, t.outPath);
    if (!owner || owner.shape === '$') continue;
    const existing = scopes.get(owner.shape) ?? [];
    for (const ref of tail.slice(0, 1)) if (!existing.includes(ref)) existing.push(ref);
    scopes.set(owner.shape, existing);
  }
  return scopes;
}

function startsWithSeq(seq, prefix) {
  if (prefix.length > seq.length) return false;
  for (let i = 0; i < prefix.length; i++) if (seq[i] !== prefix[i]) return false;
  return true;
}

// Resolve the node that owns a trace outPath, returning its normalized shape.
// Expanded property names are arbitrary (often absolute) IRIs, so the path
// cannot be split on "." / ":" — the expanded tree guides key selection.
export function ownerShapeFor(expanded, outPath) {
  let rest = outPath.startsWith('$') ? outPath.slice(1) : outPath;
  const nodeStack = [];
  let cur, shape;
  if (rest[0] === '.') {
    cur = expanded[0];
    shape = '$';
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) nodeStack.push({ shape });
  } else {
    cur = expanded;
    shape = '$';
  }

  while (rest.length) {
    if (rest[0] === '[') {
      const end = rest.indexOf(']');
      if (end === -1 || !Array.isArray(cur)) return null;
      const i = Number(rest.slice(1, end));
      rest = rest.slice(end + 1);
      shape += '[]';
      cur = cur[i];
      if (cur && typeof cur === 'object' && !Array.isArray(cur)) nodeStack.push({ shape });
      continue;
    }
    if (rest[0] !== '.') return null;

    let best = null;
    for (const k of (cur && !Array.isArray(cur) ? Object.keys(cur) : [])) {
      if (rest.length === k.length + 1 && rest === '.' + k) { best = longer(best, k); continue; }
      const ch = rest[k.length + 1];
      if (rest.startsWith('.' + k) && (ch === '.' || ch === '[')) best = longer(best, k);
    }
    if (best === null) return null;

    if (rest.length === best.length + 1) {
      return { shape: nodeStack.at(-1)?.shape ?? '$', finalKey: best };
    }
    cur = cur?.[best];
    shape += '.' + best;
    rest = rest.slice(best.length + 1);
  }
  return null;
}

function longer(a, b) { return a === null || b.length > a.length ? b : a; }

// Ordered local refs for a compact document's root @context. Prefer the
// originating document's own @context (preserving author order); fall back to
// the include order recorded in the document-level decision chain.
export function rootContextFrom(document, rootChain) {
  const ctx = document && typeof document === 'object' ? document['@context'] : undefined;
  if (typeof ctx === 'string') return [ctx];
  if (Array.isArray(ctx)) return ctx.filter(x => typeof x === 'string');
  const fromChain = (rootChain ?? []).filter(c => c.kind === 'include').map(c => c.ref);
  return [...new Set(fromChain)];
}
