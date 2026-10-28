import { describe, expect, it } from 'vitest';
import { parseLocalDefinition } from '../src/definitionSemantics';
import type { DefTreeSource } from '../src/messageTable';
import { buildMessageTable } from '../src/messageTable';
import { listClientSdkBuiltinTypeNames } from '../src/clientSdkGenerator';
import {
  AUDITED_PRIMITIVE_LOAD_ORDER,
  listPrimitivesMissingFromSdk,
  SDK_MESSAGE_NUMBER_AUDIT_VERSION,
  verifyPrimitiveUtypeOrderAgainstAudit
} from '../src/sdkMessageNumberAudit';

// IDE-SDK-005 对拍一个真实引擎版本的消息编号:以 kbengine@f85ad81 的
// DataTypes::initialize 真实装载序(addDataType 调用序,utype=DataType
// 构造 _g_dataTypeUID++ 从 1)核对 kode 消息表的基元 utype 产出与 SDK
// 类型映射覆盖面;差异逐条点名;SDK 未映射的类型如实点名保留边界,
// 不假装支持。

function createSource(files: Record<string, string>): DefTreeSource {
  return {
    loadDef(name, kind) {
      const content = files[`${kind}:${name}`];
      if (content === undefined) {
        return null;
      }
      return parseLocalDefinition(content, kind, name, `/defs/${kind}s/${name}.def`);
    }
  };
}

/** 真实生产面:buildMessageTable 产出的基元条目(kind='primitive') */
function productionPrimitives(): Array<{ name: string; utype: number }> {
  const table = buildMessageTable('E', createSource({ 'entity:E': '<root></root>' }))!;
  return table.types
    .filter(entry => entry.kind === 'primitive')
    .map(entry => ({ name: entry.name, utype: entry.utype }));
}

describe('审计面自身(f85ad81 实读装载序)', () => {
  it('登记目标版本与源码依据', () => {
    expect(SDK_MESSAGE_NUMBER_AUDIT_VERSION.commit).toBe('f85ad81');
    expect(SDK_MESSAGE_NUMBER_AUDIT_VERSION.source).toContain('datatypes.cpp');
  });

  it('装载序 21 条,utype 1..21 连续无跳号', () => {
    expect(AUDITED_PRIMITIVE_LOAD_ORDER).toHaveLength(21);
    expect(AUDITED_PRIMITIVE_LOAD_ORDER.map(([, utype]) => utype)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1)
    );
  });
});

describe('verifyPrimitiveUtypeOrderAgainstAudit(消息表基元产出对拍)', () => {
  it('生产基元面与真实装载序逐条一致(ok)', () => {
    const verdict = verifyPrimitiveUtypeOrderAgainstAudit(productionPrimitives());
    expect(verdict.ok).toBe(true);
    expect(verdict.mismatches).toEqual([]);
  });

  it('缺一个基元 → 点名缺(按审计序)', () => {
    const verdict = verifyPrimitiveUtypeOrderAgainstAudit(
      productionPrimitives().filter(entry => entry.name !== 'VECTOR4')
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches).toEqual(['缺 VECTOR4(审计:utype 21)']);
  });

  it('多出未知基元 → 点名多', () => {
    const verdict = verifyPrimitiveUtypeOrderAgainstAudit([
      ...productionPrimitives(),
      { name: 'FAKE', utype: 22 }
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches.some(line => line.includes('FAKE'))).toBe(true);
  });

  it('错号 → 点名生产值与审计值', () => {
    const verdict = verifyPrimitiveUtypeOrderAgainstAudit(
      productionPrimitives().map(entry => (entry.name === 'STRING' ? { ...entry, utype: 10 } : entry))
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches).toEqual(['STRING utype 不符:生产 10 vs 审计 9']);
  });
});

describe('listPrimitivesMissingFromSdk(SDK 映射覆盖面,未映射如实保留)', () => {
  it('SDK 全 21 基元已映射 → 空清单', () => {
    expect(listPrimitivesMissingFromSdk(AUDITED_PRIMITIVE_LOAD_ORDER, listClientSdkBuiltinTypeNames()))
      .toEqual([]);
  });

  it('映射子集 → 未映射的逐个点名(边界保留,不假装支持)', () => {
    const missing = listPrimitivesMissingFromSdk(AUDITED_PRIMITIVE_LOAD_ORDER, ['UINT8', 'STRING']);
    expect(missing).toEqual([
      'UINT16', 'UINT64', 'UINT32', 'INT8', 'INT16', 'INT32', 'INT64',
      'UNICODE', 'FLOAT', 'DOUBLE', 'PYTHON', 'PY_DICT', 'PY_TUPLE',
      'PY_LIST', 'ENTITYCALL', 'BLOB', 'VECTOR2', 'VECTOR3', 'VECTOR4'
    ]);
  });
});
