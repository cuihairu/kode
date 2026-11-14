import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// RUST-053(旧 BUILD-004)基础包瘦身守卫:Cargo features 分割 optional
// engines/runtime/plugin host 的结构面前提=kode-server 二进制的依赖闭包
// 不连 engines(kode-kbengine*)与 plugin host(kode-mcp)——这些 crate
// 在 workspace 里独立存在,但只要被 server 闭包(直接或经中间 crate)引用,
// 就会被静态链进基础二进制。启动成本实测已小(core-spawn-run.txt start.total
// p50 4.5ms;release 二进制 ~7.8MB),真实瘦身空间在 VSIX 平台拆分
// (RUST-057 车道);本测试钉「引擎/插件面不得无声回到基础闭包」:
// 有人给 kode-server 闭包加 kbengine/mcp 依赖且无显式决策时,此处即红。

const repoRoot = path.resolve(__dirname, '..');
const cratesDir = path.join(repoRoot, 'crates');

/** 解析一个 crate 的 Cargo.toml 里 path 依赖的本地包名(闭包边) */
const localDepsOf = (crateName: string): string[] => {
  const manifest = fs.readFileSync(
    path.join(cratesDir, crateName, 'Cargo.toml'), 'utf8'
  );
  const deps: string[] = [];
  // 只扫 [dependencies] 段(不扫 dev-dependencies/test 依赖——不进二进制)
  const section = /\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(manifest);
  if (!section) {
    return deps;
  }
  for (const match of section[1].matchAll(/([\w-]+)\s*=\s*\{\s*path\s*=\s*"([^"]+)"/g)) {
    const target = path.basename(match[2]);
    if (fs.existsSync(path.join(cratesDir, target, 'Cargo.toml'))) {
      deps.push(target);
    }
  }
  return deps;
};

const closureOf = (root: string): Set<string> => {
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    for (const dep of localDepsOf(name)) {
      walk(dep);
    }
  };
  walk(root);
  return seen;
};

describe('RUST-053 基础包依赖闭包守卫', () => {
  it('kode-server 闭包不连 engines(kode-kbengine*)与 plugin host(kode-mcp)', () => {
    const closure = closureOf('kode-server');
    expect(closure.size).toBeGreaterThan(0);
    const foreign = [...closure].filter(name =>
      name.startsWith('kode-kbengine') || name === 'kode-mcp'
    );
    expect(foreign).toEqual([]);
  });

  it('engines 与 plugin host crate 确实在 workspace 独立存在(守卫的靶子真实)', () => {
    // 守卫防的是「这些 crate 被连进 server」;若这些 crate 根本不存在,
    // 守卫就是空转。钉它们在场,保证守卫靶子真实。
    for (const name of ['kode-kbengine', 'kode-kbengine-analyzer', 'kode-mcp']) {
      expect(fs.existsSync(path.join(cratesDir, name, 'Cargo.toml'))).toBe(true);
    }
  });
});
