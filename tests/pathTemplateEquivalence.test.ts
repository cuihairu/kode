import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefinitionWorkspaceLayout } from '../src/definitionWorkspace';
import {
  buildDiscoveryReport,
  resetDiscoveryState,
  resolveAgainstWorkspace
} from '../src/workspaceDiscovery';
import type { DiscoveryFieldLabel, DiscoveryLayoutFacts } from '../src/workspaceDiscovery';
import { renderPathTemplate } from '../src/workspacePath';
import { configurationOverrides, workspace as stubWorkspace } from './helpers/vscodeStub';
import { Uri } from './helpers/vscodeStub';

// 路径模板两链等价(真 bug:def 根定位错位):
// - 手工输入链 definitionWorkspace.resolveWorkspacePath —— kbengine.entityDefsPath
//   等配置项经 getDefinitionWorkspaceLayout 落成 layout.entityDefsRoot
// - 发现链 workspaceDiscovery.resolveAgainstWorkspace —— 诊断报告盘点显式配置
//   (explicitConfigExists 即它的 existsSync 结论)
// 同一输入必须渲染出同一输出。修前手工链不渲染模板:配置值
// `${workspaceFolder}/scripts/entity_defs` 被当相对路径字面拼进 def 根
// (`<root>/${workspaceFolder}/scripts/entity_defs`,必然不存在),与发现链结论相反。
// 两链现同委派 workspacePath.renderPathTemplate(variableSubstitution 单一真源)。

let root = '';

const GENERATED_AT = '2026-11-06T00:00:00.00Z';

const setEntityDefsPath = (setting: string): void => {
  configurationOverrides.set('kbengine', { entityDefsPath: setting });
};

/** 装配层同口径的 facts(extension.ts 组装;诊断层纯逻辑不碰 vscode) */
const factsFor = (entityDefsPathSetting: string): DiscoveryLayoutFacts => {
  const layout = getDefinitionWorkspaceLayout(root);
  return {
    entityDefsRoot: layout.entityDefsRoot || '',
    entityScriptsRoot: layout.entityScriptsRoot,
    interfacesRoot: layout.interfacesRoot,
    componentsRoot: layout.componentsRoot,
    entitiesXmlPath: layout.entitiesXmlPath,
    typesXmlPath: layout.typesXmlPath,
    entityDefsPathSetting,
    entitiesXmlPathSetting: '',
    // types.xml 无独立配置项,布局内硬编码候选链
    typesXmlPathSetting: '',
    configPath: '',
    configPathEffective: '',
    binPathSetting: '',
    binPath: ''
  };
};

const discoveryField = (entityDefsPathSetting: string) => {
  const report = buildDiscoveryReport(
    root,
    factsFor(entityDefsPathSetting),
    undefined,
    GENERATED_AT
  );
  const label: DiscoveryFieldLabel = '实体定义目录 entity_defs';
  return report.fields.find(field => field.label === label);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-path-template-'));
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  resetDiscoveryState();
  configurationOverrides.delete('kbengine');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
  configurationOverrides.delete('kbengine');
});

describe('路径模板两链等价(renderPathTemplate 单一真源)', () => {
  it('${workspaceFolder} 占位:手工输入链与发现链同输入同输出', () => {
    const setting = '${workspaceFolder}/scripts/entity_defs';
    const expected = path.join(root, 'scripts', 'entity_defs');

    // 单一真源先证对
    expect(renderPathTemplate(setting, root)).toBe(expected);

    setEntityDefsPath(setting);
    // 先在**目录尚不存在**时取 layout:def 根此时只能来自候选首项(渲染结果)。
    // 目录一旦先建成,发现兜底约定链会命中 scripts/entity_defs 并把修前的
    // 字面错位路径掩盖成正确值,等价性断言就假绿了。
    expect(getDefinitionWorkspaceLayout(root).entityDefsRoot).toBe(expected);
    // 发现链(字符串级)
    expect(resolveAgainstWorkspace(root, setting)).toBe(expected);

    fs.mkdirSync(expected, { recursive: true });
    // 发现链报告面:渲染后目录才存在;未渲染字面量 `<root>/${workspaceFolder}/...`
    // 必不存在,修前这里会是 false
    expect(fs.existsSync(`${root}/\${workspaceFolder}/scripts/entity_defs`)).toBe(false);
    expect(discoveryField(setting)?.explicitConfigExists).toBe(true);
  });

  it('相对路径:两链都锚到工作区根', () => {
    const setting = 'scripts/entity_defs';
    const expected = path.join(root, 'scripts', 'entity_defs');

    setEntityDefsPath(setting);
    expect(getDefinitionWorkspaceLayout(root).entityDefsRoot).toBe(expected);
    expect(resolveAgainstWorkspace(root, setting)).toBe(expected);

    fs.mkdirSync(expected, { recursive: true });
    expect(discoveryField(setting)?.explicitConfigExists).toBe(true);
  });

  it('绝对路径:两链都原样透传,不重复锚定', () => {
    const setting = path.join(root, 'custom_defs');

    setEntityDefsPath(setting);
    expect(getDefinitionWorkspaceLayout(root).entityDefsRoot).toBe(setting);
    expect(resolveAgainstWorkspace(root, setting)).toBe(setting);
    expect(renderPathTemplate(setting, root)).toBe(setting);
  });
});
