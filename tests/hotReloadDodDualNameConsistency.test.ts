// RUST-441（旧 HR-DOD-002）三触发面短名/全名一致性。
//
// 书 §19.1 双名称口径(src/backend/hotReloadModuleIdentity.ts:31-34):
//   fullModule    = UI 展示名 = entities.fight.FightAI
//   requestModule = 实际发送名 = fight.FightAI
// DOD-002 主张:手动命令、onSave、onDiskChange 对**同一模块**生成**完全一致**
// 的短名/全名。onSave 与 onDiskChange 是同一条 fire 路径(triggerMode 只决定
// 谁把事件送进来),所以本门的对照面是:
//   - 自动面(auto)= resolveHotReloadModuleIdentity(sendViaProviders 键开,生命周期
//     槽)与 resolveDefaultHotfixModule(键关,默认热更请求);
//   - 手动命令面(manual)= 用户 HTTP 请求模板的 ${reloadModule}/${fullModule},
//     由 buildTemplateVars 产出。
//
// 收口前的缺口=手动命令面漏 HR-MOD-008(kbengine.hotReload.allowRootLevelStem):
// buildTemplateVars 只把 (filePath, scriptRoot) 喂给 resolveModuleDualName,从不带
// allowRootLevelStem。根下单层脚本(`scripts/Lone.py`)键开时自动面解出裸短名
// Lone/Lone,手动命令面解出空串/空串(未解析)——同一模块两个名字,预览面同缺。
// 收口=TemplateEditorContext 增 allowRootLevelStem 并进 buildTemplateVars,手动面
// 与自动面同参;键关默认面与自动面一致地判未解析(手动空串,自动 root-level 码)。

import { describe, expect, it } from 'vitest';

import { resolveDefaultHotfixModule } from '../src/backend/hotReloadDefaultHotfix';
import { resolveHotReloadModuleIdentity } from '../src/backend/hotReloadModuleIdentity';
import { buildTemplateVars } from '../src/backend/httpRequests';

// 书 §19.1 示例:DOD-002 场景用的脚本根与两个文件(嵌套 + 根下单层)
const SCRIPT_ROOT = '/ws/scripts';
const FIGHT_AI = `${SCRIPT_ROOT}/entities/fight/FightAI.py`;
const LONE = `${SCRIPT_ROOT}/Lone.py`;
const FULL_MODULE = 'entities.fight.FightAI'; // UI 展示名
const REQUEST_MODULE = 'fight.FightAI'; // 实际发送名

/** 包边界探针:${module} legacy 推导面用(__init__.py 才算包段) */
const probe = (dirs: readonly string[]): ((dir: string) => boolean) =>
  (dir: string) => dirs.includes(dir);

/** 手动命令面:用户 HTTP 请求模板的 ${reloadModule}/${fullModule} */
const manualVars = (file: string, allowRootLevelStem: boolean) =>
  buildTemplateVars(
    { filePath: file, scriptRoot: SCRIPT_ROOT, allowRootLevelStem },
    probe([`${SCRIPT_ROOT}/entities`, `${SCRIPT_ROOT}/entities/fight`, SCRIPT_ROOT])
  );

/** 自动面 A:sendViaProviders 键开 → 生命周期槽 resolveModule */
const autoLifecycle = (file: string, allowRootLevelStem: boolean) =>
  resolveHotReloadModuleIdentity({
    fileUri: file,
    scriptRoots: [SCRIPT_ROOT],
    ...(allowRootLevelStem ? { allowRootLevelStem: true } : {})
  });

describe('RUST-441 DOD-002:三触发面短名/全名一致性(同一模块同一对)', () => {
  it('嵌套模块:手动命令面与自动面同一解析核同值(FightAI 场景)', () => {
    const manual = manualVars(FIGHT_AI, false);
    expect({ requestModule: manual.reloadModule, fullModule: manual.fullModule }).toEqual({
      requestModule: REQUEST_MODULE,
      fullModule: FULL_MODULE
    });
    const lifecycle = autoLifecycle(FIGHT_AI, false);
    expect(lifecycle).toMatchObject({
      ok: true,
      identity: { requestModule: REQUEST_MODULE, fullModule: FULL_MODULE }
    });
    // 默认热更面(键关 wire 面)与自动面同源
    expect(resolveDefaultHotfixModule(FIGHT_AI, { scriptRoot: SCRIPT_ROOT })).toBe(FULL_MODULE);
  });

  it('根下单层 + HR-MOD-008 键开:三面对齐同一裸短名(收口前手动面漏 allowRootLevelStem)', () => {
    const manual = manualVars(LONE, true);
    expect(manual.reloadModule).toBe('Lone');
    expect(manual.fullModule).toBe('Lone');
    const lifecycle = autoLifecycle(LONE, true);
    expect(lifecycle).toMatchObject({ ok: true, identity: { requestModule: 'Lone', fullModule: 'Lone' } });
    expect(
      resolveDefaultHotfixModule(LONE, {
        scriptRoot: SCRIPT_ROOT,
        allowRootLevelStem: true
      })
    ).toBe('Lone');
  });

  it('根下单层 + 键关(默认):三面对齐地判未解析,不猜名', () => {
    const manual = manualVars(LONE, false);
    expect(manual.reloadModule).toBe('');
    expect(manual.fullModule).toBe('');
    const lifecycle = autoLifecycle(LONE, false);
    expect(lifecycle).toMatchObject({ ok: false, diagnostics: [{ code: 'root-level' }] });
    // 双名两值都未解析时,两面一致地回落 ${module} legacy 包边界扫描
    // (HR-AUDIT-004/RUST-322 兼容裁定;探针须给,缺探针=无可收包段,裸名)
    const legacyProbe = probe([SCRIPT_ROOT]);
    expect(buildTemplateVars({ filePath: LONE, scriptRoot: SCRIPT_ROOT, allowRootLevelStem: false }, legacyProbe).module).toBe('scripts.Lone');
    expect(resolveDefaultHotfixModule(LONE, { scriptRoot: SCRIPT_ROOT, isPackageDir: legacyProbe })).toBe('scripts.Lone');
  });

  it('未配脚本根:手动面与自动面一致地无模块名(空串/ no-root),不混用回落', () => {
    const manual = buildTemplateVars(
      { filePath: FIGHT_AI, allowRootLevelStem: false },
      probe([])
    );
    expect(manual.reloadModule).toBe('');
    expect(manual.fullModule).toBe('');
    const lifecycle = resolveHotReloadModuleIdentity({ fileUri: FIGHT_AI });
    expect(lifecycle).toMatchObject({ ok: false, diagnostics: [{ code: 'no-root' }] });
  });
});
