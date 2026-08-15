#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
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
  govee.mjs lan scan [--subnet 192.168.1] [--timeout MS]
  govee.mjs lan paint --score FILE [--ip ADDR] [--hold-seconds N]
                      [--confirm-write --receipt FILE --confirm-segments]
  govee.mjs lan release --ip ADDR --confirm-write
  govee.mjs lan holds

GOVEE_API_KEY is required for live cloud commands; lan commands are keyless.
Writes require --confirm-write on every path, cloud or LAN.`;
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
  // LAN receipts restore over LAN — releasing any hold first, then replaying the
  // captured whole-device state via the documented colorwc channel.
  if (receipt.transport === 'lan') return restoreLan(receipt, await import('./lan.mjs'));
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

  // Reserve the receipt before touching the device — same fail-closed contract as apply().
  await writePrivateJson(args.receipt, {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'prepared',
    transport: 'lan',
    plan,
    restoreOperations: [],
    restoreCoverage: { mode: 'capture', complete: false, warning: 'State capture has not run.' }
  });

  // Keyless pre-write capture: devStatus answers over LAN (the razer channel does
  // not, but we are reading the documented state BEFORE painting over it).
  const captured = await lan.lanDevStatus(ip);
  const restoreOperations = [];
  if (captured) {
    restoreOperations.push({ transport: 'lan', action: 'razer-disable', ip });
    if (captured.color) {
      restoreOperations.push({
        transport: 'lan',
        action: 'colorwc',
        ip,
        color: `#${[captured.color.r, captured.color.g, captured.color.b].map(v => Number(v ?? 0).toString(16).padStart(2, '0')).join('')}`,
        brightness: Number.isFinite(captured.brightness) ? captured.brightness : null
      });
    }
  }
  const restoreCoverage = {
    mode: 'capture',
    complete: restoreOperations.length > 1,
    warning: captured
      ? 'devStatus reflects the whole-device state only; any prior per-LED look is not queryable and cannot be restored.'
      : 'devStatus did not answer before the write; restoration will fall back to releasing the device to its own effects.'
  };

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

  await writePrivateJson(args.receipt, {
    version: 1,
    createdAt: new Date().toISOString(),
    status: 'applied',
    transport: 'lan',
    plan,
    restoreOperations,
    restoreCoverage
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
    // The channel is mute: report what was SENT, never that the device obeyed.
    verified: false
  });
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
      await lan.lanSetColor(operation.ip, operation.color, { brightness: operation.brightness });
      outcomes.push({ action: 'colorwc', ip: operation.ip, sent: true });
    } else {
      throw new GoveeSkillError(`Unknown LAN restore action: ${operation.action}`, 'invalid-receipt');
    }
  }
  printJson({ restored: true, transport: 'lan', operationCount: outcomes.length, outcomes, warning: receipt?.restoreCoverage?.warning ?? null });
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
  if (command === 'lan') return lanCommand(args);
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
