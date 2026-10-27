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
  extractFileReturnAnnotations,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType
} from '../src/pythonReturnTypeInference';
import {
  formatEntityBuiltinPropertyHeadline,
  getEntityBuiltinPropertiesForFace
} from '../src/entityBuiltinProperties';
import {
  CompletionItemKind,
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
    const annotation = resolveLocalVariableReturnType(
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
