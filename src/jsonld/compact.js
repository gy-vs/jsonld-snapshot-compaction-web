// JSON-LD compaction: the inverse of expand.js, restricted to the semantics
// this workbench supports. The compactor never trusts a pretty name: every
// candidate key/value form is verified by re-expanding a probe document with
// the SAME active context (root bindings + node-scoped local contexts). A
// candidate that does not re-expand to the source expanded data is rejected
// and the field keeps an explicit form that is known to expand correctly.
//
// Like the expander, this module is local-only: it only ever sees contexts
// through the injected snapshot loader. It never derives an IRI from a remote
// resource and never consults a resource "head" — callers pin the snapshot.

import { JsonLdError, ERR } from './errors.js';
import {
  createInitialContext, processContext, isKeyword, looksLikeKeyword
} from './context.js';
import { expandDocument } from './expand.js';
import { isAbsoluteIri } from './iri.js';

const MAX_CANDIDATE_PROBES = 12;

/**
 * Compact one expanded document (the array form produced by expandDocument)
 * against a pinned snapshot.
 *
 * @param {Array} expanded    expanded document (array of node objects)
 * @param {object} opts
 *   loader        snapshot loader (same contract as the expander's)
 *   rootRefs      ordered local: refs that form the compact document's root
 *                 @context, e.g. ['local:schema', 'local:ext']
 *   scopes        Map<shapePath, string[]> node-scoped local refs, derived
 *                 from parse traces (only refs bound in the target snapshot)
 *   baseUrl       document base IRI used by the originating parse
 *   maxContextDepth
 * @returns {{ compact, decisions, warnings, rootContext, verification }}
 */
export function compactDocument(expanded, opts) {
  const env = {
    loader: opts.loader,
    rootRefs: opts.rootRefs ?? [],
    scopes: opts.scopes ?? new Map(),
    baseUrl: opts.baseUrl ?? null,
    maxContextDepth: opts.maxContextDepth ?? 32,
    decisions: [],
    warnings: []
  };
  if (!env.loader) throw new JsonLdError(ERR.VALIDATION, 'A local context loader is required');
  if (!Array.isArray(expanded)) {
    throw new JsonLdError(ERR.VALIDATION, 'Compaction input must be the expanded result (an array of nodes)');
  }

  // Root active context. A scope attached to the root shape is merged into the
  // root @context rather than emitted as a nested one.
  const rootChain = [];
  let rootCtx = createInitialContext();
  if (env.baseUrl) rootCtx.base = env.baseUrl;
  const rootExtra = env.scopes.get('$') ?? [];
  const rootRefsEffective = appendRefs(env.rootRefs, rootExtra);
  if (rootRefsEffective.length) {
    rootCtx = processContext(rootCtx, rootRefsEffective, {
      loader: env.loader, chain: rootChain, maxDepth: env.maxContextDepth, baseUrl: env.baseUrl
    });
  }
  env.warnings.push(...(rootCtx.warnings ?? []));

  const rootState = {
    shape: '$', refs: rootRefsEffective, ctx: rootCtx, chain: rootChain, root: true
  };

  let compact;
  if (expanded.length === 0) {
    compact = rootRefsEffective.length ? { '@context': contextValue(rootRefsEffective) } : {};
  } else if (expanded.length === 1) {
    compact = compactNode(expanded[0], rootState, '$', env, rootRefsEffective);
  } else {
    // Each top-level node carries the root @context itself (a bare array has
    // nowhere else to put it).
    compact = expanded.map((node, i) => {
      const st = childState(rootState, '$[]', env);
      st.emitContext = st.refs;
      return compactNode(node, st, `$[${i}]`, env, st.refs);
    });
  }

  // Belt-and-braces: per-field probes must guarantee this, but verify the
  // whole document once more and refuse to return something misleading.
  const verification = verify(expanded, compact, env);
  if (!verification.ok) {
    throw new JsonLdError(ERR.COMPACTION_CONFLICT,
      'Compaction result does not re-expand to the source expanded document',
      { mismatches: verification.mismatches.slice(0, 5) });
  }

  return {
    compact,
    decisions: env.decisions,
    warnings: env.warnings,
    rootContext: contextValue(rootRefsEffective),
    verification
  };
}

// ---------------------------------------------------------------------------
// Node state: active context at a tree node, including scoped local contexts.
// ---------------------------------------------------------------------------

function appendRefs(parent, extra) {
  const out = [...parent];
  for (const ref of extra) if (!out.includes(ref)) out.push(ref);
  return out;
}

function childState(parent, shape, env) {
  const full = appendRefs(parent.refs, env.scopes.get(norm(shape)) ?? []);
  const delta = full.slice(parent.refs.length);
  const chain = [...parent.chain];
  let ctx = parent.ctx;
  if (delta.length) {
    const scopedChain = [];
    ctx = processContext(ctx, delta, {
      loader: env.loader, chain: scopedChain, maxDepth: env.maxContextDepth
    });
    chain.push(...scopedChain);
  }
  return {
    shape, refs: full, ctx, chain, root: false,
    delta, emitContext: delta
  };
}

function contextValue(refs) {
  if (refs.length === 1) return refs[0];
  return refs;
}

// ---------------------------------------------------------------------------
// Node compaction
// ---------------------------------------------------------------------------

function compactNode(node, st, cPath, env, contextToEmit) {
  const out = {};
  const dataKeys = [];

  // @id first, then @type, then every IRI/keyword property — mirrors the
  // expander's key ordering.
  if ('@id' in node) {
    const { key, value } = compactNodeId(node['@id'], st, cPath, env);
    out[key] = value;
    dataKeys.push(key);
  }
  if ('@type' in node) {
    const { key, value } = compactNodeType(node['@type'], st, cPath, env);
    out[key] = value;
    dataKeys.push(key);
  }

  for (const prop of Object.keys(node)) {
    if (prop === '@id' || prop === '@type') continue;
    const items = node[prop];
    const itemsArr = Array.isArray(items) ? items : [items];
    const propShape = `${st.shape}.${prop}`;

    if (isKeyword(prop)) {
      const key = keywordAlias(st.ctx, prop);
      const childShape = keywordChildShape(st.shape, prop);
      const value = compactKeywordValue(prop, itemsArr, key, st, childShape, env,
        `${cPath}.${key}`);
      out[key] = value;
      dataKeys.push(key);
      env.decisions.push({
        id: `d${env.decisions.length + 1}`,
        kind: 'keyword-property',
        expandedShape: propShape,
        compactShape: norm(`${cPath}.${key}`),
        expandedIri: prop,
        compactKey: key,
        via: key === prop ? 'keyword' : 'keyword-alias',
        resource: attributeTerm(st.chain, key) ?? undefined,
        safe: true,
        reason: key === prop
          ? '关键字原样保留。'
          : `词项 "${key}" 是关键字 ${prop} 的别名，再展开等价；未使用其他别名以保证确定性。`
      });
      continue;
    }

    const chosen = chooseProperty(prop, itemsArr, st, propShape, `${cPath}`, env);
    out[chosen.key] = chosen.value;
    dataKeys.push(chosen.key);
  }

  // Emit the node-scoped @context only for nodes that carry data — an empty
  // node cannot keep a scope meaningful and re-expands away anyway. A scope
  // resolved at a property-array shape and again at its (same-normalized)
  // inner node shape is the same node-scope; record it once.
  if (contextToEmit && contextToEmit.length && dataKeys.length) {
    const withContext = { '@context': contextValue(contextToEmit) };
    for (const [k, v] of Object.entries(out)) withContext[k] = v;
    Object.keys(out).forEach(k => delete out[k]);
    Object.assign(out, withContext);
    if (st.delta?.length) {
      // The same node-scope is reached both as a property's array item (cPath
      // uses the compact key) and as the node's own shape (cPath uses the
      // expanded IRI); dedupe on the expanded shape to record it exactly once.
      const sig = `${st.shape}|${[...st.delta].join(',')}`;
      if (!env.emittedScopes) env.emittedScopes = new Set();
      if (!env.emittedScopes.has(sig)) {
        env.emittedScopes.add(sig);
        env.decisions.push({
          id: `d${env.decisions.length + 1}`,
          kind: 'scoped-context',
          expandedShape: st.shape,
          compactShape: norm(cPath),
          scope: [...st.delta],
          safe: true,
          reason: '该节点在原始解析中拥有节点级 @context；词项仅在此节点及其子树内有效，'
            + '因此保留为局部 @context，不提升到根，避免泄漏给兄弟节点。'
        });
      }
    }
  }

  return out;
}

function keywordChildShape(shape, keyword) {
  if (keyword === '@list') return `${shape}.@list[]`;
  if (keyword === '@graph' || keyword === '@included') return `${shape}.${keyword}[]`;
  return `${shape}.${keyword}[]`;
}

function compactKeywordValue(keyword, items, compactKey, st, childShape, env, cPath) {
  if (keyword === '@index') {
    // @index values are plain strings.
    return items.length === 1 ? items[0] : items;
  }
  const recurse = (item, i, path) => {
    const itemSt = childState(st, childShape, env);
    return compactGenericItem(item, st.ctx.terms.get(compactKey), itemSt, path, env);
  };
  if (keyword === '@list' || keyword === '@graph' || keyword === '@included') {
    const values = items.map((item, i) => recurse(item, i, `${cPath}[${i}]`));
    return values.length === 1 ? values[0] : values;
  }
  // @set / unknown keyword-bearing structures: recurse generically.
  const values = items.map((item, i) => recurse(item, i, `${cPath}[${i}]`));
  return values.length === 1 ? values[0] : values;
}

// ---------------------------------------------------------------------------
// @id / @type compaction (node-level)
// ---------------------------------------------------------------------------

function compactNodeId(iri, st, cPath, env) {
  const key = keywordAlias(st.ctx, '@id');
  const candidates = idValueCandidates(st.ctx, iri);
  const chosen = pickVerified(candidates, (value) => {
    const probe = { [key]: value };
    const expanded = runProbe(st, probe, env);
    return expanded && expanded['@id'] === iri;
  });

  env.decisions.push({
    id: `d${env.decisions.length + 1}`,
    kind: 'node-id',
    expandedShape: `${st.shape}.@id`,
    compactShape: norm(`${cPath}.${key}`),
    expandedIri: '@id',
    compactKey: key,
    via: key === '@id' ? 'keyword' : 'keyword-alias',
    idVia: chosen.via,
    resource: (keywordSource(st.ctx, st.chain, '@id', key)
      ?? (chosen.via === 'prefix' ? attributeTerm(st.chain, chosen.prefix) : null)
      ?? (chosen.via === 'relative' ? attributeBase(st.chain) : null)) ?? undefined,
    safe: true,
    reason: idReason(chosen.via, key),
    candidates: chosen.report
  });
  return { key, value: chosen.value };
}

function compactNodeType(types, st, cPath, env) {
  const key = keywordAlias(st.ctx, '@type');
  // Choose the shortest member form that verifies alone; every member is also
  // re-verified in the combined probe below.
  const memberChoices = types.map(iri => {
    const cands = iriCandidatesAtVocab(st.ctx, iri);
    const ordered = cands.slice().sort(compareCandidates);
    const report = [];
    for (const cand of ordered) {
      const ok = probeType(st, key, cand.key, [iri], env);
      report.push({
        iri, value: cand.key, via: cand.via, prefix: cand.prefix,
        selected: false, usable: ok,
        reason: ok
          ? '该形式单独再展开等于该类型 IRI。'
          : '该形式单独再展开后不等于该类型 IRI，弃用。'
      });
      if (ok) {
        report[report.length - 1].selected = true;
        return { iri, value: cand.key, cand, report };
      }
    }
    throw new JsonLdError(ERR.COMPACTION_CONFLICT,
      `Cannot safely compact type "${iri}" at ${st.shape}: not even the absolute IRI round-trips`,
      { iri });
  });

  let value = memberChoices.length === 1
    ? memberChoices[0].value
    : memberChoices.map(c => c.value);
  let members = memberChoices.map(c => c.report);

  // Combined verification when plural (candidate interaction).
  if (memberChoices.length > 1 && !probeType(st, key, value, types, env)) {
    value = types.slice();
    if (!probeType(st, key, value, types, env)) {
      throw new JsonLdError(ERR.COMPACTION_CONFLICT,
        `Cannot safely compact @type at ${st.shape}`, { types });
    }
    members = types.map(iri => ({
      iri, value: iri, via: 'absolute-iri', selected: true, usable: true,
      reason: '组合再展开失败，回退为绝对 IRI。'
    }));
  }

  env.decisions.push({
    id: `d${env.decisions.length + 1}`,
    kind: 'node-type',
    expandedShape: `${st.shape}.@type`,
    compactShape: norm(`${cPath}.${key}`),
    expandedIri: '@type',
    compactKey: key,
    via: key === '@type' ? 'keyword' : 'keyword-alias',
    safe: true,
    reason: key === '@type'
      ? '节点 @type 使用词项/前缀/@vocab 压缩类型 IRI。'
      : `"${key}" 是 @type 的关键字别名。`,
    members: members.flat()
  });
  return { key, value };
}

function probeType(st, key, value, types, env) {
  const expanded = runProbe(st, { [key]: value }, env);
  return deepEqual(expanded?.['@type'], types);
}

// ---------------------------------------------------------------------------
// Property compaction: rank every candidate key and verify each attempt.
// ---------------------------------------------------------------------------

function chooseProperty(iri, items, st, propShape, cPathBase, env) {
  const candidates = iriCandidatesAtVocab(st.ctx, iri);
  const evaluations = [];
  let probes = 0;

  for (const cand of candidates) {
    const def = cand.via === 'term' ? st.ctx.terms.get(cand.key) : null;
    let attempt = null;
    if (probes < MAX_CANDIDATE_PROBES) {
      attempt = evaluatePropertyCandidate(cand, def, iri, items, st, propShape, cPathBase, env);
      probes += 1;
    }
    evaluations.push({ cand, def, attempt });
  }

  const safe = evaluations.filter(e => e.attempt?.safe);
  if (!safe.length) {
    // No candidate — not even the absolute IRI key with fully explicit
    // values — re-expands identically. The data cannot be expressed under
    // this engine within the current vocabulary (e.g. a datatyped literal
    // whose @type differs from the term's @type coercion, which the expander
    // would reinterpret as a node type). Refuse rather than mislabel it.
    const diffs = evaluations
      .map(e => ({ key: e.cand.key, via: e.cand.via, reason: e.attempt?.diff ?? 'not evaluated' }));
    throw new JsonLdError(ERR.COMPACTION_CONFLICT,
      `Property "${iri}" at ${propShape} cannot be compacted without changing its meaning: ` +
      `every candidate key re-expands to different data under the current context. ` +
      `The field is not representable in a safe compact form (its value semantics conflict ` +
      `with the active term mapping). The expanded result and original input are unchanged.`,
      { iri, path: propShape, kind: 'inexpressible-value', candidates: diffs });
  }
  const rank = { term: 0, 'keyword-alias': 0, prefix: 1, '@vocab': 2, 'absolute-iri': 3 };
  safe.sort((a, b) =>
    (rank[a.cand.via] - rank[b.cand.via]) ||
    (fragmentLength(a.attempt.value) - fragmentLength(b.attempt.value)) ||
    (a.cand.key.localeCompare(b.cand.key)));

  const winner = safe[0];
  const chosenKey = winner.cand.key;

  env.decisions.push({
    id: `d${env.decisions.length + 1}`,
    kind: 'property',
    expandedShape: propShape,
    compactShape: norm(winner.attempt.compactShape),
    expandedIri: iri,
    compactKey: chosenKey,
    via: winner.cand.via,
    form: winner.attempt.form,
    resource: candidateSource(st.ctx, st.chain, winner.cand) ?? undefined,
    scope: st.delta?.length ? [...st.delta] : null,
    safe: true,
    reason: propertyReason(winner, evaluations),
    candidates: evaluations.map(e => describeCandidate(e, winner, probes)),
    notes: winner.attempt.notes
  });

  return { key: chosenKey, value: winner.attempt.value };
}

function fragmentLength(value) {
  return JSON.stringify(value ?? null).length;
}

function describeCandidate(e, winner, probesUsed) {
  const { cand, attempt } = e;
  const base = {
    key: cand.key,
    via: cand.via,
    prefix: cand.prefix,
    resource: cand.resource ?? undefined,
    selected: cand.key === winner.cand.key
  };
  if (!attempt) {
    return { ...base, usable: 'untried', reason: `候选数量超过单次验证上限（${MAX_CANDIDATE_PROBES}），未逐一尝试；不影响已选结果。` };
  }
  if (attempt.safe) {
    if (base.selected) return { ...base, usable: true, reason: attempt.formNote };
    const why = winner.cand.key === cand.key ? ''
      : '该候选也能正确再展开，但选择了更短或优先级更高的名称 ' +
        `"${winner.cand.key}"（${viaLabel(winner.cand.via)}）。`;
    return { ...base, usable: true, reason: why || attempt.formNote };
  }
  return {
    ...base,
    usable: false,
    reason: `采用后再展开与原数据不一致：${attempt.diff}` +
      (attempt.fallbackSafe ? '；已为该名称改用显式形式。' : '')
  };
}

function viaLabel(via) {
  return { term: '词项', 'keyword-alias': '关键字别名', prefix: 'compact IRI 前缀',
    '@vocab': '@vocab 后缀', 'absolute-iri': '绝对 IRI' }[via] ?? via;
}

function propertyReason(winner, evaluations) {
  const rejected = evaluations.filter(e => e.attempt && !e.attempt.safe).length;
  const head = winner.cand.via === 'term'
    ? `词项 "${winner.cand.key}" 直接映射到该 IRI`
    : winner.cand.via === 'keyword-alias'
      ? `"${winner.cand.key}" 是该关键字的别名`
      : winner.cand.via === 'prefix'
        ? `前缀词项 "${winner.cand.prefix}" 映射到 ${winner.cand.prefixId}，拼接后缀得到该 IRI`
        : winner.cand.via === '@vocab'
          ? `该 IRI 位于当前 @vocab 之下，使用其后缀`
          : '没有可用词项，保留绝对 IRI 作为键';
  const form = winner.attempt.formNote ? `；${winner.attempt.formNote}` : '';
  const tail = rejected ? `；${rejected} 个候选经再展开验证后被否决（见候选列表）。` : '。';
  return head + form + tail;
}

function evaluatePropertyCandidate(cand, def, iri, items, st, propShape, cPathBase, env) {
  const compactKey = cand.key;
  const itemShape = `${propShape}[]`;
  const cPath = `${cPathBase}.${compactKey}`;

  // Attempt 1: container/coercion-aware readable form.
  let built;
  try {
    built = buildAwareValue(compactKey, def, items, st, itemShape, cPath, env);
  } catch (err) {
    built = { impossible: err.message };
  }

  if (!built.impossible) {
    const diff = verifyProperty(st, compactKey, built.value, iri, items, env);
    if (diff === null) {
      return { safe: true, value: built.value, form: built.form,
        formNote: built.note, compactShape: built.compactShape, notes: built.notes };
    }
    // Attempt 2: explicit fallback under the same key.
    if (built.allowsExplicitFallback !== false) {
      const fb = buildExplicitValue(compactKey, def, items, st, itemShape, cPath, env, built);
      if (fb) {
        const fbDiff = verifyProperty(st, compactKey, fb.value, iri, items, env);
        if (fbDiff === null) {
          return {
            safe: true, value: fb.value, form: fb.form, formNote: fb.note,
            compactShape: fb.compactShape, diff, fallbackSafe: true,
            notes: ['可读形式未能通过再展开验证（' + diff + '），已保留显式形式。']
          };
        }
        return { safe: false, diff: fbDiff, fallbackSafe: false };
      }
    }
    return { safe: false, diff };
  }

  // The term's own mapping makes the data inexpressible under that key
  // (e.g. an @list-container term used for non-list data).
  return { safe: false, diff: built.impossible };
}

function verifyProperty(st, key, value, iri, items, env) {
  const expanded = runProbe(st, { [key]: value }, env);
  if (!expanded || !(iri in expanded)) {
    return `"${key}" 没有展开为该 IRI（词项映射到其他 IRI、被 @vocab 改写或被丢弃）`;
  }
  if (!deepEqual(expanded[iri], items)) {
    return summarizeValueDiff(items, expanded[iri]);
  }
  const extra = Object.keys(expanded).filter(k => k !== iri);
  if (extra.length) return `产生了额外的展开字段 ${extra.join(', ')}`;
  return null;
}

// ---------------------------------------------------------------------------
// Aware value building: containers and term coercion.
// ---------------------------------------------------------------------------

function buildAwareValue(key, def, items, st, itemShape, cPath, env) {
  const container = def?.container ?? [];
  const notes = [];
  const wrap = (values) => values.length === 1 ? values[0] : values;
  const recurseItems = (list, pathPrefix, shape) =>
    list.map((item, i) => {
      const ist = childState(st, shape, env);
      return compactGenericItem(item, def, ist, `${pathPrefix}[${i}]`, env);
    });

  // @list container ----------------------------------------------------------------
  if (container.includes('@list')) {
    if (items.length !== 1 || !items[0] || typeof items[0] !== 'object' ||
      !('@list' in items[0]) || Object.keys(items[0]).some(k => k !== '@list' && k !== '@index')) {
      return { impossible: '该词项强制 @list 容器，而展开数据不是单个 @list；在该词项下无法表达非列表数据' };
    }
    const listItems = items[0]['@list'];
    const arr = listItems.map((item, i) => {
      const ist = childState(st, `${itemShape}.@list[]`, env);
      return compactGenericItem(item, def, ist, `${cPath}[${i}]`, env);
    });
    return {
      value: wrap(arr), form: 'list-container', allowsExplicitFallback: false,
      compactShape: norm(cPath),
      note: '词项声明了 @container: @list，直接写数组，再展开会自动包回 @list。'
    };
  }

  const unsupportedCombo = container.filter(c => c !== '@set');
  const multi = unsupportedCombo.length > 1;

  // @language map -----------------------------------------------------------------
  if (container.includes('@language') &&
    items.every(it => it && typeof it === 'object' && '@value' in it &&
      typeof it['@value'] === 'string' && '@language' in it)) {
    const map = {};
    for (const it of items) {
      const lang = it['@language'];
      if (lang in map) {
        map[lang] = Array.isArray(map[lang]) ? [...map[lang], it['@value']] : [map[lang], it['@value']];
      } else map[lang] = it['@value'];
    }
    return {
      value: map, form: 'language-map', compactShape: norm(cPath),
      note: '词项声明了 @container: @language，重建为语言映射表。'
    };
  }

  // @index map --------------------------------------------------------------------
  if (container.includes('@index') &&
    items.every(it => it && typeof it === 'object' && !Array.isArray(it) && !('@list' in it) && '@index' in it)) {
    const value = bucketMap(items, it => String(it['@index']), (clone) => { delete clone['@index']; },
      key, def, st, itemShape, cPath, env);
    if (value) {
      return { value, form: 'index-map', compactShape: norm(cPath),
        note: multi ? undefined : '词项声明了 @container: @index，重建为索引映射表。' };
    }
  }

  // @id map -----------------------------------------------------------------------
  if (container.includes('@id') &&
    items.every(it => it && typeof it === 'object' && !Array.isArray(it) && '@id' in it)) {
    const value = bucketMap(items, it => idMapKey(st.ctx, it['@id']), (clone) => { delete clone['@id']; },
      key, def, st, itemShape, cPath, env);
    if (value) {
      return { value, form: 'id-map', compactShape: norm(cPath),
        note: '词项声明了 @container: @id，以节点 @id 作为映射键。' };
    }
  }

  // @type map (only when every node has exactly one @type — the expander appends) -
  if (container.includes('@type') &&
    items.every(it => it && typeof it === 'object' && !Array.isArray(it) &&
      Array.isArray(it['@type']) && it['@type'].length === 1)) {
    const value = bucketMap(items,
      it => shortestVocabForm(st.ctx, it['@type'][0]),
      (clone) => { delete clone['@type']; },
      key, def, st, itemShape, cPath, env);
    if (value) {
      return { value, form: 'type-map', compactShape: norm(cPath),
        note: '词项声明了 @container: @type，以唯一节点类型作为映射键。' };
    }
  }

  if (multi) {
    notes.push(`词项声明了组合容器 ${unsupportedCombo.join(' + ')}，不在安全压缩支持范围内，保留显式形式。`);
    env.warnings.push({
      code: 'compaction explicit',
      message: `Property "${key}" uses unsupported container combination ${unsupportedCombo.join(' + ')}; kept explicit form`
    });
  }

  // plain form --------------------------------------------------------------------
  const values = recurseItems(items, cPath, itemShape);
  return {
    value: wrap(values), form: 'plain', compactShape: norm(cPath), notes
  };
}

// Group expanded items into a container map. `strip` removes the injected key
// from a clone before recursing; @none buckets keep their data untouched.
function bucketMap(items, keyOf, strip, compactKey, def, st, itemShape, cPath, env) {
  const buckets = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  const map = {};
  for (const [k, bucket] of buckets) {
    const values = bucket.map(it => {
      if (k === '@none') return it;
      const clone = JSON.parse(JSON.stringify(it));
      strip(clone);
      return clone;
    }).map((clone, i) => {
      const ist = childState(st, itemShape, env);
      const subPath = `${cPath}.${mapKeyPath(k)}[${i}]`;
      if (k !== '@none' && clone && typeof clone === 'object' && Object.keys(clone).length === 0) {
        // Pure reference whose @id/@type became the map key: the map value must
        // re-expand to a node carrying that key back.
        if ('@id' in bucket[i]) {
          return compactGenericItem({ '@id': bucket[i]['@id'] }, def, ist, subPath, env);
        }
      }
      return compactGenericItem(clone, def, ist, subPath, env);
    });
    map[k] = values.length === 1 ? values[0] : values;
  }
  return map;
}

function mapKeyPath(k) {
  return String(k);
}

function idMapKey(ctx, iri) {
  // @id map keys expand at a document-relative (non-vocab) position.
  return shortestIdForm(ctx, iri).value;
}

// Explicit fallback: expanded-form value objects/arrays, which pass through
// the expander unchanged even beneath a term with mismatched coercion.
function buildExplicitValue(key, def, items, st, itemShape, cPath, env, attempted) {
  if (def?.container?.includes('@list')) return null; // handled as impossible
  const values = items.map((item, i) => {
    const ist = childState(st, itemShape, env);
    return compactGenericItem(item, def, ist, `${cPath}[${i}]`, env, { explicit: true });
  });
  return {
    value: values.length === 1 ? values[0] : values,
    form: describeExplicitForm(items),
    note: '为保证再展开一致，保留了显式的展开形式（值对象/数组/关键字结构未缩短）。',
    compactShape: norm(cPath)
  };
}

function describeExplicitForm(items) {
  if (items.some(it => it && typeof it === 'object' && '@list' in it)) return 'explicit-list';
  if (items.some(it => it && typeof it === 'object' && '@value' in it)) return 'explicit-value-object';
  return 'explicit';
}

// ---------------------------------------------------------------------------
// Item / value-object compaction
// ---------------------------------------------------------------------------

function compactGenericItem(item, def, ist, cPath, env, { explicit = false } = {}) {
  if (item === null) return null;
  if (typeof item !== 'object') {
    // A raw scalar in expanded form should not occur (expansion always wraps
    // scalars), but keep it losslessly.
    return item;
  }
  if (Array.isArray(item)) return item.map((v, i) =>
    compactGenericItem(v, def, ist, `${cPath}[${i}]`, env, { explicit }));

  // explicit @list object
  if ('@list' in item) {
    const inner = item['@list'];
    const listShape = `${ist.shape}.@list[]`;
    const arr = inner.map((v, i) => {
      const lst = childState(ist, listShape, env);
      return compactGenericItem(v, def, lst, `${cPath}.@list[${i}]`, env, { explicit });
    });
    const out = { [keywordAlias(ist.ctx, '@list')]: arr };
    if ('@index' in item) out[keywordAlias(ist.ctx, '@index')] = String(item['@index']);
    return out;
  }

  // value object
  if ('@value' in item) {
    return compactValueObject(item, def, ist, explicit);
  }

  // Pure reference node {@id} under a property term with @id/@vocab coercion
  // compacts to a bare string. Whether that string actually re-expands to the
  // same reference is verified by the enclosing property probe; if it does
  // not, that candidate falls back to the explicit {@id: …} form.
  if (!explicit && def?.typeMapping && (def.typeMapping === '@id' || def.typeMapping === '@vocab') &&
    Object.keys(item).length === 1 && typeof item['@id'] === 'string') {
    return shortestIdForm(ist.ctx, item['@id']).value;
  }

  // node object (including pure references {@id})
  return compactNode(item, ist, cPath, env, ist.emitContext);
}

function compactValueObject(vo, def, ist, explicit) {
  const value = vo['@value'];
  const lang = vo['@language'] ?? null;
  const dtype = vo['@type'] ?? null;
  const ctx = ist.ctx;

  if (!explicit) {
    // Datatype coercion offered by the active term.
    if (dtype && def?.typeMapping === dtype) {
      return value;
    }
    // An @id/@vocab-coercing term turns EVERY string (including an explicit
    // value object) into an IRI reference in this engine. A plain literal
    // under such a term cannot be shortened; keep {@value} so the property
    // probe fails and another key (e.g. the absolute IRI) carries it safely.
    const coercesIri = def?.typeMapping === '@id' || def?.typeMapping === '@vocab';
    if (!dtype && !coercesIri) {
      const effectiveLang = def?.language ?? ctx.language ?? null;
      if (typeof value !== 'string' || lang === effectiveLang) {
        return value;
      }
    }
  }

  const out = { '@value': value };
  if (lang) out['@language'] = lang;
  if (dtype) {
    // Datatype IRIs at a value-object @type position re-expand at the vocab
    // position; a wrong pretty form is caught by the enclosing property probe.
    out['@type'] = explicit ? dtype : shortestVocabForm(ctx, dtype);
  }
  if ('@index' in vo) out['@index'] = String(vo['@index']);
  return out;
}

// ---------------------------------------------------------------------------
// IRI candidate generation
// ---------------------------------------------------------------------------

// Property / type / datatype position (vocab: true).
function iriCandidatesAtVocab(ctx, iri) {
  const out = [];
  const seen = new Set();
  const push = (c) => { if (!seen.has(c.key)) { seen.add(c.key); out.push(c); } };

  for (const [term, def] of ctx.terms) {
    if (def && def.id === iri && validKey(term)) {
      push({ key: term, via: isKeyword(iri) ? 'keyword-alias' : 'term' });
    }
  }
  // Provenance (which include/revision defined a term) is resolved by the
  // caller from the node's decision chain.
  for (const [term, def] of ctx.terms) {
    if (def && typeof def.id === 'string' && def.prefix === true &&
      iri.startsWith(def.id) && iri !== def.id) {
      const suffix = iri.slice(def.id.length);
      if (validSuffix(suffix) && term !== suffix) {
        push({ key: `${term}:${suffix}`, via: 'prefix', prefix: term, prefixId: def.id });
      }
    }
  }
  if (ctx.vocab && iri.startsWith(ctx.vocab) && iri !== ctx.vocab) {
    const suffix = iri.slice(ctx.vocab.length);
    if (validSuffix(suffix) && !ctx.terms.has(suffix) && !suffix.includes(':')) {
      push({ key: suffix, via: '@vocab' });
    }
  }
  push({ key: iri, via: 'absolute-iri' });
  return out;
}

// @id value position (document-relative, vocab: false).
function idValueCandidates(ctx, iri) {
  const out = [];
  const seen = new Set();
  const push = (value, via, extra = {}) => {
    if (typeof value !== 'string' || seen.has(value)) return;
    seen.add(value);
    out.push({ value, via, ...extra });
  };

  if (iri.startsWith('_:')) {
    push(iri, 'blank-node');
    return out;
  }

  if (ctx.base && isAbsoluteIri(iri)) {
    if (iri.startsWith(ctx.base)) {
      const rel = iri.slice(ctx.base.length);
      if (rel && !rel.startsWith('/') && !rel.includes('://')) push(rel, 'relative');
    }
    const rootRel = rootRelative(ctx.base, iri);
    if (rootRel) push(rootRel, 'root-relative');
  }
  for (const [term, def] of ctx.terms) {
    // At a value position a prefix is joined even without @prefix: true.
    if (def && typeof def.id === 'string' && !isKeyword(def.id) &&
      iri.startsWith(def.id) && iri !== def.id) {
      const suffix = iri.slice(def.id.length);
      if (validSuffix(suffix)) push(`${term}:${suffix}`, 'prefix', { prefix: term, prefixId: def.id });
    }
  }
  push(iri, 'absolute-iri');
  return out;
}

function shortestVocabForm(ctx, iri) {
  const c = iriCandidatesAtVocab(ctx, iri)
    .filter(c => c.via !== 'absolute-iri')
    .sort((a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key))[0];
  return c ? c.key : iri;
}

function shortestIdForm(ctx, iri) {
  const all = idValueCandidates(ctx, iri);
  return all.sort((a, b) => a.value.length - b.value.length || a.value.localeCompare(b.value))[0]
    ?? { value: iri, via: 'absolute-iri' };
}

function rootRelative(base, iri) {
  const mb = /^([A-Za-z][A-Za-z0-9+.-]*:)\/\/([^/?#]*)(.*)$/.exec(base);
  const mi = /^([A-Za-z][A-Za-z0-9+.-]*:)\/\/([^/?#]*)(.*)$/.exec(iri);
  if (!mb || !mi) return null;
  if (mb[1].toLowerCase() !== mi[1].toLowerCase() || mb[2].toLowerCase() !== mi[2].toLowerCase()) {
    return null;
  }
  const tail = mi[3] || '';
  return tail.startsWith('/') ? tail : `/${tail}`;
}

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && !looksLikeKeyword(key) &&
    !/\s/.test(key) && key !== '@context';
}

function validSuffix(suffix) {
  return suffix.length > 0 && !/\s/.test(suffix) && !suffix.startsWith('@');
}

// ---------------------------------------------------------------------------
// Keyword aliases
// ---------------------------------------------------------------------------

function keywordAlias(ctx, keyword) {
  const aliases = ctx.keywordAliases.get(keyword);
  if (!aliases || !aliases.length) return keyword;
  return [...aliases].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

function keywordSource(ctx, chain, keyword, chosen) {
  if (chosen === keyword) return null;
  return attributeTerm(chain, chosen);
}

// ---------------------------------------------------------------------------
// Provenance attribution: map a chosen term back to the include + revision
// that defined it by walking the captured decision chain.
// ---------------------------------------------------------------------------

function attributeTerm(chain, term) {
  if (!chain) return null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i];
    if ((e.kind === 'term' || e.kind === 'term-override' || e.kind === 'keyword-alias') &&
      e.term === term) {
      for (let j = i - 1; j >= 0; j--) {
        if (chain[j].kind === 'include') {
          return { ref: chain[j].ref, revision: chain[j].revision ?? null };
        }
      }
      return { ref: null, revision: null, inline: true };
    }
  }
  return null;
}

function attributeBase(chain) {
  if (!chain) return null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i];
    if (e.kind === 'base' && e.value !== null) {
      for (let j = i - 1; j >= 0; j--) {
        if (chain[j].kind === 'include') return { ref: chain[j].ref, revision: chain[j].revision ?? null };
      }
      return { ref: null, revision: null, inline: true };
    }
  }
  return null;
}

function candidateSource(ctx, chain, cand) {
  if (cand.via === 'term' || cand.via === 'keyword-alias') return attributeTerm(chain, cand.key);
  if (cand.via === 'prefix') return attributeTerm(chain, cand.prefix);
  if (cand.via === '@vocab') {
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].kind === 'vocab' && chain[i].value) {
        for (let j = i - 1; j >= 0; j--) {
          if (chain[j].kind === 'include') return { ref: chain[j].ref, revision: chain[j].revision ?? null };
        }
        return { ref: null, revision: null, inline: true };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function runProbe(st, fragment, env) {
  const probeDoc = st.refs.length ? { '@context': contextValue(st.refs), ...fragment } : { ...fragment };
  let result;
  try {
    result = expandDocument(probeDoc, {
      loader: env.loader, baseUrl: env.baseUrl, maxContextDepth: env.maxContextDepth
    });
  } catch {
    return null;
  }
  if (!result.expanded.length) return null;
  return result.expanded[0];
}

function verify(expected, compact, env) {
  let result;
  try {
    result = expandDocument(compact, {
      loader: env.loader, baseUrl: env.baseUrl, maxContextDepth: env.maxContextDepth
    });
  } catch (err) {
    return { ok: false, expanded: null, mismatches: [{ path: '$', message: err.message }] };
  }
  const mismatches = [];
  collectMismatches(expected, result.expanded, '$', mismatches);
  return { ok: mismatches.length === 0, expanded: result.expanded, mismatches };
}

function collectMismatches(expected, actual, path, out) {
  if (out.length > 10) return;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(actual)) { out.push({ path, message: 'expected array' }); return; }
    if (expected.length !== actual.length) {
      out.push({ path, message: `array length ${expected.length} ≙ ${actual.length}` });
      return;
    }
    expected.forEach((v, i) => collectMismatches(v, actual[i], `${path}[${i}]`, out));
    return;
  }
  if (expected === null || typeof expected !== 'object') {
    if (expected !== actual) out.push({ path, message: `${show(expected)} ≠ ${show(actual)}` });
    return;
  }
  if (actual === null || typeof actual !== 'object') {
    out.push({ path, message: `expected object, got ${show(actual)}` });
    return;
  }
  for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!(k in actual)) { out.push({ path: `${path}.${k}`, message: 'missing after re-expansion' }); continue; }
    if (!(k in expected)) { out.push({ path: `${path}.${k}`, message: 'added after re-expansion' }); continue; }
    collectMismatches(expected[k], actual[k], `${path}.${k}`, out);
  }
}

function summarizeValueDiff(expected, actual) {
  if (actual === undefined) return '属性在再展开后消失（值可能被丢弃）';
  if (!Array.isArray(actual)) return '再展开结果不是数组';
  if (actual.length !== expected.length) return `值数量 ${expected.length} ≙ 再展开后 ${actual.length}`;
  for (let i = 0; i < expected.length; i++) {
    const a = expected[i], b = actual[i];
    const ka = kindOf(a), kb = kindOf(b);
    if (ka !== kb) return `第 ${i + 1} 项类型不同（${ka} ≠ ${kb}），词项的 @type/@container 可能改写了值`;
    if (ka === 'value') {
      if (a['@value'] !== b['@value']) return `第 ${i + 1} 项字面值不同`;
      if ((a['@language'] ?? null) !== (b['@language'] ?? null)) return `第 ${i + 1} 项语言标签不同（@language 不匹配）`;
      if ((a['@type'] ?? null) !== (b['@type'] ?? null)) return `第 ${i + 1} 项数据类型不同（@type 不匹配）`;
    } else if (ka === 'reference') {
      if (a['@id'] !== b['@id']) return `第 ${i + 1} 项引用 IRI 不同（@id 解析不一致）`;
    } else if (ka === 'list') {
      const la = a['@list'], lb = b['@list'];
      if (Array.isArray(la) !== Array.isArray(lb) || la.length !== lb.length) return `第 ${i + 1} 项 @list 结构不同`;
    } else {
      const diffs = [];
      collectMismatches(a, b, '$', diffs);
      if (diffs.length) return `第 ${i + 1} 项节点内容不同：${diffs[0].message}`;
    }
  }
  return '再展开后的值与原展开数据不一致';
}

function kindOf(item) {
  if (item === null || typeof item !== 'object') return 'scalar';
  if ('@value' in item) return 'value';
  if ('@list' in item) return 'list';
  if ('@id' in item && Object.keys(item).length === 1) return 'reference';
  return 'node';
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v.slice(0, 40));
  return JSON.stringify(v) ?? String(v);
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

function compareCandidates(a, b) {
  const rank = { term: 0, 'keyword-alias': 0, prefix: 1, '@vocab': 2, 'absolute-iri': 3 };
  return (rank[a.via] - rank[b.via]) ||
    (a.key.length - b.key.length) || a.key.localeCompare(b.key);
}

function pickVerified(candidates, verifyFn) {
  const ordered = candidates.slice().sort((a, b) =>
    (a.value.length - b.value.length) || a.value.localeCompare(b.value));
  // Evaluate EVERY candidate so the decision record can show which other
  // names would have worked and which were unsafe, then take the shortest.
  const results = ordered.map(c => {
    let ok = false;
    try { ok = verifyFn(c.value); } catch { ok = false; }
    return { c, ok };
  });
  const winner = results.find(r => r.ok);
  if (!winner) {
    throw new JsonLdError(ERR.COMPACTION_CONFLICT,
      'No IRI form re-expands to the target value',
      { candidates: candidates.map(c => c.value) });
  }
  const report = results.map(({ c: cc, ok: good }) => ({
    value: cc.value, via: cc.via, prefix: cc.prefix,
    selected: cc.value === winner.c.value,
    usable: good,
    reason: !good
      ? `该形式再展开后不等于目标 IRI（${describeVia(cc.via)} 在此上下文不安全）。`
      : (cc.value === winner.c.value
        ? (cc.via === 'absolute-iri' ? '其他更短形式均不可用，保留绝对 IRI。' : '最短且能正确再展开。')
        : '同样可再展开，但选择了更短的形式。')
  }));
  return {
    value: winner.c.value, via: winner.c.via, prefix: winner.c.prefix,
    report
  };
}

function describeVia(via) {
  return { relative: '@base 相对引用', 'root-relative': '根相对引用', prefix: 'compact IRI 前缀',
    'absolute-iri': '绝对 IRI', 'blank-node': '空白节点标识符' }[via] ?? via;
}

function idReason(via, key) {
  return {
    relative: '@id 使用相对于 @base 的最短引用，再展开解析回原 IRI。',
    'root-relative': '@id 使用同源根相对引用，再展开解析回原 IRI。',
    prefix: '@id 使用 compact IRI 前缀压缩，再展开拼接回原 IRI。',
    'absolute-iri': '当前 @base/前缀无法安全缩短该 @id，保留绝对 IRI。',
    'blank-node': '空白节点标识符原样保留。'
  }[via] ?? '@id 原样保留。';
}

// Normalize array indices: "$.a[0].b" -> "$.a[].b"
export function norm(path) {
  return path.replace(/\[\d+\]/g, '[]');
}

/**
 * Derive node-scoped local contexts from a parse's traces. Expanded property
 * names are arbitrary (often absolute) IRIs, so an outPath cannot be split on
 * "." or ":" — the expanded tree itself guides segment parsing: at each
 * ".KEY" step we pick the node's own key that actually matches the path.
 *
 * @param {Array} expanded   expanded document the traces were produced from
 * @param {Array} traces     parse traces
 * @param {Array} rootChain  document-level decision chain
 * @returns {Map<string,string[]>} normalized node shape -> scoped local refs
 */
export function deriveScopes(expanded, traces, rootChain) {
  // Ordered document-level include sequence. A node's visible chain is the
  // root sequence followed by one include per node-scoped @context (that
  // resource may itself nest further includes, which stay attached to it).
  // Because the root sequence is always an exact ordered prefix, stripping
  // it leaves exactly the scoped refs declared on ancestor nodes.
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
    // Only the ref(s) declared directly as node-scoped @context belong in the
    // emitted local @context. Includes nested INSIDE such a resource (the
    // entries after its own include) are resolved by the loader automatically
    // and must not be re-emitted. With one node-scope that is the first tail
    // entry; multiple scoped contexts on the same node are rare, and each
    // declared scoped resource is followed only by its own nested includes,
    // which we cannot separate without resource metadata — conservatively
    // keep just the first declared ref per scope (the common case).
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
export function ownerShapeFor(expanded, outPath) {
  let rest = outPath.startsWith('$') ? outPath.slice(1) : outPath;
  const nodeStack = []; // { shape } for each plain object the path descends into
  let cur, shape;
  // Single-root documents address properties as "$.prop"; array documents
  // address them as "$[i].prop". Seed the walk accordingly.
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

    // Guided key choice: a key of the current node that matches the path and
    // is followed by a structural boundary ('.', '[' or end). Longest match
    // wins when keys are prefixes of one another.
    let best = null;
    for (const k of (cur && !Array.isArray(cur) ? Object.keys(cur) : [])) {
      if (rest.length === k.length + 1 && rest === '.' + k) { best = longer(best, k); continue; }
      const ch = rest[k.length + 1];
      if (rest.startsWith('.' + k) && (ch === '.' || ch === '[')) best = longer(best, k);
    }
    if (best === null) return null;

    const isLastKey = rest.length === best.length + 1;
    if (isLastKey) {
      // The final segment is the trace's own property/keyword.
      const owner = nodeStack.at(-1)?.shape ?? '$';
      return { shape: owner, finalKey: best };
    }
    cur = cur?.[best];
    shape += '.' + best;
    rest = rest.slice(best.length + 1);
  }
  return null;
}

function longer(a, b) { return a === null || b.length > a.length ? b : a; }
