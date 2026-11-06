import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KODE_FILE_CHANGED_METHOD,
  buildNonPythonChangeEvent,
  createFileChangeRouter,
  fileChangedNotificationParams,
  rustFileChangeConsumer,
  type FileChangeConsumer,
  type NonPythonChangeEvent
} from '../src/fileChangeBypass';

// 非 py 文件变化的旁路通道(设计文档 §11.2/§11.3):
// ① 事件结构是纯数据(不绑 vscode)——将来 watch 下沉 rust 时 TS 只是消费者,
//    协议不变;
// ② 消费者注册表按扩展名/路径前缀路由,默认无消费者 = 只记录不处理;
// ③ 通知 rust 走现有 LSP stdio 的 `$/kode/fileChanged` 通知帧,按需投递
//    (只有注册了 rust 消费者的扩展名才发),rust 不可用/未启动静默降级。

const repoRoot = path.join(__dirname, '..');
const readRepo = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

let tmpDir = '';

const writeFixture = (relative: string, content: string): string => {
  const target = path.join(tmpDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-bypass-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const eventOf = (overrides: Partial<NonPythonChangeEvent> = {}): NonPythonChangeEvent => ({
  fsPath: '/ws/assets/res/types.xml',
  identity: '/ws/assets/res/types.xml',
  kind: 'change',
  version: '1730000000000:12',
  fileName: 'types.xml',
  ext: '.xml',
  sha256: 'a'.repeat(64),
  handledBy: 'unrouted',
  ...overrides
});

describe('旁路事件协议(纯数据,不绑 vscode)', () => {
  it('模块零 vscode 引用(将来 watch 下沉 rust,TS 转消费者)', () => {
    const source = readRepo('src/fileChangeBypass.ts');
    expect(source).not.toMatch(/from ['"]vscode['"]/);
    expect(source).not.toMatch(/require\(['"]vscode['"]\)/);
    expect(source).not.toContain('vscode.');
  });

  it('事件可由纯数据字面量构造(类型层不依赖 vscode 命名空间)', () => {
    const event: NonPythonChangeEvent = eventOf();
    expect(event).toMatchObject({
      fileName: 'types.xml',
      ext: '.xml',
      kind: 'change',
      handledBy: 'unrouted'
    });
    expect(Object.keys(event).sort()).toEqual(
      ['ext', 'fileName', 'fsPath', 'identity', 'kind', 'handledBy', 'sha256', 'version'].sort()
    );
  });

  it('`$/kode/fileChanged` 与 rust 协议常量互证(跨语言对账锁)', () => {
    expect(KODE_FILE_CHANGED_METHOD).toBe('$/kode/fileChanged');
    const rust = readRepo('crates/kode-protocol/src/lib.rs');
    expect(rust).toContain('"$/kode/fileChanged"');
    expect(rust).toContain('FileChangedParams');
    // TS 侧常量确实被发帧方使用(不是写死在别处的字面量)
    expect(readRepo('src/kodeCoreGate.ts')).toContain('KODE_FILE_CHANGED_METHOD');
  });
});

describe('buildNonPythonChangeEvent(元信息同一口径)', () => {
  it('非 py:fileName/ext/identity/kind/version/sha256/handledBy 齐全', async () => {
    const target = writeFixture('res/types.xml', '<root/>\n');
    const event = await buildNonPythonChangeEvent({ fsPath: target, kind: 'change' });
    expect(event).not.toBeNull();
    const stats = fs.statSync(target);
    expect(event).toMatchObject({
      fsPath: target,
      fileName: 'types.xml',
      ext: '.xml',
      kind: 'change',
      handledBy: 'unrouted',
      version: `${stats.mtimeMs}:${stats.size}`,
      sha256: createHash('sha256').update(Buffer.from('<root/>\n', 'utf8')).digest('hex')
    });
    expect(event!.identity).toContain('types.xml');
  });

  it('.py 永不进旁路(热更自己的事)', async () => {
    const target = writeFixture('scripts/base/Account.py', 'class Account: pass\n');
    expect(await buildNonPythonChangeEvent({ fsPath: target, kind: 'change' })).toBeNull();
    expect(await buildNonPythonChangeEvent({ fsPath: target, kind: 'create' })).toBeNull();
  });

  it('删除:内容与盘上版本都拿不到,如实 undefined 不编造', async () => {
    const target = path.join(tmpDir, 'res', 'gone.xml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const event = await buildNonPythonChangeEvent({ fsPath: target, kind: 'delete' });
    expect(event).toMatchObject({ kind: 'delete', sha256: undefined, version: undefined, ext: '.xml' });
  });

  it('目录不是文件事件(不进旁路)', async () => {
    const dir = path.join(tmpDir, 'res');
    fs.mkdirSync(dir, { recursive: true });
    expect(await buildNonPythonChangeEvent({ fsPath: dir, kind: 'create' })).toBeNull();
  });
});

describe('消费者注册表(按扩展名/路径前缀路由)', () => {
  it('按扩展名命中:注册了才投递,没注册的扩展名零投递', () => {
    const router = createFileChangeRouter();
    const delivered: NonPythonChangeEvent[] = [];
    const registration = router.register(
      rustFileChangeConsumer({ id: 'rust-def', extensions: ['.def'], notify: e => delivered.push(e) })
    );

    expect(router.publish(eventOf({ fsPath: '/ws/a.def', fileName: 'a.def', ext: '.def' }))).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].handledBy).toBe('rust');

    // 没注册 .xml → 零投递、返回空、不报错
    expect(router.publish(eventOf())).toEqual([]);
    expect(delivered).toHaveLength(1);

    registration.dispose();
    expect(router.publish(eventOf({ fsPath: '/ws/a.def', fileName: 'a.def', ext: '.def' }))).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it('按路径前缀命中:前缀内投递,前缀外不投递', () => {
    const router = createFileChangeRouter();
    const delivered: string[] = [];
    router.register(
      rustFileChangeConsumer({
        id: 'rust-entity-defs',
        pathPrefixes: [path.join('/ws', 'assets', 'entity_defs')],
        notify: e => delivered.push(String(e.fsPath))
      })
    );
    router.publish(eventOf({ fsPath: path.join('/ws', 'assets', 'entity_defs', 'x.xml') }));
    router.publish(eventOf({ fsPath: path.join('/ws', 'assets', 'res', 'y.xml') }));
    expect(delivered).toEqual([path.join('/ws', 'assets', 'entity_defs', 'x.xml')]);
  });

  it('扩展名大小写不敏感;没有任何选择器的消费者不参与路由(不误全量广播)', () => {
    const router = createFileChangeRouter();
    const delivered: NonPythonChangeEvent[] = [];
    router.register(rustFileChangeConsumer({ id: 'upper', extensions: ['.XML'], notify: e => delivered.push(e) }));
    router.publish(eventOf({ fileName: 'a.xml', ext: '.xml' }));
    expect(delivered).toHaveLength(1);

    const free: NonPythonChangeEvent[] = [];
    router.register(rustFileChangeConsumer({ id: 'no-selector', notify: e => free.push(e) }));
    router.publish(eventOf({ fileName: 'b.json', ext: '.json' }));
    expect(free).toEqual([]);
  });

  it('公共订阅口 onPublish:观察者拿到完整元信息(与消费者同源)', () => {
    const router = createFileChangeRouter();
    const seen: NonPythonChangeEvent[] = [];
    router.subscribe(event => seen.push(event));
    router.publish(eventOf({ handledBy: 'unrouted' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ fileName: 'types.xml', ext: '.xml', handledBy: 'unrouted' });
  });
});

describe('rust 通知帧与静默降级', () => {
  it('只有 rust 消费者命中才发帧,帧体是纯数据载荷', () => {
    const router = createFileChangeRouter();
    const frames: Array<Record<string, unknown>> = [];
    router.register(
      rustFileChangeConsumer({ id: 'rust-xml', extensions: ['.xml'], notify: params => frames.push(params) })
    );
    const event = eventOf();
    router.publish(event);

    expect(frames).toHaveLength(1);
    // 帧体 = 事件纯数据 + 本消费者的处理方(handledBy=rust)
    expect(frames[0]).toEqual(fileChangedNotificationParams({ ...event, handledBy: 'rust' }));
    expect(frames[0]).toMatchObject({
      fsPath: '/ws/assets/res/types.xml',
      fileName: 'types.xml',
      ext: '.xml',
      kind: 'change',
      handledBy: 'rust'
    });
    // 不请求/不等响应回执:通知帧语义
    expect(KODE_FILE_CHANGED_METHOD).toBe('$/kode/fileChanged');
  });

  it('rust 不可用(未注入投递口)→ 静默降级,不报错不阻塞', () => {
    const router = createFileChangeRouter();
    const seen: NonPythonChangeEvent[] = [];
    router.subscribe(event => seen.push(event));
    router.register(rustFileChangeConsumer({ id: 'rust-dead', extensions: ['.xml'] }));
    expect(() => router.publish(eventOf())).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('投递口抛错 → 吞掉并继续广播订阅者(不阻塞热更)', () => {
    const router = createFileChangeRouter();
    const seen: NonPythonChangeEvent[] = [];
    router.subscribe(event => seen.push(event));
    const spy = vi.fn(() => {
      throw new Error('rust exited');
    });
    router.register(rustFileChangeConsumer({ id: 'rust-boom', extensions: ['.xml'], notify: spy }));
    expect(() => router.publish(eventOf())).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('python 消费者与 rust 消费者各自命中(消费者类型如实上事件)', () => {
    const router = createFileChangeRouter();
    const pythonHits: NonPythonChangeEvent[] = [];
    const rustHits: NonPythonChangeEvent[] = [];
    router.register({
      id: 'py-script',
      kind: 'python',
      extensions: ['.xml'],
      deliver: event => pythonHits.push(event)
    } satisfies FileChangeConsumer);
    router.register(rustFileChangeConsumer({ id: 'rust-xml', extensions: ['.xml'], notify: e => rustHits.push(e) }));

    router.publish(eventOf());
    expect(pythonHits).toHaveLength(1);
    expect(rustHits).toHaveLength(1);
    // 每个消费者拿到的是「自己是处理方」的事件(handledBy 按命中者盖章)
    expect(pythonHits[0].handledBy).toBe('python');
    expect(rustHits[0].handledBy).toBe('rust');
  });
});
