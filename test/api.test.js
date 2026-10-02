// HTTP API integration tests, including concurrent editing from two "pages".
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

let server, base, store;

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-api-'));
  store = new Store(join(dir, 'store.json'));
  server = createApp({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe('resources API', () => {
  test('seeds demo resources on an empty store', async () => {
    const { status, json } = await api('GET', '/api/resources');
    assert.equal(status, 200);
    const names = json.resources.map(r => r.name);
    assert.ok(names.includes('schema') && names.includes('secure'));
  });

  test('PUT creates, GET reads back, revisions listed', async () => {
    const create = await api('PUT', '/api/resources/colors', {
      body: { '@vocab': 'https://colors.example/' },
      baseRevision: null
    });
    assert.equal(create.status, 200);
    assert.equal(create.json.created, true);

    const got = await api('GET', '/api/resources/colors');
    assert.equal(got.json.body['@vocab'], 'https://colors.example/');
    assert.equal(got.json.revisionCount, 1);

    const update = await api('PUT', '/api/resources/colors', {
      body: { '@vocab': 'https://colors.example/v2/' },
      baseRevision: got.json.latestRevision
    });
    assert.equal(update.status, 200);
    const got2 = await api('GET', '/api/resources/colors');
    assert.equal(got2.json.revisionCount, 2);
  });

  test('concurrent edits: first save wins, second gets 409 revision conflict', async () => {
    await api('PUT', '/api/resources/race', { body: { v: 0 }, baseRevision: null });
    const { json: before } = await api('GET', '/api/resources/race');
    const baseRev = before.latestRevision;

    // Two pages save diverging bodies based on the same revision.
    const [a, b] = await Promise.all([
      api('PUT', '/api/resources/race', { body: { v: 'A' }, baseRevision: baseRev }),
      api('PUT', '/api/resources/race', { body: { v: 'B' }, baseRevision: baseRev })
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const loser = a.status === 409 ? a : b;
    assert.equal(loser.json.error.code, 'revision conflict');
    assert.ok(loser.json.error.details.currentRevision);

    // Loser merges on top of the winner and succeeds.
    const retry = await api('PUT', '/api/resources/race', {
      body: { v: 'B-merged' },
      baseRevision: loser.json.error.details.currentRevision
    });
    assert.equal(retry.status, 200);
    const final = await api('GET', '/api/resources/race');
    assert.equal(final.json.body.v, 'B-merged');
    assert.equal(final.json.revisionCount, 3);
  });

  test('update without baseRevision is rejected (no silent last-write-wins)', async () => {
    await api('PUT', '/api/resources/guard', { body: { v: 1 }, baseRevision: null });
    const res = await api('PUT', '/api/resources/guard', { body: { v: 2 } });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'revision conflict');
  });
});

describe('parse API', () => {
  test('ad-hoc parse expands and returns traces + decision chain', async () => {
    const res = await api('POST', '/api/parse', {
      document: {
        '@context': 'local:schema',
        'id': 'thing/7',
        'kind': 'Product',
        'created': '2026-09-26'
      },
      bindings: { schema: 'latest' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.expanded[0]['@id'], 'https://example.com/things/thing/7');
    assert.deepEqual(res.json.expanded[0]['@type'], ['https://schema.org/Product']);
    assert.ok(res.json.traces.some(t => t.sourcePath === '$.id' && t.kind === 'node-id'));
    assert.ok(res.json.decisionChain.some(c => c.kind === 'include' && c.ref === 'local:schema' && c.revision));
    assert.equal(res.json.pinnedResources.schema, res.json.decisionChain.find(c => c.kind === 'include').revision);
  });

  test('remote http context is refused with a clear error', async () => {
    const res = await api('POST', '/api/parse', {
      document: { '@context': 'https://schema.org/docs/jsonldcontext.jsonld', 'name': 'x' },
      bindings: {}
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'loading remote context failed');
    assert.match(res.json.error.message, /never accesses the public network/);
  });

  test('unknown local resource reports 404 with known resources', async () => {
    const res = await api('POST', '/api/parse', {
      document: { '@context': 'local:does-not-exist', 'a': 1 },
      bindings: {}
    });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'unknown resource');
  });

  test('protected term redefinition surfaces as 409 with details', async () => {
    const res = await api('POST', '/api/parse', {
      document: {
        '@context': ['local:secure', { 'owner': { '@id': 'https://evil.example/owner' } }],
        'owner': 'mallory'
      },
      bindings: { secure: 'latest' }
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'protected term redefinition');
    assert.equal(res.json.error.details.term, 'owner');
  });

  test('cyclic local contexts are rejected', async () => {
    await api('PUT', '/api/resources/cycA', { body: { '@context': 'local:cycB' }, baseRevision: null });
    await api('PUT', '/api/resources/cycB', { body: { '@context': 'local:cycA' }, baseRevision: null });
    const res = await api('POST', '/api/parse', {
      document: { '@context': 'local:cycA', 'x': 1 },
      bindings: { cycA: 'latest', cycB: 'latest' }
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'cyclic IRI mapping');
  });
});

describe('session API', () => {
  test('session pins revisions; resource edits afterwards do not leak in', async () => {
    await api('PUT', '/api/resources/pinned', { body: { '@vocab': 'https://v1/' }, baseRevision: null });
    const created = await api('POST', '/api/sessions', {
      name: 'demo',
      bindings: { pinned: 'latest' },
      document: { '@context': 'local:pinned', 'field': 'x' }
    });
    assert.equal(created.status, 201);
    const sid = created.json.id;

    const parsed1 = await api('POST', `/api/sessions/${sid}/parse`, {});
    assert.equal(parsed1.json.expanded[0]['https://v1/field'][0]['@value'], 'x');

    // Resource advances; the session still sees v1.
    const cur = await api('GET', '/api/resources/pinned');
    await api('PUT', '/api/resources/pinned', {
      body: { '@vocab': 'https://v2/' },
      baseRevision: cur.json.latestRevision
    });
    const parsed2 = await api('POST', `/api/sessions/${sid}/parse`, {});
    assert.equal(parsed2.json.expanded[0]['https://v1/field'][0]['@value'], 'x');
    assert.equal(parsed2.json.pinnedResources.pinned, created.json.resources.pinned);
  });

  test('parse persists the posted document into the session', async () => {
    const created = await api('POST', '/api/sessions', { bindings: { schema: 'latest' } });
    const sid = created.json.id;
    await api('POST', `/api/sessions/${sid}/parse`, {
      document: { '@context': 'local:schema', 'id': 'a/1' }
    });
    const got = await api('GET', `/api/sessions/${sid}`);
    assert.equal(got.json.document.id, 'a/1');
  });

  test('unknown session 404s', async () => {
    const res = await api('GET', '/api/sessions/ses_nope');
    assert.equal(res.status, 404);
  });
});

describe('compact API: full save → session → parse → compact → re-expand → modify path', () => {
  test('end-to-end: compaction re-expands identically, then a resource edit does not change the session view', async () => {
    // 1. save a resource (revision 1)
    const created = await api('PUT', '/api/resources/vocab', {
      body: {
        '@base': 'https://example.com/things/',
        '@vocab': 'https://schema.org/',
        'id': '@id', 'kind': '@type',
        'created': { '@id': 'dateCreated', '@type': 'xsd:date' },
        'xsd': { '@id': 'http://www.w3.org/2001/XMLSchema#', '@prefix': true }
      },
      baseRevision: null
    });
    assert.equal(created.status, 200);
    const rev1 = created.json.revision;

    // 2. create a session pinned to rev1
    const ses = await api('POST', '/api/sessions', {
      name: 'compact-e2e', bindings: { vocab: rev1 }
    });
    assert.equal(ses.status, 201);
    const sid = ses.json.id;

    // 3. parse a compact document
    const parsed = await api('POST', `/api/sessions/${sid}/parse`, {
      document: {
        '@context': 'local:vocab',
        'id': 'widget/9', 'kind': 'Product', 'created': '2026-09-26'
      }
    });
    assert.equal(parsed.status, 200);

    // 4. compact the EXPANDED result against the pinned snapshot
    const compact = await api('POST', `/api/sessions/${sid}/compact`, {
      expanded: parsed.json.expanded,
      rootContext: parsed.json.rootContext,
      scopes: parsed.json.scopes
    });
    assert.equal(compact.status, 200);
    assert.equal(compact.json.verified, true);
    assert.equal(compact.json.pinnedResources.vocab, rev1);
    assert.equal(compact.json.compacted.id, 'widget/9');
    assert.equal(compact.json.compacted.kind, 'Product');
    assert.equal(compact.json.compacted.created, '2026-09-26');

    // 5. feed the compact document back into the expander — must match the
    //    original expansion semantically
    const reparsed = await api('POST', `/api/sessions/${sid}/parse`, {
      document: compact.json.compacted
    });
    assert.equal(reparsed.status, 200);
    assert.deepEqual(
      normalize(reparsed.json.expanded),
      normalize(parsed.json.expanded)
    );

    // 6. a second page edits the resource (new vocab/IRI layout) on rev2
    const updated = await api('PUT', '/api/resources/vocab', {
      body: {
        '@vocab': 'https://schema.org/v2/',
        'id': '@id', 'kind': '@type',
        'created': { '@id': 'dateCreated' }
      },
      baseRevision: rev1
    });
    assert.equal(updated.status, 200);
    const rev2 = updated.json.revision;
    assert.notEqual(rev1, rev2);

    // 7. re-compacting the SAME expanded data in session A must still be
    //    interpreted by rev1, never by head
    const again = await api('POST', `/api/sessions/${sid}/compact`, {
      expanded: parsed.json.expanded,
      rootContext: parsed.json.rootContext,
      scopes: parsed.json.scopes
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.pinnedResources.vocab, rev1);
    assert.deepEqual(normalize(again.json.compacted), normalize(compact.json.compacted));

    // 8. a brand-new session (or ad-hoc parse) DOES read the new head
    const adhoc = await api('POST', '/api/parse', {
      document: { '@context': 'local:vocab', 'created': 'x' },
      bindings: { vocab: 'latest' }
    });
    assert.ok(adhoc.json.expanded[0]['https://schema.org/v2/dateCreated']);
  });

  test('compaction keeps a node-local @context on exactly its node', async () => {
    await api('PUT', '/api/resources/rootctx', { body: { '@vocab': 'https://root/' }, baseRevision: null });
    const cur = await api('GET', '/api/resources/rootctx');
    await api('PUT', '/api/resources/rootctx', {
      body: { '@vocab': 'https://root/' }, baseRevision: cur.json.latestRevision
    }).catch(() => {});
    await api('PUT', '/api/resources/subctx', {
      body: { '@vocab': 'https://sub/', 'label': '@id' }, baseRevision: null
    });

    const parsed = await api('POST', '/api/parse', {
      document: {
        '@context': 'local:rootctx',
        'a': { '@context': 'local:subctx', 'label': 'x' },
        'b': { 'onlyInRoot': 1 }
      },
      bindings: { rootctx: 'latest', subctx: 'latest' }
    });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.json.scopes.length, 1);

    const compact = await api('POST', '/api/compact', {
      expanded: parsed.json.expanded,
      rootContext: parsed.json.rootContext,
      scopes: parsed.json.scopes,
      bindings: { rootctx: 'latest', subctx: 'latest' }
    });
    assert.equal(compact.status, 200);
    assert.equal(compact.json.compacted.a['@context'], 'local:subctx');
    assert.ok(!('@context' in compact.json.compacted.b));

    // scope provenance attributes the include to the pinned revision
    const scope = compact.json.scopeLayout[0];
    assert.equal(scope.raw, 'local:subctx');
    assert.ok(scope.includes[0].revision);

    const reparsed = await api('POST', '/api/parse', {
      document: compact.json.compacted,
      bindings: { rootctx: 'latest', subctx: 'latest' }
    });
    assert.deepEqual(normalize(reparsed.json.expanded), normalize(parsed.json.expanded));
  });

  test('ad-hoc compact with no provenance binds all given resources', async () => {
    const res = await api('POST', '/api/compact', {
      expanded: [{ '@id': 'https://schema.org/z', 'https://schema.org/name': [{ '@value': 'N' }] }],
      bindings: { schema: 'latest' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.verified, true);
    assert.equal(res.json.pinnedResources.schema, res.json.pinnedResources.schema);
    assert.ok(res.json.compacted['@context']);
  });

  test('compaction against an unknown bound resource reports unknown resource, trees stay on client', async () => {
    const res = await api('POST', '/api/compact', {
      expanded: [{ 'https://v/x': [{ '@value': 1 }] }],
      bindings: { ghost: 'latest' }
    });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'unknown resource');
  });

  test('compaction requires an expanded array', async () => {
    const res = await api('POST', '/api/compact', { compacted: {}, bindings: {} });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'validation error');
  });

  test('remote context is still refused during re-expansion verification', async () => {
    const res = await api('POST', '/api/compact', {
      // expanded data that would need a term, but bind nothing and ask for a
      // remote root context — verification must never touch the network
      expanded: [{ 'https://v/x': [{ '@value': 1 }] }],
      bindings: {},
      rootContext: 'https://schema.org/'
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'loading remote context failed');
  });
});

// Semantic normalization shared with the compaction round-trip checks.
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = normalize(v[k]);
    if ('@value' in o && Array.isArray(o['@type']) && o['@type'].length === 1) {
      o['@type'] = o['@type'][0];
    }
    return o;
  }
  return v;
}
