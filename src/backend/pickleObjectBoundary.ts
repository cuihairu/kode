/**
 * KSEM-SER-11:pickle/PYTHON 边界(纯核心,零 vscode 依赖,零执行)。
 *
 * 引擎口径(SER-01 §3 / SER-02 §3 / wire golden):PYTHON/PY_DICT/PY_TUPLE/
 * PY_LIST 四族走 CPython pickle 字节透传(datatype.cpp:1225-1242/:1288-1296/
 * :1344-1352/:1400-1408,DB 落 BLOB 列 entity_table_mysql.cpp:699-711)——
 * pickle 桶不透明,无字段结构可静态展开。
 *
 * 三条验收(todo.md):
 * ① 保留已有对象类型可传递证据:边界闸对 implementedBy 对象类型(STRUCT-07:
 *    内存形式=实现类)、非 impl FIXED_DICT/FixedArray 键位面全数放行;
 *    GEN-DEF-1c <Default> 字面量精化(def 声明、引擎 Py_eval_input 求值)
 *    经 pickleObjectEvidence 透传——这是 pickle 桶唯一合法的结构侧证据,
 *    证据来自 def 注册声明,不是运行时反序列化产物。
 * ② 不把裸 PYTHON 当 FIXED_DICT:引擎族名优先于同名自定义类型注册,
 *    pickle 桶恒零字段/键位声称(structureClaimGate 铁面)。
 * ③ 不执行反序列化不可信数据来推断:scanPickleDeserialization 纯静态识别
 *    项目码 pickle.loads/cPickle.loads 调用形态(import 证据绑定、掩码行,
 *    与 json 链同纪律),结构声称恒空且类型层不可能产出(never[])——
 *    pickle 无 schema 绑定机制,与 json.loads(SER-10:经
 *    .kbengine/serialization.json 绑定才有声称)相反;本模块零子进程、
 *    零动态求值,任何反序列化执行都不存在。
 */

import type { CustomTypeInfo } from '../definitionWorkspace';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';
import { SCALAR_FAMILIES } from './scalarFamilies';
import { PYTHON_FAMILY_BASE, inferPythonLiteralAnnotation } from './pythonLiteralTypes';
import { pythonCodeLines } from './pythonParser';

// ---------------------------------------------------------------------------
// pickle 桶内存形式登记(SER-02 §3 解码产物;单一真源=GEN-DEF-1c 基类表)
// ---------------------------------------------------------------------------

/** pickle 桶内存形式:PYTHON=任意 PyObject,PY_DICT/PY_TUPLE/PY_LIST=dict/tuple/list。 */
export type PickleMemoryForm = 'any' | 'dict' | 'tuple' | 'list';

/** 基类注解串 → 内存形式(PYTHON_FAMILY_BASE 值域归一,不自造第二套族表)。 */
const MEMORY_FORM_BY_ANNOTATION: Readonly<Record<string, PickleMemoryForm>> = {
  Any: 'any',
  dict: 'dict',
  tuple: 'tuple',
  list: 'list'
};

/** 引擎 pickle 族名 → 内存形式;非族名(大小写不同/未注册)→ null。 */
export function pickleFamilyMemoryFormOf(typeName: string): PickleMemoryForm | null {
  const base = PYTHON_FAMILY_BASE[typeName];
  return base === undefined ? null : (MEMORY_FORM_BY_ANNOTATION[base] ?? null);
}

// ---------------------------------------------------------------------------
// pickle 桶对象证据(GEN-DEF-1c 声明精化透传,验收①)
// ---------------------------------------------------------------------------

/** pickle 桶对象证据:内存形式 + def 声明精化注解 + 零字段声称标记。 */
export interface PickleObjectEvidence {
  kind: 'pickleOpaque';
  memoryForm: PickleMemoryForm;
  /** GEN-DEF-1c:无 Default/解析失败/None/基类形态不符 → 基类注解
   * (Any/dict/tuple/list);有合法字面量 → 精确注解。既有面原样透传。 */
  declaredAnnotation: string;
  /** 字段结构声称:恒 none——pickle 桶无键位面(验收②)。 */
  fieldClaims: 'none';
}

/** 仅 pickle 桶族返回证据;非族名 → null(闸路由到别类证据面)。 */
export function pickleObjectEvidence(
  typeName: string,
  defaultValue?: string
): PickleObjectEvidence | null {
  const memoryForm = pickleFamilyMemoryFormOf(typeName);
  if (memoryForm === null) {
    return null;
  }
  return {
    kind: 'pickleOpaque',
    memoryForm,
    declaredAnnotation: inferPythonLiteralAnnotation(defaultValue, typeName),
    fieldClaims: 'none'
  };
}

// ---------------------------------------------------------------------------
// 结构声称边界闸(验收②铁面:裸 PYTHON 恒不落 FIXED_DICT 类声称)
// ---------------------------------------------------------------------------

/** def 属性类型标签 → 允许的声称面。各面消费前先过闸;pickle 桶恒零声称。 */
export type StructureClaimGate =
  | { kind: 'pickleOpaque'; memoryForm: PickleMemoryForm; fieldClaims: 'none' }
  | { kind: 'object'; info: CustomTypeInfo }
  | { kind: 'fixedDict'; info: CustomTypeInfo }
  | { kind: 'array'; element: CustomTypeInfo | null }
  | { kind: 'scalar' }
  | { kind: 'unknown' };

const FIXED_ARRAY_ANNOTATION = /^FixedArray\[(.+)\]$/;

/**
 * 边界闸:typeLabel(def 属性 <Type> 文本或代码注解名)+ 自定义类型注册 →
 * 该类型允许的声称面。判定序:
 * 1. 引擎 pickle 族名优先——同名自定义类型注册不能给 pickle 桶结构(验收②);
 * 2. FIXED_DICT 别名:implementedBy → object(STRUCT-07:内存形式=实现类,
 *    Properties 键位=传输形式,对象契约面放行);非 impl → fixedDict(键位面接管);
 * 3. FixedArray[X]:元素须非 impl FD 才给元素结构(与
 *    fixedDictSubscript.chainStateFromAnnotation 同口径);其余 element null
 *    (容器是数组,元素面诚实断链);
 * 4. 引擎标量(SCALAR_FAMILIES 真源)→ scalar;
 * 5. 其余(VECTOR/BLOB/ENTITYCALL/未注册/畸形)→ unknown:本闸零声称,
 *    各车道(VISUAL/pyi/调用图)自有自己的面。
 */
export function structureClaimGate(
  typeLabel: string,
  customTypes: readonly CustomTypeInfo[]
): StructureClaimGate {
  const trimmed = typeLabel.trim();
  const memoryForm = pickleFamilyMemoryFormOf(trimmed);
  if (memoryForm !== null) {
    return { kind: 'pickleOpaque', memoryForm, fieldClaims: 'none' };
  }
  const info = customTypes.find(candidate => candidate.name === trimmed);
  if (info && info.aliasType === FIXED_DICT_TYPE_NAME) {
    return info.implementedBy
      ? { kind: 'object', info }
      : { kind: 'fixedDict', info };
  }
  const array = FIXED_ARRAY_ANNOTATION.exec(trimmed);
  if (array) {
    const element = customTypes.find(
      candidate =>
        candidate.name === array[1] &&
        candidate.aliasType === FIXED_DICT_TYPE_NAME &&
        !candidate.implementedBy
    ) ?? null;
    return { kind: 'array', element };
  }
  if (SCALAR_FAMILIES.has(trimmed)) {
    return { kind: 'scalar' };
  }
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// 项目码 pickle 反序列化零声称扫描(验收③:识别形态,声称恒零)
// ---------------------------------------------------------------------------

/** 识别到的反序列化直接调用点(import 证据成立、模块作用域、掩码行)。 */
export interface PickleDeserializationScan {
  /** 计数面:模块面顶层直接调用形态(`alias.loads(…)` / 绑定裸名/别名
   * `loads(…)`,简单名/下标目标赋值形或语句形)。计数只为证明「形态可识别
   * 而声称恒零」的对照面;引用/callback(`map(pickle.loads, xs)`)、函数体内
   * 调用、未绑定接收者(`obj.loads`)、序列化方向(`dumps`)、属性目标/
   * 增量赋值形态(`self.x = loads(…)` / `s += loads(…)`,json 链同界)不属
   * 反序列化调用点。 */
  recognizedCalls: number;
  /** 结构声称:恒空,类型层即不可能产出(never[])——pickle 无 schema 绑定
   * 机制,调用点可数而结构不可推(对照 json.loads:SER-10 schema 命中才声称)。 */
  readonly structureClaims: readonly never[];
}

interface BindingFlags {
  from: number;
  killed: boolean;
}

/**
 * 纯静态扫描项目码的 pickle 反序列化调用形态(与 json 链同纪律:掩码行、
 * import 证据绑定、绑定名重绑即死、def/class 体不入模块面)。零执行:
 * 不跑 Python、不读 pickle 字节、不求值任何表达式——调用点数得出,
 * 结构永远数不出。
 */
export function scanPickleDeserialization(text: string): PickleDeserializationScan {
  const masked = pythonCodeLines(text);
  const attrModules = new Map<string, BindingFlags>(); // import pickle/cPickle [as X]
  const bareLoads = new Map<string, BindingFlags>(); // from pickle/cPickle import … loads [as X]
  const bound = (
    table: ReadonlyMap<string, BindingFlags>,
    name: string,
    line: number
  ): boolean => {
    const flag = table.get(name);
    return flag !== undefined && !flag.killed && flag.from <= line;
  };
  let recognizedCalls = 0;
  let line = 0;
  while (line < masked.length) {
    const m = masked[line] ?? '';
    if (m.trim().length === 0) {
      line += 1;
      continue;
    }
    const trimmed = m.trim();
    if (/^(async\s+)?(def|class)\s/.test(trimmed)) {
      line += 1;
      continue;
    }
    // ── import 证据(模块面;函数体内 import 不入)──
    const impAttr = /^import\s+(pickle|cPickle)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(trimmed);
    if (impAttr) {
      attrModules.set(impAttr[2] ?? impAttr[1], { from: line, killed: false });
      line += 1;
      continue;
    }
    const impFrom = /^from\s+(pickle|cPickle)\s+import\s+(.+)$/.exec(trimmed);
    if (impFrom) {
      let itemsText = impFrom[2];
      let endLine = line;
      if (itemsText.includes('(') && !itemsText.includes(')')) {
        // 括号续行:收整到闭括号行(有界 8 行;未闭 → 无绑定诚实)
        let closed = false;
        while (!closed && endLine - line < 8) {
          endLine += 1;
          const nextLine = masked[endLine] ?? '';
          itemsText += ` ${nextLine.trim()}`;
          if (nextLine.includes(')')) {
            closed = true;
          }
        }
        if (!closed) {
          line += 1;
          continue;
        }
        itemsText = itemsText.slice(itemsText.indexOf('(') + 1, itemsText.lastIndexOf(')'));
      }
      for (const itemRaw of itemsText.split(',')) {
        const item = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(itemRaw.trim());
        if (!item) {
          continue;
        }
        if (item[1] === 'loads') {
          bareLoads.set(item[2] ?? 'loads', { from: line, killed: false });
        }
      }
      line = endLine + 1;
      continue;
    }
    // ── 绑定名重绑即死(绑定证据不再成立;多目标一并)──
    const assignHead =
      /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::[^=]*?)?=(?![=>])/.exec(trimmed);
    if (assignHead) {
      for (const piece of assignHead[1].split(',')) {
        const name = piece.trim();
        const a = attrModules.get(name);
        if (a) {
          a.killed = true;
        }
        const b = bareLoads.get(name);
        if (b) {
          b.killed = true;
        }
      }
    }
    // ── 调用识别(顶层赋值形/语句形;计数不受实参形态影响)──
    const callAt =
      /^(?:([A-Za-z_]\w*(?:\s*\[[^\]=]*\])?)\s*(?::[^=]*?)?=\s*(?![=>]))?(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/.exec(
        trimmed
      );
    if (callAt) {
      const [, , attr, fn] = callAt;
      const isDeserialization =
        attr !== undefined
          ? fn === 'loads' && bound(attrModules, attr, line)
          : bound(bareLoads, fn, line);
      if (isDeserialization) {
        recognizedCalls += 1;
      }
    }
    line += 1;
  }
  return { recognizedCalls, structureClaims: [] };
}
