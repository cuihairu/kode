import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EventCodeLensProvider } from '../src/eventApi';
import { type EventCallIndex, type IndexedEventCall } from '../src/eventIndexTypes';
import { makeTextDocument } from './fake-vscode/core';

// IDE-ARC-002 事件索引小接口化:纯数据类型(EventCall/IndexedEventCall)与消费接口
// (EventCallIndex)只住 eventIndexTypes.ts(无 vscode 依赖);事件语法分析(eventApi)
// 不再 import WorkspaceIndex——provider 只通过 allEventCalls 一个成员消费索引,
// WorkspaceIndex 只是该接口的一个实现(implements 锁定)。

const root = join(__dirname, '..');

describe('事件索引小接口(IDE-ARC-002)', () => {
  it('provider 只依赖小接口:最小桩索引(无 WorkspaceIndex)即可驱动监听 CodeLens', async () => {
    const stub: EventCallIndex = {
      allEventCalls: async () => [
        {
          file: '/ws/entity.py',
          call: { api: 'addEvent', event: 'ev_ready', callback: 'on_ready', eventOffset: 0, callbackOffset: 0 },
          line: 3,
        } satisfies IndexedEventCall,
      ],
    };
    const doc = makeTextDocument('self.emitEvent("ev_ready")\n', { fileName: '/ws/emit.py', languageId: 'python' }) as unknown as vscode.TextDocument;
    const lenses = await new EventCodeLensProvider(stub).provideCodeLenses(doc);
    const listenerLens = lenses.find(lens => ((lens.command as { title: string }).title).includes('1 处监听'));
    expect(listenerLens).toBeTruthy();
    const args = (listenerLens!.command as { arguments: Array<{ fsPath?: string }> }).arguments;
    expect(args[0]).toMatchObject({ fsPath: '/ws/entity.py' });
  });

  it('eventApi 不再依赖 workspaceIndex(反向边切断),索引类型改从小接口模块取', () => {
    const eventApi = readFileSync(join(root, 'src/eventApi.ts'), 'utf8');
    expect(eventApi.includes("from './workspaceIndex'"), 'eventApi 仍 import workspaceIndex').toBe(false);
    expect(eventApi.includes("from './eventIndexTypes'"), 'eventApi 应改用 eventIndexTypes').toBe(true);
  });

  it('eventIndexTypes 是纯数据模块:不 import vscode;旧定义面删净,WorkspaceIndex implements 小接口', () => {
    const types = readFileSync(join(root, 'src/eventIndexTypes.ts'), 'utf8');
    expect(types.includes("from 'vscode'")).toBe(false);
    expect(types.match(/export type EventCall\b/)).toBeTruthy();
    expect(types.match(/export interface IndexedEventCall\b/)).toBeTruthy();
    expect(types.match(/export interface EventCallIndex\b/)).toBeTruthy();
    const workspaceIndex = readFileSync(join(root, 'src/workspaceIndex.ts'), 'utf8');
    expect(workspaceIndex.match(/export interface IndexedEventCall/), 'workspaceIndex 仍本地定义 IndexedEventCall').toBe(null);
    expect(workspaceIndex.includes('implements EventCallIndex')).toBe(true);
  });
});
