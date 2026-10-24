import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import {
  KBEngineCompletionProvider,
  KBEngineDefinitionProvider,
  KBEngineHoverProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider,
  validateDocument,
  validateEntitiesXmlDocument
} from '../src/languageProviders';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { resetScanRootCache } from '../src/scanRoots';
import {
  Diagnostic,
  DiagnosticCollection,
  Position,
  Uri,
  makeTextDocument,
  workspace
} from './helpers/vscodeStub';

// PH0-02 旧功能 parity 锁(docs/kode2/ph0-gate.md 门 2):
// hover / definition / completion / diagnostics 四主请求对 tests/fixtures/
// parity-project(由 scripts/generate-parity-fixtures.mjs 确定性生成)的
// golden 输入输出。重生成 golden:
//   KODE_PARITY_UPDATE=1 npx vitest run tests/parityGolden.test.ts
// 其余任何改动若令本测试失败,即语义行为漂移,须在 PR 描述中列明差异。

const PROJECT = path.join(__dirname, 'fixtures', 'parity-project');
const GOLDEN = path.join(__dirname, 'fixtures', 'parity', 'golden.json');
const UPDATE = process.env.KODE_PARITY_UPDATE === '1';

const originalFindFiles = workspace.findFiles;
const originalFolders = workspace.workspaceFolders;

function walkFiles(root: string): Uri[] {
  const files: Uri[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); }
      else { files.push(Uri.file(full)); }
    }
  };
  walk(root);
  return files;
}

/** 读文件并定位标记行/符号列(与 navigation manifest 同口径) */
function locate(relative: string, marker: string, symbol: string): { document: ReturnType<typeof makeTextDocument>; position: Position; content: string } {
  const filePath = path.join(PROJECT, relative);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const line = lines.findIndex(row => row.includes(marker));
  expect(line, `missing marker ${marker} in ${relative}`).toBeGreaterThanOrEqual(0);
  const row = lines[line];
  const character = row.indexOf(symbol);
  expect(character, `missing symbol ${symbol} beside ${marker}`).toBeGreaterThanOrEqual(0);
  return {
    content,
    document: makeTextDocument(content, {
      fileName: filePath,
      languageId: relative.endsWith('.py') ? 'python' : 'kbengine-def'
    }),
    position: new Position(line, character + Math.floor(symbol.length / 2))
  };
}

/** 深度归一化:绝对路径→<ROOT>(含反斜杠路径),丢弃非确定字段 */
function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.split(PROJECT).join('<ROOT>').split(PROJECT.replace(/\\/g, '/')).join('<ROOT>').replace(/\\/g, '/');
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => normalize(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Uri 桩 → 相对路径字符串
    if (typeof record.fsPath === 'string') {
      return normalize(record.fsPath);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === 'function' || item === undefined) continue;
      if (key === 'command' || key === 'sortText' || key === 'filterText' || key === 'preselect') continue;
      out[key] = normalize(item);
    }
    return out;
  }
  return String(value);
}

interface GoldenRequest {
  id: string;
  kind: 'hover' | 'definition' | 'completion' | 'diagnostics';
  input: Record<string, unknown>;
  response: unknown;
}

function sortResponses(kind: GoldenRequest['kind'], response: unknown): unknown {
  if (kind !== 'completion' && kind !== 'diagnostics') return response;
  const list = Array.isArray(response) ? response : [];
  const keyOf = (item: unknown): string => JSON.stringify(item);
  return [...list].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

describe('PH0-02 parity golden: hover/definition/completion/diagnostics', () => {
  let manager: EntityMappingManager;
  let pythonClassIndex: PythonClassIndex;
  let hoverProvider: KBEngineHoverProvider;
  let pythonDefinition: PythonDefinitionProvider;
  let defDefinition: KBEngineDefinitionProvider;
  let pythonCompletion: PythonCompletionProvider;
  let defCompletion: KBEngineCompletionProvider;
  const requests: GoldenRequest[] = [];

  const record = (id: string, kind: GoldenRequest['kind'], input: Record<string, unknown>, response: unknown): void => {
    requests.push({ id, kind, input, response: sortResponses(kind, normalize(response)) });
  };

  beforeAll(async () => {
    workspace.workspaceFolders = [{ uri: Uri.file(PROJECT), name: 'parity-project', index: 0 }];
    workspace.findFiles = async (glob: string) => walkFiles(PROJECT).filter(uri => {
      const name = path.basename(uri.fsPath);
      return glob.includes('entities.xml') ? name === 'entities.xml'
        : glob.includes('*.def') ? name.endsWith('.def')
          : glob.includes('types.xml') ? name === 'types.xml'
            : name.endsWith('.py');
    });
    resetScanRootCache();
    manager = new EntityMappingManager({ subscriptions: [] });
    pythonClassIndex = new PythonClassIndex();
    hoverProvider = new KBEngineHoverProvider(manager);
    pythonDefinition = new PythonDefinitionProvider(manager, pythonClassIndex);
    defDefinition = new KBEngineDefinitionProvider(manager);
    pythonCompletion = new PythonCompletionProvider(manager);
    defCompletion = new KBEngineCompletionProvider(manager);
    await manager.waitForInitialScan();
    await pythonClassIndex.waitForInitialScan();
  });

  afterAll(() => {
    workspace.findFiles = originalFindFiles;
    workspace.workspaceFolders = originalFolders;
    if (UPDATE && requests.length > 0) {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify({
        fixture: 'tests/fixtures/parity-project',
        generator: 'scripts/generate-parity-fixtures.mjs',
        requestCount: requests.length,
        requests
      }, null, 2)}\n`);
    }
  });

  // ---------- hover ----------
  it('hover: def 方法声明标注(Avatar.onRpc)', async () => {
    const { document, position } = locate('scripts/base/Avatar.py', 'def onRpc(self', 'onRpc');
    const hover = await hoverProvider.provideHover(document, position);
    record('hover.def-method-onRpc', 'hover',
      { file: 'scripts/base/Avatar.py', marker: 'def onRpc(self', symbol: 'onRpc' }, hover);
    expect(hover).not.toBeNull();
  });

  it('hover: KBEngine 内建属性 self.databaseID', async () => {
    const { document } = locate('scripts/base/Avatar.py', 'print(self.databaseID)', 'databaseID');
    const lines = document.getText().split(/\r?\n/);
    const markerLine = lines.findIndex(row => row.includes('print(self.databaseID)'));
    const column = lines[markerLine].indexOf('print(') + 'print(self.'.length;
    const hover = await hoverProvider.provideHover(document, new Position(markerLine, column));
    record('hover.builtin-property-databaseID', 'hover',
      { file: 'scripts/base/Avatar.py', marker: 'print(self.databaseID)', at: 'after self.' }, hover);
    expect(hover).not.toBeNull();
  });

  it('hover: 接收者感知 self.base.onRpc', async () => {
    const { document, position } = locate('scripts/base/Avatar.py', 'self.base.onRpc(argOne)', 'onRpc');
    const hover = await hoverProvider.provideHover(document, position);
    record('hover.receiver-base-onRpc', 'hover',
      { file: 'scripts/base/Avatar.py', marker: 'self.base.onRpc(argOne)', symbol: 'onRpc' }, hover);
    expect(hover).not.toBeNull();
  });

  // ---------- definition ----------
  it('definition: Python 方法 → def 声明(Avatar.onRpc)', async () => {
    const { document, position } = locate('scripts/base/Avatar.py', 'def onRpc(self', 'onRpc');
    const target = await pythonDefinition.provideDefinition(document, position);
    record('definition.method-to-def-onRpc', 'definition',
      { file: 'scripts/base/Avatar.py', marker: 'def onRpc(self', symbol: 'onRpc' }, target);
    expect(target).not.toBeNull();
  });

  it('definition: 基类符号 → Python 类(Monster→Avatar)', async () => {
    const { document, position } = locate('scripts/cell/Monster.py', 'class Monster(Avatar)', 'Avatar)');
    const target = await pythonDefinition.provideDefinition(document, position);
    record('definition.baseclass-to-python-Avatar', 'definition',
      { file: 'scripts/cell/Monster.py', marker: 'class Monster(Avatar)', symbol: 'Avatar)' }, target);
    expect(target).not.toBeNull();
  });

  it('definition: 组件分面方法 self.inventory.add → Inventory.def', async () => {
    const { document, position } = locate('scripts/base/Avatar.py', 'self.inventory.add(itemId)', 'add(');
    const target = await pythonDefinition.provideDefinition(document, position);
    record('definition.component-facet-add', 'definition',
      { file: 'scripts/base/Avatar.py', marker: 'self.inventory.add(itemId)', symbol: 'add' }, target);
    expect(target).not.toBeNull();
  });

  it('definition: def 声明 → Python 实现(Avatar.def onRpc)', async () => {
    const { document, position } = locate('scripts/entity_defs/Avatar.def', '<onRpc>', 'onRpc');
    const target = await defDefinition.provideDefinition(document, position);
    record('definition.def-to-python-onRpc', 'definition',
      { file: 'scripts/entity_defs/Avatar.def', marker: '<onRpc>', symbol: 'onRpc' }, target);
    expect(target).not.toBeNull();
  });

  // ---------- completion ----------
  it('completion: Python self. 属性/方法', () => {
    const content = fs.readFileSync(path.join(PROJECT, 'scripts', 'base', 'Avatar.py'), 'utf8');
    const lines = content.split(/\r?\n/);
    const line = lines.findIndex(row => row.trim() === 'self.');
    expect(line, 'missing bare `self.` completion line').toBeGreaterThanOrEqual(0);
    const document = makeTextDocument(content, { fileName: path.join(PROJECT, 'scripts', 'base', 'Avatar.py'), languageId: 'python' });
    const items = pythonCompletion.provideCompletionItems(
      document,
      new Position(line, lines[line].length)
    );
    record('completion.python-self', 'completion',
      { file: 'scripts/base/Avatar.py', marker: 'self. (行尾)', at: 'eol' }, items ?? []);
    expect((items ?? []).length).toBeGreaterThan(0);
  });

  it('completion: .def <Type> 自定义类型', () => {
    // 探针文档不落盘:保持 parity 项目本身"干净",输入仍锚定项目根
    const probe = makeTextDocument([
      '<root>',
      '  <Properties>',
      '    <probe>',
      '      <Type>PAR',
      '    </probe>',
      '  </Properties>',
      '</root>'
    ].join('\n'), {
      fileName: path.join(PROJECT, 'scripts', 'entity_defs', 'CompletionProbe.def'),
      languageId: 'kbengine-def'
    });
    const items = defCompletion.provideCompletionItems(probe, new Position(3, 15));
    record('completion.def-type-known-types', 'completion',
      { file: '(inline) scripts/entity_defs/CompletionProbe.def', marker: '<Type>PAR', at: 'end' }, items ?? []);
    expect((items ?? []).length).toBeGreaterThan(0);
  });

  // ---------- diagnostics ----------
  it('diagnostics: .def 未知 Flags 报错', () => {
    const probe = makeTextDocument([
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>NOT_A_PARITY_FLAG</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), {
      fileName: path.join(PROJECT, 'scripts', 'entity_defs', 'DiagProbe.def'),
      languageId: 'kbengine-def'
    });
    const collection = new DiagnosticCollection();
    validateDocument(probe, collection);
    const diags = collection.get(probe.uri) as Diagnostic[];
    record('diagnostics.def-unknown-flag', 'diagnostics',
      { file: '(inline) scripts/entity_defs/DiagProbe.def', marker: '<Flags>NOT_A_PARITY_FLAG' }, diags ?? []);
    expect((diags ?? []).length).toBeGreaterThan(0);
  });

  it('diagnostics: entities.xml 重复条目', () => {
    const probe = makeTextDocument([
      '<root>',
      '  <Avatar config="kbengine_avatar_defaults"/>',
      '  <Avatar config="kbengine_avatar_defaults"/>',
      '  <Monster config="kbengine_monster_defaults"/>',
      '</root>'
    ].join('\n'), {
      fileName: path.join(PROJECT, 'scripts', 'entities.xml'),
      languageId: 'xml'
    });
    const collection = new DiagnosticCollection();
    validateEntitiesXmlDocument(probe, collection);
    const diags = collection.get(probe.uri) as Diagnostic[];
    record('diagnostics.entities-duplicate-entry', 'diagnostics',
      { file: '(inline) scripts/entities.xml', marker: 'duplicate <Avatar/>' }, diags ?? []);
    expect(Array.isArray(diags)).toBe(true);
  });

  it('golden 对拍(KODE_PARITY_UPDATE=1 时只重录)', () => {
    expect(requests).toHaveLength(11);
    expect(UPDATE || fs.existsSync(GOLDEN)).toBe(true);
    if (UPDATE) {
      expect(requests.every(request => request.response !== undefined)).toBe(true);
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as { requests: GoldenRequest[] };
    const byId = new Map(golden.requests.map(request => [request.id, request]));
    for (const request of requests) {
      const expected = byId.get(request.id);
      expect(expected, `golden 缺少 ${request.id}`).toBeDefined();
      expect(request.response, `${request.id} 行为漂移`).toEqual(expected?.response);
    }
    expect(golden.requests).toHaveLength(requests.length);
  });
});
