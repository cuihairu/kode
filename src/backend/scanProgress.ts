/**
 * SCAN-RESUME-001 扫描断点续扫纯核(2026-11-18 用户令「扫描一半可以关闭
 * 重新打开可以继续扫描」):python 类索引全量扫描分块推进(16 路并发读、逐块
 * loadFile→commitParsedFile 逐文件提交),本模块把「已完成且已提交的分块」
 * 落盘为断点,中断(关窗/崩溃)后重开指纹匹配的文件直接采纳(直取路径,
 * 与 indexDiskCache 恢复同构),只扫剩余部分。
 *
 * 布局:<index-cache>/scan-progress/{progress.json, chunk-N.json}
 * - chunk-N.json = 分块载荷(不可变,一次写成):该块已提交文件的
 *   {path, mtimeMs, size, version, parsed}——parsed 为 ParsedPythonFile 的
 *   JSON 投影(Map→条目数组),恢复侧重建 Map 后走 commitParsedFile 同一面,
 *   不重读盘不重解析。
 * - progress.json = 提交点:schema/kodeVersion 版本门 + 已完成分块号清单
 *   (分块完成序≠入队序,清单是集合语义;chunksDone 为计数观测面)。
 *   产物先写、meta 后写;meta 未列出的分块 = 不存在(下次照扫)。
 * - 写失败静默:断点只是加速不是承诺;meta 列了但分块文件损坏 → 整体弃用
 *   (等同无断点全扫,不 crash)。
 *
 * 诚实口径红线:断点恢复发生在扫描内部(采纳=一次分块完成),查询面
 * loading/partial 口径不动——半成品索引不提前对外服务;指纹漂移(mtime/size
 * 任一不符)绝不复用,宁可重扫不错续。
 *
 * 与任务书 progress.json 形状的两处有意偏差(工程口径):
 * - files 指纹清单分布在 chunk-N.json 内而非 progress.json——meta 保持
 *   微小(每分块重写一次是 O(分块数) 不是 O(文件数),巨仓不写放大);
 * - chunksDone 数字升格为 chunks 分块号清单——分块完成序随 IO 时序翻动,
 *   计数会把「未完成的第 N 块之后全部错记」。
 *
 * 本模块零 vscode 依赖(纯核);IO 全注入(测试容错臂)。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedPythonFile, PythonClassDef } from './pythonParser';

export const SCAN_PROGRESS_SCHEMA_VERSION = 'scan-progress/1';
export const SCAN_PROGRESS_DIR_NAME = 'scan-progress';

const META_FILE = 'progress.json';
const chunkFileOf = (index: number): string => `chunk-${index}.json`;

/** 断点条目载荷:ParsedPythonFile 的 JSON 投影(Map 序列化为条目数组) */
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

/** 分块载荷单条:文件指纹 + 版本 + 解析投影 */
export interface ScanProgressEntry {
  path: string;
  mtimeMs: number;
  size: number;
  version: number;
  parsed: SerializedParsedPythonFile;
}

/** 提交点 meta:版本门 + 已完成分块号清单 */
export interface ScanProgressMetaFile {
  schema: string;
  /** 溯源用:写断点时的扩展版本号。不作淘汰键(见 readScanProgress 版本门) */
  kodeVersion: string;
  chunks: number[];
  chunksDone: number;
}

/** IO 注入面(默认同步 fs;测试注入失败/损坏臂) */
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

/** 序列化投影往返等价断言面(测试/自检用) */
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

/** 读断点:版本门(分级,只认破坏性变更,见下方注释)→ 逐分块读载荷
 * (meta 列了但文件缺失/损坏 → 整体弃用 null,不部分采纳半截)。 */
export function readScanProgress(
  dir: string,
  expected: { schemaVersion: string; kodeVersion: string },
  io: ScanProgressIo = defaultScanProgressIo
): { meta: ScanProgressMetaFile; entries: ScanProgressEntry[] } | null {
  const meta = parseJson<ScanProgressMetaFile>(io.readText(path.join(dir, META_FILE)));
  if (!meta || typeof meta !== 'object' || typeof meta.schema !== 'string') {
    return null;
  }
  // 版本门(2026-11-18 用户拍板,纠正 2fe69ff3):唯一淘汰键 = schema 格式
  // 常量,与 indexDiskCache 同口径;引擎版本/扩展版本号都不参与,数据准确
  // 性由逐文件 mtime+size 快照管。meta 里遗留的 engineMajor 键(旧形态
  // 断点)被解析自然忽略,不因此作废。
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

/** 清场(删 meta+全部分块文件;失败静默——断点是加速不是承诺)。
 *  先读 meta 拿分块清单再删(顺序不能反);meta 已不在 → 孤儿 chunk 文件
 *  永不被读(读侧以 meta 为准),不构成正确性面,留待下轮同号覆盖。 */
export function clearScanProgressDir(dir: string, io: ScanProgressIo = defaultScanProgressIo): void {
  const meta = parseJson<ScanProgressMetaFile>(io.readText(path.join(dir, META_FILE)));
  if (meta && Array.isArray(meta.chunks)) {
    for (const index of meta.chunks) {
      if (typeof index === 'number') {
        try {
          io.deleteFile(path.join(dir, chunkFileOf(index)));
        } catch {
          // 静默
        }
      }
    }
  }
  try {
    io.deleteFile(path.join(dir, META_FILE));
  } catch {
    // 静默
  }
}

/** 恢复计划:指纹匹配(当前 stat 与断点指纹逐字段相等)→ 采纳;漂移/新增/
 * 断点缺席 → 照扫;断点里有但发现清单没有的文件(已删除) → 丢弃不复用。 */
export function planResume(
  entries: ScanProgressEntry[],
  files: string[],
  statOf: (file: string) => { mtimeMs: number; size: number } | null
): { adopt: Map<string, ScanProgressEntry>; scan: string[] } {
  const byPath = new Map<string, ScanProgressEntry>();
  for (const entry of entries) {
    // 良构断点里一个文件只属一个分块;防御性去重取先见(若出现重复条目,
    // 两者指纹同源同轮,取谁等价)
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

/** recordChunk 输入:已提交文件的版本+解析(指纹由控制器自查盘) */
export interface ScanChunkCommit {
  path: string;
  version: number;
  parsed: ParsedPythonFile;
}

/**
 * 断点控制器(纯核,IO 注入):PythonClassIndex 全扫分块完成时 recordChunk
 * (setImmediate 节拍异步落盘,静默失败);扫描起点 loadResumePlan(读断点+
 * 清场,计划驻内存);全量零失败收尾 complete(清场——断点使命完成)。
 * 部分失败/取消:不 complete,已记录分块留盘供下轮续扫。
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

  /** 扫描起点:读断点出计划并清场(含版本门作废的陈旧断点);无断点 → null */
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

  /** 分块完成:载荷先写、meta 后写(meta=提交点);setImmediate 节拍串行,
   *  失败静默(该块下次照扫,断点只是加速)。 */
  recordChunk(chunkIndex: number, commits: ScanChunkCommit[]): void {
    if (commits.length === 0) {
      return;
    }
    const entries: ScanProgressEntry[] = [];
    for (const commit of commits) {
      const stat = this.io.stat(commit.path);
      if (!stat) {
        continue; // 无诚实指纹(盘上已不可 stat):不入断点,下次照扫
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
          // 静默:断点写失败不影响扫描本身
        }
        resolve();
      });
    }));
  }

  /** 写链落定观测面(测试/收尾前 flush 用) */
  settle(): Promise<void> {
    return this.writeChain;
  }

  /** 全量零失败收尾:断点使命完成,清场(失败静默) */
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
