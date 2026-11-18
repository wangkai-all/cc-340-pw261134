import { ApiError, json, makeServer, readJson } from './lib/http.js';
import { FIELDS, REQUIRED_FIELDS } from './lib/catalog.js';

/**
 * A deliberately small downstream receiver. It is the place where the
 * publication's completeness promise is checked again: a "complete" claim
 * must actually carry every required field, and a "partial" claim must say
 * what it is still waiting for. Receipts are idempotent per key.
 */
export class Receiver {
  constructor() {
    this.receipts = [];
    this.byKey = new Map();
    this.sequence = 0;
    this.server = null;
    this.port = null;
    this.host = '127.0.0.1';
  }

  reset() {
    this.receipts = [];
    this.byKey.clear();
    this.sequence = 0;
  }

  summary() {
    return {
      port: this.port,
      receipts: this.receipts,
      duplicateAttempts: this.receipts.reduce((count, receipt) => count + receipt.duplicates, 0),
    };
  }

  validate(body) {
    if (!body || typeof body !== 'object') throw new ApiError(400, 'invalid_body', 'Expected a publication envelope');
    const { publication, idempotencyKey } = body;
    if (!publication || typeof publication !== 'object') {
      throw new ApiError(400, 'invalid_body', 'Missing publication');
    }
    if (!idempotencyKey) throw new ApiError(400, 'missing_idempotency_key', 'Idempotency-Key header or body field is required');
    if (!publication.recordId) throw new ApiError(422, 'invalid_publication', 'Publication is missing recordId');
    if (!publication.contract || typeof publication.contract !== 'object') {
      throw new ApiError(422, 'invalid_publication', 'Publication is missing its completeness contract');
    }
    if (!publication.payload || typeof publication.payload !== 'object') {
      throw new ApiError(422, 'invalid_publication', 'Publication is missing its payload');
    }
    if (!publication.fieldStates || typeof publication.fieldStates !== 'object') {
      throw new ApiError(422, 'invalid_publication', 'Publication is missing per-field states');
    }

    const promise = publication.contract.promise;
    if (promise !== 'complete' && promise !== 'partial') {
      throw new ApiError(422, 'invalid_contract', 'contract.promise must be "complete" or "partial"');
    }
    for (const field of Object.keys(publication.payload)) {
      if (!FIELDS.includes(field)) {
        throw new ApiError(422, 'invalid_payload', `Payload contains unknown field ${field}`);
      }
      const state = publication.fieldStates[field];
      if (!state || state.state !== 'authorized') {
        throw new ApiError(422, 'payload_state_mismatch', `Payload field ${field} is not authorized in fieldStates`);
      }
    }
    const missingRequired = REQUIRED_FIELDS.filter((field) => !(field in publication.payload));
    if (promise === 'complete' && missingRequired.length) {
      throw new ApiError(422, 'completeness_mismatch', `Publication promises complete but is missing ${missingRequired.join(', ')}`, {
        missingRequired,
      });
    }
    if (promise === 'partial') {
      const blocking = publication.contract.blockingRequired;
      if (!Array.isArray(blocking) || blocking.length === 0) {
        throw new ApiError(422, 'completeness_mismatch', 'Publication is marked partial but names no blocking required fields');
      }
      const dishonest = blocking.filter((field) => field in publication.payload);
      if (dishonest.length) {
        throw new ApiError(422, 'completeness_mismatch', 'Blocking fields are present in a partial payload', { dishonest });
      }
      // A partial promise must account for every required field it did not
      // deliver. Otherwise it would quietly drop a field from the promise.
      const undeclared = missingRequired.filter((field) => !blocking.includes(field));
      if (undeclared.length) {
        throw new ApiError(422, 'completeness_mismatch', 'Partial publication omits required fields without declaring them blocking', {
          undeclared,
        });
      }
    }
    return { publication, idempotencyKey };
  }

  async receive(body) {
    const { publication, idempotencyKey } = this.validate(body);
    const existing = this.byKey.get(idempotencyKey);
    if (existing) {
      existing.duplicates += 1;
      existing.lastAttemptAt = Date.now();
      return { receipt: existing, duplicate: true };
    }
    this.sequence += 1;
    const receipt = {
      id: `rcpt-${String(this.sequence).padStart(4, '0')}`,
      idempotencyKey,
      recordId: publication.recordId,
      revision: publication.revision,
      promise: publication.contract.promise,
      blockingRequired: publication.contract.blockingRequired ?? [],
      receivedAt: Date.now(),
      duplicates: 0,
      lastAttemptAt: null,
      payload: publication.payload,
    };
    this.receipts.push(receipt);
    this.byKey.set(idempotencyKey, receipt);
    return { receipt, duplicate: false };
  }

  async listen(host, port) {
    this.host = host;
    this.server = makeServer((req, res) => this.route(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this;
  }

  async close() {
    await new Promise((resolve) => {
      if (!this.server?.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://receiver.local');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, receipts: this.receipts.length });
    }
    if (req.method === 'GET' && url.pathname === '/receipts') {
      return json(res, 200, this.summary());
    }
    if (req.method === 'POST' && url.pathname === '/intake') {
      const body = await readJson(req);
      const key = req.headers['idempotency-key'] ?? body.idempotencyKey;
      const { receipt, duplicate } = await this.receive({ ...body, idempotencyKey: key ?? body.idempotencyKey });
      return json(res, duplicate ? 200 : 201, {
        receiptId: receipt.id,
        duplicate,
        promise: receipt.promise,
        recordId: receipt.recordId,
        revision: receipt.revision,
        note: duplicate
          ? '重复领取：同一幂等键已入库，未产生第二份记录'
          : receipt.promise === 'partial'
            ? '已接收部分结果，仍等待必填字段'
            : '已接收完整结果',
      });
    }
    if (req.method === 'POST' && url.pathname === '/reset') {
      this.reset();
      return json(res, 200, this.summary());
    }
    throw new ApiError(404, 'not_found', `No receiver route ${req.method} ${url.pathname}`);
  }
}
