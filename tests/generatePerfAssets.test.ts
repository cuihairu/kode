import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDefDocument } from '../src/backend/defParser';
import { buildDefChain } from '../src/backend/defChain';

// RUST-020 对抗性样例钉:生成器 adversarial 场景(深继承/循环别名/不完整
// XML/非 ASCII 路径/符号冲突)被真实解析通路消费——深链 50 层走通、Parent
// 环被 visited 截断不挂、截断 XML 容错不炸不挂、非 ASCII 路径在盘可读、
// 同名符号冲突双实现都在。生成器确定性(同参字节级一致)已在
// docs/perf/hardware.md §3 记录(sha256 全树比对)。

const generator = path.resolve(__dirname, '..', 'scripts', 'generate-perf-assets.mjs');
let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-perf-adversarial-'));
  execFileSync(process.execPath, [generator, '--only', 'adversarial', '--out', root], {
    stdio: 'pipe',
    timeout: 60_000
  });
}, 90_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const scenarioDir = (): string => path.join(root, 'adversarial', 'scripts');
const defsDir = (): string => path.join(scenarioDir(), 'entity_defs');

describe('generate-perf-assets adversarial 场景(RUST-020)', () => {
  it('深继承:def Parent 链 50 层全走通,无截断', () => {
    const info = buildDefChain(path.join(defsDir(), 'Chain50.def'));
    expect(info.cycleTruncated).toBe(false);
    expect(info.parentChain).toHaveLength(50);
    expect(info.parentChain[0].name).toBe('Chain49');
    expect(info.parentChain[49].name).toBe('Chain0');
  }, 30_000);

  it('Parent 环(LoopA↔LoopB):visited 截断不挂', () => {
    const info = buildDefChain(path.join(defsDir(), 'LoopA.def'));
    expect(info.cycleTruncated).toBe(true);
    expect(info.parentChain.length).toBeLessThanOrEqual(2);
  }, 30_000);

  it('循环类型别名(circular_alias.xml)可被解析通路读入,root 节点聚合双向环', () => {
    const text = fs.readFileSync(path.join(defsDir(), 'circular_alias.xml'), 'utf8');
    expect(text).toContain('<TYPE_A type="ARRAY" of="TYPE_B"/>');
    expect(text).toContain('<TYPE_B type="ARRAY" of="TYPE_A"/>');
    const document = parseDefDocument(text);
    // 节点模型:<root> 聚合为单节点,双向环在其 children 里(children 含
    // 文本片段等无名条目,按名字过滤后恰为环的两型)
    const rootChildren = document.nodes[0]?.children ?? [];
    const names = rootChildren.map(node => node?.name).filter(Boolean);
    expect(names).toEqual(['TYPE_A', 'TYPE_B']);
  }, 30_000);

  it('不完整 XML:两种截断形都在解析位抛错,生产调用方以 try/catch 跳过(defAnalyzer 口径)', () => {
    // 真实容错语义=解析器层对截断输入 throw(def:位置赋值段
    // consumeNextToken / entities:fast-xml-parser readTagExp),调用方
    // (defAnalyzer.ts:491-493 catch→continue 等)跳过坏文件;fixture 的
    // 价值=稳定到达两条 throw 路径,逼调用方保持兜底。
    const truncatedText = fs.readFileSync(path.join(defsDir(), 'Truncated.def'), 'utf8');
    expect(() => parseDefDocument(truncatedText)).toThrow(/Failed to locate XML token/);
    const brokenText = fs.readFileSync(path.join(scenarioDir(), 'broken_entities.xml'), 'utf8');
    expect(() => parseDefDocument(brokenText)).toThrow(/readTagExp|Failed to locate/);
  }, 30_000);

  it('非 ASCII 路径:CJK 目录/文件名在盘且 utf8 可读', () => {
    const pyPath = path.join(scenarioDir(), 'base', '怪物', '武器库', '宝剑.py');
    expect(fs.existsSync(pyPath)).toBe(true);
    expect(fs.readFileSync(pyPath, 'utf8')).toContain('class 宝剑:');
  }, 30_000);

  it('符号冲突:base/cell 同名 Avatar 类两套实现都在盘', () => {
    expect(fs.readFileSync(path.join(scenarioDir(), 'base', 'Avatar.py'), 'utf8')).toContain('def base_only');
    expect(fs.readFileSync(path.join(scenarioDir(), 'cell', 'Avatar.py'), 'utf8')).toContain('def cell_only');
  }, 30_000);
});
