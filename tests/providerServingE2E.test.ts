import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import {
  serveCompletionFromRust,
  serveHoverFromRust,
  setKodeCoreShadowGate
} from '../src/backend/kodeCoreShadowFaces';
import { buildDependencyGraphInRust } from '../src/backend/dependencyGraphRust';
import { KBEngineHoverProvider } from '../src/languageProviders/hover';
import { KBEngineCompletionProvider } from '../src/languageProviders/completion';
import { KBEngineDefinitionProvider } from '../src/languageProviders/navigation';
import {
  rustDiagnosticsFaceGateOpen,
  serveRustDiagnosticsFace
} from '../src/languageProviders/validation';
import { getLanguageFeatureConfig } from '../src/languageProviders/shared';
import {
  DiagnosticCollection,
  DiagnosticSeverity,
  Position,
  makeTextDocument
} from './helpers/vscodeStub';

// QA-002(旧 KSEM-QA-02)Provider 端到端验证:同一文件实际走补全/hover/
// 跳转/诊断/图入口,包含 RPC 缺失、旧二进制和失败降级 —— 避免只测核心函数。
// 与 kodeCoreServingE2E(定义面核心函数真二进制)互补:本套件走 **provider
// 入口**(KBEngineHoverProvider/DefinitionProvider/CompletionProvider +
// 诊断归并腿 + 依赖图入口),同一实体 Avatar 的 def/py 两份代表文件上全五面
// 各走各的轨道;降级三臂 = 门未装配(backend=ts)/坏二进制(spawn 拒绝)/
// 异构二进制(kode-mcp 不识 LSP 方法,交互预算内回落)。二进制缺失时跳过
// (单测基线不背工具链依赖,与 kodeCoreServingE2E 同口径)。

const repoRoot = join(__dirname, '..');
const serverBinary = join(repoRoot, 'target', 'debug', 'kode-server');
const mcpBinary = join(repoRoot, 'target', 'debug', 'kode-mcp');
const demoRoot = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets');
const DEF = join(demoRoot, 'scripts', 'entity_defs', 'Avatar.def');
const PY = join(demoRoot, 'scripts', 'cell', 'Avatar.py');

const suite = existsSync(serverBinary) ? describe : describe.skip;

const hoverTextOf = (hover: unknown): string => {
  if (!hover || typeof hover !== 'object') {
    return '';
  }
  const contents = (hover as { contents: unknown }).contents;
  if (Array.isArray(contents)) {
    return contents
      .map(item => (typeof item === 'string' ? item : String((item as { value?: string }).value ?? '')))
      .join('');
  }
  if (contents && typeof contents === 'object' && 'value' in contents) {
    return String((contents as { value: string }).value);
  }
  return typeof contents === 'string' ? contents : '';
};

const defText = readFileSync(DEF, 'utf8');
const pyText = readFileSync(PY, 'utf8');

/** Avatar.def 里 hp 属性词位置(0 基行/列;列取词中,避锚漂移) */
function hpToken(): { line: number; character: number } {
  const lines = defText.split('\n');
  const line = lines.findIndex(l => /\bhp\b/.test(l) && !/<Type>|<Flags>|<Default>|<Persistent>/.test(l));
  expect(line, 'Avatar.def 应含 hp 属性词').toBeGreaterThanOrEqual(0);
  const character = lines[line].indexOf('hp') + 1;
  return { line, character };
}

/** Avatar.py 里首个 self.position 链的 self. 词位置(补全触发点) */
function selfDotPosition(): { line: number; character: number } {
  const lines = pyText.split('\n');
  const line = lines.findIndex(l => /self\.position\.x/.test(l));
  expect(line, 'Avatar.py 应含 self.position 链').toBeGreaterThanOrEqual(0);
  return { line, character: lines[line].indexOf('self.') + 5 };
}

const defDocument = () =>
  makeTextDocument(defText, { fileName: DEF, languageId: 'kbengine-def', version: 1 });
const pyDocument = () =>
  makeTextDocument(pyText, { fileName: PY, languageId: 'python', version: 1 });

function realGate(binaryPath: string = serverBinary): { gate: KodeCoreGate; client: KodeCoreClient } {
  const client = new KodeCoreClient({ binaryPath });
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend: 'rust', serverPath: binaryPath, shadowTimeoutMs: 15000 });
  return { gate, client };
}

const gates: KodeCoreGate[] = [];
afterEach(() => {
  setKodeCoreShadowGate(null);
});
afterAll(async () => {
  await Promise.all(gates.splice(0).map(gate => gate.dispose().catch(() => undefined)));
});

suite('kode Provider 端到端(真实二进制):同一文件五面+降级三臂(QA-002)', () => {
  it('Avatar.def:悬停 provider 经真二进制出 rust markdown(hp/Type/Default)', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const { line, character } = hpToken();
    const hover = await new KBEngineHoverProvider().provideHoverTimed(
      defDocument(),
      new Position(line, character)
    );
    const text = hoverTextOf(hover);
    expect(text).toContain('**hp**');
    expect(text).toContain('**Type**: `UINT32`');
    expect(text).toContain('**Default**: `100`');
  }, 30_000);

  it('Avatar.def:跳转 provider 经真二进制落 DetailLevels 声明块', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const location = await new KBEngineDefinitionProvider().provideDefinition(
      defDocument(),
      new Position(35, 18)
    );
    expect(location).not.toBeNull();
    const loc = Array.isArray(location) ? location[0] : location;
    expect((loc as { uri: { fsPath: string } }).uri.fsPath).toBe(DEF);
    const startLine = (loc as { range: { start: { line: number } } }).range.start.line;
    expect(startLine).toBeGreaterThanOrEqual(58);
    expect(startLine).toBeLessThanOrEqual(62);
  }, 30_000);

  it('Avatar.def:诊断归并腿经真二进制出未知 Flags 错误(虚拟破档)', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const featureConfig = getLanguageFeatureConfig();
    expect(rustDiagnosticsFaceGateOpen(featureConfig)).toBe(true);
    const brokenText = [
      '<root>',
      '<Type>Broken</Type>',
      '<Entity>',
      '\t<Properties>',
      '\t\t<hp>',
      '\t\t\t<Type> UINT32 </Type>',
      '\t\t\t<Flags> NOT_A_FLAG </Flags>',
      '\t\t</hp>',
      '\t</Properties>',
      '</Entity>',
      '</root>',
      ''
    ].join('\n');
    const broken = makeTextDocument(brokenText, {
      fileName: '/ws/scripts/entity_defs/Broken.def',
      languageId: 'kbengine-def',
      version: 1
    });
    const collection = new DiagnosticCollection();
    serveRustDiagnosticsFace(broken, collection, featureConfig);
    await new Promise(resolve => setTimeout(resolve, 250));
    const merged = collection.get(broken.uri);
    expect(merged).toHaveLength(1);
    expect(merged[0].message).toContain('未知的 KBEngine Flags 值: NOT_A_FLAG');
    expect(merged[0].severity).toBe(DiagnosticSeverity.Error);
  }, 30_000);

  it('Avatar.py:补全 provider 经真二进制出 def 属性候选(self. 面)', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    // 冷客户端预热(kodeCoreServingE2E 判例:首 it 拉起进程后同 gate 复用):
    // def 悬停建立语料环境+拉起进程,py 面直调一次让镜像落位 —— 否则
    // provider 首请求落在 2000ms 交互预算外/语料环境未建立,null 回 TS。
    await serveHoverFromRust(defDocument(), hpToken() as never);
    const { line, character } = selfDotPosition();
    const warmDoc = pyDocument();
    await serveCompletionFromRust(warmDoc, { line, character } as never);
    const items = (await new KBEngineCompletionProvider().provideCompletionItems(
      warmDoc,
      new Position(line, character)
    )) as { label: string; detail?: string }[];
    const labels = items.map(item => item.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).toContain('hp');
    const hpItem = items.find(item => item.label === 'hp');
    expect(hpItem?.detail).toBe('UINT32');
  }, 30_000);

  it('图入口:demo 根经真二进制出依赖图(8 实体含 Avatar)', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const graph = await buildDependencyGraphInRust(demoRoot);
    expect(graph).not.toBeNull();
    expect(graph!.stats.entityCount).toBe(8);
    expect(graph!.stats.defCount).toBe(8);
    expect(graph!.stats.nodeCount).toBe(20);
    expect(graph!.stats.edgeCount).toBe(10);
    expect(JSON.stringify(graph)).toContain('Avatar');
  }, 60_000);

  it('降级臂①RPC 缺失(门未装配):悬停/跳转/补全走 TS 链仍出有效结果', async () => {
    setKodeCoreShadowGate(null);
    const { line, character } = hpToken();
    const hover = await new KBEngineHoverProvider().provideHoverTimed(
      defDocument(),
      new Position(line, character)
    );
    expect(hoverTextOf(hover)).toContain('hp');

    const location = await new KBEngineDefinitionProvider().provideDefinition(
      defDocument(),
      new Position(35, 18)
    );
    expect(location).not.toBeNull();
    const loc = Array.isArray(location) ? location[0] : location;
    expect((loc as { uri: { fsPath: string } }).uri.fsPath).toBe(DEF);

    const { line: pyLine, character: pyChar } = selfDotPosition();
    const items = (await new KBEngineCompletionProvider().provideCompletionItems(
      pyDocument(),
      new Position(pyLine, pyChar)
    )) as { label: string }[];
    expect(items.length).toBeGreaterThan(0);
  }, 30_000);

  it('降级臂②失败降级(坏二进制 spawn 拒绝):provider 回落 TS 不悬挂', async () => {
    const { gate } = realGate(join(repoRoot, 'package.json'));
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const { line, character } = hpToken();
    const hover = await new KBEngineHoverProvider().provideHoverTimed(
      defDocument(),
      new Position(line, character)
    );
    expect(hoverTextOf(hover)).toContain('hp');

    const location = await new KBEngineDefinitionProvider().provideDefinition(
      defDocument(),
      new Position(35, 18)
    );
    expect(location).not.toBeNull();
    const loc = Array.isArray(location) ? location[0] : location;
    expect((loc as { uri: { fsPath: string } }).uri.fsPath).toBe(DEF);
  }, 30_000);

  it('降级臂③旧二进制(kode-mcp 不识 LSP 方法):交互预算内回落 TS', async () => {
    if (!existsSync(mcpBinary)) {
      return; // 本地无 mcp 二进制时此臂无事可证(CI rust-coverage 会构建)
    }
    const { gate } = realGate(mcpBinary);
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const { line, character } = hpToken();
    const hover = await new KBEngineHoverProvider().provideHoverTimed(
      defDocument(),
      new Position(line, character)
    );
    expect(hoverTextOf(hover)).toContain('hp');
  }, 45_000);
});
