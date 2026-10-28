/**
 * 对拍一个真实引擎版本的消息编号(IDE-SDK-005):以 kbengine@f85ad81 的
 * DataTypes::initialize 真实装载序(kbe/src/lib/entitydef/datatypes.cpp
 * addDataType 调用序;utype 由 DataType 构造函数 _g_dataTypeUID++ 分配,
 * 初值 1,datatype.cpp L87-92)核对 kode 两侧——消息表的基元 utype 产出
 * (buildMessageTable types 面 kind='primitive' 条目)与 SDK 生成器的内置
 * 类型映射覆盖面。差异逐条点名;SDK 未映射的基元如实点名保留边界,不
 * 假装支持。与 LIV-002 watcherProtocolAudit 同模式:审计表钉源码,生产
 * 面漂移测试即红。
 */

/** 对拍所用目标版本(引擎仓与文件,登记面 LIV-001 的 engineVersion 对齐) */
export const SDK_MESSAGE_NUMBER_AUDIT_VERSION = {
  repoUrl: 'https://github.com/kbengine/kbengine',
  commit: 'f85ad81',
  source: 'kbe/src/lib/entitydef/datatypes.cpp DataTypes::initialize(addDataType 调用序)'
};

/** f85ad81 实读装载序:21 条 [类型名, utype](utype=装载位置,1 起) */
export const AUDITED_PRIMITIVE_LOAD_ORDER: ReadonlyArray<readonly [string, number]> = [
  ['UINT8', 1],
  ['UINT16', 2],
  ['UINT64', 3],
  ['UINT32', 4],
  ['INT8', 5],
  ['INT16', 6],
  ['INT32', 7],
  ['INT64', 8],
  ['STRING', 9],
  ['UNICODE', 10],
  ['FLOAT', 11],
  ['DOUBLE', 12],
  ['PYTHON', 13],
  ['PY_DICT', 14],
  ['PY_TUPLE', 15],
  ['PY_LIST', 16],
  ['ENTITYCALL', 17],
  ['BLOB', 18],
  ['VECTOR2', 19],
  ['VECTOR3', 20],
  ['VECTOR4', 21]
];

export interface SdkMessageNumberVerifyVerdict {
  ok: boolean;
  mismatches: string[];
}

/** 消息表基元产出 ↔ 审计装载序逐条咬合:缺名/多名/错号都点名 */
export function verifyPrimitiveUtypeOrderAgainstAudit(
  actualPrimitives: ReadonlyArray<{ name: string; utype: number }>
): SdkMessageNumberVerifyVerdict {
  const mismatches: string[] = [];
  const actualByName = new Map(actualPrimitives.map(entry => [entry.name, entry.utype]));
  for (const [name, utype] of AUDITED_PRIMITIVE_LOAD_ORDER) {
    const actualUtype = actualByName.get(name);
    if (actualUtype === undefined) {
      mismatches.push(`缺 ${name}(审计:utype ${utype})`);
    } else if (actualUtype !== utype) {
      mismatches.push(`${name} utype 不符:生产 ${actualUtype} vs 审计 ${utype}`);
    }
  }
  for (const entry of actualPrimitives) {
    if (!AUDITED_PRIMITIVE_LOAD_ORDER.some(([name]) => name === entry.name)) {
      mismatches.push(`多出审计外基元 ${entry.name}(utype ${entry.utype})`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** 装载序中 SDK 映射未覆盖的基元名(按审计序):边界如实保留,非失败 */
export function listPrimitivesMissingFromSdk(
  auditedOrder: ReadonlyArray<readonly [string, number]>,
  sdkMappedNames: ReadonlyArray<string>
): string[] {
  const mapped = new Set(sdkMappedNames);
  return auditedOrder.map(([name]) => name).filter(name => !mapped.has(name));
}
