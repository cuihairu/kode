/**
 * KSEM-CFG-09 配置关联约束检查(纯核心)。
 *
 * 面分组:端口 claim 分类(local-bind/outbound-target;远端目标不参与
 * 本机冲突)/ 端口冲突(同协议族+同绑定面才判重叠,协议不同不冲突、
 * 绑定面不同不冲突,跨进程 machineDependent 不裁定,telnet 自愈注记)/
 * 哨兵逐段语义(loginapp udp -1 / machine udp 0 / externalTcp 0=默认)/
 * 字段组合(bots 夹断自愈有文档、external 空区间只报算术事实)/
 * 引用目标(dbmgr 至少一个 default=error、enable=false 条目失效)/
 * 路径基准(项目注册表:未覆盖读取 + 未用绑定双向)。真实引擎 defaults
 * 夹具解析(基线零冲突),变异树构造冲突。零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfigXml } from '../src/serverConfigFallbackCore';
import {
  checkEngineConfigRelations,
  checkProjectPathBaseline
} from '../src/backend/configRelationChecks';
import type { ConfigXmlNode } from '../src/serverConfigMerge';
import { normalizeRootNode } from '../src/backend/configFieldIdentity';
import { parseSerializationSchema } from '../src/backend/jsonChainPropagation';
import { deriveProjectConfigStructure } from '../src/backend/configProjectStructure';

const FIXTURE = path.join(__dirname, 'fixtures/config/kbengine_defaults.xml');

const defaultsTree = (): ConfigXmlNode => {
  const tree = parseConfigXml(readFileSync(FIXTURE, 'utf8'));
  if (tree === null) {
    throw new Error('defaults fixture failed to parse');
  }
  return normalizeRootNode(tree);
};

function cloneTree(node: ConfigXmlNode): ConfigXmlNode {
  return { name: node.name, text: node.text, children: node.children.map(cloneTree) };
}

function findByPath(node: ConfigXmlNode, names: string[]): ConfigXmlNode | null {
  let cur: ConfigXmlNode | null = node;
  for (const name of names) {
    if (cur === null) {
      return null;
    }
    cur = cur.children.find((c) => c.name === name) ?? null;
  }
  return cur;
}

function setLeaf(node: ConfigXmlNode, names: string[], text: string): void {
  const target = findByPath(node, names);
  if (target === null) {
    throw new Error(`path not found: ${names.join('.')}`);
  }
  target.text = text;
}

const report = (tree: ConfigXmlNode) => checkEngineConfigRelations(tree);

describe('KSEM-CFG-09 engine config relations: claims', () => {
  it('real defaults parse to a clean baseline: zero port-overlap findings', () => {
    const out = report(defaultsTree());
    expect(out.findings.filter((f) => f.kind === 'port-overlap')).toEqual([]);
  });

  it('claims inventory: local binds and outbound targets are separated', () => {
    const out = report(defaultsTree());
    const byScope = (scope: string) => out.claims.filter((c) => c.scope === scope);
    expect(byScope('external-tcp').filter((c) => c.role === 'local-bind').map((c) => c.section))
      .toEqual(['baseapp', 'loginapp', 'machine']);
    // bots 登录 loginapp 的端口段是远端目标,不是本机绑定
    const bots = out.claims.find((c) => c.path === 'bots.port_min/max')!;
    expect(bots.role).toBe('outbound-target');
    const dbPort = out.claims.find((c) => c.path === 'dbmgr.databaseInterfaces.default.port')!;
    expect(dbPort.role).toBe('outbound-target');
    expect(dbPort.defaulted).toBe(true); // 0 = MySQL 默认 3306,数值未文档化
  });

  it('telnet claims carry documented per-section defaults and self-heal', () => {
    const out = report(defaultsTree());
    const telnets = out.claims.filter((c) => c.scope === 'telnet');
    expect(telnets.map((c) => c.section).sort()).toEqual(
      ['baseapp', 'bots', 'cellapp', 'dbmgr', 'interfaces', 'logger', 'loginapp']
    );
    for (const t of telnets) {
      expect(t.selfHeal).toBe(true);
    }
    const dbmgr = telnets.find((t) => t.section === 'dbmgr')!;
    expect(dbmgr.min).toBe(32000);
    expect(dbmgr.max).toBe(32000);
    expect(dbmgr.source).toContain('32001');
  });

  it('missing telnet port element falls back to the documented default', () => {
    const tree = defaultsTree();
    const dbmgr = findByPath(tree, ['dbmgr', 'telnet_service'])!;
    dbmgr.children = dbmgr.children.filter((c) => c.name !== 'port');
    const out = report(tree);
    const dbmgrClaim = out.claims.find(
      (c) => c.path === 'dbmgr.telnet_service.port'
    )!;
    expect(dbmgrClaim.defaulted).toBe(true);
    expect(dbmgrClaim.min).toBe(32000);
  });

  it('sentinels are per-section: loginapp udp -1 and machine udp 0 are disabled', () => {
    const out = report(defaultsTree());
    const loginappUdp = out.claims.find(
      (c) => c.path === 'loginapp.externalUdpPorts_min/max'
    )!;
    expect(loginappUdp.disabled).toBe(true);
    expect(loginappUdp.min).toBeNull();
    const machineUdp = out.claims.find(
      (c) => c.path === 'machine.externalUdpPorts_min/max'
    )!;
    expect(machineUdp.disabled).toBe(true);
    // externalTcp 0 = 使用默认:loginapp max=0 → 区间不可解
    const loginappTcp = out.claims.find(
      (c) => c.path === 'loginapp.externalTcpPorts_min/max'
    )!;
    expect(loginappTcp.defaulted).toBe(true);
    expect(loginappTcp.min).toBe(20013);
    expect(loginappTcp.max).toBeNull();
  });
});

describe('KSEM-CFG-09 engine config relations: conflicts and combos', () => {
  it('same scope overlapping ranges across sections report machine-dependent overlap', () => {
    const tree = defaultsTree();
    setLeaf(tree, ['baseapp', 'externalTcpPorts_min'], '20013');
    setLeaf(tree, ['baseapp', 'externalTcpPorts_max'], '20017');
    setLeaf(tree, ['loginapp', 'externalTcpPorts_max'], '20017');
    const out = report(tree);
    const hits = out.findings.filter((f) => f.kind === 'port-overlap');
    expect(hits).toHaveLength(1);
    const f = hits[0];
    expect(f.severity).toBe('info');
    expect(f.machineDependent).toBe(true);
    expect(f.selfHeal).toBe(false);
    expect(f.paths).toEqual([
      'baseapp.externalTcpPorts_min/max',
      'loginapp.externalTcpPorts_min/max'
    ]);
    expect(f.detail).toContain('部署在同一物理机');
  });

  it('telnet overlap downgrades to self-heal note (engine retries next port)', () => {
    const tree = defaultsTree();
    setLeaf(tree, ['baseapp', 'telnet_service', 'port'], '31000');
    const out = report(tree);
    const hits = out.findings.filter((f) => f.kind === 'port-overlap');
    expect(hits).toHaveLength(1);
    expect(hits[0].selfHeal).toBe(true);
    expect(hits[0].paths).toEqual([
      'baseapp.telnet_service.port',
      'loginapp.telnet_service.port'
    ]);
    expect(hits[0].detail).toContain('自愈');
  });

  it('same numbers in tcp and udp never conflict (protocol separation)', () => {
    const tree = defaultsTree();
    // 跨进程 + 跨协议:loginapp udp 区间与 baseapp tcp 区间同号
    setLeaf(tree, ['loginapp', 'externalUdpPorts_min'], '20015');
    setLeaf(tree, ['loginapp', 'externalUdpPorts_max'], '20019');
    const out = report(tree);
    expect(out.findings.filter((f) => f.kind === 'port-overlap')).toEqual([]);
  });

  it('different bind faces never conflict (address-scope separation)', () => {
    const tree = defaultsTree();
    // 跨进程 + 跨绑定面:loginapp http 回调端口与 dbmgr telnet 同号
    setLeaf(tree, ['loginapp', 'http_cbport'], '32000');
    const out = report(tree);
    expect(out.findings.filter((f) => f.kind === 'port-overlap')).toEqual([]);
  });

  it('bots clamp (max < min) is documented self-heal', () => {
    const tree = defaultsTree();
    setLeaf(tree, ['bots', 'port_min'], '20020');
    setLeaf(tree, ['bots', 'port_max'], '20013');
    const out = report(tree);
    const hits = out.findings.filter((f) => f.kind === 'range-clamp');
    expect(hits).toHaveLength(1);
    expect(hits[0].selfHeal).toBe(true);
    expect(hits[0].severity).toBe('info');
    expect(hits[0].evidence).toContain('bots.port_max');
  });

  it('external empty range reports the arithmetic fact only, no engine claim', () => {
    const tree = defaultsTree();
    setLeaf(tree, ['baseapp', 'externalTcpPorts_min'], '20020');
    setLeaf(tree, ['baseapp', 'externalTcpPorts_max'], '20015');
    const out = report(tree);
    const hits = out.findings.filter((f) => f.kind === 'range-empty-candidate');
    expect(hits).toHaveLength(1);
    expect(hits[0].selfHeal).toBe(false);
    expect(hits[0].severity).toBe('info');
    expect(hits[0].evidence).toContain('无引擎夹断证据');
  });

  it('sentinel with live counter-value reports the inert combination', () => {
    const tree = defaultsTree();
    setLeaf(tree, ['loginapp', 'externalUdpPorts_min'], '20005');
    const out = report(tree);
    const hits = out.findings.filter((f) => f.kind === 'disabled-sentinel');
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain('不生效');
    // 纯哨兵(默认 -1/-1)无 finding
    expect(report(defaultsTree()).findings.filter((f) => f.kind === 'disabled-sentinel'))
      .toEqual([]);
  });
});

describe('KSEM-CFG-09 engine config relations: reference targets', () => {
  it('databaseInterfaces without default is an error (documented requirement)', () => {
    const tree = defaultsTree();
    const dbi = findByPath(tree, ['dbmgr', 'databaseInterfaces'])!;
    dbi.children = dbi.children.filter((c) => c.name !== 'default');
    const out = report(tree);
    const hits = out.findings.filter((f) => f.kind === 'missing-default-dbinterface');
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('error');
    expect(hits[0].evidence).toContain('至少存在一个 default');
  });

  it('absent databaseInterfaces section makes no claim', () => {
    const tree = defaultsTree();
    const dbmgr = findByPath(tree, ['dbmgr'])!;
    dbmgr.children = dbmgr.children.filter((c) => c.name !== 'databaseInterfaces');
    expect(report(tree).findings.filter((f) => f.kind === 'missing-default-dbinterface'))
      .toEqual([]);
  });

  it('enable=false with configured items reports the inert forwarding combo', () => {
    const tree = defaultsTree();
    setLeaf(tree, ['dbmgr', 'InterfacesServiceAddr', 'enable'], 'false');
    // 真实 defaults 里 item 是注释掉的(不入树):手动挂一条已配置条目
    const isa = findByPath(tree, ['dbmgr', 'InterfacesServiceAddr'])!;
    isa.children.push({
      name: 'item',
      text: '',
      children: [
        { name: 'host', text: 'localhost1', children: [] },
        { name: 'port', text: '30098', children: [] }
      ]
    });
    const out = report(tree);
    const hits = out.findings.filter((f) => f.kind === 'inert-interfaces-forwarding');
    expect(hits).toHaveLength(1);
    expect(hits[0].paths).toEqual(['dbmgr.InterfacesServiceAddr']);
  });
});

describe('KSEM-CFG-09 project path baseline (CFG-08 registry consumption)', () => {
  const schemaWithGuild = () =>
    parseSerializationSchema(
      JSON.stringify({
        schema_version: 1,
        types: { 'T': { fields: { level: 'UINT32' } } },
        bindings: {
          'json.loads': [{ path: 'res/guild/*.json', type: 'T' }],
          'json.load': []
        }
      })
    ).schema;

  it('uncovered code reads are surfaced with sources', () => {
    const structure = deriveProjectConfigStructure(
      [
        { file: 'a.py', text: "import json\ncfg = json.loads('res/guild/g1.json')\nother = json.loads('res/other/x.json')" }
      ],
      schemaWithGuild()
    );
    const out = checkProjectPathBaseline(structure);
    // guild glob 有读取证据(不报未用);只有未覆盖读取一条
    expect(out).toHaveLength(1);
    const uncovered = out[0];
    expect(uncovered.kind).toBe('uncovered-read');
    expect(uncovered.path).toBe('res/other/x.json');
    expect(uncovered.loader).toBe('json.loads');
    expect(uncovered.sources).toEqual([{ file: 'a.py', line: 2 }]);
  });

  it('declared bindings without code readers are reported as unused', () => {
    const structure = deriveProjectConfigStructure([], schemaWithGuild());
    const out = checkProjectPathBaseline(structure);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('unused-binding');
    expect(out[0].path).toBe('res/guild/*.json');
    expect(out[0].loader).toBeNull();
    expect(out[0].sources).toEqual([{ file: '.kbengine/serialization.json', line: null }]);
  });

  it('fully covered reads produce no baseline findings', () => {
    const structure = deriveProjectConfigStructure(
      [{ file: 'a.py', text: "import json\ncfg = json.loads('res/guild/g1.json')" }],
      schemaWithGuild()
    );
    expect(checkProjectPathBaseline(structure)).toEqual([]);
  });
});
