// IDE-LINT-011:统一 lint 规则注册与能力清单。每一条规则登记
// code/严重度/适用角色/开关/触发入口/修复支持/实现状态/源码模块,单一
// 事实源(规则表),供「Kode Lint Rules」报告命令与一致性测试消费。
// 规范编号与 docs/zh/guide/kbengine-lint-rules.md 规则总表一一对应
// (表内未登记的交付诊断在总表续号:KBE-PY-011..014 / KBE-DEF-010..013)。
//
// 纯逻辑层,不 import vscode/不读配置——开关启用态由调用方注入
// (isToggleEnabled),本模块只登记与渲染。状态三档明确区分:
//   - implemented:真实诊断已发布(Problems 可见,走诊断集合);
//   - hint-only  :仅 hover/inlay/补全等元数据,无诊断(规则覆盖表如实);
//   - pending    :待实现(不冒充已交付)。
//
// 一致性契约(测试钉住):implemented 规则的 code 字符串必须出现在真实
// src 模块(结构诊断发布时不带 code,规则表如实标注);每条规则引用的
// 开关必须在 package.json contributes.configuration;package.json 的每个
// 诊断类配置键必须被至少一条规则引用(无孤儿开关)。

/** 规则实现状态(已实现 / 仅提示 / 待实现) */
export type LintRuleStatus = 'implemented' | 'hint-only' | 'pending';

/** 触发入口(实时诊断 / 按需分析 / 提示元数据) */
export type LintRuleTrigger = '实时(open/edit)' | '实时结构' | '按需分析' | 'hover/inlay/补全';

/** 一条 lint 规则的登记描述 */
export interface LintRuleDescriptor {
  /** 规范编号(规则总表文档编号,如 KBE-PY-001;待实现项用 todo 编号) */
  id: string;
  /** 诊断 code(`kbengine.*` 或 Rust lint id);hint-only/pending/无 code 结构诊断为 null */
  code: string | null;
  /** 规则标题(中文) */
  title: string;
  /** 严重度(仅 implemented) */
  severity: 'Error' | 'Warning' | 'Information' | null;
  /** 适用角色/面(引擎组件或文档域) */
  roles: string;
  /** 配置开关键集(空 = 无独立开关/主开关外常开;任一开即启用该规则) */
  toggles: readonly string[];
  /** 触发入口 */
  trigger: LintRuleTrigger;
  /** 修复支持:false=无;true=有;字符串=修复名 */
  quickFix: boolean | string;
  /** 实现状态 */
  status: LintRuleStatus;
  /** 实现源码模块(证据面;hint-only/pending 为调研/待定模块) */
  source: string;
}

/**
 * 规则表(单一事实源)。排序:先 implemented(按角色分组),再 hint-only,
 * 再 pending。code 与 toggles 均须与 package.json/src 真值一致(测试锁步)。
 */
export const LINT_RULES: readonly LintRuleDescriptor[] = [
  // ── Python 脚本实时诊断(implemented)────────────────────────────
  {
    id: 'KBE-PY-001', code: 'kbengine.receiverNone',
    title: '直接引用可能为 None 的 self.cell/base/client 成员',
    severity: 'Warning', roles: 'base/cell/client',
    toggles: ['kbengine.receiverNoneDiagnostics'], trigger: '实时(open/edit)',
    quickFix: '包裹守卫/提前返回', status: 'implemented',
    source: 'src/receiverNoneDiagnostics.ts'
  },
  {
    id: 'KBE-PY-003', code: 'kbengine.sectionMismatch',
    title: 'receiver 与 .def 方法声明段不匹配',
    severity: 'Warning', roles: 'base/cell/client',
    toggles: ['kbengine.receiverNoneDiagnostics'], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/receiverNoneDiagnostics.ts'
  },
  {
    id: 'KBE-PY-011', code: 'kbengine.attributeNone',
    title: '用户自管 self.<attr> 含 None 且未窄化的成员访问',
    severity: 'Warning', roles: 'base/cell/client',
    toggles: ['kbengine.attributeNoneDiagnostics'], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/selfAttributeNoneDiagnostics.ts'
  },
  {
    id: 'KBE-PY-012', code: 'kbengine.propertyDirectionViolation',
    title: 'def 属性访问方向违规(位置不在 Flags 域位内)',
    severity: 'Warning', roles: 'base/cell/client',
    toggles: ['kbengine.propertyDirectionDiagnostics'], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/propertyDirectionDiagnostics.ts'
  },
  {
    id: 'KBE-PY-012b', code: 'kbengine.propertyDirectionScopeUnknown',
    title: '属性方向判定文件作用域不足(降级参考信息)',
    severity: 'Information', roles: 'base/cell/client',
    toggles: ['kbengine.propertyDirectionDiagnostics'], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/propertyDirectionDiagnostics.ts'
  },
  {
    id: 'KBE-PY-013', code: 'kbengine.spaceNav',
    title: '空间/导航语义(保留键 _mapping/无 canNavigate 的 navigate/键类型)',
    severity: 'Warning', roles: 'base/cell',
    toggles: ['kbengine.spaceNavDiagnostics'], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/spaceNavDiagnostics.ts'
  },
  {
    id: 'KBE-PY-014', code: 'kbengine.startupScript',
    title: '启动脚本启动行未知 --参数/非数字 --cid/--gus/未赋值引用',
    severity: 'Warning', roles: '启动脚本',
    toggles: ['kbengine.startupScriptDiagnostics'], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/kbengineStartupScript.ts'
  },
  {
    id: 'KBE-PY-007', code: 'kbengine.readOnlyWrite',
    title: '写入引擎内建只读属性(普通/增强/注解赋值与 del)',
    severity: 'Warning', roles: 'base/cell/client',
    toggles: ['kbengine.readOnlyWriteDiagnostics'], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/readOnlyWriteDiagnostics.ts'
  },
  // ── def/结构实时诊断(implemented)────────────────────────────────
  {
    id: 'KBE-DEF-001', code: 'kbengine.unknownType',
    title: '未知 Type/Flags/DetailLevel',
    severity: 'Warning', roles: 'def',
    toggles: [
      'kbengine.diagnostics.checkUnknownTypes',
      'kbengine.diagnostics.checkUnknownFlags',
      'kbengine.diagnostics.checkUnknownDetailLevels'
    ],
    trigger: '实时结构', quickFix: '替换为已注册类型',
    status: 'implemented', source: 'src/defAnalyzer.ts(languageProviders 发布)'
  },
  {
    id: 'KBE-DEF-003', code: null,
    title: '同域重复定义、缺失/重复必需字段(结构诊断发布时不带 code)',
    severity: 'Warning', roles: 'def',
    toggles: [
      'kbengine.enableStructureDiagnostics',
      'kbengine.diagnostics.checkDuplicateDefinitions',
      'kbengine.diagnostics.checkMissingPropertyFields'
    ],
    trigger: '实时结构', quickFix: false,
    status: 'implemented', source: 'src/defAnalyzer.ts'
  },
  {
    id: 'KBE-DEF-009', code: 'duplicate-entity-name',
    title: 'entities.xml 重复实体注册',
    severity: 'Warning', roles: 'def',
    toggles: [], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/entitiesXmlAnalysis.ts'
  },
  {
    id: 'KBE-DEF-010', code: 'kbengine.userTypeContractMethodMissing',
    title: 'user_type 三契约方法缺失(createObjFromDict/getDictFromObj/isSameType)',
    severity: 'Error', roles: 'def',
    toggles: ['kbengine.enableDiagnostics'], trigger: '实时(open/edit)',
    quickFix: '生成空实现', status: 'implemented',
    source: 'src/userTypeContract.ts'
  },
  {
    id: 'KBE-DEF-011', code: 'def-method-missing-in-python',
    title: 'def 声明方法在 Python 缺实现',
    severity: 'Warning', roles: 'def',
    toggles: ['kbengine.diagnostics.checkDefMethodMissingInPython'],
    trigger: '实时(open/edit)', quickFix: '生成方法骨架',
    status: 'implemented', source: 'src/defMethodConsistency.ts'
  },
  {
    id: 'KBE-DEF-012', code: 'kbengine.pythonMethodNotInDef',
    title: 'Python 方法在 def 无声明',
    severity: 'Warning', roles: 'base/cell/client',
    toggles: ['kbengine.diagnostics.checkPythonMethodNotInDef'],
    trigger: '实时(open/edit)', quickFix: false,
    status: 'implemented', source: 'src/defMethodConsistency.ts'
  },
  {
    id: 'KBE-DEF-013', code: 'kbengine.processTopology',
    title: '进程拓扑定义与定义期错配预警',
    severity: 'Warning', roles: 'def/清单',
    toggles: ['kbengine.diagnostics.checkProcessTopology'],
    trigger: '实时(open/edit)', quickFix: false,
    status: 'implemented', source: 'src/processTopologyDiagnostics.ts'
  },
  // ── def 按需分析(implemented,非实时)────────────────────────────
  {
    id: 'KBE-DEF-004', code: 'phantom-type',
    title: 'BOOL/BOOLEAN/TUPLE/MAP/FIXED_ARRAY 等未注册类型',
    severity: 'Warning', roles: 'def',
    toggles: [], trigger: '按需分析', quickFix: false,
    status: 'implemented', source: 'src/defAnalyzer.ts'
  },
  {
    id: 'KBE-DEF-005', code: 'invalid-identifier',
    title: '方法/属性/继承声明非法名称',
    severity: 'Error', roles: 'def',
    toggles: [], trigger: '按需分析', quickFix: false,
    status: 'implemented', source: 'src/defAnalyzer.ts'
  },
  {
    id: 'KBE-DEF-005b', code: 'engine-limited-name',
    title: '引擎限定名',
    severity: 'Error', roles: 'def',
    toggles: [], trigger: '按需分析', quickFix: false,
    status: 'implemented', source: 'src/defAnalyzer.ts'
  },
  {
    id: 'KBE-DEF-005c', code: 'method-property-collision',
    title: '方法/属性声明名称冲突',
    severity: 'Error', roles: 'def',
    toggles: [], trigger: '按需分析', quickFix: false,
    status: 'implemented', source: 'src/defAnalyzer.ts'
  },
  {
    id: 'KBE-DEF-005d', code: 'inherited-name-collision',
    title: '继承名冲突',
    severity: 'Error', roles: 'def',
    toggles: [], trigger: '按需分析', quickFix: false,
    status: 'implemented', source: 'src/defAnalyzer.ts'
  },
  {
    id: 'KBE-DEF-006', code: 'heavy-sync-broadcast',
    title: '重负载属性广播',
    severity: 'Warning', roles: 'def',
    toggles: [], trigger: '按需分析', quickFix: false,
    status: 'implemented', source: 'src/defAnalyzer.ts'
  },
  {
    id: 'KBE-DEF-006b', code: 'redundant-detail-level',
    title: '无效 DetailLevel 配置',
    severity: 'Warning', roles: 'def',
    toggles: [], trigger: '按需分析', quickFix: false,
    status: 'implemented', source: 'src/defAnalyzer.ts'
  },
  // ── 仅提示(hint-only,无诊断)───────────────────────────────────
  // 引擎实体 API(方法,如 teleport/addTimer)角色面表尚未建立 → 保持仅提示;
  // 属性角色错用已实现(见 KBE-PY-008b)。
  {
    id: 'KBE-PY-008', code: null,
    title: '在错误角色访问引擎 API(仅 hover/补全元数据;属性面已实现 KBE-PY-008b)',
    severity: null, roles: 'base/cell/client',
    toggles: ['kbengine.entity.builtinProperties'], trigger: 'hover/inlay/补全',
    quickFix: false, status: 'hint-only',
    source: 'src/entityBuiltinProperties.ts'
  },
  {
    id: 'KBE-PY-008b', code: 'kbengine.roleMisuse',
    title: '在错误角色访问引擎属性(属性角色错用实时 Warning)',
    severity: 'Warning', roles: 'base/cell/client',
    toggles: ['kbengine.roleMisuseDiagnostics'], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/roleMisuseDiagnostics.ts(属性面表取 entityBuiltinProperties.ts)'
  },
  {
    id: 'KBE-PY-009', code: 'kbengine.rpcArgCount',
    title: 'RPC 参数数量与 .def 不一致(调用点实参数对账)',
    severity: 'Warning', roles: 'base/cell/client',
    toggles: ['kbengine.rpcArgCountDiagnostics'], trigger: '实时(open/edit)',
    quickFix: false, status: 'implemented',
    source: 'src/rpcArgCountDiagnostics.ts'
  },
  // ── 待实现(pending)────────────────────────────────────────────
  {
    id: 'KBE-PY-010', code: null,
    title: 'Entity 销毁后访问 lint(IDE-LINT-010)',
    severity: null, roles: 'base/cell/client',
    toggles: [], trigger: '实时(open/edit)',
    quickFix: false, status: 'pending',
    source: 'IDE-LINT-010(待实现)'
  }
];

/**
 * 已启用规则:implemented 且(无独立开关或任一开关开启)。开关态由调用方
 * 注入(读 vscode 配置或测试替身);无 toggle 的 implemented 规则恒启用
 * (def 按需分析经命令触发,不随开关关闭)。
 */
export function getEnabledLintRules(
  isToggleEnabled: (toggle: string) => boolean
): readonly LintRuleDescriptor[] {
  return LINT_RULES.filter(
    rule =>
      rule.status === 'implemented'
      && (rule.toggles.length === 0 || rule.toggles.some(isToggleEnabled))
  );
}

/**
 * 规则报告文本(输出通道/测试共用):按状态分组列出每条规则
 * code/严重度/角色/开关/触发/修复/源码,并标注启用态。已启用集合与
 * Problems 一致(一致性测试核验 code 均在真实 src 模块、toggle 均在 package.json)。
 */
export function renderLintRulesReport(
  isToggleEnabled: (toggle: string) => boolean
): string {
  const lines: string[] = ['Kode 诊断规则能力清单(IDE-LINT-011)', '='.repeat(48), ''];
  const statusLabel: Record<LintRuleStatus, string> = {
    implemented: '已实现',
    'hint-only': '仅提示',
    pending: '待实现'
  };
  for (const status of ['implemented', 'hint-only', 'pending'] as const) {
    const group = LINT_RULES.filter(rule => rule.status === status);
    lines.push(`■ ${statusLabel[status]}(${group.length})`);
    for (const rule of group) {
      const enabled =
        rule.status === 'implemented'
        && (rule.toggles.length === 0 || rule.toggles.some(isToggleEnabled));
      const code = rule.code ?? '(—)';
      const sev = rule.severity ?? '—';
      const qf = rule.quickFix === false ? '无' : typeof rule.quickFix === 'string' ? rule.quickFix : '有';
      const mark = rule.status === 'implemented' ? (enabled ? '●启用' : '○停用') : '';
      lines.push(
        `  ${mark} ${rule.id.padEnd(14)} ${code.padEnd(30)} ${sev.padEnd(11)} ${rule.roles.padEnd(16)} `
        + `开关:${rule.toggles.length === 0 ? '无' : rule.toggles.join('/')} | 触发:${rule.trigger} | 修复:${qf} | ${rule.source}`
      );
    }
    lines.push('');
  }
  lines.push('已实现:真实诊断(Problems 可见) | 仅提示:hover/inlay/补全元数据 | 待实现:未交付');
  return lines.join('\n');
}
