// Safe JSON-LD compaction for this workbench's supported subset.
//
// The input is an EXPANDED document (the output of expand.js). The target
// vocabulary is the same pinned snapshot the expander uses, so compaction
// never touches the network and every name it picks is resolvable by the
// exact resource revisions bound to the session/ad-hoc parse.
//
// Hard rule: re-expanding the compact document with the same snapshot must be
// semantically identical to the input. Every candidate term/alias/relative
// IRI is verified against the engine's own IRI expansion before use, and the
// whole document is re-expanded at the end as a safety net. Where a readable
// term cannot carry the value shape safely (container/coercion/language would
// change meaning), the full IRI / explicit keyword form is kept and the
// decision explains why — compaction never emits a "looks shorter but means
// something else" field.

import { JsonLdError, ERR } from './errors.js';
import {
  createInitialContext, processContext, expandIri, isKeyword
} from './context.js';
import { expandDocument } from './expand.js';
import { isAbsoluteIri } from './iri.js';

export function compactDocument(input, opts) {
  const {
    loader,
    rootContext = null,
    scopes = [],
    baseUrl = null,
    maxContextDepth = 32
  } = opts;
  if (!loader) throw new JsonLdError(ERR.VALIDATION, 'A local context loader is required for compaction');
  if (!Array.isArray(input)) {
    throw new JsonLdError(ERR.VALIDATION, 'Compaction expects an expanded document (JSON array)');
  }

  const state = {
    loader, baseUrl, maxContextDepth,
    decisions: [],                 // explainable per-field choices
    scopeQueues: buildScopeQueues(scopes),
    scopeLayout: scopes
  };

  // Build the root active context from the target bindings / document context.
  const rootChain = [];
  let rootCtx = createInitialContext();
  if (baseUrl) rootCtx.base = baseUrl;
  if (rootContext !== null && rootContext !== undefined) {
    rootCtx = processContext(rootCtx, rootContext, {
      loader, chain: rootChain, maxDepth: maxContextDepth, baseUrl, sourceStack: []
    });
  }

  // Term -> origin ("local:<name>") maps, so each choice can point at the
  // immutable resource revision that defined the chosen name.
  const rootOrigins = buildTermOrigins(rootChain);

  const run = (forceGeneric) => {
    state.forceGeneric = forceGeneric;
    state.decisions = [];
    state.scopeCursor = new Map();
    const elements = input.map((node, i) =>
      compactNode(node, rootCtx, `$[${i}]`, rootChain, rootOrigins, state));
    let doc;
    if (elements.length === 1) {
      doc = elements[0];
    } else {
      doc = elements;
    }
    if (rootContext !== null && rootContext !== undefined && doc && typeof doc === 'object' && !Array.isArray(doc)) {
      doc = { '@context': cloneJson(rootContext), ...doc };
    } else if (rootContext !== null && rootContext !== undefined && Array.isArray(doc)) {
      // A document-level @context needs an object wrapper; use @graph so the
      // array of nodes keeps exactly the same meaning on re-expansion.
      doc = { '@context': cloneJson(rootContext), '@graph': doc };
    }
    return doc;
  };

  state.decisions.push({
    kind: 'root-context',
    raw: rootContext,
    includes: includesOf(rootChain),
    note: rootContext === null ? '目标上下文没有文档级 @context' : undefined
  });

  let compacted = run(false);

  // Safety net: re-expand with the SAME pinned snapshot and compare.
  const verify = verifyRoundTrip(input, compacted, loader, baseUrl);
  if (!verify.ok) {
    // Retry with every property forced to its unambiguous full-IRI / explicit
    // keyword shape, which cannot invoke term coercion or containers.
    const safe = run(true);
    const verifySafe = verifyRoundTrip(input, safe, loader, baseUrl);
    if (!verifySafe.ok) {
      throw new JsonLdError(ERR.UNREPRESENTABLE_COMPACTION,
        `Compaction cannot represent this expanded result in the supported ` +
        `subset while preserving semantics: mismatch at ${verifySafe.path ?? verify.path ?? '?'}. ` +
        `The expanded result was left unchanged.`,
        { path: verifySafe.path ?? verify.path, expected: verifySafe.expected, actual: verifySafe.actual });
    }
    state.decisions.push({
      kind: 'fallback',
      path: verify.path,
      reason: '首选词项形状无法通过再展开校验，已对相关字段改用完整 IRI / 显式关键字表达。'
    });
    compacted = safe;
  }

  return {
    compacted,
    decisions: state.decisions,
    scopeLayout: state.scopeLayout.map(s => ({
      sourcePath: s.sourcePath,
      outPath: s.outPath,
      raw: s.raw,
      includes: includesOf(s.chain ?? [])
    })),
    verified: true
  };
}

// ---------------------------------------------------------------------------
// Node compaction
// ---------------------------------------------------------------------------

function compactNode(node, ctx, path, chain, origins, state) {
  if (node === null || typeof node !== 'object') {
    // Scalars only occur inside @list/@set keyword structures; never coerce
    // them (the expander treated the keyword position as a plain property).
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item, i) => compactNode(item, ctx, `${path}[${i}]`, chain, origins, state));
  }

  // Value object?
  if ('@value' in node) return compactValueObject(node, ctx, path, state);

  // Node-local @context: recover the scope provenance recorded for exactly
  // this expanded path. Scopes are keyed by tree-shape paths, so a context
  // applies to this node only — never to its siblings.
  let nodeCtx = ctx;
  let nodeChain = chain;
  let nodeOrigins = origins;
  const scope = takeScope(path, state);
  const out = {};
  if (scope) {
    const scopedChain = [];
    nodeCtx = processContext(ctx, scope.raw, {
      loader: state.loader, chain: scopedChain, maxDepth: state.maxContextDepth,
      baseUrl: state.baseUrl, sourceStack: []
    });
    nodeChain = [...chain, ...scopedChain];
    nodeOrigins = overlayOrigins(origins, scopedChain);
    out['@context'] = cloneJson(scope.raw);
    state.decisions.push({
      kind: 'scope',
      path,
      raw: scope.raw,
      includes: includesOf(scopedChain),
      note: '该节点在原文档中拥有自己的 @context；压缩时放回同一节点，作用域不泄漏给兄弟节点。'
    });
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    const cpath = `${path}.${key}`;
    if (isKeyword(key)) {
      compactKeywordEntry(out, key, value, nodeCtx, cpath, path, nodeChain, nodeOrigins, state);
    } else {
      compactProperty(out, key, value, nodeCtx, cpath, nodeChain, nodeOrigins, state);
    }
  }
  return out;
}

function compactKeywordEntry(out, keyword, value, ctx, cpath, nodePath, chain, origins, state) {
  switch (keyword) {
    case '@id': {
      const alias = chooseAlias('@id', ctx, cpath, state, origins);
      out[alias.key] = compactIdValue(value, ctx, cpath, state);
      return;
    }
    case '@type': {
      const alias = chooseAlias('@type', ctx, cpath, state, origins);
      const arr = Array.isArray(value) ? value : [value];
      const compacted = arr.map((t, i) => {
        const key = compactVocabValue(t, ctx, `${cpath}[${i}]`, state);
        // Every type must have a form that re-expands to the same IRI;
        // compactVocabValue falls back to the full IRI itself.
        return key ?? t;
      });
      // The expander always collects node types into an array; a single type
      // is conventionally compact and re-expands to the same one-element
      // array. Multiple types stay an array.
      out[alias.key] = compacted.length === 1 ? compacted[0] : compacted;
      return;
    }
    case '@index': {
      const alias = chooseAlias('@index', ctx, cpath, state, origins);
      out[alias.key] = value; // expander already stringifies
      return;
    }
    case '@language': {
      const alias = chooseAlias('@language', ctx, cpath, state, origins);
      out[alias.key] = value;
      return;
    }
    case '@value': {
      const alias = chooseAlias('@value', ctx, cpath, state, origins);
      out[alias.key] = value;
      return;
    }
    case '@list': {
      const alias = chooseAlias('@list', ctx, cpath, state, origins);
      // At an explicit @list keyword position there is no term coercion, and
      // the array structure is part of the meaning — always emit an array.
      const listValue = (Array.isArray(value) ? value : [value])
        .map((item, i) => compactPlainItem(item, ctx, `${cpath}[${i}]`, chain, origins, state));
      out[alias.key] = listValue;
      return;
    }
    case '@graph': {
      const alias = chooseAlias('@graph', ctx, cpath, state, origins);
      const arr = Array.isArray(value) ? value : [value];
      out[alias.key] = arr.map((item, i) =>
        compactNode(item, ctx, `${cpath}[${i}]`, chain, origins, state));
      return;
    }
    case '@set': {
      // Explicit @set is preserved explicitly (dropping it would erase the
      // set marker). Entries were expanded with no property term coercion.
      const alias = chooseAlias('@set', ctx, cpath, state, origins);
      const arr = Array.isArray(value) ? value : [value];
      out[alias.key] = arr.map((item, i) =>
        compactPlainItem(item, ctx, `${cpath}[${i}]`, chain, origins, state));
      return;
    }
    default: {
      // @included and any other structural keyword: keep the name (alias if
      // the vocabulary defines one) and recurse generically.
      const alias = chooseAlias(keyword, ctx, cpath, state, origins);
      const arr = Array.isArray(value) ? value : [value];
      out[alias.key] = arr.map((item, i) =>
        compactNode(item, ctx, `${cpath}[${i}]`, chain, origins, state));
    }
  }
}

// ---------------------------------------------------------------------------
// Property compaction (IRI -> term / prefix / vocab / full IRI)
// ---------------------------------------------------------------------------

function compactProperty(out, iri, items, ctx, path, chain, origins, state) {
  const list = Array.isArray(items) ? items : [items];
  const candidates = propertyCandidates(iri, ctx, state);

  // Every term/alias/prefix candidate gets a built value; keep the most
  // compact applicable shape together with the candidate that produced it.
  const attempts = [];
  if (!state.forceGeneric) {
    for (const cand of candidates) {
      const built = buildPropertyValue(cand, list, ctx, path, chain, origins, state);
      cand.applicable = built.ok;
      cand.reason = built.ok ? undefined : built.reason;
      if (built.ok) attempts.push({ cand, built });
    }
  }

  let chosen, attempt;
  if (attempts.length) {
    // Most compact shape first; for the same shape a real term beats a CURIE,
    // @vocab suffix or full IRI (and reads better in this vocabulary).
    const viaRank = { term: 0, prefix: 1, vocab: 2, iri: 3 };
    attempts.sort((a, b) =>
      (rankMode(a.built.mode) - rankMode(b.built.mode)) ||
      ((viaRank[a.cand.via] ?? 9) - (viaRank[b.cand.via] ?? 9)) ||
      (a.cand.key.length - b.cand.key.length));
    ({ cand: chosen, built: attempt } = attempts[0]);
  } else {
    // Generic, semantics-preserving fallback: full IRI key, explicit shapes.
    const generic = candidates.find(c => c.via === 'iri');
    const built = buildGenericProperty(list, ctx, path, chain, origins, state);
    chosen = generic ?? { key: iri, via: 'iri', def: null };
    attempt = built;
    chosen.applicable = true;
    chosen.reason = undefined;
    chosen.fallback = true;
  }

  out[chosen.key] = attempt.value;

  state.decisions.push({
    kind: 'property',
    path,
    expandedIri: iri,
    compactKey: chosen.key,
    compactPath: path.replace(iri, chosen.key),
    via: chosen.via,
    mode: attempt.mode,
    sourceRef: chosen.via === 'term' ? (origins.get(chosen.key) ?? null) : null,
    term: chosen.via === 'term' ? describeTerm(chosen.key, chosen.def) : undefined,
    candidates: candidates.map(c => ({
      key: c.key, via: c.via,
      accepted: c === chosen,
      applicable: c.applicable,
      reason: c.reason,
      sourceRef: c.via === 'term' ? (origins.get(c.key) ?? null) : null
    })),
    valueDecisions: attempt.valueDecisions,
    fallback: chosen.fallback || undefined,
    note: chosen.fallback
      ? '上下文里没有能安全承载该值形状的词项/别名，保留完整 IRI 与显式结构；再展开语义不变。'
      : undefined
  });
}

function rankMode(mode) {
  // Most compact (container-elided) shapes first.
  return { list: 0, languageMap: 1, indexMap: 2, idMap: 3, typeMap: 4, plain: 5 }[mode] ?? 9;
}

function propertyCandidates(iri, ctx, state) {
  const out = [];
  const seen = new Set();
  const push = (key, via, def) => {
    if (typeof key !== 'string' || !key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, via, def });
  };

  // 1. Terms explicitly mapped to this IRI (including keyword aliases, which
  //    never appear here because keywords are handled separately).
  const termNames = [];
  for (const [name, def] of ctx.terms) {
    if (def && def.id === iri && !isKeyword(iri)) termNames.push(name);
  }
  termNames.sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const name of termNames) push(name, 'term', ctx.terms.get(name));

  // 2. CURIE/ prefix with @prefix (required at property position).
  for (const [name, def] of ctx.terms) {
    if (def?.prefix === true && typeof def.id === 'string' && iri.startsWith(def.id) && iri !== def.id) {
      const suffix = iri.slice(def.id.length);
      if (suffix) push(`${name}:${suffix}`, 'prefix', def);
    }
  }

  // 3. @vocab suffix.
  if (ctx.vocab && iri.startsWith(ctx.vocab) && iri !== ctx.vocab) {
    push(iri.slice(ctx.vocab.length), 'vocab', null);
  }

  // Every candidate is verified against the engine's own property expansion;
  // a suffix that collides with another term/prefix simply fails here.
  const verified = out.filter(c =>
    c.via === 'term' || safeExpandProperty(ctx, c.key) === iri);
  for (const c of verified) c.verified = true;

  // 4. Full IRI — always valid and always safe.
  push(iri, 'iri', null);
  return out;
}

function safeExpandProperty(ctx, key) {
  try {
    return expandIri(ctx, key, { vocab: true, documentRelative: false });
  } catch {
    return null;
  }
}

// Try every container/plain representation a candidate supports.
function buildPropertyValue(cand, items, ctx, path, chain, origins, state) {
  const def = cand.def;

  // A term candidate can only be trusted if the engine really maps the key to
  // its IRI at property position (prefix/vocab candidates pre-verified).
  if (cand.via === 'term' && safeExpandProperty(ctx, cand.key) !== def.id) {
    return { ok: false, reason: '该词项在当前（可能被节点级 context 覆盖的）作用域中不再映射到该 IRI' };
  }

  const containers = def?.container ? [...def.container] : [];
  if (containers.includes('@list')) {
    const listAttempt = tryListMode(def, items, ctx, path, chain, origins, state);
    if (listAttempt.ok) return listAttempt;
  }
  if (containers.includes('@language')) {
    const langAttempt = tryLanguageMap(items, def, ctx, path, chain, origins, state);
    if (langAttempt.ok) return langAttempt;
  }
  if (containers.includes('@index')) {
    const idxAttempt = tryIndexMap(items, def, ctx, path, chain, origins, state);
    if (idxAttempt.ok) return idxAttempt;
  }
  if (containers.includes('@id')) {
    const idAttempt = tryIdMap(items, def, ctx, path, chain, origins, state);
    if (idAttempt.ok) return idAttempt;
  }
  if (containers.includes('@type')) {
    const typeAttempt = tryTypeMap(items, def, ctx, path, chain, origins, state);
    if (typeAttempt.ok) return typeAttempt;
  }

  // Plain mode is only safe when re-expansion through this term cannot reshape
  // the values: each item must compact to something the term re-coerces back
  // to exactly the same expanded item.
  return tryPlain(items, def, ctx, path, chain, origins, state);
}

// ---- @list ----------------------------------------------------------------

function tryListMode(def, items, ctx, path, chain, origins, state) {
  // A single {"@list": [...]} can become the bare array scalar form.
  if (items.length === 1 && isListObject(items[0])) {
    const entries = Array.isArray(items[0]['@list']) ? items[0]['@list'] : [items[0]['@list']];
    const valueDecisions = [];
    const compacted = entries.map((item, i) =>
      compactItemThroughTerm(item, def, ctx, `${path}[].@list[${i}]`, chain, origins, state, valueDecisions));
    // @list preserves ORDER and ARRAY-ness: never scalarize a one-element
    // list (a bare scalar would still be a list of one here, but keeping the
    // array makes the list structure explicit and unambiguous on review).
    return { ok: true, mode: 'list', value: compacted, valueDecisions };
  }
  return { ok: false, reason: '@list 容器只接受单个 {"@list": [...]}；数据为多个列表对象或其他形状，压缩为短形式会改变结构' };
}

function isListObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).length === 1 && '@list' in item;
}

// ---- @language map --------------------------------------------------------

function tryLanguageMap(items, def, ctx, path, chain, origins, state) {
  // Engine: language map inner values are strings only; output items are
  // value objects carrying exactly @value + @language.
  const groups = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return langFail();
    if (!('@language' in item)) return langFail();
    if ('@type' in item || '@index' in item) return langFail();
    if (typeof item['@value'] !== 'string') return langFail();
    const lang = item['@language'];
    if (!groups.has(lang)) groups.set(lang, []);
    groups.get(lang).push(item['@value']);
  }
  const map = {};
  const valueDecisions = [];
  for (const [lang, values] of groups) {
    map[lang] = values.length === 1 ? values[0] : values;
    valueDecisions.push({ shape: 'language-map', language: lang, count: values.length });
  }
  return { ok: true, mode: 'languageMap', value: map, valueDecisions };

  function langFail() {
    return { ok: false, reason: '@language 容器要求所有值都是带 @language 的字符串值对象；存在其他形状，使用短形式会在再展开时变成普通字面量' };
  }
}

// ---- @index map -----------------------------------------------------------

function tryIndexMap(items, def, ctx, path, chain, origins, state) {
  const groups = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: '@index 容器值必须是对象' };
    }
    const hasIndex = '@index' in item;
    const key = hasIndex ? item['@index'] : '@none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const valueDecisions = [];
  const map = {};
  for (const [index, group] of groups) {
    const compacted = group.map((item, i) => {
      const stripped = stripKey(item, '@index');
      return compactItemThroughTerm(stripped, def, ctx, `${path}[].${index}[${i}]`, chain, origins, state, valueDecisions);
    });
    map[index] = compacted.length === 1 ? compacted[0] : compacted;
    valueDecisions.push({ shape: 'index-map', index, count: group.length });
  }
  return { ok: true, mode: 'indexMap', value: map, valueDecisions };
}

// ---- @id map --------------------------------------------------------------

function tryIdMap(items, def, ctx, path, chain, origins, state) {
  const groups = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: '@id 容器值必须是对象' };
    }
    const key = '@id' in item ? item['@id'] : '@none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const valueDecisions = [];
  const map = {};
  for (const [id, group] of groups) {
    const mapKey = id === '@none' ? '@none' : compactIdValue(id, ctx, `${path}["${id}"]`, state);
    const compacted = group.map((item, i) => {
      const stripped = stripKey(item, '@id');
      return compactItemThroughTerm(stripped, def, ctx, `${path}[].${mapKey}[${i}]`, chain, origins, state, valueDecisions);
    });
    map[mapKey] = compacted.length === 1 ? compacted[0] : compacted;
    valueDecisions.push({ shape: 'id-map', id: mapKey, count: group.length });
  }
  return { ok: true, mode: 'idMap', value: map, valueDecisions };
}

// ---- @type map ------------------------------------------------------------

function tryTypeMap(items, def, ctx, path, chain, origins, state) {
  // To strip the type safely it must be the LAST @type entry: the engine
  // appends the key type on re-expansion, so order is observable.
  const groups = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !('@type' in item)) {
      return { ok: false, reason: '@type 容器要求每个值对象带 @type，且类型须位于 @type 末尾以保证再展开顺序一致' };
    }
    const types = item['@type'];
    const lastType = types[types.length - 1];
    const typeKey = compactTypeKey(lastType, ctx);
    if (typeKey === null) {
      return { ok: false, reason: `类型 "${lastType}" 无法在当前作用域压缩为可再展开的 @type 容器键` };
    }
    if (!groups.has(typeKey)) groups.set(typeKey, { iri: lastType, items: [] });
    groups.get(typeKey).items.push(item);
  }
  const valueDecisions = [];
  const map = {};
  for (const [typeKey, group] of groups) {
    const compacted = group.items.map((item, i) => {
      const stripped = stripType(item);
      return compactItemThroughTerm(stripped, def, ctx, `${path}[].${typeKey}[${i}]`, chain, origins, state, valueDecisions);
    });
    map[typeKey] = compacted.length === 1 ? compacted[0] : compacted;
    valueDecisions.push({ shape: 'type-map', typeIri: group.iri, typeKey, count: group.items.length });
  }
  return { ok: true, mode: 'typeMap', value: map, valueDecisions };
}

function compactTypeKey(iri, ctx) {
  // The key expands at vocabulary position (vocab + document-relative).
  const candidates = valueCandidates(iri, ctx, { vocab: true, documentRelative: true });
  return candidates.length ? candidates[0] : null;
}

function stripType(item) {
  const types = item['@type'];
  const copy = { ...item };
  if (types.length === 1) delete copy['@type'];
  else copy['@type'] = types.slice(0, -1);
  return copy;
}

// ---- plain ----------------------------------------------------------------

function tryPlain(items, def, ctx, path, chain, origins, state) {
  const valueDecisions = [];
  const compacted = items.map((item, i) =>
    compactItemThroughTerm(item, def, ctx, `${path}[${i}]`, chain, origins, state, valueDecisions));
  const ok = valueDecisions.every(d => d.safe !== false);
  if (!ok) {
    const bad = valueDecisions.find(d => d.safe === false);
    return { ok: false, reason: bad.reason };
  }
  return { ok: true, mode: 'plain', value: compacted.length === 1 ? compacted[0] : compacted, valueDecisions };
}

// Full-IRI property: no term coercion or container ever applies.
function buildGenericProperty(items, ctx, path, chain, origins, state) {
  const valueDecisions = [];
  const compacted = items.map((item, i) =>
    compactPlainItem(item, ctx, `${path}[${i}]`, chain, origins, state, valueDecisions));
  return { ok: true, mode: 'plain', value: compacted.length === 1 ? compacted[0] : compacted, valueDecisions };
}

// ---------------------------------------------------------------------------
// Value item compaction
// ---------------------------------------------------------------------------

// An item re-expanded THROUGH a property term: the term may coerce @id/@vocab,
// add a datatype or a language, so scalars are safe exactly when the term
// deterministically restores the expanded shape.
function compactItemThroughTerm(item, def, ctx, ipath, chain, origins, state, valueDecisions) {
  const decision = { path: ipath };
  valueDecisions.push(decision);

  if (item === null || typeof item !== 'object') {
    decision.shape = 'scalar';
    decision.safe = true;
    return item;
  }
  if (Array.isArray(item)) {
    decision.shape = 'array';
    decision.safe = true;
    return item.map((sub, i) =>
      compactPlainItem(sub, ctx, `${ipath}[${i}]`, chain, origins, state, valueDecisions));
  }

  // Explicit list / set / node → recurse (term coercion does not touch nodes;
  // @list keyword content was expanded without coercion).
  if ('@list' in item) {
    decision.shape = 'list';
    decision.safe = true;
    const entries = Array.isArray(item['@list']) ? item['@list'] : [item['@list']];
    return { '@list': entries.map((sub, i) =>
      compactPlainItem(sub, ctx, `${ipath}.@list[${i}]`, chain, origins, state, valueDecisions)) };
  }
  if ('@id' in item && !('@value' in item)) {
    return compactIdRef(item, def, ctx, ipath, chain, origins, state, decision);
  }
  if ('@value' in item) {
    return compactValueThroughTerm(item, def, ctx, ipath, chain, origins, state, decision);
  }
  // node object
  decision.shape = 'node';
  decision.safe = true;
  return compactNode(item, ctx, ipath, chain, origins, state);
}

function compactIdRef(item, def, ctx, ipath, chain, origins, state, decision) {
  const keys = Object.keys(item);
  const coerce = def?.typeMapping;
  if (keys.length === 1 && (coerce === '@id' || coerce === '@vocab')) {
    const iri = item['@id'];
    if (coerce === '@id') {
      decision.shape = 'id-coercion';
      decision.safe = true;
      decision.from = iri;
      decision.compact = compactIdValue(iri, ctx, ipath, state);
      return decision.compact;
    }
    // @vocab coercion: scalar only if a vocabulary-relative form exists.
    const compact = compactVocabValue(iri, ctx, ipath, state, decision);
    if (compact !== null) {
      decision.shape = 'vocab-coercion';
      decision.safe = true;
      return compact;
    }
    decision.shape = 'id-coercion-blocked';
    decision.safe = false;
    decision.reason = '@vocab 强制类型要求值能按词表解析回该 IRI，但当前词表中没有安全的压缩形式';
    return { '@id': iri };
  }
  // A node reference with more properties, or a term without @id/@vocab
  // coercion: recurse as a node (no scalarization would be valid).
  decision.shape = 'node';
  decision.safe = true;
  return compactNode(item, ctx, ipath, chain, origins, state);
}

function compactValueThroughTerm(vo, def, ctx, ipath, chain, origins, state, decision) {
  const value = vo['@value'];
  const typeArr = vo['@type'];
  const lang = '@language' in vo ? vo['@language'] : undefined;
  const coerce = def?.typeMapping ?? null;

  // Typed literal restored by the term's @type coercion.
  if (typeArr && typeArr.length === 1 && coerce && coerce !== '@id' && coerce !== '@vocab' && coerce !== '@json') {
    if (typeArr[0] === coerce && lang === undefined) {
      decision.shape = 'typed-literal';
      decision.safe = true;
      decision.datatype = typeArr[0];
      return value;
    }
  }

  // Language-tagged string restored by term / default language.
  if (typeof value === 'string' && lang !== undefined) {
    const termLang = def?.languageSet ? def.language : undefined;
    const effectiveLang = termLang !== undefined ? termLang : ctx.language;
    if (effectiveLang === lang) {
      decision.shape = 'language-literal';
      decision.safe = true;
      decision.language = lang;
      return value;
    }
    decision.shape = 'language-literal-blocked';
    decision.safe = false;
    decision.reason = `词项/默认语言是 ${effectiveLang ?? '空'}，无法还原 @language "${lang}"，压缩为裸字符串会改变字面量语言标记`;
    return keepValueObject(vo, ctx, decision, state, ipath);
  }

  // Plain string with NO language tag.
  if (typeof value === 'string' && lang === undefined) {
    if (def?.languageSet) {
      // Explicit term @language: null suppresses the default → a scalar stays
      // untagged; an explicit non-null language would ADD a tag the value
      // lacks, so the scalar is unsafe in that case.
      if (def.language === null) {
        decision.shape = 'plain-literal';
        decision.safe = true;
        return value;
      }
      decision.shape = 'plain-literal-blocked';
      decision.safe = false;
      decision.reason = `词项带有 @language "${def.language}"，裸字符串会被加上该语言标记`;
      return keepValueObject(vo, ctx, decision, state, ipath);
    }
    // No explicit term language: a scalar inherits the active default. A
    // tagged value reaching here with no tag is only reproducible as a scalar
    // when there is no default language at all.
    if (ctx.language) {
      decision.shape = 'plain-literal-blocked';
      decision.safe = false;
      decision.reason = `活动默认语言 "${ctx.language}" 会给裸字符串加上语言标记，而展开值没有 @language`;
      return keepValueObject(vo, ctx, decision, state, ipath);
    }
    decision.shape = 'plain-literal';
    decision.safe = true;
    return value;
  }

  // Numbers/booleans/null are unaffected by default language; a datatype
  // coercion mismatch means the term would ADD a type the value lacks.
  if (typeArr === undefined && lang === undefined) {
    if (coerce && coerce !== '@id' && coerce !== '@vocab' && coerce !== '@json' && typeof value !== 'object') {
      decision.shape = 'typed-literal-blocked';
      decision.safe = false;
      decision.reason = `词项会把值强制为类型 ${coerce}，但展开值没有该类型`;
      return keepValueObject(vo, ctx, decision, state, ipath);
    }
    decision.shape = 'plain-literal';
    decision.safe = true;
    return value;
  }

  // Anything richer (typed/datatype, language mismatch already handled): keep explicit.
  decision.shape = 'value-object';
  decision.safe = true;
  return keepValueObject(vo, ctx, decision, state, ipath);
}

// Generic position (keyword structures / full-IRI properties / nodes):
// nothing coerces the value, so explicit shapes must stay explicit except
// plain literals with no active default language.
function compactPlainItem(item, ctx, ipath, chain, origins, state, valueDecisions = []) {
  const decision = { path: ipath };
  valueDecisions.push(decision);
  if (item === null || typeof item !== 'object') {
    decision.shape = 'scalar';
    decision.safe = true;
    return item;
  }
  if (Array.isArray(item)) {
    decision.shape = 'array';
    return item.map((sub, i) =>
      compactPlainItem(sub, ctx, `${ipath}[${i}]`, chain, origins, state, valueDecisions));
  }
  if ('@list' in item) {
    decision.shape = 'list';
    const entries = Array.isArray(item['@list']) ? item['@list'] : [item['@list']];
    return { '@list': entries.map((sub, i) =>
      compactPlainItem(sub, ctx, `${ipath}.@list[${i}]`, chain, origins, state, valueDecisions)) };
  }
  if ('@value' in item) {
    const value = item['@value'];
    const lang = '@language' in item ? item['@language'] : undefined;
    if (typeof value === 'string') {
      if (lang !== undefined || ctx.language) {
        decision.shape = 'value-object';
        decision.safe = true;
        decision.reason = lang === undefined
          ? '默认语言处于活动状态，保留显式 {"@value"} 以免凭空获得语言标记'
          : '保留显式 @language 标记';
        return keepValueObject(item, ctx, decision, state, ipath);
      }
    }
    if (lang === undefined && item['@type'] === undefined && !('@index' in item)) {
      decision.shape = 'plain-literal';
      decision.safe = true;
      return value;
    }
    decision.shape = 'value-object';
    return keepValueObject(item, ctx, decision, state, ipath);
  }
  // node reference / node object
  decision.shape = 'node';
  return compactNode(item, ctx, ipath, chain, origins, state);
}

function compactValueObject(node, ctx, path, state) {
  // A free-standing value object (only reachable inside keyword structures).
  const out = {};
  for (const key of Object.keys(node)) {
    if (key === '@type') {
      const arr = node['@type'];
      const types = (Array.isArray(arr) ? arr : [arr]).map(t => compactDatatypeIri(t, ctx, state, path));
      out['@type'] = Array.isArray(arr) ? types : types[0];
    } else if (key === '@language') {
      out['@language'] = node['@language'];
    } else {
      out[key] = node[key];
    }
  }
  return out;
}

function keepValueObject(vo, ctx, decision, state, ipath) {
  const out = { '@value': vo['@value'] };
  if ('@language' in vo) out['@language'] = vo['@language'];
  if ('@type' in vo) {
    const types = vo['@type'];
    const compacted = types.map(t => compactDatatypeIri(t, ctx, state, ipath));
    out['@type'] = types.length === 1 ? compacted[0] : compacted;
  }
  if ('@index' in vo) out['@index'] = vo['@index'];
  decision.kept = out;
  return out;
}

function compactDatatypeIri(iri, ctx, state, ipath) {
  // A datatype inside a value object: prefer prefix/vocab names that
  // re-expand to the same IRI; otherwise keep the full IRI.
  const candidates = valueCandidates(iri, ctx, { vocab: true, documentRelative: false });
  for (const key of candidates) {
    if (safeExpandIri(ctx, key, { vocab: true, documentRelative: false }) === iri) {
      state.decisions.push({
        kind: 'datatype', path: ipath, expandedIri: iri, compactKey: key,
        via: ctx.terms.get(key) ? 'term' : 'compact-iri',
        note: '值对象的数据类型 IRI 压缩；再展开会回到同一 IRI。'
      });
      return key;
    }
  }
  return iri;
}

// ---------------------------------------------------------------------------
// IRI value compaction (@id values, @type values)
// ---------------------------------------------------------------------------

function compactIdValue(iri, ctx, path, state) {
  if (typeof iri !== 'string') return iri;
  const candidates = valueCandidates(iri, ctx, { vocab: false, documentRelative: true });
  pickAndExplain(iri, candidates, ctx, path, state, '@id');
  return candidates[0] ?? iri;
}

function compactVocabValue(iri, ctx, path, state, decision = null) {
  if (typeof iri !== 'string') return iri;
  const candidates = valueCandidates(iri, ctx, { vocab: true, documentRelative: true });
  if (!candidates.length) {
    if (decision) {
      decision.safe = false;
      decision.reason = `"${iri}" 无法在当前词表中压缩为可还原的值`;
    }
    return null;
  }
  pickAndExplain(iri, candidates, ctx, path, state, '@type/@vocab');
  return candidates[0];
}

function pickAndExplain(iri, candidates, ctx, path, state, position) {
  state.decisions.push({
    kind: 'value-iri',
    path,
    position,
    expandedIri: iri,
    compactKey: candidates[0],
    rejected: candidates.slice(1),
    note: '候选均经当前作用域的 IRI 展开验证；选择最短且能还原的形式。'
  });
}

// Ordered list of value-position compact forms, shortest first, each verified
// to re-expand to `iri`. Full IRI is appended last (always valid).
function valueCandidates(iri, ctx, { vocab, documentRelative }) {
  const cands = [];
  const seen = new Set();
  const add = (key) => {
    if (typeof key === 'string' && key && !seen.has(key)) {
      seen.add(key);
      cands.push(key);
    }
  };

  // Direct term mapping (works at value position when the term IRI matches).
  for (const [name, def] of ctx.terms) {
    if (def && def.id === iri) add(name);
  }
  // Prefix CURIEs: @prefix needed when vocab/document-relative flags apply;
  // at a pure value position an IRI mapping suffices — verify regardless.
  for (const [name, def] of ctx.terms) {
    if (def && typeof def.id === 'string' && iri.startsWith(def.id) && iri !== def.id) {
      add(`${name}:${iri.slice(def.id.length)}`);
    }
  }
  // @vocab suffix.
  if (vocab && ctx.vocab && iri.startsWith(ctx.vocab) && iri !== ctx.vocab) {
    add(iri.slice(ctx.vocab.length));
  }
  // Document-relative forms against @base.
  if (documentRelative && ctx.base) {
    for (const rel of relativize(iri, ctx.base)) add(rel);
  }

  const verified = cands
    .filter(key => safeExpandIri(ctx, key, { vocab, documentRelative }) === iri)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (!verified.includes(iri)) verified.push(iri);
  return verified;
}

function safeExpandIri(ctx, key, opts) {
  try {
    return expandIri(ctx, key, opts);
  } catch {
    return null;
  }
}

// Relative forms of `iri` against base, shortest first; all must be verified
// by the caller through resolveIri (we only suggest syntactic relatives).
function relativize(iri, base) {
  if (!isAbsoluteIri(iri) || !isAbsoluteIri(base)) return [];
  const out = [];

  if (iri === base) { out.push(''); return out; }

  // Simple suffix under the base string (covers base directory + file names).
  if (iri.startsWith(base)) {
    out.push(iri.slice(base.length));
  }

  // RFC-ish: break into scheme/authority/path and offer root-relative and
  // dot-segment relatives against the base directory.
  const b = splitIri(base);
  const t = splitIri(iri);
  if (b && t && b.scheme === t.scheme && b.authority === t.authority) {
    out.push(t.path + t.query + t.fragment); // root-relative
    const baseDir = b.path.slice(0, b.path.lastIndexOf('/') + 1);
    if (t.path.startsWith(baseDir) && t.path !== baseDir) {
      out.push(t.path.slice(baseDir.length) + t.query + t.fragment);
    } else {
      const baseSegs = b.path.split('/').slice(0, -1).filter(Boolean);
      const tSegs = t.path.split('/').filter(Boolean);
      let common = 0;
      while (common < baseSegs.length && common < tSegs.length && baseSegs[common] === tSegs[common]) common++;
      const up = baseSegs.length - common;
      const rest = tSegs.slice(common).join('/');
      const rel = '../'.repeat(up) + rest + t.query + t.fragment;
      if (rel) out.push(rel);
    }
    // Protocol-relative ("//authority…") forms are intentionally NOT offered:
    // they resolve correctly but read as broken URLs in a vocabulary-oriented
    // document. The full IRI stays available as the verified fallback.
  }
  // Prefer shortest; dedupe.
  return [...new Set(out)].sort((a, b) => a.length - b.length);
}

function splitIri(iri) {
  const m = iri.match(/^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!m) return null;
  return { scheme: m[1], authority: m[3] ?? '', path: m[4] ?? '', query: m[5] ?? '', fragment: m[6] ?? '' };
}

// ---------------------------------------------------------------------------
// Keyword aliases
// ---------------------------------------------------------------------------

function chooseAlias(keyword, ctx, path, state, origins) {
  const aliases = [];
  for (const [name, def] of ctx.terms) {
    if (def && def.id === keyword) {
      // An alias used at a structural position must carry no container/type
      // mapping that would reshape the value.
      const clean = !def.container && !def.typeMapping;
      aliases.push({ key: name, clean });
    }
  }
  aliases.sort((a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key));
  const usable = aliases.find(a => a.clean) ?? null;
  const chosen = usable ? usable.key : keyword;

  state.decisions.push({
    kind: 'keyword',
    path,
    keyword,
    compactKey: chosen,
    via: usable ? 'alias' : 'keyword',
    sourceRef: usable ? (origins.get(chosen) ?? null) : null,
    candidates: aliases.map(a => ({
      key: a.key,
      accepted: a === usable,
      reason: a.clean ? undefined : '该别名带有 @container / @type 映射，用于关键字位置会改变结构，故不采用'
    }))
  });
  return { key: chosen };
}

// ---------------------------------------------------------------------------
// Scopes (node-level @context recovery)
// ---------------------------------------------------------------------------

function canonPath(p) {
  return p.replace(/\[\d+\]/g, '[]');
}

// Expanded scope paths are rooted at the document element ("$.prop"), while
// the compaction walk starts from the expanded array ("$[0].prop"). Collapse
// the document-array prefix so the two name the same node.
function scopeKey(p) {
  const c = canonPath(p);
  return c === '$' || c === '$[]' ? '$' : c.replace(/^\$\[\]/, '$');
}

function buildScopeQueues(scopes) {
  const queues = new Map();
  const enqueue = (key, scope) => {
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(scope);
  };
  for (const scope of scopes) {
    const c = scopeKey(scope.outPath);
    enqueue(c, scope);
    if (c.endsWith('[]')) enqueue(c.slice(0, -2), scope);
  }
  return queues;
}

function takeScope(path, state) {
  const c = scopeKey(path);
  const cursor = state.scopeCursor.get(c) ?? 0;
  const queue = state.scopeQueues.get(c);
  if (!queue || cursor >= queue.length) return null;
  state.scopeCursor.set(c, cursor + 1);
  return queue[cursor];
}

// ---------------------------------------------------------------------------
// Provenance helpers
// ---------------------------------------------------------------------------

function buildTermOrigins(chain) {
  const origins = new Map();
  for (const entry of chain) {
    if (entry.kind === 'term' || entry.kind === 'term-override' || entry.kind === 'keyword-alias') {
      if (entry.sourceRef !== undefined) origins.set(entry.term, entry.sourceRef);
    } else if (entry.kind === 'term-cleared') {
      origins.delete(entry.term);
    }
  }
  return origins;
}

function overlayOrigins(base, scopedChain) {
  const merged = new Map(base);
  for (const entry of scopedChain) {
    if (entry.kind === 'term' || entry.kind === 'term-override' || entry.kind === 'keyword-alias') {
      if (entry.sourceRef !== undefined) merged.set(entry.term, entry.sourceRef);
    } else if (entry.kind === 'term-cleared') {
      merged.delete(entry.term);
    }
  }
  return merged;
}

function includesOf(chain) {
  const seen = new Set();
  const out = [];
  for (const entry of chain) {
    if (entry.kind === 'include' && !seen.has(entry.ref)) {
      seen.add(entry.ref);
      out.push({ ref: entry.ref, revision: entry.revision ?? null });
    }
  }
  return out;
}

function describeTerm(name, def) {
  if (!def) return null;
  return {
    name,
    id: def.id,
    container: def.container ?? undefined,
    typeMapping: def.typeMapping ?? undefined,
    language: def.language ?? undefined,
    prefix: def.prefix || undefined,
    protected: def.protected || undefined
  };
}

function stripKey(item, key) {
  if (!(key in item)) return item;
  const copy = { ...item };
  delete copy[key];
  return copy;
}

function cloneJson(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Round-trip verification
// ---------------------------------------------------------------------------

// The expander normalizes a value object's @type into a one-element array
// regardless of input form; normalize both sides so that semantically equal
// documents compare equal, while leaving everything else (node @type arrays)
// untouched. Object keys are also sorted away (JSON object key order carries
// no semantics).
function normalizeForCompare(value) {
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalizeForCompare(value[k]);
    if ('@value' in out && Array.isArray(out['@type']) && out['@type'].length === 1) {
      out['@type'] = out['@type'][0];
    }
    return out;
  }
  return value;
}

function verifyRoundTrip(input, compacted, loader, baseUrl) {
  let reexpanded;
  try {
    reexpanded = expandDocument(compacted, { loader, baseUrl }).expanded;
  } catch (err) {
    return { ok: false, path: '$', expected: safeJson(input), actual: `re-expansion threw: ${err.code ?? err.message}` };
  }
  const mismatch = firstMismatch(input, reexpanded, '$');
  if (mismatch) {
    return { ok: false, ...mismatch };
  }
  return { ok: true };
}

function firstMismatch(a, b, path) {
  if (JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b))) return null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return diff(a, b, path);
    if (a.length !== b.length) return diff(a, b, path);
    for (let i = 0; i < a.length; i++) {
      const m = firstMismatch(a[i], b[i], `${path}[${i}]`);
      if (m) return m;
    }
    return diff(a, b, path);
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a) || !(k in b)) return diff(a, b, `${path}.${k}`);
      const m = firstMismatch(a[k], b[k], `${path}.${k}`);
      if (m) return m;
    }
    return diff(a, b, path);
  }
  return diff(a, b, path);
}

function diff(a, b, path) {
  return { path, expected: safeJson(a), actual: safeJson(b) };
}

function safeJson(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}
