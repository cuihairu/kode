import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Position, Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { makeTextDocument } from './helpers/vscodeStub';
import { EntityMappingManager } from '../src/entityMapping';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { PythonDefinitionProvider } from '../src/languageProviders';
import {
  clearRecentJumpLogs,
  getRecentJumpLogs,
  isJumpLogEnabled,
  jumpLog,
  setJumpLogEnabled
} from '../src/navigationLog';

// 跳转决策路径日志(用户 2026-10-16 主动要求):每次跳转把「查了哪几层、
// 每层结果、耗时」打到 KBEngine Navigation 通道,前缀 [kode-jump]。本测试
// 锁:命中与失败两条路径都留下完整决策链,且不倾倒整文件内容。

const FIXTURE = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');

const lineOf = (content: string, needle: string): number =>
  content.split('\n').findIndex(line => line.includes(needle));

describe('jumpLog 决策路径日志', () => {
  const ORIGINAL = stubWorkspace.findFiles;

  const realFindFiles = async (pattern?: string): Promise<Uri[]> => {
    const matches = pattern && pattern.includes('entities.xml')
      ? (name: string): boolean => name === 'entities.xml'
      : pattern && pattern.includes('*.def')
        ? (name: string): boolean => name.endsWith('.def')
        : pattern && pattern.includes('types.xml')
          ? (name: string): boolean => name === 'types.xml'
          : (name: string): boolean => name.endsWith('.py');
    const out: Uri[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (matches(entry.name)) {
          out.push(Uri.file(full));
        }
      }
    };
    walk(FIXTURE);
    return out;
  };

  afterEach(() => {
    stubWorkspace.findFiles = ORIGINAL;
    stubWorkspace.workspaceFolders = [];
    setJumpLogEnabled(false);
    clearRecentJumpLogs();
  });

  it('默认关闭:决策路径零输出(开关注入前)', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(FIXTURE), name: 'demo', index: 0 }];
    clearRecentJumpLogs();
    expect(isJumpLogEnabled()).toBe(false);

    const index = new PythonClassIndex();
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const provider = new PythonDefinitionProvider(manager, index);
    const file = path.join(FIXTURE, 'scripts', 'user_type', 'SKILL_SLOT_DATA.py');
    const text = fs.readFileSync(file, 'utf8');
    const callLine = lineOf(text, 'self.reindex()');
    await provider.provideDefinitionTraced(
      makeTextDocument(text, { fileName: file, languageId: 'python' }),
      new Position(callLine, text.split('\n')[callLine].indexOf('self.reindex') + 7)
    );
    expect(getRecentJumpLogs(), '开关默认关 → 一条日志都不出').toEqual([]);
    manager.dispose();
  }, 60_000);

  it('命中路径:开启后入口→对象类→层1落空→层2命中→落点与耗时齐打', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(FIXTURE), name: 'demo', index: 0 }];
    setJumpLogEnabled(true);
    clearRecentJumpLogs();

    const index = new PythonClassIndex();
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const provider = new PythonDefinitionProvider(manager, index);

    const file = path.join(FIXTURE, 'scripts', 'user_type', 'SKILL_SLOT_DATA.py');
    const text = fs.readFileSync(file, 'utf8');
    const callLine = lineOf(text, 'self.reindex()');
    const char = text.split('\n')[callLine].indexOf('self.reindex') + 7;
    await provider.provideDefinitionTraced(
      makeTextDocument(text, { fileName: file, languageId: 'python' }),
      new Position(callLine, char)
    );

    const logs = getRecentJumpLogs().join('\n');
    expect(logs).toMatch(/\[kode-jump\]\[info\] F12 .*SKILL_SLOT_DATA\.py:12/);
    expect(logs, '对象类应入日志').toContain('对象类=serializer_base');
    expect(logs).toMatch(/层1 entity-def 落空\(/);
    expect(logs, '层2 命中并给出落点与耗时').toMatch(/层2 python-mro 命中 → .*SKILL_SLOT_DATA\.py:16.*ms/);
    // 决策链之外不得倾倒整文件:每行封顶
    for (const line of getRecentJumpLogs()) {
      expect(line.length, `日志行超长(疑似倾倒文件): ${line.slice(0, 80)}…`).toBeLessThan(600);
    }
    manager.dispose();
  }, 60_000);

  it('失败路径:三层逐层落空 + 放弃点 + 总耗时', async () => {
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(FIXTURE), name: 'demo', index: 0 }];
    setJumpLogEnabled(true);
    clearRecentJumpLogs();

    const index = new PythonClassIndex();
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const provider = new PythonDefinitionProvider(manager, index);

    // Functor.self.func():func 是属性,不是任何类的方法 → 三层全落空
    const file = path.join(FIXTURE, 'scripts', 'common', 'Functor.py');
    const text = fs.readFileSync(file, 'utf8');
    const callLine = lineOf(text, 'self.func(');
    const char = text.split('\n')[callLine].indexOf('self.func(') + 7;
    const traced = await provider.provideDefinitionTraced(
      makeTextDocument(text, { fileName: file, languageId: 'python' }),
      new Position(callLine, char)
    );
    expect(traced.location).toBeNull();

    const logs = getRecentJumpLogs().join('\n');
    expect(logs).toMatch(/层1 entity-def 落空\(/);
    expect(logs).toMatch(/层2 python-mro 落空\(/);
    expect(logs).toMatch(/层3 file-scope 落空\(/);
    expect(logs, '放弃点与总耗时').toMatch(/跳转放弃: 三层全落空\(query=func\) 总耗时 \d+ms/);
    manager.dispose();
  }, 60_000);

  it('开关语义:关闭时消息函数零调用(零开销),开启后 info+debug 全量入通道', () => {
    clearRecentJumpLogs();
    setJumpLogEnabled(false);
    let evaluated = 0;
    jumpLog('info', () => {
      evaluated += 1;
      return 'must-not-evaluate-when-off';
    });
    expect(evaluated, '关闭时不得求值消息(不拼字符串)').toBe(0);
    expect(getRecentJumpLogs()).toEqual([]);

    setJumpLogEnabled(true);
    jumpLog('info', () => {
      evaluated += 1;
      return 'info-line-kept';
    });
    jumpLog('debug', 'debug-line-kept');
    expect(evaluated, '开启后才求值').toBe(1);
    const tail = getRecentJumpLogs().slice(-2).join('\n');
    expect(tail).toContain('[kode-jump][info] info-line-kept');
    expect(tail).toContain('[kode-jump][debug] debug-line-kept');
  });

  it('环形缓冲封顶:超 RECENT_LIMIT(400)条时滚动淘汰最旧,缓存不无界增长', () => {
    setJumpLogEnabled(true);
    clearRecentJumpLogs();
    for (let i = 0; i < 401; i += 1) {
      jumpLog('info', `line-${i}`);
    }
    const logs = getRecentJumpLogs();
    expect(logs.length, '缓冲恒 ≤ RECENT_LIMIT').toBe(400);
    expect(logs[0], '最旧一条已淘汰').toContain('line-1');
    expect(logs[0]).not.toContain('line-0');
    expect(logs[399], '最新一条保留').toContain('line-400');
  });
});
