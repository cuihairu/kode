/**
 * KSEM-CFG-09 配置关联约束检查(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-039,旧 KSEM-CFG-09):检查配置关联约束。
 * 逐条核实路径基准、字段组合、引用目标等可静态检查关系;端口冲突按
 * 绑定地址/协议/部署角色判断,不简单全局去重。
 *
 * 两入口:
 *  - checkEngineConfigRelations(tree):引擎最终配置树(serverConfigMerge
 *    解析产物)上的端口/组合/引用目标关系;
 *  - checkProjectPathBaseline(structure):项目配置注册表(CFG-08 产物)
 *    上的路径基准缺口(代码读取路径无绑定覆盖 / 声明绑定无代码读取)。
 *
 * 端口冲突判定模型(验收同款,绝不简单全局去重):
 *  - 端口字段逐条分类:role = local-bind(引擎监听)/ outbound-target
 *    (远端目标:bots 登录 loginapp 的端口段、dbmgr 数据库端口、
 *    InterfacesServiceAddr 条目端口——远端目标不参与本机冲突,这是
 *    「不简单全局去重」的第一刀);
 *  - local-bind 按 (协议族 tcp/udp, 绑定面 external/telnet/http-cb/
 *    interfaces-listen) 分组,仅同组内做区间重叠(单端口=闭区间);
 *    协议不同不冲突(tcp/udp 各自空间),绑定面不同不冲突(external
 *    绑 externalInterface/externalAddress、http-cb 绑 http_cbhost、
 *    telnet/interfaces-listen 另有绑定面——静态判不出地址相等,跨面
 *    比较会造假阳性,这是第二刀);跨进程同面重叠 = machineDependent
 *    (真冲突与否取决于部署机器,不裁定,来源双方路径都给);
 *  - 哨兵/默认值语义逐段核实(loginapp udp -1=不启用、machine udp
 *    0=不启用、externalTcp 0=使用默认、telnet 各段引擎默认端口有目录
 *    文档)——哨兵禁用的 claim 不参与重叠;默认端口未文档化的
 *    (externalTcp 0)区间不可解,诚实排除不算重叠。
 *
 * 逐条核实纪律(每条检查都要引擎/目录证据,无证据不检查):
 *  - 有证据:bots port_max 夹断(目录注释「小于下限时取下限」→ 自愈)、
 *    telnet 端口占用向后重试(目录段注释 → 自愈)、dbmgr 数据库接口
 *    至少一个 default(目录注释)、InterfacesServiceAddr enable=false
 *    不转发(目录注释)、loginapp/machine udp 哨兵(目录注释);
 *  - 无证据:external 段 min>max 无夹断文档 → 只报算术事实
 *    (range-empty-candidate,info + 不裁定声明),不声称引擎行为;
 *    machine.addresses 无格式/关系证据 → 不实现检查(诚实缺席)。
 */

import type { ConfigXmlNode } from '../serverConfigMerge';
import { normalizeRootNode } from './configFieldIdentity';
import type {
  ConfigStructureSource,
  ProjectConfigStructure
} from './configProjectStructure';

/** 端口绑定面(协议族 × 绑定口;同组内才算重叠)。 */
export type ConfigPortScope =
  | 'external-tcp'
  | 'external-udp'
  | 'telnet'
  | 'http-cb'
  | 'interfaces-listen';

/** telnet 各进程段引擎默认端口(目录逐段文档:baseapp 40000/loginapp
 * 31000/cellapp 50000/dbmgr 32000/interfaces 33000/logger 34000/bots
 * 51000;段注释同证「端口被占用则向后尝试」)。 */
const TELNET_DEFAULTS: Readonly<Record<string, number>> = {
  baseapp: 40000,
  loginapp: 31000,
  cellapp: 50000,
  dbmgr: 32000,
  interfaces: 33000,
  logger: 34000,
  bots: 51000
};

/** external 端口段所在的进程段(引擎默认配置三段;目录键同口径)。 */
const EXTERNAL_RANGE_SECTIONS = ['baseapp', 'loginapp', 'machine'] as const;

/** externalUdp 哨兵禁用值(逐段不同:loginapp -1=不启用、machine
 * 0=不启用——目录注释逐段取证,不全局套同一哨兵)。 */
const UDP_DISABLED_SENTINEL: Readonly<Record<string, number>> = {
  loginapp: -1,
  machine: 0
};

export interface ConfigPortClaim {
  /** 点分路径(去 <root> 包裹;重复条目按序补 .item#N 序号) */
  path: string;
  /** 进程段名(顶层段=进程,serverConfigCatalog 分组主轴) */
  section: string;
  scope: ConfigPortScope;
  /** local-bind = 引擎本机监听(参与冲突);outbound-target = 远端目标
   * (不参与本机冲突,进引用目标面) */
  role: 'local-bind' | 'outbound-target';
  /** 区间端点(null=不可解析/未文档化默认——重叠算术诚实排除) */
  min: number | null;
  max: number | null;
  /** 哨兵禁用(loginapp udp -1 / machine udp 0) */
  disabled: boolean;
  /** 引擎默认值未文档化(externalTcp 0=使用默认,数值未知) */
  defaulted: boolean;
  /** 引擎自愈面(telnet 占用重试 / bots 夹断) */
  selfHeal: boolean;
  /** 取证锚(目录键/引擎默认 XML 段注释) */
  source: string;
}

export interface ConfigRelationFinding {
  kind:
    | 'port-overlap'
    | 'range-clamp'
    | 'range-empty-candidate'
    | 'disabled-sentinel'
    | 'missing-default-dbinterface'
    | 'inert-interfaces-forwarding';
  severity: 'error' | 'warning' | 'info';
  /** 涉及配置路径(点分,取证面) */
  paths: readonly string[];
  /** 判据(zh,含数值事实) */
  detail: string;
  /** 取证锚(目录键/段注释) */
  evidence: string;
  /** 跨进程重叠:真冲突与否取决于部署机器(不裁定) */
  machineDependent: boolean;
  /** 引擎自愈(telnet 重试/bots 夹断)→ 非致命 */
  selfHeal: boolean;
}

export interface ConfigRelationReport {
  claims: ConfigPortClaim[];
  findings: ConfigRelationFinding[];
}

function findChild(node: ConfigXmlNode, name: string): ConfigXmlNode | null {
  for (const child of node.children) {
    if (child.name === name) {
      return child;
    }
  }
  return null;
}

function parseIntText(node: ConfigXmlNode | null): number | null {
  if (node === null) {
    return null;
  }
  const t = node.text.trim();
  if (!/^-?\d+$/.test(t)) {
    return null;
  }
  return Number.parseInt(t, 10);
}

/** external min/max 对:0 = 使用引擎默认(数值未文档化)→ defaulted;
 * 其余可解析整数照收。 */
function externalEndpoint(
  section: ConfigXmlNode,
  name: string
): { value: number | null; defaulted: boolean } {
  const v = parseIntText(findChild(section, name));
  if (v === 0) {
    return { value: null, defaulted: true };
  }
  return { value: v, defaulted: false };
}

/** external 区间段 claim(externalTcp/externalUdp × 三进程段)。 */
function externalRangeClaims(tree: ConfigXmlNode): ConfigPortClaim[] {
  const claims: ConfigPortClaim[] = [];
  for (const sectionName of EXTERNAL_RANGE_SECTIONS) {
    const section = findChild(tree, sectionName);
    if (section === null) {
      continue;
    }
    const tcpMin = externalEndpoint(section, 'externalTcpPorts_min');
    const tcpMax = externalEndpoint(section, 'externalTcpPorts_max');
    if (tcpMin.value !== null || tcpMax.value !== null || tcpMin.defaulted || tcpMax.defaulted) {
      claims.push({
        path: `${sectionName}.externalTcpPorts_min/max`,
        section: sectionName,
        scope: 'external-tcp',
        role: 'local-bind',
        min: tcpMin.value,
        max: tcpMax.value,
        disabled: false,
        defaulted: tcpMin.defaulted || tcpMax.defaulted,
        selfHeal: false,
        source: `serverConfigCatalog: ${sectionName}.externalTcpPorts_min/max(0 = 使用默认)`
      });
    }
    const udpMin = parseIntText(findChild(section, 'externalUdpPorts_min'));
    const udpMax = parseIntText(findChild(section, 'externalUdpPorts_max'));
    const sentinel = UDP_DISABLED_SENTINEL[sectionName];
    const disabled =
      sentinel !== undefined && (udpMin === sentinel || udpMax === sentinel);
    const hasAny = udpMin !== null || udpMax !== null;
    if (hasAny || disabled) {
      claims.push({
        path: `${sectionName}.externalUdpPorts_min/max`,
        section: sectionName,
        scope: 'external-udp',
        role: 'local-bind',
        min: disabled ? null : udpMin,
        max: disabled ? null : udpMax,
        disabled,
        defaulted: false,
        selfHeal: false,
        source: `serverConfigCatalog: ${sectionName}.externalUdpPorts_min/max`
      });
    }
  }
  return claims;
}

/** telnet claim:每进程段一个监听端口;占用自愈重试(段注释);缺元素
 * /非整数 → 目录文档化的引擎默认端口(defaulted)。 */
function telnetClaims(tree: ConfigXmlNode): ConfigPortClaim[] {
  const claims: ConfigPortClaim[] = [];
  for (const sectionName of Object.keys(TELNET_DEFAULTS)) {
    const section = findChild(tree, sectionName);
    if (section === null) {
      continue;
    }
    const svc = findChild(section, 'telnet_service');
    const raw = svc === null ? null : parseIntText(findChild(svc, 'port'));
    const def = TELNET_DEFAULTS[sectionName];
    const defaulted = raw === null;
    const port = defaulted ? def : raw;
    claims.push({
      path: `${sectionName}.telnet_service.port`,
      section: sectionName,
      scope: 'telnet',
      role: 'local-bind',
      min: port,
      max: port,
      disabled: false,
      defaulted,
      selfHeal: true,
      source: `serverConfigCatalog: ${sectionName}.telnet_service.port(引擎默认 ${def};端口被占用则向后尝试 ${def + 1}..)`
    });
  }
  return claims;
}

/** http 回调端口(loginapp;http_cbhost 一般被引擎替换为 external 面)。 */
function httpCbClaims(tree: ConfigXmlNode): ConfigPortClaim[] {
  const loginapp = findChild(tree, 'loginapp');
  if (loginapp === null) {
    return [];
  }
  const port = parseIntText(findChild(loginapp, 'http_cbport'));
  if (port === null) {
    return [];
  }
  return [
    {
      path: 'loginapp.http_cbport',
      section: 'loginapp',
      scope: 'http-cb',
      role: 'local-bind',
      min: port,
      max: port,
      disabled: false,
      defaulted: false,
      selfHeal: false,
      source: 'serverConfigCatalog: loginapp.http_cbport(仅第一个 loginapp 才会开启这个服务)'
    }
  ];
}

/** interfaces 监听端口区间(interfaces 进程;无哨兵文档,缺元素不声称)。 */
function interfacesListenClaims(tree: ConfigXmlNode): ConfigPortClaim[] {
  const section = findChild(tree, 'interfaces');
  if (section === null) {
    return [];
  }
  const min = parseIntText(findChild(section, 'port_min'));
  const max = parseIntText(findChild(section, 'port_max'));
  if (min === null && max === null) {
    return [];
  }
  return [
    {
      path: 'interfaces.port_min/max',
      section: 'interfaces',
      scope: 'interfaces-listen',
      role: 'local-bind',
      min,
      max,
      disabled: false,
      defaulted: false,
      selfHeal: false,
      source: 'serverConfigCatalog: interfaces.port_min/max(interfaces 监听端口范围)'
    }
  ];
}

/** 远端目标 claims(引用目标面;bots 登录 loginapp 的端口段 / dbmgr
 * 数据库端口 / InterfacesServiceAddr 条目端口)。不参与本机冲突。 */
function outboundTargetClaims(tree: ConfigXmlNode): ConfigPortClaim[] {
  const claims: ConfigPortClaim[] = [];
  const bots = findChild(tree, 'bots');
  if (bots !== null) {
    const min = parseIntText(findChild(bots, 'port_min'));
    const max = parseIntText(findChild(bots, 'port_max'));
    if (min !== null || max !== null) {
      claims.push({
        path: 'bots.port_min/max',
        section: 'bots',
        scope: 'external-tcp',
        role: 'outbound-target',
        min: min === 0 ? null : min,
        max: max === 0 ? null : max,
        disabled: false,
        defaulted: min === 0 || max === 0,
        selfHeal: true,
        source: 'serverConfigCatalog: bots.port_min/max(登录 loginapp 的端口范围;max 小于下限时取下限)'
      });
    }
  }
  const dbmgr = findChild(tree, 'dbmgr');
  if (dbmgr !== null) {
    const dbi = findChild(dbmgr, 'databaseInterfaces');
    const def = dbi === null ? null : findChild(dbi, 'default');
    if (def !== null) {
      const port = parseIntText(findChild(def, 'port'));
      if (port !== null) {
        claims.push({
          path: 'dbmgr.databaseInterfaces.default.port',
          section: 'dbmgr',
          scope: 'external-tcp',
          role: 'outbound-target',
          min: port === 0 ? null : port,
          max: port === 0 ? null : port,
          disabled: false,
          defaulted: port === 0,
          selfHeal: false,
          source: 'serverConfigCatalog: dbmgr.databaseInterfaces.default.port(0 = MySQL 默认 3306)'
        });
      }
    }
    const isa = findChild(dbmgr, 'InterfacesServiceAddr');
    if (isa !== null) {
      let idx = 0;
      for (const item of isa.children) {
        if (item.name !== 'item') {
          continue;
        }
        idx += 1;
        const port = parseIntText(findChild(item, 'port'));
        if (port === null) {
          continue;
        }
        claims.push({
          path: idx === 1
            ? 'dbmgr.InterfacesServiceAddr.item.port'
            : `dbmgr.InterfacesServiceAddr.item#${idx}.port`,
          section: 'dbmgr',
          scope: 'external-tcp',
          role: 'outbound-target',
          min: port === 0 ? null : port,
          max: port === 0 ? null : port,
          disabled: false,
          defaulted: port === 0,
          selfHeal: false,
          source: 'serverConfigCatalog: dbmgr.InterfacesServiceAddr.item.port(0 = 引擎默认 KBE_INTERFACES_TCP_PORT)'
        });
      }
    }
  }
  return claims;
}

function rangesOverlap(
  a: ConfigPortClaim,
  b: ConfigPortClaim
): boolean {
  if (a.min === null || a.max === null || b.min === null || b.max === null) {
    return false; // 区间不可解(哨兵/默认未文档化/非整数)→ 诚实不算重叠
  }
  return a.max >= b.min && b.max >= a.min;
}

/** 端口冲突面:仅 local-bind、同 (协议族, 绑定面) 内做区间重叠;
 * 跨进程 = machineDependent(部署机器未知,不裁定);任一方 telnet =
 * 自愈注记。 */
function portOverlapFindings(claims: ConfigPortClaim[]): ConfigRelationFinding[] {
  const findings: ConfigRelationFinding[] = [];
  const binds = claims.filter((c) => c.role === 'local-bind');
  for (let i = 0; i < binds.length; i += 1) {
    for (let j = i + 1; j < binds.length; j += 1) {
      const a = binds[i];
      const b = binds[j];
      if (a.scope !== b.scope || a.section === b.section) {
        continue;
      }
      if (!rangesOverlap(a, b)) {
        continue;
      }
      const selfHeal = a.selfHeal || b.selfHeal;
      findings.push({
        kind: 'port-overlap',
        severity: 'info',
        paths: [a.path, b.path],
        detail: selfHeal
          ? `${a.section} 与 ${b.section} 的 ${a.scope} 端口区间重叠 [${a.min}..${a.max}] vs [${b.min}..${b.max}];涉及 telnet 服务时引擎占用向后重试,自愈非致命`
          : `${a.section} 与 ${b.section} 的 ${a.scope} 端口区间重叠 [${a.min}..${a.max}] vs [${b.min}..${b.max}];是否真冲突取决于两进程是否部署在同一物理机(静态不可知,不裁定)`,
        evidence: `serverConfigCatalog: ${a.section}/${b.section} 端口键;协议/绑定面分组判定`,
        machineDependent: true,
        selfHeal
      });
    }
  }
  return findings;
}

/** 字段组合面:min>max 算术关系。bots 段有引擎夹断文档(自愈);
 * external 段无文档 → 只报算术事实,不裁定引擎行为(逐条核实纪律)。 */
function rangeOrderFindings(claims: ConfigPortClaim[]): ConfigRelationFinding[] {
  const findings: ConfigRelationFinding[] = [];
  for (const claim of claims) {
    if (claim.min === null || claim.max === null || claim.min <= claim.max) {
      continue;
    }
    if (claim.role === 'outbound-target' && claim.section === 'bots') {
      findings.push({
        kind: 'range-clamp',
        severity: 'info',
        paths: [claim.path],
        detail: `bots 端口区间 ${claim.path} min(${claim.min}) > max(${claim.max}):引擎夹断取下限(目录注释「小于下限时取下限」),自愈非致命`,
        evidence: 'serverConfigCatalog: bots.port_max(小于下限时取下限)',
        machineDependent: false,
        selfHeal: true
      });
    } else if (claim.role === 'local-bind') {
      findings.push({
        kind: 'range-empty-candidate',
        severity: 'info',
        paths: [claim.path],
        detail: `${claim.path} min(${claim.min}) > max(${claim.max}):区间为空;引擎对该段无夹断文档(逐条核实:bots 段有夹断注释,此处无)——算术事实候选,不裁定引擎行为`,
        evidence: `${claim.source};external 段无引擎夹断证据(诚实候选,不声称)`,
        machineDependent: false,
        selfHeal: false
      });
    }
  }
  return findings;
}

/** 哨兵组合面:哨兵禁用(udp 不启用)的同时对端显式给了正值 → 显式值
 * 不生效(目录哨兵文档)。 */
function disabledSentinelFindings(tree: ConfigXmlNode): ConfigRelationFinding[] {
  const findings: ConfigRelationFinding[] = [];
  for (const sectionName of Object.keys(UDP_DISABLED_SENTINEL)) {
    const section = findChild(tree, sectionName);
    if (section === null) {
      continue;
    }
    const sentinel = UDP_DISABLED_SENTINEL[sectionName];
    const min = parseIntText(findChild(section, 'externalUdpPorts_min'));
    const max = parseIntText(findChild(section, 'externalUdpPorts_max'));
    const disabled = min === sentinel || max === sentinel;
    if (!disabled) {
      continue;
    }
    const liveValues: number[] = [];
    if (min !== null && min !== sentinel) {
      liveValues.push(min);
    }
    if (max !== null && max !== sentinel) {
      liveValues.push(max);
    }
    if (liveValues.length > 0) {
      findings.push({
        kind: 'disabled-sentinel',
        severity: 'info',
        paths: [`${sectionName}.externalUdpPorts_min/max`],
        detail: `${sectionName}.externalUdpPorts 哨兵值 ${sentinel} = 不启用,另一端显式值 ${liveValues.join('/')} 不生效(目录哨兵语义逐段不同:loginapp -1 / machine 0)`,
        evidence: `serverConfigCatalog: ${sectionName}.externalUdpPorts_min/max(哨兵 ${sentinel} = 不启用)`,
        machineDependent: false,
        selfHeal: false
      });
    }
  }
  return findings;
}

/** 引用目标面:dbmgr 数据库接口至少一个 default(目录注释);不转发时
 * InterfacesServiceAddr 条目失效(目录注释)。 */
function referenceTargetFindings(tree: ConfigXmlNode): ConfigRelationFinding[] {
  const findings: ConfigRelationFinding[] = [];
  const dbmgr = findChild(tree, 'dbmgr');
  if (dbmgr !== null) {
    const dbi = findChild(dbmgr, 'databaseInterfaces');
    if (dbi !== null && findChild(dbi, 'default') === null) {
      findings.push({
        kind: 'missing-default-dbinterface',
        severity: 'error',
        paths: ['dbmgr.databaseInterfaces'],
        detail: 'dbmgr.databaseInterfaces 未定义 default 接口;引擎要求至少存在一个 default(目录注释)',
        evidence: 'serverConfigCatalog: dbmgr.databaseInterfaces.default(可以定义多个不同的接口,但至少存在一个 default)',
        machineDependent: false,
        selfHeal: false
      });
    }
    const isa = findChild(dbmgr, 'InterfacesServiceAddr');
    if (isa !== null) {
      const enable = findChild(isa, 'enable');
      const hasItems = isa.children.some((c) => c.name === 'item');
      if (enable !== null && enable.text.trim() === 'false' && hasItems) {
        findings.push({
          kind: 'inert-interfaces-forwarding',
          severity: 'info',
          paths: ['dbmgr.InterfacesServiceAddr'],
          detail: 'dbmgr.InterfacesServiceAddr.enable=false 时相关数据不转发到 Interfaces 进程,已配置的 item 条目不生效(目录注释)',
          evidence: 'serverConfigCatalog: dbmgr.InterfacesServiceAddr.enable(如果 enable 为 false 则相关数据不转发到 Interfaces 进程)',
          machineDependent: false,
          selfHeal: false
        });
      }
    }
  }
  return findings;
}

/**
 * 引擎配置关联约束检查入口(纯函数;tree = serverConfigMerge 解析产物,
 * 最终生效树或 defaults 快照均可;入口处做 <root> 包裹归一,与
 * configContract 同口径——parseConfigXml 空名文档包裹须归一,CFG-04 坑)。
 */
export function checkEngineConfigRelations(tree: ConfigXmlNode): ConfigRelationReport {
  const root = normalizeRootNode(tree);
  const claims = [
    ...externalRangeClaims(root),
    ...telnetClaims(root),
    ...httpCbClaims(root),
    ...interfacesListenClaims(root),
    ...outboundTargetClaims(root)
  ];
  const findings = [
    ...portOverlapFindings(claims),
    ...rangeOrderFindings(claims),
    ...disabledSentinelFindings(root),
    ...referenceTargetFindings(root)
  ];
  const rank = (f: ConfigRelationFinding): number =>
    f.severity === 'error' ? 0 : f.severity === 'warning' ? 1 : 2;
  findings.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.paths[0].localeCompare(b.paths[0]) ||
      a.kind.localeCompare(b.kind)
  );
  return { claims, findings };
}

// ── 路径基准面(项目配置注册表,CFG-08 产物消费) ──────────────────

export interface ConfigPathBaselineFinding {
  kind: 'uncovered-read' | 'unused-binding';
  /** 具体读取路径(uncovered-read)/ 绑定 glob(unused-binding) */
  path: string;
  loader: 'json.loads' | 'json.load' | null;
  sources: readonly ConfigStructureSource[];
}

/**
 * 路径基准检查:代码读取路径是否落在声明基线(绑定 glob)内、声明基线
 * 是否有代码读取证据。双向都只报事实与来源,不裁定(未覆盖=零约束,
 * 未使用=可能由外部工具读取)。
 */
export function checkProjectPathBaseline(
  structure: ProjectConfigStructure
): ConfigPathBaselineFinding[] {
  const findings: ConfigPathBaselineFinding[] = [];
  for (const r of structure.uncoveredReads) {
    findings.push({
      kind: 'uncovered-read',
      path: r.path,
      loader: r.loader,
      sources: r.sources
    });
  }
  for (const entry of structure.entries) {
    if (entry.tier === 'explicit-schema' && entry.face === 'path-binding' && entry.readers.length === 0) {
      findings.push({
        kind: 'unused-binding',
        path: entry.key,
        loader: null,
        sources: entry.sources
      });
    }
  }
  return findings.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path)
  );
}
