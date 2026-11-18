import { DatabaseSync } from 'node:sqlite';

export const FIELDS = ['title', 'price', 'description', 'material', 'weight_g', 'origin'];

export const FIELD_META = {
  title: { label: 'Title', required: true },
  price: { label: 'Price', required: true },
  description: { label: 'Description', required: false },
  material: { label: 'Material', required: false },
  weight_g: { label: 'Weight', required: false },
  origin: { label: 'Origin', required: false },
};

export const REQUIRED_FIELDS = FIELDS.filter((field) => FIELD_META[field].required);

export const PRODUCT_SEEDS = [
  {
    id: 'SKU-1001',
    title: 'Nimbus Ceramic Mug',
    price: 18.5,
    description: 'Hand-glazed 320 ml mug in storm grey.',
    material: 'ceramic',
    weight_g: 310,
    origin: 'Port Aline',
  },
  {
    id: 'SKU-1002',
    title: 'Tidal Linen Throw',
    price: 64,
    description: 'Stonewashed linen throw, 130 × 180 cm.',
    material: 'linen',
    weight_g: 610,
    origin: 'Vellmar',
  },
  {
    id: 'SKU-1003',
    title: 'Driftwood Desk Tray',
    price: 29.75,
    description: 'Reclaimed driftwood tray with felt base.',
    material: 'wood',
    weight_g: 540,
    origin: 'Kestrel Bay',
  },
  {
    id: 'SKU-1004',
    title: 'Saltmarsh Wool Cushion',
    price: 42,
    description: 'Undyed wool cushion with a linen back, 45 × 45 cm.',
    material: 'wool',
    weight_g: 405,
    origin: 'Low Fen',
  },
];

/**
 * Persistence for the adjudication trail. The product table is intentionally
 * not updated by collection: only an explicit publication freezes values.
 */
export class Catalog {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS product (
        id TEXT PRIMARY KEY,
        title TEXT,
        price REAL,
        description TEXT,
        material TEXT,
        weight_g REAL,
        origin TEXT
      );

      CREATE TABLE IF NOT EXISTS raw_response (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        request_kind TEXT NOT NULL,
        requested_fields TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        http_status INTEGER NOT NULL,
        body TEXT NOT NULL,
        parsed TEXT NOT NULL,
        source_version INTEGER,
        source_updated_at INTEGER,
        priority_at_fetch INTEGER NOT NULL,
        reason TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fetch_attempt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        requested_fields TEXT NOT NULL,
        scope TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        raw_response_id INTEGER,
        priority_at_attempt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS claim (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_response_id INTEGER NOT NULL REFERENCES raw_response(id),
        source_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        field TEXT NOT NULL,
        state TEXT NOT NULL,
        value TEXT,
        source_version INTEGER,
        source_updated_at INTEGER,
        priority_at_claim INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS publication (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        mode TEXT NOT NULL,
        completeness TEXT NOT NULL,
        contract TEXT NOT NULL,
        field_states TEXT NOT NULL,
        payload TEXT NOT NULL,
        superseded_by INTEGER,
        UNIQUE (record_id, revision)
      );

      CREATE TABLE IF NOT EXISTS delivery (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        publication_id INTEGER NOT NULL REFERENCES publication(id),
        receiver TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempted_at INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        http_status INTEGER,
        receipt_id TEXT,
        response TEXT,
        UNIQUE (publication_id, receiver, idempotency_key, attempted_at)
      );

      CREATE TABLE IF NOT EXISTS event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        record_id TEXT,
        source_id TEXT,
        field TEXT,
        detail TEXT NOT NULL
      );
    `);
  }

  reset() {
    this.db.exec(`
      DELETE FROM delivery;
      DELETE FROM publication;
      DELETE FROM claim;
      DELETE FROM fetch_attempt;
      DELETE FROM raw_response;
      DELETE FROM event;
      DELETE FROM product;
    `);
    for (const row of PRODUCT_SEEDS) {
      this.db
        .prepare('INSERT INTO product (id,title,price,description,material,weight_g,origin) VALUES (?,?,?,?,?,?,?)')
        .run(row.id, row.title, row.price, row.description, row.material, row.weight_g, row.origin);
    }
  }

  products() {
    return this.db.prepare('SELECT * FROM product ORDER BY id').all();
  }

  recordRaw(frame) {
    const info = this.db
      .prepare(
        `INSERT INTO raw_response
          (source_id, record_id, request_kind, requested_fields, fetched_at, http_status, body, parsed,
           source_version, source_updated_at, priority_at_fetch, reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        frame.sourceId,
        frame.recordId,
        frame.requestKind,
        JSON.stringify(frame.requestedFields),
        frame.fetchedAt,
        frame.httpStatus,
        frame.body,
        JSON.stringify(frame.parsed),
        frame.sourceVersion ?? null,
        frame.sourceUpdatedAt ?? null,
        frame.priority,
        frame.reason,
      );
    return Number(info.lastInsertRowid);
  }

  recordAttempt(attempt) {
    const info = this.db
      .prepare(
        `INSERT INTO fetch_attempt
          (record_id, source_id, requested_fields, scope, started_at, finished_at, status, error_code,
           error_message, raw_response_id, priority_at_attempt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        attempt.recordId,
        attempt.sourceId,
        JSON.stringify(attempt.requestedFields),
        attempt.scope,
        attempt.startedAt,
        attempt.finishedAt,
        attempt.status,
        attempt.errorCode ?? null,
        attempt.errorMessage ?? null,
        attempt.rawResponseId ?? null,
        attempt.priority,
      );
    return Number(info.lastInsertRowid);
  }

  recordClaims(claims) {
    const insert = this.db.prepare(
      `INSERT INTO claim
        (raw_response_id, source_id, record_id, field, state, value, source_version, source_updated_at,
         priority_at_claim, recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const now = Date.now();
    for (const claim of claims) {
      insert.run(
        claim.rawResponseId,
        claim.sourceId,
        claim.recordId,
        claim.field,
        claim.state,
        claim.value === null || claim.value === undefined ? null : JSON.stringify(claim.value),
        claim.sourceVersion ?? null,
        claim.sourceUpdatedAt ?? null,
        claim.priority,
        now,
      );
    }
  }

  rawResponses(recordId, limit = 40) {
    return this.db
      .prepare('SELECT * FROM raw_response WHERE record_id = ? ORDER BY id DESC LIMIT ?')
      .all(recordId, limit)
      .map(hydrateRaw);
  }

  rawResponse(id) {
    const row = this.db.prepare('SELECT * FROM raw_response WHERE id = ?').get(id);
    return row ? hydrateRaw(row) : null;
  }

  attempts(recordId, limit = 30) {
    return this.db
      .prepare('SELECT * FROM fetch_attempt WHERE record_id = ? ORDER BY id DESC LIMIT ?')
      .all(recordId, limit)
      .map(hydrateAttempt);
  }

  /** Which supplier was ever asked for each field, successful or not. */
  askedSourcesByField(recordId) {
    const rows = this.db
      .prepare('SELECT source_id, requested_fields FROM fetch_attempt WHERE record_id = ?')
      .all(recordId);
    const map = {};
    for (const row of rows) {
      const fields = JSON.parse(row.requested_fields);
      for (const field of fields) {
        if (!map[field]) map[field] = new Set();
        map[field].add(row.source_id);
      }
    }
    return map;
  }

  claimsFor(recordId) {
    return this.db
      .prepare('SELECT * FROM claim WHERE record_id = ? ORDER BY id')
      .all(recordId)
      .map(hydrateClaim);
  }

  log(kind, detail, { recordId = null, sourceId = null, field = null } = {}) {
    this.db
      .prepare('INSERT INTO event (at, kind, record_id, source_id, field, detail) VALUES (?,?,?,?,?,?)')
      .run(Date.now(), kind, recordId, sourceId, field, JSON.stringify(detail));
  }

  events(limit = 80) {
    return this.db
      .prepare('SELECT * FROM event ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
  }

  nextRevision(recordId) {
    const row = this.db.prepare('SELECT MAX(revision) AS max FROM publication WHERE record_id = ?').get(recordId);
    return (row?.max ?? 0) + 1;
  }

  insertPublication(pub) {
    const info = this.db
      .prepare(
        `INSERT INTO publication
          (record_id, revision, created_at, mode, completeness, contract, field_states, payload)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        pub.recordId,
        pub.revision,
        Date.now(),
        pub.mode,
        pub.completeness,
        JSON.stringify(pub.contract),
        JSON.stringify(pub.fieldStates),
        JSON.stringify(pub.payload),
      );
    return Number(info.lastInsertRowid);
  }

  supersedeOtherPublications(recordId, keepId) {
    this.db
      .prepare('UPDATE publication SET superseded_by = ? WHERE record_id = ? AND id != ? AND superseded_by IS NULL')
      .run(keepId, recordId, keepId);
  }

  publications(recordId) {
    return this.db
      .prepare('SELECT * FROM publication WHERE record_id = ? ORDER BY revision DESC')
      .all(recordId)
      .map(hydratePublication);
  }

  publication(id) {
    const row = this.db.prepare('SELECT * FROM publication WHERE id = ?').get(id);
    return row ? hydratePublication(row) : null;
  }

  latestPublication(recordId) {
    const row = this.db
      .prepare('SELECT * FROM publication WHERE record_id = ? ORDER BY revision DESC LIMIT 1')
      .get(recordId);
    return row ? hydratePublication(row) : null;
  }

  activePublication(recordId) {
    const row = this.db
      .prepare('SELECT * FROM publication WHERE record_id = ? AND superseded_by IS NULL ORDER BY revision DESC LIMIT 1')
      .get(recordId);
    return row ? hydratePublication(row) : null;
  }

  createDelivery(delivery) {
    const info = this.db
      .prepare(
        `INSERT INTO delivery
          (publication_id, receiver, idempotency_key, attempted_at, outcome, http_status, receipt_id, response)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        delivery.publicationId,
        delivery.receiver,
        delivery.idempotencyKey,
        Date.now(),
        delivery.outcome,
        delivery.httpStatus ?? null,
        delivery.receiptId ?? null,
        delivery.response ?? null,
      );
    return this.db.prepare('SELECT * FROM delivery WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  deliveriesFor(publicationId) {
    return this.db
      .prepare('SELECT * FROM delivery WHERE publication_id = ? ORDER BY id')
      .all(publicationId);
  }

  latestDelivery(publicationId) {
    return this.db
      .prepare('SELECT * FROM delivery WHERE publication_id = ? ORDER BY id DESC LIMIT 1')
      .get(publicationId);
  }
}

function hydrateRaw(row) {
  return {
    ...row,
    requested_fields: JSON.parse(row.requested_fields),
    parsed: JSON.parse(row.parsed),
  };
}

function hydrateAttempt(row) {
  return { ...row, requested_fields: JSON.parse(row.requested_fields) };
}

function hydrateClaim(row) {
  return { ...row, value: row.value === null ? null : JSON.parse(row.value) };
}

function hydratePublication(row) {
  return {
    ...row,
    contract: JSON.parse(row.contract),
    field_states: JSON.parse(row.field_states),
    payload: JSON.parse(row.payload),
  };
}
