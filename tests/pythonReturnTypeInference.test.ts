import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KBEngineBuiltinTypeInlayHintsProvider,
  KBEngineCompletionProvider,
  KBEngineHoverProvider
} from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import {
  applySavedFileAnnotations,
  buildReturnAnnotationIndex,
  extractFileReturnAnnotations,
  extractFileReturnAnnotationsAsync,
  flushPendingDocumentReturnAnnotationsForTests,
  releaseDocumentReturnAnnotations,
  removeSavedFileAnnotations,
  renameSavedFileAnnotations,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType,
  resolveLocalVariableReturnTypeFromSnapshot,
  updateDocumentReturnAnnotations
} from '../src/pythonReturnTypeInference';
import {
  formatEntityBuiltinPropertyHeadline,
  getEntityBuiltinPropertiesForFace
} from '../src/entityBuiltinProperties';
import {
  CompletionItemKind,
  configurationOverrides,
  InlayHintKind,
  Position,
  Range,
  Uri,
  makeTextDocument,
  workspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 「能推才显 + 返回类型推导」(用户令 2026-10-21):三提示面解析链断/未知
// 一律不显示任何类型(不显 Any、不显空类型);`data = a.get_data()` 按
// python 返回注解推导 `data: JSONDATA`;无注解不显示;同名重赋值取最后
// 一次可解析值。pyi 生成物的 Any 不在本闸(另册测试保 Any 不变)。

const pyDoc = (text: string, fileName: string): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

const hoverText = (hover: unknown): string => {
  const { contents } = (hover ?? { contents: [] }) as { contents: unknown };
  const raw = Array.isArray(contents) ? contents : [contents];
  return raw.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
};

const managers: EntityMappingManager[] = [];
const makeManager = (): EntityMappingManager => {
  const manager = new EntityMappingManager({ subscriptions: [] });
  managers.push(manager);
  return manager;
};

const roots: string[] = [];
afterEach(() => {
  managers.splice(0).forEach(manager => manager.dispose());
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  workspace.workspaceFolders = undefined;
  workspace.findFiles = async () => [];
  resetPythonReturnAnnotationCache();
});

interface TempWorkspace {
  root: string;
  put: (relative: string, content: string) => string;
}

const setupWorkspace = (): TempWorkspace => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-return-type-'));
  roots.push(root);
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'return-type', index: 0 }];
  return { root, put };
};

describe('返回类型推导(局部变量 hover)', () => {
  it('关闭返回推导后 hover 不启动注解目录发现', async () => {
    const { root } = setupWorkspace();
    const read = vi.spyOn(fs.promises, 'readdir');
    configurationOverrides.set('kbengine', { 'hover.returnTypeInference': false });
    try {
      const doc = pyDoc('data = get_data()\n', path.join(root, 'source.py'));
      await Promise.resolve(new KBEngineHoverProvider().provideHover(doc, new Position(0, 1)));
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      configurationOverrides.delete('kbengine');
    }
  });
  it('单个大文件解析在处理长行时让出事件循环且结果与同步提取一致', async () => {
    const source = `def long_method(value: ${'A'.repeat(150000)}) -> Result:\n    pass\n`;
    let yielded = false;
    const pending = extractFileReturnAnnotationsAsync(source);
    setImmediate(() => { yielded = true; });
    const actual = await pending;
    expect(yielded).toBe(true);
    expect([...actual]).toEqual([...extractFileReturnAnnotations(source)]);
  });
  it('单次遍历提取各方法注解，无注解的方法不会引起全文重扫', () => {
    const source = Array.from({ length: 1000 }, (_, i) =>
      `def method_${i}():\n    pass\n`
    ).join('') + 'def annotated() -> Result:\n    pass\n';
    const exec = vi.spyOn(RegExp.prototype, 'exec');
    let matches: number;
    let annotations: Map<string, string>;
    try {
      annotations = extractFileReturnAnnotations(source);
      matches = exec.mock.contexts.filter(context =>
        context instanceof RegExp && context.source === '^\\s*def\\s+([A-Za-z_]\\w*)\\s*\\('
      ).length;
    } finally {
      exec.mockRestore();
    }
    expect([...annotations]).toEqual([['annotated', 'Result']]);
    expect(matches).toBeLessThanOrEqual(source.split('\n').length + 5);
  });

  it('提取多行签名，截断签名不借用后续定义的注解', () => {
    const source = [
      'def multiline(', '    value: int,', '    other: str,', ') -> Result:', '    pass',
      'def broken(', '    value: int,', 'def next_method() -> Next:', '    pass',
      'def incomplete() -> Missing'
    ].join('\n');
    expect([...extractFileReturnAnnotations(source)]).toEqual([
      ['multiline', 'Result'], ['next_method', 'Next']
    ]);
  });

  it('项目索引保留文件顺序和文件内首次定义规则', () => {
    const index = buildReturnAnnotationIndex([
      'def missing():\n    pass\ndef missing() -> Ignored:\n    pass\ndef value() -> First:\n    pass\n',
      'def missing(\n    arg: int,\n) -> Found:\n    pass\ndef value() -> Second:\n    pass\n'
    ]);
    expect([...index]).toEqual([['value', 'First'], ['missing', 'Found']]);
  });

  it('JSONDATA 正例:data = activity_data.get_data() → data: JSONDATA,标注来源', async () => {
    const { put } = setupWorkspace();
    put(
      'scripts/entity/Activity.py',
      'class Activity:\n    def get_data(self) -> JSONDATA:\n        return None\n'
    );
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        data = activity_data.get_data()\n        return data\n',
      path.join(workspace.workspaceFolders![0].uri.fsPath, 'scripts/base/Avatar.py')
    );
    await resolveLocalVariableReturnType(doc.getText().split(/\r?\n/), 2, 'data', workspace.workspaceFolders![0].uri.fsPath);
    const text = hoverText(
      await Promise.resolve(provider.provideHover(doc, new Position(2, 8))) // 光标在 data 上
    );
    expect(text).toContain('**data: JSONDATA**');
    expect(text).toContain('推导自 get_data() 返回注解');
  });

  it('无注解不显示:def 无 `->` → 无 data 提示、无 Any 残留', async () => {
    const { put } = setupWorkspace();
    put('scripts/entity/Activity.py', 'class Activity:\n    def get_data(self):\n        return None\n');
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        data = activity_data.get_data()\n',
      path.join(workspace.workspaceFolders![0].uri.fsPath, 'scripts/base/Avatar.py')
    );
    const text = hoverText(
      await Promise.resolve(provider.provideHover(doc, new Position(2, 8)))
    );
    expect(text).not.toContain('data:');
    expect(text).not.toContain('Any');
  });

  it('同名重赋值取最后一次可解析值:先可解析后不可解析 → 仍取 JSONDATA', async () => {
    const { put } = setupWorkspace();
    put(
      'scripts/entity/Activity.py',
      'class Activity:\n    def get_data(self) -> JSONDATA:\n        return None\n'
    );
    put('scripts/entity/Loader.py', 'class Loader:\n    def load(self):\n        return None\n');
    const doc = pyDoc(
      'class Avatar:\n    def tick(self, activity_data, loader):\n        data = activity_data.get_data()\n        data = loader.load()\n        return data\n',
      path.join(workspace.workspaceFolders![0].uri.fsPath, 'scripts/base/Avatar.py')
    );
    // 纯逻辑直接验:自 hover 行向上,末条赋值 load() 无注解 → 回退取 get_data()
    const annotation = await resolveLocalVariableReturnType(
      doc.getText().split(/\r?\n/),
      4,
      'data',
      workspace.workspaceFolders![0].uri.fsPath
    );
    expect(annotation).toMatchObject({ target: 'data', annotation: 'JSONDATA', methodName: 'get_data' });
  });
});

describe('三提示面无 Any(能推才显闸)', () => {
  it('内建属性 hover:Any 位(自 allClients)不显示类型段;已知位照常', () => {
    const cellProps = getEntityBuiltinPropertiesForFace('cellapp');
    const allClients = cellProps.find(item => item.name === 'allClients')!;
    expect(allClients.type).toBe('Any'); // 数据表保留事实位
    expect(formatEntityBuiltinPropertyHeadline('allClients', 'cellapp', allClients))
      .toBe('**self.allClients** — cellapp面 · 只读');
    const position = cellProps.find(item => item.name === 'position')!;
    expect(formatEntityBuiltinPropertyHeadline('position', 'cellapp', position))
      .toBe('**self.position: Vector3Like** — cellapp面 · 可写');
  });

  it('内建属性补全:Any 位 label 右列无类型;已知位仍出类型', async () => {
    setupWorkspace();
    const provider = new KBEngineCompletionProvider(makeManager());
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const items = provider.provideCompletionItems(doc, new Position(2, '        self.'.length));
    const list = items as Array<{ label: { label: string; description?: string }; detail?: string; kind?: number }>;
    const allClients = list.find(item => item.label.label === 'allClients');
    const otherClients = list.find(item => item.label.label === 'otherClients');
    const controlledBy = list.find(item => item.label.label === 'controlledBy');
    const volatileInfo = list.find(item => item.label.label === 'volatileInfo');
    for (const anySlot of [allClients, otherClients, controlledBy, volatileInfo]) {
      expect(anySlot).toBeDefined();
      expect(anySlot!.label.description ?? '').toBe('');
    }
    const position = list.find(item => item.label.label === 'position');
    expect(position?.label.description).toBe('Vector3Like');
    expect(list.every(item => item.kind === CompletionItemKind.Property)).toBe(true);
  });

  it('内建属性 inlay:Any 位不出 hint;已知位仍出;全文档无 Any 文本', async () => {
    setupWorkspace();
    const provider = new KBEngineBuiltinTypeInlayHintsProvider(makeManager());
    const doc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.volatileInfo = None\n        self.position = (1, 2, 3)\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const hints = (await provider.provideInlayHints(
      doc as never,
      new Range(new Position(0, 0), new Position(99, 0))
    )) as unknown as Array<{ label: string; kind: number }>;
    const labels = hints.map(hint => hint.label);
    expect(labels).toContain(': Vector3Like');
    expect(labels.join('\n')).not.toContain('Any');
    expect(hints.every(hint => hint.kind === InlayHintKind.Type)).toBe(true);
  });

  it('def 方法签名(声明面 hover/补全 detail 同源):未知 <Arg> 类型只出名不显 Any', async () => {
    setupWorkspace();
    const provider = new KBEngineHoverProvider(makeManager());
    // 未知类型 FOO 经解析链落 Any → 形参只出名(无 `: Any`)
    const doc = pyDoc(
      'class Avatar:\n    def custom(self, arg1):\n        pass\n',
      '/proj/scripts/base/Avatar.py'
    );
    const text = hoverText(
      await Promise.resolve(provider.provideHover(doc, new Position(1, 9)))
    );
    // 未知类型不接管 def 声明标注时落回普通链,也不得出现 Any
    expect(text).not.toContain('Any');
  });
});

describe('IDE-HOV-011 按文档版本更新当前文件注解', () => {
  it('未保存的注解变化经受控异步发布进入当前文件桶:发布后同文件 hover 见新值,不等磁盘与 TTL', async () => {
    const { root, put } = setupWorkspace();
    // 磁盘仍是旧值 JSONDATA;文档未保存改为 OTHERDATA
    put('main.py', 'def get_data() -> JSONDATA:\n    pass\n\ndata = get_data()\n');
    const provider = new KBEngineHoverProvider(makeManager());
    const docV1 = makeTextDocument(
      'def get_data() -> JSONDATA:\n    pass\n\ndata = get_data()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    // IDE-REV-010:hover 只读已发布桶并触发受控异步更新;发布后查询可见
    await Promise.resolve(provider.provideHover(docV1, new Position(3, 1)));
    await flushPendingDocumentReturnAnnotationsForTests();
    const v1 = hoverText(await Promise.resolve(provider.provideHover(docV1, new Position(3, 1))));
    expect(v1).toContain('**data: JSONDATA**');
    const docV2 = makeTextDocument(
      'def get_data() -> OTHERDATA:\n    pass\n\ndata = get_data()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 2 }
    );
    await Promise.resolve(provider.provideHover(docV2, new Position(3, 1)));
    await flushPendingDocumentReturnAnnotationsForTests();
    const v2 = hoverText(await Promise.resolve(provider.provideHover(docV2, new Position(3, 1))));
    expect(v2).toContain('**data: OTHERDATA**');
  });

  it('旧版本/同版本不得覆盖新版本,且仅在版本前进时读取全文', () => {
    const { root } = setupWorkspace();
    // 无工作区根(未归属任何 folder 的文档)不建桶也不抛
    updateDocumentReturnAnnotations(null, { fileKey: 'file:///orphan.py', version: 1, source: () => '' });
    releaseDocumentReturnAnnotations(null, 'file:///orphan.py');
    const sourceV1 = vi.fn(() => 'def get_data() -> ONE:\n    pass\n');
    updateDocumentReturnAnnotations(root, { fileKey: 'file:///a.py', version: 1, source: sourceV1 });
    expect(sourceV1).toHaveBeenCalledTimes(1);
    const sourceV3 = vi.fn(() => 'def get_data() -> THREE:\n    pass\n');
    updateDocumentReturnAnnotations(root, { fileKey: 'file:///a.py', version: 3, source: sourceV3 });
    expect(sourceV3).toHaveBeenCalledTimes(1);
    // 旧版本(2<3)与同版本(3=3)都不重提取、不覆盖
    const sourceStale = vi.fn(() => 'def get_data() -> STALE:\n    pass\n');
    updateDocumentReturnAnnotations(root, { fileKey: 'file:///a.py', version: 2, source: sourceStale });
    expect(sourceStale).not.toHaveBeenCalled();
    const sourceSame = vi.fn(() => 'def get_data() -> SAME:\n    pass\n');
    updateDocumentReturnAnnotations(root, { fileKey: 'file:///a.py', version: 3, source: sourceSame });
    expect(sourceSame).not.toHaveBeenCalled();
    const resolved = resolveLocalVariableReturnTypeFromSnapshot(
      ['data = get_data()'], 0, 'data', root,
      { fileKey: 'file:///a.py', version: 3, source: () => '' }
    );
    expect(resolved).toMatchObject({ annotation: 'THREE' });
  });

  it('删除注解(def 在而注解缺)立即遮蔽磁盘旧注解,不借旧值', async () => {
    const { root, put } = setupWorkspace();
    put('main.py', 'def get_data() -> JSONDATA:\n    pass\n\ndata = get_data()\n');
    // 磁盘索引就绪(旧值 JSONDATA 已可解析)
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    // 正例前置:注解在时(同文件 v1)确实显示——证明删除后的「不显」是遮蔽生效而非链路断
    const docV1 = makeTextDocument(
      'def get_data() -> JSONDATA:\n    pass\n\ndata = get_data()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    const v1 = hoverText(await Promise.resolve(provider.provideHover(docV1, new Position(3, 1))));
    expect(v1).toContain('**data: JSONDATA**');
    const docV2 = makeTextDocument(
      'def get_data():\n    pass\n\ndata = get_data()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 2 }
    );
    // IDE-REV-010:删除注解的变化同样经受控异步发布;发布后遮蔽生效
    await Promise.resolve(provider.provideHover(docV2, new Position(3, 1)));
    await flushPendingDocumentReturnAnnotationsForTests();
    const text = hoverText(await Promise.resolve(provider.provideHover(docV2, new Position(3, 1))));
    expect(text).not.toContain('JSONDATA');
    expect(text).not.toContain('推导自');
  });

  it('其他打开文档的未保存注解同样遮蔽磁盘旧值', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///svc.py', version: 2,
      source: () => 'def get_data() -> OTHER:\n    pass\n'
    });
    const resolved = resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root);
    expect(resolved).toMatchObject({ annotation: 'OTHER' });
  });

  it('关闭文档弃桶:回到磁盘口径(未保存修改随关闭消失)', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///svc.py', version: 2,
      source: () => 'def get_data() -> OTHER:\n    pass\n'
    });
    releaseDocumentReturnAnnotations(root, 'file:///svc.py');
    const resolved = resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root);
    expect(resolved).toMatchObject({ annotation: 'JSONDATA' });
  });
});

describe('IDE-REV-010:首次 hover 不做同步整文件注解提取', () => {
  it('大文件首次 hover 同步段零 source() 调用(只读已发布桶),发布后能查到新注解', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    // 磁盘索引就绪(旧值 JSONDATA);文档未保存改为 OTHERDATA(大文件:候选后垫注释行)
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const pad = 'x'.repeat(120);
    const bigSource = [
      'def get_data() -> OTHERDATA:',
      '    pass',
      'data = get_data()',
      ...Array.from({ length: 4000 }, (_, i) => `# pad-${i} ${pad}`)
    ].join('\n');
    let sourceCalls = 0;
    const first = resolveLocalVariableReturnTypeFromSnapshot(
      bigSource.split('\n'), 2, 'data', root,
      { fileKey: 'file:///main.py', version: 1, source: () => { sourceCalls += 1; return bigSource; } }
    );
    // 同步段零提取:source() 未被调用(修复前红:同步整文件提取在此处即调),
    // 本轮回磁盘旧值(JSONDATA),冷版本交受控异步更新
    expect(sourceCalls).toBe(0);
    expect(first).toMatchObject({ annotation: 'JSONDATA' });

    // 受控异步更新发布后,新注解可查(发布后能查到新注解)
    await flushPendingDocumentReturnAnnotationsForTests();
    const second = resolveLocalVariableReturnTypeFromSnapshot(
      bigSource.split('\n'), 2, 'data', root,
      { fileKey: 'file:///main.py', version: 1, source: () => { sourceCalls += 1; return bigSource; } }
    );
    expect(second).toMatchObject({ annotation: 'OTHERDATA' });
  });

  it('编辑后立即 hover 同步段零提取;发布后见新值;旧版本不覆盖', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const ctx = (version: number, text: string, counter: { calls: number }) => ({
      fileKey: 'file:///main.py',
      version,
      source: (): string => { counter.calls += 1; return text; }
    });
    const v2 = { calls: 0 };
    // 编辑(v2,THIRDDATA)后立即 hover:同步段零提取
    const text2 = 'def get_data() -> THIRDDATA:\n    pass\n\ndata = get_data()\n';
    const immediate = resolveLocalVariableReturnTypeFromSnapshot(
      text2.split('\n'), 3, 'data', root, ctx(2, text2, v2)
    );
    expect(v2.calls).toBe(0);
    expect(immediate).toMatchObject({ annotation: 'JSONDATA' }); // 旧桶未发布,回磁盘旧值
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      text2.split('\n'), 3, 'data', root, ctx(2, text2, { calls: 0 })
    )).toMatchObject({ annotation: 'THIRDDATA' });

    // 旧版本(v1,STALE)不能覆盖已发布的 v2:提取前版本闸拒绝(source 零调用)
    const stale = { calls: 0 };
    const text1 = 'def get_data() -> STALE:\n    pass\n\ndata = get_data()\n';
    resolveLocalVariableReturnTypeFromSnapshot(
      text1.split('\n'), 3, 'data', root, ctx(1, text1, stale)
    );
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(stale.calls).toBe(0);
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      text2.split('\n'), 3, 'data', root, ctx(2, text2, { calls: 0 })
    )).toMatchObject({ annotation: 'THIRDDATA' });
  });
});

describe('IDE-HOV-012 保存文件时只替换该文件注解桶', () => {
  it('保存删除注解后不再可查,且不重读任何文件(纯内存换桶)', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    put('other.py', 'def load_all() -> PAYLOAD:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const read = vi.spyOn(fs.promises, 'readFile');
    applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data():\n    pass\n');
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root)).toBeNull();
    // 其他文件桶未动:load_all 仍可查
    expect(resolveLocalVariableReturnTypeFromSnapshot(['x = load_all()'], 0, 'x', root))
      .toMatchObject({ annotation: 'PAYLOAD' });
  });

  it('保存新注解即时并入合并视图(换桶后取新值)', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data():\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root)).toBeNull();
    applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data() -> FRESH:\n    pass\n');
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
      .toMatchObject({ annotation: 'FRESH' });
  });

  it('新文件保存后新增注解桶:可查其注解,目录发现不重跑', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    // 索引就绪时 extra.py 尚不存在(不在任何桶里)
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const read = vi.spyOn(fs.promises, 'readFile');
    const readdir = vi.spyOn(fs.promises, 'readdir');
    applySavedFileAnnotations(root, path.join(root, 'extra.py'), 'def load_all() -> PAYLOAD:\n    pass\n');
    expect(read).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
    read.mockRestore();
    readdir.mockRestore();
    expect(resolveLocalVariableReturnTypeFromSnapshot(['x = load_all()'], 0, 'x', root))
      .toMatchObject({ annotation: 'PAYLOAD' });
    // 既有桶不受新桶影响
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
      .toMatchObject({ annotation: 'JSONDATA' });
  });

  it('冷缓存无桶可换为 no-op:不虚建部分索引', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data() -> STALE:\n    pass\n');
    const built = await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    expect(built).toMatchObject({ annotation: 'JSONDATA' });
  });
});

describe('IDE-HOV-014 删除文件时移除注解桶', () => {
  it('删除后该来源注解消失,其他同名方法来源仍存在(纯内存,零文件读取)', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def load_all() -> SVC:\n    pass\n\ndef only_svc() -> SVCONLY:\n    pass\n');
    put('other.py', 'def load_all() -> PAYLOAD:\n    pass\n');
    await resolveLocalVariableReturnType(['x = load_all()'], 0, 'x', root);
    // 正例前置:两来源在册(目录扫描次序不保证,load_all 命中其一即可)
    expect(resolveLocalVariableReturnTypeFromSnapshot(['x = load_all()'], 0, 'x', root))
      .toMatchObject({ target: 'x', methodName: 'load_all' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(['y = only_svc()'], 0, 'y', root))
      .toMatchObject({ annotation: 'SVCONLY' });
    const read = vi.spyOn(fs.promises, 'readFile');
    removeSavedFileAnnotations(root, path.join(root, 'svc.py'));
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(resolveLocalVariableReturnTypeFromSnapshot(['x = load_all()'], 0, 'x', root))
      .toMatchObject({ annotation: 'PAYLOAD' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(['y = only_svc()'], 0, 'y', root)).toBeNull();
  });

  it('冷缓存删除为 no-op:不虚建索引,下一次查询按磁盘真量全量建', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    removeSavedFileAnnotations(root, path.join(root, 'svc.py'));
    const built = await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    expect(built).toMatchObject({ annotation: 'JSONDATA' });
  });

  it('删不在册的文件路径为 no-op:不抛不动', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    removeSavedFileAnnotations(root, path.join(root, 'never_scanned.py'));
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
      .toMatchObject({ annotation: 'JSONDATA' });
  });
});

describe('IDE-HOV-015 重命名文件时迁移注解来源', () => {
  it('迁移保内容保次序:新 URI 承接桶,旧 URI 不留双份', async () => {
    const { root, put } = setupWorkspace();
    put('a.py', 'def dup() -> FROM_A:\n    pass\n\ndef a_only() -> A:\n    pass\n');
    put('svc.py', 'def dup() -> FROM_SVC:\n    pass\n\ndef only_svc() -> SVCONLY:\n    pass\n');
    await resolveLocalVariableReturnType(['x = dup()'], 0, 'x', root);
    const before = resolveLocalVariableReturnTypeFromSnapshot(['x = dup()'], 0, 'x', root)!;
    expect(before).toMatchObject({ target: 'x', methodName: 'dup' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(['y = only_svc()'], 0, 'y', root))
      .toMatchObject({ annotation: 'SVCONLY' });
    const read = vi.spyOn(fs.promises, 'readFile');
    renameSavedFileAnnotations(root, path.join(root, 'svc.py'), path.join(root, 'svc2.py'));
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    // 迁移后:合并次序不变(dup 仍解析同源)、独有注解仍可查(承接不丢)
    expect(resolveLocalVariableReturnTypeFromSnapshot(['x = dup()'], 0, 'x', root))
      .toMatchObject({ annotation: before.annotation });
    expect(resolveLocalVariableReturnTypeFromSnapshot(['y = only_svc()'], 0, 'y', root))
      .toMatchObject({ annotation: 'SVCONLY' });
    // 弃新桶后 dup 只剩 a.py 来源、独有注解落空——证明旧 svc.py 桶未残留双份
    removeSavedFileAnnotations(root, path.join(root, 'svc2.py'));
    expect(resolveLocalVariableReturnTypeFromSnapshot(['x = dup()'], 0, 'x', root))
      .toMatchObject({ annotation: 'FROM_A' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(['y = only_svc()'], 0, 'y', root)).toBeNull();
  });

  it('保存改写走新 URI:旧 URI 不再是活桶', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    renameSavedFileAnnotations(root, path.join(root, 'svc.py'), path.join(root, 'svc2.py'));
    applySavedFileAnnotations(root, path.join(root, 'svc2.py'), 'def get_data() -> FRESH:\n    pass\n');
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
      .toMatchObject({ annotation: 'FRESH' });
  });

  it('冷缓存与不在册路径均为 no-op', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    renameSavedFileAnnotations(null, '/x/old.py', '/x/new.py');
    renameSavedFileAnnotations(root, path.join(root, 'svc.py'), path.join(root, 'svc2.py'));
    const built = await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    expect(built).toMatchObject({ annotation: 'JSONDATA' });
    renameSavedFileAnnotations(root, path.join(root, 'ghost.py'), path.join(root, 'ghost2.py'));
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
      .toMatchObject({ annotation: 'JSONDATA' });
  });
});

describe('IDE-HOV-016 按当前文件限定返回注解候选', () => {
  it('同文件明确声明优先于项目无关同名方法', async () => {
    const { root, put } = setupWorkspace();
    put('main.py', 'def get_data() -> LOCAL:\n    pass\n\ndata = get_data()\n');
    put('other.py', 'def get_data() -> REMOTE:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'def get_data() -> LOCAL:\n    pass\n\ndata = get_data()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    const text = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(3, 1))));
    expect(text).toContain('**data: LOCAL**');
    expect(text).not.toContain('REMOTE');
  });

  it('不跨作用域借用赋值:兄弟方法内的同名赋值不接管', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'class Avatar:\n'
      + '    def a(self):\n'
      + '        data = get_data()\n'
      + '\n'
      + '    def b(self):\n'
      + '        return data\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    // 正例前置:a() 内同作用域赋值可推,证明链路通(否则下面的「不显」是链路断)
    const inA = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(2, 9))));
    expect(inA).toContain('**data: JSONDATA**');
    // 兄弟方法 b() 内不借 a() 的赋值:不显示任何推导类型
    const inB = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(5, 16))));
    expect(inB).not.toContain('JSONDATA');
    expect(inB).not.toContain('推导自');
  });
});

describe('IDE-HOV-017 按显式 import 限定返回注解候选', () => {
  it('from 导入绑定只解析到对应模块,不借项目无关同名方法', async () => {
    const { root, put } = setupWorkspace();
    put('helpers.py', 'def load_all() -> FROM_HELPERS:\n    pass\n');
    put('unrelated.py', 'def load_all() -> FROM_UNRELATED:\n    pass\n');
    put('main.py', 'from helpers import load_all\n\ndata = load_all()\n');
    await resolveLocalVariableReturnType(['data = load_all()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'from helpers import load_all\n\ndata = load_all()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    const text = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(2, 1))));
    expect(text).toContain('**data: FROM_HELPERS**');
    expect(text).not.toContain('FROM_UNRELATED');
  });

  it('绑定模块内无注解不回退全局:同名无关方法不顶替', async () => {
    const { root, put } = setupWorkspace();
    put('helpers.py', 'def load_all():\n    pass\n');
    put('unrelated.py', 'def load_all() -> FROM_UNRELATED:\n    pass\n');
    await resolveLocalVariableReturnType(['data = load_all()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'from helpers import load_all\n\ndata = load_all()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    const text = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(2, 1))));
    expect(text).not.toContain('FROM_UNRELATED');
    expect(text).not.toContain('推导自');
  });

  it('import 接收者绑定:X.fn() 只查 X 模块;X 未定义该方法则不显', async () => {
    const { root, put } = setupWorkspace();
    put('helpers.py', 'def get_all() -> HELP:\n    pass\n');
    put('unrelated.py', 'def get_all() -> NOISE:\n    pass\n');
    await resolveLocalVariableReturnType(['data = helpers.get_all()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const bound = makeTextDocument(
      'import helpers\n\ndata = helpers.get_all()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    const text = hoverText(await Promise.resolve(provider.provideHover(bound, new Position(2, 1))));
    expect(text).toContain('**data: HELP**');
    expect(text).not.toContain('NOISE');
    const missing = makeTextDocument(
      'import helpers\n\ndata = helpers.absent_all()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 2 }
    );
    const textMissing = hoverText(await Promise.resolve(provider.provideHover(missing, new Position(2, 1))));
    expect(textMissing).not.toContain('NOISE');
    expect(textMissing).not.toContain('推导自');
  });

  it('同名模块多处无法确定时返回未知:不显任何类型', async () => {
    const { root, put } = setupWorkspace();
    put('a/helpers.py', 'def load_all() -> AMBIG_A:\n    pass\n');
    put('b/helpers.py', 'def load_all() -> AMBIG_B:\n    pass\n');
    await resolveLocalVariableReturnType(['data = load_all()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'from helpers import load_all\n\ndata = load_all()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    const text = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(2, 1))));
    expect(text).not.toContain('AMBIG');
    expect(text).not.toContain('推导自');
  });
});

// 2026-10-28 审核整改(HOV-012/014/015 竞态 + TTL 次序):三个文件事件面在
// 「首扫在途、缓存未发布」时直接 return,窗口内的保存/删除/重命名被丢弃,
// 发布用的是扫描期读到的旧内容 → 陈旧注解驻留;快照面 TTL 过期检查又在
// 命中返回之后,过期旧值可无限命中。门住首个目录枚举制造确定性在途窗口。
describe('2026-10-28 审核整改:首扫在途窗口内的文件事件不被丢弃', () => {
  /** 门住首扫的第一次 readdir,返回放行(并还原 spy)函数 */
  const gateFirstScan = (): (() => void) => {
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let gating = true;
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(
      (async (...args: unknown[]) => {
        if (gating) { gating = false; await gate; }
        return await realReaddir(...(args as Parameters<typeof fs.promises.readdir>));
      }) as unknown as typeof fs.promises.readdir
    );
    return () => {
      release();
      spy.mockRestore();
    };
  };

  it('保存(HOV-012):首扫在途的换桶在发布时生效,扫描期旧读不吞新注解', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> OLD:\n    pass\n');
    const release = gateFirstScan();
    const pending = resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data() -> FRESH:\n    pass\n');
    release();
    const resolved = await pending;
    expect(resolved).toMatchObject({ annotation: 'FRESH' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
      .toMatchObject({ annotation: 'FRESH' });
  });

  it('删除(HOV-014):首扫在途的弃桶在发布时生效,已删文件注解不再可查', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def only_svc() -> PAYLOAD:\n    pass\n');
    const release = gateFirstScan();
    const pending = resolveLocalVariableReturnType(['y = only_svc()'], 0, 'y', root);
    removeSavedFileAnnotations(root, path.join(root, 'svc.py'));
    release();
    expect(await pending).toBeNull();
    expect(resolveLocalVariableReturnTypeFromSnapshot(['y = only_svc()'], 0, 'y', root)).toBeNull();
  });

  it('重命名(HOV-015):首扫在途的迁键在发布时生效,import 绑定按新模块命中', async () => {
    const { root, put } = setupWorkspace();
    put('a.py', 'def get_data() -> FROM_A:\n    pass\n');
    const release = gateFirstScan();
    const lines = ['from b import get_data', 'data = get_data()'];
    const pending = resolveLocalVariableReturnType(lines, 1, 'data', root);
    renameSavedFileAnnotations(root, path.join(root, 'a.py'), path.join(root, 'b.py'));
    release();
    await pending; // 发布完成后再断言
    // 迁键被吞时桶仍挂旧键 a.py:绑定模块 b 找不到桶 → 不回退全局 → null
    expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'data', root))
      .toMatchObject({ annotation: 'FROM_A' });
  });
});

/** 门住第二次目录枚举(重建的 readdir;首次已被预热消耗),返回放行函数
 * (REV-006/007 共用:制造「预热已发布,TTL 重建在途」的确定性窗口) */
const gateRebuildScan = (): (() => void) => {
  const realReaddir = fs.promises.readdir.bind(fs.promises);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let scans = 0;
  const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(
    (async (...args: unknown[]) => {
      scans += 1;
      if (scans === 2) { await gate; }
      return await realReaddir(...(args as Parameters<typeof fs.promises.readdir>));
    }) as unknown as typeof fs.promises.readdir
  );
  return () => {
    release();
    spy.mockRestore();
  };
};

// IDE-REV-006:TTL 过期重建在途时,已有缓存走「立即换桶」臂,保存事件不进
// pendingFileEvents——重建的扫描期旧读在发布时覆盖本次保存,新值被吞。预热
// →TTL 过期→门住重建的目录枚举→窗口内保存→释放,发布快照只含新值。
describe('IDE-REV-006:TTL 重建在途窗口内的保存事件不被覆盖', () => {
  it('预热→TTL 过期→门住旧内容读取→保存新注解→释放重建:新快照只含新值', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> OLD:\n    pass\n');
    put('other.py', 'def other_fn() -> OTHER_VAL:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root); // 预热发布
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      const release = gateRebuildScan(); // 门住重建:扫描期读到的磁盘内容仍是 OLD
      const pending = resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
      applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data() -> FRESH:\n    pass\n');
      release();
      const resolved = await pending;
      // 重建发布必须重放窗口内保存:旧读的 OLD 不得覆盖 FRESH
      expect(resolved).toMatchObject({ annotation: 'FRESH' });
      expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
        .toMatchObject({ annotation: 'FRESH' });
      // 单文件保存不动其他文件桶:other 的注解原样可查
      expect(resolveLocalVariableReturnTypeFromSnapshot(['y = other_fn()'], 0, 'y', root))
        .toMatchObject({ annotation: 'OTHER_VAL' });
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// IDE-REV-007:同族删除面——预热后 TTL 重建在途,窗口内删除的文件桶在发布
// 时不得复活(旧读重扫会把它带回来);其他同名来源按合并序兜底。
describe('IDE-REV-007:TTL 重建在途窗口内的删除事件不复活来源', () => {
  it('预热→门住重建→删除→释放:该来源不再可查,其他同名来源兜底', async () => {
    const { root, put } = setupWorkspace();
    put('a.py', 'def get_data() -> FROM_A:\n    pass\n');
    put('b.py', 'def get_data() -> FROM_B:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root); // 预热发布
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      const release = gateRebuildScan(); // 门住重建:扫描期仍读到 a.py(旧读)
      const pending = resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
      removeSavedFileAnnotations(root, path.join(root, 'a.py'));
      release();
      const resolved = await pending;
      // a.py 来源不得复活;同名方法由 b.py 来源兜底
      expect(resolved).toMatchObject({ annotation: 'FROM_B' });
      expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
        .toMatchObject({ annotation: 'FROM_B' });
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// IDE-REV-008:同族重命名面——预热后 TTL 重建在途,窗口内迁键的桶在发布时
// 不得把旧键带回来(旧模块不再命中、新模块可查、来源不重复);连续
// 保存/重命名事件按到达序重放。
describe('IDE-REV-008:TTL 重建在途窗口内的重命名事件不复活旧键', () => {
  it('预热→门住重建→重命名→释放:旧模块不命中,新模块可查,来源不重复', async () => {
    const { root, put } = setupWorkspace();
    put('a.py', 'def get_data() -> FROM_A:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root); // 预热发布
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      const release = gateRebuildScan(); // 门住重建:扫描期仍读到 a.py 旧路径
      const lines = ['from b import get_data', 'data = get_data()'];
      const pending = resolveLocalVariableReturnType(lines, 1, 'data', root);
      renameSavedFileAnnotations(root, path.join(root, 'a.py'), path.join(root, 'b.py'));
      release();
      await pending; // 发布完成后再断言
      // 新模块可查(内容承接),旧模块不再命中(桶已迁走),两键不同并存
      expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'data', root))
        .toMatchObject({ annotation: 'FROM_A' });
      expect(resolveLocalVariableReturnTypeFromSnapshot(
        ['from a import get_data', 'data = get_data()'], 1, 'data', root
      )).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('窗口内连续事件:先重命名后保存,发布按到达序重放', async () => {
    const { root, put } = setupWorkspace();
    put('a.py', 'def get_data() -> FROM_A:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root); // 预热发布
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      const release = gateRebuildScan();
      const lines = ['from b import get_data', 'data = get_data()'];
      const pending = resolveLocalVariableReturnType(lines, 1, 'data', root);
      renameSavedFileAnnotations(root, path.join(root, 'a.py'), path.join(root, 'b.py'));
      applySavedFileAnnotations(root, path.join(root, 'b.py'), 'def get_data() -> SAVED_AT_B:\n    pass\n');
      release();
      await pending;
      // 到达序重放:迁键后落新源,b 桶以最后保存为准;旧键不复活
      expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'data', root))
        .toMatchObject({ annotation: 'SAVED_AT_B' });
      expect(resolveLocalVariableReturnTypeFromSnapshot(
        ['from a import get_data', 'data = get_data()'], 1, 'data', root
      )).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('2026-10-28 审核整改:过期磁盘索引不得继续答', () => {
  it('TTL 过期后快照面不再从磁盘旧注解答', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> OLD:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const now = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      // 命中前先过期:磁盘 OLD 不得再答(原 TTL 检查在命中返回之后)
      expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
        .toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});

// 2026-10-28 审核整改(HOV-017 补漏):`import pkg.good as g` 是合法 Python
// (子模块带别名),原 BARE_IMPORT_PATTERN 只认单段模块名,该行不匹配 → g
// 未入 receivers → `g.get_data()` 落回全局同名方法,可能给出错误注解。
describe('2026-10-28 审核整改:import 子模块别名绑定不回退全局', () => {
  it('import pkg.good as g:g.get_data() 只解析到 pkg/good.py,不借全局同名', async () => {
    const { root, put } = setupWorkspace();
    // 全局序 other.py 在前:全局 get_data=NOISE(绑定失效时的错误回退值)
    put('other.py', 'def get_data() -> NOISE:\n    pass\n');
    put('pkg/good.py', 'def get_data() -> FROM_SUB:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const lines = ['import pkg.good as g', 'data = g.get_data()'];
    expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'data', root))
      .toMatchObject({ annotation: 'FROM_SUB' });
  });

  it('绑定模块无该方法时不回退全局:未知即未知', async () => {
    const { root, put } = setupWorkspace();
    put('other.py', 'def load_all() -> NOISE:\n    pass\n');
    put('pkg/good.py', 'def other_fn() -> FROM_SUB:\n    pass\n');
    await resolveLocalVariableReturnType(['x = load_all()'], 0, 'x', root);
    const lines = ['import pkg.good as g', 'x = g.load_all()'];
    expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'x', root)).toBeNull();
  });
});
