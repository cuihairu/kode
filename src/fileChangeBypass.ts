import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeFileIdentity } from './backend/pathIdentity';
import { fileVersionTokenFromStats } from './sharedFileEvents';

// 非 py 文件变化的旁路通道(设计文档 §11.2/§11.3)。
//
// 事件源唯一(vscode watcher + sharedFileEvents 的 30ms 合并/version token),
// 本模块只做三件事:把原始事件补成**纯数据**元信息、按消费者注册表路由、
// 为 rust 消费者拼 `$/kode/fileChanged` 通知帧体。
//
// 红线:
// - 事件结构不绑 vscode(零 `vscode` 引用):将来 watch 下沉 rust 时 TS 只是
//   消费者,协议逐字不变;
// - 默认无消费者 = 只记录不处理,不投递、不发帧、不改热更状态栏;
// - rust 不可用/未启动 → 静默降级,绝不阻塞热更(投递异常在路由内收口)。

/** 文件事件种类(与 sharedFileEvents 同名同义) */
export type FileChangeKind = 'create' | 'change' | 'delete';

/**
 * 处理归属:该变化最终由谁处理——`python` = 命中 python 消费者;`rust` = 命中
 * rust 消费者(发通知帧);`unrouted` = 无消费者命中(只记录)。消费者逐个投递时
 * 按**自己**的 kind 盖章,订阅者看到的是首个命中者(无命中 = unrouted)。
 *
 * 与 `src/fileChangeMeta.ts` 的 `processKind` **刻意不同名**:那个字段回答
 * 「这个脚本归哪个 KBEngine 进程」(baseapp/cellapp/…/ambiguous),本字段回答
 * 「这次变化由谁处理」;两者同名会把消费端的匹配悄悄引到错的值域。
 */
export type FileChangeHandledBy = 'python' | 'rust' | 'unrouted';

/** 旁路事件(纯数据载荷;可直接 JSON 序列化进 LSP 通知帧) */
export interface NonPythonChangeEvent {
  /** 原样路径(消费端按自身键规则使用) */
  readonly fsPath: string;
  /** 归一身份键(normalizeFileIdentity,与 sharedFileEvents 合并口径同源) */
  readonly identity: string;
  readonly kind: FileChangeKind;
  /** 盘上版本 token `${mtimeMs}:${size}`(KR-AUD-30 口径);stat 不可得为 undefined */
  readonly version: string | undefined;
  readonly fileName: string;
  /** 小写含点扩展名(`.def`);无扩展名为空串 */
  readonly ext: string;
  /** 内容 sha256 hex(发送/解析对账基准);删除或读不到为 undefined,不编造 */
  readonly sha256: string | undefined;
  readonly handledBy: FileChangeHandledBy;
}

/** 旁路事件订阅者(公共扩展口:观察者只读,不参与投递决策) */
export type NonPythonChangeSubscriber = (event: NonPythonChangeEvent) => void;

/**
 * 通知 rust 的 LSP 方法名(现有 stdio 通道上的一个通知帧,**不改请求/响应语义**;
 * 服务器按 LSP 规范对未知通知静默丢弃,故 rust 侧未实现时零副作用)。
 * 与 `crates/kode-protocol` 的 `FILE_CHANGED_NOTIFICATION` 逐字互证(跨语言对账锁)。
 */
export const KODE_FILE_CHANGED_METHOD = '$/kode/fileChanged';

/** 消费者:按扩展名/路径前缀命中;两者都缺省 = 不参与路由(禁误全量广播) */
export interface FileChangeConsumer {
  readonly id: string;
  readonly kind: Exclude<FileChangeHandledBy, 'unrouted'>;
  /** 扩展名选择器(小写含点,如 `.def`);大小写不敏感 */
  readonly extensions?: readonly string[];
  /** 路径前缀选择器(绝对路径前缀,如 `<assetsRoot>/entity_defs`) */
  readonly pathPrefixes?: readonly string[];
  /** 命中投递(异常由路由收口,绝不外抛阻塞热更) */
  deliver(event: NonPythonChangeEvent): void;
}

export interface FileChangeRouter {
  /** 注册消费者,返回退订口 */
  register(consumer: FileChangeConsumer): { dispose(): void };
  /** 订阅旁路事件(公共接口),返回退订口 */
  subscribe(handler: NonPythonChangeSubscriber): { dispose(): void };
  /**
   * 路由 + 广播:逐消费者按命中 kind 盖章投递,再广播给订阅者(无消费者命中
   * 时订阅者看到 `unrouted`),返回命中的消费者(空数组 = 无消费者,调用方
   * 如实记日志,不投递不发帧)。
   */
  publish(event: NonPythonChangeEvent): FileChangeConsumer[];
  /** 当前注册的消费者(测试/诊断读口) */
  consumers(): readonly FileChangeConsumer[];
}

const matches = (event: NonPythonChangeEvent, consumer: FileChangeConsumer): boolean => {
  const extensions = consumer.extensions ?? [];
  const prefixes = consumer.pathPrefixes ?? [];
  if (extensions.length === 0 && prefixes.length === 0) {
    return false; // 没有任何选择器:不参与路由,避免「注册即全量广播」
  }
  const ext = event.ext.toLowerCase();
  return extensions.some(candidate => candidate.toLowerCase() === ext) ||
    prefixes.some(prefix => event.fsPath.startsWith(prefix));
};

export function createFileChangeRouter(): FileChangeRouter {
  const consumers = new Set<FileChangeConsumer>();
  const subscribers = new Set<NonPythonChangeSubscriber>();
  return {
    register(consumer: FileChangeConsumer): { dispose(): void } {
      consumers.add(consumer);
      return { dispose: (): void => void consumers.delete(consumer) };
    },
    subscribe(handler: NonPythonChangeSubscriber): { dispose(): void } {
      subscribers.add(handler);
      return { dispose: (): void => void subscribers.delete(handler) };
    },
    publish(event: NonPythonChangeEvent): FileChangeConsumer[] {
      const hits = [...consumers].filter(consumer => matches(event, consumer));
      for (const consumer of hits) {
        try {
          consumer.deliver({ ...event, handledBy: consumer.kind });
        } catch {
          // rust 不可用/投递口异常:静默降级,不报错不阻塞热更与后续订阅者
        }
      }
      const observed: NonPythonChangeEvent = {
        ...event,
        handledBy: hits[0]?.kind ?? 'unrouted'
      };
      for (const handler of [...subscribers]) {
        try {
          handler(observed);
        } catch {
          // 订阅者异常同样收口:观察面不能制造未处理异常
        }
      }
      return hits;
    },
    consumers(): readonly FileChangeConsumer[] {
      return [...consumers];
    }
  };
}

/**
 * 原始事件 → 纯数据元信息。`.py` 恒返回 null(热更自己的事,绝不进旁路);
 * 目录/非常规文件、以及 stat/read 失败的字段如实落 undefined,不编造。
 */
export async function buildNonPythonChangeEvent(input: {
  readonly fsPath: string;
  readonly kind: FileChangeKind;
}): Promise<NonPythonChangeEvent | null> {
  const ext = path.extname(input.fsPath).toLowerCase();
  if (ext === '.py') {
    return null;
  }
  let stats: fs.Stats | undefined;
  try {
    stats = await fs.promises.stat(input.fsPath);
  } catch {
    stats = undefined; // 删除后/从未落盘:版本与内容如实缺省
  }
  if (stats !== undefined && !stats.isFile()) {
    return null; // 目录等非常规文件不是内容事件
  }
  let sha256: string | undefined;
  if (input.kind !== 'delete') {
    try {
      sha256 = createHash('sha256').update(await fs.promises.readFile(input.fsPath)).digest('hex');
    } catch {
      sha256 = undefined;
    }
  }
  return {
    fsPath: input.fsPath,
    identity: normalizeFileIdentity(input.fsPath),
    kind: input.kind,
    version: stats === undefined ? undefined : fileVersionTokenFromStats(stats),
    fileName: path.basename(input.fsPath),
    ext,
    sha256,
    handledBy: 'unrouted'
  };
}

/** `$/kode/fileChanged` 帧体:与事件同构的纯数据拷贝(帧体契约只在这一处) */
export function fileChangedNotificationParams(event: NonPythonChangeEvent): NonPythonChangeEvent {
  return { ...event };
}

/**
 * rust 消费者工厂:命中即把帧体交给注入的投递口(现有 LSP stdio 的 notify)。
 * 未注入投递口 = rust 未接线 → 静默降级为只记录。
 */
export function rustFileChangeConsumer(options: {
  readonly id: string;
  readonly extensions?: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly notify?: (event: NonPythonChangeEvent) => void;
}): FileChangeConsumer {
  return {
    id: options.id,
    kind: 'rust',
    extensions: options.extensions,
    pathPrefixes: options.pathPrefixes,
    deliver(event: NonPythonChangeEvent): void {
      options.notify?.(fileChangedNotificationParams(event));
    }
  };
}

/**
 * 投递口(生产实现 = `KodeCoreGate.notifyFileChanged`):把帧体写上现有 LSP
 * stdio。返回 false = 没发出去(rust 进程未起/写失败),**由调用方静默降级**,
 * 不报错、不阻塞热更与其余订阅者。
 */
export interface FileChangedNotificationSink {
  notifyFileChanged(params: unknown): boolean;
}

/**
 * 注册 rust 消费者并接到投递口(§11.3 的生产接线,装配根/扩展 API 调用):
 * 按扩展名/路径前缀命中的变化 → `$/kode/fileChanged` 帧 → 现有 LSP stdio。
 * **默认不注册任何消费者**(设计 §11.2:无消费者 = 只记录不投递),注册即接通;
 * 返回退订口。
 */
export function registerRustFileChangeConsumer(
  router: FileChangeRouter,
  sink: FileChangedNotificationSink,
  selectors: {
    readonly id?: string;
    readonly extensions?: readonly string[];
    readonly pathPrefixes?: readonly string[];
  }
): { dispose(): void } {
  return router.register(
    rustFileChangeConsumer({
      id: selectors.id ?? 'rust',
      extensions: selectors.extensions,
      pathPrefixes: selectors.pathPrefixes,
      notify: event => void sink.notifyFileChanged(fileChangedNotificationParams(event))
    })
  );
}
