/**
 * postDestroy Rust↔TS 行为对拍(AUDIT-005 B2 车道批 4,沿 receiverNoneRustParity
 * 先例):用真实 kode-server 二进制跑 `$/kode/lint/analyzePostDestroy`,把 Rust
 * 结构面经 renderRustPostDestroyItems 渲染,与 TS 兜底 findPostDestroyFindings
 * 对同一语料**全量深等**(有序数组 toEqual:range/message/severity/source/code
 * 逐条一致)。
 *
 * 语义面由 TS 供给(statements = pythonStatements 掩码拼接文本,与生产装配
 * buildPostDestroyItemsWithRust 同一条入参路径);面/动态分派闸按生产装配同序
 * 先短路再发 RPC。语料 = 合成样本(块/销毁形态/早退/掩码/嵌套/非 ASCII 偏移)
 * + 真实 fixture .py 全量。
 *
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏
 * 纯 TS 门禁;二进制在场则跑真实 RPC。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { pythonStatements } from '../src/backend/pythonParser';
import {
  findPostDestroyFindings,
  postDestroyFindingToItem,
  renderRustPostDestroyItems
} from '../src/backend/postDestroyDiagnostics';
import type { EntityComponentFace } from '../src/backend/entityBuiltinProperties';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);

const FIXTURE_ROOT = join(repoRoot, 'tests', 'fixtures');

/** 递归收集 fixture .py(现实语料;对拍不挑内容,双实现同输入即可) */
function collectPythonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectPythonFiles(full, out);
    } else if (entry.endsWith('.py')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 合成样本:同块直进(裸/赋值形态)/安全成员/同层早退(死码)/深层早退不杀
 * 证明/dedent 断块/销毁在访问后(不报)/字符串注释掩码/f-string 整段掩码/
 * 跨行语句/嵌套 def/async def/非 ASCII 列(掩码保位)/docstring 三引号。
 * face 判不出/动态分派样本验证零产出语义(双侧同 [] 不发 RPC 面即兜底面)。
 */
const SYNTHETIC_SAMPLES: Array<{
  label: string;
  text: string;
  face?: EntityComponentFace | null;
  declared?: boolean;
}> = [
  {
    label: 'bare',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        self.hp\n'
  },
  {
    label: 'assignment-form',
    text: 'class Avatar:\n    def onSay(self):\n        result = self.destroy()\n        self.hp\n'
  },
  {
    label: 'safe-members',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        print(self.id, self.isDestroyed, self.className)\n        self.destroy()\n'
  },
  {
    label: 'same-level-early-exit',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        return\n        self.hp\n'
  },
  {
    label: 'raise-exit',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        raise RuntimeError("gone")\n        self.hp\n'
  },
  {
    label: 'deeper-exit-no-kill',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        if x: return\n        self.hp\n'
  },
  {
    label: 'dedent-breaks-block',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n      x = 1\n        self.hp\n'
  },
  {
    label: 'destroy-after-access',
    text: 'class Avatar:\n    def onSay(self):\n        self.hp\n        self.destroy()\n'
  },
  {
    label: 'masked-string-comment',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        # self.hp\n        s = "self.hp"\n'
  },
  {
    label: 'fstring-masked',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        log(f"hp={self.hp}")\n'
  },
  {
    label: 'multiline-access',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        total = (self.hp +\n            self.mp)\n'
  },
  {
    label: 'nested-def',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        def inner():\n            self.mana\n        self.hp\n'
  },
  {
    label: 'async-def',
    text: 'class Avatar:\n    async def onSay(self):\n        self.destroy()\n        self.hp\n'
  },
  {
    label: 'non-ascii-column',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        report("销毁完成") ; self.hp\n'
  },
  {
    label: 'docstring-triple',
    text: 'class Avatar:\n    def onSay(self):\n        """doc with self.ghost"""\n        self.destroy()\n        self.hp\n'
  },
  {
    label: 'no-face',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        self.hp\n',
    face: null
  },
  {
    label: 'destroy-declared',
    text: 'class Avatar:\n    def onSay(self):\n        self.destroy()\n        self.hp\n',
    declared: true
  },
  { label: 'empty', text: '' }
];

const suite = binaryReady ? describe : describe.skip;

suite('postDestroy Rust↔TS 行为对拍(真实 kode-server)', () => {
  it('Rust 结构面渲染 ≡ TS 兜底(全量深等,合成+fixture)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    try {
      const fixtureTexts = collectPythonFiles(FIXTURE_ROOT).map(file => ({
        label: `fixture:${file.slice(FIXTURE_ROOT.length + 1)}`,
        text: readFileSync(file, 'utf8')
      }));
      const samples = [...SYNTHETIC_SAMPLES, ...fixtureTexts];
      expect(samples.length).toBeGreaterThan(17);
      for (const sample of samples) {
        const pathFace: EntityComponentFace | null = sample.face !== undefined ? sample.face : 'cellapp';
        const declared = sample.declared === true;
        const tsItems = findPostDestroyFindings(sample.text, pathFace, null, declared).map(postDestroyFindingToItem);
        // 生产装配同序短路:declared/face 判不出 → 兜底面即 [],不发 RPC
        if (declared || pathFace === null) {
          expect(
            tsItems,
            `${sample.label}: TS 短路面应为空`
          ).toEqual([]);
          continue;
        }
        const statements = pythonStatements(sample.text);
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzePostDestroy',
          params: { text: sample.text, destroyDeclared: declared, statements }
        })) as { items?: unknown };
        const rustItems = resp.items ?? [];
        const rendered = renderRustPostDestroyItems(rustItems);
        expect(
          rendered,
          `${sample.label}: Rust 结构面含畸形条目(整面作废语义)`
        ).not.toBeNull();
        expect(
          rendered,
          `${sample.label}: Rust ≠ TS(能力丢失/漂移)`
        ).toEqual(tsItems);
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 120000);

  it('合成样本逐面健全(命中在位/边界零报,防双侧同错空转)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    try {
      const itemsFor = async (text: string, destroyDeclared = false) => {
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzePostDestroy',
          params: { text, destroyDeclared, statements: pythonStatements(text) }
        })) as { items?: Array<{ code: string; line: number; character: number; length: number; member: string; destroyLine: number; destroyColumn: number }> };
        return resp.items ?? [];
      };
      // 裸样本报 1:member/位置/取证面逐项
      const bare = await itemsFor('def f(self):\n    self.destroy()\n    self.hp\n');
      expect(bare).toHaveLength(1);
      expect(bare[0].code).toBe('kbengine.postDestroy');
      expect(bare[0].line).toBe(2);
      expect(bare[0].character).toBe(4);
      expect(bare[0].length).toBe(7);
      expect(bare[0].member).toBe('hp');
      expect(bare[0].destroyLine).toBe(1);
      expect(bare[0].destroyColumn).toBe(4);
      // 同层早退零报 / 销毁在访问后零报 / declared 零报
      expect(await itemsFor('def f(self):\n    self.destroy()\n    return\n    self.hp\n')).toHaveLength(0);
      expect(await itemsFor('def f(self):\n    self.hp\n    self.destroy()\n')).toHaveLength(0);
      expect(await itemsFor('def f(self):\n    self.destroy()\n    self.hp\n', true)).toHaveLength(0);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 60000);
});
