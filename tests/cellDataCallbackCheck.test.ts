import { describe, expect, it } from 'vitest';
import {
  CELL_DATA_CALLBACK_CODE,
  CELL_DATA_CALLBACK_DIAGNOSTICS_ENABLED_DEFAULT,
  cellDataCallbackFindingToItem,
  cellDataCallbackFindings,
  cellDataProvenStateAtLine
} from '../src/backend/cellDataCallbackCheck';

const wrap = (body: string): string =>
  ['class Avatar:', '    def onGetCell(self):', ...body.split('\n').map(l => `        ${l}`), ''].join('\n');

describe('cellDataCallbackFindings (KSEM-CELL-12)', () => {
  it('reports a plain subscript read in onGetCell', () => {
    const text = wrap("level = self.cellData['level']");
    const findings = cellDataCallbackFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
    expect(text.split('\n')[2].slice(findings[0].character, findings[0].character + findings[0].length)).toBe('self.cellData');
    expect(findings[0].message).toContain('AttributeError');
  });

  it('reports a .get read and an attribute-call read', () => {
    const text = wrap('v = self.cellData.get("hpe")\nw = self.cellData.copy()');
    expect(cellDataCallbackFindings(text)).toHaveLength(2);
  });

  it('reports iteration and alias binding reads', () => {
    const text = wrap('for k in self.cellData:\n    pass\ndata = self.cellData');
    expect(cellDataCallbackFindings(text)).toHaveLength(2);
  });

  it('does not report a plain attribute store', () => {
    const text = wrap('self.cellData = {}');
    expect(cellDataCallbackFindings(text)).toEqual([]);
  });

  it('does not report reads after an in-method store (attribute rebuilt)', () => {
    const text = wrap('self.cellData = {}\nlevel = self.cellData["level"]');
    expect(cellDataCallbackFindings(text)).toEqual([]);
  });

  it('reports a read that follows store-then-del (attribute gone again)', () => {
    const text = wrap('self.cellData = {}\ndel self.cellData\nv = self.cellData["level"]');
    const findings = cellDataCallbackFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
  });

  it('reports del of the missing attribute with the del-specific wording', () => {
    const text = wrap('del self.cellData');
    const findings = cellDataCallbackFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('del 同样抛');
  });

  it('does not report subscript writes as stores (they evaluate the attribute)', () => {
    const text = wrap('self.cellData["level"] = 5');
    expect(cellDataCallbackFindings(text)).toHaveLength(1);
  });

  it('does not report augmented assignment as a store', () => {
    const text = wrap('v = self.cellData["n"]\nself.cellData["n"] += 1');
    expect(cellDataCallbackFindings(text)).toHaveLength(2);
  });

  it('treats tuple-unpack store targets as stores', () => {
    const text = wrap('self.cellData, other = {}, 1');
    expect(cellDataCallbackFindings(text)).toEqual([]);
  });

  it('ignores other lifecycle callbacks (no definite claim outside onGetCell)', () => {
    const text = [
      'class Avatar:',
      '    def onLoseCell(self):',
      '        v = self.cellData',
      '',
      '    def onRestore(self):',
      '        v = self.cellData',
      '',
      '    def anyMethod(self):',
      '        v = self.cellData["x"]',
      ''
    ].join('\n');
    expect(cellDataCallbackFindings(text)).toEqual([]);
  });

  it('ignores module-level functions named onGetCell (engine never calls them)', () => {
    const text = ['def onGetCell(self):', '    v = self.cellData["x"]', ''].join('\n');
    expect(cellDataCallbackFindings(text)).toEqual([]);
  });

  it('ignores comment and string mentions via masking', () => {
    const text = wrap('# self.cellData lookup\ns = "self.cellData"\nv = self.cellData["x"]');
    const findings = cellDataCallbackFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
  });

  it('scans every class with onGetCell in the file', () => {
    const text = [
      'class A:',
      '    def onGetCell(self):',
      '        v = self.cellData["a"]',
      '',
      'class B:',
      '    def onGetCell(self):',
      '        v = self.cellData["b"]',
      ''
    ].join('\n');
    const findings = cellDataCallbackFindings(text);
    expect(findings).toHaveLength(2);
    expect(findings.map(f => f.line)).toEqual([2, 6]);
  });

  it('covers a closure defined inside onGetCell (attribute still gone when it runs)', () => {
    const text = wrap('def later():\n    return self.cellData["x"]\nreturn later');
    expect(cellDataCallbackFindings(text)).toHaveLength(1);
  });

  it('returns empty for files without onGetCell', () => {
    const text = wrap('v = self.cellData["x"]');
    const patched = text.replace('def onGetCell', 'def onOther');
    expect(cellDataCallbackFindings(patched)).toEqual([]);
  });

  it('findingToItem maps the token range with the family shape', () => {
    const [finding] = cellDataCallbackFindings(wrap('v = self.cellData["x"]'));
    const item = cellDataCallbackFindingToItem(finding);
    expect(item.range.start).toEqual({ line: 2, character: finding.character });
    expect(item.range.end.character - item.range.start.character).toBe('self.cellData'.length);
    expect(item.severity).toBe('Warning');
    expect(item.source).toBe('kbengine');
    expect(item.code).toBe(CELL_DATA_CALLBACK_CODE);
  });

  it('keeps the toggle default on, matching the CELL-08/10 convention', () => {
    expect(CELL_DATA_CALLBACK_DIAGNOSTICS_ENABLED_DEFAULT).toBe(true);
  });
});

describe('cellDataProvenStateAtLine (KSEM-CELL-14 hover face)', () => {
  it('reports the absent engine state on the first body line of onGetCell', () => {
    const text = wrap('v = self.cellData["level"]');
    // wrap: 0=class, 1=def, body starts at 2; 状态 = 处理完 [1, 2)(仅 def 行)后
    expect(cellDataProvenStateAtLine(text, 2)).toEqual({ inWindow: true, state: 'absent' });
  });

  it('reports present after an in-method store on an earlier line', () => {
    const text = wrap('self.cellData = {}\nlevel = self.cellData["level"]');
    expect(cellDataProvenStateAtLine(text, 3)).toEqual({ inWindow: true, state: 'present' });
  });

  it('reports absent again after store-then-del', () => {
    const text = wrap('self.cellData = {}\ndel self.cellData\nv = self.cellData["x"]');
    expect(cellDataProvenStateAtLine(text, 4)).toEqual({ inWindow: true, state: 'absent' });
  });

  it('gives the same verdict the diagnostics face reports at that line', () => {
    // 与 CELL-12 诊断面互证:每个报点位置 proven 态必为 absent(读取见已删属性)
    const text = wrap('v = self.cellData["a"]\nw = self.cellData["b"]');
    const findings = cellDataCallbackFindings(text);
    expect(findings.map(f => f.line)).toEqual([2, 3]);
    for (const finding of findings) {
      expect(cellDataProvenStateAtLine(text, finding.line)).toEqual({ inWindow: true, state: 'absent' });
    }
  });

  it('stays outside the window for other methods in the same file', () => {
    const text = [
      'class Avatar:',
      '    def onGetCell(self):',
      '        pass',
      '',
      '    def onLoseCell(self):',
      '        v = self.cellData',
      ''
    ].join('\n');
    expect(cellDataProvenStateAtLine(text, 5)).toEqual({ inWindow: false, state: null });
  });

  it('returns out-of-window for files without any onGetCell', () => {
    const text = ['class Avatar:', '    def anyMethod(self):', '        pass', ''].join('\n');
    expect(cellDataProvenStateAtLine(text, 2)).toEqual({ inWindow: false, state: null });
  });

  it('picks the window of the class the queried line belongs to', () => {
    const text = [
      'class A:',
      '    def onGetCell(self):',
      '        pass',
      '',
      'class B:',
      '    def onGetCell(self):',
      '        self.cellData = {}',
      '        v = self.cellData["x"]',
      ''
    ].join('\n');
    // A 体(2 行)仍处引擎删除态;B 体先存后读 → present
    expect(cellDataProvenStateAtLine(text, 2)).toEqual({ inWindow: true, state: 'absent' });
    expect(cellDataProvenStateAtLine(text, 7)).toEqual({ inWindow: true, state: 'present' });
  });

  it('treats a line past the method end as out of window (indent close)', () => {
    const text = wrap('v = self.cellData["x"]');
    // wrap 末尾补一空行后整体 4 行;无第 5 行 → 越界同样窗口外
    expect(cellDataProvenStateAtLine(text, 4)).toEqual({ inWindow: false, state: null });
  });
});
