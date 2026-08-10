#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
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
  govee.mjs scenes --sku SKU [--name NAME] [--instance lightScene|diyScene]
  govee.mjs palettes [--name NAME] [--catalog FILE]
  govee.mjs compile --score FILE --capabilities FILE [--catalog FILE] [--output FILE]
  govee.mjs apply --score FILE [--catalog FILE] [--confirm-write --receipt FILE]
                   [--confirm-segments]
  govee.mjs restore --receipt FILE --confirm-write

GOVEE_API_KEY is required for live commands. Writes require --confirm-write.`;
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
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: overwrite ? 'w' : 'wx'
  });
  await chmod(path, 0o600);
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

  // Reserve the receipt before touching a physical device. This fails closed if the path
  // already exists and leaves a useful prepared record if the process exits unexpectedly.
  await writePrivateJson(args.receipt, {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'prepared',
    plan,
    outcomes: [],
    restoreOperations: [],
    restoreCoverage: { mode: plan.restoreMode, complete: false, capturedInstances: [], warning: 'State capture has not run.' }
  });

  let stateDocument = null;
  let stateWarning = null;
  if (plan.restoreMode === 'capture') {
    try {
      stateDocument = await queryState(device);
    } catch (error) {
      stateWarning = `Pre-write state capture failed: ${error.message}`;
    }
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

  let outcomes;
  try {
    outcomes = await executeOperations(plan.operations);
  } catch (error) {
    outcomes = error.outcomes ?? [];
    const receipt = {
      version: 1,
      createdAt: new Date().toISOString(),
      status: 'partial-or-failed',
      plan,
      outcomes,
      restoreOperations,
      restoreCoverage
    };
    await writePrivateJson(args.receipt, receipt, { overwrite: true });
    throw new GoveeSkillError(`Write stopped; receipt saved to ${args.receipt}: ${error.message}`, error.code);
  }

  const receipt = {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'applied',
    plan,
    outcomes,
    restoreOperations,
    restoreCoverage
  };
  await writePrivateJson(args.receipt, receipt, { overwrite: true });
  printJson({
    applied: true,
    target: { sku: plan.target.sku, device: redactIdentifier(plan.target.device) },
    executionMode: plan.executionMode,
    operationCount: outcomes.length,
    receipt: args.receipt,
    restoreCoverage
  });
}

async function restore(args) {
  if (!args['confirm-write']) throw new GoveeSkillError('restore requires --confirm-write', 'write-not-confirmed');
  const receipt = await loadJson(args.receipt, 'receipt');
  if (receipt?.version !== 1 || !Array.isArray(receipt?.restoreOperations)) {
    throw new GoveeSkillError('Receipt has no valid restore operation list', 'invalid-receipt');
  }
  if (!receipt.restoreOperations.length) {
    throw new GoveeSkillError('Receipt contains no queryable state to restore', 'restore-unavailable');
  }
  receipt.restoreOperations.forEach(validateControlOperation);
  const outcomes = await executeOperations(receipt.restoreOperations);
  printJson({
    restored: true,
    target: {
      sku: receipt?.plan?.target?.sku,
      device: redactIdentifier(receipt?.plan?.target?.device)
    },
    operationCount: outcomes.length,
    outcomes,
    warning: receipt?.restoreCoverage?.warning ?? null
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || ['help', '-h'].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === 'inspect') return inspect(args);
  if (command === 'scenes') return scenes(args);
  if (command === 'palettes') return palettes(args);
  if (command === 'compile') return compile(args);
  if (command === 'apply') return apply(args);
  if (command === 'restore') return restore(args);
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
  querySceneCatalog,
  queryState,
  writePrivateJson
};
