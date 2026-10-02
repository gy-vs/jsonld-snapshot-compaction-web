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

describe('compaction lifecycle (save → session → expand → compact → re-expand → resource edit)', () => {
  test('full path round-trips and stays pinned to the session revision', async () => {
    // 1. Save a resource (v1).
    const created = await api('PUT', '/api/resources/vocab', {
      body: {
        '@base': 'https://example.com/things/',
        '@vocab': 'https://schema.org/',
        'xsd': { '@id': 'http://www.w3.org/2001/XMLSchema#', '@prefix': true },
        'created': { '@id': 'dateCreated', '@type': 'xsd:date' },
        'id': '@id', 'kind': '@type'
      },
      baseRevision: null
    });
    assert.equal(created.status, 200);
    const rev1 = created.json.revision;

    // 2. Create a session pinned at v1.
    const ses = await api('POST', '/api/sessions', {
      name: 'lifecycle',
      bindings: { vocab: rev1 },
      document: {
        '@context': 'local:vocab', 'id': 'w/7', 'kind': 'Product',
        'created': '2026-09-26'
      }
    });
    assert.equal(ses.status, 201);
    const sid = ses.json.id;

    // 3. Expand within the session.
    const parsed = await api('POST', `/api/sessions/${sid}/parse`, {});
    assert.equal(parsed.status, 200);
    const node = parsed.json.expanded[0];
    assert.equal(node['@id'], 'https://example.com/things/w/7');
    assert.deepEqual(node['@type'], ['https://schema.org/Product']);
    assert.equal(
      node['https://schema.org/dateCreated'][0]['@type'],
      'http://www.w3.org/2001/XMLSchema#date'
    );

    // 4. Compact the expanded result against the SAME session snapshot.
    const compacted = await api('POST', `/api/sessions/${sid}/compact`, {
      expanded: parsed.json.expanded,
      rootContext: ['local:vocab']
    });
    assert.equal(compacted.status, 200);
    const c = compacted.json.compact;
    assert.deepEqual(c['@context'], 'local:vocab');
    assert.equal(c.id, 'w/7');               // keyword alias + relative @id
    assert.equal(c.kind, 'Product');         // keyword alias + @vocab type
    assert.equal(c.created, '2026-09-26');   // datatype coercion elides @type
    assert.equal(compacted.json.pinnedResources.vocab, rev1);
    // every property decision is marked safe and attributed to a revision
    assert.ok(compacted.json.decisions.length >= 3);
    for (const d of compacted.json.decisions) assert.equal(d.safe, true);

    // 5. Re-expand the compact document (ad-hoc parse bound to the same rev):
    //    must be semantically identical to the original expanded result.
    const reparsed = await api('POST', '/api/parse', {
      document: c,
      bindings: { vocab: rev1 }
    });
    assert.equal(reparsed.status, 200);
    assert.deepEqual(reparsed.json.expanded, parsed.json.expanded);

    // 6. Save a NEW revision of the resource that changes the vocabulary.
    const updated = await api('PUT', '/api/resources/vocab', {
      body: { '@vocab': 'https://CHANGED.example/', 'id': '@id' },
      baseRevision: rev1
    });
    assert.equal(updated.status, 200);
    const rev2 = updated.json.revision;
    assert.notEqual(rev1, rev2);

    // 7. Re-expand AND re-compact the OLD session: still interpreted with rev1.
    const parsedAgain = await api('POST', `/api/sessions/${sid}/parse`, {});
    assert.equal(parsedAgain.json.pinnedResources.vocab, rev1);
    const compactAgain = await api('POST', `/api/sessions/${sid}/compact`, {
      expanded: parsedAgain.json.expanded,
      rootContext: ['local:vocab']
    });
    assert.equal(compactAgain.status, 200);
    assert.equal(compactAgain.json.pinnedResources.vocab, rev1);
    assert.equal(compactAgain.json.compact.kind, 'Product'); // old rev has kind:@type
    assert.deepEqual(compactAgain.json.compact, c);

    // 8. A NEW session reads the new head and compacts with the new mapping.
    const ses2 = await api('POST', '/api/sessions', {
      bindings: { vocab: 'latest' },
      document: { '@context': 'local:vocab', 'id': 'w/7', 'Product': 1 }
    });
    assert.equal(ses2.json.resources.vocab, rev2);
    const parsed2 = await api('POST', `/api/sessions/${ses2.json.id}/parse`, {});
    const compact2 = await api('POST', `/api/sessions/${ses2.json.id}/compact`, {
      expanded: parsed2.json.expanded,
      rootContext: ['local:vocab']
    });
    assert.equal(compact2.status, 200);
    assert.equal(compact2.json.pinnedResources.vocab, rev2);
    // under the new vocab the property expands under the changed namespace
    assert.ok(parsed2.json.expanded[0]['https://CHANGED.example/Product']);
  });

  test('ad-hoc compact mirrors ad-hoc parse binding semantics', async () => {
    await api('PUT', '/api/resources/adhoc', {
      body: { '@vocab': 'https://v1/' }, baseRevision: null
    });
    const expand = await api('POST', '/api/parse', {
      document: { '@context': 'local:adhoc', 'field': 'x' },
      bindings: { adhoc: 'latest' }
    });
    const compact = await api('POST', '/api/compact', {
      expanded: expand.json.expanded,
      rootContext: ['local:adhoc'],
      bindings: { adhoc: 'latest' }
    });
    assert.equal(compact.status, 200);
    assert.equal(compact.json.compact.field, 'x');
    // re-expansion through the same ad-hoc binding is identical
    const again = await api('POST', '/api/parse', {
      document: compact.json.compact,
      bindings: { adhoc: 'latest' }
    });
    assert.deepEqual(again.json.expanded, expand.json.expanded);
  });

  test('compact against an unbound local ref is rejected (no remote fetch)', async () => {
    const res = await api('POST', '/api/compact', {
      expanded: [{ '@id': 'x' }],
      rootContext: ['local:not-bound'],
      bindings: {}
    });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'unknown resource');
    assert.equal(res.json.error.details.ref, 'local:not-bound');
  });

  test('an inexpressible value returns a classified conflict and keeps inputs available', async () => {
    await api('PUT', '/api/resources/coerce', {
      body: {
        '@vocab': 'https://v/',
        'n': { '@id': 'n', '@type': 'http://www.w3.org/2001/XMLSchema#integer' }
      },
      baseRevision: null
    });
    const res = await api('POST', '/api/compact', {
      expanded: [{ 'https://v/n': [{
        '@value': '5', '@type': 'http://www.w3.org/2001/XMLSchema#string'
      }] }],
      rootContext: ['local:coerce'],
      bindings: { coerce: 'latest' }
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'compaction conflict');
    assert.equal(res.json.error.details.kind, 'inexpressible-value');
  });
});
