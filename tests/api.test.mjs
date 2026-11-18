import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../server/main.js';

let app;
let base;

test.before(async () => {
  app = await startApp({
    port: 0,
    sourcePort: 4700 + Math.floor(Math.random() * 100),
    receiverPort: 4900 + Math.floor(Math.random() * 100),
  });
  base = `http://127.0.0.1:${app.port}`;
});

test.after(async () => {
  await app.close();
});

async function call(path, body, method = 'POST') {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('before any request every field is uncollected, not missing', async () => {
  await call('/api/reset', {});
  const { body } = await call('/api/bootstrap?record=SKU-1001', null, 'GET');
  const decision = body.record.decision;
  for (const field of Object.values(decision.fields)) {
    assert.equal(field.state, 'uncollected');
  }
  assert.equal(decision.complete, false);
});

test('a clear is distinct from missing, and a lower value cannot resurrect it', async () => {
  await call('/api/reset', {});
  await call('/api/collect', { recordId: 'SKU-1002' });
  const { body } = await call('/api/bootstrap?record=SKU-1002', null, 'GET');
  const decision = body.record.decision;
  assert.equal(decision.fields.description.state, 'cleared');
  assert.equal(decision.fields.description.sourceId, 'aurora');
  assert.ok(
    decision.fields.description.suppressed.some((entry) => entry.sourceId === 'cirrus' && entry.reason === 'higher_priority_clear'),
    'lower-priority archive value is recorded as suppressed, not applied',
  );
  assert.equal(decision.fields.weight_g.state, 'authorized');
});

test('an unauthorized field is denied, not missing', async () => {
  await call('/api/reset', {});
  await call('/api/collect', { recordId: 'SKU-1004' });
  const { body } = await call('/api/bootstrap?record=SKU-1004', null, 'GET');
  const decision = body.record.decision;
  assert.equal(decision.fields.title.state, 'denied');
  assert.equal(decision.fields.price.state, 'denied');
  assert.deepEqual(decision.blockingRequired.sort(), ['price', 'title']);
  const publish = await call('/api/publish', { recordId: 'SKU-1004' });
  assert.equal(publish.status, 409);
});

test('partial publication freezes a partial promise and omits blocking fields', async () => {
  await call('/api/reset', {});
  await call('/api/collect', { recordId: 'SKU-1004' });
  const { status, body } = await call('/api/publish', { recordId: 'SKU-1004', allowIncomplete: true, note: 'waiting' });
  assert.equal(status, 200);
  const pub = body.publication;
  assert.equal(pub.completeness, 'partial');
  assert.equal(pub.contract.promise, 'partial');
  assert.deepEqual(pub.contract.blockingRequired.sort(), ['price', 'title']);
  assert.equal('title' in pub.payload, false);
  assert.equal('price' in pub.payload, false);
  assert.equal(pub.payload.description.includes('Undyed wool cushion'), true);
  assert.equal(body.snapshot.record.activePublication.revision, pub.revision);
});

test('the receiver rejects a complete claim that is missing a required field', async () => {
  const { status, body } = await call('/api/receiver/reset', {});
  assert.equal(status, 200);
  const response = await fetch(`http://127.0.0.1:${app.receiver.port}/intake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'bad-1' },
    body: JSON.stringify({
      idempotencyKey: 'bad-1',
      publication: {
        recordId: 'SKU-9999',
        revision: 1,
        contract: { promise: 'complete', blockingRequired: [] },
        fieldStates: { title: { state: 'authorized' } },
        payload: { title: 'Lying product' },
      },
    }),
  });
  const receipt = await response.json();
  assert.equal(response.status, 422);
  assert.equal(receipt.error, 'completeness_mismatch');
});

test('a partial claim must declare every required field it did not deliver', async () => {
  await call('/api/receiver/reset', {});
  const response = await fetch(`http://127.0.0.1:${app.receiver.port}/intake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'half-honest-1' },
    body: JSON.stringify({
      idempotencyKey: 'half-honest-1',
      publication: {
        recordId: 'SKU-9999',
        revision: 1,
        contract: { promise: 'partial', blockingRequired: ['title'] },
        fieldStates: {
          title: { state: 'denied' },
          price: { state: 'pending' },
          description: { state: 'authorized', value: 'x' },
        },
        payload: { description: 'x' },
      },
    }),
  });
  const receipt = await response.json();
  assert.equal(response.status, 422);
  assert.equal(receipt.error, 'completeness_mismatch');
  assert.deepEqual(receipt.detail.undeclared, ['price'], 'the silently dropped required field is named');
});

test('priority change reports only affected fields and refetches only those', async () => {
  await call('/api/reset', {});
  await call('/api/collect', { recordId: 'SKU-1001' });
  const before = await call('/api/bootstrap?record=SKU-1001', null, 'GET');
  const initial = before.body.record.decision;
  assert.equal(initial.fields.weight_g.sourceId, 'borealis');

  const { body } = await call('/api/priority', { recordId: 'SKU-1001', order: ['cirrus', 'aurora', 'borealis'] });
  assert.ok(body.affectedFields.includes('weight_g'));
  assert.ok(body.affectedFields.includes('description'));
  assert.ok(!body.affectedFields.includes('title'), 'title is denied by cirrus either way');

  await call('/api/collect', { recordId: 'SKU-1001', fields: body.affectedFields, reason: 'priority_scoped_refetch' });
  const after = await call('/api/bootstrap?record=SKU-1001', null, 'GET');
  const decision = after.body.record.decision;
  assert.equal(decision.fields.weight_g.sourceId, 'cirrus');
  assert.equal(decision.fields.weight_g.value, 298);

  const scoped = after.body.record.attempts.filter((attempt) => attempt.requestKind?.startsWith('priority_scoped_refetch') || attempt.fields?.length < 5);
  assert.ok(scoped.length > 0);
  const raw = after.body.record.rawResponses.filter((item) => item.requestKind === 'priority_scoped_refetch');
  assert.ok(
    raw.some((item) => item.sourceId === 'borealis' && item.requestedFields.slice().sort().join() === 'origin,weight_g'),
    'borealis is asked only for the affected fields it owns',
  );
  assert.ok(!raw.some((item) => item.sourceId === 'aurora' && item.requestedFields.includes('material')), 'unaffected fields are not refetched');

  const pub = await call('/api/publish', { recordId: 'SKU-1001' });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.publication.revision, 1);

  const { body: history } = await call('/api/bootstrap?record=SKU-1001', null, 'GET');
  assert.equal(history.record.publicationHistory.length, 1);
});

test('an offline source leaves required fields pending and blocks a complete publish', async () => {
  await call('/api/reset', {});
  await call('/api/source-admin', { sourceId: 'aurora', action: 'online', online: false });
  const collect = await call('/api/collect', { recordId: 'SKU-1001' });
  const failure = collect.body.attempts.find((attempt) => attempt.sourceId === 'aurora');
  assert.equal(failure.ok, false);
  assert.equal(failure.errorCode, 'source_disconnected');
  const decision = collect.body.decision;
  assert.equal(decision.fields.title.state, 'pending');
  assert.equal(decision.fields.price.state, 'pending');
  assert.equal(decision.complete, false);
  const publish = await call('/api/publish', { recordId: 'SKU-1001' });
  assert.equal(publish.status, 409);
  const errorCode = publish.body.error;
  assert.equal(errorCode, 'incomplete_decision');
  const rawFailure = collect.body.snapshot.record.rawResponses.find(
    (item) => item.sourceId === 'aurora' && item.httpStatus === 503,
  );
  assert.ok(rawFailure, 'the 503 body is retained as a raw response');
});

test('a revision queued mid-flight is not in that response but is picked up next time', async () => {
  await call('/api/reset', {});
  await call('/api/source-admin', { sourceId: 'aurora', action: 'delay', delayMs: 800 });
  const inFlight = call('/api/collect', { recordId: 'SKU-1001', fields: ['title'], reason: 'midflight' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await call('/api/revisions', { sourceId: 'aurora', recordId: 'SKU-1001', field: 'title', value: 'Revised mid-flight' });
  const result = await inFlight;
  const title = result.body.decision.fields.title;
  assert.equal(title.value, 'Nimbus Ceramic Mug');
  assert.ok(title.pendingAtSource.some((entry) => entry.sourceId === 'aurora'));
  assert.equal(result.body.snapshot.record.auditNote, undefined);

  await call('/api/source-admin', { sourceId: 'aurora', action: 'delay', delayMs: 10 });
  const second = await call('/api/collect', { recordId: 'SKU-1001', fields: ['title'], reason: 'pick_up_revision' });
  assert.equal(second.body.decision.fields.title.value, 'Revised mid-flight');
});

test('duplicate delivery with the same idempotency key is not stored twice', async () => {
  await call('/api/reset', {});
  await call('/api/receiver/reset', {});
  await call('/api/collect', { recordId: 'SKU-1001' });
  await call('/api/publish', { recordId: 'SKU-1001' });
  const first = await call('/api/deliver', { recordId: 'SKU-1001' });
  assert.equal(first.status, 200);
  assert.equal(first.body.result.duplicate, false);
  const second = await call('/api/deliver', { recordId: 'SKU-1001' });
  assert.equal(second.status, 200);
  assert.equal(second.body.result.duplicate, true);
  assert.equal(second.body.result.receiptId, first.body.result.receiptId);
  const receiver = await call('/api/receiver', null, 'GET');
  assert.equal(receiver.body.receipts.length, 1);
  assert.equal(receiver.body.duplicateAttempts, 1);
});

test('publication history keeps superseded revisions traceable', async () => {
  await call('/api/reset', {});
  await call('/api/collect', { recordId: 'SKU-1001' });
  const first = await call('/api/publish', { recordId: 'SKU-1001' });
  await call('/api/priority', { recordId: 'SKU-1001', order: ['cirrus', 'aurora', 'borealis'] });
  await call('/api/collect', { recordId: 'SKU-1001', fields: ['description', 'weight_g', 'origin'] });
  const second = await call('/api/publish', { recordId: 'SKU-1001' });
  assert.equal(second.body.publication.revision, first.body.publication.revision + 1);
  const { body } = await call('/api/bootstrap?record=SKU-1001', null, 'GET');
  const history = body.record.publicationHistory;
  assert.equal(history.length, 2);
  const old = history.find((item) => item.revision === first.body.publication.revision);
  assert.equal(old.superseded_by, second.body.publication.id, 'old revision points at its successor');
  assert.equal(old.payload.weight_g, 310, 'old revision keeps the value it promised');
});

test('an injected upstream failure is persisted with its error body', async () => {
  await call('/api/reset', {});
  await call('/api/source-admin', { sourceId: 'borealis', action: 'fail-next' });
  const collect = await call('/api/collect', { recordId: 'SKU-1001' });
  const failure = collect.body.attempts.find((attempt) => attempt.sourceId === 'borealis');
  assert.equal(failure.ok, false);
  assert.equal(failure.errorCode, 'upstream_rejected');
  const raw = collect.body.snapshot.record.rawResponses.find((item) => item.sourceId === 'borealis' && item.httpStatus === 502);
  assert.ok(raw);
  assert.match(raw.body, /upstream_rejected/);
  const weight = collect.body.decision.fields.weight_g;
  assert.equal(weight.state, 'authorized', 'cirrus still answered, so a value exists');
  assert.equal(weight.provisional, true, 'but the higher-priority borealis failed, so it is provisional');
  assert.ok(collect.body.decision.waitingFields.includes('weight_g'), 'the page must still show it as waiting');
  assert.ok(
    collect.body.snapshot.record.decision.fields.weight_g.unverifiedBy.some((entry) => entry.reason !== null),
    'the wait reason names the failed higher-priority source',
  );
});
