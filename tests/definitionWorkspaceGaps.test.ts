import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// fs 模块命名空间不可重定义(Cannot redefine property),经 vi.mock 的
// getter 接缝把 readdirSync 换成可控实现:undefined 走真实读取,null
// 模拟属性缺失,函数则原样交给实现调用(throw / 返回字符串数组 / 返回
// 特构 dirent)。
const readdirState = vi.hoisted(() => ({
  impl: undefined as undefined | null | ((...args: unknown[]) => unknown)
}));

const readFileSyncState = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: unknown[]) => unknown)
}));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: actual,
    get readdirSync(): typeof actual.readdirSync {
      if (readdirState.impl === null) {
        return undefined as unknown as typeof actual.readdirSync;
      }
      if (readdirState.impl) {
        return readdirState.impl as typeof actual.readdirSync;
      }
      return actual.readdirSync;
    },
    get readFileSync(): typeof actual.readFileSync {
      if (readFileSyncState.impl) {
        return readFileSyncState.impl as typeof actual.readFileSync;
      }
      return actual.readFileSync;
    }
  };
});
import {
  findCustomTypeInfo,
  findCustomTypeDeclarationInfo,
  findCustomTypePythonImplementationFile,
  findDefinitionEntryByCategory,
  findEntitiesXmlFile,
  findEntityDefinitionFile,
  findEntityDefinitionsRoot,
  getCustomTypeInfos,
  getDefinitionEntries,
  getDefinitionWorkspaceLayout,
  getEntityRuntimeProfile,
  getRegisteredCustomTypes,
  getRegisteredEntities
} from '../src/definitionWorkspace';
import { makeTextDocument, workspace as stubWorkspace } from './helpers/vscodeStub';

// definitionWorkspace 的守卫与枚举缺口:document 目标在无工作区时的
// 归一 null 守卫、坏/缺 XML 的快照短路、win32 风格根路径的 join 分支、
// 设置项绝对路径直通、FIXED_DICT 结构渲染(自闭合与嵌套元素)、
// listDefinitionFiles 的 readdirSync 降级链(降级读字符串目录项、
// 全部失败、无名条目、子目录跳过)。

const write = (root: string, relative: string, content: string): void => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

let root = '';
let bare = '';
let badEntitiesXml = '';
let badTypesXml = '';
let badParseXml = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-gap-'));
  bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-bare-'));
  badEntitiesXml = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-badex-'));
  badTypesXml = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-badtx-'));
  badParseXml = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-badparse-'));

  write(root, 'scripts/entities.xml', '<root>\n  <Hero hasBase="true"/>\n</root>');
  write(root, 'scripts/entity_defs/Hero.def', '<root>\n</root>');
  // 子目录:目录枚举须跳过(不递归)
  write(root, 'scripts/entity_defs/Archive/Old.def', '<root>\n</root>');
  write(root, 'scripts/entity_defs/types.xml', [
    '<root>',
    '  <ITEM_ID>UINT16</ITEM_ID>',
    '  <WEIRD>',
    '    <Type>',
    '      FIXED_DICT',
    '      <meta/>',
    '      <of>UINT8</of>',
    '    </Type>',
    '  </WEIRD>',
    '</root>'
  ].join('\n'));

  write(badEntitiesXml, 'scripts/entities.xml', 'plain text without elements');
  write(badTypesXml, 'scripts/entity_defs/types.xml', 'plain text without elements');
  // 未闭合元素:定位闭标 token 失败令 parseDefDocument throw
  write(badParseXml, 'scripts/entities.xml', '<root><Hero>');
});

afterAll(() => {
  for (const dir of [root, bare, badEntitiesXml, badTypesXml, badParseXml]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  stubWorkspace.workspaceFolders = [];
});

describe('document-target guards without a workspace', () => {
  it('returns null for every lookup driven by a document when no folder is open', () => {
    stubWorkspace.workspaceFolders = [];
    const document = makeTextDocument('x', { fileName: '/nowhere/Hero.def' });

    expect(findCustomTypeInfo('X', document)).toBeNull();
    expect(findCustomTypeDeclarationInfo('X', document)).toBeNull();
    expect(findCustomTypePythonImplementationFile('X', document)).toBeNull();
    expect(findEntityDefinitionFile('Hero', document)).toBeNull();
    expect(findEntityDefinitionsRoot(document)).toBeNull();
    expect(findEntitiesXmlFile(document)).toBeNull();
    expect(getEntityRuntimeProfile('Hero', document)).toBeNull();
    expect(findDefinitionEntryByCategory('Hero', 'entity', document)).toBeNull();
  });
});

describe('broken workspace short-circuits', () => {
  it('returns null when the types.xml snapshot is unavailable', () => {
    // 树里没有 types.xml:声明信息与按类别 type 的查找短路
    expect(findCustomTypeDeclarationInfo('ITEM_ID', bare)).toBeNull();
    expect(findDefinitionEntryByCategory('ITEM_ID', 'type', bare)).toBeNull();
    expect([...getRegisteredCustomTypes(bare)]).toEqual([]);
  });

  it('tolerates an entities.xml without elements', () => {
    expect(getRegisteredEntities(badEntitiesXml)).toEqual([]);
  });

  it('tolerates a types.xml without elements', () => {
    expect(findCustomTypeInfo('ITEM_ID', badTypesXml)).toBeNull();
    expect([...getRegisteredCustomTypes(badTypesXml)]).toEqual([]);
  });

  it('tolerates an entities.xml that fails XML tokenization', () => {
    // 未闭合元素使 parseDefDocument throw,parseXmlDocument catch 归一 null
    expect(getRegisteredEntities(badParseXml)).toEqual([]);
  });

  it('exhausts readTextFile candidates when every read throws', () => {
    const restore = readFileSyncState.impl;
    readFileSyncState.impl = () => {
      throw new Error('read blocked');
    };
    try {
      // 候选路径逐个尝试失败后 catch-continue,耗尽返回 null
      expect(findCustomTypeInfo(root, 'ITEM_ID')).toBeNull();
      expect(getRegisteredEntities(root)).toEqual([]);
    } finally {
      readFileSyncState.impl = restore;
    }
  });
});

describe('workspace path joining branches', () => {
  it('joins windows-style roots with the native path module', () => {
    const layout = getDefinitionWorkspaceLayout('C:\\ws');

    expect(layout.entityDefsRoot).toContain('entity_defs');
    expect(layout.entityDefsRoot?.includes('\\')).toBe(true);
  });

  it('honours an absolute configured entity defs path verbatim', () => {
    // 绝对配置路径直返(resolveWorkspacePath 不再 join);目录须真实存在
    // 才能从候选里胜出,取 fixture 根下的绝对路径避免污染系统目录。
    const absoluteRoot = path.join(root, 'custom_defs');
    fs.mkdirSync(absoluteRoot, { recursive: true });
    const original = stubWorkspace.getConfiguration;
    stubWorkspace.getConfiguration = ((section?: string) => ({
      get: <T>(key: string, defaultValue: T): T =>
        section === 'kbengine' && key === 'entityDefsPath'
          ? absoluteRoot as unknown as T
          : defaultValue
    })) as unknown as typeof stubWorkspace.getConfiguration;

    try {
      const layout = getDefinitionWorkspaceLayout(root);
      expect(layout.entityDefsRoot).toBe(absoluteRoot);
    } finally {
      stubWorkspace.getConfiguration = original;
    }
  });
});

describe('custom type structure rendering', () => {
  it('renders self-closing and nested element children of a FIXED_DICT value', () => {
    const weird = getCustomTypeInfos(root).find(info => info.name === 'WEIRD');

    expect(weird).toBeDefined();
    const structure = JSON.stringify(weird?.structure);
    expect(structure).toContain('<meta/>');
    expect(structure).toContain('<of>UINT8</of>');
  });
});

describe('listDefinitionFiles readdir fallbacks', () => {
  const patchReaddir = (impl: typeof readdirState.impl): (() => void) => {
    readdirState.impl = impl;
    return () => {
      readdirState.impl = undefined;
    };
  };

  it('returns nothing when readdirSync is unavailable', () => {
    const restore = patchReaddir(null);
    try {
      // 磁盘枚举无贡献,只剩注册实体;Hero.def 存在与否由真实 fs 决定
      expect(getDefinitionEntries(root, 'entity').map(entry => entry.name)).toEqual(['Hero']);
    } finally {
      restore();
    }
  });

  it('falls back to string directory entries without withFileTypes', () => {
    const restore = patchReaddir((_path: unknown, options?: { withFileTypes?: boolean }) => {
      if (options?.withFileTypes) {
        throw new Error('no dirent support');
      }
      return ['Hero.def', 'notes.txt'];
    });
    try {
      const entries = getDefinitionEntries(root, 'entity');
      // 字符串目录项只收 .def,其余后缀忽略
      expect(entries.map(entry => entry.name)).toEqual(['Hero']);
      expect(entries.every(entry => entry.exists)).toBe(true);
    } finally {
      restore();
    }
  });

  it('gives up on entries when every readdir attempt throws', () => {
    const restore = patchReaddir(() => {
      throw new Error('always broken');
    });
    try {
      const entries = getDefinitionEntries(root, 'entity');
      // 只剩注册实体 Hero;磁盘枚举两次尝试全败后放弃
      expect(entries.map(entry => entry.name)).toEqual(['Hero']);
    } finally {
      restore();
    }
  });

  it('skips nameless entries and subdirectories in dirent listings', () => {
    const restore = patchReaddir(() => [
      { name: 'Sub', isDirectory: () => true },
      { name: 'Y.def', isFile: () => true },
      { isFile: () => true }
    ]);
    try {
      const names = getDefinitionEntries(root, 'entity').map(entry => entry.name).sort();
      expect(names).toEqual(['Hero', 'Y']);
    } finally {
      restore();
    }
  });
});
