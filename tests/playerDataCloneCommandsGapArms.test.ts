import { describe, expect, it } from 'vitest';
import {
  CLONE_SUMMARY_CANCEL,
  CLONE_SUMMARY_EDIT,
  CLONE_SUMMARY_SAVE,
  runConfigureCloneProfileCommand,
  runExportCloneCommand,
  type PlayerCloneCommandDeps
} from '../src/backend/playerDataCloneCommands';
import type { CloneProfileStore } from '../src/backend/playerDataCloneProfiles';

// playerDataCloneCommands 缺口臂(2026-11-09 覆盖率扫尾)。
//
// 已覆盖臂:
// - reviseDraftStep 端口/用户/数据库/主机 重填:输入框 answer !== undefined 的
//   写回分支(377/394/404/423)、各字段校验函数体(388-391/402/421/377)经
//   validateInput 实调;revise quickpick 取消(369)、env 标签在 source 角色被
//   脚本返回(427 守卫)、未知选择 default(433)。
// - runExportCloneCommand 的「Source 未配置 → 进向导 → 仍无配置」收尾(570,
//   含其前两行 568-569)。
//
// 死臂(证据):
// - 828(`if (!plan) return;`):plan 声明于 try 外(`let plan: ImportPlanWire | null
//   = null`),try 内每个出口要么 return(probe 失败 745/747、pass1 非 ok 776-783、
//   行读取非 ok 788-795、pass2 非 ok 816-821),要么 `plan = pass2.result`(822);
//   planCloneImport 的 status==='ok' 恒携带经 isImportPlan 门校验的非空结果
//   (playerDataCloneRust.toCall:guard 失败转 status:'error',不进 ok),故 827 的
//   `!plan` 恒假。该检查仅是 TS 对跨 try-finally 赋值的窄化守卫(编译期需要),
//   无运行时路径可达。

// 提示文案与源模块一致(localize 未注入 → t 恒等)。
const HOST_PROMPT = 'Source database host';
const PORT_PROMPT = 'Port (default 3306)';
const USER_PROMPT = 'Username';
const DATABASE_PROMPT = 'Database';
const ENV_PROMPT = 'Target environment (production and staging are not allowed)';

interface WizardScript {
  inputs?: Array<string | undefined>;
  picks?: Array<string | undefined | ((options: { placeHolder: string }) => string | undefined)>;
}

interface WizardRecord {
  saved: Array<{ role: string; config: unknown; password: unknown }>;
  info: string[];
  warn: Array<{ message: string; action?: string }>;
  error: string[];
  pickCount: number;
  inputCount: number;
  validateCalls: Array<string | null>;
}

/**
 * 向导替身:showInputBox 会实调 validateInput(探针值:端口步用
 * ['','abc','99999'] 以覆盖空串/非数字/越界三分支;其余步用 [''] 单触发),
 * 从而覆盖 reviseDraftStep 里各字段的校验函数体。
 */
const makeWizard = (script: WizardScript = {}): { deps: PlayerCloneCommandDeps; record: WizardRecord } => {
  const record: WizardRecord = {
    saved: [],
    info: [],
    warn: [],
    error: [],
    pickCount: 0,
    inputCount: 0,
    validateCalls: []
  };
  const inputs = [...(script.inputs ?? [])];
  const picks = [...(script.picks ?? [])];
  const deps: PlayerCloneCommandDeps = {
    profiles: {
      get: () => null,
      save: async (role, config, password) => {
        record.saved.push({ role, config, password });
      },
      resolveConnection: async () => null
    } as unknown as CloneProfileStore,
    listEntityNames: () => ['Avatar'],
    resolveEntityTables: () => [{ name: 'tbl_Avatar' }],
    showQuickPick: async (_items, options) => {
      record.pickCount += 1;
      const next = picks.shift();
      return typeof next === 'function' ? next(options) : next;
    },
    showInputBox: async options => {
      record.inputCount += 1;
      if (options.validateInput) {
        const probes = options.prompt.includes('Port') ? ['', 'abc', '99999'] : [''];
        for (const probe of probes) {
          record.validateCalls.push(options.validateInput(probe));
        }
      }
      return inputs.shift();
    },
    showInformationMessage: async message => {
      record.info.push(message);
      return undefined;
    },
    showWarningMessage: async (message, ..._actions) => {
      record.warn.push({ message });
      return undefined;
    },
    showErrorMessage: async message => {
      record.error.push(message);
      return undefined;
    },
    withProgress: async (_options, task) => task({ isCancellationRequested: false }),
    pickArchiveSavePath: async () => undefined,
    pickArchiveOpenPath: async () => undefined,
    writeAuditFile: async () => '',
    listAuditFiles: async () => [],
    readAuditFile: async () => null,
    getKeyRoot: () => undefined,
    channel: { appendLine: () => undefined, show: () => undefined },
    now: () => 0
  };
  return { deps, record };
};

const wizardInputs = (over: Partial<Record<string, string>> = {}): string[] => [
  over.host ?? 'db.host',
  over.port ?? '3307',
  over.user ?? 'kbe',
  over.password ?? 'pw-typed',
  over.database ?? 'kbe_db'
];

describe('playerDataCloneCommands 缺口臂:reviseDraftStep 各字段重填(端口/主机/用户/数据库)', () => {
  it('重填端口:校验函数体实调(空串/非数字/越界三分支),answer 定义写回 3308', async () => {
    const { deps, record } = makeWizard({
      inputs: [...wizardInputs(), '3308'],
      picks: [
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder === CLONE_SUMMARY_EDIT ? PORT_PROMPT : CLONE_SUMMARY_SAVE),
        CLONE_SUMMARY_SAVE
      ]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    // 端口 validate 探针结果:''→null(空串过)、'abc'→非数字错、'99999'→越界错
    expect(record.validateCalls).toContain(null);
    expect(record.validateCalls).toContain('Port must be a number');
    expect(record.validateCalls).toContain('Port must be between 1 and 65535');
    expect(record.saved).toHaveLength(1);
    expect(record.saved[0].config).toMatchObject({ port: 3308 });
  });

  it('重填主机:校验函数体实调,answer 定义写回 new.host', async () => {
    const { deps, record } = makeWizard({
      inputs: [...wizardInputs(), 'new.host'],
      picks: [
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder === CLONE_SUMMARY_EDIT ? HOST_PROMPT : CLONE_SUMMARY_SAVE),
        CLONE_SUMMARY_SAVE
      ]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(record.validateCalls).toContain('Enter a host address');
    expect(record.saved).toHaveLength(1);
    expect(record.saved[0].config).toMatchObject({ host: 'new.host' });
  });

  it('重填用户:校验函数体实调,answer 定义写回 new-user', async () => {
    const { deps, record } = makeWizard({
      inputs: [...wizardInputs(), 'new-user'],
      picks: [
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder === CLONE_SUMMARY_EDIT ? USER_PROMPT : CLONE_SUMMARY_SAVE),
        CLONE_SUMMARY_SAVE
      ]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(record.validateCalls).toContain('Enter a username');
    expect(record.saved).toHaveLength(1);
    expect(record.saved[0].config).toMatchObject({ user: 'new-user' });
  });

  it('重填数据库:校验函数体实调,answer 定义写回 new-db', async () => {
    const { deps, record } = makeWizard({
      inputs: [...wizardInputs(), 'new-db'],
      picks: [
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder === CLONE_SUMMARY_EDIT ? DATABASE_PROMPT : CLONE_SUMMARY_SAVE),
        CLONE_SUMMARY_SAVE
      ]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(record.validateCalls).toContain('Enter a database name');
    expect(record.saved).toHaveLength(1);
    expect(record.saved[0].config).toMatchObject({ database: 'new-db' });
  });
});

describe('playerDataCloneCommands 缺口臂:reviseDraftStep 取消/env 标签不匹配/default', () => {
  it('重填 quickpick 取消(369)、env 标签在 source 被脚本返回(427)、未知选择 default(433)', async () => {
    const { deps, record } = makeWizard({
      inputs: wizardInputs(),
      picks: [
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder === CLONE_SUMMARY_EDIT ? undefined : CLONE_SUMMARY_CANCEL), // 369:重填取消
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder === CLONE_SUMMARY_EDIT ? ENV_PROMPT : CLONE_SUMMARY_CANCEL), // 427:source 角色撞 env 标签
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder === CLONE_SUMMARY_EDIT ? 'junk-item' : CLONE_SUMMARY_CANCEL), // 433:未知选择
        CLONE_SUMMARY_CANCEL
      ]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    // 三次重填都未保存(每次编辑后回到摘要,最终取消)
    expect(record.saved).toHaveLength(0);
    expect(record.error).toHaveLength(0);
  });
});

describe('playerDataCloneCommands 缺口臂:导出未配置 Source 且向导后仍无配置(568-570)', () => {
  it('Source 未配置 → 进向导(首步取消)→ 仍未配置 → 570 return,不弹实体选择不建连', async () => {
    const { deps, record } = makeWizard({
      inputs: [undefined], // 向导首步即取消
      picks: []
    });
    // 覆盖 showWarningMessage 返回动作(进入向导)
    const warningActions: string[] = [];
    deps.showWarningMessage = async (message, action) => {
      record.warn.push({ message, action });
      warningActions.push(action ?? '');
      return action;
    };
    await runExportCloneCommand(deps);
    expect(warningActions).toEqual(['Configure source connection']);
    // 向导被拉起(输入框弹出)但首步取消 → 未配置 → 570 return:
    expect(record.inputCount).toBeGreaterThan(0);
    // 不弹实体选择、不建连、无错误提示
    expect(record.pickCount).toBe(0);
    expect(record.error).toHaveLength(0);
  });
});
