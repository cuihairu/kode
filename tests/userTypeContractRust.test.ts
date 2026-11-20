import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import {
  collectUserTypeContractMissingByImplFileFromRust,
  type RustUserTypeContractMissingItem
} from '../src/backend/userTypeContractRust';
import type { UserTypeContractStatus } from '../src/backend/userTypeContract';

// user_type 三契约探测/收集收编 Rust(RUST-MIGRATION-AUDIT-006 B1 车道批 4):
// collectUserTypeContractMissingByImplFileFromRust 主路径经
// `$/kode/python/userTypeContract` 调 Rust 探测/收集核。测试用假 gate
// (setKodeCoreShadowGate),断言重点=精确方法名 + params 闭包 {file,
// sources, statuses 剥 methods} + 无绑定本文件合法空面零 RPC + 整面弃用
// 纪律:无门/RPC 失败/items 非数组/条目畸形(message 非串/method 越三方法/
// typeName/symbolName 非串/symbolLength 或 line 非非负整数/related 缺或非双
// 串)一律 null → 调用方回 TS collectUserTypeContractMissingByImplFile 兜底,
// 禁止部分采用。

const COMPLETE_IMPL = [
  'class TalentTreeImpl:',
  '    def createObjFromDict(self, dictData):',
  '        return dictData',
  '    def getDictFromObj(self, obj):',
  '        return {}',
  '    def isSameType(self, obj):',
  '        return True'
].join('\n');

const NO_IS_SAME_IMPL = COMPLETE_IMPL
  .split('\n')
  .filter(line => !line.includes('isSameType'))
  .join('\n');

let root = '';
let implFile = '';
let otherImplFile = '';

const statusOf = (overrides: Partial<UserTypeContractStatus>): UserTypeContractStatus => ({
  name: 'TalentTree',
  implementedBy: 'talent.TalentTreeImpl',
  implFile,
  implLine: 7,
  methods: { createObjFromDict: true, getDictFromObj: true, isSameType: false },
  ...overrides
});

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-utcr-contract-'));
  implFile = path.join(root, 'impl.py');
  otherImplFile = path.join(root, 'other.py');
  fs.writeFileSync(implFile, NO_IS_SAME_IMPL, 'utf8');
  fs.writeFileSync(otherImplFile, COMPLETE_IMPL, 'utf8');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('collectUserTypeContractMissingByImplFileFromRust(契约收集 Rust 主路径契约)', () => {
  it('Rust 在场:精确方法名 + params {file, sources, statuses 剥 methods},items 直传', async () => {
    let calledMethod = '';
    let calledParams: Record<string, unknown> | null = null;
    const rustItems: RustUserTypeContractMissingItem[] = [
      {
        message: 'rust-rendered message',
        method: 'isSameType',
        typeName: 'TalentTree',
        symbolName: 'TalentTreeImpl',
        symbolLength: 14,
        line: 7,
        related: { targetFile: implFile, label: '实现文件 impl.py' }
      }
    ];
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        calledMethod = method;
        calledParams = params as Record<string, unknown>;
        return { ok: true, result: { items: rustItems } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const statuses = [
        statusOf({}),
        statusOf({ name: 'Other', implFile: otherImplFile, implLine: 1 })
      ];
      const items = await collectUserTypeContractMissingByImplFileFromRust(
        statuses,
        implFile
      );
      expect(items).toEqual(rustItems);
      expect(calledMethod).toBe('$/kode/python/userTypeContract');
      expect(calledParams).toEqual({
        file: implFile,
        sources: {
          [implFile]: NO_IS_SAME_IMPL,
          [otherImplFile]: COMPLETE_IMPL
        },
        statuses: [
          {
            name: 'TalentTree',
            implementedBy: 'talent.TalentTreeImpl',
            implFile,
            implLine: 7
          },
          {
            name: 'Other',
            implementedBy: 'talent.TalentTreeImpl',
            implFile: otherImplFile,
            implLine: 1
          }
        ]
      });
      expect(JSON.stringify(calledParams)).not.toContain('methods');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('无 gate → null(不发 RPC)', async () => {
    setKodeCoreShadowGate(null);
    expect(
      await collectUserTypeContractMissingByImplFileFromRust([statusOf({})], implFile)
    ).toBeNull();
  });

  it('无绑定目标文件的 status:合法空面 [](不空发 RPC)', async () => {
    let rpcCalls = 0;
    const fakeGate = {
      runInRust: async () => {
        rpcCalls += 1;
        return { ok: true, result: { items: [] } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const statuses = [statusOf({ implFile: otherImplFile })];
      expect(
        await collectUserTypeContractMissingByImplFileFromRust(statuses, implFile)
      ).toEqual([]);
      expect(rpcCalls).toBe(0);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('RPC 失败(ok:false)→ null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false as const, reason: 'boom' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      expect(
        await collectUserTypeContractMissingByImplFileFromRust([statusOf({})], implFile)
      ).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('形状畸形整面弃用:非数组/条目非对象/字段缺失或越型', async () => {
    const malformed = [
      { result: {} },
      { result: { items: 'nope' } },
      { result: { items: ['not-an-object'] } },
      { result: { items: [{ method: 'isSameType' }] } },
      { result: { items: [{ message: 'm', method: 'unknownMethod' }] } },
      {
        result: {
          items: [
            {
              message: 'm',
              method: 'isSameType',
              typeName: 'T',
              symbolName: 'S',
              symbolLength: -1,
              line: 1,
              related: { targetFile: 'a', label: 'b' }
            }
          ]
        }
      },
      {
        result: {
          items: [
            {
              message: 'm',
              method: 'isSameType',
              typeName: 'T',
              symbolName: 'S',
              symbolLength: 1.5,
              line: 1,
              related: { targetFile: 'a', label: 'b' }
            }
          ]
        }
      },
      {
        result: {
          items: [
            {
              message: 'm',
              method: 'isSameType',
              typeName: 'T',
              symbolName: 'S',
              symbolLength: 1,
              related: { targetFile: 'a', label: 'b' }
            }
          ]
        }
      },
      {
        result: {
          items: [
            {
              message: 'm',
              method: 'isSameType',
              typeName: 'T',
              symbolName: 'S',
              symbolLength: 1,
              line: 1
            }
          ]
        }
      },
      {
        result: {
          items: [
            {
              message: 'm',
              method: 'isSameType',
              typeName: 'T',
              symbolName: 'S',
              symbolLength: 1,
              line: 1,
              related: { targetFile: 'a' }
            }
          ]
        }
      }
    ];
    for (const result of malformed) {
      const fakeGate = {
        runInRust: async () => ({ ok: true, result })
      } as unknown as KodeCoreGate;
      setKodeCoreShadowGate(fakeGate);
      try {
        const items = await collectUserTypeContractMissingByImplFileFromRust(
          [statusOf({})],
          implFile
        );
        expect(items, `畸形应弃用: ${JSON.stringify(result)}`).toBeNull();
      } finally {
        setKodeCoreShadowGate(null);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 批 27:形状闸补齐臂——line 非整数/负数、typeName/symbolName 非串、related
// 非对象。既有畸形清单已盖 message/method/symbolLength/related 双串缺项。
// ---------------------------------------------------------------------------
describe('批 27:形状闸补齐臂', () => {
  const baseItem = (over: Record<string, unknown>): Record<string, unknown> => ({
    message: 'm',
    method: 'isSameType',
    typeName: 'T',
    symbolName: 'S',
    symbolLength: 1,
    line: 1,
    related: { targetFile: 'a', label: 'b' },
    ...over
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ['line 非整数', baseItem({ line: 1.5 })],
    ['line 负数', baseItem({ line: -1 })],
    ['line 非数值', baseItem({ line: '1' })],
    ['typeName 非串', baseItem({ typeName: 1 })],
    ['symbolName 非串', baseItem({ symbolName: null })],
    ['related 为 null', baseItem({ related: null })],
    ['related 为原始值', baseItem({ related: 'x' })]
  ];

  for (const [label, item] of cases) {
    it(`${label} → 整面弃用 null`, async () => {
      const fakeGate = {
        runInRust: async () => ({ ok: true, result: { items: [item] } })
      } as unknown as KodeCoreGate;
      setKodeCoreShadowGate(fakeGate);
      try {
        const items = await collectUserTypeContractMissingByImplFileFromRust(
          [statusOf({})],
          implFile
        );
        expect(items, `${label} 应弃用`).toBeNull();
      } finally {
        setKodeCoreShadowGate(null);
      }
    });
  }
});

describe('批 27 续:五臂显式补齐', () => {
  const baseItem = (over: Record<string, unknown>): Record<string, unknown> => ({
    message: 'm',
    method: 'isSameType',
    typeName: 'T',
    symbolName: 'S',
    symbolLength: 1,
    line: 1,
    related: { targetFile: 'a', label: 'b' },
    ...over
  });

  const cases: Array<[string, unknown[]]> = [
    ['条目为原始串', ['not-an-object']],
    ['message 非串', [baseItem({ message: 9 })]],
    ['method 越三方法', [baseItem({ method: 'nope' })]],
    ['method 非串', [baseItem({ method: 3 })]],
    ['symbolLength 非数值', [baseItem({ symbolLength: 'x' })]],
    ['related.targetFile 非串', [baseItem({ related: { targetFile: 1, label: 'b' } })]],
    ['related.label 缺失', [baseItem({ related: { targetFile: 'a' } })]]
  ];

  for (const [label, items] of cases) {
    it(`${label} → null`, async () => {
      const fakeGate = {
        runInRust: async () => ({ ok: true, result: { items } })
      } as unknown as KodeCoreGate;
      setKodeCoreShadowGate(fakeGate);
      try {
        expect(
          await collectUserTypeContractMissingByImplFileFromRust([statusOf({})], implFile)
        ).toBeNull();
      } finally {
        setKodeCoreShadowGate(null);
      }
    });
  }
});
