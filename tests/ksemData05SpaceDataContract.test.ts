/**
 * KSEM-DATA-05(SEM-046)登记 spaceData 契约 — 审计钉(零生产码)。
 *
 * 验收口径(todo.md SEM-046):核实 key/value 字符串约束、空间范围、客户端
 * 可见路径和 _mapping 保护规则,记录出处。
 *
 * 面分解(现状核实,缺口账记录在 docs/knowledge/api-cellapp.md §2 spaceData
 * contract,不预造):
 *  - cell 进程 API 携带三函数(str 注解签名,pyi 出处 124-130)——字符串
 *    约束面=签名注解,引擎真源 spacememory.cpp:709-742/766-806/822-864;
 *  - bots/client 只带单键读形态(客户端本地副本),无 set/del——接收单向
 *    路径的签名面(引擎真源 spacememory.cpp:636-684 客户端转发,kbengine.js
 *    :4846-4870 本地副本,客户端无写 API);
 *  - 入口钩子 onSpaceData 已登记(cellapp,SpaceMemory::onSpaceDataChanged
 *    出处,set=Iss/del=IsO);
 *  - 共享数据字典索引刻意不含 spaceData(函数形态非字典属性,
 *    KBENGINE_DATA_DICTS 三元)。
 */
import { describe, expect, it } from 'vitest';
import { PYTHON_PROCESSES, processApiSymbols } from '../src/backend/pythonProcess';
import { KBENGINE_ENTRY_HOOKS } from '../src/backend/entryHooks';
import { KBENGINE_DATA_DICTS, findKbeDataDictAccesses } from '../src/backend/globalDataIndexCore';

describe('KSEM-DATA-05 spaceData 契约登记(审计钉)', () => {
  it('cell 进程 API:三函数齐,str 注解签名,pyi 出处 124-130', () => {
    const symbols = processApiSymbols('cell');
    const set = symbols.find(s => s.name === 'setSpaceData');
    const get = symbols.find(s => s.name === 'getSpaceData');
    const del = symbols.find(s => s.name === 'delSpaceData');
    expect(set?.signature).toBe('def setSpaceData(__spaceID: int, __key: str, __value: str) -> None');
    expect(get?.signature).toBe('def getSpaceData(__spaceID: int, __key: str) -> str');
    expect(del?.signature).toBe('def delSpaceData(__spaceID: int, __key: str) -> None');
    // 空间范围:首参 spaceID(逐空间存储,非进程全局面)
    expect(set?.signature).toContain('__spaceID: int');
    expect(get?.signature).toContain('__spaceID: int');
    expect(del?.signature).toContain('__spaceID: int');
    expect(set?.sourceFile).toBe('typings/cell/KBEngine/_module.pyi');
    expect(get?.sourceLine).toBe(127);
    expect(set?.sourceLine).toBe(124);
    expect(del?.sourceLine).toBe(130);
  });

  it('bots/client:只带单键读形态(客户端本地副本),无 set/del——接收单向', () => {
    for (const proc of ['bots', 'client'] as const) {
      expect(PYTHON_PROCESSES).toContain(proc);
      const symbols = processApiSymbols(proc);
      const get = symbols.find(s => s.name === 'getSpaceData');
      expect(get?.signature).toBe('def getSpaceData(__key: str) -> str');
      // 客户端无写 API(set/del 缺席=接收单向路径的签名面)
      expect(symbols.some(s => s.name === 'setSpaceData')).toBe(false);
      expect(symbols.some(s => s.name === 'delSpaceData')).toBe(false);
    }
  });

  it('入口钩子 onSpaceData:cellapp,SpaceMemory::onSpaceDataChanged 出处,set=Iss/del=IsO', () => {
    const hook = KBENGINE_ENTRY_HOOKS.find(h => h.name === 'onSpaceData');
    expect(hook).toBeDefined();
    expect(hook!.component).toBe('cellapp');
    expect(hook!.signature).toBe('def onSpaceData(spaceID, key, value):');
    expect(hook!.documentation).toContain('SpaceMemory::onSpaceDataChanged');
    expect(hook!.documentation).toContain('Iss');
    expect(hook!.documentation).toContain('IsO');
    expect(hook!.sourceLocation).toContain('spacememory.cpp');
  });

  it('共享数据字典索引刻意不含 spaceData(函数形态非字典属性)', () => {
    expect([...KBENGINE_DATA_DICTS]).toEqual(['globalData', 'baseAppData', 'cellAppData']);
    // 函数调用形态与 spaceData 属性位都不入字典索引(索引范围=三字典)
    const aliases = new Set(['KBEngine']);
    expect(findKbeDataDictAccesses(
      'import KBEngine\nKBEngine.setSpaceData(1, "k", "v")\n', aliases
    )).toHaveLength(0);
    expect(findKbeDataDictAccesses(
      'import KBEngine\nv = KBEngine.spaceData["k"]\n', aliases
    )).toHaveLength(0);
  });
});
