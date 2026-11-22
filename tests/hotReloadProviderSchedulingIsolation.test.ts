import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// HR-EXT-008(RUST-412)调度隔离钉:新增 Provider 不得进入语言服务
// hover/definition 调用图——provider 派发面只活在保存事件管线
// (src/hotReload.ts)与后端装配/注册表层(src/backend/*),零出现在语言服务
// 模块。此门扫生产 .ts 源码,三道:
//   ①语言服务模块零引用派发面(resolveSendProvider/HotReloadProviderHost);
//   ②hover/definition 入口零导入 provider 面(pluginApi/Assembly/Examples);
//   ③派发面生产调用点除 src/hotReload.ts 与 src/backend/* 外零出现。
// 若有人把 provider 派发搬进 hover/definition 处理器(比如在悬停里查
// provider 或派发发送),此门红——语言服务尾延迟不被 Provider 拖累的
// 结构性保障。

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DISPATCH = ['resolveSendProvider', 'HotReloadProviderHost'];
const FACES = ['hotReloadProviderAssembly', 'hotReloadProviderExamples', 'hotReloadPluginApi'];

function allTs(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'target') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push(path.relative(SRC_ROOT, full));
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

/** 语言服务面:provider 桶 + hover/definition 入口 + 激活装配 */
function isLanguageService(rel: string): boolean {
  const base = path.basename(rel);
  return (
    rel === 'languageProviders.ts' ||
    rel.startsWith('languageProviders/') ||
    rel.startsWith('activate/languageServices') ||
    /^hover[^/]*\.ts$/.test(base) ||
    /^definition[^/]*\.ts$/.test(base) ||
    rel.startsWith('languageService')
  );
}

describe('HR-EXT-008 调度隔离:provider 不在语言服务调用图(RUST-412)', () => {
  it('①语言服务模块零引用 provider 派发面', () => {
    const hits: string[] = [];
    for (const rel of allTs()) {
      if (!isLanguageService(rel)) {
        continue;
      }
      const content = read(rel);
      for (const token of DISPATCH) {
        if (content.includes(token)) {
          hits.push(`${rel}:${token}`);
        }
      }
    }
    expect(hits, `语言服务模块引用了 provider 派发面: ${hits.join(', ')}`).toEqual([]);
  });

  it('②hover/definition 入口零导入 provider 面', () => {
    const entries = [
      'languageProviders/hover.ts',
      'languageProviders/pythonDefinition.ts',
      'languageProviders/navigation.ts',
      'languageProviders.ts'
    ];
    const hits: string[] = [];
    for (const rel of entries) {
      const content = read(rel);
      for (const token of FACES) {
        if (content.includes(token)) {
          hits.push(`${rel}:${token}`);
        }
      }
    }
    expect(hits, `hover/definition 入口导入了 provider 面: ${hits.join(', ')}`).toEqual([]);
  });

  it('③派发面生产调用点只在 src/hotReload.ts 与 src/backend/*', () => {
    const hits: string[] = [];
    for (const rel of allTs()) {
      if (rel === 'hotReload.ts' || rel.startsWith('backend/')) {
        continue;
      }
      const content = read(rel);
      for (const token of DISPATCH) {
        if (content.includes(token)) {
          hits.push(`${rel}:${token}`);
        }
      }
    }
    expect(
      hits,
      `provider 派发面出现在语言服务/其他生产面: ${hits.join(', ')}`
    ).toEqual([]);
  });
});
