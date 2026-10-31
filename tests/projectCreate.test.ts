import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { createMinimalProject } from '../src/projectCreate';
import { writeFileAtomic } from '../src/atomicFileWrite';
import { MINIMAL_PROJECT_TEMPLATE } from '../src/projectTemplate';
import { ProjectProfileStore } from '../src/projectProfiles';
import { Uri, window as stubWindow } from './helpers/vscodeStub';

// IDE-PRJ-008:最小项目创建命令。IDE-PRJ-007 的清单接到命令面:
// 选目标根→预检冲突(已有目标直接拒绝不出预览)→确认面预览(生成器同一
// QuickPick 面)→落盘(目录递归建/文件原子写)→失败回收本次新增(逆序
// 删文件再逆序删空目录)→成功后按导入同一识别链建 profile。取消零写入。

class MemoryMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  setKeysForSync(_keys: readonly string[]): void {
    // 内存替身不参与云同步
  }
}

describe('minimal project create flow (IDE-PRJ-008)', () => {
  const windowish = stubWindow as unknown as Record<string, unknown>;
  const originalWindow: Record<string, unknown> = {};
  const windowKeys = ['showOpenDialog', 'showQuickPick', 'showInformationMessage', 'showErrorMessage'];
  const info: string[] = [];
  const errors: string[] = [];

  const pickConfirm = (): void => {
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = (await items) as Array<{ label: string; description: string }>;
      // 预览面与生成器同一确认行,计划项逐条在场
      expect(resolved[0].label).toBe('确认生成');
      expect(resolved).toHaveLength(MINIMAL_PROJECT_TEMPLATE.length + 1);
      return resolved[0];
    };
  };

  beforeAll(() => {
    for (const key of windowKeys) {
      originalWindow[key] = windowish[key];
    }
  });

  afterAll(() => {
    for (const key of windowKeys) {
      if (originalWindow[key] === undefined) {
        delete windowish[key];
      } else {
        windowish[key] = originalWindow[key];
      }
    }
  });

  it('materializes the template, creates the profile, and reports it', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-'));
    const targetRoot = path.join(base, 'newproj');
    const memento = new MemoryMemento();
    windowish.showOpenDialog = async () => [Uri.file(targetRoot)];
    pickConfirm();
    windowish.showInformationMessage = async (message: string): Promise<unknown> => {
      info.push(message);
      return undefined;
    };
    windowish.showErrorMessage = async (message: string): Promise<unknown> => {
      errors.push(message);
      return undefined;
    };

    await createMinimalProject(
      { workspaceState: memento },
      { resolveInterpreter: () => ({ interpreterPath: '/opt/py/python3', interpreterSource: 'path' }) }
    );

    // 清单全数落盘:目录在,文件内容逐字节
    expect(fs.existsSync(path.join(targetRoot, 'scripts', 'base'))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, 'scripts', 'cell'))).toBe(true);
    expect(fs.readFileSync(path.join(targetRoot, 'scripts', 'entities.xml'), 'utf8')).toBe('<root>\n</root>\n');
    expect(fs.readFileSync(path.join(targetRoot, 'scripts', 'entity_defs', 'types.xml'), 'utf8')).toBe(
      '<root>\n</root>\n'
    );

    // 成功即建档:与导入同一 store,识别链吃真盘(引擎仓不在模板,如实空)
    const profiles = new ProjectProfileStore(memento).list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      displayName: 'newproj',
      assetsRoot: targetRoot,
      engineRoot: '',
      interpreterPath: '/opt/py/python3',
      interpreterSource: 'path'
    });
    expect(info.at(-1)).toContain('已创建最小项目 profile');
    expect(errors).toHaveLength(0);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('refuses without a preview when any target already exists', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-conflict-'));
    const targetRoot = path.join(base, 'occupied');
    fs.mkdirSync(path.join(targetRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, 'scripts', 'entities.xml'), '既有内容', 'utf8');
    const memento = new MemoryMemento();
    let quickPickCalls = 0;
    windowish.showOpenDialog = async () => [Uri.file(targetRoot)];
    windowish.showQuickPick = async (): Promise<unknown> => {
      quickPickCalls += 1;
      return undefined;
    };
    windowish.showErrorMessage = async (message: string): Promise<unknown> => {
      errors.push(message);
      return undefined;
    };

    await createMinimalProject({ workspaceState: memento });

    // 冲突直接拒绝:不出预览,不动盘,不建档
    expect(quickPickCalls).toBe(0);
    expect(errors.some(message => message.includes(path.join(targetRoot, 'scripts', 'entities.xml')))).toBe(true);
    expect(fs.readFileSync(path.join(targetRoot, 'scripts', 'entities.xml'), 'utf8')).toBe('既有内容');
    expect(fs.existsSync(path.join(targetRoot, 'scripts', 'entity_defs'))).toBe(false);
    expect(new ProjectProfileStore(memento).list()).toHaveLength(0);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('is a no-op when the folder dialog is dismissed', async () => {
    const memento = new MemoryMemento();
    let quickPickCalls = 0;
    windowish.showOpenDialog = async () => undefined;
    windowish.showQuickPick = async (): Promise<unknown> => {
      quickPickCalls += 1;
      return undefined;
    };

    await createMinimalProject({ workspaceState: memento });

    expect(quickPickCalls).toBe(0);
    expect(new ProjectProfileStore(memento).list()).toHaveLength(0);
  });

  it('cancels at the preview without writing anything', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-cancel-'));
    const targetRoot = path.join(base, 'proj');
    const memento = new MemoryMemento();
    windowish.showOpenDialog = async () => [Uri.file(targetRoot)];
    windowish.showQuickPick = async (): Promise<unknown> => undefined;

    await createMinimalProject({ workspaceState: memento });

    expect(fs.existsSync(targetRoot)).toBe(false);
    expect(new ProjectProfileStore(memento).list()).toHaveLength(0);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('rolls back everything created this run when a file write fails midway', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-rollback-'));
    const targetRoot = path.join(base, 'proj');
    const memento = new MemoryMemento();
    windowish.showOpenDialog = async () => [Uri.file(targetRoot)];
    pickConfirm();
    windowish.showErrorMessage = async (message: string): Promise<unknown> => {
      errors.push(message);
      return undefined;
    };
    windowish.showInformationMessage = async (): Promise<unknown> => undefined;

    // 只拦第二个文件的写:此前已建的目录与已写的 entities.xml 都要被回收
    await createMinimalProject({ workspaceState: memento }, {
      writeFile: (filePath: string, content: string): void => {
        if (filePath.endsWith(path.join('entity_defs', 'types.xml'))) {
          throw new Error('模拟写入中断');
        }
        writeFileAtomic(filePath, content);
      }
    });

    expect(fs.existsSync(targetRoot)).toBe(false);
    expect(errors.some(message => message.includes('创建失败') && message.includes('回收'))).toBe(true);
    expect(new ProjectProfileStore(memento).list()).toHaveLength(0);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('rejects the whole creation when a target appears during the preview (R2-F08)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-concurrent-'));
    const targetRoot = path.join(base, 'proj');
    const memento = new MemoryMemento();
    errors.length = 0;
    info.length = 0;
    windowish.showOpenDialog = async () => [Uri.file(targetRoot)];
    // 预览确认期间另一来源并发建出 entities.xml:落盘前重查必须整次拒绝
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = (await items) as Array<{ label: string }>;
      fs.mkdirSync(path.join(targetRoot, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(targetRoot, 'scripts', 'entities.xml'), '并发新增内容', 'utf8');
      return resolved[0];
    };
    windowish.showErrorMessage = async (message: string): Promise<unknown> => {
      errors.push(message);
      return undefined;
    };
    windowish.showInformationMessage = async (): Promise<unknown> => undefined;

    await createMinimalProject({ workspaceState: memento });

    // 整次拒绝:并发的 entities.xml 字节原样,其他清单项一个都不落,不建档
    expect(
      errors.some(
        message =>
          message.includes('目标已存在') && message.includes(path.join(targetRoot, 'scripts', 'entities.xml'))
      )
    ).toBe(true);
    // 并发的 entities.xml 连同其父目录 scripts(同为清单目标)一并如实摊开
    expect(errors).toHaveLength(2);
    expect(fs.readFileSync(path.join(targetRoot, 'scripts', 'entities.xml'), 'utf8')).toBe('并发新增内容');
    expect(fs.existsSync(path.join(targetRoot, 'scripts', 'entity_defs'))).toBe(false);
    expect(fs.existsSync(path.join(targetRoot, 'scripts', 'base'))).toBe(false);
    expect(fs.existsSync(path.join(targetRoot, 'scripts', 'cell'))).toBe(false);
    expect(new ProjectProfileStore(memento).list()).toHaveLength(0);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('rollback leaves a file another source replaced after we wrote it (R2-F08)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-replace-'));
    const targetRoot = path.join(base, 'proj');
    const memento = new MemoryMemento();
    errors.length = 0;
    info.length = 0;
    windowish.showOpenDialog = async () => [Uri.file(targetRoot)];
    pickConfirm();
    windowish.showErrorMessage = async (message: string): Promise<unknown> => {
      errors.push(message);
      return undefined;
    };
    windowish.showInformationMessage = async (): Promise<unknown> => undefined;

    await createMinimalProject({ workspaceState: memento }, {
      writeFile: (filePath: string, content: string): void => {
        if (filePath.endsWith(path.join('entity_defs', 'types.xml'))) {
          throw new Error('模拟写入中断');
        }
        writeFileAtomic(filePath, content);
        // 模拟本进程写入后、回滚前,另一来源替换了刚写出的 entities.xml
        if (filePath.endsWith(path.join('scripts', 'entities.xml'))) {
          fs.writeFileSync(filePath, '他人并发替换的内容', 'utf8');
        }
      }
    });

    // 字节不再匹配本次写入:他人新增不被回收,如实留下
    expect(fs.readFileSync(path.join(targetRoot, 'scripts', 'entities.xml'), 'utf8')).toBe('他人并发替换的内容');
    expect(errors.some(message => message.includes('创建失败') && message.includes('回收'))).toBe(true);
    expect(new ProjectProfileStore(memento).list()).toHaveLength(0);

    fs.rmSync(base, { recursive: true, force: true });
  });
});
