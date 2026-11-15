import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { GlobalDataDictIndex } from '../src/globalDataIndex';

// RUST-004:查询显式标注面(queryMarked/queryKeyFamiliesMarked)——索引未就绪
// 时返回 {…, ready:false},调用方不再可能把「索引未建」读成「查询结果为空」
// (禁止悄悄返回假完整结果的标注轴)。就绪语义=工作区初扫完成且未弃置;
// 本索引是增量事件驱动面(noteSaved 无初扫也可蓄内容),严格就绪门会误伤
// 事件驱动用法,门在上游 ensureStarted 纪律,标注面在这里。

describe('GlobalDataDictIndex marked query (RUST-004)', () => {
  let root = '';
  let writer = '';
  let reader = '';
  let originalFind: typeof vscode.workspace.findFiles | undefined;
  let originalRead: typeof vscode.workspace.fs.readFile | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-marked-query-'));
    fs.mkdirSync(root, { recursive: true });
    writer = path.join(root, 'writer.py');
    reader = path.join(root, 'reader.py');
    fs.writeFileSync(writer, 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n');
    fs.writeFileSync(reader, 'import KBEngine\nx = KBEngine.globalData["cfg"]\n');
    originalFind = vscode.workspace.findFiles;
    originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
  });

  afterEach(() => {
    if (originalFind) {
      vscode.workspace.findFiles = originalFind;
    }
    if (originalRead) {
      vscode.workspace.fs.readFile = originalRead;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('isReady:未启动 false → 初扫完成 true → 弃置 false', async () => {
    const index = new GlobalDataDictIndex();
    try {
      expect(index.isReady).toBe(false);
      await index.ensureStarted();
      expect(index.isReady).toBe(true);
    } finally {
      index.dispose();
    }
    expect(index.isReady).toBe(false);
  });

  it('queryMarked:未就绪且无内容 {sites:[], ready:false}(空集只代表「还没有内容」)', () => {
    const index = new GlobalDataDictIndex();
    try {
      const marked = index.queryMarked('globalData', 'cfg');
      expect(marked.ready).toBe(false);
      expect(marked.sites).toEqual([]);
    } finally {
      index.dispose();
    }
  });

  it('queryMarked:未就绪但已有部分真实内容 → partial 照常流出,ready:false 如实标注(W1 审计修正:不藏已索引内容)', () => {
    const index = new GlobalDataDictIndex();
    try {
      index.noteSaved(
        vscode.makeTextDocument('import KBEngine\nKBEngine.globalData["cfg"] = 1\n', {
          fileName: path.join(root, 'writer.py'),
          languageId: 'python'
        })
      );
      const marked = index.queryMarked('globalData', 'cfg');
      expect(marked.ready, '初扫未完成如实标 false').toBe(false);
      expect(marked.sites.length, '已索引部分真实内容照常流出').toBeGreaterThan(0);
      expect(marked.sites.map(site => site.kind)).toEqual(index.query('globalData', 'cfg').map(site => site.kind));
    } finally {
      index.dispose();
    }
  });

  it('queryMarked:初扫后 ready:true 且站点与 plain query 同源', async () => {
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      const marked = index.queryMarked('globalData', 'cfg');
      expect(marked.ready).toBe(true);
      expect(marked.sites.map(site => site.kind)).toEqual(
        index.query('globalData', 'cfg').map(site => site.kind)
      );
      expect(marked.sites.map(site => site.kind)).toEqual(['write', 'read']);
    } finally {
      index.dispose();
    }
  });

  it('queryKeyFamiliesMarked:未就绪且无内容 {families:[], ready:false};部分内容不藏;初扫后键族流出', async () => {
    const index = new GlobalDataDictIndex();
    try {
      const before = index.queryKeyFamiliesMarked('globalData');
      expect(before.ready).toBe(false);
      expect(before.families).toEqual([]);

      // W1 审计修正:未就绪不强制空族——事件驱动面已蓄的真实键照常流出
      index.noteSaved(
        vscode.makeTextDocument('import KBEngine\nKBEngine.globalData["cfg"] = 1\n', {
          fileName: path.join(root, 'writer.py'),
          languageId: 'python'
        })
      );
      const partial = index.queryKeyFamiliesMarked('globalData');
      expect(partial.ready).toBe(false);
      expect(partial.families.map(family => family.keySignature)).toEqual(['cfg']);

      await index.ensureStarted();
      const after = index.queryKeyFamiliesMarked('globalData');
      expect(after.ready).toBe(true);
      expect(after.families.map(family => family.keySignature)).toEqual(['cfg']);
    } finally {
      index.dispose();
    }
  });
});
