import { ApiError } from './http.js';
import { FIELD_META, FIELDS } from './catalog.js';

const CIRRUS_FORBIDDEN = '__FORBIDDEN__';

/**
 * Translate each supplier dialect into normalized claims, then decide which
 * claim wins per field. Nothing is written to the product table here.
 *
 * Claim states:
 *   authorized – a real value we may publish
 *   cleared    – the source explicitly said "no value" (distinct from missing)
 *   missing    – the source had nothing to say about the field
 *   denied     – the source was asked but did not authorize this field
 *   unrequested– this row was fetched for other fields and skips this one
 */
export function normalizeFrame(source, frame, requestedFields) {
  const requested = requestedFields ?? source.fields;
  const claims = [];
  const fields = frame.fields ?? {};
  const authorization = frame.authorization ?? {};

  for (const field of FIELDS) {
    if (!requested.includes(field)) {
      claims.push({ field, state: 'unrequested' });
      continue;
    }
    const wasSent = Object.prototype.hasOwnProperty.call(fields, field);
    const auth = authorization[field];
    if (auth === 'denied' || fields[field] === CIRRUS_FORBIDDEN) {
      claims.push({ field, state: 'denied' });
      continue;
    }
    if (wasSent) {
      claims.push({ field, state: fields[field] === null ? 'cleared' : 'authorized', value: fields[field] });
      continue;
    }
    if (!source.fields.includes(field)) {
      // Supplier cannot speak for this field at all.
      claims.push({ field, state: 'unrequested' });
      continue;
    }
    claims.push({ field, state: 'missing' });
  }

  return claims;
}

/**
 * Full-fetch decision for a record: walk sources in current priority order and
 * take the first claim that says something positive about each field.
 * A preferred source's explicit clear also blocks lower sources from
 * resurrecting the field; only a true "missing" does not.
 */
export function decide(recordId, priorityOrder, claimsBySource) {
  const result = {};
  for (const field of FIELDS) {
    const trail = [];
    let chosen = { state: 'missing', sourceId: null, reason: 'no_source_offered_a_value' };
    for (const sourceId of priorityOrder) {
      const claim = (claimsBySource[sourceId] ?? []).find((item) => item.field === field);
      if (!claim) {
        trail.push({ sourceId, state: 'unrequested' });
        continue;
      }
      trail.push({ sourceId, state: claim.state });
      if (claim.state === 'authorized') {
        chosen = { state: 'authorized', sourceId, value: claim.value, reason: 'first_authorized_by_priority', trail };
        break;
      }
      if (claim.state === 'cleared') {
        chosen = { state: 'cleared', sourceId, value: null, reason: 'preferred_source_cleared', trail };
        break;
      }
      if (claim.state === 'denied') {
        chosen = { state: 'denied', sourceId, reason: 'preferred_source_denied', trail };
        break;
      }
    }
    result[field] = chosen;
  }
  return result;
}

export function summarizeCompleteness(decision) {
  const required = FIELDS.filter((field) => FIELD_META[field].required);
  const filled = required.filter((field) => decision[field]?.state === 'authorized').length;
  const blocking = required.filter((field) => !['authorized'].includes(decision[field]?.state));
  return {
    requiredTotal: required.length,
    requiredFilled: filled,
    complete: blocking.length === 0,
    blocking,
  };
}

export function assertKnownField(field) {
  if (!FIELDS.includes(field)) {
    throw new ApiError(400, 'unknown_field', `Unknown field ${field}`);
  }
}
