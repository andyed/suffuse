import { randomUUID } from 'node:crypto';

export const EVIDENCE_SCHEMA = 'suffuse/evidence-transaction';
export const EVIDENCE_VERSION = 1;

const EVENT_STATUSES = Object.freeze({
  request: new Set(['recorded']),
  transport: new Set(['selected']),
  query: new Set(['captured', 'unavailable', 'failed']),
  protocol: new Set(['accepted', 'sent-unacknowledged', 'failed']),
  visual: new Set(['confirmed', 'mismatch', 'uncertain', 'not-observed']),
  restoration: new Set(['started', 'completed', 'failed']),
  uncertainty: new Set(['open', 'resolved'])
});

function timestamp(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function assertEvent(event) {
  const statuses = EVENT_STATUSES[event?.kind];
  if (!statuses || !statuses.has(event?.status)) {
    throw new TypeError(`Invalid evidence event: ${event?.kind ?? '(missing)'}/${event?.status ?? '(missing)'}`);
  }
  if (event.facts !== undefined && (event.facts === null || Array.isArray(event.facts) || typeof event.facts !== 'object')) {
    throw new TypeError('Evidence event facts must be an object');
  }
}

export function appendEvidence(transaction, event, { at = new Date() } = {}) {
  if (transaction?.schema !== EVIDENCE_SCHEMA || transaction?.version !== EVIDENCE_VERSION || !Array.isArray(transaction.events)) {
    throw new TypeError('Invalid evidence transaction');
  }
  assertEvent(event);
  transaction.events.push({ at: timestamp(at), ...event });
  return transaction;
}

export function openUncertainty(transaction, code, detail, options) {
  const alreadyOpen = transaction.events.some(event => (
    event.kind === 'uncertainty'
    && event.status === 'open'
    && event.facts?.code === code
    && !transaction.events.some(later => (
      later.kind === 'uncertainty'
      && later.status === 'resolved'
      && later.facts?.code === code
      && later.at >= event.at
    ))
  ));
  if (!alreadyOpen) {
    appendEvidence(transaction, {
      kind: 'uncertainty',
      status: 'open',
      source: 'suffuse',
      facts: { code, detail }
    }, options);
  }
  return transaction;
}

export function createEvidenceTransaction({
  transport,
  requestedState,
  transportFacts = {},
  id = randomUUID(),
  at = new Date()
}) {
  const transaction = {
    schema: EVIDENCE_SCHEMA,
    version: EVIDENCE_VERSION,
    id,
    events: []
  };
  appendEvidence(transaction, {
    kind: 'request',
    status: 'recorded',
    source: 'compiled-plan',
    facts: requestedState
  }, { at });
  appendEvidence(transaction, {
    kind: 'transport',
    status: 'selected',
    source: 'suffuse',
    facts: { transport, ...transportFacts }
  }, { at });
  return transaction;
}

function latest(events, kind) {
  return [...events].reverse().find(event => event.kind === kind) ?? null;
}

function openUncertainties(events, includeDetails) {
  const state = new Map();
  for (const event of events) {
    if (event.kind !== 'uncertainty' || !event.facts?.code) continue;
    if (event.status === 'open') state.set(event.facts.code, event.facts.detail ?? null);
    if (event.status === 'resolved') state.delete(event.facts.code);
  }
  return [...state].map(([code, detail]) => includeDetails ? { code, detail } : { code });
}

function applicationStatus(protocolEvents) {
  if (!protocolEvents.length) return 'not-attempted';
  const successes = protocolEvents.filter(event => ['accepted', 'sent-unacknowledged'].includes(event.status));
  const failures = protocolEvents.filter(event => event.status === 'failed');
  if (failures.length && successes.length) return 'partial-or-failed';
  if (failures.length) return 'failed';
  if (successes.every(event => event.status === 'accepted')) return 'accepted';
  if (successes.every(event => event.status === 'sent-unacknowledged')) return 'sent-unacknowledged';
  return 'mixed-evidence';
}

function statementFor(application, visual) {
  if (application === 'accepted' && visual === 'not-observed') return 'Command accepted but appearance unverified.';
  if (application === 'sent-unacknowledged' && visual === 'not-observed') return 'Command sent without device acknowledgment; appearance unverified.';
  if (application === 'partial-or-failed') return 'Some operations may have reached the device; the transition did not complete cleanly.';
  if (application === 'failed') return 'No successful control operation is recorded.';
  if (visual === 'confirmed') return 'Appearance was visually confirmed.';
  if (visual === 'mismatch') return 'Observed appearance did not match the requested state.';
  return 'No control-operation evidence is recorded.';
}

export function summarizeEvidence(transaction, { includeDetails = true } = {}) {
  if (transaction?.schema !== EVIDENCE_SCHEMA || transaction?.version !== EVIDENCE_VERSION || !Array.isArray(transaction.events)) {
    throw new TypeError('Invalid evidence transaction');
  }
  transaction.events.forEach(assertEvent);
  const transport = latest(transaction.events, 'transport');
  const query = latest(transaction.events, 'query');
  const visual = latest(transaction.events, 'visual');
  const restoration = latest(transaction.events, 'restoration');
  const protocolEvents = transaction.events.filter(event => event.kind === 'protocol');
  const application = applicationStatus(protocolEvents);
  const visualStatus = visual?.status ?? 'not-observed';
  const restorationFacts = restoration?.facts ?? {};
  const safeRestorationFacts = includeDetails
    ? restorationFacts
    : Object.fromEntries(Object.entries(restorationFacts).filter(([key]) => key !== 'message'));
  return {
    transactionId: transaction.id,
    selectedTransport: transport?.facts?.transport ?? null,
    application: {
      status: application,
      protocolOperations: protocolEvents.length,
      appearance: visualStatus,
      statement: statementFor(application, visualStatus)
    },
    queryResult: query ? { status: query.status, ...query.facts } : { status: 'not-attempted' },
    restoration: restoration ? { status: restoration.status, ...safeRestorationFacts } : { status: 'not-attempted' },
    residualUncertainty: openUncertainties(transaction.events, includeDetails)
  };
}

export function evidenceFromReceipt(receipt, { id = randomUUID() } = {}) {
  if (receipt?.evidence) {
    summarizeEvidence(receipt.evidence);
    return receipt.evidence;
  }
  const transport = receipt?.transport ?? 'cloud';
  const at = receipt?.createdAt ?? new Date();
  const plan = receipt?.plan ?? {};
  const transaction = createEvidenceTransaction({
    transport,
    id,
    at,
    requestedState: {
      executionMode: plan.executionMode ?? null,
      operationCount: plan.operations?.length ?? receipt?.sent?.length ?? null
    },
    transportFacts: { inferredFromLegacyReceipt: true }
  });
  appendEvidence(transaction, {
    kind: 'query',
    status: (receipt?.restoreOperations?.length ?? 0) > 0 ? 'captured' : 'unavailable',
    source: 'legacy-receipt',
    facts: { restoreOperationCount: receipt?.restoreOperations?.length ?? 0 }
  }, { at });

  if (Array.isArray(receipt?.outcomes)) {
    for (const outcome of receipt.outcomes) {
      appendEvidence(transaction, {
        kind: 'protocol',
        status: outcome.ok ? 'accepted' : 'failed',
        source: 'legacy-receipt',
        facts: { label: outcome.label ?? null, code: outcome.code ?? null }
      }, { at });
    }
  } else if (Array.isArray(receipt?.sent)) {
    for (const sent of receipt.sent) {
      appendEvidence(transaction, {
        kind: 'protocol',
        status: 'sent-unacknowledged',
        source: 'legacy-receipt',
        facts: { channel: sent.channel ?? null }
      }, { at });
    }
  } else if (receipt?.status === 'applied') {
    appendEvidence(transaction, {
      kind: 'protocol',
      status: transport === 'cloud' ? 'accepted' : 'sent-unacknowledged',
      source: 'legacy-receipt',
      facts: { inferred: true }
    }, { at });
  }

  if (receipt?.status === 'applied' || receipt?.status === 'partial-or-failed') {
    appendEvidence(transaction, {
      kind: 'visual',
      status: 'not-observed',
      source: 'legacy-receipt',
      facts: {}
    }, { at });
    openUncertainty(transaction, 'appearance-unverified', 'No visual observation is recorded.', { at });
  }
  if (receipt?.restoreCoverage?.warning) {
    openUncertainty(transaction, 'restoration-coverage', receipt.restoreCoverage.warning, { at });
  }
  return transaction;
}
