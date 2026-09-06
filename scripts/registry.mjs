// Read-only household registry. This module merges transport observations; it
// does not choose a writer or authorize control. Every fact retains its source
// and observation time so a cached snapshot cannot become timeless truth.

const text = value => String(value ?? '').trim();

export function normalizeDeviceIdentity(value) {
  const normalized = text(value).toUpperCase().replace(/[^0-9A-F]/g, '');
  return normalized.length >= 12 ? normalized : '';
}

function capabilityInstances(device) {
  return [...new Set((device?.capabilities ?? [])
    .map(capability => text(capability?.instance))
    .filter(Boolean))]
    .sort();
}

function cloudObservation(device, observedAt) {
  return {
    source: 'govee-cloud-inventory',
    transport: 'cloud',
    observedAt,
    reachability: 'unknown',
    evidence: 'account-listed',
    deviceId: text(device?.device),
    address: null
  };
}

function lanObservation(device, observedAt) {
  return {
    source: 'govee-lan-scan',
    transport: 'lan',
    observedAt,
    reachability: 'observed',
    evidence: 'scan-response',
    deviceId: text(device?.device),
    address: text(device?.ip) || null
  };
}

function makeEntry({ device, observation, origin }) {
  return {
    identityKey: normalizeDeviceIdentity(device?.device),
    identityConfidence: 'single-source',
    name: origin === 'cloud' ? text(device?.deviceName) : '',
    sku: text(device?.sku).toUpperCase(),
    type: origin === 'cloud' ? text(device?.type) : 'devices.types.light',
    capabilityInstances: origin === 'cloud' ? capabilityInstances(device) : [],
    transports: [observation.transport],
    observations: [observation],
    conflicts: []
  };
}

function mergeCloudLan(cloud, lan) {
  const conflicts = [];
  if (cloud.sku && lan.sku && cloud.sku !== lan.sku) {
    conflicts.push({ field: 'sku', sources: { cloud: cloud.sku, lan: lan.sku } });
  }
  return {
    identityKey: cloud.identityKey,
    identityConfidence: 'exact-device-id',
    name: cloud.name,
    sku: cloud.sku || lan.sku,
    type: cloud.type || lan.type,
    capabilityInstances: cloud.capabilityInstances,
    transports: ['cloud', 'lan'],
    observations: [...cloud.observations, ...lan.observations],
    conflicts
  };
}

/**
 * Merge one live cloud inventory and one live LAN scan. Exact normalized Govee
 * device ids are the only automatic join key. Missing ids and suffix matches
 * remain separate because a false merge can route a later write to the wrong
 * physical fixture.
 */
export function buildHouseholdRegistry({
  cloudDevices = [],
  lanDevices = [],
  observedAt = new Date().toISOString(),
  sources = {}
} = {}) {
  const cloud = cloudDevices.map(device => makeEntry({
    device,
    observation: cloudObservation(device, observedAt),
    origin: 'cloud'
  }));
  const lan = lanDevices.map(device => makeEntry({
    device,
    observation: lanObservation(device, observedAt),
    origin: 'lan'
  }));

  const lanByIdentity = new Map();
  for (const entry of lan) {
    if (!entry.identityKey) continue;
    const matches = lanByIdentity.get(entry.identityKey) ?? [];
    matches.push(entry);
    lanByIdentity.set(entry.identityKey, matches);
  }

  const consumedLan = new Set();
  const cloudIdentityCounts = new Map();
  for (const entry of cloud) {
    if (entry.identityKey) {
      cloudIdentityCounts.set(entry.identityKey, (cloudIdentityCounts.get(entry.identityKey) ?? 0) + 1);
    }
  }
  const devices = cloud.map(cloudEntry => {
    if (!cloudEntry.identityKey) return cloudEntry;
    if (cloudIdentityCounts.get(cloudEntry.identityKey) !== 1) return cloudEntry;
    const matches = lanByIdentity.get(cloudEntry.identityKey) ?? [];
    if (matches.length !== 1) return cloudEntry;
    const [lanEntry] = matches;
    consumedLan.add(lanEntry);
    return mergeCloudLan(cloudEntry, lanEntry);
  });
  devices.push(...lan.filter(entry => !consumedLan.has(entry)));

  devices.sort((a, b) => (
    a.name.localeCompare(b.name)
    || a.sku.localeCompare(b.sku)
    || a.identityKey.localeCompare(b.identityKey)
  ));

  return {
    version: 1,
    generatedAt: observedAt,
    readOnly: true,
    sources,
    devices
  };
}

export function summarizeHouseholdRegistry(registry, { showIdentifiers = false } = {}) {
  let mergedDeviceCount = 0;
  const devices = registry.devices.map((device, index) => {
    if (device.transports.length > 1) mergedDeviceCount += 1;
    return {
      ref: `device-${index + 1}`,
      name: showIdentifiers ? device.name || null : device.name ? '[redacted]' : null,
      sku: device.sku || null,
      type: device.type || null,
      transports: device.transports,
      identityConfidence: device.identityConfidence,
      capabilityInstances: device.capabilityInstances,
      observations: device.observations.map(observation => ({
        source: observation.source,
        transport: observation.transport,
        observedAt: observation.observedAt,
        reachability: observation.reachability,
        evidence: observation.evidence,
        ...(showIdentifiers ? {
          deviceId: observation.deviceId || null,
          address: observation.address || null
        } : {})
      })),
      conflicts: device.conflicts
    };
  });
  return {
    version: registry.version,
    generatedAt: registry.generatedAt,
    readOnly: true,
    snapshotRefsAreEphemeral: true,
    sourceStatus: registry.sources,
    deviceCount: devices.length,
    mergedDeviceCount,
    devices
  };
}

export function buildDoctorReport(registrySummary) {
  const cloud = registrySummary.sourceStatus?.cloud ?? { status: 'not-run' };
  const lan = registrySummary.sourceStatus?.lan ?? { status: 'not-run' };
  const availableSources = [cloud, lan].filter(source => source.status === 'ok').length;
  const status = availableSources === 2 ? 'ok' : availableSources === 1 ? 'partial' : 'unavailable';
  const recommendations = [];
  if (cloud.status === 'not-configured') {
    recommendations.push('Set GOVEE_API_KEY in the process environment for cloud inventory; do not pass it as a tool argument.');
  } else if (cloud.status === 'error') {
    recommendations.push('Resolve the reported cloud error, then rerun doctor. LAN observations remain independently useful.');
  }
  if (lan.status === 'error') {
    recommendations.push('Check UDP port ownership, LAN Control, and local network reachability, then rerun doctor.');
  } else if (lan.status === 'ok' && Number(lan.deviceCount) === 0) {
    recommendations.push('No LAN scan responses were observed; this is not proof that installed devices lack LAN support.');
  }
  return {
    readOnly: true,
    checkedAt: registrySummary.generatedAt,
    status,
    checks: {
      cloud,
      lan,
      registry: {
        status: registrySummary.deviceCount > 0 ? 'ok' : status === 'unavailable' ? 'unavailable' : 'empty',
        deviceCount: registrySummary.deviceCount,
        mergedDeviceCount: registrySummary.mergedDeviceCount
      }
    },
    recommendations
  };
}
