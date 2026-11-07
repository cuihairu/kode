import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildFinalServerConfig, sanitizeXmlComment, type ConfigXmlNode } from '../src/serverConfigMerge';
import { ensureConfigResolved, resetConfigResolveForTests } from '../src/serverConfigResolve';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import {
  makeContractGate,
  mergeConfigXml,
  parseConfigXml,
  type ContractGateCall
} from './helpers/configCoreContract';
import { resolveEngineRoot } from './helpers/engineRoot';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';

// KODE-CFG-010 最终合成丢源注释的修复:解析期把输入 XML 里原有的注释按
// 「前导→紧随元素 / 行内尾随→所属叶子 / 游离→就近容器」挂进树
// (sourceComments),渲染期回写在生成注释之前并去重;合并时 override 侧优先、
// 两侧不同都保留。铁律不变:叶子注释仍在值之后(tinyxml2 IntText() 只认第一个
// 子节点是文本),取值不被注释污染。

/** 最小引擎目录树(binPath 可推导 kbe/res/server/kbengine_defaults.xml) */
function makeEngineTree(defaultsXml: string, customXml?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-srccomment-'));
  fs.mkdirSync(path.join(root, 'kbe', 'res', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'), defaultsXml);
  if (customXml !== undefined) {
    fs.writeFileSync(path.join(root, 'kbengine.xml'), customXml);
  }
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
  configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
  return root;
}

/** 输出里的注释清单(规范化:多行压单行,与渲染口径一致) */
const commentsOf = (text: string): string[] =>
  [...text.matchAll(/<!--([\s\S]*?)-->/g)].map(match => sanitizeXmlComment(match[1]));

/** 节点源注释清单(规范化后比较,原文留白不进断言) */
const sourceCommentsOf = (node: ConfigXmlNode | undefined): string[] =>
  (node?.sourceComments ?? []).map(comment => sanitizeXmlComment(comment));

/** 按点分路径下钻取叶子文本 */
const leafText = (xml: string, ...names: string[]): string | undefined => {
  let current: ConfigXmlNode | null = parseConfigXml(xml);
  for (const name of names) {
    current = current?.children.find(child => child.name === name) ?? null;
  }
  return current?.text;
};

/** 点分路径 = 文本的取值清单(顺序无关:子分类排序会改同级次序) */
const flatten = (node: ConfigXmlNode, prefix: string[] = []): string[] => {
  const here = node.name.length > 0 ? [...prefix, node.name] : prefix;
  const own = node.name.length > 0 ? [`${here.join('.')}=${node.text}`] : [];
  return [...own, ...node.children.flatMap(child => flatten(child, here))];
};

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

// KODE-CFG-009:合成链消费 core 解析(`$/kode/config/resolve`),门替身按
// 契约回数(镜像语义在 configCoreContract;真值由 Rust 侧钉死)。
const contractCalls: ContractGateCall[] = [];

const refreshCore = async (): Promise<void> => {
  contractCalls.length = 0;
  resetConfigResolveForTests();
  setKodeCoreShadowGate(makeContractGate(contractCalls));
  await ensureConfigResolved();
};

beforeEach(() => {
  configurationOverrides.clear();
  stubWorkspace.workspaceFolders = [];
});

describe('源注释回写(解析 → 合并 → 渲染)', () => {
  it('① 带注释 defaults+override 合成后源注释不丢(override 侧在前)', async () => {
    // 注释写在所描述元素的开标签之前(前导注释 → 紧随元素,归属规则见
    // parseConfigXml 文件头),故根段/段注释放各自开标签前
    const defaults = [
      '<!-- 默认根段说明 -->',
      '<root>',
      '\t<gameUpdateHertz> 10 </gameUpdateHertz>',
      '\t<!-- 默认 baseapp 说明 -->',
      '\t<baseapp>',
      '\t\t<archivePeriod> 300 </archivePeriod>',
      '\t\t<telnet_service>',
      '\t\t\t<port> 40000 </port>',
      '\t\t</telnet_service>',
      '\t</baseapp>',
      '</root>'
    ].join('\n');
    const custom = [
      '<!-- 元件根段说明 -->',
      '<root>',
      '\t<!-- 元件 baseapp 说明 -->',
      '\t<baseapp>',
      '\t\t<archivePeriod> 600 </archivePeriod>',
      '\t</baseapp>',
      '</root>'
    ].join('\n');
    const root = makeEngineTree(defaults, custom);
    try {
      await refreshCore();
      const text = buildFinalServerConfig('zh-CN').text;
      const comments = commentsOf(text);
      // defaults 侧、元件侧、未被覆盖的段,源注释都还在
      expect(comments).toContain('默认根段说明');
      expect(comments).toContain('元件根段说明');
      expect(comments).toContain('默认 baseapp 说明');
      expect(comments).toContain('元件 baseapp 说明');
      // 同元素两侧注释:override 侧在前(优先),不同则都保留
      expect(comments.indexOf('元件根段说明')).toBeLessThan(comments.indexOf('默认根段说明'));
      expect(comments.indexOf('元件 baseapp 说明')).toBeLessThan(
        comments.indexOf('默认 baseapp 说明')
      );
      // 注释回写不改变取值:被覆盖的取元件值,未覆盖的取默认值
      expect(leafText(text, 'root', 'baseapp', 'archivePeriod')).toBe('600');
      expect(leafText(text, 'root', 'baseapp', 'telnet_service', 'port')).toBe('40000');
      expect(leafText(text, 'root', 'gameUpdateHertz')).toBe('10');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('② 源注释与生成注释同内容只显示一次,不同内容两者都留', async () => {
    const defaults = [
      '<root>',
      '\t<!-- 游戏逻辑处理频率HZ -->',
      '\t<gameUpdateHertz> 10 </gameUpdateHertz>',
      '\t<baseapp>',
      '\t\t<bitsPerSecondToClient> 20000 </bitsPerSecondToClient>\t\t<!-- Type: Integer -->',
      '\t</baseapp>',
      '</root>'
    ].join('\n');
    const root = makeEngineTree(defaults);
    try {
      await refreshCore();
      const text = buildFinalServerConfig('zh-CN').text;
      // 文案库 zh 正文即收割自该行:不去重会「源注释 + 生成注释」各显示一遍
      expect(countOf(text, '游戏逻辑处理频率HZ')).toBe(1);
      expect(commentsOf(text)).toContain('游戏逻辑处理频率HZ');
      // 内容不同的源注释(Type: Integer)不误杀生成注释:两者都在
      expect(commentsOf(text)).toContain('Type: Integer');
      expect(text).toContain('每秒发送到客户端的带宽限制');
      // 源注释在生成注释之前
      const comments = commentsOf(text);
      expect(comments.indexOf('Type: Integer')).toBeLessThan(
        comments.findIndex(comment => comment.includes('每秒发送到客户端的带宽限制'))
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('③ 叶子注释仍在值之后:回读取值不被注释污染', async () => {
    const defaults = [
      '<root>',
      '\t<baseapp>',
      '\t\t<archivePeriod><!-- 注释在值前也落到值后 --> 300 </archivePeriod>',
      '\t\t<SOMAXCONN> 511 <!-- 行内尾随注释 --></SOMAXCONN>',
      '\t\t<telnet_service>',
      '\t\t\t<port> 40000 </port>',
      '\t\t</telnet_service>',
      '\t</baseapp>',
      '</root>'
    ].join('\n');
    const root = makeEngineTree(defaults);
    try {
      await refreshCore();
      const text = buildFinalServerConfig('zh-CN').text;
      // 铁律:值是第一个子节点,源注释排在其后(tinyxml2 IntText() 取原值)
      expect(text).toMatch(/<archivePeriod>\s*300\s*<!--[^]*?-->\s*<\/archivePeriod>/);
      expect(text).toMatch(/<SOMAXCONN>\s*511\s*<!--[^]*?-->\s*<\/SOMAXCONN>/);
      // 源注释确实回写了
      expect(commentsOf(text)).toContain('注释在值前也落到值后');
      expect(commentsOf(text)).toContain('行内尾随注释');
      // 取值断言:回读合成树,值不被注释文本污染
      expect(leafText(text, 'root', 'baseapp', 'archivePeriod')).toBe('300');
      expect(leafText(text, 'root', 'baseapp', 'SOMAXCONN')).toBe('511');
      expect(leafText(text, 'root', 'baseapp', 'telnet_service', 'port')).toBe('40000');
      // telnet 速览同口径已随 core 读取(KODE-CFG-009:telnetSummary 由
      // `$/kode/config/resolve` 直出,见 serverConfigResolve 测试)
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('⑤ 游离注释就近归属:文件级/文件尾挂段首容器,段尾挂所在容器,不落文件头', async () => {
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<!-- 文件级前导注释 -->',
      '<root>',
      '\t<baseapp>',
      '\t\t<archivePeriod> 300 </archivePeriod>',
      '\t\t<!-- 段尾游离注释 -->',
      '\t</baseapp>',
      '</root>',
      '<!-- 文件尾游离注释 -->'
    ].join('\n');
    const tree = parseConfigXml(xml)!;
    const root = tree.children[0];
    // 文件级前导 → 段首容器;文件尾 → 同一段首容器(不丢、不落文件头)
    expect(sourceCommentsOf(root)).toEqual(['文件级前导注释', '文件尾游离注释']);
    const baseapp = root.children.find(child => child.name === 'baseapp')!;
    expect(sourceCommentsOf(baseapp)).toEqual(['段尾游离注释']);

    const dir = makeEngineTree(xml);
    try {
      await refreshCore();
      const text = buildFinalServerConfig('zh-CN').text;
      expect(text.startsWith('<!--')).toBe(false);
      for (const comment of ['文件级前导注释', '段尾游离注释', '文件尾游离注释']) {
        expect(commentsOf(text)).toContain(comment);
        // 每条都在元素内部(段首容器内),不悬在文件头/元素外
        expect(text).toMatch(new RegExp(`<[\\w]+>[^]*?${comment}[^]*?</[\\w]+>`));
      }
      // 确无归属(纯注释输入):丢弃并返回 null,不崩
      expect(parseConfigXml('<!-- nothing to attach -->')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('⑥ kbengine.finalConfigComments 关闭:只输出源注释,不输出生成注释(含头注)', async () => {
    const defaults = [
      '<root>',
      '\t<!-- 源注释是原文,不随开关走 -->',
      '\t<gameUpdateHertz> 10 </gameUpdateHertz>',
      '</root>'
    ].join('\n');
    const root = makeEngineTree(defaults);
    try {
      configurationOverrides.set('kbengine', {
        binPath: '${workspaceFolder}/kbe/bin/server',
        finalConfigComments: false
      });
      await refreshCore();
      const off = buildFinalServerConfig('zh-CN').text;
      expect(commentsOf(off)).toEqual(['源注释是原文,不随开关走']);
      expect(off).not.toContain('合成最终配置');
      expect(off).not.toContain('【');
      expect(off).not.toContain('〔来源');

      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
      await refreshCore();
      const on = buildFinalServerConfig('zh-CN').text;
      expect(commentsOf(on)).toContain('源注释是原文,不随开关走');
      expect(on).toContain('合成最终配置');
      expect(on).toContain('〔来源: kbe/res/server/kbengine_defaults.xml');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// 真实引擎 defaults 全量回保(引擎检出缺席时 skip,与 RealDefaults 用例同口径)
const engineRoot = resolveEngineRoot();
const realDefaultsPath = engineRoot
  ? path.join(engineRoot, 'kbe', 'res', 'server', 'kbengine_defaults.xml')
  : null;
const hasRealDefaults = realDefaultsPath !== null && fs.existsSync(realDefaultsPath);

describe.skipIf(!hasRealDefaults)('④ 真实 kbengine_defaults.xml 源注释全量回保', () => {
  it('192 条源注释逐条回写、出现次数不少于原文,取值与原文一致', async () => {
    const raw = fs.readFileSync(realDefaultsPath!, 'utf8');
    const inputs = [...raw.matchAll(/<!--([\s\S]*?)-->/g)].map(match =>
      sanitizeXmlComment(match[1])
    );
    expect(inputs).toHaveLength(192);

    const root = makeEngineTree(raw);
    try {
      await refreshCore();
      const text = buildFinalServerConfig('zh-CN').text;
      const outputs = commentsOf(text);
      const distinct = [...new Set(inputs)];
      // 每条源注释都在合成结果里(去重只杀生成注释,不吞源注释)
      expect(distinct.filter(comment => !outputs.includes(comment))).toEqual([]);
      // 出现次数不少于原文:同文本注释散在不同元素时各留一条
      for (const comment of distinct) {
        expect(
          outputs.filter(output => output === comment).length,
          `${comment.slice(0, 24)}…`
        ).toBeGreaterThanOrEqual(inputs.filter(input => input === comment).length);
      }
      // 取值与原文逐项一致:注释回写不污染任何叶子值
      expect(flatten(parseConfigXml(text)!).sort()).toEqual(flatten(parseConfigXml(raw)!).sort());
    } finally {
      configurationOverrides.clear();
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
