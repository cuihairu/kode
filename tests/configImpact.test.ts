/**
 * KSEM-CFG-10 联动配置修改影响(纯核心)。
 *
 * 面分组:engine-xml 键影响(受影响模块=路径首段进程段/默认回退=defaults
 * 叶值·无引擎默认·容器段三态/读取点=引擎内消费零用户代码声称)/
 * project-json 键影响(读取点=注册表绑定 glob 命中 readers/未覆盖=零声称
 * 诚实结论/注册表缺=readersKnown false)/ 类型影响(绑定合并去重/
 * readers 跨 glob 合并/files 排序/schema=null 零声称)/ 渲染块双语言
 * (敏感回退值只出脱敏形态)。零写入面由构造保证(本模块无 fs/无命令)。
 * 真实引擎 defaults 夹具 + 合成 schema/注册表,零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfigXml } from '../src/serverConfigFallbackCore';
import type { ConfigXmlNode } from '../src/serverConfigMerge';
import {
  computeKeyImpact,
  computeTypeImpact,
  renderImpactBlock
} from '../src/backend/configImpact';
import { parseSerializationSchema } from '../src/backend/jsonChainPropagation';
import { deriveProjectConfigStructure } from '../src/backend/configProjectStructure';

const FIXTURE = path.join(__dirname, 'fixtures/config/kbengine_defaults.xml');

const defaultsTree = (): ConfigXmlNode => {
  const tree = parseConfigXml(readFileSync(FIXTURE, 'utf8'));
  if (tree === null) {
    throw new Error('defaults fixture failed to parse');
  }
  return tree;
};

const customTree = (): ConfigXmlNode => {
  const tree = parseConfigXml(
    [
      '<root>',
      '  <baseapp>',
      '    <customThing>7</customThing>',
      '  </baseapp>',
      '</root>'
    ].join('\n')
  );
  if (tree === null) {
    throw new Error('custom tree failed to parse');
  }
  return tree;
};

describe('KSEM-CFG-10 key impact: engine-xml face', () => {
  it('documented default key: fallback value, section, engine-internal readers', () => {
    const impact = computeKeyImpact({
      path: 'dbmgr.telnet_service.port',
      face: 'engine-xml',
      customTree: null,
      defaultsTree: defaultsTree()
    })!;
    expect(impact).not.toBeNull();
    expect(impact.section).toBe('dbmgr');
    expect(impact.fallback).toEqual({ value: '32000', sensitive: false });
    expect(impact.fallbackKnown).toBe(true);
    expect(impact.readers).toEqual([]);
    expect(impact.readersKnown).toBe(true);
    expect(impact.engineInternal).toBe(true);
    expect(impact.affectedFiles).toEqual([]);
  });

  it('component-config-only key: no engine default, removal disables the setting', () => {
    const impact = computeKeyImpact({
      path: 'baseapp.customThing',
      face: 'engine-xml',
      customTree: customTree(),
      defaultsTree: defaultsTree()
    })!;
    expect(impact.fallback).toBeNull();
    expect(impact.fallbackKnown).toBe(true);
    expect(renderImpactBlock(impact, 'zh')).toContain('无引擎默认');
  });

  it('container node falls back to the engine default structure', () => {
    const impact = computeKeyImpact({
      path: 'dbmgr.databaseInterfaces',
      face: 'engine-xml',
      customTree: null,
      defaultsTree: defaultsTree()
    })!;
    expect(impact.fallback).not.toBeNull();
    expect(impact.fallback!.value).toBeNull(); // 容器段:回落结构,不虚称叶值
    expect(renderImpactBlock(impact, 'zh')).toContain('回落引擎默认结构');
  });

  it('path missing from both trees returns null (no fabricated face)', () => {
    expect(
      computeKeyImpact({
        path: 'dbmgr.nosuch',
        face: 'engine-xml',
        customTree: customTree(),
        defaultsTree: defaultsTree()
      })
    ).toBeNull();
  });

  it('defaults tree unavailable: fallback unknown, zero claim', () => {
    const impact = computeKeyImpact({
      path: 'baseapp.customThing',
      face: 'engine-xml',
      customTree: customTree(),
      defaultsTree: null
    })!;
    expect(impact.fallbackKnown).toBe(false);
    expect(impact.fallback).toBeNull();
    expect(renderImpactBlock(impact, 'zh')).toContain('默认回退:未知');
  });

  it('sensitive fallback value renders masked only', () => {
    const impact = computeKeyImpact({
      path: 'dbmgr.telnet_service.password',
      face: 'engine-xml',
      customTree: null,
      defaultsTree: defaultsTree()
    })!;
    expect(impact.fallback!.sensitive).toBe(true);
    const zh = renderImpactBlock(impact, 'zh');
    expect(zh).not.toContain('pwd123456');
    expect(zh).toContain('p***');
    const en = renderImpactBlock(impact, 'en');
    expect(en).not.toContain('pwd123456');
    expect(en).toContain('p***');
    expect(en).toContain('Affected module: `dbmgr` process section');
  });
});

describe('KSEM-CFG-10 key impact: project-json face', () => {
  const schemaWithGuild = () =>
    parseSerializationSchema(
      JSON.stringify({
        schema_version: 1,
        types: { T: { fields: { level: 'UINT32' } } },
        bindings: {
          'json.loads': [{ path: 'res/guild/*.json', type: 'T' }],
          'json.load': [{ path: 'res/guild/*.json', type: 'T' }]
        }
      })
    ).schema;

  it('readers from matching binding globs are listed with affected files', () => {
    const structure = deriveProjectConfigStructure(
      [
        {
          file: 'a.py',
          text: "import json\ncfg = json.loads('res/guild/g1.json')"
        },
        {
          file: 'b.py',
          text: "import json\ncfg2 = json.loads('res/guild/g2.json')"
        }
      ],
      schemaWithGuild()
    );
    const impact = computeKeyImpact({
      path: 'res/guild/g1.json',
      face: 'project-json',
      customTree: null,
      defaultsTree: null,
      structure
    })!;
    expect(impact.section).toBeNull();
    expect(impact.readers).toEqual([{ file: 'a.py', line: 1 }]);
    expect(impact.readersKnown).toBe(true);
    expect(impact.affectedFiles).toEqual(['a.py']);
    const zh = renderImpactBlock(impact, 'zh');
    expect(zh).toContain('读取点:a.py:2');
    expect(zh).toContain('受影响文件:a.py');
  });

  it('uncovered path reports zero readers as an honest conclusion', () => {
    const structure = deriveProjectConfigStructure(
      [{ file: 'a.py', text: "import json\ncfg = json.loads('res/other/x.json')" }],
      schemaWithGuild()
    );
    const impact = computeKeyImpact({
      path: 'res/other/x.json',
      face: 'project-json',
      customTree: null,
      defaultsTree: null,
      structure
    })!;
    expect(impact.readers).toEqual([]);
    expect(impact.readersKnown).toBe(true);
    expect(impact.affectedFiles).toEqual([]);
    expect(renderImpactBlock(impact, 'zh')).toContain('零声称');
  });

  it('structure unavailable: readersKnown false, zero claim', () => {
    const impact = computeKeyImpact({
      path: 'res/guild/g1.json',
      face: 'project-json',
      customTree: null,
      defaultsTree: null,
      structure: null
    })!;
    expect(impact.readersKnown).toBe(false);
    expect(renderImpactBlock(impact, 'zh')).toContain('读取点:未知');
  });
});

describe('KSEM-CFG-10 type impact', () => {
  const schemaTwoTypes = () =>
    parseSerializationSchema(
      JSON.stringify({
        schema_version: 1,
        types: {
          T: { fields: { level: 'UINT32' } },
          U: { fields: { name: 'STRING' } }
        },
        bindings: {
          'json.loads': [
            { path: 'res/guild/*.json', type: 'T' },
            { path: 'res/item/*.json', type: 'T' }
          ],
          'json.load': [{ path: 'res/static/*.json', type: 'U' }]
        }
      })
    ).schema;

  const structureWithReaders = () =>
    deriveProjectConfigStructure(
      [
        { file: 'a.py', text: "import json\nc1 = json.loads('res/guild/g1.json')" },
        { file: 'b.py', text: "import json\nc2 = json.loads('res/item/i1.json')" },
        { file: 'c.py', text: "import json\nc3 = json.load(open('res/static/s1.json'))" }
      ],
      schemaTwoTypes()
    );

  it('type impact merges bindings and readers across globs and loaders', () => {
    const impact = computeTypeImpact('T', schemaTwoTypes(), structureWithReaders())!;
    expect(impact.bindings).toEqual([
      { glob: 'res/guild/*.json', loader: 'json.loads' },
      { glob: 'res/item/*.json', loader: 'json.loads' }
    ]);
    expect(impact.readers).toEqual([
      { file: 'a.py', line: 1 },
      { file: 'b.py', line: 1 }
    ]);
    expect(impact.files).toEqual(['a.py', 'b.py']);
    expect(impact.fallbackNote).toContain('失去类型信息');
  });

  it('changing an unbound type reports zero bindings as an honest conclusion', () => {
    const impact = computeTypeImpact('U-nobody', schemaTwoTypes(), structureWithReaders())!;
    expect(impact.bindings).toEqual([]);
    expect(impact.readers).toEqual([]);
    expect(impact.files).toEqual([]);
  });

  it('schema null returns null (zero claim, no fabricated bindings)', () => {
    expect(computeTypeImpact('T', null, structureWithReaders())).toBeNull();
  });

  it('structure null keeps bindings but reports no readers', () => {
    const impact = computeTypeImpact('T', schemaTwoTypes(), null)!;
    expect(impact.bindings).toHaveLength(2);
    expect(impact.readers).toEqual([]);
    expect(impact.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 批 16 容错臂:渲染块 en 侧三分支(读取点未知/零声称/有读取点+受影响文件)、
// engine-xml en 侧三态回退文案(未知/无引擎默认/回落默认结构)。
// 既有臂只覆盖 zh 侧与 sensitive en 臂,en 普通分支从未执行。
// ---------------------------------------------------------------------------
describe('批 16:renderImpactBlock en 侧分支', () => {
  const schemaWithGuild = () =>
    parseSerializationSchema(
      JSON.stringify({
        schema_version: 1,
        types: { T: { fields: { level: 'UINT32' } } },
        bindings: { 'json.loads': [{ path: 'res/guild/*.json', type: 'T' }], 'json.load': [] }
      })
    ).schema;

  it('project-json en:读取点未知(注册表不可得)', () => {
    const impact = computeKeyImpact({
      path: 'res/guild/g1.json', face: 'project-json',
      customTree: null, defaultsTree: null, structure: null
    })!;
    const en = renderImpactBlock(impact, 'en');
    expect(en).toContain('**Modification impact** (if this key is changed)');
    expect(en).toContain('Read points: unknown (project config registry not available)');
  });

  it('project-json en:零声称(无绑定 glob 命中)', () => {
    const structure = deriveProjectConfigStructure(
      [{ file: 'a.py', text: "import json\ncfg = json.loads('res/other/x.json')" }],
      schemaWithGuild()
    );
    const impact = computeKeyImpact({
      path: 'res/other/x.json', face: 'project-json',
      customTree: null, defaultsTree: null, structure
    })!;
    const en = renderImpactBlock(impact, 'en');
    expect(en).toContain('Read points: none claimed');
    expect(en).not.toContain('Affected files');
  });

  it('project-json en:有读取点(1 基行号)与受影响文件', () => {
    const structure = deriveProjectConfigStructure(
      [{ file: 'a.py', text: "import json\ncfg = json.loads('res/guild/g1.json')" }],
      schemaWithGuild()
    );
    const impact = computeKeyImpact({
      path: 'res/guild/g1.json', face: 'project-json',
      customTree: null, defaultsTree: null, structure
    })!;
    const en = renderImpactBlock(impact, 'en');
    expect(en).toContain('Read points: a.py:2');
    expect(en).toContain('Affected files: a.py');
  });

  it('engine-xml en:三态回退文案(未知/无引擎默认/回落默认结构)', () => {
    // 未知:defaults 树不可得
    const unknown = computeKeyImpact({
      path: 'baseapp.customThing', face: 'engine-xml',
      customTree: customTree(), defaultsTree: null
    })!;
    expect(renderImpactBlock(unknown, 'en')).toContain(
      'Default fallback: unknown (engine defaults tree unavailable)'
    );
    // 无引擎默认:组件配置键
    const none = computeKeyImpact({
      path: 'baseapp.customThing', face: 'engine-xml',
      customTree: customTree(), defaultsTree: defaultsTree()
    })!;
    expect(renderImpactBlock(none, 'en')).toContain('Default fallback: none');
    // 回落默认结构:容器节点
    const container = computeKeyImpact({
      path: 'dbmgr.telnet_service', face: 'engine-xml',
      customTree: null, defaultsTree: defaultsTree()
    })!;
    expect(renderImpactBlock(container, 'en')).toContain(
      'falls back to the engine default structure'
    );
  });
});

describe('批 16 续:类型影响去重与窄注册表', () => {
  it('同表重复绑定去重;窄注册表查不到条目照跳(零 readers 不冒称)', () => {
    const dupSchema = parseSerializationSchema(
      JSON.stringify({
        schema_version: 1,
        types: { T: { fields: { level: 'UINT32' } } },
        bindings: {
          'json.loads': [
            { path: 'res/guild/*.json', type: 'T' },
            { path: 'res/guild/*.json', type: 'T' }
          ],
          'json.load': []
        }
      })
    ).schema;
    // 结构按窄 schema 派生:res/guild glob 无 path-binding 条目
    const narrowStructure = deriveProjectConfigStructure(
      [{ file: 'a.py', text: "import json\nc1 = json.loads('res/guild/g1.json')" }],
      parseSerializationSchema(
        JSON.stringify({
          schema_version: 1,
          types: { T: { fields: { level: 'UINT32' } } },
          bindings: { 'json.loads': [], 'json.load': [] }
        })
      ).schema
    );
    const impact = computeTypeImpact('T', dupSchema, narrowStructure)!;
    // 同 loader 同 path 重复声明只留一条
    expect(impact.bindings).toEqual([{ glob: 'res/guild/*.json', loader: 'json.loads' }]);
    // 窄注册表里查不到该 glob 的条目:readers 零,不冒称
    expect(impact.readers).toEqual([]);
  });
});

// 覆盖口径残余(不硬凑):src/backend/configImpact.ts:192 的 `seen.has(key)` 去重
// continue 不可达——parseSerializationSchema(:178-181)已按 `path\u0000type` 在
// 解析期去重全同条目,进表后同 loader 不可能出现同 path 两条,故 computeTypeImpact
// 的第二道去重是防御性死码(保留为上游行为变更时的兜底)。
