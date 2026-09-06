#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GoveeSkillError,
  compileLightScore,
  devicesFromDocument,
  mergeDeviceCapabilities,
  redactIdentifier,
  redactPlan,
  restoreOperationsFromState,
  selectDevice,
  summarizeDevices,
  validateControlOperation
} from './core.mjs';
import {
  loadPaletteCatalog,
  materializePaletteScore,
  summarizePalettes
} from './palettes.mjs';
import {
  appendEvidence,
  createEvidenceTransaction,
  evidenceFromReceipt,
  openUncertainty,
  summarizeEvidence
} from './evidence.mjs';
import {
  buildDoctorReport,
  buildHouseholdRegistry,
  summarizeHouseholdRegistry
} from './registry.mjs';

const BASE_URL = 'https://openapi.api.govee.com';
const PATHS = Object.freeze({
  devices: '/router/api/v1/user/devices',
  state: '/router/api/v1/device/state',
  control: '/router/api/v1/device/control',
  scenes: '/router/api/v1/device/scenes',
  diyScenes: '/router/api/v1/device/diy-scenes'
});
const WRITE_INTERVAL_MS = 550;
const TIMEOUT_MS = 10_000;

function usage() {
  return `Usage:
  govee.mjs inspect [--sku SKU] [--name NAME] [--fixture FILE] [--show-identifiers]
  govee.mjs household [--subnet 192.168.1] [--timeout MS] [--show-identifiers]
  govee.mjs doctor [--subnet 192.168.1] [--timeout MS]
  govee.mjs scenes --sku SKU [--name NAME] [--instance lightScene|diyScene]
  govee.mjs palettes [--name NAME] [--catalog FILE]
  govee.mjs compile --score FILE --capabilities FILE [--catalog FILE] [--output FILE]
  govee.mjs apply --score FILE [--catalog FILE] [--confirm-write --receipt FILE]
                   [--confirm-segments]
  govee.mjs evidence --receipt FILE
  govee.mjs restore --receipt FILE --confirm-write
  govee.mjs lan scan [--subnet 192.168.1] [--timeout MS]
  govee.mjs lan paint --score FILE [--ip ADDR] [--hold-seconds N]
                      [--confirm-write --receipt FILE --confirm-segments]
  govee.mjs lan release --ip ADDR --confirm-write
  govee.mjs lan holds
  govee.mjs ble scan [--timeout MS]
  govee.mjs ble set [--id ID | --name NAME] [--power on|off] [--color #RRGGBB]
                    [--brightness 1-100] [--confirm-write --receipt FILE]

GOVEE_API_KEY is required for live cloud commands; lan and ble commands are keyless.
Writes require --confirm-write on every path, cloud, LAN or BLE.`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (['confirm-write', 'confirm-segments', 'show-identifiers'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new GoveeSkillError(`Missing value for --${key}`, 'invalid-arguments');
    args[key] = value;
    index += 1;
  }
  return args;
}

async function loadJson(path, label) {
  if (!path) throw new GoveeSkillError(`${label} path is required`, 'invalid-arguments');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new GoveeSkillError(`Could not read ${label}: ${error.message}`, 'invalid-json');
  }
}

async function writePrivateJson(path, value, { overwrite = false } = {}) {
  if (!path) throw new GoveeSkillError('Output path is required', 'invalid-arguments');
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (!overwrite) {
    await writeFile(path, body, { mode: 0o600, flag: 'wx' });
    await chmod(path, 0o600);
    return;
  }

  // Rewrite through the receipt's own directory so rename is atomic. A crash
  // leaves either the old complete journal or the new complete journal, never a
  // truncated JSON file that destroys the restoration record.
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function requestedState(plan) {
  return {
    executionMode: plan.executionMode ?? null,
    operationCount: plan.operations?.length ?? null,
    operations: plan.operations?.map(operation => ({
      label: operation.label ?? null,
      capability: operation.payload?.capability ?? null
    })) ?? null,
    restoreMode: plan.restoreMode ?? null,
    look: plan.requestedLook ?? null,
    channels: plan.channels ?? null,
    pixels: plan.pixels ?? null,
    holdSeconds: plan.holdSeconds ?? null
  };
}

function beginEvidence(plan, transport) {
  const profiles = {
    cloud: {
      protocolAcknowledgment: 'service-response',
      query: 'cloud-state',
      visualVerification: 'external-only'
    },
    lan: {
      protocolAcknowledgment: 'none',
      query: 'pre-write-whole-device-only',
      visualVerification: 'external-only'
    },
    ble: {
      protocolAcknowledgment: 'none',
      query: 'unavailable',
      visualVerification: 'external-only'
    }
  };
  const evidence = createEvidenceTransaction({
    transport,
    requestedState: requestedState(plan),
    transportFacts: profiles[transport]
  });
  for (const [index, warning] of (plan.warnings ?? []).entries()) {
    openUncertainty(evidence, `plan-warning-${index + 1}`, warning);
  }
  return evidence;
}

function recordOutcomes(evidence, outcomes, { transport, source }) {
  for (const outcome of outcomes) {
    appendEvidence(evidence, {
      kind: 'protocol',
      status: outcome.ok === false
        ? 'failed'
        : transport === 'cloud' ? 'accepted' : 'sent-unacknowledged',
      source,
      facts: {
        label: outcome.label ?? outcome.action ?? outcome.channel ?? null,
        code: outcome.code ?? null,
        message: outcome.ok === false ? outcome.message ?? null : null
      }
    });
  }
}

function recordAppearanceBoundary(evidence) {
  appendEvidence(evidence, {
    kind: 'visual',
    status: 'not-observed',
    source: 'suffuse',
    facts: { method: null }
  });
  openUncertainty(evidence, 'appearance-unverified', 'No visual observation is recorded.');
}

function recordRestoreCoverage(evidence, restoreCoverage) {
  if (restoreCoverage?.warning) {
    openUncertainty(evidence, 'restoration-coverage', restoreCoverage.warning);
  }
}

function apiKey() {
  const key = String(process.env.GOVEE_API_KEY ?? '').trim();
  if (!key) throw new GoveeSkillError('GOVEE_API_KEY is not configured', 'missing-api-key');
  return key;
}

async function apiRequest(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Govee-API-Key': apiKey()
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    let document = null;
    try {
      document = await response.json();
    } catch {
      throw new GoveeSkillError(`Govee returned non-JSON HTTP ${response.status}`, 'invalid-response');
    }
    const hasServiceCode = document?.code !== undefined && document?.code !== null;
    const serviceCode = hasServiceCode ? Number(document.code) : null;
    if (!response.ok || (Number.isFinite(serviceCode) && serviceCode !== 200)) {
      const status = response.ok && Number.isFinite(serviceCode) ? serviceCode : response.status;
      const code = status === 401 ? 'invalid-api-key' : status === 429 ? 'rate-limited' : 'platform-error';
      const serviceMessage = String(document?.message ?? document?.msg ?? '').trim();
      const details = [
        `HTTP ${response.status}`,
        Number.isFinite(serviceCode) ? `service ${serviceCode}` : null,
        serviceMessage || null
      ].filter(Boolean).join(', ');
      throw new GoveeSkillError(`Govee request failed (${details})`, code);
    }
    return document;
  } catch (error) {
    if (error?.name === 'AbortError') throw new GoveeSkillError('Govee request timed out', 'timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverDevices() {
  return devicesFromDocument(await apiRequest(PATHS.devices));
}

async function queryState(device) {
  return apiRequest(PATHS.state, {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      payload: { sku: device.sku, device: device.device }
    }
  });
}

async function querySceneCatalog(device, path) {
  return apiRequest(path, {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      payload: { sku: device.sku, device: device.device }
    }
  });
}

async function enrichDeviceForScore(device, score) {
  const directScene = score?.look?.kind === 'scene';
  const sceneFallback = score?.look?.kind === 'gradient'
    && Array.isArray(score?.fallback)
    && score.fallback.includes('scene')
    && String(score?.look?.fallbackScene ?? '').trim();
  if (!directScene && !sceneFallback) return device;
  const instance = directScene ? score.look.sceneInstance : null;
  const documents = [];
  if (!instance || instance === 'lightScene') {
    documents.push(await querySceneCatalog(device, PATHS.scenes));
  }
  if (!instance || instance === 'diyScene') {
    documents.push(await querySceneCatalog(device, PATHS.diyScenes));
  }
  return documents.length ? mergeDeviceCapabilities(device, documents) : device;
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function executeOperations(operations) {
  const outcomes = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = validateControlOperation(operations[index]);
    if (index) await wait(WRITE_INTERVAL_MS);
    try {
      const response = await apiRequest(PATHS.control, {
        method: 'POST',
        body: { requestId: randomUUID(), payload: operation.payload }
      });
      outcomes.push({ label: operation.label, ok: true, code: response.code ?? 200 });
    } catch (error) {
      outcomes.push({ label: operation.label, ok: false, code: error.code, message: error.message });
      error.outcomes = outcomes;
      throw error;
    }
  }
  return outcomes;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function inspect(args) {
  const document = args.fixture ? await loadJson(args.fixture, 'fixture') : await apiRequest(PATHS.devices);
  const devices = devicesFromDocument(document);
  printJson({
    readOnly: true,
    source: args.fixture ? 'fixture' : 'live',
    matchedDeviceCount: summarizeDevices(devices, { sku: args.sku, name: args.name }).length,
    devices: summarizeDevices(devices, {
      sku: args.sku,
      name: args.name,
      showIdentifiers: !!args['show-identifiers']
    })
  });
}

function sourceError(error) {
  return {
    code: error?.code ?? 'unexpected-error',
    message: String(error?.message ?? error)
  };
}

async function probeHousehold(args = {}) {
  const observedAt = new Date().toISOString();
  const timeoutMs = args.timeout === undefined ? undefined : Number(args.timeout);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new GoveeSkillError('--timeout must be a positive number of milliseconds', 'invalid-arguments');
  }

  const cloudConfigured = !!String(process.env.GOVEE_API_KEY ?? '').trim();
  const cloudProbe = cloudConfigured
    ? discoverDevices()
      .then(devices => ({ devices, status: { status: 'ok', deviceCount: devices.length } }))
      .catch(error => ({ devices: [], status: { status: 'error', deviceCount: 0, error: sourceError(error) } }))
    : Promise.resolve({ devices: [], status: { status: 'not-configured', deviceCount: 0 } });

  const lanProbe = import('./lan.mjs')
    .then(lan => lan.lanScan({
      subnet: args.subnet ?? null,
      timeoutMs
    }))
    .then(devices => ({ devices, status: { status: 'ok', deviceCount: devices.length } }))
    .catch(error => ({ devices: [], status: { status: 'error', deviceCount: 0, error: sourceError(error) } }));

  const [cloud, lan] = await Promise.all([cloudProbe, lanProbe]);
  return buildHouseholdRegistry({
    cloudDevices: cloud.devices,
    lanDevices: lan.devices,
    observedAt,
    sources: { cloud: cloud.status, lan: lan.status }
  });
}

async function household(args) {
  const registry = await probeHousehold(args);
  printJson(summarizeHouseholdRegistry(registry, {
    showIdentifiers: !!args['show-identifiers']
  }));
}

async function doctor(args) {
  const registry = await probeHousehold(args);
  printJson(buildDoctorReport(summarizeHouseholdRegistry(registry)));
}

async function palettes(args) {
  const catalog = await loadPaletteCatalog(args.catalog);
  const available = summarizePalettes(catalog);
  const selected = args.name
    ? available.filter(palette => palette.name.toLowerCase() === String(args.name).trim().toLowerCase())
    : available;
  if (args.name && !selected.length) throw new GoveeSkillError(`Unknown palette: ${args.name}`, 'unknown-palette');
  printJson({ readOnly: true, source: args.catalog ? 'custom' : 'bundled', palettes: selected });
}

async function scenes(args) {
  const device = selectDevice(await discoverDevices(), { sku: args.sku, name: args.name });
  const requested = args.instance;
  if (requested && !['lightScene', 'diyScene'].includes(requested)) {
    throw new GoveeSkillError('scenes --instance must be lightScene or diyScene', 'invalid-arguments');
  }
  const documents = [];
  if (!requested || requested === 'lightScene') documents.push(await querySceneCatalog(device, PATHS.scenes));
  if (!requested || requested === 'diyScene') documents.push(await querySceneCatalog(device, PATHS.diyScenes));
  const enriched = mergeDeviceCapabilities(device, documents);
  const grouped = new Map();
  for (const item of enriched.capabilities ?? []) {
    if (item?.type !== 'devices.capabilities.dynamic_scene') continue;
    if (!['lightScene', 'diyScene'].includes(item?.instance)) continue;
    const names = grouped.get(item.instance) ?? new Set();
    (item?.parameters?.options ?? []).map(option => option?.name).filter(Boolean).forEach(name => names.add(name));
    grouped.set(item.instance, names);
  }
  const catalogs = [...grouped].map(([instance, names]) => ({ instance, scenes: [...names] }));
  printJson({
    readOnly: true,
    target: { sku: device.sku, device: redactIdentifier(device.device) },
    catalogs
  });
}

async function loadScoreWithPalette(args) {
  const score = await loadJson(args.score, 'score');
  const catalog = await loadPaletteCatalog(args.catalog);
  return materializePaletteScore(score, catalog);
}

async function compile(args) {
  const score = await loadScoreWithPalette(args);
  const devices = devicesFromDocument(await loadJson(args.capabilities, 'capabilities'));
  const plan = compileLightScore(score, selectDevice(devices, score.target));
  if (args.output) {
    await writePrivateJson(args.output, plan);
    printJson({ written: args.output, mode: plan.executionMode, operationCount: plan.operations.length });
    return;
  }
  printJson(args['show-identifiers'] ? plan : redactPlan(plan));
}

async function inspectEvidence(args) {
  const receipt = await loadJson(args.receipt, 'receipt');
  if (receipt?.version !== 1 || !Array.isArray(receipt?.restoreOperations)) {
    throw new GoveeSkillError('Receipt has no valid restore operation list', 'invalid-receipt');
  }
  printJson({
    readOnly: true,
    receiptStatus: receipt.status ?? null,
    evidence: summarizeEvidence(evidenceFromReceipt(receipt), { includeDetails: false })
  });
}

async function apply(args) {
  if (args.fixture) throw new GoveeSkillError('apply never accepts fixture data', 'fixture-write-blocked');
  const score = await loadScoreWithPalette(args);
  let device = selectDevice(await discoverDevices(), score.target);
  device = await enrichDeviceForScore(device, score);
  const plan = compileLightScore(score, device);

  if (!args['confirm-write']) {
    printJson({ dryRun: true, plan: redactPlan(plan) });
    return;
  }
  if (!args.receipt) throw new GoveeSkillError('A private --receipt path is required for writes', 'missing-receipt');
  const segmentedWrite = plan.operations.some(operation => operation.payload.capability.instance === 'segmentedColorRgb');
  if (segmentedWrite && !args['confirm-segments']) {
    throw new GoveeSkillError(
      'Segment writes require --confirm-segments because advertised support still needs visual verification',
      'segment-write-not-confirmed'
    );
  }

  const evidence = beginEvidence(plan, 'cloud');

  // Reserve the receipt before touching a physical device. This fails closed if the path
  // already exists and leaves a useful prepared record if the process exits unexpectedly.
  await writePrivateJson(args.receipt, {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'prepared',
    transport: 'cloud',
    plan,
    outcomes: [],
    restoreOperations: [],
    restoreCoverage: { mode: plan.restoreMode, complete: false, capturedInstances: [], warning: 'State capture has not run.' },
    evidence
  });

  let stateDocument = null;
  let stateWarning = null;
  if (plan.restoreMode === 'capture') {
    try {
      stateDocument = await queryState(device);
      appendEvidence(evidence, {
        kind: 'query',
        status: 'captured',
        source: 'govee-cloud-state',
        facts: { query: 'pre-write-state' }
      });
    } catch (error) {
      stateWarning = `Pre-write state capture failed: ${error.message}`;
      appendEvidence(evidence, {
        kind: 'query',
        status: 'failed',
        source: 'govee-cloud-state',
        facts: { query: 'pre-write-state', code: error.code ?? 'query-failed' }
      });
    }
  } else {
    appendEvidence(evidence, {
      kind: 'query',
      status: 'unavailable',
      source: 'light-score',
      facts: { reason: 'restore-mode-none' }
    });
  }
  const restoreOperations = stateDocument ? restoreOperationsFromState(device, stateDocument) : [];
  const sceneWrite = plan.operations.some(operation => operation.payload.capability.type === 'devices.capabilities.dynamic_scene');
  const restoreCoverage = {
    mode: plan.restoreMode,
    complete: plan.restoreMode === 'capture' && !segmentedWrite && !sceneWrite && restoreOperations.length > 0,
    capturedInstances: restoreOperations.map(operation => operation.payload.capability.instance),
    warning: stateWarning || (segmentedWrite
      ? 'Prior per-segment colors may not be queryable; restoration is partial unless an advertised snapshot is used.'
      : sceneWrite ? 'Prior dynamic scene selection may not be queryable; restoration covers only returned device state.'
      : restoreOperations.length ? null : 'No queryable restore operations were captured.')
  };
  recordRestoreCoverage(evidence, restoreCoverage);

  let outcomes;
  try {
    outcomes = await executeOperations(plan.operations);
  } catch (error) {
    outcomes = error.outcomes ?? [];
    recordOutcomes(evidence, outcomes, { transport: 'cloud', source: 'govee-cloud-control' });
    if (outcomes.some(outcome => outcome.ok)) recordAppearanceBoundary(evidence);
    const receipt = {
      version: 1,
      createdAt: new Date().toISOString(),
      status: 'partial-or-failed',
      transport: 'cloud',
      plan,
      outcomes,
      restoreOperations,
      restoreCoverage,
      evidence
    };
    await writePrivateJson(args.receipt, receipt, { overwrite: true });
    throw new GoveeSkillError(`Write stopped; receipt saved to ${args.receipt}: ${error.message}`, error.code);
  }

  recordOutcomes(evidence, outcomes, { transport: 'cloud', source: 'govee-cloud-control' });
  recordAppearanceBoundary(evidence);

  const receipt = {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'applied',
    transport: 'cloud',
    plan,
    outcomes,
    restoreOperations,
    restoreCoverage,
    evidence
  };
  await writePrivateJson(args.receipt, receipt, { overwrite: true });
  printJson({
    applied: true,
    target: { sku: plan.target.sku, device: redactIdentifier(plan.target.device) },
    executionMode: plan.executionMode,
    operationCount: outcomes.length,
    receipt: args.receipt,
    restoreCoverage,
    evidence: summarizeEvidence(evidence)
  });
}

async function restore(args) {
  if (!args['confirm-write']) throw new GoveeSkillError('restore requires --confirm-write', 'write-not-confirmed');
  const receipt = await loadJson(args.receipt, 'receipt');
  if (receipt?.version !== 1 || !Array.isArray(receipt?.restoreOperations)) {
    throw new GoveeSkillError('Receipt has no valid restore operation list', 'invalid-receipt');
  }
  const evidence = evidenceFromReceipt(receipt);
  receipt.evidence = evidence;
  appendEvidence(evidence, {
    kind: 'restoration',
    status: 'started',
    source: 'suffuse',
    facts: { operationCount: receipt.restoreOperations.length }
  });
  receipt.updatedAt = new Date().toISOString();
  // Persist the attempt before touching the device. If the process dies during
  // restore, the private journal says that restoration was in flight.
  await writePrivateJson(args.receipt, receipt, { overwrite: true });

  let restored;
  try {
    // LAN receipts restore over LAN — releasing any hold first, then replaying the
    // captured whole-device state via the documented colorwc channel.
    if (receipt.transport === 'lan') {
      restored = await restoreLan(receipt, await import('./lan.mjs'));
    // BLE receipts replay the DECLARED restore point — the channel has no
    // readback, so this is a return to a stated neutral, not to prior state.
    } else if (receipt.transport === 'ble') {
      restored = await restoreBle(receipt, await import('./ble.mjs'));
    } else {
      if (!receipt.restoreOperations.length) {
        throw new GoveeSkillError('Receipt contains no queryable state to restore', 'restore-unavailable');
      }
      receipt.restoreOperations.forEach(validateControlOperation);
      const outcomes = await executeOperations(receipt.restoreOperations);
      restored = {
        restored: true,
        transport: 'cloud',
        target: {
          sku: receipt?.plan?.target?.sku,
          device: redactIdentifier(receipt?.plan?.target?.device)
        },
        operationCount: outcomes.length,
        outcomes,
        warning: receipt?.restoreCoverage?.warning ?? null
      };
    }
  } catch (error) {
    appendEvidence(evidence, {
      kind: 'restoration',
      status: 'failed',
      source: receipt.transport ?? 'cloud',
      facts: { code: error.code ?? 'restore-failed', message: error.message }
    });
    receipt.updatedAt = new Date().toISOString();
    await writePrivateJson(args.receipt, receipt, { overwrite: true });
    throw error;
  }

  appendEvidence(evidence, {
    kind: 'restoration',
    status: 'completed',
    source: receipt.transport ?? 'cloud',
    facts: {
      operationCount: restored.operationCount ?? restored.sent?.length ?? null,
      coverageComplete: receipt?.restoreCoverage?.complete === true,
      appearance: 'not-observed'
    }
  });
  openUncertainty(evidence, 'restoration-appearance-unverified', 'Restore operations completed, but restored appearance was not visually observed.');
  receipt.updatedAt = new Date().toISOString();
  await writePrivateJson(args.receipt, receipt, { overwrite: true });
  printJson({ ...restored, evidence: summarizeEvidence(evidence) });
}

// ── LAN commands ─────────────────────────────────────────────────────────────
// Same contract as the cloud path — score in, gates on, receipt out — with a
// different wire. Everything transport-specific (razer encoding, holds, the
// contention rule, why counts must match) lives in lan.mjs.

async function lanCommand(args) {
  const lan = await import('./lan.mjs');
  const sub = args._[1];

  if (sub === 'scan') {
    const devices = await lan.lanScan({
      timeoutMs: args.timeout ? Number(args.timeout) : undefined,
      subnet: args.subnet ?? null
    });
    printJson({
      devices: devices.map(device => ({
        sku: device.sku,
        ip: device.ip,
        device: redactIdentifier(device.device),
        perLed: device.razer ? { pixels: device.razer.pixels, blend: device.razer.blend, verified: device.razer.verified } : null
      }))
    });
    return;
  }

  if (sub === 'holds') {
    printJson({ holds: await lan.listHolds() });
    return;
  }

  if (sub === 'release') {
    if (!args.ip) throw new GoveeSkillError('lan release requires --ip', 'invalid-arguments');
    if (!args['confirm-write']) throw new GoveeSkillError('lan release requires --confirm-write', 'write-not-confirmed');
    const hold = await lan.releaseHold(args.ip);
    printJson({ released: true, ip: args.ip, hadHold: !!hold });
    return;
  }

  if (sub === 'hold-loop') {
    // Internal: the detached keepalive spawned by `lan paint`. Not for direct use.
    const colors = JSON.parse(Buffer.from(args.frame, 'base64').toString('utf8'));
    await lan.runHoldLoop(args.ip, colors, Number(args.ttl));
    return;
  }

  if (sub === 'paint') return lanPaint(args, lan);

  throw new GoveeSkillError(`Unknown lan subcommand: ${sub ?? '(none)'}`, 'invalid-command');
}

async function lanPaint(args, lan) {
  if (args.fixture) throw new GoveeSkillError('lan paint never accepts fixture data', 'fixture-write-blocked');
  const score = await loadScoreWithPalette(args);
  if (!['gradient', 'solid'].includes(score.look.kind)) {
    throw new GoveeSkillError('lan paint supports gradient and solid looks; scenes are a cloud concept', 'unsupported-look');
  }

  // Resolve the device: explicit --ip, or a LAN scan matched on the score's target
  // sku. The LAN has no device names — that's a cloud concept — so an ambiguous
  // room (two lamps, same SKU) must be pinned by --ip rather than guessed at.
  let ip = args.ip ?? null;
  let sku = score.target?.sku ?? null;
  if (!ip) {
    const devices = (await lan.lanScan({})).filter(device => !sku || device.sku === sku);
    if (!devices.length) throw new GoveeSkillError(`No LAN device found${sku ? ` for sku ${sku}` : ''}`, 'device-not-found');
    if (devices.length > 1) {
      throw new GoveeSkillError(
        `Multiple LAN devices match (${devices.map(d => `${d.sku}@${d.ip}`).join(', ')}); pin one with --ip`,
        'ambiguous-device'
      );
    }
    ip = devices[0].ip;
    sku = devices[0].sku ?? sku;
  }

  const profile = lan.razerProfile(sku);
  const holdSeconds = lan.clampHoldSeconds(args['hold-seconds'] ? Number(args['hold-seconds']) : undefined);

  // Compile: bands → per-LED for profiled fixtures, solid → documented colorwc.
  const warnings = [];
  let mode;
  let pixels = null;
  if (score.look.kind === 'gradient') {
    if (!profile) {
      throw new GoveeSkillError(
        `No verified per-LED profile for sku ${sku ?? '(unknown)'}; a wrong pixel count is silently ignored by the device, so Suffuse refuses to guess. Use a solid look, or the cloud path.`,
        'no-razer-profile'
      );
    }
    if (!profile.verified) {
      warnings.push(`The ${sku} pixel count (${profile.pixels}) is unverified; an interpolating fixture renders a plausible gradient at any count, so treat the layout as approximate.`);
    }
    pixels = lan.bandsToPixels(score.look.bands, profile.pixels);
    mode = 'lan-per-led';
  } else {
    mode = 'lan-solid';
  }

  const plan = {
    executionMode: mode,
    target: { sku, ip },
    requestedLook: score.look,
    pixels: pixels ? pixels.length : null,
    holdSeconds: mode === 'lan-per-led' ? holdSeconds : null,
    warnings
  };

  if (!args['confirm-write']) {
    printJson({ dryRun: true, plan });
    return;
  }
  if (!args.receipt) throw new GoveeSkillError('A private --receipt path is required for writes', 'missing-receipt');
  if (mode === 'lan-per-led' && !args['confirm-segments']) {
    throw new GoveeSkillError(
      'Per-LED writes require --confirm-segments: the razer channel is mute, so nothing can verify the result but eyes',
      'segment-write-not-confirmed'
    );
  }
  const evidence = beginEvidence(plan, 'lan');

  // Reserve the receipt before touching the device — same fail-closed contract as apply().
  await writePrivateJson(args.receipt, {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'prepared',
    transport: 'lan',
    plan,
    restoreOperations: [],
    restoreCoverage: { mode: 'capture', complete: false, warning: 'State capture has not run.' },
    evidence
  });

  // Keyless pre-write capture: devStatus answers over LAN (the razer channel does
  // not, but we are reading the documented state BEFORE painting over it). The
  // capture→restore mapping (CCT-mode trap included) lives in lanRestoreOperations.
  const captured = await lan.lanDevStatus(ip);
  const restoreOperations = captured ? lan.lanRestoreOperations(ip, captured) : [];
  appendEvidence(evidence, {
    kind: 'query',
    status: captured ? 'captured' : 'unavailable',
    source: 'govee-lan-devStatus',
    facts: {
      query: 'pre-write-whole-device-state',
      restoreOperationCount: restoreOperations.length,
      segmentStateQueryable: false
    }
  });
  const restoreCoverage = {
    mode: 'capture',
    complete: mode === 'lan-solid' && restoreOperations.length > 1,
    warning: !captured
      ? 'devStatus did not answer before the write; restoration will fall back to releasing the device to its own effects.'
      : mode === 'lan-per-led' && restoreOperations.length > 1
        ? 'devStatus reflects the whole-device state only; any prior per-LED look is not queryable and cannot be restored.'
        : restoreOperations.length > 1
          ? null
          : 'The device reported black RGB with no colour temperature; its prior colour is unknown and will not be replayed.'
  };
  recordRestoreCoverage(evidence, restoreCoverage);

  try {
    if (mode === 'lan-per-led') {
      await lan.lanPaintPixels(ip, pixels);
      if (holdSeconds > 0) {
        const { spawn } = await import('node:child_process');
        const self = fileURLToPath(import.meta.url);
        const child = spawn(process.execPath, [
          self, 'lan', 'hold-loop',
          '--ip', ip,
          '--frame', Buffer.from(JSON.stringify(pixels)).toString('base64'),
          '--ttl', String(holdSeconds)
        ], { detached: true, stdio: 'ignore' });
        child.unref();
        await lan.writeHold(ip, { pid: child.pid, expiresAt: Date.now() + holdSeconds * 1000, label: score.name });
      } else {
        warnings.push('No hold requested: the device reverts to its own effects in roughly a minute (hardware dead-man).');
      }
    } else {
      await lan.lanSetColor(ip, score.look.color, {
        brightness: score.look.brightness ?? null
      });
    }
  } catch (error) {
    recordOutcomes(evidence, [{
      action: mode === 'lan-per-led' ? 'razer-paint' : 'colorwc',
      ok: false,
      code: error.code ?? 'lan-write-failed',
      message: error.message
    }], { transport: 'lan', source: 'govee-lan' });
    await writePrivateJson(args.receipt, {
      version: 1,
      createdAt: new Date().toISOString(),
      status: 'partial-or-failed',
      transport: 'lan',
      plan,
      restoreOperations,
      restoreCoverage,
      evidence
    }, { overwrite: true });
    throw error;
  }

  recordOutcomes(evidence, [{
    action: mode === 'lan-per-led' ? 'razer-paint' : 'colorwc',
    ok: true
  }], { transport: 'lan', source: 'govee-lan' });
  recordAppearanceBoundary(evidence);

  await writePrivateJson(args.receipt, {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'applied',
    transport: 'lan',
    plan,
    restoreOperations,
    restoreCoverage,
    evidence
  }, { overwrite: true });

  printJson({
    applied: true,
    transport: 'lan',
    executionMode: mode,
    target: { sku, ip },
    holdSeconds: plan.holdSeconds,
    receipt: args.receipt,
    restoreCoverage,
    warnings,
    evidence: summarizeEvidence(evidence),
    // The channel is mute: report what was SENT, never that the device obeyed.
    verified: false
  });
}

// ── BLE commands ─────────────────────────────────────────────────────────────
// Same contract again — gates on, receipt out — over the third wire. BLE is
// keyless AND works with no Wi-Fi at all, which is why it exists here: the
// H6009 class is cloud-listed but has no LAN Control, so this is its only
// keyless path. Everything transport-specific (frames, the link contract, why
// there is no readback) lives in ble.mjs and references/ble.md.

async function bleCommand(args) {
  const ble = await import('./ble.mjs');
  const sub = args._[1];
  try {
    if (sub === 'scan') {
      const devices = await ble.bleScanSummaries({
        timeoutMs: args.timeout ? Number(args.timeout) : undefined
      });
      printJson({
        devices,
        note: 'A lamp held by another central (Govee Home app, another controller) stops advertising and will not appear.'
      });
      return;
    }
    if (sub === 'set') return await bleSetCommand(args, ble);
    throw new GoveeSkillError(`Unknown ble subcommand: ${sub ?? '(none)'}`, 'invalid-command');
  } finally {
    // The native central keeps the event loop alive; a CLI must put it down.
    ble.bleStop();
  }
}

async function bleSetCommand(args, ble) {
  const power = args.power === undefined ? null
    : args.power === 'on' ? true
    : args.power === 'off' ? false
    : (() => { throw new GoveeSkillError('ble set --power must be on or off', 'invalid-arguments'); })();
  const color = args.color ?? null;
  const brightness = args.brightness === undefined ? null : Number(args.brightness);
  if (brightness !== null && !(Number.isFinite(brightness) && brightness >= 1 && brightness <= 100)) {
    throw new GoveeSkillError('ble set --brightness must be 1-100', 'invalid-arguments');
  }
  if (power === null && color === null && brightness === null) {
    throw new GoveeSkillError('ble set requires at least one of --power, --color, --brightness', 'invalid-arguments');
  }

  const plan = {
    executionMode: 'ble-one-shot',
    target: { id: args.id ?? null, name: args.name ?? null },
    channels: { power, color, brightness },
    // Honest up front: nothing on this channel can confirm delivery, and prior
    // state cannot be captured. Restoration returns to a declared warm white.
    restorePoint: { declared: true, ...ble.BLE_RESTORE_POINT }
  };

  if (!args['confirm-write']) {
    printJson({ dryRun: true, plan });
    return;
  }
  if (!args.receipt) throw new GoveeSkillError('A private --receipt path is required for writes', 'missing-receipt');

  const peripheral = await ble.bleResolve({
    id: args.id ?? null,
    name: args.name ?? null,
    timeoutMs: args.timeout ? Number(args.timeout) : undefined
  });
  const summary = ble.peripheralSummary(peripheral);
  plan.target = summary;

  const restoreOperations = [{
    transport: 'ble',
    action: 'set',
    id: summary.id,
    name: summary.name,
    power: true,
    color: ble.BLE_RESTORE_POINT.color,
    brightness: ble.BLE_RESTORE_POINT.brightness
  }];
  const restoreCoverage = {
    mode: 'declared',
    complete: false,
    warning: 'BLE has no state readback: prior colour and brightness were not captured. '
      + 'Restore returns the lamp to a declared warm white, not to its previous look.'
  };
  const evidence = beginEvidence(plan, 'ble');
  appendEvidence(evidence, {
    kind: 'query',
    status: 'unavailable',
    source: 'govee-ble',
    facts: { reason: 'protocol-has-no-state-readback' }
  });
  recordRestoreCoverage(evidence, restoreCoverage);

  // Reserve the receipt before touching the device — same fail-closed contract
  // as every other write path.
  await writePrivateJson(args.receipt, {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'prepared',
    transport: 'ble',
    plan,
    restoreOperations,
    restoreCoverage,
    evidence
  });

  let outcome;
  try {
    outcome = await ble.bleSet(peripheral, { power, color, brightness });
  } catch (error) {
    recordOutcomes(evidence, [{
      action: 'ble-one-shot',
      ok: false,
      code: error.code ?? 'ble-write-failed',
      message: error.message
    }], { transport: 'ble', source: 'govee-ble' });
    await writePrivateJson(args.receipt, {
      version: 1,
      createdAt: new Date().toISOString(),
      status: 'partial-or-failed',
      transport: 'ble',
      plan,
      restoreOperations,
      restoreCoverage,
      evidence
    }, { overwrite: true });
    throw error;
  }
  recordOutcomes(evidence, outcome.sent, { transport: 'ble', source: 'ble-write-without-response' });
  recordAppearanceBoundary(evidence);

  await writePrivateJson(args.receipt, {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'applied',
    transport: 'ble',
    plan,
    sent: outcome.sent,
    restoreOperations,
    restoreCoverage,
    evidence
  }, { overwrite: true });

  printJson({
    applied: true,
    transport: 'ble',
    executionMode: 'ble-one-shot',
    target: { sku: summary.sku, name: summary.name },
    channels: plan.channels,
    receipt: args.receipt,
    restoreCoverage,
    evidence: summarizeEvidence(evidence),
    // Write-without-response resolves when the OS accepts the buffer. Report
    // what was SENT, never that the lamp obeyed.
    verified: false
  });
}

async function restoreBle(receipt, ble) {
  const operation = (receipt.restoreOperations ?? []).find(entry => entry.action === 'set');
  if (!operation) {
    throw new GoveeSkillError('Receipt contains no BLE restore operation', 'restore-unavailable');
  }
  try {
    const peripheral = await ble.bleResolve({ id: operation.id, name: operation.name });
    const outcome = await ble.bleSet(peripheral, {
      power: operation.power ?? true,
      color: operation.color,
      brightness: operation.brightness
    });
    return {
      restored: true,
      transport: 'ble',
      target: { name: operation.name },
      sent: outcome.sent,
      warning: receipt?.restoreCoverage?.warning ?? null
    };
  } finally {
    ble.bleStop();
  }
}

async function restoreLan(receipt, lan) {
  const operations = receipt.restoreOperations ?? [];
  if (!operations.length) {
    throw new GoveeSkillError('Receipt contains no queryable state to restore', 'restore-unavailable');
  }
  const outcomes = [];
  for (const operation of operations) {
    if (operation.action === 'razer-disable') {
      await lan.releaseHold(operation.ip);
      outcomes.push({ action: 'razer-disable', ip: operation.ip, sent: true });
    } else if (operation.action === 'colorwc') {
      await lan.lanSetColor(operation.ip, operation.color ?? null, {
        brightness: operation.brightness,
        colorTemInKelvin: operation.colorTemInKelvin ?? 0
      });
      outcomes.push({ action: 'colorwc', ip: operation.ip, sent: true });
    } else {
      throw new GoveeSkillError(`Unknown LAN restore action: ${operation.action}`, 'invalid-receipt');
    }
  }
  return {
    restored: true,
    transport: 'lan',
    operationCount: outcomes.length,
    outcomes,
    warning: receipt?.restoreCoverage?.warning ?? null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || ['help', '-h'].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === 'inspect') return inspect(args);
  if (command === 'household') return household(args);
  if (command === 'doctor') return doctor(args);
  if (command === 'scenes') return scenes(args);
  if (command === 'palettes') return palettes(args);
  if (command === 'compile') return compile(args);
  if (command === 'evidence') return inspectEvidence(args);
  if (command === 'apply') return apply(args);
  if (command === 'restore') return restore(args);
  if (command === 'lan') return lanCommand(args);
  if (command === 'ble') return bleCommand(args);
  throw new GoveeSkillError(`Unknown command: ${command}`, 'invalid-command');
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => {
    const code = error instanceof GoveeSkillError ? error.code : 'unexpected-error';
    process.stderr.write(`suffuse [${code}]: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  apiRequest,
  discoverDevices,
  enrichDeviceForScore,
  executeOperations,
  loadJson,
  probeHousehold,
  querySceneCatalog,
  queryState,
  writePrivateJson
};
