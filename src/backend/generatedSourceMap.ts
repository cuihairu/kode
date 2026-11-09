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
      return { origin: entry.name, line: entry.sourceLine };
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
        return { origin: entry.name, line: sourceLine };
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
      return {
        origin: entry.entity,
        line: property.customTypeLine ?? property.sourceLine
      };
    }
  }
  return null;
}
