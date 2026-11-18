import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { ApiError, json, makeServer, readJson } from './lib/http.js';
import { Catalog, FIELDS, FIELD_META, REQUIRED_FIELDS } from './lib/catalog.js';
import { SourceNetwork } from './lib/sources.js';
import { Collector } from './lib/collector.js';
import { Receiver } from './downstream.js';
import { assertKnownFields, diffAgainstPublication } from './lib/adjudication.js';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4310);
const SOURCE_BASE_PORT = Number(process.env.SOURCE_PORT ?? 4411);
const RECEIVER_PORT = Number(process.env.RECEIVER_PORT ?? 4510);
const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export async function startApp({ host = HOST, port = PORT, sourcePort = SOURCE_BASE_PORT, receiverPort = RECEIVER_PORT } = {}) {
  const catalog = new Catalog(':memory:');
  catalog.reset();
  const network = new SourceNetwork();
  await network.listen(host, sourcePort);
  const receiver = new Receiver();
  await receiver.listen(host, receiverPort);
  const collector = new Collector({ catalog, network });

  const app = { catalog, network, collector, receiver };
  const server = makeServer((req, res) => route(app, req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  app.server = server;
  app.port = server.address().port;
  app.close = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await network.close();
    await receiver.close();
    catalog.db.close();
  };
  return app;
}

async function route(app, req, res) {
  const url = new URL(req.url, 'http://console.local');
  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    res.setHeader('cache-control', 'no-store');
    await routeApi(app, req, res, url);
    return;
  }
  await serveStatic(req, res, pathname);
}

function snapshot(app, recordId) {
  const view = app.collector.recordView(recordId);
  const decision = view.decision;
  const diff = view.activePublication
    ? diffAgainstPublication(decision, view.activePublication)
    : { unpublished: true, fields: FIELDS.slice(), reason: 'never_published' };
  return {
    now: Date.now(),
    fields: FIELDS.map((field) => ({ field, ...FIELD_META[field] })),
    requiredFields: REQUIRED_FIELDS,
    sources: app.network.summaries(),
    receiver: app.receiver.summary(),
    events: app.catalog.events(80),
    products: app.catalog.products(),
    record: {
      recordId,
      decision,
      activePublication: view.activePublication,
      publicationHistory: view.publicationHistory.map((pub) => ({
        ...pub,
        deliveries: app.catalog.deliveriesFor(pub.id),
      })),
      unpublishedChanges: diff,
      health: view.health,
      attempts: view.attempts.map((attempt) => ({
        id: attempt.id,
        sourceId: attempt.source_id,
        fields: attempt.requested_fields,
        scope: attempt.scope,
        startedAt: attempt.started_at,
        finishedAt: attempt.finished_at,
        status: attempt.status,
        errorCode: attempt.error_code,
        errorMessage: attempt.error_message,
        rawResponseId: attempt.raw_response_id,
        priority: attempt.priority_at_attempt,
      })),
      rawResponses: view.rawResponses.map((raw) => ({
        id: raw.id,
        sourceId: raw.source_id,
        requestKind: raw.request_kind,
        requestedFields: raw.requested_fields,
        fetchedAt: raw.fetched_at,
        httpStatus: raw.http_status,
        body: raw.body,
        version: raw.source_version,
        sourceUpdatedAt: raw.source_updated_at,
        priority: raw.priority_at_fetch,
        reason: raw.reason,
      })),
    },
  };
}

async function routeApi(app, req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/bootstrap') {
    const recordId = url.searchParams.get('record') ?? 'SKU-1001';
    return json(res, 200, snapshot(app, recordId));
  }

  if (method === 'POST' && pathname === '/api/reset') {
    app.catalog.reset();
    app.network.reset();
    app.receiver.reset();
    app.catalog.log('demo_reset', {});
    return json(res, 200, snapshot(app, 'SKU-1001'));
  }

  if (method === 'POST' && pathname === '/api/priority') {
    const body = await readJson(req);
    const order = body.order;
    const recordId = body.recordId ?? 'SKU-1001';
    const before = app.collector.decision(recordId);
    const impacts = app.collector.affectedByOrder(recordId, order);
    const sources = app.network.reorder(order);
    app.catalog.log(
      'priority_changed',
      {
        order,
        affectedFields: impacts.changed,
        details: impacts.details,
      },
      { recordId },
    );
    return json(res, 200, {
      sources,
      affectedFields: impacts.changed,
      details: impacts.details,
      before,
      hypothetical: impacts.hypothetical,
      snapshot: snapshot(app, recordId),
    });
  }

  if (method === 'POST' && pathname === '/api/collect') {
    const body = await readJson(req);
    const recordId = body.recordId ?? 'SKU-1001';
    const fields = body.fields ?? FIELDS;
    assertKnownFields(fields);
    if (!fields.length) throw new ApiError(400, 'no_fields', 'Choose at least one field');
    const reason = body.reason ?? (body.fields ? 'priority_scoped_refetch' : 'manual_full_fetch');
    const sourceIds = body.sourceIds ?? null;
    if (sourceIds) {
      for (const id of sourceIds) app.network.get(id);
    }
    try {
      const result = await app.collector.collect(recordId, { fields, reason, sourceIds });
      return json(res, 200, {
        attempts: result.attempts,
        decision: result.decision,
        snapshot: snapshot(app, recordId),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw error;
    }
  }

  if (method === 'POST' && pathname === '/api/publish') {
    const body = await readJson(req);
    const recordId = body.recordId ?? 'SKU-1001';
    const publication = app.collector.publish(recordId, {
      allowIncomplete: Boolean(body.allowIncomplete),
      note: body.note ?? null,
    });
    return json(res, 200, { publication, snapshot: snapshot(app, recordId) });
  }

  if (method === 'POST' && pathname === '/api/deliver') {
    const body = await readJson(req);
    const recordId = body.recordId ?? 'SKU-1001';
    const publication = body.publicationId
      ? app.catalog.publication(Number(body.publicationId))
      : app.catalog.activePublication(recordId);
    if (!publication) throw new ApiError(409, 'nothing_to_deliver', 'Publish a version before delivering');
    const idempotencyKey = body.idempotencyKey ?? `pub-${publication.id}-rev${publication.revision}`;
    const payload = {
      publication: {
        recordId: publication.record_id,
        revision: publication.revision,
        mode: publication.mode,
        contract: publication.contract,
        fieldStates: publication.field_states,
        payload: publication.payload,
      },
      idempotencyKey,
    };
    try {
      const response = await fetch(`http://${app.receiver.host ?? '127.0.0.1'}:${app.receiver.port}/intake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      const result = await response.json();
      app.catalog.createDelivery({
        publicationId: publication.id,
        receiver: 'downstream-intake',
        idempotencyKey,
        outcome: response.ok ? 'accepted' : 'rejected',
        httpStatus: response.status,
        receiptId: result.receiptId ?? null,
        response: JSON.stringify(result),
      });
      app.catalog.log('delivered', { publicationId: publication.id, status: response.status, duplicate: Boolean(result.duplicate) }, { recordId });
      return json(res, response.ok ? 200 : 502, {
        result,
        httpStatus: response.status,
        deliveries: app.catalog.deliveriesFor(publication.id),
        snapshot: snapshot(app, recordId),
      });
    } catch (error) {
      app.catalog.createDelivery({
        publicationId: publication.id,
        receiver: 'downstream-intake',
        idempotencyKey,
        outcome: 'unreachable',
        httpStatus: null,
        receiptId: null,
        response: error.message,
      });
      throw new ApiError(502, 'receiver_unreachable', `Downstream receiver did not answer: ${error.message}`);
    }
  }

  if (method === 'POST' && pathname === '/api/source-admin') {
    const body = await readJson(req);
    const source = app.network.get(body.sourceId);
    const action = body.action;
    if (action === 'online') {
      source.online = Boolean(body.online);
    } else if (action === 'delay') {
      const delay = Number(body.delayMs);
      if (!Number.isFinite(delay) || delay < 0 || delay > 15_000) {
        throw new ApiError(400, 'invalid_delay', 'delayMs must be between 0 and 15000');
      }
      source.delayMs = delay;
    } else if (action === 'fail-next') {
      source.failNext = true;
    } else if (action === 'reset') {
      source.reset();
    } else {
      throw new ApiError(400, 'unknown_action', `Unknown source action ${action}`);
    }
    app.catalog.log('source_admin', { sourceId: source.id, action, online: source.online, delayMs: source.delayMs });
    return json(res, 200, { sources: app.network.summaries(), snapshot: snapshot(app, body.recordId ?? 'SKU-1001') });
  }

  if (method === 'POST' && pathname === '/api/revisions') {
    const body = await readJson(req);
    const source = app.network.get(body.sourceId);
    const revision = source.queueRevision(body.recordId ?? 'SKU-1001', body.field, body.value ?? null);
    app.catalog.log('revision_queued', { sourceId: source.id, field: revision.field, value: revision.value }, { recordId: revision.recordId, field: revision.field });
    return json(res, 200, { revision, sources: app.network.summaries(), snapshot: snapshot(app, revision.recordId) });
  }

  if (method === 'POST' && pathname === '/api/raw/preview') {
    const body = await readJson(req);
    const raw = app.catalog.rawResponse(Number(body.rawResponseId));
    if (!raw) throw new ApiError(404, 'raw_not_found', 'No such raw response');
    return json(res, 200, raw);
  }

  if (method === 'POST' && pathname === '/api/recompute') {
    const body = await readJson(req);
    const recordId = body.recordId ?? 'SKU-1001';
    return json(res, 200, { snapshot: snapshot(app, recordId) });
  }

  if (method === 'GET' && pathname === '/api/publication') {
    const id = Number(url.searchParams.get('id'));
    const publication = app.catalog.publication(id);
    if (!publication) throw new ApiError(404, 'publication_not_found', 'No such publication');
    return json(res, 200, { publication, deliveries: app.catalog.deliveriesFor(id) });
  }

  if (method === 'GET' && pathname === '/api/receiver') {
    return json(res, 200, app.receiver.summary());
  }

  if (method === 'POST' && pathname === '/api/receiver/reset') {
    app.receiver.reset();
    return json(res, 200, app.receiver.summary());
  }

  throw new ApiError(404, 'not_found', `No API route ${method} ${pathname}`);
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new ApiError(405, 'method_not_allowed', 'Static assets are read-only');
  }
  const relative = pathname === '/' ? '/index.html' : pathname;
  const target = normalize(join(PUBLIC_DIR, relative));
  if (!target.startsWith(PUBLIC_DIR)) throw new ApiError(403, 'forbidden', 'Path escapes public directory');
  let data;
  try {
    data = await readFile(target);
  } catch {
    throw new ApiError(404, 'not_found', 'Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const app = await startApp();
  console.log(`console      http://${HOST}:${app.port}`);
  app.network.services.forEach((source) => console.log(`source ${source.id.padEnd(9)} http://${HOST}:${source.port}`));
  console.log(`receiver     http://${HOST}:${app.receiver.port}`);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
