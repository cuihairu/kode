import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createKbeSymbolHover,
  KBEngineHoverProvider,
  KBEngineSignatureHelpProvider,
  resolveUserTypeContractSection,
  setPythonDataDictIndexEnabled
} from '../src/languageProviders';
import type { EntityMappingManager } from '../src/entityMapping';
import { GlobalDataDictIndex } from '../src/globalDataIndex';
import { clearRecentHoverTimeouts, getRecentHoverTimeouts, setHoverBudgetLogHub } from '../src/hoverBudget';
import { resetScanRootCache } from '../src/scanRoots';
import { configurationOverrides } from './fake-vscode/workspaceState';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// hover.ts 缺口臂(2026-11-09 覆盖率扫尾):三条异步面的 R2-F18 onStop 面
// (receiver-call / builtin-property / self-property-type 预算到期传播取消)、
// 同步段口 deadline 闸、数据字典面就绪复核版本换代、apiDoc 面、签名帮助
// 解析抛错如实 null、kbe 符号版本标注、用户类型契约段的两个早退臂。

const cancelableToken = () => {
  let listener: (() => void) | undefined;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(callback: () => void) {
      listener = callback;
      return { dispose: () => { listener = undefined; } };
    }
  };
  return {
    token: token as never,
    cancel: () => { token.isCancellationRequested = true; listener?.(); }
  };
};

const neverPromise = new Promise<null>(() => undefined);

const fakeManager = (overrides: Record<string, unknown>): EntityMappingManager =>
  overrides as unknown as EntityMappingManager;

const ORIGINAL_FOLDERS = stubWorkspace.workspaceFolders;

beforeEach(() => {
  clearRecentHoverTimeouts();
  setHoverBudgetLogHub(null);
});

afterEach(() => {
  configurationOverrides.delete('kbengine');
  stubWorkspace.workspaceFolders = ORIGINAL_FOLDERS;
  resetScanRootCache();
});

describe('hover 缺口臂:同步段口闸与数据字典就绪复核', () => {
  it('同步段口:进入前父 token 已取消 → 不进同步链,如实 null', async () => {
    const parent = cancelableToken();
    parent.cancel();
    const provider = new KBEngineHoverProvider(fakeManager({}));
    const doc = makeTextDocument('value = compute(1)\n', { fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python' });
    const result = await provider.provideHover(doc, new Position(0, 2), parent.token);
    expect(result).toBeNull();
    expect(getRecentHoverTimeouts()).toEqual([]); // 段口协作检查不是超时
  });

  it('同步段口:同步链中途父 token 取消 → 段口协作检查短路 null', async () => {
    const parent = cancelableToken();
    const provider = new KBEngineHoverProvider(fakeManager({}));
    const text = 'value = alpha\n';
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python' });
    // 同步段不可抢占,但父取消经链接 token 即刻可观测;lineAt 首调即取消,
    // 模拟事件循环把取消夹进同步链两条语句之间的真实交错。
    const realLineAt = doc.lineAt.bind(doc);
    doc.lineAt = (line: number) => {
      parent.cancel();
      return realLineAt(line);
    };
    const result = await provider.provideHover(doc, new Position(0, text.indexOf('alpha')), parent.token);
    expect(result).toBeNull();
    expect(getRecentHoverTimeouts()).toEqual([]); // 段口协作检查不是超时
  });

  it('数据字典面:读点 hover 出同键写点类型;就绪后版本换代如实 null', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-hover-gap-dd-'));
    const writer = path.join(root, 'base', 'writer.py');
    const reader = path.join(root, 'cell', 'reader.py');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    fs.mkdirSync(path.dirname(reader), { recursive: true });
    const writerText = 'import KBEngine\nKBEngine.globalData["cfg"] = {"gold": 1}\n';
    const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get("cfg")\n';
    fs.writeFileSync(writer, writerText);
    fs.writeFileSync(reader, readerText);
    const originalFind = stubWorkspace.findFiles;
    const originalRead = stubWorkspace.fs.readFile;
    stubWorkspace.findFiles = (async () => [Uri.file(writer), Uri.file(reader)]) as typeof stubWorkspace.findFiles;
    stubWorkspace.fs.readFile = (async (uri: Uri) => fs.readFileSync(uri.fsPath)) as typeof stubWorkspace.fs.readFile;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const previousEnabled = true; // 下面显式开启,afterEach 由配置面恢复语义
    void previousEnabled;
    setPythonDataDictIndexEnabled(true);
    const index = new GlobalDataDictIndex();
    try {
      const provider = new KBEngineHoverProvider(undefined, index);
      const keyPos = new Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      // 基线:同版本 → 读点 hover 出写点值类型(真 hover,非 null)
      const warm = makeTextDocument(readerText, { fileName: reader, languageId: 'python', version: 1 });
      const baseline = await provider.provideHover(warm, keyPos);
      expect(baseline).not.toBeNull();
      // 读点 hover:同键写点值类型(union)+首写点定位
      expect(JSON.stringify(baseline)).toContain('读点');
      // 就绪后版本换代:captured version=1,ready 复检见 version=2 → 如实 null
      const doc = makeTextDocument(readerText, { fileName: reader, languageId: 'python', version: 1 });
      const pending = provider.provideHover(doc, keyPos);
      doc.version = 2; // 索引初扫在途/刚就绪前换代(recheck 面)
      expect(await pending).toBeNull();
    } finally {
      index.dispose();
      stubWorkspace.findFiles = originalFind;
      stubWorkspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hover 缺口臂:三条异步面的预算到期 onStop 面', () => {
  it('receiver-call 面:预算截断慢层,onStop 取消链接 token,如实 null', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 20 });
    const provider = new KBEngineHoverProvider(
      fakeManager({ resolveMethodDefinition: () => neverPromise })
    );
    const text = 'class Hero:\n    def onCmd(self):\n        self.cell.remoteCall(1)\n';
    const line = text.split('\n')[2];
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python' });
    const result = await provider.provideHover(doc, new Position(2, line.indexOf('remoteCall') + 3));
    expect(result).toBeNull();
    expect(getRecentHoverTimeouts().map(record => record.layer)).toEqual(['hover:receiver-call']);
  });

  it('builtin-property 面:无面路径走 manager 面判定,预算截断如实 null', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 20 });
    const provider = new KBEngineHoverProvider(
      fakeManager({ getEntityComponentFacesForPythonFile: () => neverPromise })
    );
    const text = 'class Hero:\n    def run(self):\n        self.cellData = 1\n';
    const line = text.split('\n')[2];
    // generic 目录无组件面 → resolveEntityComponentFaceFromPath null → 面判定落在 manager
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/generic/Hero.py', languageId: 'python' });
    const result = await provider.provideHover(doc, new Position(2, line.indexOf('cellData') + 3));
    // 面超时返回空 → 落同步链,'cellData' 有行为条目 → 行为注记兜底 hover
    expect(JSON.stringify(result)).toContain('行为注记');
    expect(getRecentHoverTimeouts().map(record => record.layer)).toEqual(['hover:builtin-property']);
  });

  it('self-property-type 面:多段访问进面,预算截断如实 null', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 20 });
    const provider = new KBEngineHoverProvider(
      fakeManager({
        resolvePropertyDefinitionInfo: () => neverPromise,
        resolveMethodDefinition: () => neverPromise
      })
    );
    const text = 'class Hero:\n    def run(self):\n        self.pos.x = 1\n';
    const line = text.split('\n')[2];
    // self.pos.x 多段访问 → 内建属性单段面让位,进 self-property-type 面
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/generic/Hero.py', languageId: 'python' });
    const result = await provider.provideHover(doc, new Position(2, line.indexOf('self.pos.x') + 'self.pos.'.length));
    expect(result).toBeNull();
    expect(getRecentHoverTimeouts().map(record => record.layer)).toEqual(['hover:self-property-type']);
  });
});

describe('hover 缺口臂:apiDoc 面 / 签名帮助抛错 / kbe 符号标注 / 契约段', () => {
  it('KBEngine.<api> 成员:hover 出 API 文档页(非 miss 如实出 hover)', async () => {
    const provider = new KBEngineHoverProvider();
    const text = 'import KBEngine\nx = KBEngine.fireEvent(1)\n';
    const line = text.split('\n')[1];
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/base/Hero.py', languageId: 'python' });
    const result = await provider.provideHover(doc, new Position(1, line.indexOf('fireEvent') + 3));
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).toContain('fireEvent');
  });

  it('签名帮助:def 解析抛错 → 如实 null,不炸面板', async () => {
    const provider = new KBEngineSignatureHelpProvider(
      fakeManager({
        resolveMethodDefinition: async () => {
          throw new Error('index exploded');
        }
      })
    );
    const text = 'value = avatar.doThing(1)\n';
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python' });
    // 光标须在实参表内(方法名上 getPythonCallAtPosition 不认),解析抛错才进如实 null 臂
    const result = await provider.provideSignatureHelp(doc, new Position(0, text.indexOf('(1)') + 1));
    expect(result).toBeNull();
  });

  it('kbe 符号 hover:fork 版本条目带版本归属标注', () => {
    const hover = createKbeSymbolHover({
      name: 'createEntityAnywhere',
      kind: 'function',
      signature: 'KBEngine.createEntityAnywhere(...)',
      summary: 'x',
      summaryEn: 'x',
      sourceFile: 'kbengine/KBEngine.py',
      sourceLine: 12,
      version: 'fork'
    } as never);
    const value = (hover.contents as { value: string }).value;
    expect(value).toContain('createEntityAnywhere');
    expect(value).toContain('fork'); // 版本归属标注(fork 条目在非 fork 引擎版本上)
  });

  it('用户类型契约段:文档不在工作区内 → 如实 null', () => {
    stubWorkspace.workspaceFolders = [];
    const doc = makeTextDocument('x = 1\n', { fileName: '/nowhere/scripts/entity_defs/T.xml', languageId: 'kbengine-def' });
    const result = resolveUserTypeContractSection(
      doc,
      { name: 'SOME_DATA', implementedBy: ['Avatar'] } as never
    );
    expect(result).toBeNull();
  });

  it('用户类型契约段:类型登记缺失 → 如实 null', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-hover-gap-utc-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      const doc = makeTextDocument('x = 1\n', {
        fileName: path.join(root, 'scripts', 'entity_defs', 'T.xml'),
        languageId: 'kbengine-def'
      });
      const result = resolveUserTypeContractSection(
        doc,
        { name: 'NO_SUCH_TYPE', implementedBy: ['Avatar'] } as never
      );
      expect(result).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hover 缺口臂:行为注记各臂(词范围/合并/透传)', () => {
  it('光标不在词上(等号)→ 无词范围,不找行为条目,如实透传 null', async () => {
    const provider = new KBEngineHoverProvider();
    const text = 'value = 1\n';
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python' });
    const result = await provider.provideHover(doc, new Position(0, text.indexOf('=')));
    expect(result).toBeNull();
  });

  it('def 方法注解 hover 与行为注记合并(已知符号 isDestroyed)', async () => {
    const provider = new KBEngineHoverProvider(fakeManager({
      resolveMethodDefinition: async () => ({
        section: 'base',
        defFile: '/tmp/project/scripts/entity_defs/Hero.def',
        line: 8,
        exposed: false,
        declaredArgs: []
      })
    }));
    const text = 'class Hero:\n    def isDestroyed(self):\n        pass\n';
    const line = text.split('\n')[1];
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/base/Hero.py', languageId: 'python' });
    const result = await provider.provideHover(doc, new Position(1, line.indexOf('isDestroyed')));
    expect(result).not.toBeNull();
    const value = (result as { contents: { value: string } }).contents.value;
    expect(value).toContain('isDestroyed'); // def 注解段
    expect(value).toContain('行为注记'); // 同名已知符号注记并段(合并臂)
  });

  it('事件统计 string 面 hover:非 MarkdownString 形态原样透传,不猜不拼', async () => {
    const provider = new KBEngineHoverProvider();
    const text = 'self.registerEvent(isDestroyed, self.onFire)\n';
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python' });
    const result = await provider.provideHover(doc, new Position(0, text.indexOf('isDestroyed') + 2));
    expect(result).not.toBeNull();
    const json = JSON.stringify(result);
    expect(json).toContain('isDestroyed'); // 事件统计 hover 本体
    expect(json).not.toContain('行为注记'); // 未知 contents 形态:不猜测,原样返回
  });
});
