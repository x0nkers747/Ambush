// Geographic service endpoints (docs/adr/0014). The defaults are the free
// public services; each can be replaced (e.g. by a self-hosted or paid
// Overpass instance before a commercial release) without code changes, by
// storing a JSON object with any of these fields under
// `localStorage["ambush.services"]`.

export interface ServiceConfig {
  /** Overpass API interpreter URLs, tried in order. */
  readonly overpassEndpoints: readonly string[];
  /** Nominatim base URL (search is `${base}/search`). */
  readonly nominatimEndpoint: string;
  /** Terrarium tile URL with `{z}`, `{x}` and `{y}`. */
  readonly terrainTileUrl: string;
  /** Optional contact address Nominatim asks heavy users to send; empty by default. */
  readonly contactEmail: string;
  /** Tiles fetched at once. */
  readonly tileConcurrency: number;
}

export const DEFAULT_SERVICES: ServiceConfig = {
  overpassEndpoints: ['https://overpass-api.de/api/interpreter'],
  nominatimEndpoint: 'https://nominatim.openstreetmap.org',
  terrainTileUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  contactEmail: '',
  tileConcurrency: 4,
};

export const SERVICE_CONFIG_KEY = 'ambush.services';

/**
 * The service configuration: the defaults, overridden field by field by
 * valid values stored under `SERVICE_CONFIG_KEY`. Invalid overrides are
 * ignored and listed in `problems`.
 */
export function loadServiceConfig(storage: Pick<Storage, 'getItem'> | null): {
  config: ServiceConfig;
  problems: string[];
} {
  const problems: string[] = [];
  let raw: unknown = null;
  try {
    const text = storage?.getItem(SERVICE_CONFIG_KEY) ?? null;
    raw = text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    problems.push(`${SERVICE_CONFIG_KEY} is not valid JSON`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { config: DEFAULT_SERVICES, problems };
  const o = raw as Record<string, unknown>;
  const url = (v: unknown) => typeof v === 'string' && /^https?:\/\//.test(v);
  const config = { ...DEFAULT_SERVICES } as {
    -readonly [K in keyof ServiceConfig]: ServiceConfig[K];
  };
  if (o['overpassEndpoints'] !== undefined) {
    if (
      Array.isArray(o['overpassEndpoints']) &&
      o['overpassEndpoints'].length > 0 &&
      o['overpassEndpoints'].every(url)
    ) {
      config.overpassEndpoints = o['overpassEndpoints'] as string[];
    } else problems.push('overpassEndpoints must be a list of http(s) URLs');
  }
  if (o['nominatimEndpoint'] !== undefined) {
    if (url(o['nominatimEndpoint'])) config.nominatimEndpoint = o['nominatimEndpoint'] as string;
    else problems.push('nominatimEndpoint must be an http(s) URL');
  }
  if (o['terrainTileUrl'] !== undefined) {
    const t = o['terrainTileUrl'];
    if (url(t) && typeof t === 'string' && ['{z}', '{x}', '{y}'].every((p) => t.includes(p)))
      config.terrainTileUrl = t;
    else problems.push('terrainTileUrl must be an http(s) URL containing {z}, {x} and {y}');
  }
  if (o['contactEmail'] !== undefined) {
    if (typeof o['contactEmail'] === 'string') config.contactEmail = o['contactEmail'];
    else problems.push('contactEmail must be a string');
  }
  if (o['tileConcurrency'] !== undefined) {
    const n = o['tileConcurrency'];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 8)
      config.tileConcurrency = n;
    else problems.push('tileConcurrency must be an integer from 1 to 8');
  }
  return { config, problems };
}
