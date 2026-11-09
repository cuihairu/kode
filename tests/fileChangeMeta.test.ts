import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileChangeMetaResolver,
  formatFileChangeMeta,
  type FileChangeMetaDeps
} from '../src/fileChangeMeta';
import { resolveModuleDualName } from '../src/backend/hotReloadTempEdit';
import { normalizeFileIdentity } from '../src/backend/pathIdentity';
import { createSharedFileEventMerger, type SharedFileEvent } from '../src/backend/sharedFileEvents';

// 文件变化元信息(方案 B):merger 交付 version token,下游懒解析器按
// identity+version 记忆化——同版本只读一次、不同版本重读;stat/读失败如实返
// 部分字段并带 reason,绝不抛;模块名复用 resolveModuleDualName 同一口径;
// 进程归属按 KBEngine 脚本目录约定判,判不出不编造。
//
// 注入替身而非真 fs:读/次数计数是本文件的主断言面(不新增 IO、只读一次)。

const ASSETS = '/ws/assets';
const SCRIPTS = `${ASSETS}/scripts`;

const ev = (fsPath: string, kind: SharedFileEvent['kind'] = 'change', version?: string): SharedFileEvent =>
  ({ fsPath, identity: normalizeFileIdentity(fsPath), kind, version });

interface FakeIo {
  readonly deps: FileChangeMetaDeps;
  readonly reads: string[];
  readonly stats: string[];
  put(file: string, content: string, mtimeMs?: number): void;
  failRead(reason: string): void;
  failStat(reason: string): void;
}

/** 注入式 IO 替身:记读/ stat 次数,可按文件种内容、可注入失败 */
function fakeIo(): FakeIo {
  const reads: string[] = [];
  const stats: string[] = [];
  const files = new Map<string, { content: string; mtimeMs: number; size: number }>();
  let readError: string | undefined;
  let statError: string | undefined;
  const deps: FileChangeMetaDeps = {
    scriptRoot: () => SCRIPTS,
    assetsRoot: () => ASSETS,
    readFile: async (file: string): Promise<Buffer> => {
      reads.push(file);
      if (readError !== undefined) throw new Error(readError);
      const entry = files.get(file);
      if (!entry) throw new Error(`ENOENT: ${file}`);
      return Buffer.from(entry.content, 'utf8');
    },
    stat: async (file: string): Promise<{ mtimeMs: number; size: number }> => {
      stats.push(file);
      if (statError !== undefined) throw new Error(statError);
      const entry = files.get(file);
      if (!entry) throw new Error(`ENOENT: ${file}`);
      return { mtimeMs: entry.mtimeMs, size: entry.size };
    }
  };
  return {
    deps,
    reads,
    stats,
    put(file, content, mtimeMs = 1_700_000_000_000): void {
      files.set(file, { content, mtimeMs, size: Buffer.byteLength(content, 'utf8') });
    },
    failRead(reason) { readError = reason; },
    failStat(reason) { statError = reason; }
  };
}

const sha256Of = (content: string): string =>
  createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

afterEach(() => {
  for (const file of temporaryFiles.splice(0)) fs.rmSync(file, { force: true });
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 真盘夹具:`<tmp>/scripts/<proc>/<name>`(assetsRoot=<tmp>,scriptRoot=<tmp>/scripts) */
function realScriptFile(processDir: string, name: string, content: string): string {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-fcm-'));
  temporaryDirectories.push(assets);
  const scripts = path.join(assets, 'scripts');
  fs.mkdirSync(path.join(scripts, processDir), { recursive: true });
  const file = path.join(scripts, processDir, name);
  fs.writeFileSync(file, content, 'utf8');
  temporaryFiles.push(file);
  return file;
}

const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

describe('fileChangeMeta:字段面与同口径解析', () => {
  it('基本字段齐全:文件名/扩展/模块/包/进程/sha256/size/mtime/version', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    const content = 'class Avatar: pass\n';
    io.put(file, content, 1_700_000_000_000);
    const resolver = createFileChangeMetaResolver(io.deps);

    const meta = await resolver.metaFor(ev(file, 'change', '1700000000000:19'));

    expect(meta.fsPath).toBe(file);
    expect(meta.identity).toBe(normalizeFileIdentity(file));
    expect(meta.kind).toBe('change');
    expect(meta.fileName).toBe('Avatar.py');
    expect(meta.ext).toBe('.py');
    expect(meta.module).toBe('cell.Avatar');
    expect(meta.package).toBe('cell');
    expect(meta.processKind).toBe('cellapp');
    expect(meta.processSource).toBe('path');
    expect(meta.processReason).toBeUndefined();
    expect(meta.sha256).toBe(sha256Of(content));
    expect(meta.size).toBe(19);
    expect(meta.mtimeMs).toBe(1_700_000_000_000);
    expect(meta.version).toBe('1700000000000:19');
    expect(meta.reason).toBeUndefined();
    // 事件已带 version → 解析端零 stat(size/mtime 从 token 解出),只读一次
    expect(io.stats).toEqual([]);
    expect(io.reads).toEqual([file]);
  });

  it('模块名与 resolveModuleDualName 同一口径(fullModule/包=首段;解析不出即缺省)', async () => {
    const io = fakeIo();
    const resolver = createFileChangeMetaResolver(io.deps);
    const inside = `${SCRIPTS}/entities/fight/FightAI.py`;
    io.put(inside, 'class FightAI: pass\n');
    const outside = '/elsewhere/Loose.py';
    io.put(outside, 'class Loose: pass\n');

    const inMeta = await resolver.metaFor(ev(inside, 'change', '1:1'));
    const dual = resolveModuleDualName(inside, SCRIPTS);
    expect('fullModule' in dual && dual.fullModule).toBe('entities.fight.FightAI');
    expect(inMeta.module).toBe('fullModule' in dual ? dual.fullModule : undefined);
    expect(inMeta.package).toBe('entities');

    // 脚本根外:双名称解析判 unsupported → module/package 缺省,不编造
    const outMeta = await resolver.metaFor(ev(outside, 'change', '1:1'));
    expect(outMeta.module).toBeUndefined();
    expect(outMeta.package).toBeUndefined();
    expect(outMeta.fileName).toBe('Loose.py');
  });

  it('kind=delete:无内容则 sha256 省略(不读盘),模块名仍从路径解析', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    io.put(file, 'class Avatar: pass\n');
    const resolver = createFileChangeMetaResolver(io.deps);

    const meta = await resolver.metaFor(ev(file, 'delete'));

    expect(meta.kind).toBe('delete');
    expect(meta.sha256).toBeUndefined();
    expect(meta.module).toBe('cell.Avatar');
    expect(meta.processKind).toBe('cellapp');
    expect(io.reads, 'delete 无内容可读').toEqual([]);
    expect(meta.reason, 'delete 省略 sha256 不是失败').toBeUndefined();
  });

  it('格式化行:文件名/扩展/模块/包/进程/hash/version 同一行(热更审计与索引日志共用)', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    io.put(file, 'class Avatar: pass\n');
    const resolver = createFileChangeMetaResolver(io.deps);

    const line = formatFileChangeMeta(await resolver.metaFor(ev(file, 'change', '1700000000000:19')));

    expect(line).toContain('Avatar.py');
    expect(line).toContain('ext=.py');
    expect(line).toContain('module=cell.Avatar');
    expect(line).toContain('package=cell');
    expect(line).toContain('process=cellapp');
    expect(line).toMatch(/sha256=[0-9a-f]{12}…/);
    expect(line).toContain('version=1700000000000:19');
    expect(line).not.toContain('reason=');

    const missing = formatFileChangeMeta(await resolver.metaForPath('/elsewhere/Outside.py'));
    expect(missing, '判不出如实显示 unresolved').toContain('process=unresolved');
    expect(missing).toContain('sha256=-');
    expect(missing).toContain('reason=');
  });

  it('读失败:如实返部分字段带 reason,不抛', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    io.put(file, 'class Avatar: pass\n');
    io.failRead('EACCES: permission denied');
    const resolver = createFileChangeMetaResolver(io.deps);

    const meta = await resolver.metaFor(ev(file, 'change', '1700000000000:19'));

    expect(meta.sha256).toBeUndefined();
    expect(meta.size).toBe(19);
    expect(meta.module).toBe('cell.Avatar');
    expect(meta.reason).toContain('EACCES');
  });

  it('stat 失败(无 version 可得):部分字段缺失带 reason,不抛', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    io.put(file, 'class Avatar: pass\n');
    io.failStat('ENOENT: no such file');
    const resolver = createFileChangeMetaResolver(io.deps);

    const meta = await resolver.metaFor(ev(file, 'change'));

    expect(meta.version).toBeUndefined();
    expect(meta.size).toBeUndefined();
    expect(meta.mtimeMs).toBeUndefined();
    expect(meta.reason).toContain('ENOENT');
    expect(meta.sha256, 'stat 失败仍试读,读到就如实给 hash').toBe(sha256Of('class Avatar: pass\n'));
    expect(meta.module).toBe('cell.Avatar');
  });
});

describe('fileChangeMeta:identity+version 记忆化', () => {
  it('同 identity+version 只读一次(并发与先后都只读一次)', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    io.put(file, 'class Avatar: pass\n');
    const resolver = createFileChangeMetaResolver(io.deps);

    const first = await resolver.metaFor(ev(file, 'change', 'v1'));
    const second = await resolver.metaFor(ev(file, 'change', 'v1'));
    const [concurrentA, concurrentB] = await Promise.all([
      resolver.metaFor(ev(file, 'change', 'v1')),
      resolver.metaFor(ev(file, 'change', 'v1'))
    ]);

    expect(io.reads).toEqual([file]); // 四次请求一次读
    expect(second).toBe(first);
    expect(concurrentA).toBe(first);
    expect(concurrentB).toBe(first);
    expect(io.stats).toEqual([]); // version 已带 → 解析端零 stat
  });

  it('不同版本重读:换版本重新 stat/读,hash 随内容前进', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    io.put(file, 'x = 1\n', 1_700_000_000_000);
    const resolver = createFileChangeMetaResolver(io.deps);

    const v1 = await resolver.metaFor(ev(file, 'change', '1700000000000:6'));
    io.put(file, 'x = 22\n', 1_700_000_007_000);
    const v2 = await resolver.metaFor(ev(file, 'change', '1700000007000:7'));

    expect(io.reads).toEqual([file, file]);
    expect(v2.sha256).toBe(sha256Of('x = 22\n'));
    expect(v2.sha256).not.toBe(v1.sha256);
    expect(v2.version).toBe('1700000007000:7');
    // 同版本再问仍回缓存
    const again = await resolver.metaFor(ev(file, 'change', '1700000007000:7'));
    expect(again).toBe(v2);
    expect(io.reads).toHaveLength(2);
  });

  it('无 version 的事件:解析端自行 stat 取版本键(读仍只读一次)', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    io.put(file, 'class Avatar: pass\n');
    const resolver = createFileChangeMetaResolver(io.deps);

    await resolver.metaFor(ev(file, 'change'));
    await resolver.metaFor(ev(file, 'change'));

    expect(io.stats).toEqual([file, file]); // 每次都要 stat 才知道版本
    expect(io.reads, '版本相同 → 读仍只一次').toEqual([file]);
  });
});

describe('fileChangeMeta:watcher 无关(metaForPath 与事件路径同实现同缓存)', () => {
  it('watcher 未启用(无事件流)下手动路径拿到的 meta 与事件路径逐字段相等', async () => {
    const file = realScriptFile('cell', 'Avatar.py', 'class Avatar: pass\n');
    const assetsRoot = path.dirname(path.dirname(path.dirname(file))); // <tmp>
    const scriptRoot = path.join(assetsRoot, 'scripts');
    const makeResolver = (): ReturnType<typeof createFileChangeMetaResolver> =>
      createFileChangeMetaResolver({ scriptRoot: () => scriptRoot, assetsRoot: () => assetsRoot });

    // 手动触发面:只有 fsPath,没有 watcher、没有事件
    const manual = await makeResolver().metaForPath(file);

    // watcher 启用面:真合并器交付的事件(另一实例,证明是各自算出来的)
    const merger = createSharedFileEventMerger(10);
    let delivered: SharedFileEvent | undefined;
    merger.subscribe(event => { delivered ??= event; });
    merger.emit(file, 'change');
    await wait(20);
    merger.dispose();
    expect(delivered, '合并器已交付事件').toBeDefined();
    const viaEvent = await makeResolver().metaFor(delivered!);

    expect(viaEvent).not.toBe(manual); // 不同实例:不是同一个缓存对象
    expect(viaEvent).toEqual(manual); // 逐字段相等
    expect(manual.module).toBe('cell.Avatar');
    expect(manual.processKind).toBe('cellapp');
    expect(manual.sha256).toBe(sha256Of('class Avatar: pass\n'));
    expect(manual.version, '版本 token 同形(mtimeMs:size)')
      .toBe(`${fs.statSync(file).mtimeMs}:${fs.statSync(file).size}`);
  });

  it('metaForPath 对不存在的文件:部分字段缺失带 reason,不抛', async () => {
    const resolver = createFileChangeMetaResolver({
      scriptRoot: () => SCRIPTS,
      assetsRoot: () => ASSETS
    });
    const meta = await resolver.metaForPath('/ws/assets/scripts/cell/Ghost.py');
    expect(meta.fileName).toBe('Ghost.py');
    expect(meta.module).toBe('cell.Ghost'); // 路径可解的字段照给
    expect(meta.sha256).toBeUndefined();
    expect(meta.reason).toBeTruthy();
  });

  it('老消费端不 await 仍工作:同步收单、合并口径不变、无未处理拒绝', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    io.put(file, 'class Avatar: pass\n');
    const resolver = createFileChangeMetaResolver(io.deps);
    const merger = createSharedFileEventMerger(20);
    const seen: string[] = [];
    let failure: unknown;
    merger.subscribe(event => {
      seen.push(`${event.fsPath}:${event.kind}`); // 老消费端:不 await、不读 version
      void resolver.metaFor(event).catch(error => { failure = error; });
    });

    merger.emit(file, 'change');
    merger.emit(file, 'change');
    merger.flushForTests();
    expect(seen).toEqual([`${file}:change`]); // 合并语义零变化

    await wait(30);
    expect(failure).toBeUndefined(); // 不 await 也不产生未处理拒绝
    merger.dispose();
  });
});

describe('fileChangeMeta:进程归属(按 KBEngine 脚本目录约定,判不出不编造)', () => {
  const resolverWith = (): ReturnType<typeof createFileChangeMetaResolver> =>
    createFileChangeMetaResolver(fakeIo().deps);

  const kindOf = async (fsPath: string): Promise<Awaited<ReturnType<ReturnType<typeof resolverWith>['metaFor']>>> =>
    resolverWith().metaFor(ev(fsPath, 'change', '1:1'));

  it('base/cell/login 三类各一例:一级目录直接对应', async () => {
    expect((await kindOf(`${SCRIPTS}/base/Foo.py`)).processKind).toBe('baseapp');
    expect((await kindOf(`${SCRIPTS}/cell/Foo.py`)).processKind).toBe('cellapp');
    expect((await kindOf(`${SCRIPTS}/login/Foo.py`)).processKind).toBe('loginapp');
    expect((await kindOf(`${SCRIPTS}/logger/Foo.py`)).processKind).toBe('logger');
    expect((await kindOf(`${SCRIPTS}/interfaces/IFace.py`)).processKind).toBe('interfaces');
    for (const fsPath of [`${SCRIPTS}/base/Foo.py`, `${SCRIPTS}/cell/Foo.py`, `${SCRIPTS}/login/Foo.py`]) {
      const meta = await kindOf(fsPath);
      expect(meta.processSource).toBe('path');
      expect(meta.processReason).toBeUndefined();
    }
  });

  it('common/user = 共享:记 shared 并带 reason,不指认单一进程', async () => {
    const common = await kindOf(`${SCRIPTS}/common/util.py`);
    expect(common.processKind).toBe('shared');
    expect(common.processSource).toBe('path');
    expect(common.processReason, '共享必须带 reason').toBeTruthy();

    const user = await kindOf(`${SCRIPTS}/user/type.py`);
    expect(user.processKind).toBe('shared');
    expect(user.processReason).toBeTruthy();
  });

  it('嵌套 interfaces 归外层进程:base/interfaces/Interface_X.py → baseapp', async () => {
    const meta = await kindOf(`${SCRIPTS}/base/interfaces/Interface_X.py`);
    expect(meta.processKind).toBe('baseapp');
    expect(meta.processSource).toBe('path');
    expect(meta.processCandidates).toBeUndefined();
  });

  it('路径上出现两个进程段(异常)→ ambiguous + 候选数组,不挑一个猜', async () => {
    const meta = await kindOf(`${SCRIPTS}/base/cell/Stray.py`);
    expect(meta.processKind).toBe('ambiguous');
    expect(meta.processSource).toBe('path');
    expect(meta.processCandidates).toEqual(['baseapp', 'cellapp']);
  });

  it('判定不出 → processKind 缺省 + processReason=unresolved,不编造', async () => {
    for (const fsPath of [
      `${SCRIPTS}/entity_defs/entities.xml`, // 一级目录不是进程目录
      `${SCRIPTS}/bots/Bot.py`,              // bots 不在归属枚举口径内
      '/elsewhere/Outside.py',               // 不在资产根内
      `${ASSETS}/res/server/x.xml`           // 非脚本区
    ]) {
      const meta = await kindOf(fsPath);
      expect(meta.processKind, fsPath).toBeUndefined();
      expect(meta.processSource, fsPath).toBe('unresolved');
      expect(meta.processReason, fsPath).toBe('unresolved');
      expect(meta.processCandidates, fsPath).toBeUndefined();
    }
  });
});

describe('fileChangeMeta:module/package 仅 .py 才解析(Python 概念不外溢)', () => {
  // module/package 是 Python 概念:非 py 文件(如 cell/Avatar.json)两字段
  // 恒缺省(undefined,不用 '-'/空串冒充;'-' 只在渲染层 formatFileChangeMeta)。
  // 其余字段面对非 py 照常:processKind 按目录判(路径归属与语言无关)、
  // sha256/size/version 照读——只有模块名不解析。

  it.each([
    ['.json', `${SCRIPTS}/cell/Avatar.json`],
    ['.tab', `${SCRIPTS}/cell/Avatar.tab`],
    ['.txt', `${SCRIPTS}/cell/Avatar.txt`]
  ])('非 py(%s):module/package 缺省,processKind/sha256/size 照常', async (_ext, file) => {
    const io = fakeIo();
    const content = '{"Avatar": {}}';
    io.put(file, content, 1_700_000_000_000);
    const resolver = createFileChangeMetaResolver(io.deps);

    const meta = await resolver.metaFor(ev(file, 'change', '1700000000000:13'));

    expect(meta.module, `${file}: 非 py 不带 module`).toBeUndefined();
    expect(meta.package, `${file}: 非 py 不带 package`).toBeUndefined();
    expect(meta.fileName, '文件短名照给').toBe(file.slice(SCRIPTS.length + 1).split('/').pop());
    expect(meta.ext, '扩展名字段本身照给(大小写原样)').toBe(file.slice(file.lastIndexOf('.')));
    expect(meta.processKind, '路径归属与语言无关:cell/ 仍归 cellapp').toBe('cellapp');
    expect(meta.sha256, '非 py 的 sha256/读取口径不变').toBe(sha256Of(content));
    expect(meta.size).toBe(13);
    expect(meta.reason).toBeUndefined();
  });

  it('py 文件不受影响:同目录同名的 .py 仍解析出 module/package', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.py`;
    io.put(file, 'class Avatar: pass\n');
    const resolver = createFileChangeMetaResolver(io.deps);

    const meta = await resolver.metaFor(ev(file, 'change', '1700000000000:19'));

    expect(meta.module).toBe('cell.Avatar');
    expect(meta.package).toBe('cell');
    expect(meta.processKind).toBe('cellapp');
  });

  it('大小写 .PY:仓内口径大小写不敏感(与 resolveModuleDualName 同源),仍解析', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.PY`;
    io.put(file, 'class Avatar: pass\n');
    const resolver = createFileChangeMetaResolver(io.deps);

    const meta = await resolver.metaFor(ev(file, 'change', '1700000000000:19'));

    expect(meta.ext).toBe('.PY');
    expect(meta.module).toBe('cell.Avatar');
    expect(meta.package).toBe('cell');
  });

  it('渲染层对非 py:module=- package=-(缺省只在渲染层落 -),进程照常', async () => {
    const io = fakeIo();
    const file = `${SCRIPTS}/cell/Avatar.json`;
    io.put(file, '{}');
    const resolver = createFileChangeMetaResolver(io.deps);

    const line = formatFileChangeMeta(await resolver.metaFor(ev(file, 'change', '1:2')));

    expect(line).toContain('Avatar.json');
    expect(line).toContain('module=-');
    expect(line).toContain('package=-');
    expect(line).toContain('process=cellapp');
  });
});
