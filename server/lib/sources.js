import { ApiError, json, makeServer, readJson } from './http.js';
import { FIELDS, FIELD_META, PRODUCT_SEEDS } from './catalog.js';

const CIRRUS_FORBIDDEN = '__FORBIDDEN__';

/**
 * Three fictional suppliers, each with its own wire dialect.
 *
 *   aurora   camelCase JSON, explicit `field_cleared: true` next to null
 *   borealis snake_case JSON, omits fields it cannot supply, never clears
 *   cirrus   epoch seconds, archive columns, unauthorized fields come back
 *            as a sentinel and are flagged in `authorization`
 *
 * Each supplier is a real HTTP server with admin controls (online/offline,
 * delay, injected failure, queued revisions) so the console can be driven.
 */
export const SOURCE_SEEDS = [
  {
    id: 'aurora',
    name: 'Aurora Supply Co.',
    dialect: 'json-camel',
    defaultPriority: 1,
    owned: ['title', 'price', 'description', 'material'],
    note: 'Preferred supplier. Sends corrections and can explicitly clear a field.',
    latency: 180,
  },
  {
    id: 'borealis',
    name: 'Borealis Wholesale',
    dialect: 'json-snake',
    defaultPriority: 2,
    owned: ['weight_g', 'origin'],
    note: 'Supplementary supplier. Omits what it cannot supply and never clears.',
    latency: 300,
  },
  {
    id: 'cirrus',
    name: 'Cirrus Archive',
    dialect: 'json-epoch',
    defaultPriority: 3,
    owned: ['title', 'price', 'description', 'weight_g', 'origin'],
    note: 'Slow archive. Refuses title and price with an explicit denial sentinel.',
    latency: 680,
  },
];

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-source catalog. These values are deliberately inconsistent between
 * suppliers so priority changes produce a visible difference.
 */
function seedFields(sourceId, row) {
  if (sourceId === 'aurora') {
    const fields = {
      title: row.title,
      price: row.price,
      description: row.description,
      material: row.material,
    };
    if (row.id === 'SKU-1002') fields.description = null; // explicit clear, not a gap
    if (row.id === 'SKU-1004') {
      delete fields.title; // draft listing: no title or price yet
      delete fields.price;
    }
    return fields;
  }
  if (sourceId === 'borealis') {
    const weights = { 'SKU-1001': 310, 'SKU-1003': 540, 'SKU-1004': null };
    const fields = { origin: row.origin };
    if (weights[row.id] !== undefined && weights[row.id] !== null) fields.weight_g = weights[row.id];
    return fields;
  }
  const weights = { 'SKU-1001': 298, 'SKU-1002': 610, 'SKU-1003': 552, 'SKU-1004': 405 };
  // The archive's transcriptions differ from Aurora's, so a priority change is
  // observable rather than a no-op.
  return {
    description: `Archive transcription — ${row.description}`,
    weight_g: weights[row.id],
    origin: `${row.origin} · archive`,
  };
}

class SourceService {
  constructor(seed) {
    Object.assign(this, seed);
    this.priority = seed.defaultPriority;
    this.baseLatency = seed.latency;
    this.port = null;
    this.server = null;
    this.reset();
  }

  reset() {
    this.online = true;
    this.delayMs = this.baseLatency;
    this.failNext = false;
    this.requests = 0;
    this.pending = new Map();
    this.records = PRODUCT_SEEDS.map((row, index) => ({
      id: row.id,
      version: 1,
      updatedAt: Date.now() - (index + 1) * 90_000,
      fields: seedFields(this.id, row),
    }));
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      dialect: this.dialect,
      priority: this.priority,
      owned: [...this.owned],
      note: this.note,
      online: this.online,
      delayMs: this.delayMs,
      failNext: this.failNext,
      requests: this.requests,
      port: this.port,
      records: this.records.map((record) => ({
        id: record.id,
        version: record.version,
        updatedAt: record.updatedAt,
        pendingRevision: this.pending.get(record.id) ?? null,
      })),
    };
  }

  recordState(recordId) {
    const record = this.records.find((item) => item.id === recordId);
    if (!record) return null;
    return {
      version: record.version,
      updatedAt: record.updatedAt,
      pendingRevision: this.pending.get(recordId) ?? null,
    };
  }

  queueRevision(recordId, field, value) {
    if (!FIELDS.includes(field)) throw new ApiError(400, 'unknown_field', `Unknown field ${field}`);
    if (!this.owned.includes(field)) {
      throw new ApiError(400, 'field_not_owned', `${this.name} does not own ${field}`);
    }
    const record = this.records.find((item) => item.id === recordId);
    if (!record) throw new ApiError(404, 'record_not_found', `Unknown record ${recordId}`);
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
      throw new ApiError(400, 'invalid_value', 'Revision value must be a string, number or null');
    }
    const revision = { recordId, field, value, queuedAt: Date.now() };
    this.pending.set(recordId, revision);
    return revision;
  }

  async serve(recordId, requestedFields) {
    if (!this.online) throw new ApiError(503, 'source_disconnected', `${this.name} is offline`);
    if (this.failNext) {
      this.failNext = false;
      throw new ApiError(502, 'upstream_rejected', `${this.name} rejected the request (injected failure)`);
    }
    const record = this.records.find((item) => item.id === recordId);
    if (!record) throw new ApiError(404, 'record_not_found', `${this.name} has no record ${recordId}`);

    // Snapshot before the artificial latency: a revision queued while this
    // request is in flight must not leak into the response.
    const revision = this.pending.get(recordId);
    if (revision && requestedFields.includes(revision.field)) {
      this.pending.delete(recordId);
      record.fields[revision.field] = revision.value;
      record.version += 1;
      record.updatedAt = Date.now();
    }
    const snapshot = {
      version: record.version,
      updatedAt: record.updatedAt,
      fields: { ...record.fields },
    };
    this.requests += 1;
    await sleep(this.delayMs);
    if (!this.online) {
      throw new ApiError(503, 'source_disconnected', `${this.name} went offline while answering`);
    }
    return this.render(recordId, snapshot, requestedFields);
  }

  render(recordId, snapshot, requestedFields) {
    const owned = requestedFields.filter((field) => this.owned.includes(field));
    const fields = {};
    for (const field of owned) {
      if (!(field in snapshot.fields)) continue;
      const value = snapshot.fields[field];
      fields[field] = field === 'weight_g' && value !== null ? Number(value) : value;
    }

    if (this.id === 'aurora') {
      const payload = {};
      for (const [field, value] of Object.entries(fields)) {
        payload[field] = value;
        if (value === null) payload[`${field}_cleared`] = true;
      }
      return {
        version: snapshot.version,
        updatedAt: snapshot.updatedAt,
        fields,
        raw: {
          sku: recordId,
          revision: snapshot.version,
          updated_at: new Date(snapshot.updatedAt).toISOString(),
          requested: requestedFields,
          payload,
          // Aurora says out loud which owned fields it simply does not hold for
          // this record, so its silence is never mistaken for a refusal.
          not_held: this.owned.filter((field) => !(field in snapshot.fields)),
        },
      };
    }

    if (this.id === 'borealis') {
      return {
        version: snapshot.version,
        updatedAt: snapshot.updatedAt,
        fields,
        raw: {
          item_ref: recordId,
          rev: snapshot.version,
          touched: snapshot.updatedAt,
          requested: requestedFields,
          attributes: fields,
          withheld: requestedFields.filter((field) => !this.owned.includes(field)),
        },
      };
    }

    const columns = {};
    const authorization = {};
    for (const field of owned) {
      const value = fields[field];
      columns[field] = value === null ? null : String(value);
      authorization[field] = 'authorized';
    }
    for (const field of requestedFields) {
      if (field === 'title' || field === 'price') {
        columns[field] = CIRRUS_FORBIDDEN;
        authorization[field] = 'denied';
      } else if (!(field in columns)) {
        authorization[field] = this.owned.includes(field) ? 'authorized' : 'not_held';
      }
    }
    return {
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
      fields,
      authorization,
      raw: {
        dataset: 'cirrus-archive-1974',
        row_id: recordId,
        row_version: snapshot.version,
        updated: Math.floor(snapshot.updatedAt / 1000),
        requested: requestedFields,
        columns,
        authorization,
      },
    };
  }
}

export class SourceNetwork {
  constructor() {
    this.services = SOURCE_SEEDS.map((seed) => new SourceService(seed));
  }

  get(id) {
    const service = this.services.find((item) => item.id === id);
    if (!service) throw new ApiError(404, 'source_not_found', `Unknown source ${id}`);
    return service;
  }

  ordered() {
    return [...this.services].sort((a, b) => a.priority - b.priority);
  }

  reset() {
    for (const service of this.services) {
      service.reset();
      service.priority = service.defaultPriority;
    }
  }

  summaries() {
    return this.ordered().map((service) => service.summary());
  }

  reorder(order) {
    if (!Array.isArray(order) || order.length !== this.services.length) {
      throw new ApiError(400, 'invalid_priority', `Priority order must contain ${this.services.length} source ids`);
    }
    const known = new Set(this.services.map((service) => service.id));
    if (new Set(order).size !== order.length || order.some((id) => !known.has(id))) {
      throw new ApiError(400, 'invalid_priority', 'Priority order must list every source exactly once');
    }
    order.forEach((id, index) => {
      this.get(id).priority = index + 1;
    });
    return this.summaries();
  }

  async listen(host, basePort) {
    let offset = 0;
    for (const service of this.services) {
      service.port = basePort === 0 ? 0 : basePort + offset;
      offset += 1;
      service.server = makeServer((req, res) => routeSource(service, req, res));
      await new Promise((resolve, reject) => {
        service.server.once('error', reject);
        service.server.listen(service.port, host, () => {
          service.port = service.server.address().port;
          resolve();
        });
      });
    }
    return this;
  }

  async close() {
    await Promise.all(
      this.services.map(
        (service) =>
          new Promise((resolve) => {
            if (!service.server?.listening) return resolve();
            service.server.close(() => resolve());
          }),
      ),
    );
  }
}

async function routeSource(service, req, res) {
  const url = new URL(req.url, 'http://source.local');
  const base = `http://127.0.0.1:${service.port}`;
  res.setHeader('x-source-id', service.id);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { id: service.id, online: service.online });
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    return json(res, 200, { ...service.summary(), base });
  }
  if (req.method === 'POST' && url.pathname === '/admin/online') {
    const body = await readJson(req);
    service.online = Boolean(body.online);
    return json(res, 200, service.summary());
  }
  if (req.method === 'POST' && url.pathname === '/admin/delay') {
    const body = await readJson(req);
    const delay = Number(body.delayMs);
    if (!Number.isFinite(delay) || delay < 0 || delay > 15_000) {
      throw new ApiError(400, 'invalid_delay', 'delayMs must be between 0 and 15000');
    }
    service.delayMs = delay;
    return json(res, 200, service.summary());
  }
  if (req.method === 'POST' && url.pathname === '/admin/fail-next') {
    service.failNext = true;
    return json(res, 200, service.summary());
  }
  if (req.method === 'POST' && url.pathname === '/admin/reset') {
    service.reset();
    return json(res, 200, service.summary());
  }
  if (req.method === 'POST' && url.pathname === '/admin/revisions') {
    const body = await readJson(req);
    const revision = service.queueRevision(body.recordId, body.field, body.value ?? null);
    return json(res, 200, revision);
  }

  const match = url.pathname.match(/^\/records\/([^/]+)$/);
  if (req.method === 'GET' && match) {
    const rawFields = url.searchParams.get('fields');
    const requested = rawFields
      ? rawFields.split(',').map((field) => field.trim()).filter(Boolean)
      : [...service.owned];
    const unknown = requested.filter((field) => !FIELDS.includes(field));
    if (unknown.length) throw new ApiError(400, 'unknown_field', `Unknown fields: ${unknown.join(', ')}`);
    const recordId = decodeURIComponent(match[1]);
    const served = await service.serve(recordId, requested);
    return json(res, 200, {
      sourceId: service.id,
      recordId,
      fetchedAt: Date.now(),
      ...served,
      labels: Object.fromEntries(requested.map((field) => [field, FIELD_META[field]?.label ?? field])),
    });
  }

  json(res, 404, { error: 'not_found', message: `No source route ${req.method} ${url.pathname}` });
}

export { SourceService, CIRRUS_FORBIDDEN };
