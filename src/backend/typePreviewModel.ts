/**
 * RUST-167 类型预览纯核(RUST-166 同批次 RUST 泳道):把「API 类型树 /
 * typing coverage / 缺失映射 / 来源跳转」四件事归一成一棵可预览的节点树。
 * 零 vscode 依赖——数据全部来自既有生成面(entity 桩计划条目 + kbe_types
 * 桩计划条目/跳过表 + CustomTypeInfo 路径表),跳转一律用真实源行(1 起),
 * 沿 RUST-160 同一族判别:customTypeLine 在场=types.xml 族,否则 .def 族;
 * 解析不出真实路径的面如实不跳,绝不拿生成行号充当来源。
 */

import type { EntityTypeStubEntry } from '../entityTypeStubs';
import type { CustomTypeInfo } from '../definitionWorkspace';
import type { PythonTypeStubEntry, PythonTypeStubSkipped } from '../pythonTypeStubs';

/** 来源跳转目标:真实文件 + 1 基行 */
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

/** typing 覆盖:全部注解位里已解析(不含 Any)的占比;anyCount=缺失映射候选数 */
export interface TypePreviewCoverage {
  total: number;
  resolved: number;
  anyCount: number;
}

export interface TypePreviewInput {
  entities: readonly EntityTypeStubEntry[];
  /** 实体名 → .def 绝对路径(def 族跳转目标;缺映射的面如实不跳) */
  entityDefFiles: ReadonlyMap<string, string>;
  customTypes: readonly CustomTypeInfo[];
  /** kbe_types 桩计划的 kept 条目(类/别名,携注解与源行) */
  typeEntries: readonly PythonTypeStubEntry[];
  /** kbe_types 桩计划的跳过表(成环/重名作废,原因写明) */
  typeSkipped: readonly PythonTypeStubSkipped[];
  /** types.xml 绝对路径(types.xml 族跳转目标;缺省则该族如实不跳) */
  typesXmlPath?: string;
}

export interface TypePreviewModel {
  root: TypePreviewNode;
  coverage: TypePreviewCoverage;
}

/** 注解里是否落到了 Any(RUST-157 纪律:Any 唯一合法语义=解析链诚实末端,
 * 所以含 Any 的注解位就是「缺失映射」的如实清单)。词边界判定:
 * FixedArray[Any] / Any 命中,MANY / AnyType 不命中。 */
function annotationHitsAny(annotation: string): boolean {
  return /\bAny\b/.test(annotation);
}

interface AnnotationPosition {
  /** 展示名:`实体.属性` / `类型.字段` / 别名裸名 */
  label: string;
  annotation: string;
  jump?: TypePreviewJump;
}

export function buildTypePreviewModel(input: TypePreviewInput): TypePreviewModel {
  const customByName = new Map<string, CustomTypeInfo>(
    input.customTypes.map(info => [info.name, info])
  );

  /** 类型面跳转:CustomTypeInfo 携真实文件路径;行取真实源行,缺任一不跳 */
  const typeJump = (name: string, line: number | null | undefined): TypePreviewJump | undefined => {
    const info = customByName.get(name);
    if (!info || typeof line !== 'number' || line <= 0) {
      return undefined;
    }
    return { uri: info.filePath, line };
  };

  /** 实体属性跳转(族判别同 RUST-160):customTypeLine 在场=types.xml 族,
   * 否则 .def 族;对应路径缺失(未配 typesXmlPath / 实体不在注册表)不跳 */
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

  // ---- 注解位收集(覆盖/缺失映射共用同一份事实) ----
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

  // ---- 树 ----
  const coverageLeaf: TypePreviewNode = {
    label: `typing 覆盖: ${coverage.resolved}/${coverage.total} 已解析`,
    description: `${coverage.anyCount} 处含 Any(未解析)`
  };

  // 缺失映射组:Any 注解位逐条列(带跳转),加上被跳过的类型(成环/重名作废,
  // 原因写明);零面时整组不出(诚实零缺失)
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

  // 自定义类型组:类条目列字段、别名条目直接落叶子;源文件标签做 description
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

  // 实体组:实体壳跳 .def(行 1=文件头;def 声明行不在桩计划里,不硬造),
  // 属性按族跳,方法跳 def 方法面行
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
