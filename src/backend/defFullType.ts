// RUST-136 增量③:TS 生产 hover 跟随 Rust 侧 `**Full Type**` 增面。
// 算法镜像 crates/kode-server/src/hover.rs 的 expand_type_token /
// full_type_of_property(FULL_TYPE_MAX_DEPTH=3 护栏同常数),输入面换成生产
// 快照:getEntityCustomTypesSnapshot 的 CustomTypeInfo 条目替代 Rust 的
// root_types_table(types.xml 声明)。对拍真源仍是 tests/kodeHoverParity.test.ts
// (语料面 golden),本模块只服务悬停渲染,不另立判定。
// 纯逻辑:无 vscode/fs 依赖,仅类型导入(自 definitionWorkspace 类型-only,
// 运行时无环;同 definitionWorkspaceXml.ts 口径)。
import type { CustomTypeInfo, CustomTypeStructureNode } from '../definitionWorkspace';

/** 展开深度护栏:≥3 按原文 token(防环/防爆炸;与 Rust 同常数) */
export const FULL_TYPE_MAX_DEPTH = 3;

export interface DefFullTypeField {
  name: string;
  /** <Type> 直接文本首 token(Rust type_name/directive 同口径) */
  directive: string;
  /** <Type> 的 <of> 元素类型(Rust of_ref) */
  ofRef: string | null;
}

export interface DefFullTypeDecl {
  kind: 'fixedDict' | 'array' | 'builtin';
  fields: DefFullTypeField[];
  element: string | null;
}

const firstToken = (value: string | null | undefined): string | null => {
  const head = (value ?? '').trim().split(/\s+/)[0];
  return head || null;
};

/** 结构树内联子元素取首 token(<of> 元素型);无该子元素为 null */
const structureChildToken = (
  structure: CustomTypeStructureNode | undefined,
  tag: string
): string | null => {
  const child = structure?.children.find(candidate => candidate.tag === tag);
  if (!child) {
    return null;
  }
  return firstToken(child.value.rawValue) ?? firstToken(child.value.name);
};

/** 声明条目 → 展开表项;FIXED_DICT 字段按原文行号还原文档序
 * (快照 parseCustomTypeProperties 按名 localeCompare 排序,与 Rust 文档序分歧) */
const toFullTypeDecl = (info: CustomTypeInfo): DefFullTypeDecl => {
  const directive = firstToken(info.structure.name) ?? firstToken(info.aliasType) ?? '';
  if (directive === 'FIXED_DICT') {
    return {
      kind: 'fixedDict',
      fields: info.properties
        .filter(property => property.typeStructure !== undefined)
        .sort((left, right) => left.line - right.line)
        .map(property => ({
          name: property.name,
          directive: firstToken(property.typeName) ?? '',
          ofRef: structureChildToken(property.typeStructure, 'of')
        })),
      element: null
    };
  }
  if (directive === 'ARRAY') {
    // 余=属性式 <of> 回落:Rust parse_types 在缺 <of> 元素时落回 `of` 属性,
    // 快照 rawValue 只并文本与渲染子元素,属性不入值 → 属性式 ARRAY 在本面
    // 展开为原文 token(不渲染 Full Type 行),如实不猜。
    return {
      kind: 'array',
      fields: [],
      element: structureChildToken(info.structure, 'of')
    };
  }
  return { kind: 'builtin', fields: [], element: null };
};

/** 根内 types.xml 声明表:alias.xml 条目不入表(Rust root_types_table 只吃
 * types_files),同名首见保留(与 BTreeMap entry/or_insert 同口径) */
export function buildDefFullTypeTable(entries: readonly CustomTypeInfo[]): Map<string, DefFullTypeDecl> {
  const table = new Map<string, DefFullTypeDecl>();
  for (const info of entries) {
    const fileName = info.filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
    if (fileName === 'alias.xml') {
      continue;
    }
    if (!table.has(info.name)) {
      table.set(info.name, toFullTypeDecl(info));
    }
  }
  return table;
}

/** FD 键字段展示:ARRAY 字段走 <of> 元素展开(无 of = `ARRAY`),
 * 其余 token 直展开(深度沿用调用方已 +1 的层)。
 * 余=对拍镜像 tests/kodeHoverParity.test.ts 的字段展开按本层 depth(Rust 为
 * depth+1),护栏层(≥3 层嵌套)前两者同值;本模块以 Rust 生产口径为准 */
function expandDefTypeField(
  table: Map<string, DefFullTypeDecl>,
  field: DefFullTypeField,
  depth: number
): string {
  if (field.directive === 'ARRAY') {
    return field.ofRef
      ? `ARRAY<${expandDefTypeToken(table, field.ofRef, depth + 1)}>`
      : 'ARRAY';
  }
  return expandDefTypeToken(table, field.directive, depth);
}

/** token 经声明表递归展开:FD → `FIXED_DICT { 名: 展示, … }`,ARRAY →
 * `ARRAY<展开>`;内建/缺席/空 FIXED_DICT/ARRAY 无 of/深度 ≥ 护栏 → 原 token */
export function expandDefTypeToken(
  table: Map<string, DefFullTypeDecl>,
  token: string,
  depth: number
): string {
  if (depth >= FULL_TYPE_MAX_DEPTH) {
    return token;
  }
  const decl = table.get(token);
  if (!decl || decl.kind === 'builtin') {
    return token;
  }
  if (decl.kind === 'array') {
    const element = decl.element;
    return element
      ? `ARRAY<${expandDefTypeToken(table, element, depth + 1)}>`
      : token;
  }
  if (decl.fields.length === 0) {
    return token;
  }
  const inner = decl.fields
    .map(field => `${field.name}: ${expandDefTypeField(table, field, depth + 1)}`)
    .join(', ');
  return `FIXED_DICT { ${inner} }`;
}

/** def 属性面:ARRAY 指引走 <of> 展开;展开=原文 → null(不渲染该行) */
export function fullTypeOfDefProperty(
  table: Map<string, DefFullTypeDecl>,
  token: string | null | undefined,
  ofRef: string | null | undefined
): string | null {
  const head = firstToken(token);
  if (!head) {
    return null;
  }
  let expanded: string | null;
  if (head === 'ARRAY') {
    const of = firstToken(ofRef);
    expanded = of ? `ARRAY<${expandDefTypeToken(table, of, 1)}>` : null;
  } else {
    expanded = expandDefTypeToken(table, head, 0);
  }
  return expanded !== null && expanded !== head ? expanded : null;
}

/** 类型声明本体面(types.xml 声明行):展开=原名 → null */
export function fullTypeOfDefDeclaration(
  table: Map<string, DefFullTypeDecl>,
  name: string
): string | null {
  const expanded = expandDefTypeToken(table, name, 0);
  return expanded === name ? null : expanded;
}

// ---- 根键控缓存:快照 entries 引用同址即复用表(悬停逐次调用不重算) ----

const EMPTY_TABLE: Map<string, DefFullTypeDecl> = Object.freeze(new Map());

interface TableSlot {
  entries: readonly CustomTypeInfo[];
  table: Map<string, DefFullTypeDecl>;
}

const tableSlots = new Map<string, TableSlot>();

/** 按工作区根取展开表;entries 引用换代(快照重建)即重算 */
export function defFullTypeTable(
  workspaceRoot: string,
  entries: readonly CustomTypeInfo[]
): Map<string, DefFullTypeDecl> {
  if (!workspaceRoot) {
    return EMPTY_TABLE;
  }
  const slot = tableSlots.get(workspaceRoot);
  if (slot && slot.entries === entries) {
    return slot.table;
  }
  const table = buildDefFullTypeTable(entries);
  tableSlots.set(workspaceRoot, { entries, table });
  return table;
}

/** 测试收尾:清根键控表缓存(防跨用例引用残留) */
export function resetDefFullTypeTables(): void {
  tableSlots.clear();
}
