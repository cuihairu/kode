import { describe, expect, it } from 'vitest';
import {
  canonicalizeScriptFilePath,
  resolveHotReloadModuleIdentity
} from '../src/backend/hotReloadModuleIdentity';

const ROOT = '/ws/scripts';

describe('canonicalizeScriptFilePath(HR-MOD-009 词法规范化,纯字符串零 IO)', () => {
  it('file:// URI 剥 scheme+percent 解码;坏转义原样保留不抛', () => {
    expect(canonicalizeScriptFilePath('file:///ws/scripts/base/Avatar.py')).toBe('/ws/scripts/base/Avatar.py');
    expect(canonicalizeScriptFilePath('file:///ws/my%20file.py')).toBe('/ws/my file.py');
    expect(canonicalizeScriptFilePath('file:///ws/100%.py')).toBe('/ws/100%.py');
  });

  it('反斜杠转正斜杠;盘符统一大写;其余大小写保留(HR-MOD-003)', () => {
    expect(canonicalizeScriptFilePath('c:\\ws\\Scripts\\AvatarMix.py')).toBe('C:/ws/Scripts/AvatarMix.py');
    expect(canonicalizeScriptFilePath('file:///c:/ws/Avatar.py')).toBe('/C:/ws/Avatar.py');
  });

  it('UNC 形保留(WSL //wsl$、//wsl.localhost、Remote SSH 挂载),反斜杠 UNC 同折', () => {
    expect(canonicalizeScriptFilePath('//wsl$/Ubuntu-22.04/home/u/scripts/Avatar.py')).toBe(
      '//wsl$/Ubuntu-22.04/home/u/scripts/Avatar.py'
    );
    expect(canonicalizeScriptFilePath('\\\\wsl.localhost\\Ubuntu\\home\\u\\scripts\\A.py')).toBe(
      '//wsl.localhost/Ubuntu/home/u/scripts/A.py'
    );
  });

  it('重复斜杠折叠;`.` 删除;`..` 词法上卷(卷出根即落根外,交解析器拒)', () => {
    expect(canonicalizeScriptFilePath('/ws//scripts/./base///Avatar.py')).toBe('/ws/scripts/base/Avatar.py');
    expect(canonicalizeScriptFilePath('/ws/scripts/base/../fight/Foo.py')).toBe('/ws/scripts/fight/Foo.py');
    expect(canonicalizeScriptFilePath('/ws/scripts/../../secrets/x.py')).toBe('/secrets/x.py');
  });

  it('空输入空串;尾斜杠裁剪', () => {
    expect(canonicalizeScriptFilePath('')).toBe('');
    expect(canonicalizeScriptFilePath('/ws/scripts/')).toBe('/ws/scripts');
  });
});

describe('resolveHotReloadModuleIdentity(HR-MOD-001 DTO+HR-MOD-002 纯解析器)', () => {
  it('书 §19.1 四示例;base/Avatar 按 879f47d5 引擎实证剥角色目录(引擎 sys.modules 无 base. 前缀,spec 草拟于该发现前)', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      [`${ROOT}/base/Avatar.py`, 'Avatar', 'Avatar'],
      [`${ROOT}/entities/fight/FightAI.py`, 'fight.FightAI', 'entities.fight.FightAI'],
      [`${ROOT}/entities/npc/NpcAI.py`, 'npc.NpcAI', 'entities.npc.NpcAI'],
      [`${ROOT}/common/utils/math.py`, 'utils.math', 'common.utils.math']
    ];
    for (const [file, requestModule, fullModule] of cases) {
      const result = resolveHotReloadModuleIdentity({
        fileUri: file,
        scriptRoot: ROOT,
        workspaceId: 'ws-1',
        rootId: 'scripts-root',
        sourceVersion: 42
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        continue;
      }
      expect(result.identity).toEqual({
        workspaceId: 'ws-1',
        rootId: 'scripts-root',
        fileUri: file,
        fullModule,
        requestModule,
        fileStem: fullModule.slice(fullModule.lastIndexOf('.') + 1),
        parentName: expect.any(String),
        language: 'python',
        sourceVersion: 42
      });
    }
  });

  it('多根候选:唯一命中即解析;零命中 out-of-root;嵌套多命中 ambiguous 列全候选不猜(HR-MOD-006)', () => {
    const unique = resolveHotReloadModuleIdentity({
      fileUri: `${ROOT}/entities/fight/FightAI.py`,
      scriptRoots: [ROOT, '/other/scripts']
    });
    expect(unique.ok).toBe(true);
    const outside = resolveHotReloadModuleIdentity({
      fileUri: '/elsewhere/base/Avatar.py',
      scriptRoots: [ROOT, '/other/scripts']
    });
    expect(outside).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'out-of-root' }]
    });
    const ambiguous = resolveHotReloadModuleIdentity({
      fileUri: `${ROOT}/entities/fight/FightAI.py`,
      scriptRoots: [ROOT, `${ROOT}/entities`]
    });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.diagnostics[0].code).toBe('ambiguous-root');
      // 诊断列全命中候选根(ROOT 与其嵌套子根),不列未命中的根
      expect(ambiguous.diagnostics[0].message).toContain(ROOT);
      expect(ambiguous.diagnostics[0].message).toContain(`${ROOT}/entities`);
      expect(ambiguous.diagnostics[0].message).not.toContain('/other');
    }
  });

  it('相邻目录假包含不命中:/ws/scripts2 不得顶替 /ws/scripts', () => {
    const result = resolveHotReloadModuleIdentity({
      fileUri: '/ws/scripts2/base/Avatar.py',
      scriptRoot: ROOT
    });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'out-of-root' }] });
  });

  it('同名文件落在两根各自解析,rootId 区分归属(HR-MOD-010 解析器侧根上下文)', () => {
    const a = resolveHotReloadModuleIdentity({
      fileUri: '/a/scripts/entities/fight/FightAI.py',
      scriptRoots: ['/a/scripts', '/b/scripts'],
      rootId: 'a-scripts'
    });
    const b = resolveHotReloadModuleIdentity({
      fileUri: '/b/scripts/entities/fight/FightAI.py',
      scriptRoots: ['/a/scripts', '/b/scripts'],
      rootId: 'b-scripts'
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.identity.requestModule).toBe('fight.FightAI');
      expect(b.identity.requestModule).toBe('fight.FightAI');
      expect(a.identity.rootId).toBe('a-scripts');
      expect(b.identity.rootId).toBe('b-scripts');
    }
  });

  it('user override:合法替换双名;非法(空/空白/点段空)拒绝不静默回落', () => {
    const ok = resolveHotReloadModuleIdentity({
      fileUri: `${ROOT}/entities/fight/FightAI.py`,
      scriptRoot: ROOT,
      userOverrideModule: 'npc.BossAI'
    });
    expect(ok.ok && ok.identity.fullModule === 'npc.BossAI' && ok.identity.requestModule === 'npc.BossAI').toBe(true);
    for (const bad of ['', 'has space', '.foo', 'foo..bar']) {
      const refused = resolveHotReloadModuleIdentity({
        fileUri: `${ROOT}/entities/fight/FightAI.py`,
        scriptRoot: ROOT,
        userOverrideModule: bad
      });
      expect(refused).toMatchObject({ ok: false, diagnostics: [{ code: 'invalid-override' }] });
    }
  });

  it('HR-MOD-008:根下单层默认 unresolved(root-level 码),显式 allowRootLevelStem 才回落裸名', () => {
    const denied = resolveHotReloadModuleIdentity({ fileUri: `${ROOT}/Lone.py`, scriptRoot: ROOT });
    expect(denied).toMatchObject({ ok: false, diagnostics: [{ code: 'root-level' }] });
    const allowed = resolveHotReloadModuleIdentity({
      fileUri: `${ROOT}/Lone.py`,
      scriptRoot: ROOT,
      allowRootLevelStem: true
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.identity.fullModule).toBe('Lone');
      expect(allowed.identity.requestModule).toBe('Lone');
      expect(allowed.identity.parentName).toBe('');
    }
  });

  it('HR-MOD-015 URL encoding/特殊文件:%20 解码出空白短名拒;点短名拒;Unicode 字母短名合法(PEP 3130)', () => {
    const spaced = resolveHotReloadModuleIdentity({
      fileUri: 'file:///ws/scripts/base/my%20file.py',
      scriptRoot: ROOT
    });
    expect(spaced).toMatchObject({ ok: false, diagnostics: [{ code: 'invalid-stem' }] });
    const dotted = resolveHotReloadModuleIdentity({
      fileUri: `${ROOT}/entities/my.file.py`,
      scriptRoot: ROOT
    });
    expect(dotted).toMatchObject({ ok: false, diagnostics: [{ code: 'invalid-stem' }] });
    const unicode = resolveHotReloadModuleIdentity({
      fileUri: `${ROOT}/base/法术.py`,
      scriptRoot: ROOT
    });
    expect(unicode.ok && unicode.identity.fullModule === '法术').toBe(true);
  });

  it('诊断码透传:init-file / not-python / out-of-root(穿越词法上卷后落根外);空 fileUri 拒绝', () => {
    expect(
      resolveHotReloadModuleIdentity({ fileUri: `${ROOT}/entities/fight/__init__.py`, scriptRoot: ROOT })
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'init-file' }] });
    expect(
      resolveHotReloadModuleIdentity({ fileUri: `${ROOT}/entities/fight/X.json`, scriptRoot: ROOT })
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'not-python' }] });
    expect(
      resolveHotReloadModuleIdentity({ fileUri: `${ROOT}/../secrets/x.py`, scriptRoot: ROOT })
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'out-of-root' }] });
    expect(resolveHotReloadModuleIdentity({ fileUri: '', scriptRoot: ROOT })).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'not-python' }]
    });
    expect(
      resolveHotReloadModuleIdentity({ fileUri: `${ROOT}/base/Avatar.py`, scriptRoot: '' })
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'no-root' }] });
  });
});
