/**
 * RUST-167 type-preview pure core (the RUST-lane sibling of RUST-166): unifies
 * the "API type tree / typing coverage / missing mappings / source jumps" four
 * concerns into one previewable node tree. Zero vscode dependency — all data comes
 * from existing generated faces (the entity stub-plan entries + the kbe_types stub
 * plan entries/skip table + the CustomTypeInfo path table); jumps always use real
 * source lines (1-based), following the same RUST-160 family discriminant: a
 * customTypeLine present = the types.xml family, otherwise the .def family; faces
 * whose real path cannot be resolved simply do not jump, honestly — a generated
 * line number is never passed off as the source.
 */

import type { EntityTypeStubEntry } from '../entityTypeStubs';
import type { CustomTypeInfo } from '../definitionWorkspace';
import type { PythonTypeStubEntry, PythonTypeStubSkipped } from '../pythonTypeStubs';

/** A source-jump target: a real file + a 1-based line */
export interface TypePreviewJump {
  uri: string;
  line: number;
}

export interface TypePreviewNode {
  label: string;
  description?: string;
  jump?: TypePreviewJump;
  children?: TypePreviewNode[];
}

/** Typing coverage: the proportion of all annotation slots that resolved (excluding Any); anyCount = the count of missing-mapping candidates */
export interface TypePreviewCoverage {
  total: number;
  resolved: number;
  anyCount: number;
}

export interface TypePreviewInput {
  entities: readonly EntityTypeStubEntry[];
  /** Entity name → .def absolute path (the .def-family jump target; a face lacking the mapping does not jump, honestly) */
  entityDefFiles: ReadonlyMap<string, string>;
  customTypes: readonly CustomTypeInfo[];
  /** The kbe_types stub plan's kept entries (classes/aliases, carrying annotations and source lines) */
  typeEntries: readonly PythonTypeStubEntry[];
  /** The kbe_types stub plan's skip table (cyclic/duplicate names voided, with the reason stated) */
  typeSkipped: readonly PythonTypeStubSkipped[];
  /** The types.xml absolute path (the types.xml-family jump target; when absent, that family honestly does not jump) */
  typesXmlPath?: string;
}

export interface TypePreviewModel {
  root: TypePreviewNode;
  coverage: TypePreviewCoverage;
}

/** Whether an annotation landed on Any (the RUST-157 discipline: Any's only
 * legitimate semantics is the honest end of the resolution chain, so an annotation
 * slot containing Any is the honest list of "missing mappings"). Word-boundary
 * matching: FixedArray[Any] / Any hits, MANY / AnyType do not. */
function annotationHitsAny(annotation: string): boolean {
  return /\bAny\b/.test(annotation);
}

interface AnnotationPosition {
  /** Display name: `entity.property` / `type.field` / a bare alias name */
  label: string;
  annotation: string;
  jump?: TypePreviewJump;
}

export function buildTypePreviewModel(input: TypePreviewInput): TypePreviewModel {
  const customByName = new Map<string, CustomTypeInfo>(
    input.customTypes.map(info => [info.name, info])
  );

  /** The type-face jump: CustomTypeInfo carries a real file path; the line is the real source line, and a missing one means no jump */
  const typeJump = (name: string, line: number | null | undefined): TypePreviewJump | undefined => {
    const info = customByName.get(name);
    if (!info || typeof line !== 'number' || line <= 0) {
      return undefined;
    }
    return { uri: info.filePath, line };
  };

  /** The entity-property jump (family discrimination same as RUST-160): a customTypeLine present = the types.xml family,
   *  otherwise the .def family; a missing corresponding path (no typesXmlPath configured / entity not registered) means no jump */
  const entityPropertyJump = (
    entityName: string,
    prop: { sourceLine: number; customTypeLine?: number }
  ): TypePreviewJump | undefined => {
    if (prop.customTypeLine !== undefined) {
      return input.typesXmlPath ? { uri: input.typesXmlPath, line: prop.customTypeLine } : undefined;
    }
    const defFile = input.entityDefFiles.get(entityName);
    return defFile ? { uri: defFile, line: prop.sourceLine } : undefined;
  };

  // ---- Collect annotation slots (coverage / missing mappings share the same facts) ----
  const positions: AnnotationPosition[] = [];
  for (const entity of input.entities) {
    for (const prop of entity.properties) {
      positions.push({
        label: `${entity.entity}.${prop.name}`,
        annotation: prop.annotation,
        jump: entityPropertyJump(entity.entity, prop)
      });
    }
  }
  for (const entry of input.typeEntries) {
    if (entry.kind === 'alias') {
      positions.push({ label: entry.name, annotation: entry.annotation, jump: typeJump(entry.name, entry.sourceLine) });
    } else {
      for (const prop of entry.properties) {
        positions.push({
          label: `${entry.name}.${prop.name}`,
          annotation: prop.annotation,
          jump: typeJump(entry.name, entry.propertySourceLines?.[prop.name] ?? entry.sourceLine)
        });
      }
    }
  }
  const anyPositions = positions.filter(position => annotationHitsAny(position.annotation));
  const coverage: TypePreviewCoverage = {
    total: positions.length,
    resolved: positions.length - anyPositions.length,
    anyCount: anyPositions.length
  };

  // ---- The tree ----
  const coverageLeaf: TypePreviewNode = {
    label: `typing 覆盖: ${coverage.resolved}/${coverage.total} 已解析`,
    description: `${coverage.anyCount} 处含 Any(未解析)`
  };

  // Missing-mapping group: list Any annotation slots one by one (with jumps), plus
  // the skipped types (cyclic/duplicate names voided, reason stated); the whole group
  // does not appear when the face is empty (honest zero-missing)
  const missingChildren: TypePreviewNode[] = anyPositions.map(position => ({
    label: `${position.label}: ${position.annotation}`,
    jump: position.jump
  }));
  for (const skipped of input.typeSkipped) {
    missingChildren.push({
      label: `${skipped.name}: ${skipped.reason}`,
      jump: typeJump(skipped.name, customByName.get(skipped.name)?.line)
    });
  }
  const missingGroup: TypePreviewNode | null =
    missingChildren.length > 0
      ? { label: `缺失映射(${missingChildren.length})`, children: missingChildren }
      : null;

  // Custom-type group: class entries list their fields, alias entries land directly as
  // leaves; the source-file label becomes the description
  const typeNodes: TypePreviewNode[] = [];
  for (const entry of input.typeEntries) {
    if (entry.kind === 'alias') {
      typeNodes.push({
        label: `${entry.name} → ${entry.annotation}`,
        description: entry.sourceFile,
        jump: typeJump(entry.name, entry.sourceLine)
      });
    } else {
      typeNodes.push({
        label: `${entry.name}(字段 ${entry.properties.length})`,
        description: entry.sourceFile,
        jump: typeJump(entry.name, entry.sourceLine),
        children: entry.properties.map(prop => ({
          label: `${prop.name}: ${prop.annotation}`,
          jump: typeJump(entry.name, entry.propertySourceLines?.[prop.name] ?? entry.sourceLine)
        }))
      });
    }
  }
  const typesGroup: TypePreviewNode | null =
    typeNodes.length > 0 ? { label: `自定义类型(${typeNodes.length})`, children: typeNodes } : null;

  // Entity group: the entity shell jumps to the .def (line 1 = file header; the def
  // declaration line is not in the stub plan, so it is not fabricated), properties
  // jump per family, methods jump to the def method-face line
  const entityNodes: TypePreviewNode[] = input.entities.map(entity => {
    const defFile = input.entityDefFiles.get(entity.entity);
    const methodChildren: TypePreviewNode[] = [
      ...entity.methods,
      ...(entity.remoteMethods ?? [])
    ].map(method => ({
      label: `${method.section}.${method.name}(${method.args.length} 参)`,
      jump: defFile ? { uri: defFile, line: method.sourceLine } : undefined
    }));
    return {
      label: entity.entity,
      jump: defFile ? { uri: defFile, line: 1 } : undefined,
      children: [
        ...entity.properties.map(prop => ({
          label: `${prop.name}: ${prop.annotation}`,
          jump: entityPropertyJump(entity.entity, prop)
        })),
        ...methodChildren
      ]
    };
  });
  const entitiesGroup: TypePreviewNode | null =
    entityNodes.length > 0 ? { label: `实体(${entityNodes.length})`, children: entityNodes } : null;

  const children: TypePreviewNode[] = [coverageLeaf];
  if (missingGroup) {
    children.push(missingGroup);
  }
  if (typesGroup) {
    children.push(typesGroup);
  }
  if (entitiesGroup) {
    children.push(entitiesGroup);
  }
  if (children.length === 1) {
    children.push({ label: '未发现 def/types.xml 数据(先打开 def 或运行导出)' });
  }

  return {
    root: { label: 'KBEngine 类型预览', children },
    coverage
  };
}
