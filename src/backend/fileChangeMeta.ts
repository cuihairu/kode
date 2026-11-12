/**
 * 文件变化元信息(方案 B):watcher 合并器只交付路径与盘上版本 token
 * (`SharedFileEvent.version`,见 src/sharedFileEvents.ts),本模块按
 * identity+version **懒**解析其余字段——缓存命中时同版本只读一次;换版本或
 * 缓存未命中(淘汰 / 失败重试 / 路径或 scriptRoot 变化)才重读,删除事件不读。
 *
 * 口径(实现必须逐条对齐 tests/fileChangeMeta.test.ts 的断言面):
 * - 字段面:fsPath/identity/kind/fileName/ext/module/package/process*
 *   /sha256/size/mtimeMs/version/reason;路径可解的字段恒给,读/stat 失败
 *   的字段如实缺省并带 reason,**绝不抛**(消费端常不 await)。
 * - 同口径模块名:module/package 是 Python 概念,**仅 .py(大小写不敏感,
 *   与 resolveModuleDualName 同源)才解析**,非 py(如 cell/Avatar.json)
 *   两字段恒缺省不外溢;py 内再复用 hotReloadTempEdit.resolveModuleDualName
 *   (书 §19.1 双名称规则),脚本根外/__init__/单层脚本一律缺省,不编造。
 * - hash:node:crypto createHash('sha256'),与 hotReloadDefHash/hotReload
 *   的 sentDigest 同一原语(不自创哈希、不换算法)。
 * - 版本键:事件带 version 就零 stat(size/mtime 从 token 解出);没带才由
 *   本模块 stat 一次取 `${mtimeMs}:${size}` 作键(删除事件无内容可核对,
 *   不 stat 不读)。
 * - hash 是**读取时点的内容快照**:事件带 version 时读发生在交付之后,
 *   两者之间若有并发写,sha256 可能对应比 version 更新的内容——为守住
 *   「带 version 零 stat」的契约,本模块**不**为核对再 stat 一次,只把这条
 *   边界如实写进字段契约(docs/design/file-change-meta.md §3):缓存项在且
 *   完整缓存键相同时,同 token 的内容变化不触发重读(不可见);缓存未命中时
 *   (例如淘汰、失败后重试,或路径、scriptRoot 变化),非删除事件仍可能重读
 *   文件;读取成功才会刷新快照。
 * - 记忆化:键 = identity + version + 路径形态(fsPath、scriptRoot),同键回
 *   同一对象(按 kind 各记一份派生对象:换 kind 只换字段、复制一次入册、
 *   不重读,换回来仍是同一对象),路径字段不因脚本根热切换过期;容量 LRU
 *   封顶(淘汰后后续非删除事件可能重读)。**失败态不入缓存**(避免把一次
 *   EACCES 钉死到该版本)。
 * - 进程归属:按 KBEngine 脚本目录约定从路径判,判不出返回 unresolved
 *   **不编造**;详见 resolveProcessKind 的注释与 docs/design/file-change-meta.md。
 * 纯逻辑 + 注入式 IO(缺省真 fs),无 vscode 依赖。
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resolveModuleDualName } from './hotReloadTempEdit';
import { normalizeFileIdentity } from './pathIdentity';
import type { SharedFileEvent, SharedFileEventKind } from './sharedFileEvents';

/** 进程归属结论:KBEngine 组件进程 / 共享 / 多段冲突(候选并列,不挑一个猜) */
export type FileChangeProcessKind =
  | 'baseapp'
  | 'cellapp'
  | 'loginapp'
  | 'interfaces'
  | 'logger'
  | 'shared'
  | 'ambiguous';

/** 归属来源:path=从脚本根相对路径解出;unresolved=判不出(不编造) */
export type FileChangeProcessSource = 'path' | 'unresolved';

/** 单文件变化元信息(懒解析产物;缺省字段=该事实不可得,不是空串占位) */
export interface FileChangeMeta {
  /** 事件原样路径(消费端按自身键规则使用) */
  readonly fsPath: string;
  /** 归一身份键(与合并器同口径,normalizeFileIdentity) */
  readonly identity: string;
  readonly kind: SharedFileEventKind;
  /** 文件短名(basename):Avatar.py */
  readonly fileName: string;
  /** 扩展名含点:.py;无扩展为空串 */
  readonly ext: string;
  /** 脚本根相对全名模块(cell.Avatar);仅 .py(大小写不敏感)才解析,其余恒缺省 */
  readonly module?: string;
  /** 模块名首段(cell);随 module 同生同灭 */
  readonly package?: string;
  /** 进程归属结论;判不出即缺省(与 processSource='unresolved' 成对) */
  readonly processKind?: FileChangeProcessKind;
  /** 归属来源:path / unresolved */
  readonly processSource: FileChangeProcessSource;
  /** 归属判定说明(共享、冲突、判不出时给;单一进程恒缺省) */
  readonly processReason?: string;
  /** 多进程段冲突时的候选(按路径出现序去重);其余情形缺省 */
  readonly processCandidates?: readonly string[];
  /** 内容 sha256 hex(64 位);delete 或读失败缺省 */
  readonly sha256?: string;
  /** 字节数;来自版本 token 或 stat,两者皆不可得则缺省 */
  readonly size?: number;
  /** 文件修改时间(ms);来源同 size */
  readonly mtimeMs?: number;
  /** 盘上版本 token(`${mtimeMs}:${size}`);事件未带且 stat 失败则缺省 */
  readonly version?: string;
  /** 部分字段不可得的原因(stat/读失败拼接);完整解析恒缺省 */
  readonly reason?: string;
}

/** 注入式 IO 与根路径取值口(scriptRoot/assetsRoot 每次取值,配置可热切换) */
export interface FileChangeMetaDeps {
  /** 脚本资源根(模块名与进程归属的解析起点) */
  readonly scriptRoot: () => string;
  /** 资产根(scriptRoot 空时兜底 `<assetsRoot>/scripts`) */
  readonly assetsRoot: () => string;
  /** 读文件内容(缺省真 fs.promises.readFile);返回 Buffer 供 sha256 */
  readonly readFile?: (file: string) => Promise<Buffer>;
  /** stat(缺省真 fs.promises.stat);只要 mtimeMs/size 两个字段 */
  readonly stat?: (file: string) => Promise<{ mtimeMs: number; size: number }>;
}

export interface FileChangeMetaResolver {
  /** 事件路径解析(与 metaForPath 同实现同缓存;消费端可不 await) */
  metaFor(event: SharedFileEvent): Promise<FileChangeMeta>;
  /** 手动路径解析(watcher 未启用/无事件时的同一张脸) */
  metaForPath(fsPath: string): Promise<FileChangeMeta>;
}

/** 脚本根一级/嵌套进程目录 → 组件进程(KBEngine 目录约定) */
const PROCESS_DIRS: Readonly<Record<string, FileChangeProcessKind>> = Object.freeze({
  base: 'baseapp',
  cell: 'cellapp',
  login: 'loginapp',
  interfaces: 'interfaces',
  logger: 'logger'
});

/** 共享脚本目录(不指认单一进程) */
const SHARED_DIRS: ReadonlySet<string> = new Set(['common', 'user']);

const toPosix = (value: string): string => value.replace(/\\/g, '/');

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

/** 错误 → 可读原因(只取 message,不吞类型信息) */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 版本 token(`${mtimeMs}:${size}`)解析。token 形状不符(如测试里的 'v1')
 * → 两个字段都缺省,**不回头 stat**(事件已带 version 即视为解析端零 stat)。
 */
const parseVersionToken = (token: string): { size?: number; mtimeMs?: number } => {
  // mtimeMs 可能带小数(fs.stat 的浮点毫秒),token 形状 = `<mtimeMs>:<size>`
  const match = /^(\d+(?:\.\d+)?):(\d+)$/.exec(token);
  if (!match) {
    return {};
  }
  return { mtimeMs: Number(match[1]), size: Number(match[2]) };
};

/**
 * 进程归属(按 KBEngine 脚本目录约定,判不出不编造):
 * - 必须落在脚本根内(资产根的 res/ 等非脚本区一律 unresolved);
 * - 逐段扫脚本根相对目录:`base/cell/login/logger` 任意层级都算进程段,
 *   `interfaces` 只在**一级目录**算进程段(嵌套的 base/interfaces/ 是外层
 *   进程的接口包,归外层进程,不与外层冲突);
 * - 命中 0 个:目录里有 common/user → shared(带理由,不指认单一进程);
 *   否则 unresolved(reason='unresolved');
 * - 命中 ≥2 个不同进程段(异常布局,如 base/cell)→ ambiguous + 候选数组,
 *   按路径出现序去重,**不挑一个猜**;
 * - 命中 1 个 → 该进程,source='path'(归属理由恒缺省)。
 */
const resolveProcessKind = (
  scriptRoot: string,
  fsPath: string
): Pick<FileChangeMeta, 'processKind' | 'processSource' | 'processReason' | 'processCandidates'> => {
  // 根与文件走同一把身份键(normalizeFileIdentity):斜杠/点段归一 + Windows
  // 盘符与 UNC 小写化——根不归一就会出现 `C:\Proj\Scripts` 对不上
  // `c:/proj/scripts/...` 的假 unresolved。`/` 根特判(归一后只剩一个斜杠,
  // trim 会吃成空串)。
  const identityRoot = normalizeFileIdentity(scriptRoot);
  const root = trimTrailingSlashes(identityRoot) || (identityRoot === '/' ? '/' : '');
  const identity = normalizeFileIdentity(fsPath);
  const insideRoot =
    root === '/'
      ? identity.startsWith('/')
      : root.length > 0 && (identity === root || identity.startsWith(`${root}/`));
  if (!insideRoot) {
    return { processSource: 'unresolved', processReason: 'unresolved' };
  }
  const relative = root === '/' ? identity.slice(1) : identity.slice(root.length + 1);
  const segments = relative.split('/').filter(segment => segment.length > 0);
  // 至少「一个目录 + 文件名」才谈得上归属;脚本根单层文件判不出
  if (segments.length < 2) {
    return { processSource: 'unresolved', processReason: 'unresolved' };
  }
  const directories = segments.slice(0, -1);
  if (directories.some(segment => segment === '.' || segment === '..')) {
    return { processSource: 'unresolved', processReason: 'unresolved' };
  }
  const markers: FileChangeProcessKind[] = [];
  directories.forEach((directory, index) => {
    if (directory === 'interfaces') {
      if (index === 0) {
        markers.push('interfaces');
      }
      return;
    }
    const kind = PROCESS_DIRS[directory];
    if (kind) {
      markers.push(kind);
    }
  });
  if (markers.length === 0) {
    if (directories.some(directory => SHARED_DIRS.has(directory))) {
      return {
        processKind: 'shared',
        processSource: 'path',
        processReason: '共享脚本(common/user):不指认单一进程'
      };
    }
    return { processSource: 'unresolved', processReason: 'unresolved' };
  }
  const candidates = [...new Set(markers)];
  if (candidates.length > 1) {
    return {
      processKind: 'ambiguous',
      processSource: 'path',
      processCandidates: candidates,
      processReason: `多个进程段冲突:${candidates.join('|')}`
    };
  }
  return { processKind: candidates[0], processSource: 'path' };
};

/**
 * 单行格式化(热更审计与索引日志共用一式):
 * `Avatar.py kind=change ext=.py module=cell.Avatar package=cell process=cellapp
 *  sha256=abcd1234ef0… version=1700000000000:19 [reason=…]`
 * 判不出的进程显式写 unresolved;hash 只露前 12 位 + 省略号;reason 只在
 * 有失败时出现(成功行不带 reason=)。
 */
export function formatFileChangeMeta(meta: FileChangeMeta): string {
  const parts: string[] = [
    meta.fileName,
    `kind=${meta.kind}`,
    `ext=${meta.ext}`,
    `module=${meta.module ?? '-'}`,
    `package=${meta.package ?? '-'}`,
    `process=${meta.processKind ?? 'unresolved'}`
  ];
  if (meta.processKind === 'ambiguous' && meta.processCandidates) {
    parts.push(`candidates=${meta.processCandidates.join('|')}`);
  }
  parts.push(`sha256=${meta.sha256 ? `${meta.sha256.slice(0, 12)}…` : '-'}`);
  parts.push(`version=${meta.version ?? '-'}`);
  // 失败原因与归属说明分词呈现:成功行绝不出现 reason=(断言面)
  if (meta.reason !== undefined) {
    parts.push(`reason=${meta.reason}`);
  } else if (meta.processReason !== undefined) {
    parts.push(`note=${meta.processReason}`);
  }
  return parts.join(' ');
}

/**
 * 建解析器:每实例一份 identity+version 缓存(实例间互不串线,测试靠两个
 * 实例各自算出来证明「不是共享单例」)。IO 与根路径全部经 deps 注入。
 */
export function createFileChangeMetaResolver(deps: FileChangeMetaDeps): FileChangeMetaResolver {
  const readFile =
    deps.readFile ?? ((file: string): Promise<Buffer> => fs.promises.readFile(file));
  const stat =
    deps.stat ??
    (async (file: string): Promise<{ mtimeMs: number; size: number }> => {
      const stats = await fs.promises.stat(file);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    });
  /** 脚本根取值:配置优先,空则按资产根约定 `<assets>/scripts` 兜底 */
  const effectiveScriptRoot = (): string => {
    const configured = (deps.scriptRoot() ?? '').trim();
    if (configured.length > 0) {
      return configured;
    }
    const assets = trimTrailingSlashes(toPosix((deps.assetsRoot() ?? '').trim()));
    return assets.length > 0 ? `${assets}/scripts` : '';
  };

  // 缓存:键 → {首算 promise, 按 kind 复用的派生对象}(存 promise,并发首算
  // 也只读一次)。按 kind 记派生对象:同键同 kind 恒回同一对象(跨 kind 只换
  // kind 字段、不重读,且换过一次之后再换回来仍是同一个对象)。
  // 容量封顶(LRU):长会话里每次保存都是新版本键,不封顶会无限涨。
  const CACHE_LIMIT = 512;
  interface CacheEntry {
    readonly resolved: Promise<FileChangeMeta>;
    readonly variants: Map<SharedFileEventKind, FileChangeMeta>;
  }
  const cache = new Map<string, CacheEntry>();

  const reinsert = (key: string, value: CacheEntry): void => {
    cache.delete(key);
    cache.set(key, value);
  };

  /** 入键并按 LRU 淘汰最久未用(在途与已算好的一视同仁;淘汰只影响后续命中) */
  const remember = (key: string, value: CacheEntry): void => {
    reinsert(key, value);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  };

  /** 只摘自己那条失败记录:键可能已被后续请求覆盖,不能连带删掉新的 */
  const dropIfCurrent = (key: string, value: CacheEntry): void => {
    if (cache.get(key) === value) {
      cache.delete(key);
    }
  };

  /**
   * 按 kind 取派生对象:首算对象按其自身 kind 入册,其余 kind 冻结复制一次
   * 后入册——同键同 kind 之后每次回同一对象(toBe 契约),复制不重读盘。
   */
  const variantOf = (entry: CacheEntry, kind: SharedFileEventKind): Promise<FileChangeMeta> =>
    entry.resolved.then(meta => {
      const existing = entry.variants.get(kind);
      if (existing) {
        return existing;
      }
      const derived = meta.kind === kind ? meta : Object.freeze({ ...meta, kind });
      entry.variants.set(kind, derived);
      return derived;
    });

  const metaFor = async (event: SharedFileEvent): Promise<FileChangeMeta> => {
    const fsPath = event.fsPath;
    const identity = event.identity ?? normalizeFileIdentity(fsPath);
    const scriptRoot = effectiveScriptRoot();
    const isDelete = event.kind === 'delete';

    // 1) 版本键:事件带 version → 零 stat(size/mtime 从 token 解出);
    //    删除 → 不 stat 不读(无内容可核对);其余 → stat 一次取键。
    //    stat 失败只记 reason,不抛、也不入缓存(失败态不钉死到该键)。
    let version = event.version;
    let size: number | undefined;
    let mtimeMs: number | undefined;
    let statReason: string | undefined;
    if (version !== undefined) {
      const parsed = parseVersionToken(version);
      size = parsed.size;
      mtimeMs = parsed.mtimeMs;
    } else if (!isDelete) {
      try {
        const stats = await stat(fsPath);
        version = `${stats.mtimeMs}:${stats.size}`;
        size = stats.size;
        mtimeMs = stats.mtimeMs;
      } catch (error) {
        statReason = messageOf(error);
      }
    }

    const build = (): Promise<FileChangeMeta> => {
      const posixPath = toPosix(fsPath);
      const fileName = posixPath.slice(posixPath.lastIndexOf('/') + 1);
      // module/package 是 Python 概念:仅 .py(仓内口径大小写不敏感,与
      // resolveModuleDualName 同源)才解析;非 py(如 cell/Avatar.json)两字段
      // 恒缺省——本模块自守这条边界,不依赖双名称解析器的内部拒绝。
      const isPythonSource = fileName.toLowerCase().endsWith('.py');
      const dual = isPythonSource
        ? resolveModuleDualName(fsPath, scriptRoot)
        : ({ unsupported: `非 .py 文件不解析模块名: ${posixPath}` } as const);
      const moduleName = 'fullModule' in dual ? dual.fullModule : undefined;
      const processVerdict = resolveProcessKind(scriptRoot, fsPath);
      const compute = async (): Promise<FileChangeMeta> => {
        const reasons: string[] = statReason !== undefined ? [statReason] : [];
        let sha256: string | undefined;
        if (!isDelete) {
          // delete 无内容可读:省略 sha256 不是失败(读失败才进 reasons)
          try {
            const content = await readFile(fsPath);
            sha256 = createHash('sha256').update(content).digest('hex');
          } catch (error) {
            reasons.push(messageOf(error));
          }
        }
        return Object.freeze({
          fsPath,
          identity,
          kind: event.kind,
          fileName,
          ext: path.posix.extname(fileName),
          module: moduleName,
          // 顶层模块(无 '.')没有包名:cell/Avatar.py 剥掉进程角色目录后模块名
          // 就是 Avatar,split('.')[0] 会把模块名自己当包名(错)。
          package:
            moduleName !== undefined && moduleName.includes('.')
              ? moduleName.split('.')[0]
              : undefined,
          ...processVerdict,
          sha256,
          size,
          mtimeMs,
          version,
          reason: reasons.length > 0 ? reasons.join('; ') : undefined
        });
      };
      return compute();
    };

    // 2) 记忆化:并发首算也只读一次。键 = identity + version + 路径形态
    //    (fsPath、scriptRoot)——内容按 version 去重的同时,路径字段
    //    (module/package/process)不因脚本根配置热切换或别名路径而过期:
    //    换根/换写法即重算(低频事件,重读一次可接受),同根同版本仍是同一对象。
    const isCacheable = version !== undefined && !isDelete;
    if (!isCacheable) {
      return build();
    }
    const key = `${identity}|${version}|${fsPath}|${scriptRoot}`;
    const cached = cache.get(key);
    if (cached) {
      reinsert(key, cached); // LRU:命中提到队尾
      return variantOf(cached, event.kind);
    }
    const entry: CacheEntry = { resolved: build(), variants: new Map() };
    remember(key, entry);
    void entry.resolved.then(
      meta => {
        if (meta.reason !== undefined) {
          dropIfCurrent(key, entry); // 失败态不缓存:后续非删除事件可能再读
        }
      },
      () => dropIfCurrent(key, entry)
    );
    return variantOf(entry, event.kind);
  };

  return {
    metaFor,
    metaForPath(fsPath: string): Promise<FileChangeMeta> {
      return metaFor({ fsPath, identity: normalizeFileIdentity(fsPath), kind: 'change' });
    }
  };
}
