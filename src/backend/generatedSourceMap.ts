import type {
  EntityTypeStubEntry,
  EntityTypeStubLineMap
} from '../entityTypeStubs';
import type {
  PythonTypeStubEntry,
  PythonTypeStubLineMap
} from '../pythonTypeStubs';

export interface GeneratedSourceLocation {
  origin: string;
  line: number;
  /** 来源文件族:types.xml 自定义类型声明,或 .def 实体声明(RUST-160 判别面) */
  sourceKind: 'types.xml' | 'def';
  /** 实体面命中时携带属性名(供 lens 按逐属性 defFile 解析跳转目标) */
  propertyName?: string;
}

/**
 * KR-AUD-78:按生成文档真实行映射来源——python 侧行映射来自
 * buildPythonTypeStubLineMap(渲染期记录),不再硬编码 line 0/2,
 * 多条目同名键覆盖问题随之消除。
 */
export function resolvePythonTypeStubSource(
  entries: readonly PythonTypeStubEntry[],
  lineMap: PythonTypeStubLineMap | null,
  documentLine: number
): GeneratedSourceLocation | null {
  if (!lineMap) {
    return null;
  }
  for (const entry of entries) {
    const declaredLine = lineMap.entryLines.get(entry.name);
    if (declaredLine === documentLine && entry.sourceLine !== null && entry.sourceLine !== undefined) {
      return { origin: entry.name, line: entry.sourceLine, sourceKind: 'types.xml' };
    }
    if (entry.kind !== 'class') {
      continue;
    }
    const propertyLines = lineMap.propertyLines.get(entry.name);
    if (!propertyLines) {
      continue;
    }
    for (const property of entry.properties) {
      if (propertyLines[property.name] !== documentLine) {
        continue;
      }
      const sourceLine = entry.propertySourceLines?.[property.name];
      if (sourceLine !== null && sourceLine !== undefined) {
        return { origin: entry.name, line: sourceLine, sourceKind: 'types.xml' };
      }
    }
  }
  return null;
}

export function resolveEntityTypeStubSource(
  entries: readonly EntityTypeStubEntry[],
  lineMap: EntityTypeStubLineMap | null,
  documentLine: number
): GeneratedSourceLocation | null {
  if (!lineMap) {
    return null;
  }
  for (const entry of entries) {
    const propertyLines = lineMap.propertyLines.get(entry.entity);
    if (!propertyLines) {
      continue;
    }
    for (const property of entry.properties) {
      if (propertyLines[property.name] !== documentLine) {
        continue;
      }
      return property.customTypeLine !== undefined
        ? { origin: entry.entity, line: property.customTypeLine, sourceKind: 'types.xml', propertyName: property.name }
        : { origin: entry.entity, line: property.sourceLine, sourceKind: 'def', propertyName: property.name };
    }
  }
  return null;
}
