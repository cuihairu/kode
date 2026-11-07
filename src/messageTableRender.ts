// SRC-012:messageTable.ts 渲染半边迁出(纯移动):人读 Markdown(renderMessageTableMarkdown)
// + 机读 JSON(renderMessageTableJson)及私有渲染辅助(renderArgSignature/renderArg/
// renderCellAliasId)。区域原文零改动;仅类型导入(自 messageTable,运行时无环),
// 公开入口在 messageTable.ts 经 re-export 保持既有导入路径不变。
import type { MessageArgEntry, MessageMethodEntry, MessageTable } from './messageTable';

export function renderMessageTableMarkdown(table: MessageTable): string {
  const lines: string[] = [];
  lines.push(`# 消息编号表 — ${table.module}`);
  lines.push('');
  lines.push(`- 生成时间: ${table.generatedAt}`);
  lines.push(`- aliasID: ${table.aliasIdEnabled ? '开启(entitydefAliasID)' : '关闭(引擎默认)'}`);
  if (table.sources.length > 1) {
    lines.push(`- 装配序: ${table.sources.map(source => `${source.name}(${source.kind})`).join(' → ')}`);
  }
  lines.push(
    table.loadFailed
      ? `- 装载状态: 失败(${table.fatalCount} 个致命问题;引擎遇首个 fatal 即终止装载,本表为按规约的完整推演,供一次定位全部冲突)`
      : '- 装载状态: 通过(无致命问题)'
  );
  lines.push('- 编号口径: 该实体为本次装载的首个模块;组件模块不并入(其 utype 消耗依赖全局装载序,静态不可定)');
  lines.push('');

  lines.push('## 客户端可见方法(消息编号表)');
  lines.push('');
  if (table.clientMethods.length === 0) {
    lines.push('(无客户端可见方法)');
  } else {
    lines.push('| # | 方法 | 段 | 方向 | 参数序列 | utype | aliasID | 来源 | 行 |');
    lines.push('|---|------|----|------|----------|-------|---------|------|----|');
    table.clientMethods.forEach((method, index) => {
      lines.push(
        `| ${index + 1} | ${method.name} | ${method.section} | ${method.direction} | ${renderArgSignature(method.args)} | ${method.utype ?? '—'} | ${renderCellAliasId(method, table.aliasIdEnabled)} | ${method.origin} | ${method.line} |`
      );
    });
  }
  lines.push('');

  const internalMethods = table.methods.filter(method => !method.visibleToClient);
  if (internalMethods.length > 0) {
    lines.push('## 服务器内部方法(不出现在客户端消息面,但占用 utype 序列)');
    lines.push('');
    lines.push('| 方法 | 段 | 参数序列 | utype | 来源 | 行 |');
    lines.push('|------|----|----------|-------|------|----|');
    for (const method of internalMethods) {
      lines.push(`| ${method.name} | ${method.section} | ${renderArgSignature(method.args)} | ${method.utype ?? '—'} | ${method.origin} | ${method.line} |`);
    }
    lines.push('');
  }

  lines.push('## 属性表(全量,含服务器内部属性与组件槽)');
  lines.push('');
  if (table.properties.length === 0) {
    lines.push('(无属性)');
  } else {
    lines.push('| 属性 | 类型 | Flags | utype | hasClient | aliasID | 来源 | 行 |');
    lines.push('|------|------|-------|-------|-----------|---------|------|----|');
    for (const property of table.properties) {
      lines.push(`| ${property.name} | ${property.typeName ?? '—'} | ${property.flags || '—'} | ${property.utype ?? '—'} | ${property.hasClient ? '是' : '否'} | ${property.aliasID === null ? '—' : property.aliasID} | ${property.origin} | ${property.line} |`);
    }
  }
  lines.push('');

  lines.push('## 客户端属性');
  lines.push('');
  if (!table.aliasIdEnabled) {
    lines.push('(aliasID 关闭:引擎 entitydefAliasID 默认关,属性无 aliasID;下表为客户端可见属性清单)');
    if (table.clientProperties.length > 0) {
      lines.push('');
      lines.push('| 属性 | 类型 | Flags | utype | 来源 | 行 |');
      lines.push('|------|------|-------|-------|------|----|');
      for (const property of table.clientProperties) {
        lines.push(`| ${property.name} | ${property.typeName ?? '—'} | ${property.flags} | ${property.utype ?? '—'} | ${property.origin} | ${property.line} |`);
      }
    }
  } else if (table.clientProperties.length === 0) {
    lines.push('(无 hasClient 属性)');
  } else {
    lines.push('| 属性 | 类型 | Flags | utype | aliasID | 来源 | 行 |');
    lines.push('|------|------|-------|-------|---------|------|----|');
    for (const property of table.clientProperties) {
      // 到达此臂时 aliasID 已由 assignAliasIds 赋值(数字或 -1),与 renderCellAliasId 同口径
      lines.push(`| ${property.name} | ${property.typeName ?? '—'} | ${property.flags} | ${property.utype ?? '—'} | ${String(property.aliasID)} | ${property.origin} | ${property.line} |`);
    }
    if (table.clientProperties.some(property => property.aliasID === -1)) {
      lines.push('');
      lines.push('> 计数超 255:引擎静默回退 -1,全部属性不使用 aliasID(usePropertyDescrAlias_ = false)。');
    }
  }
  lines.push('');

  lines.push('## 类型 utype 表');
  lines.push('');
  lines.push('| 类型 | utype | 种类 | 别名指向 | 来源 |');
  lines.push('|------|-------|------|----------|------|');
  for (const type of table.types) {
    lines.push(`| ${type.name} | ${type.utype} | ${type.kind} | ${type.aliasedTo ?? '—'} | ${type.origin || '基元'} |`);
  }
  lines.push('');

  lines.push('## 冲突与装载问题');
  lines.push('');
  if (table.issues.length === 0) {
    lines.push('(无)');
  } else {
    for (const issue of table.issues) {
      const where = issue.line === null ? '' : ` (行 ${issue.line})`;
      lines.push(`- [${issue.fatal ? 'fatal' : 'warn'}] ${issue.message}${where}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function renderArgSignature(args: MessageArgEntry[]): string {
  if (args.length === 0) {
    return '()';
  }
  return `(${args.map(arg => renderArg(arg)).join(', ')})`;
}

function renderArg(arg: MessageArgEntry): string {
  const name = arg.ofType ? `${arg.name} of ${renderArg(arg.ofType)}` : arg.name;
  return arg.utype === null ? `${name}?` : `${name}#${arg.utype}`;
}

function renderCellAliasId(method: MessageMethodEntry, aliasIdEnabled: boolean): string {
  if (!aliasIdEnabled || method.section !== 'ClientMethods') {
    return '—';
  }
  // 到达此臂时 aliasID 已由 assignAliasIds 赋值(可能 -1 表示超限回退)
  return String(method.aliasID);
}

/** 机读 JSON:与 MessageTable 同形的纯数据(可直接 JSON.parse 消费) */
export function renderMessageTableJson(table: MessageTable): string {
  return JSON.stringify(
    {
      module: table.module,
      generatedAt: table.generatedAt,
      aliasIdEnabled: table.aliasIdEnabled,
      loadFailed: table.loadFailed,
      fatalCount: table.fatalCount,
      sources: table.sources,
      methods: table.methods.map(method => ({
        name: method.name,
        section: method.section,
        direction: method.direction,
        visibleToClient: method.visibleToClient,
        exposed: method.exposed,
        args: method.args.map(arg => ({
          name: arg.name,
          ofType: arg.ofType,
          utype: arg.utype,
          line: arg.line
        })),
        declaredUtype: method.declaredUtype,
        utype: method.utype,
        aliasID: method.aliasID,
        status: method.status,
        origin: method.origin,
        originKind: method.originKind,
        line: method.line
      })),
      clientMethods: table.clientMethods.map(method => ({
        name: method.name,
        section: method.section,
        direction: method.direction,
        args: method.args.map(arg => ({
          name: arg.name,
          ofType: arg.ofType,
          utype: arg.utype,
          line: arg.line
        })),
        utype: method.utype,
        aliasID: method.aliasID,
        origin: method.origin,
        line: method.line
      })),
      properties: table.properties.map(property => ({
        name: property.name,
        typeName: property.typeName,
        flags: property.flags,
        hasClient: property.hasClient,
        utype: property.utype,
        declaredUtype: property.declaredUtype,
        aliasID: property.aliasID,
        origin: property.origin,
        originKind: property.originKind,
        line: property.line
      })),
      clientProperties: table.clientProperties.map(property => ({
        name: property.name,
        typeName: property.typeName,
        flags: property.flags,
        hasClient: property.hasClient,
        utype: property.utype,
        declaredUtype: property.declaredUtype,
        aliasID: property.aliasID,
        origin: property.origin,
        line: property.line
      })),
      types: table.types,
      issues: table.issues.map(issue => ({
        kind: issue.kind,
        message: issue.message,
        fatal: issue.fatal,
        line: issue.line
      }))
    },
    null,
    2
  );
}
