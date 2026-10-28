import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineHoverProvider, type HoverPhaseTimer } from '../src/languageProviders';
import { makeTextDocument, Position } from './helpers/vscodeStub';

// IDE-MET-003:hover 分支级耗时记录。验收口径:能区分注解查询(annotation-query)、
// def 映射(def-mapping)、schema(schema)、渲染(render)四类分支耗时;总耗时由
// 适配层 operation.elapsedMs 承担(已有面)。计时器 per-request 直传
// (extension.ts 适配层把 operation.startSubPhase 注入 provideHoverTimed),
// 零模块级共享状态,并发 hover 各自归因;timer 不传时零开销外壳行为不变。

const pyDoc = (text: string, fileName = '/tmp/ws/scripts/cell/Avatar.py') =>
  makeTextDocument(text, { fileName, languageId: 'python' }) as unknown as vscode.TextDocument;

const locationOf = (method: string) => ({
  defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
  line: 4,
  section: 'BaseMethods',
  exposed: false,
  identity: { symbolName: method },
  declaredArgs: []
});

const managerResolving = (location: unknown): EntityMappingManager =>
  ({
    resolveMethodDefinition: () => Promise.resolve(location)
  }) as unknown as EntityMappingManager;

const recordingTimer = (): { timer: HoverPhaseTimer; labels: () => string[] } => {
  const seen: string[] = [];
  return {
    timer: {
      start: (label: string) => {
        seen.push(label);
        return () => undefined;
      }
    },
    labels: () => seen
  };
};

describe('hover 分支级耗时记录(IDE-MET-003)', () => {
  it('def 声明命中链:def-mapping → schema → render 分段计时,普通 hover 外壳结果不变', async () => {
    const provider = new KBEngineHoverProvider(managerResolving(locationOf('login')));
    const doc = pyDoc('class Avatar(kbe.KBEntity):\n    def login(self):\n        pass\n');
    const position = new Position(1, 9);

    const { timer, labels } = recordingTimer();
    const timed = await provider.provideHoverTimed(doc, position, undefined, timer);
    // 命中链三段齐备且有序:先 def 索引映射,再签名/形参闸 schema 段,最后渲染
    expect(labels()).toEqual(['def-mapping', 'schema', 'render']);
    // 外壳(无计时器)返回同一结果:计时面不改变 hover 行为
    const plain = await provider.provideHover(doc, position);
    expect(plain).not.toBeNull();
    expect((plain!.contents as { value: string }).value).toBe(
      (timed!.contents as { value: string }).value
    );
  });

  it('def 映射未命中回退:注解查询段(annotation-query)计时', async () => {
    const provider = new KBEngineHoverProvider(managerResolving(null));
    const doc = pyDoc('class Avatar(kbe.KBEntity):\n    def login(self):\n        pass\n');
    const { timer, labels } = recordingTimer();
    const result = await provider.provideHoverTimed(doc, new Position(1, 9), undefined, timer);
    // def 映射先行计时段仍在;回退后的注解查询链单独成段
    expect(labels()).toContain('def-mapping');
    expect(labels()).toContain('annotation-query');
    expect(result).toBeNull();
  });

  it('非 python 文档直达注解查询:只记 annotation-query', async () => {
    const provider = new KBEngineHoverProvider();
    const doc = makeTextDocument('<root>\n  <Prop1> INT32 </Prop1>\n</root>\n', {
      fileName: '/tmp/ws/scripts/entity_defs/Avatar.def'
    }) as unknown as vscode.TextDocument;
    const { timer, labels } = recordingTimer();
    await provider.provideHoverTimed(doc, new Position(1, 6), undefined, timer);
    expect(labels()).toEqual(['annotation-query']);
  });

  it('计时标签只允许四类验收面:注解查询/def 映射/schema/渲染', async () => {
    const allowed = new Set(['annotation-query', 'def-mapping', 'schema', 'render']);
    const provider = new KBEngineHoverProvider(managerResolving(locationOf('login')));
    const doc = pyDoc('class Avatar(kbe.KBEntity):\n    def login(self):\n        pass\n');
    const { timer, labels } = recordingTimer();
    await provider.provideHoverTimed(doc, new Position(1, 9), undefined, timer);
    expect(labels().every(label => allowed.has(label))).toBe(true);
  });
});
