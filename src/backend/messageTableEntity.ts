/**
 * 单实体 messageTable 构建的共享装配面(IDE-AUD-060):preview(markdown)与
 * export(JSON)共用同一构建输入。实体所属根的类型注册表(types.xml)与
 * entitydefAliasID 引擎配置在此统一注入两个构建路径(Rust 核心
 * buildMessageTableInRust / TS 兜底 buildMessageTable),保证「所选根」的
 * types.xml 自定义别名(如 MY_INT→UINT32)进入类型注册表——方法参数不再误报
 * unknown-arg-type;alias 开关如实反映引擎配置(默认关)。装配层负责按实体
 * 解析所属根、读该根 types.xml 与读配置,本模块只做注入与分派,保持可单测。
 */
import {
  buildMessageTable,
  buildMessageTableInRust,
  type DefTreeSource,
  type MessageTable,
  type MessageTableOptions
} from './messageTable';
import type { LocalDefinitionSemantics } from '../definitionSemantics';

/** def 取源:与 buildMessageTableInRust/buildMessageTable 两路的输入同形 */
export interface EntityMessageTableSource {
  loadDefRaw(name: string, kind: 'entity' | 'interface' | 'component'): { content: string; filePath: string } | null;
  loadDef(name: string, kind: 'entity' | 'interface' | 'component'): LocalDefinitionSemantics | null;
}

/** 构建上下文:类型注册表与 alias 配置的事实源(装配层注入) */
export interface EntityMessageTableContext {
  /** 实体所属根的 types.xml 全文;无/缺失/不可读返回 null(按缺省口径构建) */
  readEntityTypesXml(entityName: string): string | null;
  /** entitydefAliasID 引擎配置(默认关);配置缺失/非法按 false */
  readAliasIdEnabled(): boolean;
}

export async function buildEntityMessageTableShared(
  entityName: string,
  source: EntityMessageTableSource,
  context: EntityMessageTableContext
): Promise<MessageTable | null> {
  const options: MessageTableOptions = {
    // 缺失/不可读 types.xml → undefined:不喂注册表,构建按无自定义类型口径
    // 如实推进(unknown-arg-type 等仍是真实问题,不算静默吞掉)
    typesXml: context.readEntityTypesXml(entityName) ?? undefined,
    aliasIdEnabled: context.readAliasIdEnabled()
  };
  const fromRust = await buildMessageTableInRust(entityName, {
    loadDefRaw: (name, kind) => source.loadDefRaw(name, kind)
  }, options);
  if (fromRust) {
    return fromRust;
  }
  const treeSource: DefTreeSource = {
    loadDef: (name, kind) => source.loadDef(name, kind)
  };
  return buildMessageTable(entityName, treeSource, options);
}
