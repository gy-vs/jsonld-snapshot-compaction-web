// Unit tests for compaction: terms/aliases/prefixes/vocab, containers,
// scoped contexts with sibling isolation, semantic-trap refusal, and
// round-trip verification. All contexts are local resources.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expandDocument } from '../src/jsonld/expand.js';
import { createSnapshotLoader } from '../src/jsonld/loader.js';
import { compactDocument, deriveScopes, ownerShapeFor } from '../src/jsonld/compact.js';
import { runCompact } from '../src/compact-service.js';
import { ERR } from '../src/jsonld/errors.js';

function snapshot(resources) {
  return new Map(Object.entries(resources).map(
    ([name, body]) => [name, { revision: `rev_${name}`, body }]
  ));
}
function loaderOf(resources) { return createSnapshotLoader(snapshot(resources)); }

function roundtrip(doc, resources, { baseUrl = null } = {}) {
  const map = snapshot(resources);
  const loader = createSnapshotLoader(map);
  const parsed = expandDocument(doc, { loader, baseUrl });
  const rootContext = Array.isArray(doc['@context']) ? doc['@context']
    : (typeof doc['@context'] === 'string' ? [doc['@context']] : []);
  const scopes = deriveScopes(parsed.expanded, parsed.traces, parsed.decisionChain);
  const result = compactDocument(parsed.expanded, { loader, rootRefs: rootContext, scopes, baseUrl });
  // Re-expand the compact document with the same snapshot — must be identical.
  const reparsed = expandDocument(result.compact, { loader, baseUrl });
  assert.deepEqual(reparsed.expanded, parsed.expanded,
    'compact document must re-expand to the same expanded data');
  return { parsed, result };
}

describe('basic term / vocab / prefix / keyword-alias compaction', () => {
  const resources = {
    vocab: {
      '@base': 'https://example.com/things/',
      '@vocab': 'https://schema.org/',
      'xsd': { '@id': 'http://www.w3.org/2001/XMLSchema#', '@prefix': true },
      'created': { '@id': 'dateCreated', '@type': 'xsd:date' },
      'identifier': '@id', 'kind': '@type',
      'homepage': { '@id': 'url', '@type': '@id' }
    }
  };

  test('uses term, keyword aliases, datatype coercion and relative @id', () => {
    const doc = {
      '@context': 'local:vocab',
      'identifier': 'widget/42',
      'kind': 'Product',
      'created': '2026-09-26',
      'homepage': '/about',
      'anything': 'x'
    };
    const { result } = roundtrip(doc, resources);
    const c = result.compact;
    assert.equal(c.identifier, 'widget/42');
    assert.equal(c.kind, 'Product');
    assert.equal(c.created, '2026-09-26');       // xsd:date coercion elides @type
    assert.equal(c.homepage, '/about');
    assert.equal(c.anything, 'x');              // @vocab suffix
    assert.ok(result.verification.ok);
  });

  test('multiple terms for one IRI: a valid term is chosen and alternatives reported', () => {
    const r = {
      v: { '@vocab': 'https://v/', 'title': 'name', 'name': 'name' }
    };
    const doc = { '@context': 'local:v', 'title': 'Hi' };
    const { result } = roundtrip(doc, r);
    const d = result.decisions.find(d => d.expandedIri === 'https://v/name');
    assert.ok(['title', 'name'].includes(d.compactKey));
    const keys = d.candidates.map(c => c.key);
    assert.ok(keys.includes('title') && keys.includes('name'));
    assert.equal(d.candidates.filter(c => c.selected).length, 1);
  });

  test('@vocab property keeps suffix; absolute IRI remains when no term/vocab covers it', () => {
    const r = { v: { '@vocab': 'https://v/' } };
    const { result } = roundtrip({ '@context': 'local:v', 'covered': 1 }, r);
    assert.equal(result.compact.covered, 1);

    const map = snapshot(r);
    const loader = createSnapshotLoader(map);
    const expanded = [{ 'https://other.example/p': [{ '@value': 2 }] }];
    const out = compactDocument(expanded, { loader, rootRefs: [] });
    assert.ok(out.compact['https://other.example/p']);
  });

  test('cross-origin @id is not shortened; same-origin @id becomes relative', () => {
    const r = { v: { '@base': 'https://a.example/things/', '@vocab': 'https://v/' } };
    {
      const map = snapshot(r);
      const loader = createSnapshotLoader(map);
      const out = compactDocument(
        [{ '@id': 'https://b.example/x', 'https://v/p': [{ '@value': 1 }] }],
        { loader, rootRefs: ['local:v'] });
      assert.equal(out.compact['@id'], 'https://b.example/x');
    }
    {
      const map = snapshot(r);
      const loader = createSnapshotLoader(map);
      const out = compactDocument(
        [{ '@id': 'https://a.example/things/w/2', 'https://v/p': [{ '@value': 1 }] }],
        { loader, rootRefs: ['local:v'] });
      assert.equal(out.compact['@id'], 'w/2');
    }
  });
});

describe('containers round-trip into readable maps', () => {
  test('@language container -> language map', () => {
    const r = { c: { '@vocab': 'https://v/', 'name': { '@id': 'name', '@container': '@language' } } };
    const { result } = roundtrip({ '@context': 'local:c', 'name': { en: 'Hi', de: 'Hallo' } }, r);
    assert.deepEqual(result.compact.name, { en: 'Hi', de: 'Hallo' });
    assert.equal(result.decisions.find(d => d.form === 'language-map')?.compactKey, 'name');
  });

  test('@index container -> index map', () => {
    const r = { c: { '@vocab': 'https://v/', 'items': { '@id': 'items', '@container': '@index' } } };
    const doc = { '@context': 'local:c', 'items': { first: { label: 'A' }, second: { label: 'B' } } };
    const { result } = roundtrip(doc, r);
    assert.deepEqual(Object.keys(result.compact.items).sort(), ['first', 'second']);
  });

  test('@id container -> id map keyed by node @id', () => {
    const r = { c: { '@vocab': 'https://v/', 'm': { '@id': 'm', '@container': '@id' } } };
    const doc = { '@context': 'local:c', 'm': { 'https://x/1': { label: 'one' } } };
    const { result } = roundtrip(doc, r);
    assert.ok(result.compact.m['https://x/1']);
  });

  test('@type container -> type map', () => {
    const r = { c: { '@vocab': 'https://v/', 'm': { '@id': 'm', '@container': '@type' } } };
    const doc = { '@context': 'local:c', 'm': { Product: { label: 'p' } } };
    const { result } = roundtrip(doc, r);
    assert.ok(result.compact.m.Product);
  });

  test('@list container -> bare array', () => {
    const r = { c: { '@vocab': 'https://v/', 'seq': { '@id': 'seq', '@container': '@list' } } };
    const { result } = roundtrip({ '@context': 'local:c', 'seq': ['a', 'b'] }, r);
    assert.deepEqual(result.compact.seq, ['a', 'b']);
  });
});

describe('scoped contexts and sibling isolation', () => {
  const resources = {
    root: { '@vocab': 'https://root/' },
    left: { '@context': 'local:root', 'onlyLeft': 'https://left/onlyLeft' },
    right: { '@context': 'local:root', 'onlyRight': 'https://right/onlyRight' }
  };

  test('node-scoped @context is emitted locally and never lifted to siblings', () => {
    const doc = {
      '@context': 'local:root',
      'a': { '@context': 'local:left', 'onlyLeft': 1 },
      'b': { '@context': 'local:right', 'onlyRight': 2 }
    };
    const { result } = roundtrip(doc, resources);
    assert.equal(result.compact.a['@context'], 'local:left');
    assert.equal(result.compact.a.onlyLeft, 1);
    assert.equal(result.compact.b['@context'], 'local:right');
    assert.equal(result.compact.b.onlyRight, 2);
    // onlyLeft must NOT exist as a key on b/root
    assert.equal(result.compact.b.onlyLeft, undefined);
    const scoped = result.decisions.filter(d => d.kind === 'scoped-context');
    assert.equal(scoped.length, 2);
  });

  test('deriveScopes maps a trace to the owning node shape via the expanded tree', () => {
    const map = snapshot(resources);
    const loader = createSnapshotLoader(map);
    const parsed = expandDocument(
      { '@context': 'local:root', 'a': { '@context': 'local:left', 'onlyLeft': 1 } },
      { loader });
    const scopes = deriveScopes(parsed.expanded, parsed.traces, parsed.decisionChain);
    const keys = [...scopes.keys()];
    assert.ok(keys.some(k => k.endsWith('[]')));
    assert.deepEqual([...scopes.values()][0], ['local:left']);
  });

  test('ownerShapeFor resolves IRI keys containing dots', () => {
    const expanded = [{ 'https://a.example/x.y': [{ 'https://b.example/z': [{ '@value': 1 }] }] }];
    const owner = ownerShapeFor(expanded, '$.https://a.example/x.y[].https://b.example/z');
    assert.match(owner.shape, /^\$\.https:\/\/a\.example\/x\.y\[\]$/);
  });
});

describe('semantic traps: shortening that would change meaning is refused', () => {
  test('@list-container term is not used for plain (non-list) data', () => {
    const r = { c: { '@vocab': 'https://v/', 'seq': { '@id': 'seq', '@container': '@list' } } };
    const map = snapshot(r);
    const loader = createSnapshotLoader(map);
    const expanded = [{ 'https://v/seq': [{ '@value': 'a' }] }];
    const out = compactDocument(expanded, { loader, rootRefs: ['local:c'] });
    // key is the absolute IRI; value stays explicit (NOT seq:"a", which would
    // wrap in @list on re-expansion)
    assert.ok(out.compact['https://v/seq']);
    assert.equal(out.compact.seq, undefined);
    assert.ok(out.verification.ok);
  });

  test('@id-coercion term keeps an explicit value object (a bare string would coerce)', () => {
    const r = { c: { '@vocab': 'https://v/', 'ref': { '@id': 'ref', '@type': '@id' } } };
    const map = snapshot(r);
    const loader = createSnapshotLoader(map);
    const expanded = [{ 'https://v/ref': [{ '@value': 'http://x/1' }] }];
    const out = compactDocument(expanded, { loader, rootRefs: ['local:c'] });
    // An explicit value object survives (the engine only coerces bare strings
    // under an @id term). The compactor must NOT turn this into ref:"http://x/1",
    // which would re-expand to {@id:…}.
    assert.deepEqual(out.compact.ref, { '@value': 'http://x/1' });
    assert.notEqual(out.compact.ref, 'http://x/1');
    assert.ok(out.verification.ok);
  });

  test('non-default @language value keeps an explicit value object', () => {
    const r = { c: { '@language': 'en', '@vocab': 'https://v/' } };
    const map = snapshot(r);
    const loader = createSnapshotLoader(map);
    const expanded = [{ 'https://v/name': [{ '@value': 'Hallo', '@language': 'de' }] }];
    const out = compactDocument(expanded, { loader, rootRefs: ['local:c'] });
    assert.deepEqual(out.compact.name, { '@value': 'Hallo', '@language': 'de' });
  });

  test('a value the engine cannot express safely throws a classified compaction conflict', () => {
    const r = { c: {
      '@vocab': 'https://v/',
      'n': { '@id': 'n', '@type': 'http://www.w3.org/2001/XMLSchema#integer' }
    } };
    const map = snapshot(r);
    const loader = createSnapshotLoader(map);
    const expanded = [{ 'https://v/n': [{
      '@value': '5', '@type': 'http://www.w3.org/2001/XMLSchema#string'
    }] }];
    assert.throws(
      () => compactDocument(expanded, { loader, rootRefs: ['local:c'] }),
      err => err.code === ERR.COMPACTION_CONFLICT && err.details.kind === 'inexpressible-value'
    );
  });
});

describe('runCompact service', () => {
  test('refuses an unbound root ref instead of silently fetching it', () => {
    const map = snapshot({ v: { '@vocab': 'https://v/' } });
    assert.throws(
      () => runCompact({ expanded: [{ '@id': 'x' }], snapshotMap: map, rootRefs: ['local:missing'] }),
      err => err.code === ERR.UNKNOWN_RESOURCE && err.details.ref === 'local:missing'
    );
  });

  test('drops a node scope that is not bound in the target snapshot', () => {
    const resources = { v: { '@vocab': 'https://v/' }, extra: { '@vocab': 'https://e/' } };
    const map = snapshot(resources);
    // Target context binds only "v"; a scope referencing "extra" is not legal
    // there and must be dropped rather than fetched.
    const out = runCompact({
      expanded: [{ '@id': 'x' }],
      snapshotMap: new Map([['v', map.get('v')]]),
      rootRefs: ['local:v'],
      scopes: { '$.p[]': ['local:extra'] }
    });
    assert.deepEqual(out.droppedScopes, [{ shape: '$.p[]', ref: 'local:extra' }]);
    assert.ok(out.verification.ok);
  });
});
