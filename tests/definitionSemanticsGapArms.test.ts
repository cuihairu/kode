import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefinitionSemanticsLoader } from '../src/backend/definitionSemantics';
import { workspace } from './fake-vscode/workspaceState';

// definitionSemantics 残余缺口臂(逐行定性,非补测刷分):
// - loadLocalRaw 原文直传面三个出口(命中/名字解析不到/解析命中但快照读不到内容);
// - identitySetFromVisited 的「探不到身份」退路(消费文件在解析中途消失→身份
//   集合返回 null,调用方不落缓存,后续每次现解析);
// - 接口的接口继承组并入宿主实体的继承组(嵌套 Mixin 组克隆)。
//
// fs 命名空间在 ESM 下 readFileSync 为 configurable:false(实测 descriptor
// {writable:true, configurable:false}),属性级 monkeypatch 不可行——按本仓既有
// 口径(definitionWorkspaceGaps 等)走 vi.mock('fs') 模块级拦截。
const fsState = vi.hoisted((): {
  actual: typeof import('fs').readFileSync | null;
  impl: ((...args: never[]) => unknown) | null;
} => ({ actual: null, impl: null }));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  fsState.actual = actual.readFileSync;
  return {
    ...actual,
    default: actual,
    get readFileSync(): typeof actual.readFileSync {
      if (fsState.impl) {
        return fsState.impl as typeof actual.readFileSync;
      }
      return actual.readFileSync;
    }
  };
});

const write = (root: string, relative: string, lines: string[]): void => {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, lines.join('\n'), 'utf8');
};

const chainBaseLines = [
  '<root>',
  '  <Properties>',
  '    <stamina>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '    </stamina>',
  '  </Properties>',
  '</root>'
];

let root = '';
let chainBasePath = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-semantics-gap-arms-'));
  chainBasePath = path.join(root, 'scripts/entity_defs/ChainBase.def');

  write(root, 'scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ]);

  write(root, 'scripts/entity_defs/BlockedRead.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ]);

  // 接口再引接口:IParent 带属性与 ClientMethods,IChild 只声明 Interfaces。
  // 引擎对接口从不调 loadParentClass(KR-AUD-72),接口的继承只能走 Interfaces。
//
// **残余 2 行(405-406)= 定性死码,不硬凑**:类内私有方法
// `DefinitionSemanticsLoader.effectivePropertyKey`(404-408)与模块级自由函数
// `effectivePropertyKey`(1033-1037)函数体逐字相同,而全部 6 处调用点(431/432/
// 495/497/579/581)都是类方法体内的**无修饰符**标识符——按词法作用域解析到模块
// 级自由函数,`this.effectivePropertyKey` 在全仓零调用点(实测 grep)。私有方法是
// 复制残留死码,覆盖不可达,如实登记。
  write(root, 'scripts/entity_defs/interfaces/IParent.def', [
    '<root>',
    '  <Properties>',
    '    <shield>',
    '      <Type>UINT8</Type>',
    '      <Flags>ALL_CLIENTS</Flags>',
    '    </shield>',
    '  </Properties>',
    '  <ClientMethods>',
    '    <onShieldHit/>',
    '  </ClientMethods>',
    '</root>'
  ]);
  write(root, 'scripts/entity_defs/interfaces/IChild.def', [
    '<root>',
    '  <Interfaces>',
    '    <interface>IParent</interface>',
    '  </Interfaces>',
    '</root>'
  ]);
  write(root, 'scripts/entity_defs/Nested.def', [
    '<root>',
    '  <Interfaces>',
    '    <interface>IChild</interface>',
    '  </Interfaces>',
    '</root>'
  ]);

  // 父链:身份集合退路要用「解析中途消失的消费文件」
  write(root, 'scripts/entity_defs/ChainBase.def', chainBaseLines);
  write(root, 'scripts/entity_defs/ChainHero.def', [
    '<root>',
    '  <Parent>ChainBase</Parent>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ]);
});

beforeEach(() => {
  workspace.textDocuments = [];
  fsState.impl = null;
});

afterEach(() => {
  workspace.textDocuments = [];
  fsState.impl = null;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadLocalRaw 原文直传面', () => {
  it('按名取回 def 原文与解析路径,不做语义解析', () => {
    const loader = createDefinitionSemanticsLoader(root)!;
    const defPath = path.join(root, 'scripts/entity_defs/Hero.def');

    const raw = loader.loadLocalRaw('Hero', 'entity');

    expect(raw).not.toBeNull();
    expect(raw!.filePath).toBe(defPath);
    // 原文面必须逐字照传(Rust 侧负责解析,TS 侧只收集语料)
    expect(raw!.content).toContain('<Type>UINT32</Type>');
    expect(raw!.content).toContain('<hp>');
  });

  it('名字解析不到时返回 null', () => {
    const loader = createDefinitionSemanticsLoader(root)!;

    expect(loader.loadLocalRaw('NoSuchEntity', 'entity')).toBeNull();
  });

  it('解析命中但共享快照读不到内容时返回 null', () => {
    // 共享快照的磁盘补载口经 readFileSyncUtf8Recorded → fs.readFileSync;
    // 令该文件读盘失败即造出「路径可解析、内容取不到」的真实缺口
    fsState.impl = (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith('BlockedRead.def')) {
        throw new Error('EIO: simulated read failure');
      }
      return fsState.actual!.apply(fs, args);
    };

    const loader = createDefinitionSemanticsLoader(root)!;
    expect(loader.loadLocalRaw('BlockedRead', 'entity')).toBeNull();
  });
});

describe('解析中途消失的消费文件', () => {
  it('身份集合探不到即返回 null:语义照常交付但不落缓存', () => {
    const loader = createDefinitionSemanticsLoader(root)!;

    // 父文件在「读回原文之后、身份重探之前」被删掉:读盘成功但 stat 失败,
    // 该文件既不在打开文档清单也无磁盘指纹 → 身份令牌为 null
    fsState.impl = (...args: Parameters<typeof fs.readFileSync>) => {
      const content = fsState.actual!.apply(fs, args);
      if (String(args[0]) === chainBasePath) {
        fs.rmSync(chainBasePath, { force: true });
      }
      return content;
    };
    try {
      const resolved = loader.loadResolved('ChainHero', 'entity');

      // 语义结果不受影响(父属性照并入)——身份只决定是否记忆
      expect(resolved).not.toBeNull();
      expect(resolved!.effectiveProperties.map(property => property.name))
        .toEqual(['hp', 'stamina']);
    } finally {
      // 复原夹具,别把删除漏给后续用例
      write(root, 'scripts/entity_defs/ChainBase.def', chainBaseLines);
    }
  });
});

describe('接口的接口继承组', () => {
  it('嵌套 Mixin 组并入宿主实体继承组,ClientMethods 段一并克隆', () => {
    const loader = createDefinitionSemanticsLoader(root)!;
    const resolved = loader.loadResolved('Nested', 'entity')!;

    const labels = resolved.inheritanceGroups.map(group => group.label);
    // 直推组=IChild 自身;嵌套组=IChild 链下的 IParent(IChild 的 Interfaces)
    expect(labels).toContain('Mixin · IChild');
    expect(labels).toContain('Mixin · IChild / IParent');

    const nested = resolved.inheritanceGroups.find(group => group.label === 'Mixin · IChild / IParent')!;
    expect(nested.properties.map(property => property.name)).toEqual(['shield']);
    // 来源链带上宿主侧接口名(IChild)+ 自身链(IParent)
    expect(nested.properties[0].source).toMatchObject({
      kind: 'interface',
      chain: ['IChild', 'IParent'],
      label: 'Mixin · IChild / IParent'
    });
    // ClientMethods 段经 cloneMethodSectionRecord 克隆,不是引用传递
    expect(nested.methodsBySection.ClientMethods.map(method => method.name)).toEqual(['onShieldHit']);
    expect(nested.methodsBySection.ClientMethods[0].source.chain).toEqual(['IChild', 'IParent']);

    // 有效面:IParent 的属性与方法透传进实体的 effective 集
    expect(resolved.effectiveProperties.map(property => property.name)).toEqual(['shield']);
    expect(resolved.effectiveMethodsBySection.ClientMethods.map(method => method.name))
      .toEqual(['onShieldHit']);
  });
});