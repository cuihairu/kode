import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildFinalServerConfig, type ConfigXmlNode } from '../src/serverConfigMerge';
// KODE-CFG-009:parse 实现下线(core 唯一),测试夹具走契约镜像
import { parseConfigXml } from './helpers/configCoreContract';
import { resolveEngineRoot } from './helpers/engineRoot';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';

// 引擎真实 kbengine_defaults.xml 全量验收(引擎检出缺席时 skip,与
// kbeModuleIndex 的引擎源码条件用例同口径):拿942 行引擎默认配置跑一遍
// 增强,锁四件事——良构可解析、每个元素内部都有注释、注释不落元素外、
// 取值与关掉开关时逐项一致(分组只改次序,不改值)。

const engineRoot = resolveEngineRoot();
const realDefaultsPath = engineRoot
  ? path.join(engineRoot, 'kbe', 'res', 'server', 'kbengine_defaults.xml')
  : null;
const hasRealDefaults = realDefaultsPath !== null && fs.existsSync(realDefaultsPath);

/** 点分路径 = 文本的取值清单(顺序无关:子分类排序会改同级次序) */
const flatten = (node: ConfigXmlNode, prefix: string[] = []): string[] => {
  const here = node.name.length > 0 ? [...prefix, node.name] : prefix;
  const own = node.name.length > 0 ? [`${here.join('.')}=${node.text}`] : [];
  return [...own, ...node.children.flatMap(child => flatten(child, here))];
};

/** 内部缺注释的元素名(逐字符标签栈扫描) */
const elementsWithoutComment = (xml: string): string[] => {
  const missing: string[] = [];
  const stack: Array<{ name: string; sawComment: boolean }> = [];
  let index = 0;
  while (index < xml.length) {
    if (xml.startsWith('<!--', index)) {
      if (stack.length > 0) {
        stack[stack.length - 1].sawComment = true;
      }
      index = xml.indexOf('-->', index) + 3;
      continue;
    }
    const selfClosing = /^<([A-Za-z_][\w.-]*)(?:\s[^>]*)?\/>/.exec(xml.slice(index));
    if (selfClosing) {
      missing.push(selfClosing[1]);
      index += selfClosing[0].length;
      continue;
    }
    const open = /^<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>/.exec(xml.slice(index));
    if (open && !xml.startsWith('</', index)) {
      stack.push({ name: open[1], sawComment: false });
      index += open[0].length;
      continue;
    }
    const close = /^<\/([A-Za-z_][\w.-]*)\s*>/.exec(xml.slice(index));
    if (close) {
      const top = stack.pop();
      if (top && !top.sawComment) {
        missing.push(top.name);
      }
      index += close[0].length;
      continue;
    }
    index += 1;
  }
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (!top.sawComment) {
      missing.push(top.name);
    }
  }
  return missing;
};

describe.skipIf(!hasRealDefaults)('真实 kbengine_defaults.xml 全量验收', () => {
  it('良构、每元素内部带注释、取值与关闭开关时一致', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-realdefaults-'));
    fs.mkdirSync(path.join(root, 'kbe', 'res', 'server'), { recursive: true });
    fs.copyFileSync(realDefaultsPath!, path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'));
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
    configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
    try {
      const zh = buildFinalServerConfig('zh-CN').text;
      const { XMLValidator } = require('../vendor/fast-xml-parser/fxp.cjs') as {
        XMLValidator: { validate: (xml: string) => true | { err: unknown } };
      };
      expect(XMLValidator.validate(zh)).toBe(true);
      expect(zh.startsWith('<!--')).toBe(false);
      expect(elementsWithoutComment(zh)).toEqual([]);

      configurationOverrides.set('kbengine', {
        binPath: '${workspaceFolder}/kbe/bin/server',
        finalConfigComments: false
      });
      const plain = buildFinalServerConfig('zh-CN').text;
      expect(flatten(parseConfigXml(zh)!).sort()).toEqual(flatten(parseConfigXml(plain)!).sort());
    } finally {
      configurationOverrides.clear();
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
