import * as vscode from 'vscode';

import type { KodeCoreGate } from './kodeCoreGate';
import { findFilesAcrossRoots } from './scanRoots';

// kode2 服务轨道语料镜像(2026-11-08 用户令「直接切到 rust」)。
// Rust 的语料环境(实体注册/自定义类型/别名/继承链)只由已镜像文档的
// didOpen 入库。若只镜像用户当前打开的文档,types.xml/entities.xml/
// alias.xml 与未打开的 def 在 Rust 侧缺席 → 补全的类型/实体/继承面不完整
// (值上下文甚至会回空项,比 TS 更差——发现问题即修)。本模块在服务轨道
// 生效时把工作区静态语料全量镜像给 Rust,给足与 TS 同一输入。尽力而为:
// 任何失败静默,不阻塞调用方,不误伤服务。

/** 语料发现 glob(def 全量 + 三类语料 XML;与 kode-server file_kind 口径同源) */
export const CORPUS_MIRROR_GLOBS = [
  '**/*.def',
  '**/types.xml',
  '**/entities.xml',
  '**/alias.xml',
];

/** 语料文档的 languageId(Rust 面分类:def → kbengine-def,语料 XML → xml) */
export function corpusMirrorLanguageId(fsPath: string): string {
  return fsPath.toLowerCase().endsWith('.def') ? 'kbengine-def' : 'xml';
}

/** 查找依赖(可注入替身;缺省走工作区真实发现) */
export type CorpusFileFinder = (
  glob: string,
  token?: vscode.CancellationToken
) => Promise<vscode.Uri[]>;

const defaultFinder: CorpusFileFinder = (glob, token) =>
  findFilesAcrossRoots(glob, null, token);

/**
 * 服务轨道语料全量镜像:枚举工作区语料文件,逐个 didOpen 给 Rust。已打开
 * 文档优先用编辑器内容(未保存修订不能被磁盘快照冲掉),未打开读盘。顺序
 * 镜像(1 路)规避并发 client.start() 的 initialize 握手竞态;didOpen 本身
 * 是 fire-and-forget 通知,无服务端回程。非服务轨道/未装配门零开销。
 */
export async function mirrorCorpusToRust(
  gate: KodeCoreGate,
  findFiles: CorpusFileFinder = defaultFinder
): Promise<void> {
  if (!gate.serveFromRust()) {
    return;
  }
  // 枚举 + 去重(同一文件可能被多个 glob 命中;路径为规范 fsPath)。
  const corpusUris = new Map<string, vscode.Uri>();
  for (const glob of CORPUS_MIRROR_GLOBS) {
    try {
      const found = await findFiles(glob);
      for (const uri of found) {
        corpusUris.set(uri.fsPath, uri);
      }
    } catch {
      // 单个 glob 发现失败按已得集合继续,不整体放弃。
    }
  }
  // 已打开的文档优先(未保存修订不能被磁盘快照冲掉)。
  const openByFsPath = new Map<string, vscode.TextDocument>();
  for (const doc of vscode.workspace.textDocuments) {
    openByFsPath.set(doc.uri.fsPath, doc);
  }
  for (const fsPath of corpusUris.keys()) {
    if (!gate.serveFromRust()) {
      // 镜像期间配置切走服务轨道(杀进程/回 ts):停止补镜像,不写新账。
      return;
    }
    const open = openByFsPath.get(fsPath);
    if (open) {
      await gate
        .mirrorDocument(fsPath, open.languageId, open.version, open.getText())
        .catch(() => undefined);
      continue;
    }
    let bytes: Uint8Array | null = null;
    try {
      bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      continue;
    }
    await gate
      .mirrorDocument(fsPath, corpusMirrorLanguageId(fsPath), 1, Buffer.from(bytes).toString('utf8'))
      .catch(() => undefined);
  }
}
