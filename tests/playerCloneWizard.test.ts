// UX-REVIEW-005a/005c 克隆连接分步向导验收:
// - 005a:可前进(顺序步骤,标题带角色与步骤序号)、返回(摘要页「返回修改」
//   按字段重填,已输入非密码信息保留)、取消(任一步 Esc 整体放弃,不落盘);
// - 005c:不含密码的配置摘要(密码只报状态,绝不回显)、可选连接测试
//   (失败带原始原因,测试不落盘)、只有「保存」落盘,保存后可再次修改
//   (重新运行预填既有配置)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLONE_SUMMARY_CANCEL,
  CLONE_SUMMARY_EDIT,
  CLONE_SUMMARY_KEEP_SECRET,
  CLONE_SUMMARY_SAVE,
  CLONE_SUMMARY_TEST,
  runConfigureCloneProfileCommand,
  type PlayerCloneCommandDeps
} from '../src/backend/playerDataCloneCommands';
import type { CloneProfile, CloneProfileRole } from '../src/backend/playerDataCloneProfiles';
import type { CloneMysqlConnection } from '../src/backend/playerDataCloneMysql';

vi.mock('../src/backend/playerDataCloneMysql', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/backend/playerDataCloneMysql')>();
  return {
    ...actual,
    openCloneSession: vi.fn(),
    testCloneConnection: vi.fn()
  };
});

import { openCloneSession, testCloneConnection } from '../src/backend/playerDataCloneMysql';

// 010d:default 态(无 localize)=英文源串;两态锁定在 playerCloneI18n.test.ts
const HOST_PROMPT = 'Source database host';
const PASSWORD_PROMPT = 'Password (leave empty to remove the saved password)';

interface WizardScript {
  role?: CloneProfileRole;
  existing?: CloneProfile | null;
  inputs?: Array<string | undefined>;
  /** 摘要/字段选择;函数形式按 placeHolder 动态应答 */
  picks?: Array<
    | string
    | undefined
    | ((options: { placeHolder: string }) => string | undefined)
  >;
}

const makeWizard = (script: WizardScript = {}) => {
  const recorded = {
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
    saved: [] as Array<{ role: CloneProfileRole | string; config: unknown; password: unknown }>,
    inputOptions: [] as Array<{
      prompt: string;
      title?: string;
      value?: string;
      password?: boolean;
    }>,
    pickOptions: [] as Array<{ placeHolder: string }>,
    pickItems: [] as string[][]
  };
  const inputs = [...(script.inputs ?? [])];
  const picks = [...(script.picks ?? [])];
  const deps: PlayerCloneCommandDeps = {
    profiles: {
      get: () => script.existing ?? null,
      save: async (role, config, password) => {
        recorded.saved.push({ role, config, password });
      },
      resolveConnection: async () =>
        script.existing?.hasStoredSecret
          ? { host: script.existing.host, port: script.existing.port, user: script.existing.user, password: 'stored-pw', database: script.existing.database }
          : null
    } as unknown as PlayerCloneCommandDeps['profiles'],
    listEntityNames: () => [],
    resolveEntityTables: () => null,
    showQuickPick: async (items, options) => {
      recorded.pickOptions.push({ placeHolder: options.placeHolder });
      recorded.pickItems.push([...items]);
      const next = picks.shift();
      return typeof next === 'function' ? next(options) : next;
    },
    showInputBox: async options => {
      recorded.inputOptions.push(options);
      return inputs.shift();
    },
    showInformationMessage: async message => {
      recorded.info.push(message);
      return undefined;
    },
    showWarningMessage: async message => {
      recorded.warn.push(message);
      return undefined;
    },
    showErrorMessage: async message => {
      recorded.error.push(message);
      return undefined;
    },
    withProgress: async (_options, task) => await task({ isCancellationRequested: false }),
    pickArchiveSavePath: async () => undefined,
    pickArchiveOpenPath: async () => undefined,
    writeAuditFile: async () => '',
    listAuditFiles: async () => [],
    readAuditFile: async () => null,
    getKeyRoot: () => undefined,
    channel: { appendLine: () => undefined, show: () => undefined },
    now: () => 0
  };
  return { deps, recorded };
};

const wizardInputs = (over: Partial<Record<string, string>> = {}): string[] => [
  over.host ?? 'db.host',
  over.port ?? '3307',
  over.user ?? 'kbe',
  over.password ?? 'pw-typed',
  over.database ?? 'kbe_db'
];

const existingProfile = (over: Partial<CloneProfile> = {}): CloneProfile => ({
  host: 'old.host',
  port: 3306,
  user: 'old-user',
  database: 'old-db',
  hasStoredSecret: false,
  ...over
});

beforeEach(() => {
  vi.mocked(openCloneSession).mockReset();
  vi.mocked(testCloneConnection).mockReset();
});

describe('克隆连接向导:分步输入(UX-REVIEW-005a)', () => {
  it('步骤标题带角色与序号:Source 1/5..5/5;target 计环境共 6 步', async () => {
    const { deps, recorded } = makeWizard({ inputs: wizardInputs(), picks: [CLONE_SUMMARY_CANCEL] });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(recorded.inputOptions.map(options => options.title)).toEqual([
      'Source 1/5',
      'Source 2/5',
      'Source 3/5',
      'Source 4/5',
      'Source 5/5'
    ]);

    const target = makeWizard({
      role: 'target',
      inputs: [...wizardInputs(), 'local' as unknown as string].slice(0, 5),
      picks: ['local', CLONE_SUMMARY_CANCEL]
    });
    await runConfigureCloneProfileCommand(target.deps, 'target');
    expect(target.recorded.inputOptions.map(options => options.title)).toEqual([
      'Target 1/6',
      'Target 2/6',
      'Target 3/6',
      'Target 4/6',
      'Target 5/6'
    ]);
  });

  it('既有配置预填非密码字段;密码输入永不预填', async () => {
    const { deps, recorded } = makeWizard({
      existing: existingProfile({ hasStoredSecret: true }),
      inputs: ['', '', '', '', ''],
      picks: [CLONE_SUMMARY_CANCEL]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(recorded.inputOptions.map(options => options.value)).toEqual([
      'old.host',
      '3306',
      'old-user',
      undefined, // 密码:绝不回填
      'old-db'
    ]);
    expect(recorded.inputOptions[3].password).toBe(true);
  });

  it('返回修改:选中字段重填,预填当前草稿值,改后按新值保存', async () => {
    const { deps, recorded } = makeWizard({
      inputs: [...wizardInputs(), 'new.host'],
      picks: [
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder.includes(CLONE_SUMMARY_EDIT) ? HOST_PROMPT : CLONE_SUMMARY_SAVE),
        CLONE_SUMMARY_SAVE
      ]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    // 第 6 个输入框 = 返回修改重填 host,预填的是草稿旧值
    const revise = recorded.inputOptions[5];
    expect(revise.prompt).toBe(HOST_PROMPT);
    expect(revise.value).toBe('db.host');
    expect(recorded.saved[0]?.config).toMatchObject({ host: 'new.host', port: 3307 });
  });

  it('返回修改选密码:输入框 password 模式且不预填旧值', async () => {
    const { deps, recorded } = makeWizard({
      inputs: [...wizardInputs(), 'rotated-pw'],
      picks: [
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder.includes(CLONE_SUMMARY_EDIT) ? PASSWORD_PROMPT : CLONE_SUMMARY_SAVE),
        CLONE_SUMMARY_SAVE
      ]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    const revise = recorded.inputOptions[5];
    expect(revise.prompt).toBe(PASSWORD_PROMPT);
    expect(revise.password).toBe(true);
    expect(revise.value).toBeUndefined();
    expect(recorded.saved[0]?.password).toBe('rotated-pw');
  });

  it('返回修改 target 环境:local → test,按新环境保存', async () => {
    const envPrompt = 'Target environment (production and staging are not allowed)';
    const { deps, recorded } = makeWizard({
      role: 'target',
      inputs: wizardInputs(),
      picks: [
        'local',
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder.includes(CLONE_SUMMARY_EDIT) ? envPrompt : CLONE_SUMMARY_SAVE),
        'test',
        CLONE_SUMMARY_SAVE
      ]
    });
    await runConfigureCloneProfileCommand(deps, 'target');
    expect(recorded.saved[0]?.config).toMatchObject({ environment: 'test' });
  });

  it('返回修改时取消(Esc)→ 草稿不动,可继续保存原值', async () => {
    const { deps, recorded } = makeWizard({
      inputs: [...wizardInputs(), undefined],
      picks: [
        CLONE_SUMMARY_EDIT,
        options => (options.placeHolder.includes(CLONE_SUMMARY_EDIT) ? HOST_PROMPT : CLONE_SUMMARY_SAVE),
        CLONE_SUMMARY_SAVE
      ]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(recorded.saved[0]?.config).toMatchObject({ host: 'db.host', port: 3307 });
    expect(recorded.saved[0]?.password).toBe('pw-typed');
  });

  it('任一步取消仍不落盘(向导化后保持既有口径)', async () => {
    const { deps, recorded } = makeWizard({ inputs: wizardInputs({ database: undefined }) });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(recorded.saved).toHaveLength(0);
  });
});

describe('克隆连接向导:摘要与保存(UX-REVIEW-005c)', () => {
  it('摘要不含密码:连接参数齐全,密码只报「已输入」状态(不回显本体)', async () => {
    let summary = '';
    const { deps, recorded } = makeWizard({
      inputs: wizardInputs({ password: 'pw-never-echo' }),
      picks: [options => {
        summary = options.placeHolder;
        return CLONE_SUMMARY_CANCEL;
      }]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(summary).toContain('Source: Host db.host · Port 3307 · User kbe · Database kbe_db');
    expect(summary).toContain('Password: entered, applied on save (never echoed)');
    expect(summary).not.toContain('pw-never-echo');
    expect(recorded.saved).toHaveLength(0);
  });

  it('密码留空:已存密钥报「留空清除」,未存密钥报「未设置」', async () => {
    let summaryStored = '';
    const stored = makeWizard({
      existing: existingProfile({ hasStoredSecret: true }),
      inputs: ['', '', '', '', ''],
      picks: [options => {
        summaryStored = options.placeHolder;
        return CLONE_SUMMARY_CANCEL;
      }]
    });
    await runConfigureCloneProfileCommand(stored.deps, 'source');
    expect(summaryStored).toContain('Password: saved; leaving empty clears it');

    let summaryNone = '';
    const none = makeWizard({
      inputs: ['', '', '', '', ''],
      picks: [options => {
        summaryNone = options.placeHolder;
        return CLONE_SUMMARY_CANCEL;
      }]
    });
    await runConfigureCloneProfileCommand(none.deps, 'source');
    expect(summaryNone).toContain('Password: none yet');
  });

  it('摘要页取消:不落盘不提示(取消不得写入半成品)', async () => {
    const { deps, recorded } = makeWizard({ inputs: wizardInputs(), picks: [undefined] });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(recorded.saved).toHaveLength(0);
    expect(recorded.info).toHaveLength(0);
    expect(recorded.error).toHaveLength(0);
  });

  it('未知摘要选择按取消处理,绝不落盘', async () => {
    const { deps, recorded } = makeWizard({ inputs: wizardInputs(), picks: ['junk-item'] });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(recorded.saved).toHaveLength(0);
  });

  it('保留已存密码:仅在已存密钥且密码留空时出现,选中后旧密钥原样保留(005d)', async () => {
    const keepCase = makeWizard({
      existing: existingProfile({ hasStoredSecret: true }),
      inputs: ['new.host', '', '', '', ''],
      picks: [CLONE_SUMMARY_KEEP_SECRET]
    });
    await runConfigureCloneProfileCommand(keepCase.deps, 'source');
    expect(keepCase.recorded.pickItems.at(-1)).toContain(CLONE_SUMMARY_KEEP_SECRET);
    expect(keepCase.recorded.saved[0]?.password).toBeUndefined(); // undefined = 保留旧密钥
    expect(keepCase.recorded.saved[0]?.config).toMatchObject({ host: 'new.host' });
    expect(keepCase.recorded.info).toEqual(['Source connection saved.']);

    // 未存密钥 → 不出「保留」项
    const noKeep = makeWizard({
      inputs: wizardInputs({ password: '' }),
      picks: [CLONE_SUMMARY_CANCEL]
    });
    await runConfigureCloneProfileCommand(noKeep.deps, 'source');
    expect(noKeep.recorded.pickItems.at(-1)).not.toContain(CLONE_SUMMARY_KEEP_SECRET);

    // 密码已重输 → 不出「保留」项(输入值即覆盖语义)
    const typed = makeWizard({
      existing: existingProfile({ hasStoredSecret: true }),
      inputs: wizardInputs({ password: 'fresh-pw' }),
      picks: [CLONE_SUMMARY_CANCEL]
    });
    await runConfigureCloneProfileCommand(typed.deps, 'source');
    expect(typed.recorded.pickItems.at(-1)).not.toContain(CLONE_SUMMARY_KEEP_SECRET);
  });

  it('密钥面保存失败:如实报「保存失败」+ 原始原因,不虚报已保存(005d)', async () => {
    const failing = makeWizard({ inputs: wizardInputs(), picks: [CLONE_SUMMARY_SAVE] });
    (failing.deps.profiles as { save: unknown }).save = async () => {
      throw new Error('SecretStorage write refused');
    };
    await runConfigureCloneProfileCommand(failing.deps, 'source');
    expect(failing.recorded.error).toEqual(['Save failed: SecretStorage write refused']);
    expect(failing.recorded.info).toHaveLength(0);
  });

  it('摘要页「测试连接」:用草稿值建连,成功带版本,测试不落盘', async () => {
    const connection = { end: vi.fn(async () => undefined) } as unknown as CloneMysqlConnection;
    vi.mocked(openCloneSession).mockResolvedValue(connection);
    vi.mocked(testCloneConnection).mockResolvedValue({ ok: true, version: '8.0.36' });
    const { deps, recorded } = makeWizard({
      inputs: wizardInputs(),
      picks: [CLONE_SUMMARY_TEST, CLONE_SUMMARY_SAVE]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(vi.mocked(openCloneSession)).toHaveBeenCalledWith({
      host: 'db.host',
      port: 3307,
      user: 'kbe',
      password: 'pw-typed',
      database: 'kbe_db',
      environment: undefined
    });
    expect(recorded.info[0]).toContain('connection succeeded');
    expect(recorded.info[0]).toContain('8.0.36');
    expect(connection.end).toHaveBeenCalled();
    // 测试通过后再选「保存」才落盘(两次摘要选择)
    expect(recorded.saved).toHaveLength(1);
  });

  it('摘要页「测试连接」失败:错误带原始原因,失败后可继续选择保存或取消', async () => {
    vi.mocked(openCloneSession).mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3306'));
    const { deps, recorded } = makeWizard({
      inputs: wizardInputs(),
      picks: [CLONE_SUMMARY_TEST, CLONE_SUMMARY_CANCEL]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(recorded.error[0]).toContain('Connection failed');
    expect(recorded.error[0]).toContain('ECONNREFUSED');
    expect(recorded.saved).toHaveLength(0);
  });

  it('密码留空且已存密钥:测试连接按保存语义取既有密码', async () => {
    const connection = { end: vi.fn(async () => undefined) } as unknown as CloneMysqlConnection;
    vi.mocked(openCloneSession).mockResolvedValue(connection);
    vi.mocked(testCloneConnection).mockResolvedValue({ ok: false, reason: 'access denied' });
    const { deps } = makeWizard({
      existing: existingProfile({ hasStoredSecret: true }),
      inputs: ['', '', '', '', ''],
      picks: [CLONE_SUMMARY_TEST, CLONE_SUMMARY_CANCEL]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(vi.mocked(openCloneSession)).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'stored-pw' })
    );
  });

  it('保存成功提示后可再次修改:重跑命令预填刚保存的配置', async () => {
    const first = makeWizard({ inputs: wizardInputs(), picks: [CLONE_SUMMARY_SAVE] });
    await runConfigureCloneProfileCommand(first.deps, 'source');
    expect(first.recorded.info).toEqual(['Source connection saved.']);

    // 第二次运行:预填上次保存值,用户逐项回车确认(密码留空=不设)
    const second = makeWizard({
      existing: existingProfile({ host: 'db.host', port: 3307, user: 'kbe', database: 'kbe_db' }),
      inputs: ['db.host', '3307', 'kbe', '', 'kbe_db'],
      picks: [CLONE_SUMMARY_SAVE]
    });
    await runConfigureCloneProfileCommand(second.deps, 'source');
    expect(second.recorded.saved[0]?.config).toMatchObject({
      host: 'db.host',
      port: 3307,
      user: 'kbe',
      database: 'kbe_db'
    });
  });
});
