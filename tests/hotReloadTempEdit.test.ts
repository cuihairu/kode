import { describe, expect, it } from 'vitest';
import {
  TEMP_EDIT_DEFAULTS,
  TEMP_EDIT_MARKER_TAG,
  applyTempEdit,
  readTempEditReloadSettings,
  resolveModuleDualName,
  runTempEditReload,
  tempEditSectionReader
} from '../src/hotReloadTempEdit';
import type {
  TempEditReloadDeps,
  TempEditReloadDoc,
  TempEditReloadSettings
} from '../src/hotReloadTempEdit';

// 书 docs/kode2/KODE_2_COMPLETE_TODO.md §19 HR-PR-02:临时编辑热重载
// quick action。纯解析(双名称/设置/临时编辑内容)+ 编排(假腿驱动):
// 先临时编辑 → 可选自动还原 → reloadScript → 结果回显;铁律 accepted≠applied。

const ROOT = '/ws/scripts';

describe('resolveModuleDualName(书 §19.1 四示例与 explicit unsupported)', () => {
  it('四个书定示例:fullModule=根相对全段,requestModule=父目录+短名', () => {
    expect(resolveModuleDualName(`${ROOT}/base/Avatar.py`, ROOT)).toEqual({
      fullModule: 'base.Avatar',
      requestModule: 'base.Avatar',
      fileStem: 'Avatar',
      parentName: 'base'
    });
    expect(resolveModuleDualName(`${ROOT}/entities/fight/FightAI.py`, ROOT)).toEqual({
      fullModule: 'entities.fight.FightAI',
      requestModule: 'fight.FightAI',
      fileStem: 'FightAI',
      parentName: 'fight'
    });
    expect(resolveModuleDualName(`${ROOT}/entities/npc/NpcAI.py`, ROOT)).toEqual({
      fullModule: 'entities.npc.NpcAI',
      requestModule: 'npc.NpcAI',
      fileStem: 'NpcAI',
      parentName: 'npc'
    });
    expect(resolveModuleDualName(`${ROOT}/common/utils/math.py`, ROOT)).toEqual({
      fullModule: 'common.utils.math',
      requestModule: 'utils.math',
      fileStem: 'math',
      parentName: 'utils'
    });
  });

  it('大小写保留;仅去结尾 .py,.pyi/.pyc 不假匹配', () => {
    expect(resolveModuleDualName(`${ROOT}/base/AvatarMix.py`, ROOT)).toMatchObject({ fileStem: 'AvatarMix' });
    expect(resolveModuleDualName(`${ROOT}/base/Avatar.PY`, ROOT)).toMatchObject({ fileStem: 'Avatar' });
    expect(resolveModuleDualName(`${ROOT}/base/Avatar.pyi`, ROOT)).toMatchObject({
      unsupported: expect.stringContaining('非 .py')
    });
    expect(resolveModuleDualName(`${ROOT}/base/Avatar.pyc`, ROOT)).toMatchObject({
      unsupported: expect.stringContaining('非 .py')
    });
  });

  it('__init__.py 判 unsupported(HR-MOD-007:验证前跳过)', () => {
    expect(resolveModuleDualName(`${ROOT}/entities/fight/__init__.py`, ROOT)).toMatchObject({
      unsupported: expect.stringContaining('__init__')
    });
  });

  it('根下单层脚本判 unsupported(HR-MOD-008:默认未解析)', () => {
    expect(resolveModuleDualName(`${ROOT}/Lone.py`, ROOT)).toMatchObject({
      unsupported: expect.stringContaining('single-level')
    });
  });

  it('未配置脚本根、根外文件与路径穿越都拒解析,不猜名', () => {
    expect(resolveModuleDualName(`${ROOT}/base/Avatar.py`, '')).toMatchObject({
      unsupported: expect.stringContaining('scriptRoot')
    });
    expect(resolveModuleDualName('/elsewhere/base/Avatar.py', ROOT)).toMatchObject({
      unsupported: expect.stringContaining('不在脚本资源根')
    });
    // 相邻目录假包含:/ws/scripts2 不得顶替 /ws/scripts
    expect(resolveModuleDualName('/ws/scripts2/base/Avatar.py', ROOT)).toMatchObject({
      unsupported: expect.stringContaining('不在脚本资源根')
    });
    expect(resolveModuleDualName(`${ROOT}/../secrets/x.py`, ROOT)).toMatchObject({
      unsupported: expect.stringContaining('穿越')
    });
  });

  it('Windows 反斜杠路径同解析(与仓内 toPosix 口径一致)', () => {
    expect(resolveModuleDualName('C:\\ws\\scripts\\base\\Avatar.py', 'C:/ws/scripts')).toEqual({
      fullModule: 'base.Avatar',
      requestModule: 'base.Avatar',
      fileStem: 'Avatar',
      parentName: 'base'
    });
  });
});

describe('readTempEditReloadSettings(默认关与畸形回落)', () => {
  const readerOf = (values: Record<string, unknown>) => ({
    get: <T>(key: string, defaultValue: T): T => (values[key] as T) ?? defaultValue
  });

  it('全部缺省:关、无动作名、自动还原开、无脚本根', () => {
    expect(readTempEditReloadSettings(readerOf({}))).toEqual(TEMP_EDIT_DEFAULTS);
    expect(TEMP_EDIT_DEFAULTS.enabled).toBe(false);
    expect(TEMP_EDIT_DEFAULTS.autoRestore).toBe(true);
  });

  it('合法值原样回显', () => {
    expect(
      readTempEditReloadSettings(
        readerOf({ enabled: true, actionName: '热更', autoRestore: false, scriptRoot: '/ws/scripts' })
      )
    ).toEqual({ enabled: true, actionName: '热更', autoRestore: false, scriptRoot: '/ws/scripts' });
  });

  it('类型错逐项回落默认', () => {
    expect(
      readTempEditReloadSettings(readerOf({ enabled: 'yes', actionName: 42, autoRestore: 0, scriptRoot: 7 }))
    ).toEqual(TEMP_EDIT_DEFAULTS);
  });
});

describe('tempEditSectionReader(hotReload 段解出 tempEdit 子段)', () => {
  it('子段扁平键命中;段缺失/子段缺失回落默认', () => {
    const reader = tempEditSectionReader({
      enabled: true,
      tempEdit: { enabled: true, actionName: '热更', scriptRoot: '/ws/scripts' }
    });
    expect(reader.get('enabled', false)).toBe(true);
    expect(reader.get('actionName', '')).toBe('热更');
    expect(reader.get('autoRestore', true)).toBe(true);
    expect(tempEditSectionReader(undefined).get('enabled', false)).toBe(false);
    expect(tempEditSectionReader({ hotReload: {} }).get('enabled', false)).toBe(false);
    expect(tempEditSectionReader(null).get('enabled', false)).toBe(false);
  });
});

describe('applyTempEdit(临时编辑内容)', () => {
  it('尾部补换行再追加一行注释标记(时间戳注入,纯函数不取钟)', () => {
    expect(applyTempEdit('x = 1', '2026-01-01T00:00:00.000Z')).toBe(
      'x = 1\n# kode-temp-reload 2026-01-01T00:00:00.000Z\n'
    );
    expect(applyTempEdit('x = 1\n', 'S')).toBe('x = 1\n# kode-temp-reload S\n');
    expect(TEMP_EDIT_MARKER_TAG).toBe('kode-temp-reload');
  });

  it('空文件同样只追加注释行', () => {
    expect(applyTempEdit('', 'S')).toBe('# kode-temp-reload S\n');
  });
});

/** 端到端假腿:内存文件 + 脚本化 reload 通道 + 入账式回显 */
const makeFakeLegs = (options: {
  content?: string;
  reloadResult?: boolean | Error;
  failRead?: boolean;
  failWriteOn?: (content: string) => boolean;
} = {}) => {
  const files = new Map<string, string>([['/ws/scripts/entities/fight/FightAI.py', options.content ?? 'class FightAI:\n    pass\n']]);
  const writes: Array<{ fsPath: string; content: string }> = [];
  const logs: string[] = [];
  const problems: Array<{ doc: string; message: string | null }> = [];
  const reloadCalls: string[] = [];
  const doc: TempEditReloadDoc = { fsPath: '/ws/scripts/entities/fight/FightAI.py', label: 'FightAI.py' };
  const deps: TempEditReloadDeps = {
    readFile: async () => {
      if (options.failRead) {
        throw new Error('EACCES: 读被拒');
      }
      const hit = files.get(doc.fsPath);
      if (hit === undefined) {
        throw new Error('ENOENT');
      }
      return hit;
    },
    writeFile: async (target, content) => {
      if (options.failWriteOn?.(content)) {
        throw new Error('ENOSPC: 写失败');
      }
      writes.push({ fsPath: target.fsPath, content });
      files.set(target.fsPath, content);
    },
    runReloadAction: async name => {
      reloadCalls.push(name);
      if (options.reloadResult instanceof Error) {
        throw options.reloadResult;
      }
      return options.reloadResult ?? true;
    },
    log: line => void logs.push(line),
    reportProblem: (target, message) => void problems.push({ doc: target.fsPath, message }),
    now: () => new Date('2026-10-23T08:00:00.000Z')
  };
  const settings: TempEditReloadSettings = {
    enabled: true,
    actionName: '热更新',
    autoRestore: true,
    scriptRoot: '/ws/scripts'
  };
  return { doc, deps, settings, files, writes, logs, problems, reloadCalls };
};

describe('runTempEditReload(端到端假腿:编辑→还原→reloadScript→回显)', () => {
  it('happy 路径:顺序=临时编辑→还原→reloadScript;回执=已发送(未确认),applied 恒 false', async () => {
    const ctx = makeFakeLegs();
    const outcome = await runTempEditReload(ctx.doc, ctx.settings, ctx.deps);

    expect(ctx.reloadCalls).toEqual(['热更新']);
    // 两次写:第一次带临时标记,第二次还原原文;且还原在 reload 之前
    expect(ctx.writes).toHaveLength(2);
    expect(ctx.writes[0].content).toContain(`# ${TEMP_EDIT_MARKER_TAG} 2026-10-23T08:00:00.000Z`);
    expect(ctx.writes[1].content).toBe('class FightAI:\n    pass\n');
    expect(outcome.phase).toBe('sent-unverified');
    expect(outcome.transportOk).toBe(true);
    expect(outcome.applied).toBe(false);
    expect(outcome.detail).toContain('未确认');
    expect(outcome.dualName).toEqual({
      fullModule: 'entities.fight.FightAI',
      requestModule: 'fight.FightAI',
      fileStem: 'FightAI',
      parentName: 'fight'
    });
    // 回显四步齐:编辑/还原/请求/结果,结果行如实报「未确认」不称「已热更新」
    expect(ctx.logs.some(line => line.includes('第 1 步'))).toBe(true);
    expect(ctx.logs.some(line => line.includes('第 2 步'))).toBe(true);
    expect(ctx.logs.some(line => line.includes('第 3 步 reloadScript'))).toBe(true);
    expect(ctx.logs[ctx.logs.length - 1]).toContain('已发送(未确认)');
    // 结果行不得把通道回执抬成 applied(拒绝「已应用/热更新成功」式宣称)
    expect(ctx.logs[ctx.logs.length - 1]).not.toMatch(/已应用|热更新成功|applied\s*[:=]\s*true/);
    // 问题通道:成功清除(最后一条 report 为 null)
    expect(ctx.problems[ctx.problems.length - 1].message).toBeNull();
    expect(ctx.files.get(ctx.doc.fsPath)).toBe('class FightAI:\n    pass\n');
  });

  it('autoRestore=false:临时编辑保留在盘上,回显如实记录跳过', async () => {
    const ctx = makeFakeLegs();
    const outcome = await runTempEditReload(ctx.doc, { ...ctx.settings, autoRestore: false }, ctx.deps);

    expect(outcome.phase).toBe('sent-unverified');
    expect(ctx.writes).toHaveLength(1);
    expect(ctx.files.get(ctx.doc.fsPath)).toContain(TEMP_EDIT_MARKER_TAG);
    expect(ctx.logs.some(line => line.includes('autoRestore=false'))).toBe(true);
  });

  it('读失败:中止且不发请求,问题通道报错', async () => {
    const ctx = makeFakeLegs({ failRead: true });
    const outcome = await runTempEditReload(ctx.doc, ctx.settings, ctx.deps);

    expect(outcome.phase).toBe('read-failed');
    expect(outcome.applied).toBe(false);
    expect(ctx.reloadCalls).toEqual([]);
    expect(ctx.writes).toEqual([]);
    expect(ctx.problems[0].message).toContain('读取原文件失败');
  });

  it('临时编辑写失败:中止且不发请求', async () => {
    const ctx = makeFakeLegs({ failWriteOn: content => content.includes(TEMP_EDIT_MARKER_TAG) });
    const outcome = await runTempEditReload(ctx.doc, ctx.settings, ctx.deps);

    expect(outcome.phase).toBe('edit-write-failed');
    expect(ctx.reloadCalls).toEqual([]);
    expect(ctx.problems[0].message).toContain('写入临时编辑失败');
  });

  it('还原失败:中止 reloadScript,不把带标记内容发给引擎,问题通道报手工恢复', async () => {
    const ctx = makeFakeLegs({ failWriteOn: content => !content.includes(TEMP_EDIT_MARKER_TAG) });
    const outcome = await runTempEditReload(ctx.doc, ctx.settings, ctx.deps);

    expect(outcome.phase).toBe('restore-failed');
    expect(ctx.reloadCalls).toEqual([]);
    expect(ctx.files.get(ctx.doc.fsPath)).toContain(TEMP_EDIT_MARKER_TAG);
    expect(ctx.problems[0].message).toContain('手工恢复');
  });

  it('reload 通道回执 false / 抛异常:phase=sent-failed,问题通道报错,永不宣称 applied', async () => {
    const flat = makeFakeLegs({ reloadResult: false });
    const flatOutcome = await runTempEditReload(flat.doc, flat.settings, flat.deps);
    expect(flatOutcome.phase).toBe('sent-failed');
    expect(flatOutcome.transportOk).toBe(false);
    expect(flatOutcome.applied).toBe(false);
    expect(flat.problems[0].message).toContain('回执 false');

    const throwing = makeFakeLegs({ reloadResult: new Error('连接被拒') });
    const throwingOutcome = await runTempEditReload(throwing.doc, throwing.settings, throwing.deps);
    expect(throwingOutcome.phase).toBe('sent-failed');
    expect(throwingOutcome.applied).toBe(false);
    expect(throwing.problems[0].message).toContain('连接被拒');
  });

  it('动作名留空:直接中止(不编辑不发请求),问题通道报配置错误', async () => {
    const ctx = makeFakeLegs();
    const outcome = await runTempEditReload(ctx.doc, { ...ctx.settings, actionName: '' }, ctx.deps);

    expect(outcome.phase).toBe('missing-action');
    expect(ctx.writes).toEqual([]);
    expect(ctx.reloadCalls).toEqual([]);
    expect(ctx.problems[0].message).toContain('actionName');
  });

  it('脚本根未配置:流程照走,回显模块名未解析(不猜名)', async () => {
    const ctx = makeFakeLegs();
    const outcome = await runTempEditReload(ctx.doc, { ...ctx.settings, scriptRoot: '' }, ctx.deps);

    expect(outcome.phase).toBe('sent-unverified');
    expect(outcome.dualName).toMatchObject({ unsupported: expect.stringContaining('scriptRoot') });
    expect(ctx.logs.some(line => line.includes('未解析'))).toBe(true);
  });
});
