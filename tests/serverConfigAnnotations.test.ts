import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildFinalServerConfig, renderConfigXmlSections, type ConfigXmlNode } from '../src/serverConfigMerge';
import { ensureConfigResolved, resetConfigResolveForTests } from '../src/serverConfigResolve';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import { makeContractGate, parseConfigXml, type ContractGateCall } from './helpers/configCoreContract';
import { annotateConfigTree } from '../src/serverConfigAnnotations';
import {
  SERVER_CONFIG_GROUPS,
  SERVER_CONFIG_GROUP_ORDER,
  SERVER_CONFIG_ITEM_DOCS,
  SERVER_CONFIG_UNKNOWN_DOC,
  findServerConfigItemDoc
} from '../src/serverConfigCatalog';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { env as stubEnv } from './helpers/vscodeStub';

// final XML config 增强(用户令):按子分类分组 + 逐项语言化作用注释 + 自定义项
// 归入「自定义配置·未识别」。注释一律放元素内部(容器在子节点前、顶层键与
// <item> 在值之后,取证见 src/serverConfigAnnotations.ts 文件头),生成的 XML
// 仍须可被解析且值不变。
//
// prove-red:这些断言在增强落地前全部为红——旧渲染器 renderConfigXml 不认
// comment 字段、buildFinalServerConfig 不做分组也不产注释;文末「开关关闭」
// 用例即把开关拨到关,断言同样落空,证明断言确实依赖新功能而非恒真。

const engineDefaults = [
  '<root>',
  '\t<gameUpdateHertz> 10 </gameUpdateHertz>',
  '\t<trace_packet>',
  '\t\t<debug_type> 0 </debug_type>',
  '\t\t<disables>',
  '\t\t\t<item> Client::onUpdateData </item>',
  '\t\t</disables>',
  '\t</trace_packet>',
  '\t<baseapp>',
  '\t\t<archivePeriod> 300 </archivePeriod>',
  '\t\t<SOMAXCONN> 511 </SOMAXCONN>',
  '\t\t<telnet_service>',
  '\t\t\t<port> 40000 </port>',
  '\t\t</telnet_service>',
  '\t</baseapp>',
  '\t<machine>',
  '\t\t<addresses>',
  '\t\t\t<item> 127.0.0.1 </item>',
  '\t\t</addresses>',
  '\t</machine>',
  '</root>'
].join('\n');

/** 建一棵最小引擎目录树(binPath 可推导 kbe/res/server/kbengine_defaults.xml);
 * KODE-CFG-009:合成读值消费 core 解析,树建好即刷新消费态(契约门替身)。 */
const contractCalls: ContractGateCall[] = [];
async function makeEngineTree(defaultsXml: string, customXml?: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-annot-'));
  fs.mkdirSync(path.join(root, 'kbe', 'res', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'), defaultsXml);
  if (customXml !== undefined) {
    fs.writeFileSync(path.join(root, 'kbengine.xml'), customXml);
  }
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
  configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
  contractCalls.length = 0;
  resetConfigResolveForTests();
  setKodeCoreShadowGate(makeContractGate(contractCalls));
  await ensureConfigResolved();
  return root;
}

/** 取值清单:点分路径 = 文本,顺序无关(子分类排序会改变同级次序,比对应当
 * 忽略次序,只锁「哪些键取什么值」)。 */
function flatten(node: ConfigXmlNode, prefix: string[] = []): string[] {
  const here = node.name.length > 0 ? [...prefix, node.name] : prefix;
  const own = node.name.length > 0 ? [`${here.join('.')}=${node.text}`] : [];
  return [...own, ...node.children.flatMap(child => flatten(child, here))];
}

/** 注释文本清单(顺序即出现顺序) */
function commentsOf(text: string): string[] {
  return [...text.matchAll(/<!--([\s\S]*?)-->/g)].map(match => match[1].trim());
}

/** 逐行标签栈:校验每条注释都落在某元素内部(不出现在文件头/元素上方) */
function commentPlacementViolations(text: string): string[] {
  const violations: string[] = [];
  const stack: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index);
      if (stack.length === 0) {
        violations.push(`文件头/元素外注释: ${text.slice(index, Math.min(end + 3, index + 60))}`);
      }
      index = end + 3;
      continue;
    }
    const open = /^<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>/.exec(text.slice(index));
    if (open && !text.startsWith(`</${open[1]}`, index)) {
      if (!text.slice(index).startsWith(`<${open[1]}/>`)) {
        stack.push(open[1]);
      }
      index += open[0].length;
      continue;
    }
    const close = /^<\/([A-Za-z_][\w.-]*)\s*>/.exec(text.slice(index));
    if (close) {
      stack.pop();
      index += close[0].length;
      continue;
    }
    index += 1;
  }
  return violations;
}

/** 每个元素内部是否都至少有一条注释(用户令:每个配置元素内部都要带作用注释) */
function elementsWithoutComment(text: string): string[] {
  const missing: string[] = [];
  const stack: Array<{ name: string; sawComment: boolean }> = [];
  let index = 0;
  const close = (name: string): void => {
    const top = stack.pop();
    if (top && !top.sawComment) {
      missing.push(top.name);
    }
    void name;
  };
  while (index < text.length) {
    if (text.startsWith('<!--', index)) {
      if (stack.length > 0) {
        stack[stack.length - 1].sawComment = true;
      }
      index = text.indexOf('-->', index) + 3;
      continue;
    }
    const selfClosing = /^<([A-Za-z_][\w.-]*)(?:\s[^>]*)?\/>/.exec(text.slice(index));
    if (selfClosing) {
      missing.push(selfClosing[1]);
      index += selfClosing[0].length;
      continue;
    }
    const open = /^<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>/.exec(text.slice(index));
    if (open && !text.startsWith(`</`, index)) {
      stack.push({ name: open[1], sawComment: false });
      index += open[0].length;
      continue;
    }
    const closing = /^<\/([A-Za-z_][\w.-]*)\s*>/.exec(text.slice(index));
    if (closing) {
      close(closing[1]);
      index += closing[0].length;
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
}

const parse = (xml: string): ConfigXmlNode => parseConfigXml(xml)!;

describe('annotateConfigTree(子分类分组)', () => {
  const tree = () => parse(engineDefaults);

  it('段内按功能子分类排序,同组保持引擎原序,自定义项沉底', async () => {
    const custom = parse(
      engineDefaults.replace(
        '\t\t<telnet_service>',
        '\t\t<myCustomThing> 1 </myCustomThing>\n\t\t<telnet_service>'
      )
    )!;
    const annotated = annotateConfigTree(custom, { language: 'zh-CN' });
    const root = annotated.children[0];
    const baseapp = root.children.find(child => child.name === 'baseapp')!;
    // 输入序 archivePeriod(备份) → SOMAXCONN(网络) → 自定义 → telnet(控制台)
    expect(baseapp.children.map(child => child.name)).toEqual([
      'SOMAXCONN',
      'telnet_service',
      'archivePeriod',
      'myCustomThing'
    ]);
  });

  it('配置根段的全局键与进程段不重排(保持引擎原序)', async () => {
    const annotated = annotateConfigTree(tree(), { language: 'zh-CN' });
    expect(annotated.children[0].children.map(child => child.name)).toEqual([
      'gameUpdateHertz',
      'trace_packet',
      'baseapp',
      'machine'
    ]);
  });

  it('子分类来自文案库:网络在备份之前,自定义恒最后', async () => {
    expect(SERVER_CONFIG_GROUP_ORDER[SERVER_CONFIG_GROUP_ORDER.length - 1]).toBe('custom');
    expect(SERVER_CONFIG_GROUP_ORDER.indexOf('net')).toBeLessThan(
      SERVER_CONFIG_GROUP_ORDER.indexOf('backup')
    );
    expect(SERVER_CONFIG_GROUPS.net.zh).toBe('网络与连接');
    expect(SERVER_CONFIG_GROUPS.custom.zh).toContain('自定义配置');
  });

  it('enabled=false:不加注释也不重排(头注同属生成物,一并不输出)', async () => {
    const annotated = annotateConfigTree(tree(), {
      language: 'zh-CN',
      enabled: false,
      header: 'kode 合成最终配置:test'
    });
    const baseapp = annotated.children[0].children.find(child => child.name === 'baseapp')!;
    expect(baseapp.children.map(child => child.name)).toEqual([
      'archivePeriod',
      'SOMAXCONN',
      'telnet_service'
    ]);
    expect(baseapp.children.every(child => child.comment === undefined)).toBe(true);
    // 文档头注是生成物(与源注释分两套,见 ConfigXmlNode 注释),开关关闭即不输出
    expect(annotated.children[0].docHeader).toBeUndefined();
  });
});

describe('annotateConfigTree(语言化作用注释)', () => {
  const tree = () => parse(engineDefaults);

  it('zh 环境出中文注释(分类标签 + 作用 + 来源)', async () => {
    const annotated = annotateConfigTree(tree(), { language: 'zh-CN' });
    const somaxconn = annotated.children[0].children
      .find(child => child.name === 'baseapp')!
      .children.find(child => child.name === 'SOMAXCONN')!;
    expect(somaxconn.comment).toContain('【网络与连接】');
    expect(somaxconn.comment).toContain('listen监听队列最大值');
    expect(somaxconn.comment).toContain('来源: kbe/res/server/kbengine_defaults.xml');
  });

  it('en 环境出英文注释(同一条目换语言,取证不变)', async () => {
    const annotated = annotateConfigTree(tree(), { language: 'en' });
    const somaxconn = annotated.children[0].children
      .find(child => child.name === 'baseapp')!
      .children.find(child => child.name === 'SOMAXCONN')!;
    expect(somaxconn.comment).toContain('[Network & Transport]');
    expect(somaxconn.comment).toContain('listen: Maximum listen queue');
    expect(somaxconn.comment).toContain('(source: kbe/res/server/kbengine_defaults.xml');
  });

  it('vscode.env.language 决定默认语言(zh-CN → 中文,en → 英文)', async () => {
    const root = await makeEngineTree(engineDefaults);
    const original = stubEnv.language;
    try {
      stubEnv.language = 'zh-CN';
      expect(buildFinalServerConfig().text).toContain('【');
      stubEnv.language = 'en';
      expect(buildFinalServerConfig().text).toContain('[Network & Transport]');
    } finally {
      stubEnv.language = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('传入 language 覆盖环境语言(buildFinalServerConfig 参数)', async () => {
    const root = await makeEngineTree(engineDefaults);
    try {
      const zh = buildFinalServerConfig('zh-CN').text;
      const en = buildFinalServerConfig('en').text;
      expect(zh).toContain('【备份与存档】');
      expect(en).toContain('[Backup & Archive]');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('annotateConfigTree(自定义项归类)', () => {
  const withCustom = (): ConfigXmlNode =>
    parse(
      engineDefaults.replace(
        '\t\t<telnet_service>',
        '\t\t<myCustomThing> 1 </myCustomThing>\n\t\t<telnet_service>'
      )
    )!;

  it('查不到含义的自定义项归入「自定义配置」子分类并标「未识别」', async () => {
    const annotated = annotateConfigTree(withCustom(), { language: 'zh-CN' });
    const baseapp = annotated.children[0].children.find(child => child.name === 'baseapp')!;
    const custom = baseapp.children.find(child => child.name === 'myCustomThing')!;
    expect(custom.comment).toContain(SERVER_CONFIG_GROUPS.custom.zh);
    expect(custom.comment).toContain('未识别');
    expect(custom.comment).not.toContain('来源');
    // 排序上也归到自定义子分类(恒最后)
    expect(baseapp.children[baseapp.children.length - 1].name).toBe('myCustomThing');
  });

  it('英文环境标 Custom (unrecognized)', async () => {
    const annotated = annotateConfigTree(withCustom(), { language: 'en' });
    const baseapp = annotated.children[0].children.find(child => child.name === 'baseapp')!;
    const custom = baseapp.children.find(child => child.name === 'myCustomThing')!;
    expect(custom.comment).toContain('[Custom (unrecognized)]');
    expect(custom.comment).toContain(SERVER_CONFIG_UNKNOWN_DOC.en.slice(0, 40));
  });

  it('文案库查表:整路径 → 去根段 → 无歧义裸键,歧义键不猜', async () => {
    expect(findServerConfigItemDoc(['baseapp', 'archivePeriod'])).toBeTruthy();
    expect(findServerConfigItemDoc(['root', 'baseapp', 'archivePeriod'])?.zh).toContain('存档');
    expect(findServerConfigItemDoc(['port', 'password'])).toBeNull();
    expect(findServerConfigItemDoc(['nope', 'notInCatalog'])).toBeNull();
  });
});

describe('生成的 XML:注释位置与结构', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    stubWorkspace.workspaceFolders = [];
  });

  it('注释全部在元素内部:不落文件头、不出现在元素上方', async () => {
    const root = await makeEngineTree(engineDefaults);
    try {
      const text = buildFinalServerConfig('zh-CN').text;
      expect(text.startsWith('<!--')).toBe(false);
      expect(commentPlacementViolations(text)).toEqual([]);
      // 文档头注也进第一个顶层元素
      expect(text).toContain('<root>');
      expect(commentsOf(text)[0]).toContain('kode 合成最终配置');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('每个配置元素内部都带对应语言的作用注释', async () => {
    const root = await makeEngineTree(engineDefaults);
    try {
      const text = buildFinalServerConfig('zh-CN').text;
      expect(elementsWithoutComment(text)).toEqual([]);
      expect(text).toContain('【日志与调试】');
      expect(text).toContain('〔来源: kbe/src/lib/server/serverconfig.cpp:151-166〕');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('注释位置规则:容器/嵌套叶子在值之前,顶层键与 <item> 在值之后', async () => {
    const root = await makeEngineTree(engineDefaults);
    try {
      const text = buildFinalServerConfig('zh-CN').text;
      // 容器:注释是第一个子节点
      expect(text).toMatch(/<trace_packet>\s*<!--[^]*?-->\s*<debug_type>/);
      // 叶子:注释在值之后但仍在元素内部(tinyxml2 的 IntText()/DoubleText() 只认
      // 第一个子节点是文本,注释在值前会把数值读成默认值——取证见注解模块文件头)
      expect(text).toMatch(/<archivePeriod>\s*300\s*<!--[^]*?-->\s*<\/archivePeriod>/);
      // 顶层叶子:值仍是第一个子节点(注释在其后),引擎经 getRootNode 取 FirstChild
      expect(text).toMatch(/<gameUpdateHertz>\s*10\s*<!--[^]*?-->\s*<\/gameUpdateHertz>/);
      // <item>:值是第一个子节点(注释在其后),引擎按 FirstChild()->Value() 取原值
      // (serverconfig.cpp:157-164 disables.item、:1396-1401 machine.addresses.item)
      expect(text).toMatch(/<item>\s*Client::onUpdateData\s*<!--[^]*?-->\s*<\/item>/);
      expect(text).toMatch(/<item>\s*127\.0\.0\.1\s*<!--[^]*?-->\s*<\/item>/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('注释文本不与任何元素同名(TinyXML FirstChild(key) 按值匹配注释)', async () => {
    const root = await makeEngineTree(engineDefaults);
    try {
      const text = buildFinalServerConfig('zh-CN').text;
      const tagNames = new Set([...text.matchAll(/<\/?([A-Za-z_][\w.-]*)/g)].map(m => m[1]));
      for (const comment of commentsOf(text)) {
        expect(tagNames.has(comment)).toBe(false);
        expect(comment).not.toMatch(/^\w+$/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('生成的 XML:可解析且值不变', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    stubWorkspace.workspaceFolders = [];
  });

  it('带注释的合成文档是良构 XML(XMLValidator 通过)', async () => {
    const { XMLValidator } = require('../vendor/fast-xml-parser/fxp.cjs') as {
      XMLValidator: { validate: (xml: string) => true | { err: unknown } };
    };
    const root = await makeEngineTree(engineDefaults);
    try {
      const text = buildFinalServerConfig('zh-CN').text;
      expect(XMLValidator.validate(text)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('注释不改变结构与取值(与关掉开关的渲染逐节点等价)', async () => {
    const root = await makeEngineTree(engineDefaults);
    try {
      const annotated = buildFinalServerConfig('zh-CN').text;
      configurationOverrides.set('kbengine', {
        binPath: '${workspaceFolder}/kbe/bin/server',
        finalConfigComments: false
      });
      const plain = buildFinalServerConfig('zh-CN').text;

      const annotatedTree = parseConfigXml(annotated);
      const plainTree = parseConfigXml(plain);
      expect(annotatedTree).not.toBeNull();
      // 次序会因子分类重排,比对「路径=取值」清单(顺序无关)即锁住结构与取值
      expect(flatten(annotatedTree!).sort()).toEqual(flatten(plainTree!).sort());

      // 关键取值逐项复核
      const root0 = annotatedTree!.children[0];
      expect(root0.children.find(child => child.name === 'gameUpdateHertz')!.text).toBe('10');
      const baseapp = root0.children.find(child => child.name === 'baseapp')!;
      expect(baseapp.children.find(child => child.name === 'archivePeriod')!.text).toBe('300');
      const trace = root0.children.find(child => child.name === 'trace_packet')!;
      const disables = trace.children.find(child => child.name === 'disables')!;
      expect(disables.children[0].text).toBe('Client::onUpdateData');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('开关关闭(kbengine.finalConfigComments=false):无生成注释、原顺序(源注释仍回写)', async () => {
    const root = await makeEngineTree(engineDefaults);
    try {
      configurationOverrides.set('kbengine', {
        binPath: '${workspaceFolder}/kbe/bin/server',
        finalConfigComments: false
      });
      const text = buildFinalServerConfig('zh-CN').text;
      // 本用例的 defaults 无源注释 → 生成注释(含文档头注)全关后一条不剩
      expect(commentsOf(text)).toHaveLength(0);
      expect(text).not.toContain('来源:');
      expect(text).not.toContain('合成最终配置');
      const baseapp = parseConfigXml(text)!.children[0].children
        .find(child => child.name === 'baseapp')!;
      expect(baseapp.children.map(child => child.name)).toEqual([
        'archivePeriod',
        'SOMAXCONN',
        'telnet_service'
      ]);
      // 证明上面那些注释断言依赖新功能:关掉后一条都不剩
      expect(elementsWithoutComment(text).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('元件 kbengine.xml 的自定义键同样带注释并归自定义子分类', async () => {
    const root = await makeEngineTree(
      engineDefaults,
      '<root><baseapp><archivePeriod>600</archivePeriod><brandNewKey> abc </brandNewKey></baseapp></root>'
    );
    try {
      const text = buildFinalServerConfig('zh-CN').text;
      expect(text).toContain('<archivePeriod>');
      expect(text).toContain('600');
      const baseapp = parseConfigXml(text)!.children[0].children
        .find(child => child.name === 'baseapp')!;
      expect(baseapp.children[baseapp.children.length - 1].name).toBe('brandNewKey');
      expect(elementsWithoutComment(text)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('文案库数据(便于维护的注释库自身)', () => {
  it('每条目双语 + 取证 + 合法子分类,且不含会破坏 XML 注释的 `--`', async () => {
    const keys = Object.keys(SERVER_CONFIG_ITEM_DOCS);
    expect(keys.length).toBeGreaterThan(200);
    for (const key of keys) {
      const doc = SERVER_CONFIG_ITEM_DOCS[key];
      expect(doc.zh.length, `${key} zh`).toBeGreaterThan(0);
      expect(doc.en.length, `${key} en`).toBeGreaterThan(0);
      expect(doc.source, `${key} source`).toMatch(/^kbe\//);
      expect(SERVER_CONFIG_GROUP_ORDER).toContain(doc.group);
      expect(doc.zh).not.toContain('--');
      expect(doc.en).not.toContain('--');
    }
  });

  it('用户点名的 trace_packet.disables 有逐项取证说明', async () => {
    const doc = SERVER_CONFIG_ITEM_DOCS['trace_packet.disables']!;
    expect(doc.zh).toContain('包跟踪排除名单');
    expect(doc.source).toContain('serverconfig.cpp');
    expect(SERVER_CONFIG_ITEM_DOCS['trace_packet.debug_type']!.zh).toContain('16 进制');
    expect(SERVER_CONFIG_ITEM_DOCS['trace_packet.disables.item']!.zh).toContain('消息名');
  });
});

describe('renderConfigXml(无注释时排版不变)', () => {
  it('叶子/容器/空值排版与旧口径一致(关掉增强即回到该形态)', async () => {
    expect(renderConfigXmlSections(parse('<baseapp><port> 40000 </port><p/></baseapp>'))).toBe(
      ['<baseapp>', '\t<port> 40000 </port>', '\t<p></p>', '</baseapp>'].join('\n')
    );
  });
});
