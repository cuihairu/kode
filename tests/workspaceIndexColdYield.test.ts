import { expect, it } from 'vitest';
import * as vscode from 'vscode';
import { WorkspaceIndex } from '../src/workspaceIndex';

// 2026-10-28 审核整改(EVT-012 冷路径):共享索引首扫的逐文件解析让出宿主
// (每趟扫描间 setImmediate)——冷扫不再以整批同步块占住事件循环;微任务
// 级的假 fs readFile 下,旧码整趟首扫无宏任务边界,定时器零心跳。

const makeDenseFile = (events: number, prefix: string): Buffer => {
  const lines: string[] = [];
  for (let index = 0; index < events; index += 1) {
    lines.push(`self.addEvent(EV_${prefix}_${index}, self.on_${prefix}_${index})`);
  }
  return Buffer.from(lines.join('\n'));
};

it('冷首扫逐文件让出宿主,扫描期间事件循环仍有定时器心跳', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const files = Array.from({ length: 24 }, (_, i) => vscode.Uri.file(`/ws/cold${i}.py`));
  const body = makeDenseFile(3000, 'a'); // ~90KB/文件:两趟正则+行表实打实耗时
  vscode.workspace.findFiles = async () => files;
  vscode.workspace.fs.readFile = async () => body; // 微任务即决:无宏任务让出
  const index = new WorkspaceIndex();
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    const calls = await index.allEventCalls();
    expect(calls).toHaveLength(24 * 3000);
  } finally {
    clearInterval(timer);
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
  // 让出面:扫描横跨多个宏任务边界,1ms 定时器至少心跳一次
  // (旧码:整趟首扫单宏任务,定时器饿死恒 0)
  expect(ticks).toBeGreaterThan(0);
});

it('让出边界不改口径:稀疏事件行号仍按建索引时算好', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const uri = vscode.Uri.file('/ws/sparse.py');
  const lines: string[] = [];
  const markLines: number[] = [];
  for (let index = 0; index < 4000; index += 1) {
    if (index === 17 || index === 800 || index === 3999) {
      markLines.push(index);
      lines.push(`self.addEvent(EV_S_${index}, self.on_s_${index})`);
    } else {
      lines.push('value = 1');
    }
  }
  vscode.workspace.findFiles = async () => [uri];
  vscode.workspace.fs.readFile = async () => Buffer.from(lines.join('\n'));
  const index = new WorkspaceIndex();
  try {
    const calls = await index.allEventCalls();
    expect(calls).toHaveLength(3);
    expect(calls.map(call => call.line)).toEqual(markLines);
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
});
