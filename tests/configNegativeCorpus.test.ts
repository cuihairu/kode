/**
 * KSEM-CFG-11 配置负例集(纯核心面)。
 *
 * 验收口径(todo.md SEM-041,旧 KSEM-CFG-11):覆盖自定义合法键、重复节点、
 * 环境覆盖、缺文件、多根、JSONC、敏感值和版本差异;**不允许默认值推断
 * 产生伪错误**。
 *
 * 语料轴(每轴先定「容忍语义」再钉输出——负例集不是「全部必须报错」,
 * 是「不许假阳性/不许崩溃/不许越权声称」):
 *  - 自定义合法键:有源码类型/枚举证据的键给合法值 → 零诊断;用户自己的
 *    工具键(引擎目录没有)→ unknownKey 仅 information(引擎容忍忽略);
 *  - 反伪错误闸(验收核心句):defaults-value-only 记录(只有默认值形态,
 *    无类型注释/读取点证据)给怪值 → 零诊断——不从默认值形态猜类型;
 *  - 重复节点:同名重复叶同坏值 → 去重后一条(行锚=首现行);不同坏值
 *    → 两条;合并面整表替换不崩,重复条目都保留;
 *  - 环境覆盖:profile overrideRoot 只认自己的资产根——overrideRoot 下
 *    无 kbengine.xml = 该 profile 无元件配置(纯 defaults),绝不回落
 *    工作区/设置链(回落即读到别的项目的配置);
 *  - 缺文件:custom 缺 → 零值诊断;defaults 缺 → 影响面 null/零声称;
 *    serialization.json 缺 → schema=null 全静默(类型面零声称不是全报);
 *  - 多根:parseConfigXml 空名包裹保留全部顶层元素,normalizeRootNode
 *    取 <root>;游离顶层元素不入树路径 → 不产生任何诊断(不猜);
 *  - JSONC:serialization.json 是工具生成的严格 JSON——手写注释/尾逗号
 *    → schema=null + 显式错误,类型面静默零声称(不硬猜不报伪错);
 *  - 敏感值:string 类型敏感键(password)永不类型检查 → 无诊断无明文;
 *    来源证据块/修改影响块只出脱敏形态;
 *  - 版本差异:schema_version=2 照收(整数,不按版本分叉行为);非整数
 *    → version=null + 显式错误但 schema 其余面照常;旧版 defaults 缺段
 *    → custom 键落 dynamic-extension → unknownKey information(非 error)。
 * 真实引擎 defaults 夹具做基线,零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfigXml, mergeConfigXml } from '../src/serverConfigFallbackCore';
import { resolveCustomConfigXmlPath } from '../src/serverConfigResolve';
import type { ConfigXmlNode } from '../src/serverConfigMerge';
import { extractConfigContracts } from '../src/backend/configContract';
import {
  scanConfigFieldIdentities,
  normalizeRootNode,
  classifyConfigField
} from '../src/backend/configFieldIdentity';
import {
  computeConfigValueFindings,
  type ConfigValueFinding
} from '../src/backend/configValueValidation';
import { parseSerializationSchema } from '../src/backend/jsonChainPropagation';
import { deriveProjectConfigStructure } from '../src/backend/configProjectStructure';
import {
  checkEngineConfigRelations,
  checkProjectPathBaseline
} from '../src/backend/configRelationChecks';
import {
  computeKeyImpact,
  renderImpactBlock
} from '../src/backend/configImpact';
import {
  configSourceInfo,
  renderSourceEvidenceBlock
} from '../src/backend/configSourceFace';

const DEFAULTS_PATH = path.join(__dirname, 'fixtures/config/kbengine_defaults.xml');
const defaultsText = readFileSync(DEFAULTS_PATH, 'utf8');

const defaultsTree = (): ConfigXmlNode => {
  const tree = parseConfigXml(defaultsText);
  if (tree === null) {
    throw new Error('defaults fixture failed to parse');
  }
  return tree;
};

const parseCustom = (xml: string): ConfigXmlNode => {
  const tree = parseConfigXml(xml);
  if (tree === null) {
    throw new Error('custom fixture failed to parse');
  }
  return tree;
};

/** 完整值校验管道(defaults 真夹具 + 合成 custom 文本)。 */
const validate = (customXml: string, defaults: ConfigXmlNode = defaultsTree()): ConfigValueFinding[] => {
  const customTree = parseCustom(customXml);
  const extraction = extractConfigContracts(defaultsText, defaults);
  const scan = scanConfigFieldIdentities(defaults, customTree);
  return computeConfigValueFindings({
    customText: customXml,
    customTree,
    extraction,
    scan
  });
};

const findingsOf = (findings: ConfigValueFinding[], code: string): ConfigValueFinding[] =>
  findings.filter((f) => f.code === code);

describe('KSEM-CFG-11 negative corpus: 自定义合法键与反伪错误闸', () => {
  it('legal typed/enum values produce zero diagnostics; own tooling key is information-only', () => {
    const out = validate([
      '<root>',
      '  <dbmgr>',
      '    <allowEmptyDigest>false</allowEmptyDigest>',
      '    <databaseInterfaces>',
      '      <default>',
      '        <port>33066</port>',
      '        <numConnections>4</numConnections>',
      '      </default>',
      '    </databaseInterfaces>',
      '  </dbmgr>',
      '  <trace_packet>',
      '    <debug_type>2</debug_type>',
      '  </trace_packet>',
      '  <myToolFlag>whatever</myToolFlag>',
      '</root>'
    ].join('\n'));
    // 类型面(boolean/integer 合法值)与枚举面(文档值)零诊断
    expect(findingsOf(out, 'kbengine.configValue.typeMismatch')).toEqual([]);
    expect(findingsOf(out, 'kbengine.configValue.enumMismatch')).toEqual([]);
    // 自有工具键:引擎容忍忽略 → 仅 information,绝无 error/warning
    const unknown = findingsOf(out, 'kbengine.configValue.unknownKey');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].path).toBe('myToolFlag');
    expect(unknown[0].severity).toBe('information');
  });

  it('no fake errors from default-value inference: defaults-value-only key with a weird value stays silent', () => {
    // gameUpdateHertz 在引擎默认里是顶层键,只有值形态证据(defaults-value-only),
    // 无类型注释/读取点 → 怪值零诊断(不从默认值猜类型,验收核心句)
    const record = extractConfigContracts(defaultsText, defaultsTree())
      .records.find((r) => r.path === 'gameUpdateHertz')!;
    expect(record.evidence).toBe('defaults-value-only');
    const out = validate([
      '<root>',
      '  <gameUpdateHertz>notanumber</gameUpdateHertz>',
      '</root>'
    ].join('\n'));
    expect(out).toEqual([]);
  });
});

describe('KSEM-CFG-11 negative corpus: 重复节点', () => {
  it('duplicate leaves with identical bad value collapse to one finding at the first line', () => {
    const customXml = [
      '<root>',
      '  <dbmgr>',
      '    <allowEmptyDigest>x</allowEmptyDigest>',
      '    <allowEmptyDigest>x</allowEmptyDigest>',
      '  </dbmgr>',
      '</root>'
    ].join('\n');
    const out = validate(customXml);
    const bad = findingsOf(out, 'kbengine.configValue.typeMismatch');
    expect(bad).toHaveLength(1);
    expect(bad[0].line).toBe(3); // 首现行锚
  });

  it('duplicate leaves with distinct bad values keep both findings', () => {
    const out = validate([
      '<root>',
      '  <dbmgr>',
      '    <allowEmptyDigest>x</allowEmptyDigest>',
      '    <allowEmptyDigest>y</allowEmptyDigest>',
      '  </dbmgr>',
      '</root>'
    ].join('\n'));
    const bad = findingsOf(out, 'kbengine.configValue.typeMismatch');
    expect(bad).toHaveLength(2);
    expect(bad.map((f) => f.args.value).sort()).toEqual(['x', 'y']);
  });

  it('merge keeps both duplicate override nodes (whole-table replace), no crash', () => {
    const base = parseCustom('<root>\n  <dbmgr>\n    <a>1</a>\n  </dbmgr>\n</root>');
    const override = parseCustom(
      '<root>\n  <dbmgr>\n    <a>2</a>\n  </dbmgr>\n  <dbmgr>\n    <a>3</a>\n  </dbmgr>\n</root>'
    );
    const merged = mergeConfigXml(normalizeRootNode(base), normalizeRootNode(override));
    const dbmgrs = merged.children.filter((c) => c.name === 'dbmgr');
    expect(dbmgrs).toHaveLength(2); // 整表替换:两条都保留
    expect(dbmgrs.map((d) => d.children[0].text.trim())).toEqual(['2', '3']);
  });
});

describe('KSEM-CFG-11 negative corpus: 环境覆盖(profile 资产根)', () => {
  it('overrideRoot without kbengine.xml never falls back to the workspace chain', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'cfg11-empty-'));
    try {
      // overrideRoot 下无配置 → null;绝不回落 workspaceRoot(读到别的项目=伪数据)
      expect(resolveCustomConfigXmlPath('/definitely/not/this/workspace', empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('overrideRoot with a config resolves exactly that config (own assets only)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfg11-has-'));
    try {
      writeFileSync(path.join(dir, 'kbengine.xml'), '<root>\n</root>\n');
      expect(resolveCustomConfigXmlPath('/definitely/not/this/workspace', dir)).toBe(
        path.join(dir, 'kbengine.xml')
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('res/server subpath is the second candidate when the root file is absent', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfg11-res-'));
    try {
      mkdirSync(path.join(dir, 'res', 'server'), { recursive: true });
      writeFileSync(path.join(dir, 'res', 'server', 'kbengine.xml'), '<root>\n</root>\n');
      expect(resolveCustomConfigXmlPath('/definitely/not/this/workspace', dir)).toBe(
        path.join(dir, 'res', 'server', 'kbengine.xml')
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('KSEM-CFG-11 negative corpus: 缺文件', () => {
  it('empty custom tree (missing kbengine.xml equivalent) yields zero value findings', () => {
    expect(validate('<root>\n</root>\n')).toEqual([]);
  });

  it('missing defaults: relation checks and key impact stay silent, no fabricated claims', () => {
    const empty = checkEngineConfigRelations(parseCustom('<root>\n</root>\n'));
    expect(empty.claims).toEqual([]);
    expect(empty.findings).toEqual([]);
    expect(
      computeKeyImpact({
        path: 'dbmgr.telnet_service.port',
        face: 'engine-xml',
        customTree: null,
        defaultsTree: null
      })
    ).toBeNull();
  });

  it('missing serialization.json (schema=null): zero binding claims, zero uncovered noise', () => {
    const structure = deriveProjectConfigStructure(
      [{ file: 'a.py', text: "import json\ncfg = json.loads('res/guild/g1.json')" }],
      null
    );
    // 静默零声称:不报 uncovered(没有 schema 就没有基线,不是「全未覆盖」)
    expect(structure.uncoveredReads).toEqual([]);
    expect(structure.pathReads).toEqual([]);
    expect(checkProjectPathBaseline(structure)).toEqual([]);
  });
});

describe('KSEM-CFG-11 negative corpus: 多根', () => {
  it('parseConfigXml keeps every top-level element; normalizeRootNode picks <root>', () => {
    const tree = parseCustom('<root>\n  <a>1</a>\n</root>\n<stray>2</stray>');
    expect(tree.name).toBe('');
    expect(tree.children.map((c) => c.name)).toEqual(['root', 'stray']);
    const root = normalizeRootNode(tree);
    expect(root.children.map((c) => c.name)).toEqual(['a']);
  });

  it('stray top-level element never enters tree-walk diagnostics (no guesses)', () => {
    const out = validate([
      '<root>',
      '  <baseapp>',
      '    <gameUpdateHertz>30</gameUpdateHertz>',
      '  </baseapp>',
      '</root>',
      '<strayTool>weird</strayTool>'
    ].join('\n'));
    // 游离顶层元素不入树:诊断里绝无 strayTool(不猜)
    expect(out.filter((f) => f.path.includes('strayTool'))).toEqual([]);
  });
});

describe('KSEM-CFG-11 negative corpus: JSONC', () => {
  it('comments in serialization.json degrade to schema=null with an explicit error', () => {
    const commented = ['{', '  "schema_version": 1, // project bindings', '  "types": {}', '}'].join('\n');
    const out = parseSerializationSchema(commented);
    expect(out.schema).toBeNull();
    expect(out.errors).toEqual(['schema is not valid JSON']);
  });

  it('trailing commas degrade the same way (strict JSON, no partial guesses)', () => {
    const trailing = ['{', '  "schema_version": 1,', '  "types": {},', '}'].join('\n');
    const out = parseSerializationSchema(trailing);
    expect(out.schema).toBeNull();
    expect(out.errors).toEqual(['schema is not valid JSON']);
  });

  it('JSONC degrade keeps the structure face honest: static construction only, no fabricated types', () => {
    const structure = deriveProjectConfigStructure(
      [{ file: 'a.py', text: "import json\ncfg = json.loads('res/guild/g1.json')\nCFG = {'a': 1}" }],
      parseSerializationSchema('{/* hand edited */}').schema
    );
    expect(structure.entries.map((e) => e.tier)).toEqual(['static-construction']);
  });
});

describe('KSEM-CFG-11 negative corpus: 敏感值', () => {
  it('string-typed sensitive key is never type-checked: no diagnostic, no plaintext anywhere', () => {
    const customXml = [
      '<root>',
      '  <dbmgr>',
      '    <telnet_service>',
      '      <password>pwd123456</password>',
      '    </telnet_service>',
      '  </dbmgr>',
      '  </root>'
    ].join('\n');
    const out = validate(customXml);
    expect(out.filter((f) => f.path === 'dbmgr.telnet_service.password')).toEqual([]);
    // 渲染面只出脱敏形态(证据块 + 影响块)
    const info = configSourceInfo('dbmgr.telnet_service.password', parseCustom(customXml), defaultsTree(), null);
    const evidence = renderSourceEvidenceBlock(info, 'zh') ?? '';
    const impact = renderImpactBlock(
      computeKeyImpact({
        path: 'dbmgr.telnet_service.password',
        face: 'engine-xml',
        customTree: parseCustom(customXml),
        defaultsTree: defaultsTree()
      })!,
      'zh'
    );
    for (const rendered of [evidence, impact]) {
      expect(rendered).not.toContain('pwd123456');
    }
    expect(impact).toContain('p***');
  });
});

describe('KSEM-CFG-11 negative corpus: 版本差异', () => {
  it('schema_version 2 parses verbatim (no version fork, no fabricated claims)', () => {
    const out = parseSerializationSchema(
      JSON.stringify({
        schema_version: 2,
        types: { T: { fields: { level: 'UINT32' } } },
        bindings: { 'json.loads': [{ path: 'res/guild/*.json', type: 'T' }], 'json.load': [] }
      })
    );
    expect(out.schema).not.toBeNull();
    expect(out.schema!.version).toBe(2);
    expect(out.errors).toEqual([]);
    const structure = deriveProjectConfigStructure(
      [{ file: 'a.py', text: "import json\ncfg = json.loads('res/guild/g1.json')" }],
      out.schema
    );
    expect(structure.entries.find((e) => e.key === 'res/guild/*.json')?.typeId).toBe('T');
  });

  it('non-integer schema_version: version=null + explicit error, remaining faces still parse', () => {
    const out = parseSerializationSchema(
      JSON.stringify({
        schema_version: 'x',
        types: { T: { fields: { level: 'UINT32' } } },
        bindings: { 'json.loads': [{ path: 'res/guild/*.json', type: 'T' }], 'json.load': [] }
      })
    );
    expect(out.schema!.version).toBeNull();
    expect(out.errors).toEqual(['schema_version must be an integer']);
    expect(out.schema!.loadsBindings).toEqual([{ path: 'res/guild/*.json', type: 'T' }]);
  });

  it('older defaults snapshot: keys missing there are information-only, never errors', () => {
    // 旧版引擎 defaults 无 dbmgr 段 → custom 的 dbmgr 键落 dynamic-extension
    const oldDefaults = parseCustom(
      ['<root>', '  <baseapp>', '    <gameUpdateHertz>10</gameUpdateHertz>', '  </baseapp>', '</root>'].join('\n')
    );
    const customXml = [
      '<root>',
      '  <dbmgr>',
      '    <allowEmptyDigest>true</allowEmptyDigest>',
      '  </dbmgr>',
      '</root>'
    ].join('\n');
    const customTree = parseCustom(customXml);
    // 动态段=首个 defaults 缺失段(dbmgr):段本身是 dynamic-extension,
    // 其下叶子是 dynamic-segment-child(归并到段边界,不重复登记)
    expect(classifyConfigField(oldDefaults, customTree, 'dbmgr').kind).toBe('dynamic-extension');
    expect(classifyConfigField(oldDefaults, customTree, 'dbmgr.allowEmptyDigest').kind).toBe(
      'dynamic-segment-child'
    );
    const extraction = extractConfigContracts(
      ['<root>', '  <baseapp>', '    <gameUpdateHertz>10</gameUpdateHertz>', '  </baseapp>', '</root>'].join('\n'),
      oldDefaults
    );
    const scan = scanConfigFieldIdentities(oldDefaults, customTree);
    const out = computeConfigValueFindings({
      customText: customXml,
      customTree,
      extraction,
      scan
    });
    // 版本差异面:旧 defaults 不认识的键 = 容忍忽略(information),不是 error
    const unknown = findingsOf(out, 'kbengine.configValue.unknownKey');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].path).toBe('dbmgr');
    expect(unknown[0].severity).toBe('information');
    expect(out.filter((f) => f.severity === 'error')).toEqual([]);
  });
});
