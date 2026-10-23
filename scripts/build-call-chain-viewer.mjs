/*
 * bundle:webview 构建脚本(esbuild API 版):
 * 打包 src/webview/defCallChainViewer.ts 为离线单文件 IIFE——不拆包、无 CDN、
 * 无运行时动态加载,离线包即时可用。
 *
 * 与纯 CLI 打包的唯一差别是 kode-trim-unused-renderers 插件:mermaid@12 全量打包时
 * 会连带拖进调用链查看器永远用不到的渲染/布局引擎(esbuild --analyze 实测):
 *   elkjs                     ~1.45MB  (elk 布局;flowchart 默认 dagre,不需要)
 *   cytoscape + 扩展 + 布局库  ~0.59MB  (mindmap/architecture 等图形专用,不需要)
 *   katex                     ~0.27MB  (数学公式渲染,不需要)
 * 本插件把这 7 个包别名(esbuild alias 语义:onResolve 拦截)到本地虚拟 stub 模块:
 * stub 保留真实导出面(默认导出/具名导出),误用时立即抛出可诊断错误,
 * 而 flowchart(dagre + @mermaid-js/parser)的渲染链路一行不动。
 */
import { build } from 'esbuild';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

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

/**
 * 被裁剪包的真实导出面(与 mermaid@12 对这些包的 import 语句一一核对过):
 *   import ELK from 'elkjs/lib/elk.bundled.js'                  (elk-* chunk, 静态)
 *   const katexNs = await import('katex')                       (chunk-DSNLSHJZ, 懒加载)
 *   import cytoscape from 'cytoscape'                           (cose-bilkent / architectureDiagram chunk)
 *   import coseBilkent from 'cytoscape-cose-bilkent'            (cose-bilkent chunk)
 *   import fcose from 'cytoscape-fcose'                         (architectureDiagram chunk)
 *   cose-base / layout-base 仅被上面两个 cytoscape 扩展引用,兜底别名。
 */
const TRIMMED_PACKAGES = [
  {
    name: 'elkjs',
    label: 'elk.js layout engine',
    source: [
      `export default class ELK {`,
      `  constructor(options) { throw __trimmed('new ELK(' + JSON.stringify(options ?? {}) + ')'); }`,
      `  async layout(graph, options) { throw __trimmed('ELK#layout()'); }`,
      `}`,
      `export { ELK };`
    ].join('\n')
  },
  {
    name: 'katex',
    label: 'katex math renderer',
    source: [
      `export const version = '0.0.0-trimmed';`,
      // ParseError 保留真实类签名,让 instanceof 检查仍可用
      `export class ParseError extends Error {`,
      `  constructor(message, loc) { super(message); this.name = 'ParseError'; this.loc = loc; }`,
      `}`,
      `export const render = function render(teX, element, options) { throw __trimmed('katex.render()'); };`,
      `export const renderToString = function renderToString(teX, options) { throw __trimmed('katex.renderToString()'); };`,
      `export const renderToDomTree = function renderToDomTree(teX, options) { throw __trimmed('katex.renderToDomTree()'); };`,
      `export const renderToHTMLTree = function renderToHTMLTree(teX, options) { throw __trimmed('katex.renderToHTMLTree()'); };`,
      `export const defineMacro = function defineMacro(name, body) { throw __trimmed('katex.defineMacro()'); };`,
      // 默认导出:任何属性访问都返回"调用即抛错"的占位
      `export default __makeTrimmedStub('katex');`
    ].join('\n')
  },
  {
    name: 'cytoscape',
    label: 'cytoscape graph engine',
    source: [`export default __makeTrimmedStub('cytoscape');`].join('\n')
  },
  {
    name: 'cytoscape-cose-bilkent',
    label: 'cytoscape-cose-bilkent layout (mindmap)',
    source: [`export default function coseBilkent(cytoscape) { throw __trimmed('coseBilkent(cytoscape.use(...))'); }`].join('\n')
  },
  {
    name: 'cytoscape-fcose',
    label: 'cytoscape-fcose layout (architecture)',
    source: [`export default function fcose(cytoscape) { throw __trimmed('fcose(cytoscape.use(...))'); }`].join('\n')
  },
  {
    name: 'cose-base',
    label: 'cose-base layout library',
    source: [`export default __makeTrimmedStub('cose-base');`].join('\n')
  },
  {
    name: 'layout-base',
    label: 'layout-base layout library',
    source: [`export default __makeTrimmedStub('layout-base');`].join('\n')
  }
];

function stubPrelude() {
  return [
    `// AUTO-GENERATED stub — see scripts/build-call-chain-viewer.mjs. Do not edit.`,
    `function __trimmed(member) {`,
    `  return new Error(`,
    `    "[kode call-chain viewer] '" + member + "' was trimmed out of the offline bundle " +`,
    `    "(scripts/build-call-chain-viewer.mjs). Only flowchart (dagre) rendering ships; " +`,
    `    "the viewer falls back to the Text tab for diagrams that need it."`,
    `  );`,
    `}`,
    `function __makeTrimmedStub(label) {`,
    `  const stub = function trimmedStub() { throw __trimmed(label); };`,
    `  return new Proxy(stub, {`,
    `    get(target, prop) {`,
    `      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === Symbol.toStringTag) {`,
    `        return () => '[trimmed:' + label + ']';`,
    `      }`,
    `      return __makeTrimmedStub(label + '.' + String(prop));`,
    `    },`,
    `    apply() { throw __trimmed(label); },`,
    `    construct() { throw __trimmed('new ' + label); }`,
    `  });`,
    `}`
  ].join('\n');
}

/** esbuild 插件:把上表中的包(含子路径,如 elkjs/lib/elk.bundled.js)别名到虚拟 stub。 */
function trimUnusedRenderersPlugin() {
  const nameFilter = new RegExp(`^(?:${TRIMMED_PACKAGES.map((p) => p.name).join('|')})(?:/.*)?$`);
  return {
    name: 'kode-trim-unused-renderers',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: nameFilter }, (args) => ({ path: args.path, namespace: 'kode-trimmed-stub' }));
      pluginBuild.onLoad({ filter: /.*/, namespace: 'kode-trimmed-stub' }, async (args) => {
        const pkg = TRIMMED_PACKAGES.find((p) => args.path === p.name || args.path.startsWith(`${p.name}/`));
        if (!pkg) {
          throw new Error(`unmapped trimmed package: ${args.path}`);
        }
        return { contents: `${stubPrelude()}\n${pkg.source}`, loader: 'js', resolveDir: repoRoot };
      });
    }
  };
}

async function main() {
  const { entry, outfile } = parseArgs(process.argv);
  const previousSize = await stat(outfile).then((s) => s.size).catch(() => 0);

  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    logLevel: 'info',
    metafile: true,
    plugins: [trimUnusedRenderersPlugin()]
  });

  const newSize = (await stat(outfile)).size;
  const fmt = (n) => `${(n / 1024 / 1024).toFixed(2)}MB (${n} bytes)`;
  console.log(`call-chain viewer bundle: ${fmt(previousSize)} -> ${fmt(newSize)}`);
  for (const pkg of TRIMMED_PACKAGES) {
    console.log(`  trimmed: ${pkg.name} -> stub (${pkg.label})`);
  }
  const outputs = Object.values(result.metafile.outputs);
  const bundleOutput = outputs.find((o) => o.outfile === outfile) ?? outputs[0];
  const bySize = Object.entries(bundleOutput.inputs ?? {})
    .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
    .slice(0, 8);
  console.log('top inputs:');
  for (const [file, meta] of bySize) {
    console.log(`  ${(meta.bytesInOutput / 1024).toFixed(0)}KB  ${file}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
