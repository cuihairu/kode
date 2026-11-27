/**
 * FOLDER-COLOR-001 工作区目录着色纯核(零 vscode 依赖)。
 *
 * 契约钉子(任务书八钉的纯核侧):
 * ①双条件门缺一=零输出(开关+Kode 主题族,用户令终版口径);
 * ②门开+Kode 主题→生效,切走即停(纯核只判现值,监听面在装配测试);
 * ③assetsRoot 命中→子树文件 A 角标;④venv→V 弱化灰;
 * ⑤rules 用户自定义数组整体替换内置(数组序即优先序);
 * ⑥多规则冲突→第一条赢;⑦进程色与面包屑批同源判定链;
 * ⑧目录零输出在 provider 面(纯核只按路径判,不掺目录概念)。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOLDER_COLOR_RULES,
  folderColorsActive,
  globToRegExp,
  isKodeThemeFamily,
  resolveFolderColor,
  type FolderColorRule
} from '../src/backend/folderColorRules';

const WS = '/ws';
const CTX = { workspaceRoot: WS, assetsRoot: '/ws/assets' };

const face = (fsPath: string, rules?: readonly FolderColorRule[]) =>
  resolveFolderColor(fsPath, { ...CTX, ...(rules ? { rules } : {}) });

describe('folderColorRules(目录着色纯核)', () => {
  describe('启用门(2026-11-27 用户令改版:只看 enabled,主题不联动)', () => {
    const labels = ['KBEngine (One Dark)', 'KBEngine Theme (Monokai)'];
    it('开关关 → 不启用', () => {
      expect(folderColorsActive(false, 'KBEngine (One Dark)', labels)).toBe(false);
    });
    it('开关开 → 启用(任何主题;旧主题条件废止)', () => {
      expect(folderColorsActive(true, 'KBEngine (One Dark)', labels)).toBe(true);
      expect(folderColorsActive(true, 'Default Dark+', labels)).toBe(true);
      expect(folderColorsActive(true, 'Dark+ (default)', [])).toBe(true);
      expect(folderColorsActive(true, '', labels)).toBe(true);
    });
    it('族判定:label 精确命中清单;前缀兜底;非 KBEngine 前缀不兜底', () => {
      expect(isKodeThemeFamily('KBEngine (One Dark)', labels)).toBe(true);
      expect(isKodeThemeFamily('KBEngine (Nord)', [])).toBe(true); // 前缀兜底(label 微调仍归族)
      expect(isKodeThemeFamily('Default Dark+', labels)).toBe(false);
      expect(isKodeThemeFamily('', labels)).toBe(false);
    });
  });

  describe('assetsRoot 命中(钉子③:子树文件 A 角标)', () => {
    it('资产根子树文件 → A + charts.orange', () => {
      const hit = face('/ws/assets/entities/Avatar.py')!;
      expect(hit.badge).toBe('A');
      expect(hit.colorId).toBe('charts.orange');
      expect(hit.semantic).toBe('assets');
      expect(hit.process).toBeNull();
    });
    it('资产根直属文件也命中;根外文件不命中', () => {
      expect(face('/ws/assets/logo.png')?.badge).toBe('A');
      expect(face('/ws/other/logo.png')).toBeNull();
    });
    it('未记录资产根 → `{assetsRoot}` 规则跳过(不猜)', () => {
      const resolved = resolveFolderColor('/ws/assets/a.py', { workspaceRoot: WS });
      expect(resolved).toBeNull();
    });
    it('Windows 反斜杠路径归一后同样命中', () => {
      const hit = resolveFolderColor('C:\\proj\\assets\\entities\\Avatar.py', {
        workspaceRoot: 'C:\\proj',
        assetsRoot: 'C:\\proj\\assets'
      })!;
      expect(hit.badge).toBe('A');
    });
  });

  describe('venv/docs/configs/logs 内置语义(钉子④:venv 弱化灰)', () => {
    it('venv/.venv → V + descriptionForeground(弱化)', () => {
      for (const dir of ['venv', '.venv']) {
        const hit = face(`/ws/${dir}/lib/site.py`)!;
        expect(hit.badge).toBe('V');
        expect(hit.colorId).toBe('descriptionForeground');
      }
    });
    it('docs → D + charts.blue;任意层同名目录命中', () => {
      expect(face('/ws/docs/a.md')?.badge).toBe('D');
      const nested = face('/ws/sub/docs/deep/x.md')!;
      expect(nested.colorId).toBe('charts.blue');
    });
    it('目录自身也命中尾双星规则(用户令:folderColors 对目录生效)', () => {
      const dirFace = resolveFolderColor('/ws/docs', { ...CTX, isDirectory: true });
      expect(dirFace?.badge).toBe('D');
      expect(dirFace?.colorId).toBe('charts.blue');
      const nestedDir = resolveFolderColor('/ws/sub/logs', { ...CTX, isDirectory: true });
      expect(nestedDir?.colorId).toBe('charts.red');
    });
    it('configs → C + charts.purple;logs → L + charts.red', () => {
      expect(face('/ws/configs/hybridcell.xml')?.colorId).toBe('charts.purple');
      expect(face('/ws/logs/baseapp.log')?.colorId).toBe('charts.red');
    });
  });

  describe('进程语义(钉子⑦:与面包屑批同源判定链)', () => {
    it('scripts/base|cell|client|bots → 各进程色各角标', () => {
      const base = face('/ws/scripts/base/Avatar.py')!;
      expect(base).toMatchObject({ badge: 'B', colorId: 'charts.blue', semantic: 'process', process: 'baseapp' });
      expect(face('/ws/scripts/cell/Hero.py')!).toMatchObject({ badge: 'C', colorId: 'charts.green', process: 'cellapp' });
      expect(face('/ws/scripts/client/Hero.py')!).toMatchObject({ badge: 'U', colorId: 'charts.yellow', process: 'client' });
      expect(face('/ws/scripts/bots/Hero.py')!).toMatchObject({ badge: 'T', colorId: 'charts.purple', process: 'bots' });
    });
    it('共享目录层跳过后仍可判角色(同 resolveScriptRole 语义)', () => {
      expect(face('/ws/scripts/interfaces/common/Foo.py')).toBeNull(); // 跳过后直达文件名=判不出
      expect(face('/ws/scripts/base/interfaces/Avatar.py')?.process).toBe('baseapp');
    });
    it('scripts 直挂文件判不出进程 → 该规则不出面(不猜)', () => {
      expect(face('/ws/scripts/tool.py')).toBeNull();
    });
  });

  describe('rules 用户自定义(钉子⑤⑥:数组整体替换;冲突第一条赢)', () => {
    it('自定义数组整体替换内置(同路径改判 docs)', () => {
      const custom: FolderColorRule[] = [{ glob: '**/assets/**', semantic: 'docs', enabled: true }];
      expect(face('/ws/assets/a.py', custom)?.badge).toBe('D');
      // 内置 venv/docs 等规则不再在环(替换而非合并)
      expect(face('/ws/logs/a.log', custom)).toBeNull();
    });
    it('`{assetsRoot}` 占位符在自定义规则中同样展开', () => {
      const custom: FolderColorRule[] = [{ glob: '{assetsRoot}/**', semantic: 'logs', enabled: true }];
      expect(face('/ws/assets/a.py', custom)?.badge).toBe('L');
    });
    it('多规则冲突 → 数组序第一条赢', () => {
      const conflict: FolderColorRule[] = [
        { glob: '**/*.py', semantic: 'docs', enabled: true },
        { glob: '**/*.py', semantic: 'logs', enabled: true }
      ];
      expect(face('/ws/scripts/base/Avatar.py', conflict)?.badge).toBe('D');
    });
    it('enabled=false 条目跳过,后续规则接手', () => {
      const rules: FolderColorRule[] = [
        { glob: '**/*.py', semantic: 'docs', enabled: false },
        { glob: '**/*.py', semantic: 'logs', enabled: true }
      ];
      expect(face('/ws/x/a.py', rules)?.badge).toBe('L');
    });
    it('内置默认规则集形状钉死(六条,顺序即优先序)', () => {
      expect(DEFAULT_FOLDER_COLOR_RULES.map(rule => `${rule.glob}|${rule.semantic}|${rule.enabled}`)).toEqual([
        '{assetsRoot}/**|assets|true',
        '**/{venv,.venv}/**|venv|true',
        '**/docs/**|docs|true',
        '**/configs/**|configs|true',
        '**/logs/**|logs|true',
        '**/scripts/**|process|true'
      ]);
    });
  });

  describe('globToRegExp(零依赖微实现)', () => {
    it('`**` 跨段;`**/docs/**` 命中任意层 docs 子树', () => {
      const re = globToRegExp('**/docs/**');
      expect(re.test('docs/a.md')).toBe(true);
      expect(re.test('a/b/docs/c/d.md')).toBe(true);
      expect(re.test('docsx/a.md')).toBe(false);
      expect(re.test('mydocs/a.md')).toBe(false);
    });
    it('`*` 不跨段;`?` 单字符', () => {
      expect(globToRegExp('*.py').test('a.py')).toBe(true);
      expect(globToRegExp('*.py').test('x/a.py')).toBe(false);
      expect(globToRegExp('a?.py').test('ab.py')).toBe(true);
      expect(globToRegExp('a?.py').test('abc.py')).toBe(false);
    });
    it('`{a,b}` 备选;. 前缀按字面', () => {
      expect(globToRegExp('{venv,.venv}/**').test('.venv/lib/x')).toBe(true);
      expect(globToRegExp('{venv,.venv}/**').test('venv/bin/x')).toBe(true);
      expect(globToRegExp('my.docs/**').test('myXdocs/a')).toBe(false);
      expect(globToRegExp('my.docs/**').test('my.docs/a')).toBe(true);
    });
    it('反斜杠输入归一(主题路径经 resolveFolderColor 归一后同样命中)', () => {
      expect(resolveFolderColor('D:\\ws\\docs\\a.md', { workspaceRoot: 'D:\\ws' })?.badge).toBe('D');
    });
  });
});
