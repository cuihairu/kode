import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSharedFileEventMerger, type SharedFileEvent } from '../src/backend/sharedFileEvents';

// 2026-10-28 审核整改(SNP-008 重开):窗口内同 kind 吞并必须区分「同一版本
// 的重复通知」与「两次真实写入」——窗口到期核对盘上版本(mtime+size),
// 已前进则补投尾随事件,第二次更新不再永久丢失;纯重复(版本未动)仍吞。

const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

afterEach(() => {
  for (const file of temporaryFiles.splice(0)) { fs.rmSync(file, { force: true }); }
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function realFile(name: string, content: string, mtime: Date): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-snp8-'));
  temporaryDirectories.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  fs.utimesSync(file, mtime, mtime);
  temporaryFiles.push(file);
  return file;
}

const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

describe('审核整改:合并窗口按盘上版本区分重复与二次写入', () => {
  it('窗口内两次不同内容的连续修改:第二次以尾随事件补投,不永久丢失', async () => {
    const file = realFile('a.py', 'x = 1\n', new Date('2026-01-01T00:00:00Z'));
    // 窗口 150ms / 落定 30ms / 到期 300ms:留足调度裕度,负载饥饿下
    // setTimeout 也绝不越过窗口边界(20/10/60 在高负载 runner 上实测翻车)。
    const merger = createSharedFileEventMerger(150);
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(`${event.kind}:${event.fsPath}`); });

    merger.emit(file, 'change');
    expect(seen).toHaveLength(1); // 首报即达

    await wait(30); // KR-AUD-30:交付时版本改异步 stat 取,先让它落定为 v1
    // 第二次真实写入(mtime 与内容都前进),窗口内再次上报
    fs.writeFileSync(file, 'x = 2\n', 'utf8');
    const later = new Date('2026-01-01T00:00:01Z');
    fs.utimesSync(file, later, later);
    merger.emit(file, 'change');
    expect(seen).toHaveLength(1); // 立即仍吞(防抖口径不变)

    await wait(300); // 窗口到期:盘上版本已前进 → 补投第二次
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(`change:${file}`);
    merger.dispose();
  });

  it('纯重复(盘上版本未动):窗口到期不补投,同一保存只应用一次', async () => {
    const file = realFile('b.py', 'x = 1\n', new Date('2026-01-01T00:00:00Z'));
    const merger = createSharedFileEventMerger(150);
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(event.kind); });

    merger.emit(file, 'change');
    merger.emit(file, 'change');
    merger.emit(file, 'change');
    expect(seen).toEqual(['change']);

    await wait(300); // 版本未动:无尾随补投
    expect(seen).toEqual(['change']);
    merger.dispose();
  });

  it('delete 终态不补投:change→delete 两次都到达后窗口到期无多余事件', async () => {
    const file = realFile('c.py', 'x = 1\n', new Date('2026-01-01T00:00:00Z'));
    const merger = createSharedFileEventMerger(150);
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(event.kind); });

    merger.emit(file, 'change');
    fs.rmSync(file, { force: true });
    merger.emit(file, 'delete');
    merger.emit(file, 'delete');
    expect(seen).toEqual(['change', 'delete']);

    await wait(300);
    expect(seen).toEqual(['change', 'delete']);
    merger.dispose();
  });
});

// 文件变化元信息(方案 B):merger 交付时附带它为去重已经 stat 过的盘上版本
// token(mtimeMs:size)——同一份 stat,不为 version 另开 IO;下游懒解析器按
// identity+version 记忆化,同版本只读一次。首报/尾随补投两条交付路径都带。
describe('交付事件携带盘上版本 token(SharedFileEvent.version)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('首报交付的事件带 version,且不为 version 新增 stat(mock 计数=1)', async () => {
    const file = realFile('v1.py', 'x = 1\n', new Date('2026-01-01T00:00:00Z'));
    const stat = vi.spyOn(fs.promises, 'stat');
    const merger = createSharedFileEventMerger(150);
    const events: SharedFileEvent[] = [];
    merger.subscribe(event => { events.push(event); });

    const before = stat.mock.calls.length;
    merger.emit(file, 'change');
    expect(events).toHaveLength(1); // 首报即达(同步口径不变)
    await wait(60); // KR-AUD-30:版本是异步 stat,落定后回填同一事件对象

    const onDisk = fs.statSync(file);
    expect(events[0].version, '首报事件落定后带盘上版本 token')
      .toBe(`${onDisk.mtimeMs}:${onDisk.size}`);
    expect(stat.mock.calls.length - before, 'version 复用去重那一次 stat,不新增')
      .toBe(1);
    merger.dispose();
  });

  it('窗口尾随补投的事件同样带 version(补投前已 await 核对 stat)', async () => {
    const file = realFile('v2.py', 'x = 1\n', new Date('2026-01-01T00:00:00Z'));
    const stat = vi.spyOn(fs.promises, 'stat');
    const merger = createSharedFileEventMerger(150);
    const events: SharedFileEvent[] = [];
    merger.subscribe(event => { events.push(event); });

    const before = stat.mock.calls.length;
    merger.emit(file, 'change');
    await wait(30); // 首报版本落定为 v1
    fs.writeFileSync(file, 'x = 22\n', 'utf8');
    const later = new Date('2026-01-01T00:00:07Z');
    fs.utimesSync(file, later, later);
    merger.emit(file, 'change'); // 窗口内同 kind:立即仍吞
    expect(events).toHaveLength(1);

    await wait(300); // 窗口到期:版本前进 → 补投
    expect(events).toHaveLength(2);
    const current = fs.statSync(file);
    expect(events[1].version, '尾随补投带补投时点的盘上版本(已前进的 current)')
      .toBe(`${current.mtimeMs}:${current.size}`);
    expect(events[1].version, '补投版本 ≠ 首报版本(否则下游按同版本命中旧缓存)')
      .not.toBe(events[0].version);
    // emit 一次 stat + 窗口到期核对一次 stat;补投不再另 stat(复用核对结果)
    expect(stat.mock.calls.length - before).toBe(2);
    merger.dispose();
  });

  it('首报交付仍是同步的:老消费端不 await、不读 version 也照常收单', () => {
    const merger = createSharedFileEventMerger(20);
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(`${event.fsPath}:${event.kind}`); }); // 不读 version

    merger.emit('/ws/legacy.py', 'change');
    expect(seen).toEqual(['/ws/legacy.py:change']); // 首报即达,不因 version 变异步
    merger.flushForTests();
    merger.dispose();
  });
});
