// 诊断面「发现级」补测(覆盖率 98% 目标批次):activateDiagnostics 各家族
// 此前只有零发现臂在册——本批用发现级 fixture(def 方法缺口/内建只读写入/
// 角色错用/方向违规/销毁后访问/空间导航保留键/RPC 实参不符/启动脚本未知
// 参数/配置契约漂移/user_type 契约缺失/进程拓扑错配)把各 publish 映射臂跑
// 真。进程拓扑的 Rust RPC 以模块 mock 边界直返 findings(TS 侧映射/分组/
// 发布全走真实码,Rust 侧另有自己的测试面)。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/backend/processTopologyRust', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/backend/processTopologyRust')>();
  return {
    ...actual,
    validateProcessTopologyInRust: vi.fn(
      async (params: import('../src/backend/processTopologyRust').ProcessTopologyRustParams) => ({
        findings: [
          {
            target: 'manifest',
            filePath: '<manifest>',
            line: 2,
            severity: 2,
            message: 'mock: manifest process role mismatch',
            code: 'PT-MOCK-MANIFEST',
            related: [
              {
                filePath: params.defs[0]?.filePath ?? '',
                line: 1,
                message: 'mock: related def mismatch'
              }
            ]
          }
        ]
      })
    )
  };
});

import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { messages, windowState } from './fake-vscode/windowState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { configurationOverrides, workspace, workspaceEvents } from './fake-vscode/workspaceState';
import { makeTextDocument, Uri, type ExtensionContext } from './fake-vscode/core';

let root = '';
let extDir = '';
let gsDir = '';
let context: ExtensionContext;

const makeMemento = (store: Map<string, unknown>) => ({
  get: <T,>(key: string, defaultValue?: T): T | undefined => {
    if (!store.has(key)) {
      return defaultValue;
    }
    return store.get(key) as T | undefined;
  },
  update: (key: string, value: unknown): Promise<void> => {
    if (value === undefined) {
      store.delete(key);
    } else {
      store.set(key, value);
    }
    return Promise.resolve();
  }
});

const disposeContext = (target: ExtensionContext): void => {
  for (const disposable of target.subscriptions) {
    disposable.dispose();
  }
};

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const AVATAR_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE_AND_CLIENT</Flags>',
  '    </hp>',
  '    <mana>',
  '      <Type>UINT32</Type>',
  '      <Flags>CELL</Flags>',
  '    </mana>',
  '    <profile>',
  '      <Type>ProfileBag</Type>',
  '      <Flags>BASE</Flags>',
  '    </profile>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>UINT32</Arg>',
  '      <Arg>VECTOR3</Arg>',
  '    </reqPos>',
  '    <onTick/>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <cellFly/>',
  '    <cellMove>',
  '      <Arg>UINT32</Arg>',
  '    </cellMove>',
  '  </CellMethods>',
  '</root>',
  ''
].join('\n');

// base 面实体脚本:一条文档同时踩中 只读写入(self.id)/角色错用(self.position
// = cellapp/client 专属)/方向违规(self.mana = CELL 域位,base 文件访问)/
// 销毁后访问(destroy 后 self.hp)/空间导航(setSpaceData _mapping 保留键 +
// navigate 无 canNavigate)/RPC 实参不符(cellMove 声明 1 参实传 2 参)/
// 反向方法缺口(ghostMethod 不在 def)。
// RPC 调用样本必须面对齐(深审-3 逐面语义闸):base 面合法接收者是
// self.cell/self.client;self.base 在 baseapp 是 AttributeError 引用,
// 发现面即滤除,踩不到任何 receiver/实参家族。
const AVATAR_PY = [
  'REGISTRY = []',
  '',
  'class Avatar:',
  '    def reqPos(self, stamp, pos):',
  '        self.id = 1',
  '        self.position = (1, 2)',
  '        x = self.mana',
  '        self.destroy()',
  '        y = self.hp',
  '        cellData.setSpaceData(1, "_mapping")',
  '        self.navigate(3)',
  '        self.cell.cellMove(1, 2)',
  '',
  '    def ghostMethod(self):',
  '        pass',
  '',
  '    def register(self):',
  '        REGISTRY.append(self)',
  '',
  '    def rename(self):',
  '        self.profile.name = "abc"',
  ''
].join('\n');

const BROKEN_IMPL_PY = [
  'class BrokenImpl:',
  '    def getDictFromObj(self, obj):',
  '        return {}',
  '    def isSameType(self, obj):',
  '        return True',
  ''
].join('\n');

// KSEM-SER-03/SER-04/SER-05:FD 序列化器 fixture——契约三方法齐备(不触发
// user-type-contract 面):getDictFromObj 返回缺 y 字面量 → fixedDictReturnSchema
// missing;createObjFromDict 入参 wire 字典读未声明键 w → fixedDictInputKeySchema
// 一条(get 形态);createObjFromDict 透传入参 → 推导 wire 键集,getDictFromObj
// 读推导键集缺失的 w → fixedDictOutputMemberSchema 一条。
const SERIALIZERS_IMPL_PY = [
  'class VectorBagSer:',
  '    def createObjFromDict(self, dct):',
  '        w = dct.get("w")',
  '        return dct',
  '',
  '    def getDictFromObj(self, obj):',
  '        return {"x": obj["x"], "w": obj["w"]}',
  '',
  '    def isSameType(self, obj):',
  '        return True',
  ''
].join('\n');

const START_SH = [
  '#!/bin/sh',
  'source scripts/profile.sh',
  '"$KBE_BIN_PATH/baseapp" --cid=abc --bogus=1',
  '"$KBE_BIN_PATH/cellapp" --cid=1 --gus=xy',
  ''
].join('\n');

const TOPO_XML = [
  '<root>',
  '  <process name="cellapp" role="cell" />',
  '</root>',
  ''
].join('\n');

const DEBUG_JSON = '{\n  "components": {}\n}\n';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-diag-findings-'));
  const defsRoot = path.join(root, 'scripts', 'entity_defs');
  fs.mkdirSync(defsRoot, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'user_type'), { recursive: true });
  fs.mkdirSync(path.join(root, '.kbengine'), { recursive: true });
  fs.writeFileSync(path.join(defsRoot, 'Avatar.def'), AVATAR_DEF, 'utf8');
  fs.writeFileSync(
    path.join(defsRoot, 'types.xml'),
    [
      '<root>',
      '  <BrokenType>',
      '    <implementedBy>broken.BrokenImpl</implementedBy>',
      '  </BrokenType>',
      '  <VectorBag>',
      '    FIXED_DICT',
      '    <implementedBy>serializers_impl.VectorBagSer</implementedBy>',
      '    <Properties>',
      '      <x>',
      '        <Type>UINT8</Type>',
      '      </x>',
      '      <y>',
      '        <Type>UINT8</Type>',
      '      </y>',
      '    </Properties>',
      '  </VectorBag>',
      '  <ProfileBag>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <name>',
      '        <Type>STRING</Type>',
      '      </name>',
      '    </Properties>',
      '  </ProfileBag>',
      '</root>',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    '<root>\n  <Avatar> <hasClient/></Avatar>\n</root>\n',
    'utf8'
  );
  fs.writeFileSync(path.join(root, 'scripts', 'base', 'Avatar.py'), AVATAR_PY, 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'user_type', 'broken.py'), BROKEN_IMPL_PY, 'utf8');
  fs.writeFileSync(
    path.join(root, 'scripts', 'user_type', 'serializers_impl.py'),
    SERIALIZERS_IMPL_PY,
    'utf8'
  );
  fs.writeFileSync(path.join(root, 'start.sh'), START_SH, 'utf8');
  fs.writeFileSync(path.join(root, 'process_topology.xml'), TOPO_XML, 'utf8');
  fs.writeFileSync(path.join(root, '.kbengine', 'debug.json'), DEBUG_JSON, 'utf8');
  // 无 .kbengine/ 条目 → 配置契约 gitignore 维度发现
  fs.writeFileSync(path.join(root, '.gitignore'), 'bin/\n*.pyc\n', 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n', 'utf8');

  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-diag-manifest-'));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: 'kode', version: '0.2.0', engines: { vscode: '^1.84.0' } }),
    'utf8'
  );
  fs.mkdirSync(path.join(extDir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'out', 'extension.js'), '', 'utf8');
  gsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-diag-gs-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(gsDir, { recursive: true, force: true });
});

let defDoc: ReturnType<typeof makeTextDocument>;
let pyDoc: ReturnType<typeof makeTextDocument>;
let userTypeDoc: ReturnType<typeof makeTextDocument>;
let serializersDoc: ReturnType<typeof makeTextDocument>;
let shellDoc: ReturnType<typeof makeTextDocument>;
let topoDoc: ReturnType<typeof makeTextDocument>;
let readmeDoc: ReturnType<typeof makeTextDocument>;

beforeAll(async () => {
  commandRegistry.reset();
  languagesRegistry.reset();
  windowState.reset();
  panelRegistry.reset();
  const rootUri = Uri.file(root);
  workspace.workspaceFolders = [{ uri: rootUri, name: 'ws', index: 0 }];
  workspace.findFiles = async (pattern: string): Promise<Uri[]> => {
    if (pattern === '**/*.def') {
      return [Uri.file(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'))];
    }
    if (pattern === '**/*.py') {
      return [
        Uri.file(path.join(root, 'scripts', 'base', 'Avatar.py')),
        Uri.file(path.join(root, 'scripts', 'user_type', 'broken.py')),
        Uri.file(path.join(root, 'scripts', 'user_type', 'serializers_impl.py'))
      ];
    }
    return [];
  };
  defDoc = makeTextDocument(AVATAR_DEF, {
    fileName: path.join(root, 'scripts', 'entity_defs', 'Avatar.def'),
    languageId: 'kbengine-def'
  });
  pyDoc = makeTextDocument(AVATAR_PY, {
    fileName: path.join(root, 'scripts', 'base', 'Avatar.py'),
    languageId: 'python'
  });
  userTypeDoc = makeTextDocument(BROKEN_IMPL_PY, {
    fileName: path.join(root, 'scripts', 'user_type', 'broken.py'),
    languageId: 'python'
  });
  serializersDoc = makeTextDocument(SERIALIZERS_IMPL_PY, {
    fileName: path.join(root, 'scripts', 'user_type', 'serializers_impl.py'),
    languageId: 'python'
  });
  shellDoc = makeTextDocument(START_SH, {
    fileName: path.join(root, 'start.sh'),
    languageId: 'shellscript'
  });
  topoDoc = makeTextDocument(TOPO_XML, {
    fileName: path.join(root, 'process_topology.xml'),
    languageId: 'xml'
  });
  readmeDoc = makeTextDocument('# demo\n', {
    fileName: path.join(root, 'README.md'),
    languageId: 'markdown'
  });
  workspace.textDocuments = [defDoc, pyDoc, userTypeDoc, serializersDoc, shellDoc, topoDoc, readmeDoc];
  context = {
    subscriptions: [],
    extensionUri: Uri.file(extDir),
    extensionPath: extDir,
    extension: { id: 'cuihairu.kode', extensionKind: 'workspace' },
    globalStoragePath: gsDir,
    workspaceState: makeMemento(new Map())
  };
  activate(context);
  await settle(600);
});

afterAll(() => {
  disposeContext(context);
  expect(deactivate()).toBeUndefined();
});

beforeEach(() => {
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
});

const collection = (name: string) =>
  languagesRegistry.diagnosticCollections.find(entry => entry.name === name)?.collection;

const expectFindings = (name: string, uri: Uri, minCount: number): void => {
  const found = collection(name)?.get(uri) ?? [];
  expect(found.length, `${name} 应有 ≥${minCount} 条发现,实得 ${found.length}`).toBeGreaterThanOrEqual(
    minCount
  );
};

describe('诊断家族发现级映射臂(覆盖补测)', () => {
  it('启用全家族开关:发现级文档各集合拿到真实 Diagnostic', async () => {
    // 预热实体映射索引(receiver 家族 compute 走同步只读
    // getMappingForPythonFile;索引由 ensureIndexByDefFile 面构建——与
    // 真实会话一致:首次 hover/一致性检查后索引就位)
    await commands.executeCommand(
      'kbengine.defMethodConsistency.revalidate',
      Uri.file(path.join(root, 'scripts', 'entity_defs', 'Avatar.def')).toString()
    );
    await settle(400);
    configurationOverrides.set('kbengine', {
      enableDiagnostics: true,
      'diagnostics.checkDefMethodMissingInPython': true,
      'diagnostics.checkPythonMethodNotInDef': true
    });
    configurationOverrides.set('python', {
      // ${workspaceFolder} 变量形态展开 + 存在/不存在两臂
      'analysis.extraPaths': ['${workspaceFolder}/scripts', '${workspaceFolder}/no_such_dir_xyz']
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) =>
        key === 'kbengine' ||
        key === 'python' ||
        [
          'kbengine.enableDiagnostics',
          'kbengine.enableStructureDiagnostics',
          'kbengine.diagnostics',
          'kbengine.receiverNoneDiagnostics',
          'kbengine.attributeNoneDiagnostics',
          'kbengine.spaceNavDiagnostics',
          'kbengine.rpcArgCountDiagnostics',
          'kbengine.startupScriptDiagnostics',
          'kbengine.diagnostics.checkDefMethodMissingInPython',
          'kbengine.diagnostics.checkPythonMethodNotInDef',
          'kbengine.propertyDirectionDiagnostics',
          'kbengine.readOnlyWriteDiagnostics',
          'kbengine.roleMisuseDiagnostics',
          'kbengine.postDestroyDiagnostics',
          'kbengine.diagnostics.checkProcessTopology'
        ].includes(key)
    });
    await settle(500);

    // 主集合:空间导航(setSpaceData _mapping 保留键 + navigate 无 canNavigate)
    // + RPC 实参不符 + 启动脚本未知参数/非数字
    expectFindings('kbengine', pyDoc.uri, 3);
    expectFindings('kbengine', shellDoc.uri, 3);
    // 内建属性面:只读写入/角色错用/销毁后访问
    expectFindings('kbengine-readonly-write', pyDoc.uri, 1);
    expectFindings('kbengine-role-misuse', pyDoc.uri, 1);
    expectFindings('kbengine-post-destroy', pyDoc.uri, 1);
    // 方向违规:def CELL 域属性在 base 文件访问
    expectFindings('kbengine-property-direction', pyDoc.uri, 1);
    // def 方法缺口(onTick/destroy 缺实现)+ 反向(ghostMethod 不在 def)
    expectFindings('kbengine-def-method-consistency', defDoc.uri, 1);
    expectFindings('kbengine-def-method-consistency', pyDoc.uri, 1);
    // user_type 契约缺失(BrokenImpl 缺 createObjFromDict)
    expectFindings('kbengine-user-type-contract', userTypeDoc.uri, 1);
    // KSEM-SER-03:FD 序列化出口面(VectorBagSer.getDictFromObj 缺 y;打开即排)
    workspaceEvents.documentOpened.fire(serializersDoc);
    await settle(500);
    const serializersItems = collection('kbengine-fixeddict-construct')!.get(serializersDoc.uri) ?? [];
    expect(
      serializersItems.map(item => String(item.code)),
      'serializers_impl 应有 fixedDictReturnSchema 缺 y 发现'
    ).toContain('kbengine.fixedDictReturnSchema');
    // KSEM-SER-04:入参 wire 字典未声明键读取(w 引擎侧 KeyError/.get 静默默认)
    expect(
      serializersItems.map(item => String(item.code)),
      'serializers_impl 应有 fixedDictInputKeySchema 未声明 w 发现'
    ).toContain('kbengine.fixedDictInputKeySchema');
    // KSEM-SER-05:透传入参 → 推导 wire 键集 {x,y};getDictFromObj 读推导键集
    // 缺失的 w(序列化时引擎记脚本错误并整体按默认值序列化)
    expect(
      serializersItems.map(item => String(item.code)),
      'serializers_impl 应有 fixedDictOutputMemberSchema 缺成员 w 发现'
    ).toContain('kbengine.fixedDictOutputMemberSchema');
    // 进程拓扑(mock Rust RPC 返回 findings;TS 侧映射/分组/发布走真实码)
    expectFindings('kbengine-process-topology', Uri.file(path.join(root, 'process_topology.xml')), 1);
    const topoDiagnostic = collection('kbengine-process-topology')!.get(
      Uri.file(path.join(root, 'process_topology.xml'))
    )[0] as { relatedInformation?: unknown[]; code?: unknown };
    expect(topoDiagnostic.code).toBe('PT-MOCK-MANIFEST');
    expect(Array.isArray(topoDiagnostic.relatedInformation)).toBe(true);

    // 配置契约:激活首扫已产出(gitignore 缺 .kbengine/ + debug.components 空
    // + extraPaths 指向不存在目录)
    const folderUri = workspace.workspaceFolders[0].uri;
    expectFindings('kbengine-config-contract', Uri.joinPath(folderUri, '.gitignore'), 1);
    expectFindings('kbengine-config-contract', Uri.joinPath(folderUri, '.kbengine/debug.json'), 1);
  });

  it('CodeAction 重算命令 + Python 保存联动:immediate/queued 双路重排', async () => {
    await commands.executeCommand(
      'kbengine.defMethodConsistency.revalidate',
      defDoc.uri.toString()
    );
    workspaceEvents.documentSaved.fire(pyDoc);
    await settle(300);
    expectFindings('kbengine-def-method-consistency', defDoc.uri, 1);
  });

  it('配置契约开关切换:关→清空已发布;修复 .gitignore 后重扫→旧 URI 清、新 URI 留', async () => {
    const folderUri = workspace.workspaceFolders[0].uri;
    const gitignoreUri = Uri.joinPath(folderUri, '.gitignore');
    const debugUri = Uri.joinPath(folderUri, '.kbengine/debug.json');
    // README 保存触发重扫(契约文件 open/save 即扫)
    workspaceEvents.documentSaved.fire(readmeDoc);
    workspaceEvents.documentOpened.fire(readmeDoc);
    await settle(300);
    expect(collection('kbengine-config-contract')!.get(gitignoreUri).length).toBeGreaterThanOrEqual(1);

    // 关开关:既有发布全部清空
    configurationOverrides.set('kbengine', { configContractDiagnostics: false });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) =>
        key === 'kbengine' || key === 'kbengine.configContractDiagnostics'
    });
    await settle(300);
    expect(collection('kbengine-config-contract')!.get(gitignoreUri)).toHaveLength(0);
    expect(collection('kbengine-config-contract')!.get(debugUri)).toHaveLength(0);

    // 修复 .gitignore 后重开:gitignore 维度不再产出(旧 URI 清),debug.json 维度保留
    fs.writeFileSync(path.join(root, '.gitignore'), 'bin/\n*.pyc\n.kbengine/\n', 'utf8');
    configurationOverrides.set('kbengine', { configContractDiagnostics: true });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) =>
        key === 'kbengine' || key === 'kbengine.configContractDiagnostics'
    });
    await settle(300);
    expect(collection('kbengine-config-contract')!.get(gitignoreUri)).toHaveLength(0);
    expect(collection('kbengine-config-contract')!.get(debugUri).length).toBeGreaterThanOrEqual(1);
    configurationOverrides.delete('kbengine');
    configurationOverrides.delete('python');
  });

  it('家族开关关闭臂 + 无工作区根臂:compute 如实零产出/静默', async () => {
    // 关启动脚本开关:compute 直取零发现(disabled 臂)
    configurationOverrides.set('kbengine', { startupScriptDiagnostics: false });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) =>
        key === 'kbengine' || key === 'kbengine.startupScriptDiagnostics'
    });
    await settle(300);
    expect(collection('kbengine')!.get(shellDoc.uri)).toHaveLength(0);

    // 关进程拓扑校验:compute disabled 臂
    configurationOverrides.set('kbengine', { startupScriptDiagnostics: true, 'diagnostics.checkProcessTopology': false });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) =>
        key === 'kbengine' || key === 'kbengine.diagnostics.checkProcessTopology'
    });
    await settle(300);
    expect(collection('kbengine-process-topology')!.get(
      Uri.file(path.join(root, 'process_topology.xml'))
    )).toHaveLength(0);

    // 无工作区根:拓扑清单路径解析 null(静默)、user_type compute 零产出
    workspace.workspaceFolders = [];
    workspaceEvents.documentOpened.fire(topoDoc);
    workspaceEvents.documentOpened.fire(userTypeDoc);
    await settle(300);
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    configurationOverrides.delete('kbengine');
    await settle(200);
    expect(messages.error).toHaveLength(0);
  });

  it('行为陷阱三规则接线:FIXED_DICT 子键赋值/容器滞留经 wireTrapLintDiagnostics 发布', async () => {
    // 重新打开实体脚本(激活期不扫全量,首用事件即算)
    workspaceEvents.documentOpened.fire(pyDoc);
    await settle(500);
    const trapItems = collection('kbengine-trap-lints')?.get(pyDoc.uri) ?? [];
    const codes = trapItems.map(item => String(item.code));
    fs.writeFileSync('/tmp/trap-dump.json', JSON.stringify({ codes, msgs: trapItems.map(d => (d.message as string).slice(0, 60)) }, null, 1));
    // 容器滞留(REGISTRY.append(self))必然在;FIXED_DICT 子键赋值
    // (self.profile.name = ...)要求类型图经工作区 types.xml 解析
    expect(codes.length).toBeGreaterThanOrEqual(2);
    expect(codes).toContain('kbengine.fixedDictNestedMutation');
    expect(codes).toContain('kbengine.destroyedEntityReference');
  });
});
