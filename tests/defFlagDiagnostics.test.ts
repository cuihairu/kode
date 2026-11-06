// KR-AUD-84 红先行:'|' 组合形态单独出「引擎不支持」诊断 + Flags 整串查表。
// 引擎真值:KBEngine 源码按单个映射值整串查表解析 <Flags>,不拆词、不归一
// (TS 侧 validateScalarTagValues 与 Rust lint/rules.rs UnknownFlagValueRule 同口径)。
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { validateDocument } from '../src/languageProviders';
import { Diagnostic, DiagnosticCollection, makeTextDocument } from './helpers/vscodeStub';

const PROJECT = path.join(__dirname, 'fixtures', 'parity-project');

const flagDiagnostics = (flags: string): Diagnostic[] => {
  const content = [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    `      <Flags>${flags}</Flags>`,
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n');
  const doc = makeTextDocument(content, {
    fileName: path.join(PROJECT, 'scripts', 'entity_defs', 'FlagProbe.def'),
    languageId: 'kbengine-def'
  });
  const collection = new DiagnosticCollection();
  validateDocument(doc, collection);
  return ((collection.get(doc.uri) as Diagnostic[]) ?? []).filter(d =>
    d.message.includes('未知的 KBEngine Flags 值')
  );
};

describe('KR-AUD-84 Flags 整串查表 + |形态专属诊断', () => {
  it("'|' 组合形态单独出「引擎不支持」诊断", () => {
    const diags = flagDiagnostics('BASE|CELL');
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("不支持 '|' 组合形态");
  });

  it('整串查表:归一可折叠形态("all clients")不再放行', () => {
    const diags = flagDiagnostics('all clients');
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain('未知的 KBEngine Flags 值');
  });

  it('trim+大写整串命中词表的仍放行', () => {
    expect(flagDiagnostics(' CELL_PUBLIC ')).toHaveLength(0);
  });
});
