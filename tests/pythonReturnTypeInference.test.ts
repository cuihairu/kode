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
  collectProjectPythonFiles,
  extractFileReturnAnnotations,
  extractFileReturnAnnotationsAsync,
  flushPendingDocumentReturnAnnotationsForTests,
  getDocumentReturnAnnotationBucketForTests,
  releaseDocumentReturnAnnotations,
  removeSavedFileAnnotations,
  renameSavedFileAnnotations,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType,
  resolveLocalVariableReturnTypeFromSnapshot,
  updateDocumentReturnAnnotations
} from '../src/backend/pythonReturnTypeInference';
import {
  clearRecentAnnotationSourceLogs,
  getRecentAnnotationSourceLogs,
  setAnnotationSourceLogEnabled,
  setAnnotationSourceLogSink
} from '../src/backend/annotationSourceLog';
import {
  formatEntityBuiltinPropertyHeadline,
  getEntityBuiltinPropertiesForFace
} from '../src/backend/entityBuiltinProperties';
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

  it('JSONDATA 正例(接收者不可知):无 import 绑定的同名猜测不再答(级联已删,批 D)', async () => {
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
    // 预热磁盘索引:证明「索引在场也不再猜名」——get_data 无绑定、接收者
    // activity_data 不可定型 → 不显示(跨类同名误绑是批 D 删除的误导面;
    // 同文件可推导子集由 Rust localReturnType 面接收者定型接住)
    await resolveLocalVariableReturnType(doc.getText().split(/\r?\n/), 2, 'data', workspace.workspaceFolders![0].uri.fsPath);
    const text = hoverText(
      await Promise.resolve(provider.provideHover(doc, new Position(2, 8))) // 光标在 data 上
    );
    expect(text).not.toContain('**data:**');
    expect(text).not.toContain('推导自');
  });

  it('JSONDATA import 绑定正例:from 模块显式绑定仍解析(接收者正确路径保留)', async () => {
    const { put } = setupWorkspace();
    put(
      'scripts/entity/Activity.py',
      'class Activity:\n    def get_data(self) -> JSONDATA:\n        return None\n'
    );
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = pyDoc(
      'from scripts.entity.Activity import get_data\n\ndata = get_data()\n',
      path.join(workspace.workspaceFolders![0].uri.fsPath, 'scripts/base/Avatar.py')
    );
    await resolveLocalVariableReturnType(doc.getText().split(/\r?\n/), 2, 'data', workspace.workspaceFolders![0].uri.fsPath);
    const text = hoverText(
      await Promise.resolve(provider.provideHover(doc, new Position(2, 1)))
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

  it('最后一次写入是未知调用 → 不借早先可解析调用答案(AUD-042)', async () => {
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
    // AUD-042:只认最后一次写入——load() 无注解(未知调用)不借 get_data() 答案
    const annotation = await resolveLocalVariableReturnType(
      doc.getText().split(/\r?\n/),
      4,
      'data',
      workspace.workspaceFolders![0].uri.fsPath
    );
    expect(annotation).toBeNull();
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

describe('IDE-HOV-011 按文档版本更新当前文件注解(批 D:桶发布由文档事件驱动,查询消费面移交 Rust 接收者定型)', () => {
  it('未保存的注解变化经受控异步发布进入当前文件桶:发布后桶见新值,不等磁盘与 TTL', async () => {
    const { root } = setupWorkspace();
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///main.py', version: 1,
      source: () => 'def get_data() -> JSONDATA:\n    pass\n'
    });
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(getDocumentReturnAnnotationBucketForTests(root, 'file:///main.py')?.annotations.get('get_data'))
      .toBe('JSONDATA');
    // 版本前进(未保存编辑)→ 重提取换桶,新值即时入桶
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///main.py', version: 2,
      source: () => 'def get_data() -> OTHERDATA:\n    pass\n'
    });
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(getDocumentReturnAnnotationBucketForTests(root, 'file:///main.py')?.annotations.get('get_data'))
      .toBe('OTHERDATA');
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
    // 桶保持 v3 内容(THREE);批 D 后查询不再读桶,机制断言走桶访问器
    expect(getDocumentReturnAnnotationBucketForTests(root, 'file:///a.py')?.annotations.get('get_data'))
      .toBe('THREE');
  });

  it('删除注解(def 在而注解缺)入桶 unannotatedNames;查询不再借磁盘旧值(级联删除)', async () => {
    const { root, put } = setupWorkspace();
    put('main.py', 'def get_data() -> JSONDATA:\n    pass\n\ndata = get_data()\n');
    // 磁盘索引就绪(旧值 JSONDATA 已可解析)
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    // 删除注解的变化(文档事件驱动)发布后:get_data 入 unannotatedNames(不再有注解)
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///main.py', version: 2,
      source: () => 'def get_data():\n    pass\n\ndata = get_data()\n'
    });
    await flushPendingDocumentReturnAnnotationsForTests();
    const bucket = getDocumentReturnAnnotationBucketForTests(root, 'file:///main.py');
    expect(bucket?.annotations.has('get_data')).toBe(false);
    expect(bucket?.unannotatedNames.has('get_data')).toBe(true);
    // 查询面:无绑定候选不借磁盘旧值(级联已删;同文件推导归 Rust 接收者定型面)
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root)).toBeNull();
  });

  it('关闭文档弃桶:桶随关闭消失;import 绑定查询回磁盘口径(未保存修改随关闭消失)', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///svc.py', version: 2,
      source: () => 'def get_data() -> OTHER:\n    pass\n'
    });
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(getDocumentReturnAnnotationBucketForTests(root, 'file:///svc.py')).toBeDefined();
    releaseDocumentReturnAnnotations(root, 'file:///svc.py');
    expect(getDocumentReturnAnnotationBucketForTests(root, 'file:///svc.py')).toBeUndefined();
    // 绑定查询走磁盘桶:弃桶后即磁盘口径(JSONDATA;OTHER 随关闭消失)
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    )).toMatchObject({ annotation: 'JSONDATA' });
  });
});

describe('IDE-REV-010:查询路零整文件提取(批 D:查询消费面移交 Rust 面,桶发布由文档事件驱动)', () => {
  it('大文件首次查询同步段零 source() 调用(不提取);文档事件发布后桶见新注解', async () => {
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
    // 查询路零提取:source() 未被调用(修复前红:同步整文件提取在此处即调);
    // 批 D 后无 import 绑定 → 诚实 null(不借磁盘旧值猜)
    expect(sourceCalls).toBe(0);
    expect(first).toBeNull();

    // 桶发布改由文档事件驱动(非查询触发):发布后桶见新注解
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///main.py', version: 1, source: () => bigSource
    });
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(getDocumentReturnAnnotationBucketForTests(root, 'file:///main.py')?.annotations.get('get_data'))
      .toBe('OTHERDATA');
  });

  it('编辑后立即查询零提取(诚实 null);文档事件发布后桶见新值;旧版本不覆盖', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    // 编辑(v2,THIRDDATA)后立即查询:查询路零提取,无绑定候选 → 诚实 null
    const text2 = 'def get_data() -> THIRDDATA:\n    pass\n\ndata = get_data()\n';
    const sourceV2 = vi.fn(() => text2);
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      text2.split('\n'), 3, 'data', root,
      { fileKey: 'file:///main.py', version: 2, source: sourceV2 }
    )).toBeNull();
    expect(sourceV2).not.toHaveBeenCalled();
    // 桶发布由文档事件驱动:发布后桶见 THIRDDATA
    updateDocumentReturnAnnotations(root, { fileKey: 'file:///main.py', version: 2, source: sourceV2 });
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(sourceV2).toHaveBeenCalledTimes(1);
    expect(getDocumentReturnAnnotationBucketForTests(root, 'file:///main.py')?.annotations.get('get_data'))
      .toBe('THIRDDATA');

    // 旧版本(v1,STALE)不能覆盖已发布的 v2:提取前版本闸拒绝(source 零调用)
    const text1 = 'def get_data() -> STALE:\n    pass\n\ndata = get_data()\n';
    const sourceStale = vi.fn(() => text1);
    updateDocumentReturnAnnotations(root, { fileKey: 'file:///main.py', version: 1, source: sourceStale });
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(sourceStale).not.toHaveBeenCalled();
    expect(getDocumentReturnAnnotationBucketForTests(root, 'file:///main.py')?.annotations.get('get_data'))
      .toBe('THIRDDATA');
  });
});

describe('IDE-HOV-012 保存文件时只替换该文件注解桶(批 D:查询断言走 import 绑定路径)', () => {
  it('保存删除注解后不再可查,且不重读任何文件(纯内存换桶)', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    put('other.py', 'def load_all() -> PAYLOAD:\n    pass\n');
    await resolveLocalVariableReturnType(['from svc import get_data', 'data = get_data()'], 1, 'data', root);
    const read = vi.spyOn(fs.promises, 'readFile');
    applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data():\n    pass\n');
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    )).toBeNull();
    // 其他文件桶未动:load_all 仍可查
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from other import load_all', 'x = load_all()'], 1, 'x', root
    )).toMatchObject({ annotation: 'PAYLOAD' });
  });

  it('保存新注解即时并入合并视图(换桶后取新值)', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data():\n    pass\n');
    await resolveLocalVariableReturnType(['from svc import get_data', 'data = get_data()'], 1, 'data', root);
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    )).toBeNull();
    applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data() -> FRESH:\n    pass\n');
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    )).toMatchObject({ annotation: 'FRESH' });
  });

  it('新文件保存后新增注解桶:可查其注解,目录发现不重跑', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    // 索引就绪时 extra.py 尚不存在(不在任何桶里)
    await resolveLocalVariableReturnType(['from svc import get_data', 'data = get_data()'], 1, 'data', root);
    const read = vi.spyOn(fs.promises, 'readFile');
    const readdir = vi.spyOn(fs.promises, 'readdir');
    applySavedFileAnnotations(root, path.join(root, 'extra.py'), 'def load_all() -> PAYLOAD:\n    pass\n');
    expect(read).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
    read.mockRestore();
    readdir.mockRestore();
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from extra import load_all', 'x = load_all()'], 1, 'x', root
    )).toMatchObject({ annotation: 'PAYLOAD' });
    // 既有桶不受新桶影响
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    )).toMatchObject({ annotation: 'JSONDATA' });
  });

  it('冷缓存无桶可换为 no-op:不虚建部分索引', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data() -> STALE:\n    pass\n');
    const built = await resolveLocalVariableReturnType(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    );
    expect(built).toMatchObject({ annotation: 'JSONDATA' });
  });
});

describe('IDE-HOV-014 删除文件时移除注解桶(批 D:查询断言走 import 绑定路径)', () => {
  it('删除后该来源注解消失,其他同名方法来源仍存在(纯内存,零文件读取)', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def load_all() -> SVC:\n    pass\n\ndef only_svc() -> SVCONLY:\n    pass\n');
    put('other.py', 'def load_all() -> PAYLOAD:\n    pass\n');
    await resolveLocalVariableReturnType(['from svc import load_all', 'x = load_all()'], 1, 'x', root);
    // 正例前置:svc 来源在册(绑定路径接收者正确,不再依赖目录扫描次序)
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import load_all', 'x = load_all()'], 1, 'x', root
    )).toMatchObject({ target: 'x', annotation: 'SVC', methodName: 'load_all' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import only_svc', 'y = only_svc()'], 1, 'y', root
    )).toMatchObject({ annotation: 'SVCONLY' });
    const read = vi.spyOn(fs.promises, 'readFile');
    removeSavedFileAnnotations(root, path.join(root, 'svc.py'));
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    // svc 来源的注解随桶消失;其他同名来源(other.py)不受影响
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import load_all', 'x = load_all()'], 1, 'x', root
    )).toBeNull();
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from other import load_all', 'x = load_all()'], 1, 'x', root
    )).toMatchObject({ annotation: 'PAYLOAD' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import only_svc', 'y = only_svc()'], 1, 'y', root
    )).toBeNull();
  });

  it('冷缓存删除为 no-op:不虚建索引,下一次查询按磁盘真量全量建', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    removeSavedFileAnnotations(root, path.join(root, 'svc.py'));
    const built = await resolveLocalVariableReturnType(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    );
    expect(built).toMatchObject({ annotation: 'JSONDATA' });
  });

  it('删不在册的文件路径为 no-op:不抛不动', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['from svc import get_data', 'data = get_data()'], 1, 'data', root);
    removeSavedFileAnnotations(root, path.join(root, 'never_scanned.py'));
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    )).toMatchObject({ annotation: 'JSONDATA' });
  });
});

describe('IDE-HOV-015 重命名文件时迁移注解来源(批 D:查询断言走 import 绑定路径)', () => {
  it('迁移保内容保次序:新 URI 承接桶,旧 URI 不留双份', async () => {
    const { root, put } = setupWorkspace();
    put('a.py', 'def dup() -> FROM_A:\n    pass\n\ndef a_only() -> A:\n    pass\n');
    put('svc.py', 'def dup() -> FROM_SVC:\n    pass\n\ndef only_svc() -> SVCONLY:\n    pass\n');
    await resolveLocalVariableReturnType(['from svc import dup', 'x = dup()'], 1, 'x', root);
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import dup', 'x = dup()'], 1, 'x', root
    )).toMatchObject({ target: 'x', annotation: 'FROM_SVC', methodName: 'dup' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import only_svc', 'y = only_svc()'], 1, 'y', root
    )).toMatchObject({ annotation: 'SVCONLY' });
    const read = vi.spyOn(fs.promises, 'readFile');
    renameSavedFileAnnotations(root, path.join(root, 'svc.py'), path.join(root, 'svc2.py'));
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    // 迁移后:新模块名承接桶(dup 仍 FROM_SVC)、独有注解仍可查
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc2 import dup', 'x = dup()'], 1, 'x', root
    )).toMatchObject({ annotation: 'FROM_SVC' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc2 import only_svc', 'y = only_svc()'], 1, 'y', root
    )).toMatchObject({ annotation: 'SVCONLY' });
    // 弃新桶后 dup 只剩 a.py 来源、svc 独有注解落空——证明旧 svc.py 桶未残留双份
    removeSavedFileAnnotations(root, path.join(root, 'svc2.py'));
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from a import dup', 'x = dup()'], 1, 'x', root
    )).toMatchObject({ annotation: 'FROM_A' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc2 import only_svc', 'y = only_svc()'], 1, 'y', root
    )).toBeNull();
  });

  it('保存改写走新 URI:旧 URI 不再是活桶', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['from svc import get_data', 'data = get_data()'], 1, 'data', root);
    renameSavedFileAnnotations(root, path.join(root, 'svc.py'), path.join(root, 'svc2.py'));
    applySavedFileAnnotations(root, path.join(root, 'svc2.py'), 'def get_data() -> FRESH:\n    pass\n');
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc2 import get_data', 'data = get_data()'], 1, 'data', root
    )).toMatchObject({ annotation: 'FRESH' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    )).toBeNull();
  });

  it('冷缓存与不在册路径均为 no-op', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    renameSavedFileAnnotations(null, '/x/old.py', '/x/new.py');
    renameSavedFileAnnotations(root, path.join(root, 'svc.py'), path.join(root, 'svc2.py'));
    const built = await resolveLocalVariableReturnType(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    );
    expect(built).toMatchObject({ annotation: 'JSONDATA' });
    renameSavedFileAnnotations(root, path.join(root, 'ghost.py'), path.join(root, 'ghost2.py'));
    expect(resolveLocalVariableReturnTypeFromSnapshot(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    )).toMatchObject({ annotation: 'JSONDATA' });
  });
});

describe('IDE-HOV-016 按当前文件限定返回注解候选(批 D:同文件 def 推导移交 Rust 接收者定型面)', () => {
  it('接收者不可知的同名候选不再借名:同文件 def/项目同名都不答(级联已删)', async () => {
    const { root, put } = setupWorkspace();
    put('main.py', 'def get_data() -> LOCAL:\n    pass\n\ndata = get_data()\n');
    put('other.py', 'def get_data() -> REMOTE:\n    pass\n');
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'def get_data() -> LOCAL:\n    pass\n\ndata = get_data()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    // 批 D:级联兜底已删,TS 链不借名(同文件 def 推导归 Rust 面,单测无 Rust 门)
    const text = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(3, 1))));
    expect(text).not.toContain('LOCAL');
    expect(text).not.toContain('REMOTE');
    expect(text).not.toContain('推导自');
  });

  it('不跨作用域借用赋值:兄弟方法内的同名赋值不接管', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    await resolveLocalVariableReturnType(['from svc import get_data', 'data = get_data()'], 1, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'from svc import get_data\n'
      + '\n'
      + 'class Avatar:\n'
      + '    def a(self):\n'
      + '        data = get_data()\n'
      + '\n'
      + '    def b(self):\n'
      + '        return data\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    // 正例前置:a() 内同作用域赋值可推(import 绑定路径),证明链路通
    const inA = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(4, 9))));
    expect(inA).toContain('**data: JSONDATA**');
    // 兄弟方法 b() 内不借 a() 的赋值:不显示任何推导类型
    const inB = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(7, 16))));
    expect(inB).not.toContain('JSONDATA');
    expect(inB).not.toContain('推导自');
  });
});

describe('IDE-AUD-042 返回类型推导尊重最后一次变量写入(R2-F16)', () => {
  it('最后一次写入是常量 → 不借早先调用答案', async () => {
    const { root, put } = setupWorkspace();
    put('orig.py', 'def original() -> EXPECTED:\n    pass\n');
    const annotation = await resolveLocalVariableReturnType(
      ['x = original()', 'x = 0'],
      1,
      'x',
      root
    );
    expect(annotation).toBeNull();
  });

  it('最后一次写入是未知调用 → 不借早先调用答案', async () => {
    const { root, put } = setupWorkspace();
    put('orig.py', 'def original() -> EXPECTED:\n    pass\n');
    put('noann.py', 'def unknown():\n    pass\n');
    const annotation = await resolveLocalVariableReturnType(
      ['x = original()', 'x = unknown()'],
      1,
      'x',
      root
    );
    expect(annotation).toBeNull();
  });

  it('局部遮蔽不借外层调用的答案', async () => {
    const { root, put } = setupWorkspace();
    put('orig.py', 'def original() -> EXPECTED:\n    pass\n');
    const annotation = await resolveLocalVariableReturnType(
      ['x = original()', 'def f():', '    x = 0', '    return x'],
      3,
      'x',
      root
    );
    expect(annotation).toBeNull();
  });

  it('已知最新调用仍命中(正例前置,证明链路通非"不显"是断)', async () => {
    const { root, put } = setupWorkspace();
    put('orig.py', 'def original() -> EXPECTED:\n    pass\n');
    const annotation = await resolveLocalVariableReturnType(
      ['from orig import original', 'x = original()'],
      1,
      'x',
      root
    );
    expect(annotation).toMatchObject({ target: 'x', annotation: 'EXPECTED', methodName: 'original' });
  });
});

describe('IDE-AUD-043 显式本地无注解声明阻止跨文档借名(R2-F16 后半)', () => {
  it('同文件 original 无注解 → 不借其他打开文件同名注解', () => {
    const { root } = setupWorkspace();
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///main.py',
      version: 1,
      source: () => 'def original():\n    pass\n\nx = original()\n'
    });
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///other.py',
      version: 1,
      source: () => 'def original() -> OTHER_FILE:\n    pass\n'
    });
    const result = resolveLocalVariableReturnTypeFromSnapshot(
      ['def original():', '    pass', '', 'x = original()'],
      3,
      'x',
      root,
      { fileKey: 'file:///main.py', version: 1, source: () => '' }
    );
    expect(result).toBeNull();
  });

  it('本地明确注解不再经 TS 链跨文档回答(级联已删;接收者定型归 Rust 面)', () => {
    const { root } = setupWorkspace();
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///main.py',
      version: 1,
      source: () => 'def original() -> LOCAL:\n    pass\n\nx = original()\n'
    });
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///other.py',
      version: 1,
      source: () => 'def original() -> OTHER_FILE:\n    pass\n'
    });
    // 批 D:TS 链无 import 绑定即诚实 null——同文件 def 推导由 Rust localReturnType
    // 面接住(hover.ts Rust-first 腿),文档桶仍在(机制面)但查询不再消费
    const result = resolveLocalVariableReturnTypeFromSnapshot(
      ['def original() -> LOCAL:', '    pass', '', 'x = original()'],
      3,
      'x',
      root,
      { fileKey: 'file:///main.py', version: 1, source: () => '' }
    );
    expect(result).toBeNull();
  });

  it('同文件无注解也挡磁盘同名注解(不留旧值)', () => {
    const { root, put } = setupWorkspace();
    put('orig.py', 'def original() -> DISK_ANN:\n    pass\n');
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///main.py',
      version: 1,
      source: () => 'def original():\n    pass\n\nx = original()\n'
    });
    // 磁盘索引建成后,本地无注解定义挡住磁盘同名注解(与 shadowed 口径一致)
    const result = resolveLocalVariableReturnTypeFromSnapshot(
      ['def original():', '    pass', '', 'x = original()'],
      3,
      'x',
      root,
      { fileKey: 'file:///main.py', version: 1, source: () => '' }
    );
    expect(result).toBeNull();
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

describe('IDE-AUD-044 导入别名绑定保留原始符号名(R2-F17)', () => {
  it('from mod import original as local → local() 查 original', async () => {
    const { root, put } = setupWorkspace();
    put('helpers.py', 'def load_all() -> FROM_HELPERS:\n    pass\n');
    await resolveLocalVariableReturnType(['data = load()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'from helpers import load_all as load\n\ndata = load()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    const text = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(2, 1))));
    expect(text).toContain('**data: FROM_HELPERS**');
  });

  it('未起别名维持原符号名(正例前置)', async () => {
    const { root, put } = setupWorkspace();
    put('helpers.py', 'def load_all() -> FROM_HELPERS:\n    pass\n');
    await resolveLocalVariableReturnType(['data = load_all()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'from helpers import load_all\n\ndata = load_all()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    const text = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(2, 1))));
    expect(text).toContain('**data: FROM_HELPERS**');
  });

  it('绑定符号在模块内无注解 → 未知,不借邻居同名', async () => {
    const { root, put } = setupWorkspace();
    put('helpers.py', 'def load_all():\n    pass\n');
    put('unrelated.py', 'def load_all() -> NOISE:\n    pass\n');
    await resolveLocalVariableReturnType(['data = load()'], 0, 'data', root);
    const provider = new KBEngineHoverProvider(makeManager());
    const doc = makeTextDocument(
      'from helpers import load_all as load\n\ndata = load()\n',
      { fileName: path.join(root, 'main.py'), languageId: 'python', version: 1 }
    );
    const text = hoverText(await Promise.resolve(provider.provideHover(doc, new Position(2, 1))));
    expect(text).not.toContain('NOISE');
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
    const lines = ['from svc import get_data', 'data = get_data()'];
    const pending = resolveLocalVariableReturnType(lines, 1, 'data', root);
    applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data() -> FRESH:\n    pass\n');
    release();
    const resolved = await pending;
    expect(resolved).toMatchObject({ annotation: 'FRESH' });
    expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'data', root))
      .toMatchObject({ annotation: 'FRESH' });
  });

  it('删除(HOV-014):首扫在途的弃桶在发布时生效,已删文件注解不再可查', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def only_svc() -> PAYLOAD:\n    pass\n');
    const release = gateFirstScan();
    const lines = ['from svc import only_svc', 'y = only_svc()'];
    const pending = resolveLocalVariableReturnType(lines, 1, 'y', root);
    removeSavedFileAnnotations(root, path.join(root, 'svc.py'));
    release();
    expect(await pending).toBeNull();
    expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'y', root)).toBeNull();
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
    const svcLines = ['from svc import get_data', 'data = get_data()'];
    const otherLines = ['from other import other_fn', 'y = other_fn()'];
    await resolveLocalVariableReturnType(svcLines, 1, 'data', root); // 预热发布
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      const release = gateRebuildScan(); // 门住重建:扫描期读到的磁盘内容仍是 OLD
      const pending = resolveLocalVariableReturnType(svcLines, 1, 'data', root);
      applySavedFileAnnotations(root, path.join(root, 'svc.py'), 'def get_data() -> FRESH:\n    pass\n');
      release();
      const resolved = await pending;
      // 重建发布必须重放窗口内保存:旧读的 OLD 不得覆盖 FRESH
      expect(resolved).toMatchObject({ annotation: 'FRESH' });
      expect(resolveLocalVariableReturnTypeFromSnapshot(svcLines, 1, 'data', root))
        .toMatchObject({ annotation: 'FRESH' });
      // 单文件保存不动其他文件桶:other 的注解原样可查
      expect(resolveLocalVariableReturnTypeFromSnapshot(otherLines, 1, 'y', root))
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
    const aLines = ['from a import get_data', 'data = get_data()'];
    const bLines = ['from b import get_data', 'data = get_data()'];
    await resolveLocalVariableReturnType(bLines, 1, 'data', root); // 预热发布
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      const release = gateRebuildScan(); // 门住重建:扫描期仍读到 a.py(旧读)
      const pending = resolveLocalVariableReturnType(bLines, 1, 'data', root);
      removeSavedFileAnnotations(root, path.join(root, 'a.py'));
      release();
      const resolved = await pending;
      // a.py 来源不得复活(绑定模块 a 无桶 → null);同名方法由 b.py 来源兜底
      expect(resolved).toMatchObject({ annotation: 'FROM_B' });
      expect(resolveLocalVariableReturnTypeFromSnapshot(bLines, 1, 'data', root))
        .toMatchObject({ annotation: 'FROM_B' });
      expect(resolveLocalVariableReturnTypeFromSnapshot(aLines, 1, 'data', root)).toBeNull();
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
    const lines = ['from svc import get_data', 'data = get_data()'];
    await resolveLocalVariableReturnType(lines, 1, 'data', root);
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const now = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      // 命中前先过期:绑定路径也不再从磁盘 OLD 答(原 TTL 检查在命中返回之后)
      expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'data', root))
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

// IDE-REV-037:注解来源日志——hover 推导答话/未命中在 [kode-annot] 行里明确
// 所用来源。本组锁三面:①import 引用未打开文件(答话只能来自磁盘快照)命中
// 时日志带 source=disk-snapshot(import);②跨 TTL 过期未命中时日志明确
// disk-index=expired + rebuild=queued(不借旧值,受控重建异步排队);③重建
// 发布后恢复命中且来源行再次落账。交互全链路(真实编辑器 hover)在真机
// field 套件 rev037 例,本组为纯逻辑面。
describe('IDE-REV-037:注解来源日志', () => {
  afterEach(() => {
    setAnnotationSourceLogEnabled(false);
    setAnnotationSourceLogSink(undefined);
    clearRecentAnnotationSourceLogs();
  });

  it('import 未打开文件命中→source=disk-snapshot(import);过期未命中→expired+rebuild=queued;重建后恢复命中', async () => {
    const { root, put } = setupWorkspace();
    put('provider.py', 'def build_ttl_data() -> TTL_PROVIDER_RETURN:\n    pass\n');
    const lines = ['from provider import build_ttl_data', 'ttl_data = build_ttl_data()'];
    // 预热:建盘索引并发布
    await resolveLocalVariableReturnType(lines, 1, 'ttl_data', root);

    setAnnotationSourceLogEnabled(true);
    clearRecentAnnotationSourceLogs();
    // ①新鲜:import 绑定 → 磁盘快照答话,日志明确来源与模块
    expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'ttl_data', root))
      .toMatchObject({ annotation: 'TTL_PROVIDER_RETURN' });
    expect(getRecentAnnotationSourceLogs().some(line =>
      line.includes('hover-resolve') && line.includes('source=disk-snapshot(import)') && line.includes('module=provider')
    )).toBe(true);

    // ②跨 TTL 过期:不借旧值答话(返回 null),日志明确过期+受控重建排队
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'ttl_data', root)).toBeNull();
      expect(getRecentAnnotationSourceLogs().some(line =>
        line.includes('hover-miss') && line.includes('disk-index=expired') && line.includes('rebuild=queued')
      )).toBe(true);
      // ③受控重建发布(mock 时钟下建成,builtAtMs=推进时刻;恢复真实时钟后
      // 距建成仍是「未到期」,后续命中按新鲜快照答话)
      await resolveLocalVariableReturnType(lines, 1, 'ttl_data', root);
    } finally {
      nowSpy.mockRestore();
    }
    clearRecentAnnotationSourceLogs();
    expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'ttl_data', root))
      .toMatchObject({ annotation: 'TTL_PROVIDER_RETURN' });
    expect(getRecentAnnotationSourceLogs().some(line =>
      line.includes('hover-resolve') && line.includes('source=disk-snapshot(import)')
    )).toBe(true);
  });

  it('sink 与环形缓冲收同一行:真实接线面(面板落盘由 extension 注入)', async () => {
    const { root, put } = setupWorkspace();
    put('provider2.py', 'def build2() -> SINK_VAL:\n    pass\n');
    const lines = ['from provider2 import build2', 'd = build2()'];
    await resolveLocalVariableReturnType(lines, 1, 'd', root);
    setAnnotationSourceLogEnabled(true);
    clearRecentAnnotationSourceLogs();
    const sinkLines: string[] = [];
    setAnnotationSourceLogSink(line => sinkLines.push(line));
    expect(resolveLocalVariableReturnTypeFromSnapshot(lines, 1, 'd', root))
      .toMatchObject({ annotation: 'SINK_VAL' });
    expect(sinkLines.length).toBeGreaterThanOrEqual(1);
    expect(sinkLines[0]).toBe(getRecentAnnotationSourceLogs().at(-1));
  });
});

// collectProjectPythonFiles 的 limit 早退(138/148):上限命中的两处 return。
// 与主链扫描面同口径:超过 limit 即截断,不再进目录、不再收文件。
describe('collectProjectPythonFiles 上限截断(覆盖率)', () => {
  it('limit=0 立即返回;积满后目录内中途返回', () => {
    const { root, put } = setupWorkspace();
    put('a.py', 'x = 1\n');
    put('b.py', 'y = 2\n');
    put('c.py', 'z = 3\n');
    // limit=0:visit 入口 files(0)>=0 → 立即返回空
    expect(collectProjectPythonFiles(root, 0)).toEqual([]);
    // limit=1:收满 1 个后,下一目录项(147-148)即返回,只收 1
    expect(collectProjectPythonFiles(root, 1)).toHaveLength(1);
  });
});

/* ---------------- KR-AUD-64: 掩码先行(三引号体内的赋值形行不误判) ---------------- */

describe('KR-AUD-64: 赋值检测掩码先行(三引号内不误判)', () => {
  it('三引号字符串体内的 `data = get_data()` 不产推导候选', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> JSONDATA:\n    pass\n');
    // 预热注解索引(镜像本文件既有用例口径),否则查询面直接空转不红
    await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    const lines = [
      'def render(self):',
      '    doc = """',
      'data = get_data()',
      '"""',
      '    return doc'
    ];
    // hover data(名字只存在于字符串体内):不得借三引号体赋值行推导
    const resolvedData = resolveLocalVariableReturnTypeFromSnapshot(lines, 4, 'data', root);
    expect(resolvedData).toBeNull();
    // 真实赋值 doc = """(右值非单层调用)→ 无推导
    const resolvedDoc = resolveLocalVariableReturnTypeFromSnapshot(lines, 4, 'doc', root);
    expect(resolvedDoc).toBeNull();
  });
});
