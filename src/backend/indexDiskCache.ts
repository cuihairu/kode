/**
 * BG-WARM index disk cache pure core (2026-11-18 user order, inspection
 * sheet kode-index-disk-cache.md): the two heaviest pieces of the five-stage
 * warmup (discovery def parse cache / eventIndex event index) land on disk in
 * globalStorage, taking a second startup from "minutes of full-repo rescan"
 * down to "seconds of hash verification".
 *
 * Layout: <globalStorage>/index-cache/{meta.json, discovery.json, eventIndex.json, defLut.json}
 * - meta.json = commit point: schema version + extension version (for
 *   provenance) + per-artifact sha256 + counts. The eviction key only honors
 *   the schema format constant (see the readIndexCache version-gate comment):
 *   when kode changes its index data format / parse structure, bumping it
 *   discards and rebuilds the whole cache; the extension version and the
 *   engine version do not participate (2026-11-18 user ruling, correcting
 *   2fe69ff3: the engine version has nothing to do with whether kode can
 *   parse its own cache; the extension's nightly rolling version is even less
 *   fit as an eviction key). Data accuracy is governed by the entity side's
 *   existing per-file mtime+size hash snapshots.
 *   Artifacts are written first and meta last; meta not updated = the old
 *   cache is fully usable (writeFileAtomic is per-file atomic, never
 *   half-written).
 * - Artifact files = pure payload arrays; on read-back each is verified
 *   against meta's sha; tampered/truncated -> that artifact is discarded
 *   (the next startup does a full scan as before).
 *
 * This module has zero vscode dependency (pure core + dummy same-shape
 * pattern); all IO is injected (tests inject the failure arms).
 * Semantics-unchanged iron rule: the cache only moves the timing; the index
 * content is guaranteed byte-for-byte equal to a fresh computation by the
 * capture/restore entity pair (EntityMappingManager / WorkspaceIndex) -- the
 * invalidation criterion lives on the entity side (stat snapshot comparison);
 * this module only handles persistence and the version gate.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { EntityMappingIndex } from '../entityMapping';
import type { DefLutDiskFile } from './defMethodLut';
import type { IndexedFile } from '../workspaceIndex';

/** Cache structure version: bump when the payload shape changes, discarding the old cache wholesale (pin ④) */
export const INDEX_CACHE_SCHEMA_VERSION = 'index-cache/1';
export const INDEX_CACHE_DIR_NAME = 'index-cache';

/** discovery artifact entry: the on-disk shape of the .def parse cache (defParseCache).
 * pythonOwners = the half snapshot of the python owner files this def consumes --
 * py content is not reflected in the .def mtime (existing convention), so it must
 * be verified the same way across sessions, or stale pythonMethods get restored. */
export interface DefCacheDiskEntry {
  defPath: string;
  mtimeMs: number;
  size: number;
  pythonOwners: Array<{ path: string; mtimeMs: number; size: number }>;
  index: EntityMappingIndex;
}

/** eventIndex artifact entry: the on-disk shape of a WorkspaceIndex per-file index + stat snapshot */
export interface EventIndexDiskEntry {
  path: string;
  mtimeMs: number;
  size: number;
  indexed: IndexedFile;
}

export interface IndexCacheDiskPayload {
  discovery?: DefCacheDiskEntry[];
  eventIndex?: EventIndexDiskEntry[];
  /** DEF-LUT-001: def->py method jump reverse-lookup table (per-def buckets + stat snapshots, verified on the restore side) */
  defLut?: DefLutDiskFile[];
}

export interface IndexCacheMetaFile {
  schemaVersion: string;
  /** For provenance: the extension version at cache-write time. Not an eviction key (see the version-gate comment) */
  kodeVersion: string;
  savedAt: number;
  /** Content sha256 of each artifact (verified per artifact on read-back, guarding against tampering/truncation) */
  sha: { discovery?: string; eventIndex?: string; defLut?: string };
  discoveryCount: number;
  eventIndexCount: number;
  defLutCount?: number;
}

/** IO injection face (defaults to sync fs; tests inject the failure arms = pin ⑤) */
export interface IndexCacheIo {
  readText(file: string): string | null;
  writeTextAtomic(file: string, content: string): void;
  ensureDir(dir: string): void;
}

export const defaultIndexCacheIo: IndexCacheIo = {
  readText: file => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  writeTextAtomic: (file, content) => {
    // Reuses the existing atomic write (temp file + rename); a throwing failure is silently degraded by the layer above
    const temp = `${file}.kode-tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
  },
  ensureDir: dir => {
    fs.mkdirSync(dir, { recursive: true });
  }
};

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * discovery payload serialization projection: strips semantics.local.document
 * (the DefDocument XML original tree -- cyclic children references plus the
 * bulk of the cache size); the restore side rebuilds a minimal placeholder
 * document from rootName. The document face has exactly one consumer in the
 * EntityMappingIndex consumption faces (messageTableEngine reads root?.name),
 * and the placeholder keeps that face behaviorally equivalent; the
 * getAllMappings projection does not include semantics, so the equivalence
 * assertion face is unaffected. If a new deep document consumer appears in
 * the future, the placeholder will honestly expose itself as an empty face --
 * no silently serving stale data.
 */
const documentPlaceholderOf = (rootName: string): unknown => ({
  text: '',
  lineStarts: [],
  root: { name: rootName },
  nodes: []
});

export function serializeDefCacheEntries(entries: DefCacheDiskEntry[]): string {
  const projected = entries.map(entry => ({
    ...entry,
    index: {
      ...entry.index,
      semantics: {
        ...entry.index.semantics,
        local: {
          ...entry.index.semantics.local,
          document: documentPlaceholderOf(entry.index.rootName)
        }
      }
    }
  }));
  return JSON.stringify(projected);
}

export interface LoadedIndexCache {
  meta: IndexCacheMetaFile;
  payload: IndexCacheDiskPayload;
}

const parseJsonArray = (text: string | null): unknown[] | null => {
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Reads the cache: meta version gate (tiered, only destructive changes count,
 * see the comment below) -> per-artifact sha verification (mismatch -> that
 * artifact is absent, the caller full-scans that side as before).
 * meta missing/corrupt -> null (same as not cached).
 */
export function readIndexCache(
  cacheDir: string,
  expected: { schemaVersion: string; kodeVersion: string },
  io: IndexCacheIo = defaultIndexCacheIo
): LoadedIndexCache | null {
  const metaText = io.readText(path.join(cacheDir, 'meta.json'));
  if (metaText === null) {
    return null;
  }
  let meta: IndexCacheMetaFile;
  try {
    const parsed = JSON.parse(metaText) as IndexCacheMetaFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.schemaVersion !== 'string') {
      return null;
    }
    meta = parsed;
  } catch {
    return null;
  }
  // Version gate (2026-11-18 user ruling, correcting 2fe69ff3's engineMajor tiering): the only
  // eviction key = schemaVersion (kode's index data format constant). When kode changes its index
  // format/parse structure, bumping that constant discards and rebuilds the whole cache; the engine
  // version (the cached payload is derived entirely from workspace files, unrelated to engine APIs)
  // and the extension version (nightly rolls every time) do not participate in the decision; data
  // accuracy is governed by the entity side's per-file mtime+size hash snapshots. A leftover engineMajor
  // key in meta (2fe69ff3-shaped old cache) is naturally ignored by JSON parsing and does not trigger a wasted scan.
  if (meta.schemaVersion !== expected.schemaVersion) {
    return null;
  }
  const payload: IndexCacheDiskPayload = {};
  if (meta.sha.discovery) {
    const raw = parseJsonArray(io.readText(path.join(cacheDir, 'discovery.json')));
    if (raw !== null && sha256Of(JSON.stringify(raw)) === meta.sha.discovery) {
      payload.discovery = raw as DefCacheDiskEntry[];
    }
  }
  if (meta.sha.eventIndex) {
    const raw = parseJsonArray(io.readText(path.join(cacheDir, 'eventIndex.json')));
    if (raw !== null && sha256Of(JSON.stringify(raw)) === meta.sha.eventIndex) {
      payload.eventIndex = raw as EventIndexDiskEntry[];
    }
  }
  if (meta.sha.defLut) {
    const raw = parseJsonArray(io.readText(path.join(cacheDir, 'defLut.json')));
    if (raw !== null && sha256Of(JSON.stringify(raw)) === meta.sha.defLut) {
      payload.defLut = raw as DefLutDiskFile[];
    }
  }
  return { meta, payload };
}

/**
 * Writes the cache: artifacts first, meta last (meta = commit point); any
 * failure silently degrades and returns false
 * (pin ⑤: a write failure does not crash, the next startup full-scans as
 * before, logging belongs to the wiring layer).
 */
export function writeIndexCache(
  cacheDir: string,
  expected: { schemaVersion: string; kodeVersion: string },
  payload: IndexCacheDiskPayload,
  io: IndexCacheIo = defaultIndexCacheIo
): boolean {
  try {
    io.ensureDir(cacheDir);
    const sha: IndexCacheMetaFile['sha'] = {};
    if (payload.discovery) {
      const text = serializeDefCacheEntries(payload.discovery);
      io.writeTextAtomic(path.join(cacheDir, 'discovery.json'), text);
      sha.discovery = sha256Of(text);
    }
    if (payload.eventIndex) {
      const text = JSON.stringify(payload.eventIndex);
      io.writeTextAtomic(path.join(cacheDir, 'eventIndex.json'), text);
      sha.eventIndex = sha256Of(text);
    }
    if (payload.defLut) {
      const text = JSON.stringify(payload.defLut);
      io.writeTextAtomic(path.join(cacheDir, 'defLut.json'), text);
      sha.defLut = sha256Of(text);
    }
    const meta: IndexCacheMetaFile = {
      schemaVersion: expected.schemaVersion,
      kodeVersion: expected.kodeVersion,
      savedAt: Date.now(),
      sha,
      discoveryCount: payload.discovery?.length ?? 0,
      eventIndexCount: payload.eventIndex?.length ?? 0,
      defLutCount: payload.defLut?.length ?? 0
    };
    io.writeTextAtomic(path.join(cacheDir, 'meta.json'), JSON.stringify(meta));
    return true;
  } catch {
    return false;
  }
}
