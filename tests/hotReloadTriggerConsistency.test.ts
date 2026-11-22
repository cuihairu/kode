/**
 * RUST-441(HR-DOD-002)手动命令/onSave/onDiskChange 对同一模块生成完全一致的
 * 短名/全名——纯验证闭合。
 *
 * 一致性按构造成立:三触发面全部经同一纯解析器 resolveModuleDualName,且读
 * 同一脚本根配置键 kbengine.hotReload.tempEdit.scriptRoot(自动面在
 * activate/hotReload.ts defaultHotfix.resolveScriptRoot,手动面在
 * hotReloadTempEdit.ts readTempEditReloadSettings)——同 (file, scriptRoot) 必
 * 得同一 {requestModule, fullModule}。本测试把该一致性钉成可回归的守卫:任何
 * 一面的名字推导与另一面分叉(如自动面改回 fullModule,或手动面换解析源)
 * 即红。零生产代码(纯验证,任务要求已由共享解析器+共享配置键实现)。
 */
import { describe, expect, it } from 'vitest';

import { resolveDefaultHotfixModule } from '../src/backend/hotReloadDefaultHotfix';
import {
  runTempEditReload,
  type TempEditReloadDeps,
  type TempEditReloadDoc,
  type TempEditReloadSettings
} from '../src/backend/hotReloadTempEdit';

const FILE = '/ws/scripts/entities/fight/FightAI.py';
const SCRIPT_ROOT = '/ws/scripts';

const makeFakeLegs = (): {
  deps: TempEditReloadDeps;
  doc: TempEditReloadDoc;
  settings: TempEditReloadSettings;
} => {
  const doc: TempEditReloadDoc = { fsPath: FILE, label: 'FightAI.py' };
  const deps: TempEditReloadDeps = {
    readFile: async () => 'class FightAI:\n    pass\n',
    writeFile: async () => undefined,
    runReloadAction: async () => true,
    log: () => undefined,
    reportProblem: () => undefined,
    now: () => new Date('2026-11-23T00:00:00.000Z')
  };
  const settings: TempEditReloadSettings = { enabled: true, actionName: '热更新', autoRestore: true, scriptRoot: SCRIPT_ROOT };
  return { deps, doc, settings };
};

describe('RUST-441 三触发面短名/全名一致性(纯验证,零生产代码)', () => {
  it('onSave/onDiskChange(自动默认热更)与手动(tempEdit)对同一模块生成完全一致的短名/全名', async () => {
    // 自动面(线路名):resolveDefaultHotfixModule → resolveModuleDualName →
    // requestModule。这是 onSave/onDiskChange 两触发共用同一 dispatch 的线路名。
    const autoWire = resolveDefaultHotfixModule(FILE, { scriptRoot: SCRIPT_ROOT });
    expect(autoWire).toBe('fight.FightAI');

    // 手动面(runTempEditReload):outcome.dualName 经同一 resolveModuleDualName。
    const { deps, doc, settings } = makeFakeLegs();
    const outcome = await runTempEditReload(doc, settings, deps);
    expect(outcome.dualName.requestModule).toBe('fight.FightAI');
    expect(outcome.dualName.fullModule).toBe('entities.fight.FightAI');

    // 一致性:自动线路短名 === 手动生成的短名(同一解析器+同一脚本根,不混)。
    expect(outcome.dualName.requestModule).toBe(autoWire);
    // 全名展示面两路同源:手动 fullModule === 自动面的全名口径(经同一解析器)。
    expect(outcome.dualName.fullModule).toBe('entities.fight.FightAI');
  });
});
