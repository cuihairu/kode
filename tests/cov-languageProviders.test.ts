import { describe, expect, it } from 'vitest';
import { KBEngineCompletionProvider, KBEngineHoverProvider } from '../src/languageProviders';
import type { EntityMappingManager } from '../src/entityMapping';
import { Position, makeTextDocument } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 覆盖率补齐:languageProviders 内建属性补全面(用户令 2026-10-21 内建属性
// 单 ③)的 manager 分支——def 归属面判定 getEntityComponentFacesForPythonFile
// 的 null(非实体→不接管)/单面/多面(只给宏公共 3)/reject(落空回 []) 四路。
// 既有用例(补全/悬停/定义面)已覆盖主链,此处专攻 provideBuiltinProperty
// Completions 的 then/catch 收尾。

const pyDocument = (text: string, fileName = 'scripts/Hero.py'): MinimalTextDocument =>
  makeTextDocument(text, { fileName: `/tmp/ws/${fileName}`, languageId: 'python' });

const manager = (faces: (readonly string[] | null) | 'reject'): EntityMappingManager =>
  ({
    getEntityComponentFacesForPythonFile: (): Promise<readonly string[] | null> =>
      faces === 'reject'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(faces as readonly string[] | null)
  } as unknown as EntityMappingManager);

describe('KBEngineCompletionProvider 内建属性补全 manager 分支(覆盖率)', () => {
  const complete = async (
    faces: readonly string[] | null | 'reject',
    lineText: string
  ): Promise<unknown> => {
    const provider = new KBEngineCompletionProvider(manager(faces));
    const document = pyDocument(lineText);
    const position = new Position(0, lineText.length);
    return provider.provideCompletionItems(document, position);
  };

  it('faces=null(非实体无 def 归属)→ 空表不接管', async () => {
    expect(await complete(null, 'self.')).toEqual([]);
  });

  it('faces=单面 → 给该面全量内建属性项(非空)', async () => {
    const items = (await complete(['client'], 'self.')) as { label: unknown }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].label).toBeTruthy();
  });

  it('faces=多面歧义 → 只给宏公共 3(非空但少于单面全量)', async () => {
    const multi = (await complete(['client', 'cell'], 'self.')) as unknown[];
    const single = (await complete(['client'], 'self.')) as unknown[];
    expect(multi.length).toBeGreaterThan(0);
    expect(multi.length).toBeLessThan(single.length);
  });

  it('faces=reject → 落空回 []', async () => {
    expect(await complete('reject', 'self.')).toEqual([]);
  });
});

describe('KBEngineHoverProvider 内建属性悬停 def 归属 catch(覆盖率)', () => {
  it('无目录域路径 + manager 面判定 reject → 落空不炸(1114-1117)', async () => {
    const provider = new KBEngineHoverProvider(manager('reject'));
    // 路径无 base/cell/client 段 → pathFace=null → 走 try/catch;
    // manager.getEntityComponentFacesForPythonFile reject → catch 置 defFaces=null。
    // self.client 单段访问,光标在 client 名上(char 21)。
    const document = pyDocument(
      'class Hero:\n    def onTimer(self):\n        print(self.client)\n',
      'scripts/Hero.py'
    );
    const result = await provider.provideHover(document, new Position(2, 21));
    // 非实体脚本(pathFace+defFaces 双空)→ resolveEntityBuiltinPropertyHit=null
    // → 落回普通 hover 链;不外抛即覆盖 try/catch,值 null 或普通链产物均算通过。
    expect(result === null || result === undefined).toBe(true);
  });
});
