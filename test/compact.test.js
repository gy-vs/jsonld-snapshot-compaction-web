// Unit tests for safe compaction: every compacted form must re-expand to the
// same expanded data against the same pinned snapshot, and unsafe shortenings
// must be refused in favor of explicit, still-correct shapes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expandDocument } from '../src/jsonld/expand.js';
import { compactDocument } from '../src/jsonld/compact.js';
import { createSnapshotLoader } from '../src/jsonld/loader.js';

function snapshot(resources) {
  return new Map(Object.entries(resources).map(
    ([name, body]) => [name, { revision: `rev_${name}`, body }]
  ));
}

// Key-order-insensitive, @type-array-normalized semantic equality.
function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    if ('@value' in o && Array.isArray(o['@type']) && o['@type'].length === 1) {
      o['@type'] = o['@type'][0];
    }
    return o;
  }
  return v;
}

function roundTrip(doc, resources, opts = {}) {
  const map = snapshot(resources);
  const loader = createSnapshotLoader(map);
  const parsed = expandDocument(doc, { loader, baseUrl: opts.baseUrl ?? null });
  const result = compactDocument(parsed.expanded, {
    loader,
    rootContext: parsed.rootContext,
    scopes: parsed.scopes,
    baseUrl: opts.baseUrl ?? null
  });
  const reexpanded = expandDocument(result.compacted, {
    loader, baseUrl: opts.baseUrl ?? null
  });
  return {
    parsed, result, again: reexpanded,
    equal: JSON.stringify(norm(parsed.expanded)) === JSON.stringify(norm(reexpanded.expanded))
  };
}

describe('term and alias selection', () => {
  const resources = {
    vocab: {
      '@vocab': 'https://schema.org/',
      'id': '@id', 'kind': '@type',
      'created': { '@id': 'dateCreated' },
      'https://schema.org/url': { '@id': 'url' }
    }
  };

  test('uses readable terms, keyword aliases and drops the array of one', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:vocab', 'id': 'p1', 'kind': 'Product', 'created': 'now' },
      resources
    );
    assert.ok(equal);
    assert.equal(result.compacted.id, 'p1');
    assert.equal(result.compacted.kind, 'Product'); // single type scalarized
    assert.equal(result.compacted.created, 'now');
    assert.ok(!('@type' in result.compacted));
  });

  test('a term whose IRI is an absolute IRI still resolves to a readable key', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:vocab', 'https://schema.org/url': 'http://x.example/' },
      resources
    );
    assert.ok(equal);
    assert.equal(result.compacted['https://schema.org/url'], 'http://x.example/');
  });

  test('multiple @type values stay an array', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:vocab', '@type': ['Product', 'Thing'] },
      resources
    );
    assert.ok(equal);
    assert.deepEqual(result.compacted.kind, ['Product', 'Thing']);
  });

  test('decision records the chosen term and rejected candidates', () => {
    const { result } = roundTrip(
      { '@context': 'local:vocab', 'created': 'now' },
      resources
    );
    const dec = result.decisions.find(d => d.kind === 'property' && d.expandedIri === 'https://schema.org/dateCreated');
    assert.equal(dec.compactKey, 'created');
    assert.equal(dec.via, 'term');
    assert.ok(dec.candidates.some(c => c.key === 'created' && c.accepted));
    assert.ok(dec.candidates.some(c => c.key === 'dateCreated' && c.via === 'vocab'));
  });
});

describe('prefixes, @vocab suffixes and @base-relative ids', () => {
  const resources = {
    c: {
      '@base': 'https://example.com/things/',
      '@vocab': 'https://schema.org/',
      'xsd': { '@id': 'http://www.w3.org/2001/XMLSchema#', '@prefix': true }
    }
  };

  test('datatype is compacted via the prefix term', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:c', 'https://schema.org/d': [{ '@value': '2026-01-01', '@type': 'http://www.w3.org/2001/XMLSchema#date' }] },
      resources
    );
    assert.ok(equal);
    assert.deepEqual(result.compacted['https://schema.org/d'], { '@value': '2026-01-01', '@type': 'xsd:date' });
  });

  test('@id values are shortened against @base and re-resolve identically', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:c', '@id': 'https://example.com/things/widget/42' },
      resources
    );
    assert.ok(equal);
    assert.equal(result.compacted['@id'], 'widget/42');
  });

  test('root-relative id compacts to /path and re-resolves to the same IRI', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:c', '@id': 'https://example.com/about' },
      resources
    );
    assert.ok(equal);
    assert.equal(result.compacted['@id'], '/about');
  });
});

describe('containers round-trip', () => {
  const resources = {
    c: {
      '@vocab': 'https://v/',
      'name': { '@id': 'name', '@container': '@language' },
      'seq': { '@id': 'seq', '@container': '@list' },
      'items': { '@id': 'items', '@container': '@index' },
      'byId': { '@id': 'byId', '@container': '@id' },
      'byType': { '@id': 'byType', '@container': '@type' }
    }
  };

  test('language map', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:c', 'name': { en: 'Hello', de: 'Hallo' } }, resources);
    assert.ok(equal);
    assert.deepEqual(result.compacted.name, { en: 'Hello', de: 'Hallo' });
  });

  test('list stays an array even with one element', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:c', 'seq': ['only'] }, resources);
    assert.ok(equal);
    assert.deepEqual(result.compacted.seq, ['only']);
  });

  test('index map removes @index and restores it on re-expansion', () => {
    const { result, again, equal } = roundTrip(
      { '@context': 'local:c', 'items': { first: { label: 'A' } } }, resources);
    assert.ok(equal);
    assert.deepEqual(result.compacted.items, { first: { label: 'A' } });
    assert.equal(again.expanded[0]['https://v/items'][0]['@index'], 'first');
  });

  test('id map keys become compact node ids', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:c', 'byId': { 'https://x/1': { label: 'one' } } }, resources);
    assert.ok(equal);
    assert.ok(result.compacted.byId['https://x/1']);
  });

  test('type map key is removed from the node and appended back', () => {
    const { result, again, equal } = roundTrip(
      { '@context': 'local:c', 'byType': { Product: { label: 'p' } } }, resources);
    assert.ok(equal);
    assert.deepEqual(result.compacted.byType, { Product: { label: 'p' } });
    assert.deepEqual(again.expanded[0]['https://v/byType'][0]['@type'], ['https://v/Product']);
  });
});

describe('coercion safety', () => {
  const resources = {
    c: {
      '@vocab': 'https://v/',
      'home': { '@id': 'home', '@type': '@id' },
      'vocabRef': { '@id': 'vr', '@type': '@vocab' },
      'when': { '@id': 'when', '@type': 'xsd:date' },
      'xsd': { '@id': 'http://www.w3.org/2001/XMLSchema#', '@prefix': true }
    }
  };

  test('@id-coerced reference scalarizes to a relative form', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:c', 'home': 'about' }, resources,
      { baseUrl: 'https://b/' });
    assert.ok(equal);
    assert.equal(result.compacted.home, 'about');
  });

  test('@vocab-coerced reference scalarizes when a vocab form exists', () => {
    const { result, equal } = roundTrip(
      { '@context': 'local:c', 'vocabRef': 'SomeType' }, resources);
    assert.ok(equal);
    assert.equal(result.compacted.vocabRef, 'SomeType');
  });

  test('typed literal scalarizes through the term coercion', () => {
    const { result, again, equal } = roundTrip(
      { '@context': 'local:c', 'when': '2026-01-01' }, resources);
    assert.ok(equal);
    assert.equal(result.compacted.when, '2026-01-01');
    assert.equal(again.expanded[0]['https://v/when'][0]['@type'][0],
      'http://www.w3.org/2001/XMLSchema#date');
  });
});

describe('unsafe shortenings are refused but the document stays valid', () => {
  const resources = {
    c: {
      '@vocab': 'https://v/', '@language': 'en',
      'plain': { '@id': 'plain' },
      'deTerm': { '@id': 'deTerm', '@language': 'de' }
    }
  };

  test('a language-tagged value that no term can restore stays explicit', () => {
    // de-tagged literal under a plain term (default language en): a bare
    // scalar through "plain" would re-expand to @language en, so the engine
    // must keep the explicit value object under a safe (full-IRI) property.
    const expanded = [{ 'https://v/plain': [{ '@value': 'hallo', '@language': 'de' }] }];
    const map = snapshot(resources);
    const loader = createSnapshotLoader(map);
    const { compacted, decisions } = compactDocument(expanded, { loader, rootContext: 'local:c', scopes: [] });
    const again = expandDocument(compacted, { loader });
    assert.deepEqual(norm(again.expanded), norm(expanded));
    // The de-tag must survive explicitly somewhere in the output.
    assert.match(JSON.stringify(compacted), /@language/);
    assert.match(JSON.stringify(compacted), /de/);
    assert.ok(decisions.some(d => d.kind === 'property'));
  });

  test('a datatype the term does not carry is kept as an explicit value object', () => {
    const expanded = [{ 'https://v/plain': [{ '@value': 1 }] }];
    const map = snapshot(resources);
    const loader = createSnapshotLoader(map);
    const { compacted } = compactDocument(expanded, { loader, rootContext: 'local:c', scopes: [] });
    const again = expandDocument(compacted, { loader });
    assert.deepEqual(norm(again.expanded), norm(expanded));
  });
});

describe('node-local @context scoping', () => {
  const resources = {
    root: { '@vocab': 'https://root/' },
    sub: { '@vocab': 'https://sub/', 'label': '@id' }
  };

  test('the scope is placed back on exactly the node it belonged to', () => {
    const doc = {
      '@context': 'local:root',
      'a': { '@context': 'local:sub', 'label': 'x' },
      'b': { 'siblingOnly': 1 }
    };
    const { result, equal } = roundTrip(doc, resources);
    assert.ok(equal);
    assert.equal(result.compacted.a['@context'], 'local:sub');
    // sibling b must not carry the sub context; its property stays root-scoped
    assert.ok(!('@context' in result.compacted.b));
    assert.equal(result.compacted.b.siblingOnly, 1);
  });

  test('scope decision names the resource revision it activates', () => {
    const doc = { '@context': 'local:root', 'a': { '@context': 'local:sub', 'label': 'x' } };
    const { result } = roundTrip(doc, resources);
    const scope = result.decisions.find(d => d.kind === 'scope');
    assert.ok(scope);
    assert.deepEqual(scope.includes, [{ ref: 'local:sub', revision: 'rev_sub' }]);
  });

  test('sibling nodes do not inherit a scoped vocabulary', () => {
    const doc = {
      '@context': 'local:root',
      'a': { '@context': 'local:sub', 'subProp': 1 },
      'sibling': { 'subProp': 1 }
    };
    const { result, equal, again } = roundTrip(doc, resources);
    assert.ok(equal);
    // inside the scope subProp is read against https://sub/; outside against https://root/
    assert.equal(result.compacted.a.subProp, 1);
    assert.equal(result.compacted.sibling.subProp, 1);
    assert.equal(again.expanded[0]['https://root/a'][0]['https://sub/subProp'][0]['@value'], 1);
    assert.equal(again.expanded[0]['https://root/sibling'][0]['https://root/subProp'][0]['@value'], 1);
  });
});

describe('revision provenance', () => {
  test('term decisions attribute the term to the resource that defined it', () => {
    const resources = {
      schema: { '@vocab': 'https://s/', 'name': 'name' },
      ext: { '@context': 'local:schema', 'priority': { '@id': 'https://e/p' } }
    };
    const { result } = roundTrip(
      { '@context': ['local:schema', 'local:ext'], 'name': 'n', 'priority': 'p' },
      resources
    );
    const nameDec = result.decisions.find(d => d.kind === 'property' && d.compactKey === 'name');
    const prioDec = result.decisions.find(d => d.kind === 'property' && d.compactKey === 'priority');
    assert.equal(nameDec.sourceRef, 'local:schema');
    assert.equal(prioDec.sourceRef, 'local:ext');
  });
});

describe('compact provenance layout for the UI', () => {
  test('scopeLayout exposes raw node contexts with include revisions', () => {
    const resources = { root: { '@vocab': 'https://r/' }, sub: { '@vocab': 'https://s/' } };
    const { result } = roundTrip(
      { '@context': 'local:root', 'nested': { '@context': 'local:sub', 'x': 1 } },
      resources
    );
    assert.equal(result.scopeLayout[0].raw, 'local:sub');
    assert.equal(result.scopeLayout[0].includes[0].revision, 'rev_sub');
  });
});
