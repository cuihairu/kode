import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectClientSdkEntities,
  generateClientSdkEntities,
  runClientSdkGenerateCommand
} from '../src/sdk-gen/clientSdkGenerator';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { messages } from './helpers/vscodeStub';
import { window as windowish } from './helpers/vscodeStub';

// clientSdkGenerator.ts 缺口臂(2026-11-09 覆盖率扫尾):
//   collectClientSdkRelatedDefs 的接口递归 enqueue(L213)、
//   collectClientSdkComponentDefs 的缺失组件 def 早退(L340)、组件 Parent
//   enqueue(L349)、组件嵌套组件类型 enqueue(L352)、describeRustGeneratedFile
//   的组件伴随文件分支(L387)、generateClientSdkEntitiesFallback 的组件伴随
//   文件写盘(L489-490/L493)、runClientSdkGenerateCommand 的重名冲突通知
//   (L592-594)与其余错误重抛(L596)。
//
// 记录的死臂(附证据,不伪造 fs 错误强测):
//   * L324-325(collectClientSdkComponentDefs `if (defs[name] !== undefined) return`):
//     不可达。visit 只从 queue 弹出,而 queue 的每个名字都经 enqueue 的
//     `enqueued` 集合去重(318-321),同一名字至多入队一次、visit 至多一次;
//     defs 仅在 visit 内(343)写入,实体源循环(355-360)不写 defs——
//     故 visit 入口处 defs[name] 恒为 undefined,重复访问守卫永不触发。
//   * L523-524(generateClientSdkEntities 重名预检 catch):
//     不可达。预检表达式 findClientSdkMemberConflicts(collectClientSdkEntities(root),
//     languages) 的两层皆全函数:collectClientSdkEntities 内部全部经
//     parseDefDocumentSafely/parseDefText/readTextFile/parseXmlDocument 的
//     try/catch 兜底(读失败回空串、解析失败回 null,见 clientSdkCodegen.ts
//     115-121、defRenamer.ts 206-212、definitionWorkspace.ts 1452-1462、
//     definitionWorkspaceXml.ts 69-75);findClientSdkMemberConflicts 及其
//     collectEmittedClientSdkMembers 均为纯迭代无抛点。catch 无触发路径。

const ROOT_FIXTURE = [
  '<!DOCTYPE entity>',
  '<root>',
  '  <Properties>',
  '    <name>',
  '      <Type>STRING</Type>',
  '      <Flags>BASE</Flags>',
  '    </name>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// IDE-AUD-062:业务属性占用辅助成员名(TS entityId / C# EntityId)。
const COLLISION_DEF = `<root>
  <Properties>
    <entityId>
      <Type>UINT32</Type>
      <Flags>OWN_CLIENT</Flags>
    </entityId>
  </Properties>
  <ClientMethods>
    <onBaseOutgoing>
      <Arg>UINT32</Arg>
    </onBaseOutgoing>
  </ClientMethods>
</root>
`;

const COMPONENT_AVATAR_DEF = `<root>
  <Components>
    <healthPack>
      <Type>HealthComp</Type>
    </healthPack>
  </Components>
  <Properties>
    <name>
      <Type>STRING</Type>
      <Flags>BASE</Flags>
    </name>
  </Properties>
</root>
`;

const COMPONENT_DEF = `<root>
  <Parent>
    <Component/>
  </Parent>
  <Properties>
    <hp>
      <Type>UINT32</Type>
      <Flags>CELL_PUBLIC</Flags>
    </hp>
  </Properties>
  <Components>
    <sub>
      <Type>SubComp</Type>
    </sub>
  </Components>
</root>
`;

const roots: string[] = [];

const makeWorkspace = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sdk-gap-'));
  roots.push(root);
  const defsDir = path.join(root, 'scripts', 'entity_defs');
  fs.mkdirSync(defsDir, { recursive: true });
  fs.writeFileSync(path.join(defsDir, 'entities.xml'), '<root>\n  <Avatar hasBase="true"/>\n</root>\n', 'utf8');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(defsDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return root;
};

const makeOutDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sdk-gap-out-'));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  setKodeCoreShadowGate(null);
});

afterAll(() => {
  setKodeCoreShadowGate(null);
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('clientSdkGenerator 缺口臂:相关 def 闭包', () => {
  it('接口 def 自身含接口 → 递归 enqueue(L213)', () => {
    const root = makeWorkspace({
      'Avatar.def': '<root><Interfaces><interface>IDamageable</interface></Interfaces></root>',
      'interfaces/IDamageable.def': '<root><Interfaces><interface>IShield</interface></Interfaces></root>'
    });
    const entities = collectClientSdkEntities(root);
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe('Avatar');
  });
});

describe('clientSdkGenerator 缺口臂:组件 def 闭包', () => {
  it('组件 def 缺失(不在 components/ 也不在 interfaces/)→ 早退(L340)', () => {
    const root = makeWorkspace({
      'Avatar.def': '<root><Components><healthPack><Type>MissingComp</Type></healthPack></Components></root>'
    });
    const entities = collectClientSdkEntities(root);
    // 缺 def 的组件槽跳过(与 Rust 侧同口径),实体仍收
    expect(entities).toHaveLength(1);
    expect(entities[0].components).toHaveLength(0);
  });

  it('组件 def 的 Parent → enqueue(L349);嵌套组件类型 → enqueue(L352)', () => {
    const root = makeWorkspace({
      'Avatar.def': COMPONENT_AVATAR_DEF,
      'components/HealthComp.def': COMPONENT_DEF
    });
    const entities = collectClientSdkEntities(root);
    expect(entities).toHaveLength(1);
    expect(entities[0].components).toHaveLength(1);
    expect(entities[0].components[0].typeName).toBe('HealthComp');
  });
});

describe('clientSdkGenerator 缺口臂:Rust 组件伴随文件名', () => {
  it('Rust 返回 ClientSdkComponents 文件名 → kind=components(L387)', async () => {
    const root = makeWorkspace({ 'Avatar.def': ROOT_FIXTURE });
    const outDir = makeOutDir();
    const fakeGate = {
      runInRust: async () => ({
        ok: true,
        result: [{ fileName: 'ClientSdkComponents.ts', content: '// rust: comp\n' }]
      })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    const result = await generateClientSdkEntities(
      { languages: ['typescript'], outputDir: outDir, overwrite: true },
      root
    );
    const components = result.files.find(file => file.kind === 'components');
    expect(components).toBeDefined();
    expect(fs.readFileSync(components!.path, 'utf8')).toBe('// rust: comp\n');
  });
});

describe('clientSdkGenerator 缺口臂:兜底组件伴随写盘', () => {
  it('TS 兜底路径写组件伴随文件(L489-490/L493)', async () => {
    const root = makeWorkspace({
      'Avatar.def': COMPONENT_AVATAR_DEF,
      'components/HealthComp.def': COMPONENT_DEF
    });
    const outDir = makeOutDir();
    setKodeCoreShadowGate(null); // 无 Rust 门 → 主路径返回 null → 兜底
    const result = await generateClientSdkEntities(
      { languages: ['typescript'], outputDir: outDir, overwrite: true },
      root
    );
    const components = result.files.find(file => file.kind === 'components');
    expect(components).toBeDefined();
    expect(components!.written).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'ClientSdkComponents.ts'))).toBe(true);
  });
});

describe('clientSdkGenerator 缺口臂:命令编排', () => {
  const originalQuickPick = windowish.showQuickPick;
  const originalInputBox = windowish.showInputBox;

  afterEach(() => {
    windowish.showQuickPick = originalQuickPick;
    windowish.showInputBox = originalInputBox;
    setKodeCoreShadowGate(null);
  });

  beforeEach(() => {
    messages.info.length = 0;
    messages.error.length = 0;
  });

  const armCommandMocks = (): void => {
    windowish.showQuickPick = async (): Promise<unknown> => [{ value: 'typescript' }];
    windowish.showInputBox = async (): Promise<string | undefined> => 'scripts/client_entities';
  };

  it('重名冲突 → 说明通知并返回(L592-594)', async () => {
    const root = makeWorkspace({ 'Avatar.def': COLLISION_DEF });
    armCommandMocks();
    // 语言选择一次 + 覆盖策略一次;showInputBox 输出目录一次
    const pickQueue = [
      [{ value: 'typescript' }],
      [{ value: 'overwrite' }]
    ];
    let pickCalls = 0;
    windowish.showQuickPick = async (): Promise<unknown> => {
      const next = pickQueue[pickCalls];
      pickCalls += 1;
      return next;
    };
    await runClientSdkGenerateCommand(root);
    expect(messages.error.some(message => message.includes('重名'))).toBe(true);
    expect(messages.info).toHaveLength(0);
  });

  it('其余错误照常重抛(L596)', async () => {
    const root = makeWorkspace({ 'Avatar.def': ROOT_FIXTURE });
    armCommandMocks();
    const pickQueue = [
      [{ value: 'typescript' }],
      [{ value: 'overwrite' }]
    ];
    let pickCalls = 0;
    windowish.showQuickPick = async (): Promise<unknown> => {
      const next = pickQueue[pickCalls];
      pickCalls += 1;
      return next;
    };
    const fakeGate = {
      runInRust: async () => {
        throw new Error('Rust 核心不可达');
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    await expect(runClientSdkGenerateCommand(root)).rejects.toThrow('Rust 核心不可达');
  });
});
