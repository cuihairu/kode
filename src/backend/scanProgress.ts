/**
 * SCAN-RESUME-001 scan checkpoint resume pure core (2026-11-18 user order "a scan
 * that is half done may be closed and reopened, and the scan continues"): the
 * python class index full scan advances in chunks (16 concurrent reads, per chunk
 * loadFile -> commitParsedFile committing file by file); this module persists the
 * "chunks already completed and committed" as a checkpoint, and on reopen after an
 * interruption (window close/crash) adopts files whose fingerprints match
 * directly (the fast-path, isomorphic with the indexDiskCache restore), scanning
 * only the remainder.
 *
 * Layout: <index-cache>/scan-progress/{progress.json, chunk-N.json}
 * - chunk-N.json = the chunk payload (immutable, written once): the {path,
 *   mtimeMs, size, version, parsed} of the files committed in that chunk — parsed
 *   is the JSON projection of ParsedPythonFile (Map -> entry array); the restore
 *   side rebuilds the Map and goes through the same commitParsedFile face, without
 *   re-reading the disk or re-parsing.
 * - progress.json = the commit point: the schema/kodeVersion version gate + the
 *   list of completed chunk numbers (chunk completion order differs from enqueue
 *   order, the list is set semantics; chunksDone is the count observation face).
 *   Products are written first, the meta afterwards; a chunk not listed by meta =
 *   does not exist (scanned as usual next time).
 * - Write failure is silent: a checkpoint is only an accelerator, not a promise;
 *   if meta lists a chunk but the chunk file is corrupt -> discard the whole thing
 *   (a full scan without a checkpoint, no crash).
 *
 * The honesty ruling red line: checkpoint restore happens inside the scan itself
 * (adoption = one chunk completing), the query face loading/partial ruling is
 * untouched — a half-built index is never served early; fingerprint drift (mtime/
 * size mismatch on either) is never reused, rather re-scan than mis-resume.
 *
 * Two intentional deviations from the task sheet's progress.json shape
 * (engineering ruling):
 * - the files fingerprint list lives inside chunk-N.json rather than
 *   progress.json — keeping meta small (rewriting per chunk is O(chunk count), not
 *   O(file count), so a huge repo does not write-amplify);
 * - the chunksDone number is promoted into a chunks chunk-number list — chunk
 *   completion order swings with IO timing, and a count would mis-record "everything
 *   after the unfinished Nth chunk".
 *
 * This module has zero vscode dependencies (pure core); IO is all injected (the
 * test fault-injection arm).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedPythonFile, PythonClassDef } from './pythonParser';

export const SCAN_PROGRESS_SCHEMA_VERSION = 'scan-progress/1';
export const SCAN_PROGRESS_DIR_NAME = 'scan-progress';

const META_FILE = 'progress.json';
const chunkFileOf = (index: number): string => `chunk-${index}.json`;

/** Checkpoint entry payload: the JSON projection of ParsedPythonFile (Map serialized as an entry array) */
export interface SerializedPythonClassDef {
  name: string;
  bases: string[];
  qualifiedName?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  methods: Array<[string, { line: number; character: number }]>;
}

export interface SerializedParsedPythonFile {
  filePath: string;
  classes: SerializedPythonClassDef[];
  imports?: Array<[string, { module: string; symbol?: string }]>;
  instanceAssignments: Array<{ variable: string; className: string; line: number }>;
}

/** One chunk payload entry: the file fingerprint + version + parse projection */
export interface ScanProgressEntry {
  path: string;
  mtimeMs: number;
  size: number;
  version: number;
  parsed: SerializedParsedPythonFile;
}

/** Commit-point meta: the version gate + the list of completed chunk numbers */
export interface ScanProgressMetaFile {
  schema: string;
  /** For tracing: the extension version when the checkpoint was written. Not an eviction key (see the readScanProgress version gate) */
  kodeVersion: string;
  chunks: number[];
  chunksDone: number;
}

/** IO injection face (defaults to the sync fs; tests inject failure/corruption arms) */
export interface ScanProgressIo {
  readText(file: string): string | null;
  writeTextAtomic(file: string, content: string): void;
  ensureDir(dir: string): void;
  deleteFile(file: string): void;
  stat(target: string): { mtimeMs: number; size: number } | null;
}

export const defaultScanProgressIo: ScanProgressIo = {
  readText: file => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  writeTextAtomic: (file, content) => {
    const temp = `${file}.kode-tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
  },
  ensureDir: dir => {
    fs.mkdirSync(dir, { recursive: true });
  },
  deleteFile: file => {
    fs.unlinkSync(file);
  },
  stat: target => {
    try {
      const stats = fs.statSync(target);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }
  }
};

export function serializeParsedPythonFile(parsed: ParsedPythonFile): SerializedParsedPythonFile {
  return {
    filePath: parsed.filePath,
    classes: parsed.classes.map((cls): SerializedPythonClassDef => ({
      name: cls.name,
      bases: cls.bases,
      qualifiedName: cls.qualifiedName,
      filePath: cls.filePath,
      startLine: cls.startLine,
      endLine: cls.endLine,
      methods: [...cls.methods.entries()]
    })),
    imports: parsed.imports ? [...parsed.imports.entries()] : undefined,
    instanceAssignments: parsed.instanceAssignments
  };
}

export function restoreSerializedParsedPythonFile(serialized: SerializedParsedPythonFile): ParsedPythonFile {
  return {
    filePath: serialized.filePath,
    classes: serialized.classes.map((cls): PythonClassDef => ({
      name: cls.name,
      bases: cls.bases,
      qualifiedName: cls.qualifiedName,
      filePath: cls.filePath,
      startLine: cls.startLine,
      endLine: cls.endLine,
      methods: new Map(cls.methods)
    })),
    imports: serialized.imports ? new Map(serialized.imports) : undefined,
    instanceAssignments: serialized.instanceAssignments
  };
}

/** Serialization projection round-trip equality assertion face (for tests/self-checks) */
export function parsedPythonFileEqualsRoundtrip(
  original: ParsedPythonFile,
  restored: ParsedPythonFile
): boolean {
  return JSON.stringify(serializeParsedPythonFile(original))
    === JSON.stringify(serializeParsedPythonFile(restored));
}

const parseJson = <T>(text: string | null): T | null => {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const isEntryShape = (value: unknown): value is ScanProgressEntry => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string'
    && typeof entry.mtimeMs === 'number'
    && typeof entry.size === 'number'
    && typeof entry.version === 'number'
    && !!entry.parsed && typeof entry.parsed === 'object';
};

/** Read the checkpoint: the version gate (tiered, only recognizes breaking changes, see the note below) -> read payloads chunk by chunk
 * (meta lists it but the file is missing/corrupt -> discard the whole thing as null, never partially adopting half). */
export function readScanProgress(
  dir: string,
  expected: { schemaVersion: string; kodeVersion: string },
  io: ScanProgressIo = defaultScanProgressIo
): { meta: ScanProgressMetaFile; entries: ScanProgressEntry[] } | null {
  const meta = parseJson<ScanProgressMetaFile>(io.readText(path.join(dir, META_FILE)));
  if (!meta || typeof meta !== 'object' || typeof meta.schema !== 'string') {
    return null;
  }
  // Version gate (2026-11-18 user ruling, correcting 2fe69ff3): the only eviction
  // key = the schema format constant, the same ruling as indexDiskCache; neither
  // the engine version nor the extension version participates, and data accuracy
  // is governed by the per-file mtime+size snapshot. A leftover engineMajor key in
  // meta (an old-shape checkpoint) is naturally ignored by the parse, not
  // invalidated because of it.
  if (meta.schema !== expected.schemaVersion) {
    return null;
  }
  if (!Array.isArray(meta.chunks)) {
    return null;
  }
  const entries: ScanProgressEntry[] = [];
  for (const index of meta.chunks) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      return null;
    }
    const chunk = parseJson<ScanProgressEntry[]>(io.readText(path.join(dir, chunkFileOf(index))));
    if (!Array.isArray(chunk) || !chunk.every(isEntryShape)) {
      return null;
    }
    entries.push(...chunk);
  }
  return { meta, entries };
}

/** Clean up (delete meta + all chunk files; silent on failure — a checkpoint is an accelerator, not a promise).
 *  Read meta to get the chunk list before deleting (the order must not be reversed); meta already gone -> an orphan
 *  chunk file is never read (the read side treats meta as authoritative), which is not a correctness face and is left
 *  for the next round's same-numbered overwrite. */
export function clearScanProgressDir(dir: string, io: ScanProgressIo = defaultScanProgressIo): void {
  const meta = parseJson<ScanProgressMetaFile>(io.readText(path.join(dir, META_FILE)));
  if (meta && Array.isArray(meta.chunks)) {
    for (const index of meta.chunks) {
      if (typeof index === 'number') {
        try {
          io.deleteFile(path.join(dir, chunkFileOf(index)));
        } catch {
          // silent
        }
      }
    }
  }
  try {
    io.deleteFile(path.join(dir, META_FILE));
  } catch {
    // silent
  }
}

/** Resume plan: fingerprint match (the current stat equals the checkpoint fingerprint field by field) -> adopt; drifted/new/
 * checkpoint absent -> scan as usual; a file present in the checkpoint but missing from the discovery list (deleted) -> drop, never reused. */
export function planResume(
  entries: ScanProgressEntry[],
  files: string[],
  statOf: (file: string) => { mtimeMs: number; size: number } | null
): { adopt: Map<string, ScanProgressEntry>; scan: string[] } {
  const byPath = new Map<string, ScanProgressEntry>();
  for (const entry of entries) {
    // In a well-formed checkpoint a file belongs to only one chunk; defensively
    // dedupe by keeping the first sighting (if duplicate entries appear, both
    // fingerprints come from the same source and round, so taking either is equivalent)
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, entry);
    }
  }
  const adopt = new Map<string, ScanProgressEntry>();
  const scan: string[] = [];
  for (const file of files) {
    const entry = byPath.get(file);
    const stat = entry ? statOf(file) : null;
    if (entry && stat && stat.mtimeMs === entry.mtimeMs && stat.size === entry.size) {
      adopt.set(file, entry);
    } else {
      scan.push(file);
    }
  }
  return { adopt, scan };
}

/** recordChunk input: the version+parse of a committed file (the fingerprint is probed from disk by the controller) */
export interface ScanChunkCommit {
  path: string;
  version: number;
  parsed: ParsedPythonFile;
}

/**
 * Checkpoint controller (pure core, IO injected): when a PythonClassIndex full-scan
 * chunk completes, recordChunk (persisted asynchronously on the setImmediate tick,
 * silent failure); at the scan start loadResumePlan (read the checkpoint + clean
 * up, the plan stays in memory); on a full scan with zero failures complete (clean
 * up — the checkpoint's mission is done). Partial failure/cancellation: no
 * complete, recorded chunks stay on disk for the next round's resume.
 */
export class ScanProgressController {
  private readonly dir: string;
  private readonly kodeVersion: string;
  private readonly io: ScanProgressIo;
  private chunksRecorded = new Set<number>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    dir: string,
    kodeVersion: string,
    io: ScanProgressIo = defaultScanProgressIo
  ) {
    this.dir = dir;
    this.kodeVersion = kodeVersion;
    this.io = io;
  }

  /** Scan start: read the checkpoint into a plan and clean up (including stale checkpoints invalidated by the version gate); no checkpoint -> null */
  loadResumePlan(files: string[]): { adopt: Map<string, ScanProgressEntry>; scan: string[] } | null {
    const loaded = readScanProgress(this.dir, {
      schemaVersion: SCAN_PROGRESS_SCHEMA_VERSION,
      kodeVersion: this.kodeVersion
    }, this.io);
    clearScanProgressDir(this.dir, this.io);
    this.chunksRecorded = new Set();
    if (!loaded || loaded.entries.length === 0) {
      return null;
    }
    return planResume(loaded.entries, files, file => this.io.stat(file));
  }

  /** Chunk complete: the payload is written first, the meta afterwards (meta = the commit point); serialized on the
   *  setImmediate tick, silent failure (that chunk is scanned as usual next time; a checkpoint is only an accelerator). */
  recordChunk(chunkIndex: number, commits: ScanChunkCommit[]): void {
    if (commits.length === 0) {
      return;
    }
    const entries: ScanProgressEntry[] = [];
    for (const commit of commits) {
      const stat = this.io.stat(commit.path);
      if (!stat) {
        continue; // no honest fingerprint (no longer statable on disk): not in the checkpoint, scanned as usual next time
      }
      entries.push({
        path: commit.path,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        version: commit.version,
        parsed: serializeParsedPythonFile(commit.parsed)
      });
    }
    if (entries.length === 0) {
      return;
    }
    this.writeChain = this.writeChain.then(() => new Promise<void>(resolve => {
      setImmediate(() => {
        try {
          this.io.ensureDir(this.dir);
          this.io.writeTextAtomic(
            path.join(this.dir, chunkFileOf(chunkIndex)),
            JSON.stringify(entries)
          );
          this.chunksRecorded.add(chunkIndex);
          const chunks = [...this.chunksRecorded].sort((a, b) => a - b);
          const meta: ScanProgressMetaFile = {
            schema: SCAN_PROGRESS_SCHEMA_VERSION,
            kodeVersion: this.kodeVersion,
            chunks,
            chunksDone: chunks.length
          };
          this.io.writeTextAtomic(path.join(this.dir, META_FILE), JSON.stringify(meta));
        } catch {
          // silent: a checkpoint write failure does not affect the scan itself
        }
        resolve();
      });
    }));
  }

  /** Write-chain settle observation face (for tests / flushing before closing) */
  settle(): Promise<void> {
    return this.writeChain;
  }

  /** Full-scan zero-failure closing: the checkpoint's mission is done, clean up (silent failure) */
  complete(): void {
    this.writeChain = this.writeChain.then(() => new Promise<void>(resolve => {
      setImmediate(() => {
        clearScanProgressDir(this.dir, this.io);
        this.chunksRecorded = new Set();
        resolve();
      });
    }));
  }
}
