/**
 * 引擎标量族真源(KSEM-SER-10 自 CELL-08 cellDataWriteCheck 抽出为纯模块)。
 *
 * 数据源 = datatypes.cpp `DataTypes::initialize` 注册表,与 kbengineMetadata
 * 同源:整数标量带宽与符号定范围;FLOAT/DOUBLE 数值;STRING/UNICODE 字符串;
 * BLOB 字节流;VECTOR2/3/4 定长数值向量;PYTHON 与 PY_DICT/PY_TUPLE/PY_LIST/
 * ENTITYCALL 收 Python 对象面不查;ARRAY/FIXED_DICT/types.xml 自定义别名
 * 结构未知 → 不查(诚实)。
 *
 * 零 vscode 依赖(cellDataWriteCheck 经 nlsRuntime 间接依赖 vscode,序列化
 * schema 车道 SER-08/SER-10 的纯核心不能拖该依赖图,故表住这里,消费方
 * 各自 import;CELL-08 行为零变化)。
 */

/** 引擎标量族(datatypes.cpp 注册表;范围=带宽与符号的封闭区间)。 */
export interface ScalarFamily {
  /** 值类:integer 标量(int/bool 可入)/float 标量/字符串/字节流/定长向量。 */
  kind: 'integer' | 'float' | 'str' | 'bytes' | 'vector';
  /** integer 族范围(BigInt 精确边界;缺省=不设界)。 */
  min?: bigint;
  max?: bigint;
  /** vector 族元数。 */
  arity?: number;
  /** 提示文案里的期望段(`UINT16 (int 0..65535)`)。 */
  label: string;
}

/** 引擎标量类型表;不在表内的类型(PYTHON 族、ARRAY、FIXED_DICT、自定义别名)不查。 */
// 范围界一律 BigInt()(tsconfig target < ES2020 禁字面量 0n;64 位界以字符串
// 入参保精度),写入值同以 BigInt 精确解析——边界判定无 double 取整死区。
export const SCALAR_FAMILIES: ReadonlyMap<string, ScalarFamily> = new Map([
  ['UINT8', { kind: 'integer', min: BigInt(0), max: BigInt(255), label: 'UINT8 (int 0..255)' }],
  ['UINT16', { kind: 'integer', min: BigInt(0), max: BigInt(65535), label: 'UINT16 (int 0..65535)' }],
  ['UINT32', { kind: 'integer', min: BigInt(0), max: BigInt(4294967295), label: 'UINT32 (int 0..4294967295)' }],
  ['UINT64', { kind: 'integer', min: BigInt(0), max: BigInt('18446744073709551615'), label: 'UINT64 (int 0..2^64-1)' }],
  ['INT8', { kind: 'integer', min: BigInt(-128), max: BigInt(127), label: 'INT8 (int -128..127)' }],
  ['INT16', { kind: 'integer', min: BigInt(-32768), max: BigInt(32767), label: 'INT16 (int -32768..32767)' }],
  ['INT32', { kind: 'integer', min: BigInt(-2147483648), max: BigInt(2147483647), label: 'INT32 (int -2^31..2^31-1)' }],
  ['INT64', { kind: 'integer', min: BigInt('-9223372036854775808'), max: BigInt('9223372036854775807'), label: 'INT64 (int -2^63..2^63-1)' }],
  ['FLOAT', { kind: 'float', label: 'FLOAT (number)' }],
  ['DOUBLE', { kind: 'float', label: 'DOUBLE (number)' }],
  ['STRING', { kind: 'str', label: 'STRING (str)' }],
  ['UNICODE', { kind: 'str', label: 'UNICODE (str)' }],
  ['BLOB', { kind: 'bytes', label: 'BLOB (bytes)' }],
  ['VECTOR2', { kind: 'vector', arity: 2, label: 'VECTOR2 (2-number sequence)' }],
  ['VECTOR3', { kind: 'vector', arity: 3, label: 'VECTOR3 (3-number sequence)' }],
  ['VECTOR4', { kind: 'vector', arity: 4, label: 'VECTOR4 (4-number sequence)' }]
]);
