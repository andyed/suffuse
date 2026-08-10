const TYPES = Object.freeze({
  power: 'devices.capabilities.on_off',
  range: 'devices.capabilities.range',
  color: 'devices.capabilities.color_setting',
  segment: 'devices.capabilities.segment_color_setting',
  scene: 'devices.capabilities.dynamic_scene'
});

const MAX_SEGMENTS = 256;
const ALLOWED_SCENE_INSTANCES = new Set(['lightScene', 'diyScene', 'snapshot']);

export class GoveeSkillError extends Error {
  constructor(message, code = 'invalid-request') {
    super(message);
    this.name = 'GoveeSkillError';
    this.code = code;
  }
}

const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();
const lower = value => text(value).toLowerCase();

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function uniqueSortedIntegers(values) {
  return [...new Set(values.map(integer).filter(value => value !== null))]
    .sort((a, b) => a - b);
}

export function devicesFromDocument(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document?.data)) return document.data;
  if (Array.isArray(document?.payload?.devices)) return document.payload.devices;
  throw new GoveeSkillError('Capability document does not contain a device array', 'invalid-capabilities');
}

export function capability(device, type, instance) {
  const list = Array.isArray(device?.capabilities) ? device.capabilities : [];
  return list.find(item => item?.type === type && item?.instance === instance) || null;
}

export function segmentIndices(segmentCapability) {
  const fields = segmentCapability?.parameters?.fields;
  const field = Array.isArray(fields)
    ? fields.find(item => item?.fieldName === 'segment')
    : null;
  if (!field) return { indices: [], source: 'missing' };

  if (Array.isArray(field.options)) {
    const indices = uniqueSortedIntegers(field.options.map(option => (
      option && typeof option === 'object' ? option.value : option
    )));
    return { indices, source: indices.length ? 'options' : 'missing' };
  }

  const range = field.elementRange || field.range;
  const min = integer(range?.min);
  const max = integer(range?.max);
  if (min === null || max === null || min < 0 || max < min || max - min + 1 > MAX_SEGMENTS) {
    return { indices: [], source: 'missing' };
  }

  return {
    indices: Array.from({ length: max - min + 1 }, (_, offset) => min + offset),
    source: 'elementRange'
  };
}

export function summarizeDevice(device, { showIdentifiers = false } = {}) {
  const segmentColor = capability(device, TYPES.segment, 'segmentedColorRgb');
  const segmentDomain = segmentIndices(segmentColor);
  const result = {
    sku: upper(device?.sku),
    type: text(device?.type),
    segmentedColor: {
      advertised: !!segmentColor,
      count: segmentDomain.indices.length || null,
      indices: segmentDomain.indices,
      indexSource: segmentDomain.source
    },
    capabilityInstances: (Array.isArray(device?.capabilities) ? device.capabilities : [])
      .map(item => ({ type: text(item?.type), instance: text(item?.instance) }))
      .filter(item => item.type && item.instance)
  };
  if (showIdentifiers) {
    result.device = text(device?.device);
    result.deviceName = text(device?.deviceName);
  }
  return result;
}

export function summarizeDevices(devices, filters = {}) {
  const sku = upper(filters.sku);
  const name = lower(filters.name);
  return devices
    .filter(device => !sku || upper(device?.sku) === sku)
    .filter(device => !name || lower(device?.deviceName) === name)
    .map(device => summarizeDevice(device, { showIdentifiers: !!filters.showIdentifiers }));
}

export function selectDevice(devices, target = {}) {
  const sku = upper(target.sku);
  const name = lower(target.name);
  if (!sku && !name) {
    throw new GoveeSkillError('LightScore target must include sku and/or exact name', 'missing-target');
  }
  const matches = devices
    .filter(device => !sku || upper(device?.sku) === sku)
    .filter(device => !name || lower(device?.deviceName) === name);
  if (!matches.length) throw new GoveeSkillError('No installed device exactly matches the LightScore target', 'device-not-found');
  if (matches.length > 1) throw new GoveeSkillError('More than one device matches; add an exact device name', 'ambiguous-device');
  return matches[0];
}

export function rgbInteger(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(text(color));
  if (!match) throw new GoveeSkillError(`Invalid RGB color: ${text(color) || '(empty)'}`, 'invalid-color');
  return Number.parseInt(match[1], 16);
}

function validateBrightness(value) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new GoveeSkillError('look.brightness must be an integer from 0 through 100', 'invalid-score');
  }
}

export function validateLightScore(score) {
  if (!score || typeof score !== 'object' || Array.isArray(score)) {
    throw new GoveeSkillError('LightScore must be a JSON object', 'invalid-score');
  }
  if (score.version !== 1) throw new GoveeSkillError('LightScore version must be 1', 'invalid-score');
  if (!text(score.name)) throw new GoveeSkillError('LightScore name is required', 'invalid-score');
  if (!text(score?.target?.sku) && !text(score?.target?.name)) {
    throw new GoveeSkillError('LightScore target must include sku and/or name', 'invalid-score');
  }
  if (!['on', 'off', 'unchanged'].includes(score.power ?? 'unchanged')) {
    throw new GoveeSkillError('power must be on, off, or unchanged', 'invalid-score');
  }
  const kind = score?.look?.kind;
  if (!['gradient', 'solid', 'scene'].includes(kind)) {
    throw new GoveeSkillError('look.kind must be gradient, solid, or scene', 'invalid-score');
  }
  validateBrightness(score.look.brightness);
  if (kind === 'gradient') {
    if (!Array.isArray(score.look.bands) || score.look.bands.length < 3 || score.look.bands.length > 5) {
      throw new GoveeSkillError('A gradient must contain 3 through 5 bands', 'invalid-score');
    }
    for (const band of score.look.bands) {
      rgbInteger(band?.color);
      if (band?.weight !== undefined && (!Number.isFinite(band.weight) || band.weight <= 0)) {
        throw new GoveeSkillError('Band weight must be a positive number', 'invalid-score');
      }
    }
  }
  if (kind === 'solid') rgbInteger(score.look.color);
  if (kind === 'scene' && !text(score.look.scene)) {
    throw new GoveeSkillError('A scene look requires look.scene', 'invalid-score');
  }
  if (score.look.sceneInstance && !ALLOWED_SCENE_INSTANCES.has(score.look.sceneInstance)) {
    throw new GoveeSkillError('sceneInstance must be lightScene, diyScene, or snapshot', 'invalid-score');
  }
  const fallback = score.fallback ?? [];
  if (!Array.isArray(fallback) || fallback.some(item => !['scene', 'solid'].includes(item))) {
    throw new GoveeSkillError('fallback must contain only scene and/or solid', 'invalid-score');
  }
  const restoreMode = score?.restore?.mode ?? 'capture';
  if (!['capture', 'none'].includes(restoreMode)) {
    throw new GoveeSkillError('restore.mode must be capture or none', 'invalid-score');
  }
  return score;
}

function partitionSegments(indices, bands) {
  if (indices.length < bands.length) {
    throw new GoveeSkillError('The device exposes fewer segments than the authored bands', 'insufficient-segments');
  }
  const weights = bands.map(band => band.weight ?? 1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const remaining = indices.length - bands.length;
  const exactExtras = weights.map(value => remaining * value / totalWeight);
  const counts = exactExtras.map(value => 1 + Math.floor(value));
  let undistributed = indices.length - counts.reduce((sum, value) => sum + value, 0);
  const order = exactExtras
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < undistributed; index += 1) counts[order[index].index] += 1;

  let cursor = 0;
  return counts.map(count => {
    const slice = indices.slice(cursor, cursor + count);
    cursor += count;
    return slice;
  });
}

function controlOperation(device, type, instance, value, label) {
  return {
    label,
    payload: {
      sku: text(device.sku),
      device: text(device.device),
      capability: { type, instance, value }
    }
  };
}

function sceneOperation(device, name, preferredInstance) {
  const candidates = (Array.isArray(device?.capabilities) ? device.capabilities : [])
    .filter(item => item?.type === TYPES.scene)
    .filter(item => ALLOWED_SCENE_INSTANCES.has(item?.instance))
    .filter(item => !preferredInstance || item.instance === preferredInstance);
  for (const candidate of candidates) {
    const options = candidate?.parameters?.options;
    const match = Array.isArray(options)
      ? options.find(option => lower(option?.name) === lower(name))
      : null;
    if (match) return controlOperation(device, TYPES.scene, candidate.instance, match.value, `scene:${match.name}`);
  }
  return null;
}

function representativeGradientColor(bands) {
  return bands[Math.floor((bands.length - 1) / 2)].color;
}

function prependCommonOperations(score, device, operations) {
  const brightness = capability(device, TYPES.range, 'brightness');
  if (score.look.brightness !== undefined) {
    if (!brightness) throw new GoveeSkillError('Device does not advertise brightness control', 'unsupported-brightness');
    operations.unshift(controlOperation(device, TYPES.range, 'brightness', score.look.brightness, 'brightness'));
  }
  if ((score.power ?? 'unchanged') !== 'unchanged') {
    const power = capability(device, TYPES.power, 'powerSwitch');
    if (!power) throw new GoveeSkillError('Device does not advertise power control', 'unsupported-power');
    const value = score.power === 'on' ? 1 : 0;
    operations.unshift(controlOperation(device, TYPES.power, 'powerSwitch', value, `power:${score.power}`));
  }
}

export function compileLightScore(scoreInput, device) {
  const score = validateLightScore(scoreInput);
  if (!text(device?.sku) || !text(device?.device)) {
    throw new GoveeSkillError('Selected device lacks sku or device identifier', 'invalid-device');
  }

  const operations = [];
  const warnings = [];
  let executionMode = score.look.kind;

  if (score.look.kind === 'gradient') {
    const segmentColor = capability(device, TYPES.segment, 'segmentedColorRgb');
    const domain = segmentIndices(segmentColor);
    if (segmentColor && domain.indices.length) {
      const partitions = partitionSegments(domain.indices, score.look.bands);
      score.look.bands.forEach((band, index) => {
        operations.push(controlOperation(
          device,
          TYPES.segment,
          'segmentedColorRgb',
          { segment: partitions[index], rgb: rgbInteger(band.color) },
          `gradient-band:${index + 1}`
        ));
      });
    } else {
      const reason = segmentColor
        ? 'segmentedColorRgb was advertised without a safe segment domain'
        : 'segmentedColorRgb was not advertised';
      let fallbackOperation = null;
      for (const fallback of score.fallback ?? []) {
        if (fallback === 'scene' && text(score.look.fallbackScene)) {
          fallbackOperation = sceneOperation(device, score.look.fallbackScene);
          if (fallbackOperation) {
            executionMode = 'scene-fallback';
            break;
          }
        }
        if (fallback === 'solid' && capability(device, TYPES.color, 'colorRgb')) {
          fallbackOperation = controlOperation(
            device,
            TYPES.color,
            'colorRgb',
            rgbInteger(representativeGradientColor(score.look.bands)),
            'solid-fallback'
          );
          executionMode = 'solid-fallback';
          break;
        }
      }
      if (!fallbackOperation) throw new GoveeSkillError(`${reason}; no declared fallback compiled`, 'unsupported-gradient');
      warnings.push(reason);
      operations.push(fallbackOperation);
    }
  } else if (score.look.kind === 'solid') {
    if (!capability(device, TYPES.color, 'colorRgb')) {
      throw new GoveeSkillError('Device does not advertise colorRgb', 'unsupported-solid');
    }
    operations.push(controlOperation(device, TYPES.color, 'colorRgb', rgbInteger(score.look.color), 'solid-color'));
  } else {
    const operation = sceneOperation(device, score.look.scene, score.look.sceneInstance);
    if (!operation) throw new GoveeSkillError('Requested scene is not advertised by the selected device', 'unsupported-scene');
    operations.push(operation);
  }

  prependCommonOperations(score, device, operations);
  return {
    version: 1,
    scoreName: score.name,
    requestedMode: score.look.kind,
    executionMode,
    target: {
      sku: text(device.sku),
      device: text(device.device),
      deviceName: text(device.deviceName)
    },
    operations,
    restoreMode: score?.restore?.mode ?? 'capture',
    warnings
  };
}

export function redactIdentifier(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.length <= 4) return '***';
  return `${raw.slice(0, 2)}…${raw.slice(-2)}`;
}

export function redactPlan(plan) {
  return {
    ...plan,
    target: {
      sku: plan?.target?.sku,
      device: redactIdentifier(plan?.target?.device),
      deviceName: plan?.target?.deviceName ? '[redacted]' : ''
    },
    operations: (plan?.operations ?? []).map(operation => ({
      ...operation,
      payload: { ...operation.payload, device: redactIdentifier(operation?.payload?.device) }
    }))
  };
}

const RESTORABLE = new Set([
  `${TYPES.power}:powerSwitch`,
  `${TYPES.range}:brightness`,
  `${TYPES.color}:colorRgb`,
  `${TYPES.color}:colorTemperatureK`
]);

export function restoreOperationsFromState(device, stateDocument) {
  const states = Array.isArray(stateDocument?.payload?.capabilities)
    ? stateDocument.payload.capabilities
    : Array.isArray(stateDocument?.data?.capabilities)
      ? stateDocument.data.capabilities
      : [];
  const operations = [];
  for (const item of states) {
    const type = text(item?.type);
    const instance = text(item?.instance);
    const value = item?.state?.value;
    if (!RESTORABLE.has(`${type}:${instance}`) || value === undefined || value === null) continue;
    operations.push(controlOperation(device, type, instance, value, `restore:${instance}`));
  }
  const order = { colorRgb: 1, colorTemperatureK: 1, brightness: 2, powerSwitch: 3 };
  operations.sort((a, b) => (order[a.payload.capability.instance] ?? 0) - (order[b.payload.capability.instance] ?? 0));
  return operations;
}

export function validateControlOperation(operation) {
  const type = text(operation?.payload?.capability?.type);
  const instance = text(operation?.payload?.capability?.instance);
  const allowed = new Set([
    `${TYPES.power}:powerSwitch`,
    `${TYPES.range}:brightness`,
    `${TYPES.color}:colorRgb`,
    `${TYPES.color}:colorTemperatureK`,
    `${TYPES.segment}:segmentedColorRgb`,
    `${TYPES.segment}:segmentedBrightness`,
    ...[...ALLOWED_SCENE_INSTANCES].map(value => `${TYPES.scene}:${value}`)
  ]);
  if (!allowed.has(`${type}:${instance}`)) {
    throw new GoveeSkillError(`Receipt contains unsupported operation ${type}/${instance}`, 'unsafe-receipt');
  }
  if (!text(operation?.payload?.sku) || !text(operation?.payload?.device)) {
    throw new GoveeSkillError('Control operation lacks a target identifier', 'unsafe-receipt');
  }
  return operation;
}

export { TYPES };
