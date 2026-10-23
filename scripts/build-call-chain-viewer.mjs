/*
 * bundle:webview 构建脚本(esbuild API 版):
 * 打包 src/webview/defCallChainViewer.ts 为离线单文件 IIFE——不拆包、无 CDN、
 * 无运行时动态加载,离线包即时可用。
 *
 * mermaid 用官方小体积发行版 @mermaid-js/tiny(≈全量一半):无 KaTeX/Mindmap/
 * Architecture/ELK/懒加载,flowchart 布局回落 dagre——正是调用链图需要的渲染面。
 * tiny 是纯 IIFE,按官方用法以普通 <script> 语义加载、赋值 globalThis.mermaid、
 * 无 default export;其内部顶层 var 依赖全局脚本作用域,不能被 esbuild 再包一层
 * IIFE(实测报 "Cannot read properties of undefined")。因此:
 *   1) esbuild 只直包入口(入口仅 import type mermaid 类型,不引 tiny);
 *   2) tiny 的 dist/mermaid.tiny.js 原样前置于打包产物,语义与官方
 *      "<script src=tiny><script src=app>" 完全一致,仍是单文件离线。
 * 266af5a 的自写 stub 裁剪插件路线已被官方 tiny 构建取代并移除。
 */
import { build } from 'esbuild';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const require = createRequire(import.meta.url);

/** CLI: node scripts/build-call-chain-viewer.mjs --entry=... --outfile=... */
function parseArgs(argv) {
  const args = { entry: 'src/webview/defCallChainViewer.ts', outfile: 'media/defCallChainViewer.js' };
  for (const arg of argv.slice(2)) {
    const match = /^--([a-z]+)=(.+)$/.exec(arg);
    if (match) args[match[1]] = match[2];
  }
  return {
    entry: path.resolve(repoRoot, args.entry),
    outfile: path.resolve(repoRoot, args.outfile)
  };
}

async function main() {
  const { entry, outfile } = parseArgs(process.argv);
  const previousSize = await stat(outfile).then((s) => s.size).catch(() => 0);
  const staged = `${outfile}.staging`;

  const result = await build({
    entryPoints: [entry],
    outfile: staged,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    logLevel: 'info',
    metafile: true
  });

  // tiny dist 原样前置(官方 <script> 语义;尾行以 ; 结束,补 \n 防粘连)
  const tinyDist = require.resolve('@mermaid-js/tiny/dist/mermaid.tiny.js');
  const tinySource = await stat(tinyDist).then(() => readFile(tinyDist, 'utf8'));
  const entryBundle = await readFile(staged, 'utf8');
  await writeFile(outfile, `${tinySource}\n${entryBundle}`);
  const { unlink } = await import('node:fs/promises');
  await unlink(staged);

  const newSize = (await stat(outfile)).size;
  const fmt = (n) => `${(n / 1024 / 1024).toFixed(2)}MB (${n} bytes)`;
  console.log(`call-chain viewer bundle (@mermaid-js/tiny): ${fmt(previousSize)} -> ${fmt(newSize)}`);
  const outputs = Object.values(result.metafile.outputs);
  const stagedOutput = outputs.find((o) => o.outfile === staged) ?? outputs[0];
  const bySize = Object.entries(stagedOutput.inputs ?? {})
    .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
    .slice(0, 8);
  console.log('top inputs (entry bundle, tiny dist 前置另计):');
  for (const [file, meta] of bySize) {
    console.log(`  ${(meta.bytesInOutput / 1024).toFixed(0)}KB  ${file}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
