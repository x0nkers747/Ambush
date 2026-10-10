import {
  findPmtilesEntry,
  parsePmtilesDirectory,
  parsePmtilesHeader,
  PMTILES_COMPRESSION,
  PMTILES_ROOT_BYTES,
  PMTILES_TILE_TYPE,
  PmtilesError,
  pmtilesTileId,
  type OvertureTile,
  type OvertureTileId,
  type PmtilesEntry,
  type PmtilesHeader,
} from '#geo';
import type { ServiceConfig } from './config';
import { fetchWithRetry, isCancelled, mapWithConcurrency, ServiceError } from './http';
import { retry, type ClientOptions } from './services';

// Overture Maps buildings (docs/adr/0023): the `buildings` theme of Overture's
// published vector tiles, one PMTiles archive per release, read with HTTP
// range requests straight from the browser. The archive is about 180 GB; a
// 5 km battlefield needs about 15 small requests.

export const OVERTURE = 'Buildings (Overture Maps)';

/** The release and archive a battlefield's buildings were read from, and the tiles read. */
export interface OvertureBuildings {
  readonly release: string;
  readonly url: string;
  readonly tiles: readonly OvertureTile[];
}

/** Overture's release names sort by date, then by the number after the dot ("2026-09-23.1"). */
export function compareReleases(a: string, b: string): number {
  const [da = '', na = '0'] = a.split('.');
  const [db = '', nb = '0'] = b.split('.');
  return da.localeCompare(db) || Number(na) - Number(nb);
}

/** The newest release in an S3 listing of the tiles folder (`?list-type=2&delimiter=/`). */
export function latestReleaseIn(listing: string, prefix: string): string | null {
  const releases = [...listing.matchAll(/<Prefix>([^<]*)<\/Prefix>/g)]
    .map((m) => m[1] ?? '')
    .filter((p) => p.startsWith(prefix) && p.length > prefix.length)
    .map((p) => p.slice(prefix.length).replace(/\/$/, ''))
    .filter((r) => /^\d{4}-\d{2}-\d{2}(\.\d+)?$/.test(r));
  return releases.sort(compareReleases).at(-1) ?? null;
}

/** The bucket and folder of a tiles base URL such as `https://bucket.s3.region.amazonaws.com/tiles/`. */
function bucketAndPrefix(base: string): { bucket: string; prefix: string } {
  const url = new URL(base);
  return { bucket: `${url.origin}/`, prefix: url.pathname.replace(/^\//, '') };
}

/** The release to read: the configured one, or the newest published. */
export async function overtureRelease(config: ServiceConfig, o: ClientOptions): Promise<string> {
  if (config.overtureRelease !== '') return config.overtureRelease;
  const { bucket, prefix } = bucketAndPrefix(config.overtureTilesUrl);
  const response = await fetchWithRetry(
    `${bucket}?list-type=2&delimiter=%2F&prefix=${encodeURIComponent(prefix)}`,
    {},
    retry(OVERTURE, o, { retries: 2 }),
  );
  const release = latestReleaseIn(await response.text(), prefix);
  if (!release)
    throw new ServiceError(OVERTURE, `${OVERTURE} failed: no published release was found.`);
  return release;
}

/** Gzip and uncompressed data as stored; other compressions are refused. */
async function decompress(bytes: Uint8Array, compression: number): Promise<Uint8Array> {
  if (compression === PMTILES_COMPRESSION.none) return bytes;
  if (compression !== PMTILES_COMPRESSION.gzip) {
    throw new ServiceError(
      OVERTURE,
      `${OVERTURE} failed: the archive uses a compression this version cannot read (${String(compression)}).`,
    );
  }
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A PMTiles archive read by byte ranges. Directories are fetched once and
 * kept; tiles are fetched on demand.
 */
function openArchive(url: string, o: ClientOptions) {
  const range = async (offset: number, length: number): Promise<Uint8Array> => {
    const response = await fetchWithRetry(
      url,
      { headers: { Range: `bytes=${String(offset)}-${String(offset + length - 1)}` } },
      retry(OVERTURE, o),
    );
    // A server that ignores ranges would send the whole archive (about 180 GB).
    if (response.status !== 206) {
      throw new ServiceError(
        OVERTURE,
        `${OVERTURE} failed: the server does not support reading part of the archive.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  let header: Promise<{ header: PmtilesHeader; root: PmtilesEntry[] }> | null = null;
  const leaves = new Map<number, Promise<PmtilesEntry[]>>();
  const readHeader = () => {
    header ??= range(0, PMTILES_ROOT_BYTES).then(async (start) => {
      const h = parsePmtilesHeader(start);
      if (h.tileType !== PMTILES_TILE_TYPE.mvt) {
        throw new ServiceError(
          OVERTURE,
          `${OVERTURE} failed: the archive does not hold vector tiles.`,
        );
      }
      const end = h.rootDirectoryOffset + h.rootDirectoryLength;
      const bytes =
        end <= start.length
          ? start.subarray(h.rootDirectoryOffset, end)
          : await range(h.rootDirectoryOffset, h.rootDirectoryLength);
      return {
        header: h,
        root: parsePmtilesDirectory(await decompress(bytes, h.internalCompression)),
      };
    });
    return header;
  };
  const leaf = (h: PmtilesHeader, entry: PmtilesEntry) => {
    let directory = leaves.get(entry.offset);
    if (!directory) {
      directory = range(h.leafDirectoryOffset + entry.offset, entry.length).then(async (bytes) =>
        parsePmtilesDirectory(await decompress(bytes, h.internalCompression)),
      );
      leaves.set(entry.offset, directory);
    }
    return directory;
  };
  return {
    header: async () => (await readHeader()).header,
    /** The decompressed tile, or `null` when the archive has none (no buildings there). */
    async tile(z: number, x: number, y: number): Promise<Uint8Array | null> {
      const { header: h, root } = await readHeader();
      const id = pmtilesTileId(z, x, y);
      let directory = root;
      // At most a few levels of leaf directories.
      for (let depth = 0; depth < 4; depth += 1) {
        const found = findPmtilesEntry(directory, id);
        if (!found) return null;
        if (found.kind === 'tile') {
          const bytes = await range(h.tileDataOffset + found.entry.offset, found.entry.length);
          return decompress(bytes, h.tileCompression);
        }
        directory = await leaf(h, found.entry);
      }
      throw new ServiceError(
        OVERTURE,
        `${OVERTURE} failed: the archive's directories are too deep.`,
      );
    },
  };
}

/**
 * Downloads the building tiles a battlefield needs from the configured (or
 * newest) Overture release. Throws a `ServiceError` naming Overture when the
 * release or archive cannot be read.
 */
export async function fetchOvertureBuildings(
  tiles: readonly OvertureTileId[],
  config: ServiceConfig,
  o: ClientOptions & { readonly onTile?: (done: number, total: number) => void },
): Promise<OvertureBuildings> {
  const release = await overtureRelease(config, o);
  const url = `${config.overtureTilesUrl.replace(/\/?$/, '/')}${release}/buildings.pmtiles`;
  const archive = openArchive(url, o);
  try {
    const header = await archive.header();
    if (tiles.some((t) => t.z < header.minZoom || t.z > header.maxZoom)) {
      throw new ServiceError(
        OVERTURE,
        `${OVERTURE} failed: release ${release} has no tiles at zoom ${String(tiles[0]?.z)} (it has ${String(header.minZoom)}–${String(header.maxZoom)}).`,
      );
    }
    let done = 0;
    const fetched = await mapWithConcurrency(tiles, config.tileConcurrency, async (t) => {
      const data = await archive.tile(t.z, t.x, t.y);
      done += 1;
      o.onTile?.(done, tiles.length);
      return { ...t, data };
    });
    return { release, url, tiles: fetched };
  } catch (error) {
    if (error instanceof ServiceError || isCancelled(error)) throw error;
    // Damaged data (unreadable directories, failed decompression) is a failure of the service too.
    const reason =
      error instanceof PmtilesError
        ? error.message
        : `the data could not be read (${error instanceof Error ? error.message : String(error)})`;
    throw new ServiceError(OVERTURE, `${OVERTURE} failed: ${reason}.`);
  }
}
