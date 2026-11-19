import * as vscode from 'vscode';

import { interactiveActivityBeacon } from './backend/indexScheduler';
import type { KodeCoreGate } from './backend/kodeCoreGate';
import { findFilesAcrossRoots, getIndexScanRoots } from './scanRoots';

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

/** 扫描根提供者(可注入替身;缺省走索引扫描根全集) */
export type ScanRootsProvider = () => string[];

const defaultScanRoots: ScanRootsProvider = () => getIndexScanRoots();

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
 * 分帧让路步长(RUST-TRACK-FREEZE-007 刀1):每镜像 N 个唯一文件让出扩展
 * 主线程一帧。数千 def/xml 的镜像洪水此前是连续 await 链,主线程被周期性
 * 抢占-让出-再抢占,观感=卡;分帧只插让路点,镜像总数与内容不变。
 */
export const MIRROR_YIELD_EVERY = 8;

/** 交互冷却窗(与 indexScheduler DEFAULT_INTERACTIVE_COOLDOWN_MS 同值,单一口径) */
const MIRROR_INTERACTIVE_COOLDOWN_MS = 50;

/** 让路一帧(可注入替身;测试断言让路点)。 */
export type MirrorYieldFn = () => Promise<void>;

/**
 * 缺省让路:调度器交互冷却窗内(用户刚有交互任务)先等出窗,再让出一帧
 * setImmediate——镜像洪水对交互让路,复用 indexScheduler 的冷却口径
 * (interactiveActivityBeacon 同一时钟),不另造判定。
 */
const defaultMirrorYield: MirrorYieldFn = async () => {
  const since = performance.now() - interactiveActivityBeacon.lastAt;
  const wait = MIRROR_INTERACTIVE_COOLDOWN_MS - since;
  if (wait > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, wait));
  }
  await new Promise<void>(resolve => setImmediate(resolve));
};

/**
 * 服务轨道语料全量镜像:枚举工作区语料文件,逐个 didOpen 给 Rust。已打开
 * 文档优先用编辑器内容(未保存修订不能被磁盘快照冲掉),未打开读盘。顺序
 * 镜像(1 路)规避并发 client.start() 的 initialize 握手竞态;didOpen 本身
 * 是 fire-and-forget 通知,无服务端回程。非服务轨道/未装配门零开销。
 */
export async function mirrorCorpusToRust(
  gate: KodeCoreGate,
  findFiles: CorpusFileFinder = defaultFinder,
  scanRoots: ScanRootsProvider = defaultScanRoots,
  yieldFrame: MirrorYieldFn = defaultMirrorYield
): Promise<void> {
  if (!gate.serveFromRust()) {
    return;
  }
  // RUST-069-W:根生命周期先行——语料 didOpen 的根归属(server 侧
  // root_for 最长前缀)依赖根已注册;外部 assetsRoot 根不在 initialize
  // 握手里,不先注册则外部根语料落 UNROOTED(与 workspace 根互不隔离)。
  let roots: string[] = [];
  try {
    roots = scanRoots();
  } catch {
    roots = [];
  }
  for (const root of roots) {
    await gate.registerRoot(root).catch(() => undefined);
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
  // RUST-125:初扫优先级——已打开的语料文档排前镜像(「当前打开文件优先
  // warm」的镜像顺序面:交互文件首个就绪;其余文件保持发现序)。非语料
  // 打开文档不进镜像流,打开集合中不在发现结果的条目自然缺席。
  const mirrorOrder: string[] = [
    ...vscode.workspace.textDocuments
      .map(doc => doc.uri.fsPath)
      .filter(fsPath => corpusUris.has(fsPath)),
    ...corpusUris.keys()
  ];
  // RUST-074-W:暖门接线——本镜像全程即生产首扫。begin 入队(Warming),
  // 完成泵至 Warm,中断 cancel(不留假 pending)。尽力而为:失败静默,
  // 不阻塞镜像本体;Warming 期真实 RPC 照常(server 池交互优先级)。
  let mirrored = 0;
  let failed = 0;
  await gate.beginBackgroundScan(corpusUris.size).catch(() => undefined);
  // 顺序去重(打开文档在 keys 集合中,前段已镜像后段跳过)。
  const seenFsPaths = new Set<string>();
  for (const fsPath of mirrorOrder) {
    if (seenFsPaths.has(fsPath)) {
      continue;
    }
    seenFsPaths.add(fsPath);
    const completed = mirrored + failed;
    if (completed > 0 && completed % MIRROR_YIELD_EVERY === 0) {
      // RUST-TRACK-FREEZE-007 刀1:分帧让路——每完成 N 个文件让出主线程一帧
      // (交互冷却窗内多等一拍);切走服务轨道的检查在让路后照常。
      await yieldFrame();
    }
    if (!gate.serveFromRust()) {
      // 镜像期间配置切走服务轨道(杀进程/回 ts):取消首扫(回 Idle,
      // 不留假 pending),停止补镜像,不写新账。
      await gate.scanCancel().catch(() => undefined);
      return;
    }
    const open = openByFsPath.get(fsPath);
    if (open) {
      try {
        await gate.mirrorDocument(fsPath, open.languageId, open.version, open.getText());
        mirrored += 1;
      } catch {
        failed += 1;
      }
      continue;
    }
    let bytes: Uint8Array | null = null;
    try {
      bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      failed += 1;
      continue;
    }
    try {
      await gate.mirrorDocument(
        fsPath,
        corpusMirrorLanguageId(fsPath),
        1,
        Buffer.from(bytes).toString('utf8')
      );
      mirrored += 1;
    } catch {
      failed += 1;
    }
  }
  await gate.scanComplete(mirrored, failed).catch(() => undefined);
}
