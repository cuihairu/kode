import { expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  getWorkspaceIndexYieldCountForTests,
  resetWorkspaceIndexYieldClockForTests,
  setWorkspaceIndexYieldSliceMsForTests,
  WorkspaceIndex
} from '../src/workspaceIndex';

// 2026-10-28 审核整改(EVT-012 冷路径):共享索引首扫的逐文件解析让出宿主
// (时间片口径:距上次让出不足 25ms 不让)——冷扫不再以整批同步块占住
// 事件循环;微任务级的假 fs readFile 下,旧码整趟首扫无宏任务边界,定时器
// 零心跳。2026-10-28 CI 现场修复:心跳断言不再依赖「本档密集 fixture 必超
// 一个 25ms 片」(快速 runner 整趟不足一片→仅首让出时定时器未到期→余下
// 解析在微任务排空中完成,clearInterval 先于 timers 阶段,ticks=0 机器
// 相对 flake);测试内置片长 0,让出→心跳机制验证变为确定性。

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
  setWorkspaceIndexYieldSliceMsForTests(0); // 每次批边界必让出:心跳确定性
  const index = new WorkspaceIndex();
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    const calls = await index.allEventCalls();
    expect(calls).toHaveLength(24 * 3000);
  } finally {
    clearInterval(timer);
    index.dispose();
    setWorkspaceIndexYieldSliceMsForTests(null); // 复位生产口径 25ms
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
  // 让出面:扫描横跨多个宏任务边界,1ms 定时器至少心跳一次
  // (旧码:整趟首扫单宏任务,定时器饿死恒 0)
  expect(ticks).toBeGreaterThan(0);
});

it('时间片让出(EVT-012 修订):小批文件不足一个切片不让出,冷窗不再逐文件跳宏任务', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  // 40 个 5 行小文件:整趟解析远小于一个 25ms 切片——时间片口径下让出
  // 应≤2 次(首让+至多再一片);逐文件双让出的旧码是 2×40=80 次,
  // 5000 文件冷扫即上万次宏任务跳转,把共享事件循环上的 python 首扫
  // /发现拖长一个数量级(2026-10-28 现场联合重验实测)。
  const files = Array.from({ length: 40 }, (_, i) => vscode.Uri.file(`/ws/tiny${i}.py`));
  const body = Buffer.from('value = 1\nvalue = 2\nvalue = 3\nvalue = 4\nvalue = 5\n');
  vscode.workspace.findFiles = async () => files;
  vscode.workspace.fs.readFile = async () => body;
  resetWorkspaceIndexYieldClockForTests();
  const index = new WorkspaceIndex();
  try {
    const calls = await index.allEventCalls();
    expect(calls).toHaveLength(0);
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
  expect(getWorkspaceIndexYieldCountForTests()).toBeLessThanOrEqual(2);
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
