// IDE-STUB-001(用户令批次):新增设置 kbengine.python.stubSourceMode,
// `generated`(默认)/ `real-source` 两档——
// - generated:stub 由内置生成链产出(entityTypeStubs.ts / pythonTypeStubs.ts
//   生成链),**不复制真实代码**:引擎 typings checkout 拼接导出
//   (fantasydemoRealExport 所测的「generated from the local KBEngine
//   typings checkout」路径)只属于 real-source 档;
// - real-source:既有「复制真实代码导出」路径仅在此档执行。
// 验收:默认 fresh workspace 不出现复制代码行为;切档生效有测试。
import { readFileSync, rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'fs';
import * as path from 'path';
import { join } from 'path';
import * as os from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STUB_SOURCE_MODE_DEFAULT,
  STUB_SOURCE_MODE_GENERATED,
  STUB_SOURCE_MODE_REAL_SOURCE,
  STUB_SOURCE_MODE_SETTING,
  STUB_SOURCE_MODES,
  buildKbeStubExportContent,
  buildKbeStubExportContentForWorkspace,
  readStubSourceMode,
  type StubSourceMode
} from '../src/pythonStubExport';
import { configurationOverrides } from './helpers/vscodeStub';

const root = join(__dirname, '..');

interface PackageJsonShape {
  contributes: {
    configuration: { properties: Record<string, {
      type?: string;
      enum?: string[];
      default?: unknown;
      markdownDescription?: string;
      markdownEnumDescriptions?: string[];
    }> } | Array<{ properties: Record<string, {
      type?: string;
      enum?: string[];
      default?: unknown;
      markdownDescription?: string;
      markdownEnumDescriptions?: string[];
    }> }>;
  };
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJsonShape;
const nls = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
const configuration = pkg.contributes.configuration;
const properties = Array.isArray(configuration)
  ? Object.assign({}, ...configuration.map(section => section.properties))
  : configuration.properties;
const resolveNls = (value: string): string =>
  value.replace(/^%([^%]+)%$/, (_m, key: string) => nls[key] ?? key);

/** 造一棵引擎 typings 假 checkout(与 featureToggles.makeEngineRoot 同形) */
const makeEngineRoot = (): string => {
  const engineRoot = mkdtempSync(path.join(os.tmpdir(), 'kode-stub-mode-engine-'));
  mkdirSync(path.join(engineRoot, 'typings'), { recursive: true });
  writeFileSync(
    path.join(engineRoot, 'typings', '_KBEngine_common.pyi'),
    'class Entity:\n    id: int\n',
    'utf8'
  );
  for (const moduleName of [
    '_KBEngine_baseapp', '_KBEngine_bots', '_KBEngine_cellapp', '_KBEngine_dbmgr',
    '_KBEngine_hooks', '_KBEngine_interfaces', '_KBEngine_logger', '_KBEngine_loginapp',
    '_KBEngine_pythonapp', '_KBEngine_server_errors'
  ]) {
    writeFileSync(path.join(engineRoot, 'typings', `${moduleName}.pyi`), '# fixture\n', 'utf8');
  }
  return engineRoot;
};

const removeEngineRoot = (engineRoot: string): void => {
  rmSync(engineRoot, { recursive: true, force: true });
};

const ENGINE_TYPINGS_MARKER = 'generated from the local KBEngine typings checkout';

describe('kbengine.python.stubSourceMode 贡献契约(IDE-STUB-001)', () => {
  it('设置键已注册:string、两档 enum、默认 generated、逐选项说明', () => {
    const entry = properties[`kbengine.${STUB_SOURCE_MODE_SETTING}`];
    expect(entry, 'kbengine.python.stubSourceMode 必须已注册').toBeDefined();
    expect(entry.type).toBe('string');
    expect(entry.enum).toEqual(['generated', 'real-source']);
    expect(entry.default).toBe('generated');
    expect(entry.markdownEnumDescriptions?.length).toBe(2);
  });

  it('nls 描述含默认值段与档位语义(real-source=复制真实代码,generated=不复制)', () => {
    const entry = properties[`kbengine.${STUB_SOURCE_MODE_SETTING}`];
    const text = resolveNls(entry.markdownDescription ?? '');
    expect(text).toContain('默认值');
    expect(text).toContain('真实代码');
  });

  it('常量:默认 generated,档位全集恰两档', () => {
    expect(STUB_SOURCE_MODE_DEFAULT).toBe('generated');
    expect(STUB_SOURCE_MODE_GENERATED).toBe('generated');
    expect(STUB_SOURCE_MODE_REAL_SOURCE).toBe('real-source');
    expect([...STUB_SOURCE_MODES]).toEqual(['generated', 'real-source']);
  });
});

describe('readStubSourceMode(读取口)', () => {
  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  it('缺省读 generated(缺省参直读 vscode 配置)', () => {
    expect(readStubSourceMode()).toBe('generated');
  });

  it('real-source 档生效', () => {
    configurationOverrides.set('kbengine', { 'python.stubSourceMode': 'real-source' });
    expect(readStubSourceMode()).toBe('real-source');
  });

  it('注入读取:未知值一律回落 generated(不认第三档)', () => {
    expect(readStubSourceMode({ setting: 'real-source' })).toBe('real-source');
    expect(readStubSourceMode({ setting: 'generated' })).toBe('generated');
    expect(readStubSourceMode({ setting: 'aggressive' })).toBe('generated');
    expect(readStubSourceMode({ setting: undefined })).toBe('generated');
  });
});

describe('引擎 typings 拼接(复制真实代码)按档放行(IDE-STUB-001)', () => {
  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  it('默认 generated 档:显式引擎 checkout 也不拼接,回落精选目录', () => {
    const engineRoot = makeEngineRoot();
    try {
      const content = buildKbeStubExportContentForWorkspace('/ws', {
        engineRoot,
        engineRootEnv: {}
      });
      expect(content).not.toContain(ENGINE_TYPINGS_MARKER);
      expect(content).toBe(buildKbeStubExportContent());
    } finally {
      removeEngineRoot(engineRoot);
    }
  });

  it('real-source 档:同一 checkout 拼接全量 API(既有复制路径在此档执行)', () => {
    const engineRoot = makeEngineRoot();
    try {
      configurationOverrides.set('kbengine', {
        'python.stubSourceMode': STUB_SOURCE_MODE_REAL_SOURCE satisfies StubSourceMode
      });
      const content = buildKbeStubExportContentForWorkspace('/ws', {
        engineRoot,
        engineRootEnv: {}
      });
      expect(content).toContain(ENGINE_TYPINGS_MARKER);
      expect(content).toContain('class Entity:');
    } finally {
      removeEngineRoot(engineRoot);
    }
  });

  it('real-source 档内 stubEngineTypings=false 仍回落精选目录(子开关不让位)', () => {
    const engineRoot = makeEngineRoot();
    try {
      configurationOverrides.set('kbengine', {
        'python.stubSourceMode': 'real-source',
        'python.stubEngineTypings': false
      });
      expect(buildKbeStubExportContentForWorkspace('/ws', { engineRoot, engineRootEnv: {} }))
        .toBe(buildKbeStubExportContent());
    } finally {
      removeEngineRoot(engineRoot);
    }
  });
});
