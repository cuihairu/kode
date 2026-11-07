import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  isEmptyWorkspaceRoot,
  maybeOfferDemoGameScaffold,
  shouldOfferDemoGameScaffold
} from '../src/demoGameScaffoldPrompt';

// DEMO-GAME-006:空工程提示面。触发条件从严——恰好一个工作区文件夹且根下
// 无非点入口(只剩 .git/.vscode 视为空);点按钮走与命令面板同一条
// kbengine.project.createDemoGame。提示失败静默,不扰动激活。

const folder = (fsPath: string): { uri: { fsPath: string } } => ({ uri: { fsPath } });

describe('empty workspace detection (DEMO-GAME-006)', () => {
  it('offers only for a single workspace folder whose root has no non-dot entries', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-empty-ws-'));
    try {
      const emptyDir = path.join(base, 'empty');
      const dotOnlyDir = path.join(base, 'dot-only');
      const busyDir = path.join(base, 'busy');
      fs.mkdirSync(emptyDir);
      fs.mkdirSync(path.join(dotOnlyDir, '.git'), { recursive: true });
      fs.mkdirSync(busyDir, { recursive: true });
      fs.writeFileSync(path.join(busyDir, 'notes.txt'), 'x', 'utf8');

      expect(isEmptyWorkspaceRoot(emptyDir)).toBe(true);
      expect(isEmptyWorkspaceRoot(dotOnlyDir)).toBe(true);
      expect(isEmptyWorkspaceRoot(busyDir)).toBe(false);
      expect(isEmptyWorkspaceRoot(undefined)).toBe(false);
      expect(isEmptyWorkspaceRoot(path.join(base, 'no-such-dir'))).toBe(false);

      expect(shouldOfferDemoGameScaffold([folder(emptyDir)])).toBe(true);
      expect(shouldOfferDemoGameScaffold([folder(dotOnlyDir)])).toBe(true);
      expect(shouldOfferDemoGameScaffold([folder(busyDir)])).toBe(false);
      // 多根/零根都不打扰
      expect(shouldOfferDemoGameScaffold([folder(emptyDir), folder(dotOnlyDir)])).toBe(false);
      expect(shouldOfferDemoGameScaffold(undefined)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('scaffold prompt wiring (DEMO-GAME-006)', () => {
  const makeDeps = (
    folders: { uri: { fsPath: string } }[] | undefined,
    pick: string | undefined
  ) => {
    const messages: string[] = [];
    const executedCommands: string[] = [];
    return {
      deps: {
        readdirSync: (dirPath: string) => fs.readdirSync(dirPath),
        workspaceFolders: folders,
        showInformationMessage: async (message: string): Promise<string | undefined> => {
          messages.push(message);
          return pick;
        },
        executeCommand: async (command: string): Promise<unknown> => {
          executedCommands.push(command);
          return undefined;
        }
      },
      messages,
      executedCommands
    };
  };

  it('prompts on an empty workspace and runs the scaffold command when accepted', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-prompt-accept-'));
    try {
      const { deps, messages, executedCommands } = makeDeps([folder(base)], '创建 demo 游戏');
      await maybeOfferDemoGameScaffold(deps);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('空工程');
      expect(executedCommands).toEqual(['kbengine.project.createDemoGame']);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not prompt on a non-empty workspace, and dismissal runs nothing', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-prompt-quiet-'));
    try {
      fs.writeFileSync(path.join(base, 'main.py'), 'print(1)\n', 'utf8');
      const quiet = makeDeps([folder(base)], '创建 demo 游戏');
      await maybeOfferDemoGameScaffold(quiet.deps);
      expect(quiet.messages).toHaveLength(0);
      expect(quiet.executedCommands).toHaveLength(0);

      // 空工程但用户关掉提示:零命令
      const emptyDir = path.join(base, 'inner-empty');
      fs.mkdirSync(emptyDir);
      const dismissed = makeDeps([folder(emptyDir)], undefined);
      await maybeOfferDemoGameScaffold(dismissed.deps);
      expect(dismissed.messages).toHaveLength(1);
      expect(dismissed.executedCommands).toHaveLength(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('swallows prompt-surface failures without throwing', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-prompt-error-'));
    try {
      await expect(
        maybeOfferDemoGameScaffold({
          readdirSync: () => fs.readdirSync(base),
          workspaceFolders: [folder(base)],
          showInformationMessage: (): Promise<string | undefined> => {
            throw new Error('窗口面故障');
          },
          executeCommand: async () => undefined
        })
      ).resolves.toBeUndefined();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
