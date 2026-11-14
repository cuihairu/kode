/**
 * KSEM-DATA-03(SEM-044)合并多写者类型 — 验收钉。
 *
 * 验收口径(todo.md SEM-044):不同写入点类型形成联合及来源说明;只有
 * 声明契约冲突才报错,正常多态不误报。
 *
 * 面分解:
 *  - 联合已并(DATA-01 审计现状):inlay/hover 读点 `int | str`——本批钉
 *    联合的来源说明:悬停读点联合 ≥2 类时逐类型列出产源写点(类型→
 *    file:line),类型推不出的写点不入联合、条数如实补记;
 *  - 单写者渲染不铜变(首个写点行保留,既有钉不破);
 *  - 「只有声明契约冲突才报错」:引擎三共享字典(globalData/baseAppData/
 *    cellAppData)值为任意 pickle 对象,无声明契约面(引擎真源:键值即
 *    Python 对象,无 schema);索引五消费面全为信息面,零诊断发射面——
 *    正常多态(int|str)如实并陈,悬停不裁剪、不出冲突措辞(不误报钉)。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import { GlobalDataDictIndex } from '../src/globalDataIndex';

const stubManager = (): EntityMappingManager =>
  new EntityMappingManager({ subscriptions: [] } as never);

const hoverText = (hover: vscode.Hover | null): string => {
  if (!hover) {
    return '';
  }
  const contents = hover.contents as { value: string } | Array<{ value: string }>;
  return Array.isArray(contents) ? contents.map(item => item.value).join('') : contents.value;
};

/** 两写点+读点工作区;rhsA/rhsB 定两写点 RHS,extra 追加第三写点。 */
const setup = (
  rhsA = '1',
  rhsB = '"s"',
  extra?: { name: string; rhs: string }
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da03-'));
  const mk = (rel: string, text: string): string => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const writerA = mk('base/writerA.py', `import KBEngine\nKBEngine.globalData["k"] = ${rhsA}\n`);
  const writerB = mk('cell/writerB.py', `import KBEngine\nKBEngine.globalData["k"] = ${rhsB}\n`);
  const files = [writerA, writerB];
  if (extra) {
    files.push(mk(extra.name, `import KBEngine\nKBEngine.globalData["k"] = ${extra.rhs}\n`));
  }
  const readerText = 'import KBEngine\nv = KBEngine.globalData.get("k")\n';
  const reader = mk('cell/reader.py', readerText);
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const originalFolders = vscode.workspace.workspaceFolders;
  vscode.workspace.findFiles = async () => [...files, reader].map(file => vscode.Uri.file(file));
  vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
  const restore = () => {
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
    vscode.workspace.workspaceFolders = originalFolders;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { reader, readerText, restore };
};

const readHoverOf = async (
  provider: KBEngineHoverProvider,
  reader: string,
  readerText: string
): Promise<string> => {
  const doc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
  const line = readerText.split('\n')[1];
  return hoverText(await provider.provideHover(
    doc,
    new vscode.Position(1, line.indexOf('k') + 1)
  ) as vscode.Hover | null);
};

describe('KSEM-DATA-03 多写者联合来源说明(读点悬停)', () => {
  it('联合 ≥2 类:逐类型列产源写点(int←A/str←B),条数与首写点照常', async () => {
    const { reader, readerText, restore } = setup();
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    try {
      const text = await readHoverOf(hover, reader, readerText);
      expect(text).toContain('`: int | str**');
      expect(text).toContain('同键写点 2 处');
      expect(text).toContain('首个写点 writerA.py:2');
      expect(text).toContain('- int ← writerA.py:2');
      expect(text).toContain('- str ← writerB.py:2');
    } finally {
      index.dispose();
      restore();
    }
  });

  it('同型多写点:联合单一类型,产源标签聚合一行(int←A, B)', async () => {
    const { reader, readerText, restore } = setup('1', '2');
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    try {
      const text = await readHoverOf(hover, reader, readerText);
      expect(text).toContain('`: int**');
      expect(text).not.toContain('|');
      // 联合只有一类(≥2 条件不满足)→ 不出逐类型行;首写点行即来源
      expect(text).toContain('首个写点 writerA.py:2');
      expect(text).not.toContain('- int ←');
    } finally {
      index.dispose();
      restore();
    }
  });

  it('不可推写点不入联合:条数如实补记(另有 1 处写点类型不可推)', async () => {
    const { reader, readerText, restore } = setup('1', '"s"', { name: 'base/writerC.py', rhs: '{}' });
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    try {
      const text = await readHoverOf(hover, reader, readerText);
      expect(text).toContain('`: int | str**');
      expect(text).toContain('同键写点 3 处');
      expect(text).toContain('另有 1 处写点类型不可推');
      expect(text).toContain('- int ← writerA.py:2');
      expect(text).toContain('- str ← writerB.py:2');
    } finally {
      index.dispose();
      restore();
    }
  });

  it('单写者渲染不铜变:无逐类型行(首个写点行即来源)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da03-one-'));
    const writer = path.join(root, 'writer.py');
    const reader = path.join(root, 'reader.py');
    fs.writeFileSync(writer, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    const readerText = 'import KBEngine\nv = KBEngine.globalData.get("k")\n';
    fs.writeFileSync(reader, readerText);
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () => [writer, reader].map(file => vscode.Uri.file(file));
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    try {
      const doc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const line = readerText.split('\n')[1];
      const text = hoverText(await hover.provideHover(
        doc,
        new vscode.Position(1, line.indexOf('k') + 1)
      ) as vscode.Hover | null);
      expect(text).toContain('`: int**');
      expect(text).toContain('首个写点 writer.py:2');
      expect(text).not.toContain('- int ←');
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('KSEM-DATA-03 正常多态不误报(无声明契约面,零冲突措辞)', () => {
  it('int+str 两写点:悬停如实并陈联合,不出冲突措辞;inlay 照常 union', async () => {
    const { reader, readerText, restore } = setup();
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    try {
      const doc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const line = readerText.split('\n')[1];
      const text = hoverText(await hover.provideHover(
        doc,
        new vscode.Position(1, line.indexOf('k') + 1)
      ) as vscode.Hover | null);
      expect(text).toContain('int | str');
      expect(text).not.toContain('冲突');
      expect(text).not.toContain('error');
      // inlay 联合照常(信息面,非诊断)
      const hints = await inlay.provideInlayHints(
        doc,
        new vscode.Range(1, 0, 1, line.length)
      );
      expect(hints.map(h => h.label)).toEqual([': int | str']);
    } finally {
      index.dispose();
      restore();
    }
  });
});
