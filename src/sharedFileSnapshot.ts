// 共享文件快照读取接口(IDE-SNP-001,事实源 docs/kode2 设计账本 IDX-07):
// 语义 loader / 数据库 schema / 类型注册表等派生输入的统一文件读取面——
// 「打开文档优先,未打开文件从磁盘补载,不要求打开其他文档」。
//
// 契约(后续 SNP-002..010 在此之上迁移):
// - 打开文档(vscode.workspace.textDocuments 中在位者)是文本事实源:
//   content=缓冲区全文、version=编辑序号,读取绝不落盘(磁盘旧内容没有
//   路径覆盖编辑中的缓冲区,与 documentStore 同一构造性保证);
// - 未打开文件读磁盘(utf8),version=stat 的 mtimeMs——磁盘版本身份与
//   文档版本身份两个域由 source 字段区分,不做跨域比较;
// - 接口不提供打开其他文档的能力(无 openTextDocument 依赖面),读取
//   副作用只有 listOpenDocuments 与至多一次 readDiskFile/statDiskFile;
// - rootId 由根解析器注入(生产=SemanticIndex.resolveRootIdForPath,
//   显式登记序),未登记根下为 null,由调用方裁断是否接受。
//
// 同步读取:与 definitionWorkspace/databaseSchema 既有同步读盘调用链同形,
// 消费端迁移不必改异步签名。

import * as fs from 'fs';
import * as vscode from 'vscode';
import { readFileUtf8Recorded, readFileSyncUtf8Recorded } from './backend/fileReadMetrics';
import { normalizeDocumentKey } from './backend/documentStore';
import { normalizeFileIdentity } from './backend/pathIdentity';
import { getSemanticIndex } from './backend/semanticIndex';

/** 打开文档输入面:vscode.TextDocument 与测试替身的公共子集(同 documentStore) */
export interface SharedFileSnapshotDocument {
  uri: { toString(): string; fsPath: string };
  /** 编辑序号;替身可能没有 → undefined */
  version?: number;
  getText(): string;
}

export interface SharedFileSnapshotDeps {
  /** 打开文档清单(生产=vscode.workspace.textDocuments) */
  listOpenDocuments(): readonly SharedFileSnapshotDocument[];
  /** 磁盘文本读取;不存在/不可读返回 null */
  readDiskFile(fsPath: string): string | null;
  /** 磁盘指纹(mtimeMs);不可 stat 返回 null */
  statDiskFile(fsPath: string): { mtimeMs: number } | null;
  /** 文件归属根(rootId);未登记返回 null */
  resolveRootId(fsPath: string): string | null;
}

export interface SharedFileSnapshot {
  /** 归属根 ID(规范化根路径);未登记根下为 null */
  readonly rootId: string | null;
  /** 规范化身份键(与 documentStore 同一归一口径) */
  readonly uri: string;
  /** 平台路径(文档在位时取文档自身拼写) */
  readonly fsPath: string;
  /** 文档=编辑序号(替身可 undefined);磁盘=mtimeMs */
  readonly version: number | undefined;
  readonly content: string;
  /** document=编辑器缓冲区;disk=磁盘补载 */
  readonly source: 'document' | 'disk';
}

/**
 * IDE-SNP-006:快照输入版本引用(来源域+版本对)——派生结果记录所消费
 * 文件的 {source, version},消费端再读同文件比对,任一漂移即可判过期。
 */
export interface SharedFileVersionRef {
  readonly source: 'document' | 'disk';
  readonly version: number | undefined;
}

const defaultDeps: SharedFileSnapshotDeps = {
  listOpenDocuments: () => vscode.workspace.textDocuments,
  // IDE-MET-004:共享快照层是语义输入(types.xml/alias.xml/loader/schema)
  // 的统一磁盘补载口,读盘在此记账;失败(null)不记账。
  readDiskFile: fsPath => {
    try {
      return readFileSyncUtf8Recorded(fsPath);
    } catch {
      return null;
    }
  },
  statDiskFile: fsPath => {
    try {
      return fs.statSync(fsPath);
    } catch {
      return null;
    }
  },
  resolveRootId: fsPath => getSemanticIndex().resolveRootIdForPath(fsPath)
};

/**
 * IDE-NAV-004:打开文档文本清单(缓冲区全文,不含磁盘补载)——批量扫描面
 * (引用收录遍历整索引的文件集)一次取,免逐文件快照把磁盘补载放大成
 * 全量读盘。读取副作用只有 listOpenDocuments。
 */
export interface OpenDocumentText {
  fsPath: string;
  content: string;
}

export function collectOpenDocumentTexts(
  deps: SharedFileSnapshotDeps = defaultDeps
): OpenDocumentText[] {
  return deps.listOpenDocuments().map(document => ({
    fsPath: document.uri.fsPath,
    content: document.getText()
  }));
}

/**
 * RUST-003:轻量身份探针——只取 {source,version} 身份对,不读文件内容。
 * 打开文档=document:version(缓冲区编辑序号,零 IO);未打开=disk:mtimeMs
 * (一次 stat);双侧皆无(未打开且 stat 失败)返回 null。身份口径与
 * readSharedFileSnapshot 完全同源(同一 deps/归一键)——语义 loader 缓存
 * 用它做键内身份:身份漂移即重解析,不需要失效调用也结构性地吃不到旧值。
 */
export function readSharedFileSnapshotIdentity(
  fsPath: string,
  deps: SharedFileSnapshotDeps = defaultDeps
): SharedFileVersionRef | null {
  const identity = normalizeFileIdentity(fsPath);
  for (const document of deps.listOpenDocuments()) {
    if (normalizeDocumentKey(document.uri) !== identity) {
      continue;
    }
    return {
      source: 'document',
      version: typeof document.version === 'number' && Number.isFinite(document.version)
        ? document.version
        : undefined
    };
  }
  const stat = deps.statDiskFile(fsPath);
  if (stat === null) {
    return null;
  }
  return { source: 'disk', version: stat.mtimeMs };
}

/**
 * 读共享文件快照:打开文档优先(缓冲区全文+编辑序号),未打开文件磁盘补载
 * (utf8 文本+mtimeMs),双侧皆无返回 null。读取不打开任何文档。
 */
export function readSharedFileSnapshot(
  fsPath: string,
  deps: SharedFileSnapshotDeps = defaultDeps
): SharedFileSnapshot | null {
  const identity = normalizeFileIdentity(fsPath);
  for (const document of deps.listOpenDocuments()) {
    if (normalizeDocumentKey(document.uri) !== identity) {
      continue;
    }
    return {
      rootId: deps.resolveRootId(document.uri.fsPath),
      uri: identity,
      fsPath: document.uri.fsPath,
      version: typeof document.version === 'number' && Number.isFinite(document.version)
        ? document.version
        : undefined,
      content: document.getText(),
      source: 'document'
    };
  }
  const content = deps.readDiskFile(fsPath);
  if (content === null) {
    return null;
  }
  return {
    rootId: deps.resolveRootId(fsPath),
    uri: identity,
    fsPath,
    version: deps.statDiskFile(fsPath)?.mtimeMs,
    content,
    source: 'disk'
  };
}

/**
 * RUST-001:异步快照读(与 readSharedFileSnapshot 同一契约,磁盘补载改
 * fs.promises)。供**语料级**命令面用——def md5 收集按 entity_defs 全量
 * 逐文件补载,同步版本在该循环里把整仓 def 载入压成一个阻塞段;异步版
 * 让循环在每个文件之间让出宿主事件循环。缓冲区优先语义不变(打开文档
 * 零 IO),磁盘版本文本经 readFileUtf8Recorded(与同步入口同记账口径)。
 * 单文件交互链(hover/schema/loader)继续用同步版本,本变体只服务命令期
 * 语料面,不改变既有同步消费端。
 */
export async function readSharedFileSnapshotAsync(
  fsPath: string
): Promise<SharedFileSnapshot | null> {
  const identity = normalizeFileIdentity(fsPath);
  for (const document of defaultDeps.listOpenDocuments()) {
    if (normalizeDocumentKey(document.uri) !== identity) {
      continue;
    }
    return {
      rootId: defaultDeps.resolveRootId(document.uri.fsPath),
      uri: identity,
      fsPath: document.uri.fsPath,
      version: typeof document.version === 'number' && Number.isFinite(document.version)
        ? document.version
        : undefined,
      content: document.getText(),
      source: 'document'
    };
  }
  let content: string;
  try {
    content = await readFileUtf8Recorded(fsPath);
  } catch {
    return null;
  }
  return {
    rootId: defaultDeps.resolveRootId(fsPath),
    uri: identity,
    fsPath,
    version: defaultDeps.statDiskFile(fsPath)?.mtimeMs,
    content,
    source: 'disk'
  };
}
