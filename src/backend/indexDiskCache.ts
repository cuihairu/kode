/**
 * BG-WARM 索引磁盘缓存纯核(2026-11-18 用户令,巡检单 kode-index-disk-cache.md):
 * 预热五阶段最重的两块(discovery def 解析缓存 / eventIndex 事件索引)落
 * globalStorage 磁盘,二次启动从「全仓重扫分钟级」降到「哈希校验秒级」。
 *
 * 布局:<globalStorage>/index-cache/{meta.json, discovery.json, eventIndex.json, defLut.json}
 * - meta.json = 提交点:kode 版本 + schema 版本 + 各产物 sha256 + 计数。
 *   版本不符即整体弃用(升级不背旧包袱);产物先写、meta 后写,meta 未更新
 *   = 旧缓存完整可用(writeFileAtomic 单文件原子,绝不半截)。
 * - 产物文件 = 纯载荷数组;读回时按 meta 的 sha 逐件校验,篡改/半截 → 该
 *   产物弃用(下次启动照旧全扫)。
 *
 * 本模块零 vscode 依赖(纯核+假体同形模式);IO 全注入(测试容错臂)。
 * 语义不变铁律:缓存只是挪时机,索引内容由 capture/restore 双侧实体
 * (EntityMappingManager / WorkspaceIndex)保证与现算逐字节等价——失效
 * 判据在实体侧(stat 快照比对),本模块只管持久化与版本门。
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { EntityMappingIndex } from '../entityMapping';
import type { DefLutDiskFile } from './defMethodLut';
import type { IndexedFile } from '../workspaceIndex';

/** 缓存结构版本:载荷形状变更时 bump,旧缓存整体弃用(钉子④) */
export const INDEX_CACHE_SCHEMA_VERSION = 'index-cache/1';
export const INDEX_CACHE_DIR_NAME = 'index-cache';

/** discovery 产物条目:.def 解析缓存(defParseCache)的磁盘形态。
 * pythonOwners = 该 def 消费的 python owner 文件半边快照——py 内容不在
 * .def mtime 里(既有口径),跨会话必须同校验,否则恢复出陈旧 pythonMethods。 */
export interface DefCacheDiskEntry {
  defPath: string;
  mtimeMs: number;
  size: number;
  pythonOwners: Array<{ path: string; mtimeMs: number; size: number }>;
  index: EntityMappingIndex;
}

/** eventIndex 产物条目:WorkspaceIndex 单文件索引的磁盘形态+stat 快照 */
export interface EventIndexDiskEntry {
  path: string;
  mtimeMs: number;
  size: number;
  indexed: IndexedFile;
}

export interface IndexCacheDiskPayload {
  discovery?: DefCacheDiskEntry[];
  eventIndex?: EventIndexDiskEntry[];
  /** DEF-LUT-001:def→py 方法跳转反查表(逐 def 桶+stat 快照,恢复侧校验) */
  defLut?: DefLutDiskFile[];
}

export interface IndexCacheMetaFile {
  schemaVersion: string;
  kodeVersion: string;
  savedAt: number;
  /** 各产物内容 sha256(读回逐件校验,防篡改/半截) */
  sha: { discovery?: string; eventIndex?: string; defLut?: string };
  discoveryCount: number;
  eventIndexCount: number;
  defLutCount?: number;
}

/** IO 注入面(默认同步 fs;测试注入失败臂=钉子⑤) */
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
    // 复用既有原子写(临时文件+rename);失败 throw 由上层静默降级
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
 * discovery 载荷序列化投影:剔除 semantics.local.document(DefDocument XML
 * 原树——环源 children 互指+缓存体积大头),恢复侧由 rootName 重建最小占位
 * document。document 面在 EntityMappingIndex 消费面仅一处
 * (messageTableEngine 读 root?.name),占位保该面行为等价;getAllMappings
 * 投影不含 semantics,等价断言面不受影响。若未来出现新的 document 深消费,
 * 该占位会如实暴露为空面——不静默给陈旧数据。
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
 * 读缓存:meta 版本门(schema/kode 任一不符 → null 整体弃用,钉子④)→
 * 产物逐件 sha 校验(不匹配 → 该产物缺席,调用方照旧全扫该侧)。
 * meta 缺失/损坏 → null(等同未缓存)。
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
  if (meta.schemaVersion !== expected.schemaVersion || meta.kodeVersion !== expected.kodeVersion) {
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
 * 写缓存:产物先写、meta 后写(meta=提交点);任何失败静默降级返回 false
 * (钉子⑤:写失败不 crash,下次启动照旧全扫,日志归装配层)。
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
