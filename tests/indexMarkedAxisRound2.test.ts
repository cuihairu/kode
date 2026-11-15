import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { SpaceDataIndex } from '../src/spaceDataIndex';
import { WorkspaceIndex } from '../src/workspaceIndex';

// RUST-004 续批二:SpaceDataIndex/WorkspaceIndex 标注轴(isReady + *Marked
// 查询变体)——与 globalDataIndexMarkedQuery 同款模式。索引未就绪时标注面
// 返回 {…, ready:false},调用方不再可能把「索引未建」读成「查询结果为空」
// (禁止悄悄返回假完整结果的标注轴)。查询原语义不动,就绪=初扫完成且未
// 弃置。SpaceDataIndex 是增量事件驱动面(updateFile 无初扫也可蓄内容),
// 严格就绪门会误伤事件驱动用法,门在上游 ensureStarted/awaitReady 纪律,
// 标注面在这里;WorkspaceIndex.allEventCallsMarked 未就绪零阻塞返回
// (plain allEventCalls 的硬 await 接线另项设计)。

describe('SpaceDataIndex marked query (RUST-004 round 2)', () => {
  it('isReady:未启动 false → 初扫完成 true → 弃置 false', async () => {
    const index = new SpaceDataIndex();
    try {
      expect(index.isReady).toBe(false);
      await index.ensureStarted();
      expect(index.isReady).toBe(true);
    } finally {
      index.dispose();
    }
    expect(index.isReady).toBe(false);
  });

  it('queryFamiliesForSpaceMarked:未就绪 {families:[], ready:false},不把「未建」装成「空结果」', () => {
    const index = new SpaceDataIndex();
    try {
      const marked = index.queryFamiliesForSpaceMarked('1');
      expect(marked.ready).toBe(false);
      expect(marked.families).toEqual([]);
    } finally {
      index.dispose();
    }
  });

  it('queryFamilySitesMarked:未就绪 {sites:[], ready:false};初扫后与 plain query 同源', async () => {
    const index = new SpaceDataIndex();
    try {
      const before = index.queryFamilySitesMarked('1', 'cfg');
      expect(before.ready).toBe(false);
      expect(before.sites).toEqual([]);

      index.updateFile('/w/a.py', 'import KBEngine\nKBEngine.setSpaceData(1, "cfg", "x")\n');
      await index.ensureStarted();
      const marked = index.queryFamilySitesMarked('1', 'cfg');
      expect(marked.ready).toBe(true);
      expect(marked.sites.map(site => site.file)).toEqual(
        index.queryFamilySites('1', 'cfg').map(site => site.file)
      );
      expect(marked.sites.map(site => site.fn)).toEqual(['setSpaceData']);
    } finally {
      index.dispose();
    }
  });

  it('queryFamiliesForSpaceMarked:初扫后键族流出且与 plain query 同源', async () => {
    const index = new SpaceDataIndex();
    try {
      index.updateFile('/w/a.py', 'import KBEngine\nKBEngine.getSpaceData(1, "cfg")\n');
      await index.ensureStarted();
      const marked = index.queryFamiliesForSpaceMarked('1');
      expect(marked.ready).toBe(true);
      expect(marked.families.map(family => family.keySignature)).toEqual(
        index.queryFamiliesForSpace('1').map(family => family.keySignature)
      );
      expect(marked.families.map(family => family.keySignature)).toEqual(['cfg']);
    } finally {
      index.dispose();
    }
  });
});

describe('WorkspaceIndex marked query (RUST-004 round 2)', () => {
  let originalFind: typeof vscode.workspace.findFiles | undefined;
  let originalRead: typeof vscode.workspace.fs.readFile | undefined;
  let findCalls = 0;
  let uri: ReturnType<typeof vscode.Uri.file>;

  beforeEach(() => {
    originalFind = vscode.workspace.findFiles;
    originalRead = vscode.workspace.fs.readFile;
    uri = vscode.Uri.file('/ws/marked.py');
    vscode.workspace.fs.readFile = async file =>
      file.fsPath === uri.fsPath
        ? Buffer.from("self.addEvent('EV_TICK', self.on_tick)\n")
        : Buffer.from('');
  });

  afterEach(() => {
    if (originalFind) {
      vscode.workspace.findFiles = originalFind;
    }
    if (originalRead) {
      vscode.workspace.fs.readFile = originalRead;
    }
  });

  it('isReady:未启动 false → 初扫完成 true → 弃置 false', async () => {
    findCalls = 0;
    vscode.workspace.findFiles = async () => {
      findCalls += 1;
      return [uri];
    };
    const index = new WorkspaceIndex();
    try {
      expect(index.isReady).toBe(false);
      await index.ensureStarted();
      expect(index.isReady).toBe(true);
    } finally {
      index.dispose();
    }
    expect(index.isReady).toBe(false);
  });

  it('allEventCallsMarked:未就绪零阻塞 {calls:[], ready:false},不触发初扫', async () => {
    findCalls = 0;
    vscode.workspace.findFiles = async () => {
      findCalls += 1;
      return [uri];
    };
    const index = new WorkspaceIndex();
    try {
      const marked = await index.allEventCallsMarked();
      expect(marked.ready).toBe(false);
      expect(marked.calls).toEqual([]);
      // 零阻塞且零副作用:未触发初扫(findFiles 零次,isReady 不翻真)
      expect(findCalls).toBe(0);
      expect(index.isReady).toBe(false);
    } finally {
      index.dispose();
    }
  });

  it('allEventCallsMarked:就绪后 ready:true 且与 plain allEventCalls 同源', async () => {
    findCalls = 0;
    vscode.workspace.findFiles = async () => {
      findCalls += 1;
      return [uri];
    };
    const index = new WorkspaceIndex();
    try {
      await index.ensureStarted();
      const marked = await index.allEventCallsMarked();
      expect(marked.ready).toBe(true);
      const plain = await index.allEventCalls();
      expect(marked.calls.map(call => call.call.event)).toEqual(plain.map(call => call.call.event));
      expect(marked.calls.map(call => call.call.event)).toEqual(['EV_TICK']);
    } finally {
      index.dispose();
    }
  });
});
