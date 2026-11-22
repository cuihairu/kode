import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// HR-EXT-006(RUST-410):reload URL 不写死在 Rust Core——URL 只活在 TS 侧
// 模板里(BUILTIN_HTTP_REQUEST_EXAMPLE/用户自定义 HttpRequestEntry 条目),
// Rust Core(kode-server 等)是索引/语义面,不参与热更 HTTP。此门扫 crates/
// 的 .rs 源码,`8090`/`hotfix` 字面量零命中即合规;若有人把 reload URL
// 搬进 Rust(写死端点),此门红,防「Rust Core 写死 reload URL」回潮。

const CRATES_ROOT = path.resolve(__dirname, '..', 'crates');
const FORBIDDEN = ['8090', 'hotfix'];

function rustSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'target' || entry.name === 'node_modules') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.rs')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe('rust core 不写死 reload URL(HR-EXT-006)', () => {
  it('crates/ 全部 .rs 源码对 8090/hotfix 字面量零命中', () => {
    const files = rustSourceFiles(CRATES_ROOT);
    expect(files.length).toBeGreaterThan(50); // 确实扫到了 Rust 源码树
    const hits: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8').toLowerCase();
      for (const token of FORBIDDEN) {
        if (content.includes(token)) {
          hits.push(`${path.relative(CRATES_ROOT, file)}:${token}`);
        }
      }
    }
    expect(hits, `Rust Core 写死了 reload URL 字面量: ${hits.join(', ')}`).toEqual([]);
  });
});
