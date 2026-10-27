import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSharedFileEventMerger } from '../src/sharedFileEvents';

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
    const merger = createSharedFileEventMerger(20);
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(`${event.kind}:${event.fsPath}`); });

    merger.emit(file, 'change');
    expect(seen).toHaveLength(1); // 首报即达

    // 第二次真实写入(mtime 与内容都前进),窗口内再次上报
    fs.writeFileSync(file, 'x = 2\n', 'utf8');
    const later = new Date('2026-01-01T00:00:01Z');
    fs.utimesSync(file, later, later);
    merger.emit(file, 'change');
    expect(seen).toHaveLength(1); // 立即仍吞(防抖口径不变)

    await wait(60); // 窗口到期:盘上版本已前进 → 补投第二次
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(`change:${file}`);
    merger.dispose();
  });

  it('纯重复(盘上版本未动):窗口到期不补投,同一保存只应用一次', async () => {
    const file = realFile('b.py', 'x = 1\n', new Date('2026-01-01T00:00:00Z'));
    const merger = createSharedFileEventMerger(20);
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(event.kind); });

    merger.emit(file, 'change');
    merger.emit(file, 'change');
    merger.emit(file, 'change');
    expect(seen).toEqual(['change']);

    await wait(60); // 版本未动:无尾随补投
    expect(seen).toEqual(['change']);
    merger.dispose();
  });

  it('delete 终态不补投:change→delete 两次都到达后窗口到期无多余事件', async () => {
    const file = realFile('c.py', 'x = 1\n', new Date('2026-01-01T00:00:00Z'));
    const merger = createSharedFileEventMerger(20);
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(event.kind); });

    merger.emit(file, 'change');
    fs.rmSync(file, { force: true });
    merger.emit(file, 'delete');
    merger.emit(file, 'delete');
    expect(seen).toEqual(['change', 'delete']);

    await wait(60);
    expect(seen).toEqual(['change', 'delete']);
    merger.dispose();
  });
});
