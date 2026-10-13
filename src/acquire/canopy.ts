import {
  parseTiffHeader,
  TiffTruncatedError,
  type CanopyPlan,
  type CanopyRaster,
  type TiffImage,
} from '#geo';
import type { ServiceConfig } from './config';
import { fetchWithRetry, isCancelled, mapWithConcurrency, ServiceError } from './http';
import { retry, type ClientOptions } from './services';

// Canopy heights for tree cover (docs/adr/0050): the windows of the Meta /
// World Resources Institute canopy height map (CHMv2) over a battlefield,
// read with HTTP range requests straight from the browser. Each zoom-10 tile
// is one Cloud Optimized GeoTIFF of 32 768 × 32 768 pixels (about 250 MB) in
// 512-pixel blocks; a 5 km battlefield needs its header and about 120
// blocks, some 8 MB.

export const CANOPY = 'Tree cover (canopy heights)';

/** Header bytes read first: the CHMv2 tiles' headers and block tables fit in about 120 kB. */
const HEADER_BYTES = 192 * 1024;
/** Neighbouring blocks closer than this in the file are read in one request, bytes. */
const MERGE_GAP = 64 * 1024;
/** One request reads at most this much, bytes. */
const MAX_REQUEST = 4 * 1024 * 1024;

/** The canopy windows read for a battlefield. */
export interface CanopySource {
  /** The folder of the tiles read. */
  readonly url: string;
  readonly rasters: readonly CanopyRaster[];
  /** Tiles the map does not have (no land, or not published): no canopy there. */
  readonly missing: readonly string[];
}

/** Bytes `offset`…`offset + length − 1` of a file, or `null` when the file does not exist. */
async function readRange(
  url: string,
  offset: number,
  length: number,
  o: ClientOptions,
): Promise<Uint8Array | null> {
  const response = await fetchWithRetry(
    url,
    { headers: { Range: `bytes=${String(offset)}-${String(offset + length - 1)}` } },
    retry(CANOPY, o, { passStatuses: [403, 404, 416] }),
  );
  if (response.status === 403 || response.status === 404) return null;
  // Past the end of a short file: nothing more to read.
  if (response.status === 416) return new Uint8Array(0);
  // A server that ignores ranges would send the whole tile (about 250 MB).
  if (response.status !== 206) {
    throw new ServiceError(
      CANOPY,
      `${CANOPY} failed: the server does not support reading part of a file.`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** zlib (TIFF compression 8) data, inflated. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The full-resolution image of a canopy tile, checked: 8-bit, one band, tiled, Deflate or none. */
function fullImage(images: readonly TiffImage[], url: string): TiffImage {
  const image = images.find((i) => (i.subfileType & 5) === 0);
  const fail = (why: string): never => {
    throw new ServiceError(CANOPY, `${CANOPY} failed: ${url} ${why}.`);
  };
  if (!image) return fail('has no full-resolution image');
  if (image.bitsPerSample !== 8 || image.samplesPerPixel !== 1) fail('is not 8-bit heights');
  if (image.tileWidth <= 0 || image.tileHeight <= 0) fail('is not tiled');
  if (image.compression !== 8 && image.compression !== 1) fail('uses an unsupported compression');
  if (image.predictor !== 1) fail('uses a predictor');
  if (!image.pixelScale || !image.tiepoint) fail('has no georeference');
  return image;
}

/** The window of one canopy tile over `plan.box`, or `null` when the tile does not exist. */
async function readWindow(
  url: string,
  quadkey: string,
  plan: CanopyPlan,
  concurrency: number,
  o: ClientOptions,
): Promise<CanopyRaster | null> {
  let bytes = await readRange(url, 0, HEADER_BYTES, o);
  if (!bytes) return null;
  let images: TiffImage[];
  for (;;) {
    try {
      images = parseTiffHeader(bytes);
      break;
    } catch (error) {
      if (!(error instanceof TiffTruncatedError) || error.needed <= bytes.length) throw error;
      const more = await readRange(url, 0, error.needed + 64 * 1024, o);
      if (!more) return null;
      bytes = more;
    }
  }
  const image = fullImage(images, url);
  const scale = image.pixelScale ?? [];
  const tie = image.tiepoint ?? [];
  const res = scale[0] ?? 1;
  const west = (tie[3] ?? 0) - (tie[0] ?? 0) * res;
  const north = (tie[4] ?? 0) + (tie[1] ?? 0) * res;
  const c0 = Math.max(0, Math.floor((plan.box.minX - west) / res));
  const c1 = Math.min(image.width, Math.ceil((plan.box.maxX - west) / res));
  const r0 = Math.max(0, Math.floor((north - plan.box.maxY) / res));
  const r1 = Math.min(image.height, Math.ceil((north - plan.box.minY) / res));
  if (c1 <= c0 || r1 <= r0) return null;
  const width = c1 - c0;
  const height = r1 - r0;
  const heights = new Uint8Array(width * height);
  const tw = image.tileWidth;
  const th = image.tileHeight;
  const across = Math.ceil(image.width / tw);
  // The blocks the window needs, in file order, read in merged ranges.
  const blocks: { bx: number; by: number; offset: number; length: number }[] = [];
  for (let by = Math.floor(r0 / th); by <= Math.floor((r1 - 1) / th); by += 1)
    for (let bx = Math.floor(c0 / tw); bx <= Math.floor((c1 - 1) / tw); bx += 1) {
      const i = by * across + bx;
      const length = image.tileByteCounts[i] ?? 0;
      if (length > 0) blocks.push({ bx, by, offset: image.tileOffsets[i] ?? 0, length });
    }
  blocks.sort((a, b) => a.offset - b.offset);
  const groups: (typeof blocks)[] = [];
  for (const b of blocks) {
    const g = groups[groups.length - 1];
    const first = g?.[0];
    const last = g?.[g.length - 1];
    if (
      g &&
      first &&
      last &&
      b.offset - (last.offset + last.length) <= MERGE_GAP &&
      b.offset + b.length - first.offset <= MAX_REQUEST
    )
      g.push(b);
    else groups.push([b]);
  }
  await mapWithConcurrency(groups, concurrency, async (group) => {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) return;
    const start = first.offset;
    const data = await readRange(url, start, last.offset + last.length - start, o);
    if (!data) throw new ServiceError(CANOPY, `${CANOPY} failed: ${url} could not be read.`);
    for (const b of group) {
      const raw = data.subarray(b.offset - start, b.offset - start + b.length);
      const pixels = image.compression === 8 ? await inflate(raw) : raw;
      // Copy the block's part of the window.
      const bc0 = b.bx * tw;
      const br0 = b.by * th;
      for (let r = Math.max(r0, br0); r < Math.min(r1, br0 + th); r += 1) {
        const from = (r - br0) * tw + (Math.max(c0, bc0) - bc0);
        const to = (r - r0) * width + (Math.max(c0, bc0) - c0);
        const n = Math.min(c1, bc0 + tw) - Math.max(c0, bc0);
        heights.set(pixels.subarray(from, from + n), to);
      }
    }
  });
  return {
    quadkey,
    west: west + c0 * res,
    north: north - r0 * res,
    resolution: res,
    width,
    height,
    heights,
  };
}

/** Canopy windows as stored with a battlefield's sources: their heights compressed. */
export interface StoredCanopy {
  readonly url: string;
  readonly missing: readonly string[];
  readonly rasters: readonly (Omit<CanopyRaster, 'heights'> & { readonly heights: Blob })[];
}

/** The canopy windows compressed for storing (Deflate: about a quarter of their size). */
export async function packCanopy(source: CanopySource): Promise<StoredCanopy> {
  const rasters = await Promise.all(
    source.rasters.map(async ({ heights, ...rest }) => {
      const stream = new Blob([heights as BlobPart])
        .stream()
        .pipeThrough(new CompressionStream('deflate'));
      return { ...rest, heights: await new Response(stream).blob() };
    }),
  );
  return { url: source.url, missing: source.missing, rasters };
}

/** Stored canopy windows, decompressed. */
export async function unpackCanopy(stored: StoredCanopy): Promise<CanopySource> {
  const rasters = await Promise.all(
    stored.rasters.map(async ({ heights, ...rest }) => {
      const stream = heights.stream().pipeThrough(new DecompressionStream('deflate'));
      return { ...rest, heights: new Uint8Array(await new Response(stream).arrayBuffer()) };
    }),
  );
  return { url: stored.url, missing: stored.missing, rasters };
}

/**
 * Reads the canopy map over a battlefield (`planCanopy`). Throws a
 * `ServiceError` naming the canopy service when it cannot be read.
 */
export async function fetchCanopy(
  plan: CanopyPlan,
  config: ServiceConfig,
  o: ClientOptions,
): Promise<CanopySource> {
  const base = config.canopyTilesUrl.replace(/\/?$/, '/');
  const rasters: CanopyRaster[] = [];
  const missing: string[] = [];
  try {
    for (const tile of plan.tiles) {
      const raster = await readWindow(
        `${base}${tile.quadkey}.tif`,
        tile.quadkey,
        plan,
        config.tileConcurrency,
        o,
      );
      if (raster) rasters.push(raster);
      else missing.push(tile.quadkey);
    }
  } catch (error) {
    if (error instanceof ServiceError || isCancelled(error)) throw error;
    throw new ServiceError(
      CANOPY,
      `${CANOPY} failed: the data could not be read (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  return { url: base, rasters, missing };
}
