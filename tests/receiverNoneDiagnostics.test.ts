import { describe, expect, it } from 'vitest';

import {
  computeReceiverNoneFindings,
  receiverNoneDiagnosticItems
} from '../src/receiverNoneDiagnostics';
import type { EntityMapping } from '../src/entityMapping';

// receiver 可能为 None 诊断(用户令 2026-10-27 任务1):self.client/self.cell/
// self.base 无判空 guard 引用报 Warning;.def 段错配同源可报;开关默认开可关。
// 四例面:guard / 无 guard / 段错配 / 开关关。

const py = (body: string[]): string => body.join('\n');

/** 最小 EntityMapping 桩:只喂 sectionMismatch 用到的 methods 表 */
const mappingWithMethods = (
  methods: Record<string, Array<{ section: string }>>
): EntityMapping => ({
  methods: Object.fromEntries(
    Object.entries(methods).map(([name, defs]) => [
      name,
      defs.map(def => ({
        defFile: 'avatar.def',
        line: 1,
        section: def.section,
        exposed: false,
        identity: {
          ownerKind: 'method' as never,
          ownerName: 'Avatar',
          sourceKind: 'def' as never,
          sourceChain: [],
          symbolName: name
        }
      }))
    ])
  )
}) as unknown as EntityMapping;

describe('receiver 可能为 None 诊断(用户令 2026-10-27 任务1)', () => {
  it('有判空 guard(正向 if / is not None / 早退 / 别名)不报', () => {
    const guarded = py([
      'class Avatar:',
      '    def onTick(self):',
      '        if self.cell:',
      '            self.cell.tick()',
      '',
      '    def onSend(self):',
      '        if self.base is not None:',
      '            self.base.notify()',
      '',
      '    def onGuard(self):',
      '        if self.client is None:',
      '            return',
      '        self.client.show()',
      '',
      '    def onAlias(self):',
      '        cell = self.cell',
      '        if cell:',
      '            cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(guarded, '/avatar.py')).toEqual([]);
  });

  it('无 guard 引用报 receiver-none Warning,消息带引擎源码与场景', () => {
    const unguarded = py([
      'class Avatar:',
      '    def onTick(self):',
      '        self.cell.tick()',
      ''
    ]);
    const findings = computeReceiverNoneFindings(unguarded, '/avatar.py');
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('receiver-none');
    expect(findings[0].line).toBe(2);
    expect(findings[0].receiver).toBe('cell');
    expect(findings[0].methodName).toBe('tick');
    expect(findings[0].message).toContain('self.cell 可能为 None');
    expect(findings[0].message).toContain('server/baseapp/entity.cpp:750');

    // 诊断项面:Warning + source=kbengine + range 锚在方法名 token
    const items = receiverNoneDiagnosticItems(unguarded, '/avatar.py', undefined, true);
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('Warning');
    expect(items[0].source).toBe('kbengine');
    expect(items[0].range.start).toEqual({ line: 2, character: 18 });
    expect(items[0].range.end).toEqual({ line: 2, character: 22 });
  });

  it('.def 段错配:方法声明于 BaseMethods 却经 self.cell 调用,报段错配', () => {
    const mismatched = py([
      'class Avatar:',
      '    def onTick(self):',
      '        self.cell.tick()',
      ''
    ]);
    const mapping = mappingWithMethods({ tick: [{ section: 'BaseMethods' }] });
    const findings = computeReceiverNoneFindings(mismatched, '/avatar.py', mapping);
    // 无 guard 的 receiver-none 与段错配各一条
    const mismatch = findings.filter(finding => finding.kind === 'section-mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].message).toContain('段错配');
    expect(mismatch[0].message).toContain('BaseMethods');
    expect(mismatch[0].message).toContain('CellMethods');
    // 声明于 CellMethods(对应段)时不错配
    const aligned = mappingWithMethods({ tick: [{ section: 'CellMethods' }] });
    expect(
      computeReceiverNoneFindings(mismatched, '/avatar.py', aligned)
        .filter(finding => finding.kind === 'section-mismatch')
    ).toEqual([]);
    // 方法未在 .def 声明:不错配(无声明不作闸)
    expect(
      computeReceiverNoneFindings(mismatched, '/avatar.py', mappingWithMethods({}))
        .filter(finding => finding.kind === 'section-mismatch')
    ).toEqual([]);
  });

  it('开关关:receiverNoneDiagnosticItems(enabled=false) 零产出', () => {
    const unguarded = py([
      'class Avatar:',
      '    def onTick(self):',
      '        self.cell.tick()',
      ''
    ]);
    expect(receiverNoneDiagnosticItems(unguarded, '/avatar.py', undefined, false)).toEqual([]);
  });
});
