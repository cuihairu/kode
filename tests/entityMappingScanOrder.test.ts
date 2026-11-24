// def 首扫确定性序(2026-11-24 索引序对账):发现序原为 findFilesAcrossRoots
// 的 Map 插入序(= workspace.findFiles 序 + 外部 readdir 序),跨次启动/跨机器
// 不稳定 → 首扫批次与磁盘缓存快照不可复现,基准锚点对拍因此带噪音。
// 修复:实体候选按规范化路径**码点**升序排定(localeCompare 依赖平台 locale,禁用)。
// 断言面:实体入表序与发现序无关——stub 故意反序返回,入表仍为码点升序。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { IndexScheduler } from '../src/backend/indexScheduler';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { patternGlob } from './helpers/findPattern';

const writeDef = (dir: string, name: string): string => {
  const file = path.join(dir, 'scripts', 'entity_defs', `${name}.def`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '<root>',
    '  <Properties>',
    `    <${name}>`,
    '      <Type>UINT32</Type>',
    `    </${name}>`,
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  return file;
};

const waitUntil = async (probe: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const start = Date.now();
  while (!probe()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

type ManagerInternals = {
  initialScanCompleted: boolean;
  mappingIndexes: Map<string, unknown>;
};

describe('def 首扫按规范化路径码点定序(索引序对账)', () => {
  it('发现序故意反序:实体入表仍按码点升序(大写先于小写)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defscanorder-'));
    // 发现序 Zebra → alpha → Middle;码点序应为 Middle < Zebra < alpha
    const zebra = writeDef(dir, 'Zebra');
    const alpha = writeDef(dir, 'alpha');
    const middle = writeDef(dir, 'Middle');
    const oldFolders = stubWorkspace.workspaceFolders;
    const oldFindFiles = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (raw?: unknown) => {
      const pattern = patternGlob(raw);
      if (pattern.endsWith('*.def')) {
        return [Uri.file(zebra), Uri.file(alpha), Uri.file(middle)];
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never, new IndexScheduler());
      const internals = manager as unknown as ManagerInternals;
      await waitUntil(() => internals.initialScanCompleted, 'def 首扫完成');
      expect([...internals.mappingIndexes.keys()])
        .toEqual(['Middle', 'Zebra', 'alpha'], '入表序须与发现序无关,按码点升序');
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = oldFindFiles;
      stubWorkspace.workspaceFolders = oldFolders;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});