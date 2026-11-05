import { describe, expect, it } from 'vitest';
import {
  SPACE_NAV_DIAGNOSTIC_CODE,
  computeSpaceNavFindings
} from '../src/spaceNavDiagnostics';

// SP-4: 空间/导航语义诊断(纯文本面,引擎取证):
// 1) setSpaceData/delSpaceData 用保留键 _mapping → 引擎 AssertionError
//    (spacememory.cpp:740 set / :862 del)
// 2) 文件有 navigate 调用但全文无 canNavigate → 几何加载前置未核
//    (canNavigate 才能反映 pNavHandle 就绪,entity.cpp:2563)
// 3) addSpaceGeometryMapping params dict 键必须是 int 字面量
//    (引擎 PyLong_Check,spacememory.cpp:194;字符串层键 → 运行时必炸)

describe('space/nav semantic diagnostics (SP-4)', () => {
  describe('_mapping protected key', () => {
    it('flags setSpaceData with _mapping key', () => {
      const findings = computeSpaceNavFindings(
        'KBEngine.setSpaceData(spaceID, "_mapping", path)\n'
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(SPACE_NAV_DIAGNOSTIC_CODE);
      expect(findings[0].message).toContain('_mapping');
      expect(findings[0].message).toContain('protected');
    });

    it('flags delSpaceData with _mapping key', () => {
      const findings = computeSpaceNavFindings(
        'KBEngine.delSpaceData(spaceID, "_mapping")\n'
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('_mapping');
    });

    it('accepts normal space data keys', () => {
      expect(
        computeSpaceNavFindings(
          'KBEngine.setSpaceData(spaceID, "hp", "100")\nKBEngine.delSpaceData(spaceID, "gold")\n'
        )
      ).toEqual([]);
    });
  });

  describe('navigate without canNavigate guard', () => {
    it('flags navigate when file never mentions canNavigate', () => {
      const findings = computeSpaceNavFindings(
        [
          'class Avatar:',
          '    def rush(self, dest):',
          '        self.navigate(dest, 1.0, 0, 0, 0, 1, 0, None)',
          ''
        ].join('\n')
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('canNavigate');
      expect(findings[0].code).toBe(SPACE_NAV_DIAGNOSTIC_CODE);
    });

    it('flags navigatePathPoints under the same precondition', () => {
      const findings = computeSpaceNavFindings(
        'def go(self, dest):\n    self.navigatePathPoints(dest, 100.0, 0)\n'
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('canNavigate');
    });

    it('accepts files that reference canNavigate', () => {
      expect(
        computeSpaceNavFindings(
          [
            'def rush(self, dest):',
            '    if self.canNavigate():',
            '        self.navigate(dest, 1.0, 0, 0, 0, 1, 0, None)',
            ''
          ].join('\n')
        )
      ).toEqual([]);
    });

    it('does not flag navigatePathPoints substring as navigate', () => {
      // navigatePathPoints 单独出现且无 canNavigate 仍应报(同前置),
      // 但普通单词 navigatePath 不应误匹配 navigate(
      expect(
        computeSpaceNavFindings('def f(self):\n    self.navigatePath()\n')
      ).toEqual([]);
    });
  });

  describe('addSpaceGeometryMapping params key type', () => {
    it('flags string-literal layer keys in params dict', () => {
      const findings = computeSpaceNavFindings(
        'KBEngine.addSpaceGeometryMapping(0, None, path, True, {"0": "a.navmesh"})\n'
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('int');
      expect(findings[0].code).toBe(SPACE_NAV_DIAGNOSTIC_CODE);
    });

    it('accepts integer-literal layer keys', () => {
      expect(
        computeSpaceNavFindings(
          'KBEngine.addSpaceGeometryMapping(0, None, path, True, {0: "a.navmesh", 1: "b.navmesh"})\n'
        )
      ).toEqual([]);
    });

    it('accepts calls without a params dict', () => {
      expect(
        computeSpaceNavFindings('KBEngine.addSpaceGeometryMapping(0, None, path)\n')
      ).toEqual([]);
    });
  });

  describe('combined file', () => {
    it('collects all three finding kinds', () => {
      const findings = computeSpaceNavFindings(
        [
          'KBEngine.setSpaceData(spaceID, "_mapping", path)',
          'KBEngine.addSpaceGeometryMapping(0, None, p, True, {"0": "a.navmesh"})',
          'def rush(self, dest):',
          '    self.navigate(dest, 1.0, 0, 0, 0, 1, 0, None)',
          ''
        ].join('\n')
      );
      expect(findings).toHaveLength(3);
      expect(findings.every(f => f.code === SPACE_NAV_DIAGNOSTIC_CODE)).toBe(true);
      // 行号单调不减
      for (let i = 1; i < findings.length; i += 1) {
        expect(findings[i].line).toBeGreaterThanOrEqual(findings[i - 1].line);
      }
    });

    it('returns empty for unrelated python code', () => {
      expect(computeSpaceNavFindings('x = 1\nprint(x)\n')).toEqual([]);
      expect(computeSpaceNavFindings('')).toEqual([]);
    });
  });
});
