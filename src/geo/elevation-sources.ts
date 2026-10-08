// What the AWS Terrain Tiles are made from (docs/adr/0014). Each tile names its
// source rasters in the `x-amz-meta-x-imagery-sources` response header, e.g.
// "srtm/N38W078.tif" or "uk_lidar/LIDAR-DTM-2M-TQ37.tif". The directory names
// the dataset; this table gives each dataset's approximate native resolution,
// whether it is bare earth (a terrain model) or includes canopy and buildings
// (a surface model), and the attribution its licence requires
// (https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

export type SurfaceModel = 'DTM' | 'DSM' | 'mixed' | 'unknown';

export interface ElevationDataset {
  readonly key: string;
  readonly name: string;
  /** Approximate native horizontal resolution in metres. */
  readonly resolutionM: number;
  /** `DTM`: bare earth; `DSM`: includes canopy and buildings (at least partly). */
  readonly model: 'DTM' | 'DSM';
  readonly attribution: string;
  /** Global fill used under finer data; ignored when finer data is listed. */
  readonly background?: boolean;
}

const USGS = 'Elevation data courtesy of the U.S. Geological Survey';

/** By the source path's directory (or a recognisable file name for NED). */
const DATASETS: readonly (ElevationDataset & { readonly match: RegExp })[] = [
  {
    key: 'ned19',
    match: /^ned\/ned19_|^ned_topobathy\//,
    name: 'USGS NED 1/9 arc-second',
    resolutionM: 3,
    model: 'DTM',
    attribution: USGS,
  },
  {
    key: 'ned13',
    match: /^ned13\/|^ned\//,
    name: 'USGS NED 1/3 arc-second',
    resolutionM: 10,
    model: 'DTM',
    attribution: USGS,
  },
  {
    key: 'srtm',
    match: /^srtm\//,
    name: 'SRTM 1 arc-second',
    resolutionM: 30,
    model: 'DSM',
    attribution: USGS,
  },
  {
    key: 'gmted',
    match: /^gmted\//,
    name: 'GMTED2010',
    resolutionM: 225,
    model: 'DSM',
    attribution: USGS,
    background: true,
  },
  {
    key: 'etopo1',
    match: /^etopo1\//,
    name: 'ETOPO1',
    resolutionM: 1850,
    model: 'DSM',
    attribution: 'ETOPO1: NOAA National Centers for Environmental Information',
    background: true,
  },
  {
    key: 'eudem',
    match: /^eudem\//,
    name: 'EU-DEM',
    resolutionM: 25,
    model: 'DSM',
    attribution:
      'Produced using Copernicus data and information funded by the European Union - EU-DEM layers',
  },
  {
    key: 'uk_lidar',
    match: /^uk_lidar\//,
    name: 'Environment Agency LIDAR DTM',
    resolutionM: 2,
    model: 'DTM',
    attribution: '© Environment Agency copyright and/or database right 2015. All rights reserved.',
  },
  {
    key: 'austria',
    match: /^austria\//,
    name: 'DGM Österreich',
    resolutionM: 10,
    model: 'DTM',
    attribution: '© offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich',
  },
  {
    key: 'kartverket',
    match: /^kartverket\//,
    name: 'Kartverket DEM',
    resolutionM: 10,
    model: 'DTM',
    attribution: '© Kartverket',
  },
  {
    key: 'arcticdem',
    match: /^pgdc_5m\/|^arcticdem\//,
    name: 'ArcticDEM',
    resolutionM: 5,
    model: 'DSM',
    attribution:
      'DEM(s) created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736',
  },
  {
    key: 'cdem',
    match: /^cdem\//,
    name: 'Canadian Digital Elevation Model',
    resolutionM: 20,
    model: 'DSM',
    attribution: 'Contains information licensed under the Open Government Licence – Canada',
  },
  {
    key: 'inegi',
    match: /^inegi\/|^mx\//,
    name: 'INEGI Continental Relief',
    resolutionM: 15,
    model: 'DTM',
    attribution: 'Source: INEGI, Continental relief, 2016',
  },
  {
    key: 'linz',
    match: /^linz\/|^nzdem\//,
    name: 'LINZ 8 m DEM',
    resolutionM: 8,
    model: 'DTM',
    attribution:
      'Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government',
  },
  {
    key: 'geoscience_au',
    match: /^au\/|^geoscience_au\/|^ga\//,
    name: 'Geoscience Australia 5 m DEM',
    resolutionM: 5,
    model: 'DTM',
    attribution: '© Commonwealth of Australia (Geoscience Australia) 2017',
  },
];

/** The dataset a source path belongs to, or `undefined` when it is not recognised. */
export function classifyElevationSource(path: string): ElevationDataset | undefined {
  const p = path.trim();
  const found = DATASETS.find((d) => d.match.test(p));
  if (!found) return undefined;
  return {
    key: found.key,
    name: found.name,
    resolutionM: found.resolutionM,
    model: found.model,
    attribution: found.attribution,
    ...(found.background ? { background: true } : {}),
  };
}

/** Summary of the sources behind a set of tiles. */
export interface ElevationSourceSummary {
  /** Recognised datasets, finest first, background fills last. */
  readonly datasets: readonly ElevationDataset[];
  /** Source paths not in the table. */
  readonly unrecognised: readonly string[];
  /**
   * Finest native resolution among the non-background datasets listed (a
   * tile may combine sources; parts of the battlefield may be coarser).
   * `null` when nothing is recognised.
   */
  readonly finestResolutionM: number | null;
  /** Coarsest non-background resolution listed, or `null`. */
  readonly coarsestResolutionM: number | null;
  readonly surfaceModel: SurfaceModel;
  /** Attribution lines, deduplicated, in dataset order. */
  readonly attribution: readonly string[];
}

/** Summarises the source paths reported for the tiles a battlefield used. */
export function summarizeElevationSources(paths: readonly string[]): ElevationSourceSummary {
  const byKey = new Map<string, ElevationDataset>();
  const unrecognised = new Set<string>();
  for (const raw of paths) {
    for (const path of raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')) {
      const d = classifyElevationSource(path);
      if (d) byKey.set(d.key, d);
      else unrecognised.add(path);
    }
  }
  const all = [...byKey.values()].sort(
    (a, b) =>
      Number(a.background ?? false) - Number(b.background ?? false) ||
      a.resolutionM - b.resolutionM ||
      a.key.localeCompare(b.key),
  );
  const primary = all.filter((d) => !d.background);
  const used = primary.length > 0 ? primary : all;
  const models = new Set(used.map((d) => d.model));
  return {
    datasets: all,
    unrecognised: [...unrecognised].sort(),
    finestResolutionM: used.length > 0 ? Math.min(...used.map((d) => d.resolutionM)) : null,
    coarsestResolutionM: used.length > 0 ? Math.max(...used.map((d) => d.resolutionM)) : null,
    surfaceModel:
      models.size === 0 ? 'unknown' : models.size > 1 ? 'mixed' : (used[0]?.model ?? 'unknown'),
    attribution: [...new Set(all.map((d) => d.attribution))],
  };
}
