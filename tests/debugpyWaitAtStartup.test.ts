import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WAIT_BOOTSTRAP_BEGIN,
  WAIT_BOOTSTRAP_END,
  buildWaitBootstrapBlock,
  injectWaitBootstrap,
  removeWaitBootstrap,
  findEngineEntryScript,
  applyWaitAtStartupEnv
} from '../src/debugpyWaitAtStartup';
import { configurationOverrides } from './helpers/vscodeStub';

// IDE-DBG-004 启动前等待调试器连接:kbengine.debug.waitAtStartup 显式
// opt-in——入口脚本(scripts/kbengine.py)顶部插带标记的引导块(读
// KODE_DEBUGPY_WAIT_PORT,listen+wait_for_client,任何异常静默放行不阻塞
// 启动),serverManager 启动默认实例时按端口表注入该环境变量;off 命令
// 删块逐字节还原。不依赖启动后 telnet 注入。

let root = '';
let entry = '';

const writeEntry = (text: string): string => {
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  entry = path.join(root, 'scripts', 'kbengine.py');
  fs.writeFileSync(entry, text, 'utf8');
  return entry;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-wait-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  configurationOverrides.delete('kbengine');
});

describe('引导块文本', () => {
  it('含起止标记、环境变量键、listen+wait 与静默兜底', () => {
    const block = buildWaitBootstrapBlock();
    expect(block).toContain(WAIT_BOOTSTRAP_BEGIN);
    expect(block).toContain(WAIT_BOOTSTRAP_END);
    expect(block).toContain('KODE_DEBUGPY_WAIT_PORT');
    expect(block).toContain('debugpy.listen');
    expect(block).toContain('debugpy.wait_for_client()');
    // 缺包/无环境变量都静默放行,绝不阻塞引擎启动
    expect(block).toContain('except Exception:');
    expect(block.trimEnd().split('\n').length).toBeGreaterThanOrEqual(9);
  });
});

describe('入口脚本发现', () => {
  it('scripts/entity_defs 同级的 kbengine.py 即入口;缺失如实 null', () => {
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'kbengine.py'), 'pass\n', 'utf8');
    expect(findEngineEntryScript(root)).toBe(path.join(root, 'scripts', 'kbengine.py'));

    const bare = path.join(root, 'other');
    fs.mkdirSync(path.join(bare, 'scripts', 'entity_defs'), { recursive: true });
    expect(findEngineEntryScript(bare)).toBeNull();
  });
});

describe('注入与移除(真实临时文件)', () => {
  const head = ['#!/usr/bin/env python3', '# -*- coding: utf-8 -*-', '"""模块说明。', '第二行。', '"""', ''];
  const body = ['import kbengine', '', 'print("boot")', ''];
  const original = [...head, ...body].join('\n');

  it('块插在 docstring 之后,头与正文原样保留', () => {
    writeEntry(original);
    const result = injectWaitBootstrap(entry);
    expect(result.status).toBe('written');

    const text = fs.readFileSync(entry, 'utf8');
    const docEnd = text.indexOf('"""', text.indexOf('"""') + 3) + 3;
    expect(text.indexOf(WAIT_BOOTSTRAP_BEGIN)).toBeGreaterThan(docEnd);
    expect(text).toContain('import kbengine');
    expect(text.startsWith(head.join('\n'))).toBe(true);
  });

  it('幂等:已注入再注入零写入(unchanged)', () => {
    writeEntry(original);
    injectWaitBootstrap(entry);
    const once = fs.readFileSync(entry, 'utf8');
    const again = injectWaitBootstrap(entry);
    expect(again.status).toBe('unchanged');
    expect(fs.readFileSync(entry, 'utf8')).toBe(once);
  });

  it('块外用户编辑保留:重注入零写入(块未变),用户改动在且块唯一', () => {
    writeEntry(original);
    injectWaitBootstrap(entry);
    const edited = fs.readFileSync(entry, 'utf8').replace('print("boot")', 'print("edited")');
    fs.writeFileSync(entry, edited, 'utf8');

    expect(injectWaitBootstrap(entry).status).toBe('unchanged');
    expect(fs.readFileSync(entry, 'utf8')).toContain('print("edited")');
    expect(fs.readFileSync(entry, 'utf8').match(new RegExp(WAIT_BOOTSTRAP_BEGIN.slice(0, 24), 'g'))?.length).toBe(1);
  });

  it('移除:逐字节还原原文', () => {
    writeEntry(original);
    injectWaitBootstrap(entry);
    expect(removeWaitBootstrap(entry).status).toBe('removed');
    expect(fs.readFileSync(entry, 'utf8')).toBe(original);
  });

  it('移除无块:absent 零写入', () => {
    writeEntry(original);
    const result = removeWaitBootstrap(entry);
    expect(result.status).toBe('absent');
    expect(fs.readFileSync(entry, 'utf8')).toBe(original);
  });

  it('入口不存在:注入如实 error 不抛', () => {
    const result = injectWaitBootstrap(path.join(root, 'nope', 'kbengine.py'));
    expect(result.status).toBe('error');
  });
});

describe('applyWaitAtStartupEnv(启动环境变量)', () => {
  it('默认关:任何组件不带 KODE_DEBUGPY_WAIT_PORT', () => {
    const env: NodeJS.ProcessEnv = {};
    applyWaitAtStartupEnv(env, 'baseapp');
    expect(env.KODE_DEBUGPY_WAIT_PORT).toBeUndefined();
  });

  it('开+表内组件:带表口', () => {
    configurationOverrides.set('kbengine', { 'debug.waitAtStartup': true });
    const env: NodeJS.ProcessEnv = {};
    applyWaitAtStartupEnv(env, 'baseapp');
    expect(env.KODE_DEBUGPY_WAIT_PORT).toBe('5678');
  });

  it('开+表外组件(machine):不带,静默', () => {
    configurationOverrides.set('kbengine', { 'debug.waitAtStartup': true });
    const env: NodeJS.ProcessEnv = {};
    applyWaitAtStartupEnv(env, 'machine');
    expect(env.KODE_DEBUGPY_WAIT_PORT).toBeUndefined();
  });
});
