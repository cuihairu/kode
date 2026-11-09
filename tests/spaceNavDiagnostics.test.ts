import { describe, expect, it } from 'vitest';
import {
  SPACE_NAV_DIAGNOSTIC_CODE,
  computeSpaceNavFindings
} from '../src/backend/spaceNavDiagnostics';

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

    it('cross-line self\\n.navigate range lands on the method line', () => {
      // 审核发现:`\s*` 跨行时旧行号取 self 行、列取方法名列——行列不同源,
      // 范围落错行且越出行尾。修复后行/列同取方法名偏移(navigate 实际行)。
      const text = 'def f(self, dest):\n    (self\n        .navigate(dest))\n';
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(1);
      const lineText = text.split('\n')[findings[0].line];
      // 行内截取 [start,end) 必须恰是方法名本体(而非越界/错行)。
      expect(lineText.slice(findings[0].start, findings[0].end)).toBe('navigate');
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

    it('does not flag quoted keys nested inside params values', () => {
      // 审核发现:引擎只校验 params 顶层键(PyDict_Next),嵌套 dict 的字符串
      // 键不校验——旧实现对整个 dict 体扫描,`{0: {"a": 1}}` 误报键 "a"。
      expect(
        computeSpaceNavFindings(
          'KBEngine.addSpaceGeometryMapping(0, None, path, True, {0: {"a": 1}, 1: [ {"b": 2} ]})\n'
        )
      ).toEqual([]);
    });

    it('still flags top-level quoted keys when nested dicts are present', () => {
      // 顶层键仍是引号包键 → 照报(嵌套不误报≠顶层放行)。
      const findings = computeSpaceNavFindings(
        'KBEngine.addSpaceGeometryMapping(0, None, path, True, {"0": {"a": 1}})\n'
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('"0"');
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

  describe('audit fixes (2026-11-05)', () => {
    it('第二行起的诊断列号是行内列而非全文偏移', () => {
      // 第一行 20 字符长;navigate 在第二行,旧实现把全文偏移当列号(错位/越界)
      const text = [
        'x = "a" * 20 # 第一行占位,使第二行偏移 != 列号',
        '    self.navigate(dest, 1.0)',
        ''
      ].join('\n');
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(1);
      // 方法名 navigate:行 1(0 基);"self." 前有 4 空格 → 列 4+5=9(0 基)
      expect(findings[0].line).toBe(1);
      expect(findings[0].start).toBe(9);
      expect(findings[0].end).toBe(9 + 'navigate'.length);
      // 断言旧行为(全文偏移当列号)会失败:全文偏移 >> 行内列 9
      expect(findings[0].start).toBeLessThan(40);
    });

    it('第二行起的 _mapping 键列号是行内列', () => {
      const text = [
        'x = "long-prefix" * 10',
        '    KBEngine.setSpaceData(1, "_mapping", p)',
        ''
      ].join('\n');
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(1);
      expect(findings[0].line).toBe(1);
      // 列 = 该行内 "_mapping" 开引号位置
      const lineCol = text.split('\n')[1].indexOf('"');
      expect(findings[0].start).toBe(lineCol);
      expect(findings[0].end).toBe(lineCol + '_mapping'.length + 2);
      expect(findings[0].start).toBeLessThan(80);
    });

    it('注释里的 navigate 与 canNavigate 不参与判定(不报也无守卫)', () => {
      // 注释里出现 canNavigate,代码里 navigate 未守卫 → 应报(注释不充当守卫)
      const text = [
        '# 注释提到 canNavigate(),不构成守卫',
        '    self.navigate(dest, 1.0)',
        ''
      ].join('\n');
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('canNavigate');
    });

    it('字符串里的 navigate 字样不报', () => {
      const text = [
        'msg = "self.navigate(1, 2)"',
        'def f(self):',
        '    pass',
        ''
      ].join('\n');
      expect(computeSpaceNavFindings(text)).toEqual([]);
    });

    it('任意对象的 navigate 不当引擎方法(不报)', () => {
      const text = [
        'def go(self):',
        '    avatar.navigate(dest, 1.0)',
        '    other.navigatePathPoints(dest)',
        ''
      ].join('\n');
      expect(computeSpaceNavFindings(text)).toEqual([]);
    });

    it('self.navigate 仍报(引擎实体方法约定)', () => {
      const text = [
        'def go(self):',
        '    self.navigate(dest, 1.0)',
        ''
      ].join('\n');
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('canNavigate');
    });
  });

  describe('词法边界臂(覆盖补测)', () => {
    it('引号键内转义:反斜杠跳过不误判,键仍报', () => {
      const text = "addSpaceGeometryMapping(1, 2, 3, 4, {'a\\b': 1})";
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(1);
    });

    it('引号键内空格后冒号:键仍报(空白跳过)', () => {
      const text = "addSpaceGeometryMapping(1, 2, 3, 4, {'a'  : 1})";
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(1);
    });

    it('dict 键引号未闭合:保守收手零报', () => {
      const text = "addSpaceGeometryMapping(1, 2, 3, 4, {'abc\n)";
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(0);
    });

    it('dict 未闭合但调用已闭合:无效返回零报', () => {
      const text = "addSpaceGeometryMapping(1, 2, 3, 4, {'a': 1)";
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(0);
    });

    it('调用括号永不闭合:循环终零报', () => {
      const text = "addSpaceGeometryMapping(1, 2, 3, 4, {'a': 1";
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(0);
    });

    it('三引号字符串里的 navigate 与 canNavigate 不参与判定', () => {
      const text = [
        's = """',
        'self.navigate(1)',
        'self.canNavigate()',
        '"""',
        'self.navigate(dest, 1.0)',
        ''
      ].join('\n');
      const findings = computeSpaceNavFindings(text);
      // 三引号内的 navigate 被掩码;canNavigate 在字符串里不算守卫;
      // 字符串外的 self.navigate 仍报(全文无真守卫)
      expect(findings).toHaveLength(1);
    });

    it('普通字符串内转义与 navigate 掩码', () => {
      const text = [
        's = \'a\\b\'',
        'self.navigate(1)',
        ''
      ].join('\n');
      const findings = computeSpaceNavFindings(text);
      expect(findings).toHaveLength(1);
    });
  });
});
