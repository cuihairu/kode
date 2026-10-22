import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveEntityAnnotationType
} from '../src/definitionWorkspace';
import { getSemanticIndex } from '../src/semanticIndex';
import {
  EntityMappingManager
} from '../src/entityMapping';
import {
  KBEngineHoverProvider,
  PythonCompletionProvider
} from '../src/languageProviders';
import { buildEntityTypeStubPlan } from '../src/entityTypeStubs';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import type { EntityMapping } from '../src/entityMapping';
import { configurationOverrides, Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 统一注解解析链(用户令 2026-10-21,一个底座三面复用):types.xml 自定义类型
// 经 hover 断出具体类型而非 Any;def <Arg> 引用 types.xml 类型的正例;环/未知
// 仍 Any 的反例;两处 hover 同源断言;entity_types.pyi 对应行断言。manager 用
// 真实 EntityMappingManager + 临时目录真 .def/types.xml(与 receiverSection 同款装配)。

const pyDoc = (text: string, fileName: string): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

interface HoverFixture {
  root: string;
  defFile: string;
  basePy: string;
}

const makeWorkspace = (typesXml: string): HoverFixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-anno-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  put('scripts/entity_defs/types.xml', typesXml);
  // reqPos 的形参引用 types.xml 自定义类型 TIMESTAMP(别名 → UINT64)
  const defFile = put('scripts/entity_defs/Avatar.def', [
    '<root>',
    '  <CellMethods>',
    '    <reqPos>',
    '      <Arg>TIMESTAMP</Arg>',
    '    </reqPos>',
    '  </CellMethods>',
    '</root>'
  ].join('\n'));
  // 实现面按解析链注解(pos: int),过形参闸门
  const basePy = put(
    'scripts/base/Avatar.py',
    'class Avatar(kbe.KBEntity):\n    def reqPos(self, pos: int):\n        pass\n'
  );
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'anno', index: 0 }];
  return { root, defFile, basePy };
};

const makeManager = async (defFile: string): Promise<EntityMappingManager> => {
  const originalFindFiles = workspace.findFiles;
  workspace.findFiles = async (glob?: string) => (glob === '**/*.def' ? [Uri.file(defFile)] : []);
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await manager.waitForInitialScan();
  workspace.findFiles = originalFindFiles;
  return manager;
};

const hoverText = async (
  provider: KBEngineHoverProvider,
  doc: MinimalTextDocument,
  line: number,
  character: number
): Promise<string> => {
  const hover = (await Promise.resolve(provider.provideHover(doc, new Position(line, character)))) as
    | { contents: unknown }
    | null;
  const rawContents = hover?.contents ?? [];
  return (Array.isArray(rawContents) ? rawContents : [rawContents])
    .map(part => (part as { value?: string }).value ?? String(part))
    .join('\n');
};

describe('resolveEntityAnnotationType(统一解析链,单表收口)', () => {
  let root = '';

  const makeTypeRoot = (typesXml: string): string => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-anno-resolve-'));
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), typesXml, 'utf8');
    return root;
  };

  afterEach(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('别名链断到内建:TIMESTAMP→UINT64 发 int,VECTOR3 别名发 Tuple', () => {
    const ws = makeTypeRoot('<root>\n  <TIMESTAMP> UINT64 </TIMESTAMP>\n  <HOME_POS> VECTOR3 </HOME_POS>\n</root>');
    expect(resolveEntityAnnotationType(ws, 'TIMESTAMP')).toBe('int');
    expect(resolveEntityAnnotationType(ws, 'HOME_POS')).toBe('Tuple[float, float, float]');
  });

  it('多链逐层下钻:C→B→STRING 发 str;内建直查仍生效', () => {
    const ws = makeTypeRoot(
      '<root>\n  <C> B </C>\n  <B> A </B>\n  <A> STRING </A>\n</root>'
    );
    expect(resolveEntityAnnotationType(ws, 'C')).toBe('str');
    expect(resolveEntityAnnotationType(ws, 'UINT8')).toBe('int');
  });

  it('环与未知保持 Any 不硬造', () => {
    const ws = makeTypeRoot('<root>\n  <X> Y </X>\n  <Y> X </Y>\n</root>');
    expect(resolveEntityAnnotationType(ws, 'X')).toBe('Any');
    expect(resolveEntityAnnotationType(ws, 'Y')).toBe('Any');
    expect(resolveEntityAnnotationType(ws, 'FOO')).toBe('Any');
  });

  it('注册表按工作区快照缓存:types.xml 变更经更新事件驱动重建(PR4 A4-3)', () => {
    const ws = makeTypeRoot('<root>\n  <TIMESTAMP> UINT64 </TIMESTAMP>\n</root>');
    expect(resolveEntityAnnotationType(ws, 'TIMESTAMP')).toBe('int');
    // 查询路径纯内存(无逐次 statSync 指纹):改文件后不通知,快照保持旧值
    const typesXmlPath = path.join(ws, 'scripts', 'entity_defs', 'types.xml');
    fs.writeFileSync(typesXmlPath, '<root>\n  <TIMESTAMP> STRING </TIMESTAMP>\n</root>', 'utf8');
    expect(resolveEntityAnnotationType(ws, 'TIMESTAMP')).toBe('int');
    // 更新事件(watcher → notifySemanticFilesChanged)精确作废依赖快照后重建
    getSemanticIndex().notifySemanticFilesChanged([typesXmlPath]);
    expect(resolveEntityAnnotationType(ws, 'TIMESTAMP')).toBe('str');
  });

  it('alias.xml 并入同链(aliasDiscovery 开);开关关闭让位', () => {
    const ws = makeTypeRoot('<root>\n</root>');
    fs.writeFileSync(
      path.join(ws, 'scripts', 'entity_defs', 'alias.xml'),
      '<root>\n  <DIRECT>UINT8</DIRECT>\n</root>',
      'utf8'
    );
    expect(resolveEntityAnnotationType(ws, 'DIRECT')).toBe('int');
    // 开关语义保持:关闭后 alias 类型不再入注册表(回落 Any);开关入缓存键,
    // 不改文件也立即生效。
    configurationOverrides.set('kbengine', { 'types.aliasDiscovery': false });
    try {
      expect(resolveEntityAnnotationType(ws, 'DIRECT')).toBe('Any');
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });

  it('空工作区语境只剩内建直查', () => {
    expect(resolveEntityAnnotationType('', 'UINT8')).toBe('int');
    expect(resolveEntityAnnotationType('', 'FOO')).toBe('Any');
  });
});

describe('def 方法两面 hover 同源(真 def <Arg>TIMESTAMP</Arg>)', () => {
  const originalFolders = workspace.workspaceFolders;
  const managers: EntityMappingManager[] = [];
  const roots: string[] = [];

  afterEach(() => {
    managers.splice(0).forEach(manager => manager.dispose());
    roots.splice(0).forEach(path_ => fs.rmSync(path_, { recursive: true, force: true }));
    workspace.workspaceFolders = originalFolders;
  });

  it('声明面 + 接收者面同出 pos: int 形态签名且同串', async () => {
    const fixture = makeWorkspace(
      '<root>\n  <TIMESTAMP> UINT64 </TIMESTAMP>\n</root>'
    );
    roots.push(fixture.root);
    const manager = await makeManager(fixture.defFile);
    managers.push(manager);
    const provider = new KBEngineHoverProvider(manager);

    // 声明面:光标落在 def reqPos 方法名上
    const declDoc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def reqPos(self, pos: int):\n        pass\n',
      fixture.basePy
    );
    const declChar = '    def '.length;
    const declarationText = await hoverText(provider, declDoc, 1, declChar);

    // 接收者面:光标落在 self.cell.reqPos 方法名上
    const receiverDoc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.cell.reqPos(1)\n',
      fixture.basePy
    );
    const receiverChar = '        self.cell.'.length;
    const receiverText = await hoverText(provider, receiverDoc, 2, receiverChar);

    // 两面同源:同一 formatter、同一解析链,签名串一致且断出 int 而非 Any
    const expectedSignature = 'def reqPos(self, arg1: int)';
    expect(declarationText).toContain(`签名: \`${expectedSignature}\``);
    expect(receiverText).toContain(`签名: \`${expectedSignature}\``);
    expect(declarationText).not.toContain('Any');
    expect(receiverText).not.toContain('Any');
  }, 20000);

  it('补全方法 detail 同链:TIMESTAMP 形参出 arg1: int', async () => {
    const fixture = makeWorkspace(
      '<root>\n  <TIMESTAMP> UINT64 </TIMESTAMP>\n</root>'
    );
    roots.push(fixture.root);
    const manager = await makeManager(fixture.defFile);
    managers.push(manager);
    const completion = new PythonCompletionProvider(manager);
    const doc = pyDoc('class Avatar:\n    def tick(self):\n        self.\n', fixture.basePy);
    const items = completion.provideCompletionItems(
      doc,
      new Position(2, '        self.'.length)
    ) as Array<{ label: string; documentation?: { value: string } }>;
    const reqPos = items.find(item => item.label === 'reqPos');
    expect(reqPos?.documentation?.value).toContain('def reqPos(self, arg1: int)');
  }, 20000);
});

describe('entity_types.pyi 方法面同链(pyi 对应行断言)', () => {
  const makeMapping = (declaredArgs: string[]) => ({
    name: 'Guard',
    defFile: '/ws/scripts/entity_defs/Guard.def',
    pythonFile: '/ws/scripts/cell/Guard.py',
    pythonFiles: ['/ws/scripts/cell/Guard.py'],
    properties: {},
    methods: {
      respawn: [{
        defFile: '/ws/scripts/entity_defs/Guard.def',
        line: 17,
        section: 'CellMethods',
        exposed: true,
        declaredArgs
      }]
    }
  } as unknown as EntityMapping);

  const makeType = (name: string, aliasType: string): CustomTypeInfo => ({
    name,
    filePath: '/ws/scripts/entity_defs/types.xml',
    line: 8,
    implementedByLine: 8,
    startOffset: 0,
    endOffset: 1,
    aliasType,
    rawValue: aliasType,
    structure: { name: aliasType, rawValue: aliasType, children: [], line: 8 },
    properties: []
  });

  it('自定义类型形参断到内建:TIMESTAMP→def respawn(arg1: int)', () => {
    const plan = buildEntityTypeStubPlan(
      [makeMapping(['TIMESTAMP'])],
      [makeType('TIMESTAMP', 'UINT64')]
    );
    expect(plan.content).toContain('def respawn(arg1: int) -> None: ...');
  });

  it('环/未知仍 Any:成环别名与未注册名都不硬造', () => {
    const plan = buildEntityTypeStubPlan(
      [makeMapping(['X', 'FOO'])],
      [makeType('X', 'Y'), makeType('Y', 'X')]
    );
    expect(plan.content).toContain('def respawn(arg1: Any, arg2: Any) -> None: ...');
  });
});
