import { ApiError } from './http.js';
import { FIELDS, FIELD_META, REQUIRED_FIELDS } from './catalog.js';
import { normalizeClaims, decideRecord, buildPublication, compareDecisions } from './adjudication.js';

/**
 * Drives real HTTP requests against the three supplier services, stores every
 * raw frame and normalized claim, and never mutates the product row except on
 * explicit publication.
 */
export class Collector {
  constructor({ catalog, network, fetchImpl = fetch }) {
    this.catalog = catalog;
    this.network = network;
    this.fetch = fetchImpl;
    this.inflight = new Map();
  }

  sourceUrl(source, recordId, fields) {
    const query = fields?.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
    return `http://127.0.0.1:${source.port}/records/${encodeURIComponent(recordId)}${query}`;
  }

  health(recordId) {
    const attempts = this.catalog.attempts(recordId, 100);
    const bySource = {};
    for (const source of this.network.services) {
      const last = attempts.find((attempt) => attempt.source_id === source.id);
      const record = source.records.find((item) => item.id === recordId);
      bySource[source.id] = {
        online: source.online,
        name: source.name,
        recordVersion: record?.version ?? null,
        pendingRevision: source.pending.get(recordId) ?? null,
        lastAttempt: last
          ? { status: last.status, finishedAt: last.finished_at, errorCode: last.error_code, fields: last.requested_fields }
          : null,
      };
    }
    return bySource;
  }

  pendingBySource(recordId) {
    const result = {};
    for (const source of this.network.services) {
      const pending = source.pending.get(recordId);
      if (pending) result[source.id] = pending;
    }
    return result;
  }

  decision(recordId, { order = null } = {}) {
    const sources = this.network.services.map((source) => ({
      id: source.id,
      name: source.name,
      owned: source.owned,
      priority: source.priority,
    }));
    const priorityOrder = order ?? this.network.ordered().map((source) => source.id);
    const claims = this.catalog.claimsFor(recordId);
    const decided = decideRecord({
      sources,
      claims,
      pendingBySource: this.pendingBySource(recordId),
      healthBySource: this.health(recordId),
      askedByField: this.catalog.askedSourcesByField(recordId),
      orderOverride: priorityOrder,
    });
    decided.recordId = recordId;
    return decided;
  }

  /** Fields whose decision changes if the priority order changes. */
  affectedByOrder(recordId, newOrder) {
    const current = this.decision(recordId);
    const hypothetical = this.decision(recordId, { order: newOrder });
    const changed = compareDecisions(current, hypothetical);
    return {
      changed,
      current,
      hypothetical,
      details: changed.map((field) => ({
        field,
        label: FIELD_META[field].label,
        before: { state: current.fields[field].state, sourceId: current.fields[field].sourceId, value: current.fields[field].value },
        after: {
          state: hypothetical.fields[field].state,
          sourceId: hypothetical.fields[field].sourceId,
          value: hypothetical.fields[field].value,
        },
      })),
    };
  }

  async fetchFrom(source, recordId, fields, reason) {
    const startedAt = Date.now();
    const key = `${source.id}:${recordId}`;
    this.inflight.set(key, true);
    try {
      const response = await this.fetch(this.sourceUrl(source, recordId, fields), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { unparsed: text };
      }
      const finishedAt = Date.now();
      if (!response.ok) {
        const errorCode = parsed?.error ?? `http_${response.status}`;
        const errorMessage = parsed?.message ?? text.slice(0, 300);
        const rawId = this.catalog.recordRaw({
          sourceId: source.id,
          recordId,
          requestKind: `${reason}:error`,
          requestedFields: fields,
          fetchedAt: finishedAt,
          httpStatus: response.status,
          body: text,
          parsed,
          sourceVersion: null,
          sourceUpdatedAt: null,
          priority: source.priority,
          reason: 'upstream_error',
        });
        this.catalog.recordAttempt({
          recordId,
          sourceId: source.id,
          requestedFields: fields,
          scope: fields.length === source.owned.length ? 'owned' : 'field_scoped',
          startedAt,
          finishedAt,
          status: 'failed',
          errorCode,
          errorMessage,
          rawResponseId: rawId,
          priority: source.priority,
        });
        this.catalog.log('fetch_failed', { sourceId: source.id, fields, status: response.status, errorCode }, { recordId, sourceId: source.id });
        return { sourceId: source.id, ok: false, errorCode, errorMessage, httpStatus: response.status, rawResponseId: rawId };
      }
      const rawId = this.catalog.recordRaw({
        sourceId: source.id,
        recordId,
        requestKind: reason,
        requestedFields: parsed.requested ?? fields,
        fetchedAt: parsed.fetchedAt ?? finishedAt,
        httpStatus: response.status,
        body: text,
        parsed,
        sourceVersion: parsed.version,
        sourceUpdatedAt: parsed.updatedAt,
        priority: source.priority,
        reason,
      });
      const claims = normalizeClaims(source, parsed, fields).map((claim) => ({
        ...claim,
        rawResponseId: rawId,
        sourceId: source.id,
        recordId,
        sourceVersion: parsed.version,
        sourceUpdatedAt: parsed.updatedAt,
        priority: source.priority,
      }));
      this.catalog.recordClaims(claims);
      this.catalog.recordAttempt({
        recordId,
        sourceId: source.id,
        requestedFields: parsed.requested ?? fields,
        scope: fields.length === source.owned.length ? 'owned' : 'field_scoped',
        startedAt,
        finishedAt,
        status: 'ok',
        rawResponseId: rawId,
        priority: source.priority,
      });
      this.catalog.log(
        'fetch_ok',
        {
          sourceId: source.id,
          sourceName: source.name,
          fields: parsed.requested ?? fields,
          version: parsed.version,
          states: Object.fromEntries(claims.map((claim) => [claim.field, claim.state])),
          revisionQueuedDuringRequest: parsed.note ?? null,
        },
        { recordId, sourceId: source.id },
      );
      return {
        sourceId: source.id,
        ok: true,
        httpStatus: response.status,
        rawResponseId: rawId,
        version: parsed.version,
        fields: parsed.requested ?? fields,
        claims: claims.map((claim) => ({ field: claim.field, state: claim.state, value: claim.value })),
        note: parsed.note ?? null,
      };
    } catch (error) {
      const finishedAt = Date.now();
      const errorCode = error?.cause?.code ?? (error?.name === 'TimeoutError' ? 'timeout' : 'network_error');
      this.catalog.recordAttempt({
        recordId,
        sourceId: source.id,
        requestedFields: fields,
        scope: 'field_scoped',
        startedAt,
        finishedAt,
        status: 'failed',
        errorCode,
        errorMessage: error.message,
        priority: source.priority,
      });
      this.catalog.log('fetch_failed', { sourceId: source.id, fields, errorCode }, { recordId, sourceId: source.id });
      return { sourceId: source.id, ok: false, errorCode, errorMessage: error.message };
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Fetch a record. With `fields` given, only owning sources are asked and
   * each request is scoped with ?fields=... so suppliers return just those.
   */
  async collect(recordId, { fields = null, reason = 'manual_full_fetch', sourceIds = null } = {}) {
    if (this.inflight.has(`batch:${recordId}`)) {
      throw new ApiError(409, 'collect_in_progress', 'A collection for this record is already running');
    }
    this.inflight.set(`batch:${recordId}`, true);
    try {
      if (!this.catalog.rawResponse) throw new ApiError(500, 'internal_error', 'catalog not ready');
      const sources = this.network.ordered().filter((source) => !sourceIds || sourceIds.includes(source.id));
      const scope = fields ?? FIELDS;
      const jobs = [];
      for (const source of sources) {
        const ownedScope = scope.filter((field) => source.owned.includes(field));
        if (!ownedScope.length) continue;
        jobs.push(this.fetchFrom(source, recordId, ownedScope, reason));
      }
      const attempts = await Promise.all(jobs);
      const after = this.decision(recordId);
      this.catalog.log(
        'collect_finished',
        {
          reason,
          requestedFields: scope,
          attempts: attempts.map((attempt) => ({
            sourceId: attempt.sourceId,
            ok: attempt.ok,
            errorCode: attempt.errorCode ?? null,
            fields: attempt.fields ?? null,
          })),
          complete: after.complete,
        },
        { recordId },
      );
      return { attempts, decision: after };
    } finally {
      this.inflight.delete(`batch:${recordId}`);
    }
  }

  publish(recordId, { allowIncomplete = false, note = null } = {}) {
    const decision = this.decision(recordId);
    const publication = buildPublication(recordId, decision, {
      allowIncomplete,
      mode: decision.complete ? 'complete' : 'partial',
      note,
    });
    const revision = this.catalog.nextRevision(recordId);
    const id = this.catalog.insertPublication({ ...publication, revision });
    this.catalog.supersedeOtherPublications(recordId, id);
    this.catalog.log(
      'published',
      { revision, promise: publication.completeness, blocking: publication.contract.blockingRequired },
      { recordId },
    );
    return this.catalog.publication(id);
  }

  /** Fields whose current answer cannot be trusted because a better-placed source is silent. */
  provisionalFields(decision) {
    return FIELDS.filter((field) => decision.fields[field].provisional);
  }

  recordView(recordId) {
    const decision = this.decision(recordId);
    const publication = this.catalog.activePublication(recordId);
    const changed = compareDecisionsToPublication(decision, publication);
    return {
      recordId,
      decision,
      activePublication: publication,
      publicationHistory: this.catalog.publications(recordId).map((pub) => ({
        ...pub,
        superseded_by: pub.superseded_by,
      })),
      unpublishedChanges: changed,
      health: this.health(recordId),
      attempts: this.catalog.attempts(recordId),
      rawResponses: this.catalog.rawResponses(recordId),
    };
  }
}

function compareDecisionsToPublication(decision, publication) {
  if (!publication) return { neverPublished: true, fields: FIELDS.slice(), contractChanged: true };
  const changed = [];
  for (const field of FIELDS) {
    const publishedState = publication.field_states[field];
    const now = decision.fields[field];
    if (!publishedState) {
      changed.push(field);
      continue;
    }
    if (
      publishedState.state !== now.state ||
      publishedState.value !== now.value ||
      publishedState.sourceId !== now.sourceId ||
      publishedState.provisional !== now.provisional
    ) {
      changed.push(field);
    }
  }
  const promised = publication.contract.promise;
  const wouldPromise = decision.complete ? 'complete' : 'partial';
  return {
    neverPublished: false,
    fields: changed,
    contractChanged: promised !== wouldPromise,
    promised,
    wouldPromise,
  };
}

export { REQUIRED_FIELDS };
