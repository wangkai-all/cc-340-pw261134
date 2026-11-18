import { FIELDS, FIELD_META, REQUIRED_FIELDS } from './catalog.js';
import { ApiError } from './http.js';

const CIRRUS_FORBIDDEN = '__FORBIDDEN__';

/**
 * Parse the source's own wire document into normalized claims. The adjudicator
 * intentionally reads `raw`, not the supplier's convenience `fields` object,
 * so each dialect is interpreted on its own terms.
 */
export function normalizeClaims(source, response, requestedFields) {
  const raw = response.raw ?? {};
  const claims = [];
  for (const field of requestedFields) {
    if (!source.owned.includes(field)) {
      claims.push({ field, state: 'not_held' });
      continue;
    }
    let state = 'missing';
    let value = null;

    if (source.id === 'aurora') {
      const payload = raw.payload ?? {};
      const notHeld = Array.isArray(raw.not_held) ? raw.not_held : [];
      if (notHeld.includes(field)) state = 'not_held';
      else if (Object.prototype.hasOwnProperty.call(payload, field)) {
        value = payload[field];
        if (value === null) state = 'cleared';
        else state = 'authorized';
      }
    } else if (source.id === 'borealis') {
      const attributes = raw.attributes ?? {};
      if (Object.prototype.hasOwnProperty.call(attributes, field)) {
        value = attributes[field];
        state = 'authorized';
      }
    } else {
      const columns = raw.columns ?? {};
      const authorization = raw.authorization ?? {};
      const columnValue = columns[field];
      if (authorization[field] === 'denied' || columnValue === CIRRUS_FORBIDDEN) {
        state = 'denied';
      } else if (Object.prototype.hasOwnProperty.call(columns, field)) {
        value = columnValue;
        state = value === null ? 'cleared' : 'authorized';
      }
    }

    if (state === 'authorized') {
      if (field === 'price' || field === 'weight_g') {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          state = 'invalid';
          value = null;
        } else {
          value = numeric;
        }
      } else {
        value = String(value);
      }
    }
    claims.push({ field, state, value });
  }
  return claims;
}

export function latestClaimMap(claims) {
  const map = new Map();
  for (const claim of claims) {
    const existing = map.get(`${claim.source_id}:${claim.field}`);
    if (!existing || existing.id < claim.id) map.set(`${claim.source_id}:${claim.field}`, claim);
  }
  return map;
}

/**
 * Decide one field. Priority is authoritative: a higher source that explicitly
 * clears a field suppresses lower values; denials are never treated as gaps.
 * A decision from a lower source stays provisional while a higher owner has
 * not answered, and provisional required fields cannot back a "complete" promise.
 */
export function decideRecord({
  sources,
  claims,
  pendingBySource = {},
  healthBySource = {},
  askedByField = {},
  orderOverride = null,
}) {
  const order = orderOverride ?? sources.map((source) => source.id);
  const priorityOf = (id) => {
    const index = order.indexOf(id);
    return index === -1 ? 999 : index + 1;
  };
  const latest = latestClaimMap(claims);

  const fields = {};
  for (const field of FIELDS) {
    const owners = sources
      .filter((source) => source.owned.includes(field))
      .sort((a, b) => priorityOf(a.id) - priorityOf(b.id));
    const asked = askedByField[field] ?? new Set();
    const base = {
      field,
      label: FIELD_META[field].label,
      required: FIELD_META[field].required,
      owners: owners.map((owner) => owner.id),
    };

    if (!owners.length) {
      fields[field] = {
        ...base,
        state: 'unavailable',
        value: null,
        considered: [],
        waitingFor: [],
        deniedBy: [],
        suppressed: [],
      };
      continue;
    }

    const considered = [];
    const waitingFor = [];
    const deniedBy = [];
    let winner = null;

    for (const owner of owners) {
      const priority = priorityOf(owner.id);
      const claim = latest.get(`${owner.id}:${field}`);
      if (!claim) {
        const reason = asked.has(owner.id)
          ? healthBySource[owner.id]?.online === false
            ? 'source_offline'
            : 'last_request_failed'
          : 'never_asked';
        const entry = {
          sourceId: owner.id,
          sourceName: owner.name,
          priority,
          state: 'no_answer',
          reason,
        };
        considered.push(entry);
        waitingFor.push(entry);
        continue;
      }
      const entry = {
        sourceId: owner.id,
        sourceName: owner.name,
        priority,
        state: claim.state,
        value: claim.value,
        claimId: claim.id,
        rawResponseId: claim.raw_response_id,
        sourceVersion: claim.source_version,
        recordedAt: claim.recorded_at,
        reason: claim.state === 'denied' ? 'refused_authorization' : null,
      };
      considered.push(entry);
      if (claim.state === 'denied') deniedBy.push({ sourceId: owner.id, sourceName: owner.name });
      if (!winner && (claim.state === 'authorized' || claim.state === 'cleared')) winner = entry;
    }

    // Only owners ranked above the winner leave the answer unverified. Owners
    // below it can still improve coverage, but not priority.
    const unverifiedBy = winner ? waitingFor.filter((entry) => entry.priority < winner.priority) : [];
    const provisional = Boolean(winner && unverifiedBy.length);

    let state;
    let value = null;
    let sourceId = null;
    let sourceName = null;
    let claimId = null;
    let rawResponseId = null;
    let sourceVersion = null;
    let fetchedAt = null;

    if (winner) {
      state = winner.state;
      value = winner.state === 'authorized' ? winner.value : null;
      sourceId = winner.sourceId;
      sourceName = winner.sourceName;
      claimId = winner.claimId;
      rawResponseId = winner.rawResponseId;
      sourceVersion = winner.sourceVersion;
      fetchedAt = winner.recordedAt;
    } else {
      const answered = considered.filter((entry) => entry.state !== 'no_answer');
      const blockedByUnanswered = answered.length
        ? considered.some((entry) => entry.state === 'no_answer' && entry.priority < answered[0].priority)
        : true;
      if (!answered.length) {
        // Nobody ever answered for this field. This is not the same as a source
        // saying "missing", and it is not waiting on a queued revision either.
        state = considered.every((entry) => entry.reason === 'never_asked') ? 'uncollected' : 'pending';
      } else if (blockedByUnanswered) {
        // A higher-priority owner still has to speak before a lower owner's
        // refusal can be treated as the record's answer.
        state = 'pending';
      } else if (deniedBy.length) {
        // A refusal is a concrete answer that blocks the field; it is reported
        // even when other owners simply hold nothing.
        state = 'denied';
      } else if (considered.some((entry) => entry.state === 'invalid')) {
        state = 'invalid';
      } else if (considered.some((entry) => entry.state === 'missing' || entry.state === 'not_held')) {
        state = 'missing';
      } else {
        state = 'pending';
      }
    }

    const suppressed = [];
    if (winner) {
      for (const entry of considered) {
        if (entry.state === 'authorized' && entry.priority > winner.priority) {
          suppressed.push({
            sourceId: entry.sourceId,
            sourceName: entry.sourceName,
            value: entry.value,
            reason: winner.state === 'cleared' ? 'higher_priority_clear' : 'lower_priority',
          });
        }
      }
    }

    const pendingAtSource = owners
      .filter((owner) => pendingBySource[owner.id]?.field === field)
      .map((owner) => ({
        sourceId: owner.id,
        sourceName: owner.name,
        value: pendingBySource[owner.id].value,
        queuedAt: pendingBySource[owner.id].queuedAt,
      }));
    const revisionPending = pendingAtSource.some((entry) => entry.sourceId === sourceId);
    const sourceDown = Boolean(sourceId && healthBySource[sourceId]?.online === false);
    const lastAttemptFailed = Boolean(sourceId && healthBySource[sourceId]?.lastAttempt?.status === 'failed');
    const stale = sourceDown || lastAttemptFailed;
    const currentVersion = sourceId ? healthBySource[sourceId]?.recordVersion ?? null : null;
    const versionBehind =
      sourceVersion !== null && currentVersion !== null && currentVersion > sourceVersion
        ? currentVersion - sourceVersion
        : 0;
    const lastAttempt = sourceId ? healthBySource[sourceId]?.lastAttempt : null;
    const answered = considered.filter((entry) => entry.state !== 'no_answer');

    // A value whose source is unreachable, or whose latest refresh failed, is
    // still shown (it is the last known answer) but cannot back a promise.
    const provisionalNow = provisional || (state === 'authorized' && stale);

    fields[field] = {
      ...base,
      state,
      value,
      sourceId,
      sourceName,
      claimId,
      rawResponseId,
      sourceVersion,
      fetchedAt,
      provisional: provisionalNow,
      stale,
      revisionPending,
      pendingAtSource,
      versionBehind,
      waitingFor,
      unverifiedBy,
      deniedBy,
      suppressed,
      considered,
      answeredCount: answered.length,
      ownerCount: owners.length,
      coverage: answered.length === owners.length ? 'full' : answered.length ? 'partial' : 'none',
      lastAttemptAt: lastAttempt?.finishedAt ?? null,
      lastAttemptStatus: lastAttempt?.status ?? null,
    };
  }

  const waitingFields = FIELDS.filter((field) => {
    const entry = fields[field];
    return entry.provisional || entry.state === 'pending' || entry.state === 'uncollected';
  });
  const satisfied = (field) => {
    const entry = fields[field];
    return entry.state === 'authorized' && !entry.provisional && !entry.stale;
  };
  const complete = REQUIRED_FIELDS.every(satisfied);
  const requiredFilled = REQUIRED_FIELDS.filter(satisfied).length;
  const blockingRequired = REQUIRED_FIELDS.filter((field) => !satisfied(field));

  return {
    recordId: null,
    computedAt: Date.now(),
    fields,
    complete,
    requiredTotal: REQUIRED_FIELDS.length,
    requiredFilled,
    blockingRequired,
    waitingFields,
    waitingFor: waitingFields.map((field) => ({
      field,
      label: FIELD_META[field].label,
      required: FIELD_META[field].required,
      state: fields[field].state,
      provisional: fields[field].provisional,
      sources: fields[field].unverifiedBy.length ? fields[field].unverifiedBy : fields[field].waitingFor,
    })),
    uncollected: claims.length === 0,
    order,
  };
}

export function compareDecisions(before, after) {
  const changed = [];
  for (const field of FIELDS) {
    const a = before.fields[field];
    const b = after.fields[field];
    if (
      a.state !== b.state ||
      a.value !== b.value ||
      a.sourceId !== b.sourceId ||
      a.provisional !== b.provisional
    ) {
      changed.push(field);
    }
  }
  return changed;
}

export function diffAgainstPublication(decision, publication) {
  if (!publication) return { unpublished: true, fields: FIELDS.slice(), reason: 'never_published' };
  const changed = [];
  for (const field of FIELDS) {
    const state = publication.field_states[field];
    const current = decision.fields[field];
    if (!state) {
      changed.push(field);
      continue;
    }
    if (state.state !== current.state || state.value !== current.value || state.sourceId !== current.sourceId) {
      changed.push(field);
    }
  }
  return { unpublished: changed.length > 0 || publication.contract.promise !== (decision.complete ? 'complete' : 'partial'), fields: changed, reason: changed.length ? 'decision_changed' : 'in_sync' };
}

export function buildPublication(recordId, decision, { allowIncomplete, mode, note }) {
  if (!decision.complete && !allowIncomplete) {
    throw new ApiError(409, 'incomplete_decision', 'Required fields are not settled; publish a partial version explicitly', {
      blockingRequired: decision.blockingRequired,
      waitingFor: decision.waitingFor,
    });
  }
  const unresolved = FIELDS.filter((field) => decision.fields[field].state === 'uncollected');
  if (allowIncomplete && unresolved.length) {
    throw new ApiError(409, 'not_collected_yet', 'Some fields have never been requested; collect before publishing', {
      uncollected: unresolved,
    });
  }
  const fieldStates = {};
  const payload = {};
  for (const field of FIELDS) {
    const decided = decision.fields[field];
    fieldStates[field] = {
      state: decided.state,
      value: decided.value,
      sourceId: decided.sourceId,
      sourceName: decided.sourceName,
      sourceVersion: decided.sourceVersion,
      rawResponseId: decided.rawResponseId,
      fetchedAt: decided.fetchedAt,
      provisional: decided.provisional,
      pendingAtSource: decided.pendingAtSource,
      versionBehind: decided.versionBehind,
      stale: decided.stale,
      waitingFor: decided.waitingFor,
      deniedBy: decided.deniedBy,
      suppressed: decided.suppressed,
    };
    if (decided.state === 'authorized' && !decided.provisional && !decided.stale) payload[field] = decided.value;
  }
  const promise = decision.complete ? 'complete' : 'partial';
  const contract = {
    version: 'catalog-publication/1',
    promise,
    statement:
      promise === 'complete'
        ? '所有必填字段均已由授权来源确认，可视为完整。'
        : '部分必填字段尚未确认；本版明确标记为不完整，未承诺完整。',
    requiredFields: REQUIRED_FIELDS,
    requiredFilled: decision.requiredFilled,
    requiredTotal: decision.requiredTotal,
    blockingRequired: decision.blockingRequired,
    waitingFor: decision.waitingFor,
    settledAt: decision.computedAt,
    note: note ?? null,
  };
  return { recordId, mode, completeness: promise, contract, fieldStates, payload };
}

export function assertKnownFields(fields) {
  const unknown = fields.filter((field) => !FIELDS.includes(field));
  if (unknown.length) throw new ApiError(400, 'unknown_field', `Unknown fields: ${unknown.join(', ')}`);
}
