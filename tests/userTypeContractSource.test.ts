import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collectUserTypeContractStatuses, userTypeSerializationContractDoc, pythonPickleContractDoc } from '../src/userTypeContractSource';

const write = (root: string, relative: string, content: string): void => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const COMPLETE_IMPL = [
  'class TalentTreeImpl:',
  '    def createObjFromDict(self, dictData):',
  '        return dictData',
  '    def getDictFromObj(self, obj):',
  '        return {}',
  '    def isSameType(self, obj):',
  '        return True'
].join('\n');

const NO_CREATE_IMPL = [
  'class TalentTreeImpl:',
  '    def getDictFromObj(self, obj):',
  '        return {}',
  '    def isSameType(self, obj):',
  '        return True'
].join('\n');

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-utc-source-'));

  write(root, 'scripts/entity_defs/types.xml', [
    '<root>',
    '  <TalentTree>',
    '    <implementedBy>talent.TalentTreeImpl</implementedBy>',
    '  </TalentTree>',
    '  <BrokenType>',
    '    <implementedBy>broken.BrokenImpl</implementedBy>',
    '  </BrokenType>',
    '  <NoImpl>',
    '    <Type>UINT8</Type>',
    '  </NoImpl>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/user_type/talent.py', COMPLETE_IMPL);
  write(root, 'scripts/user_type/broken.py', NO_CREATE_IMPL);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GEN-DEF-1e user_type 契约收集(userTypeContractSource)', () => {
  it('带 implementedBy 的类型进索引,三契约方法存在性如实扫描', () => {
    const statuses = collectUserTypeContractStatuses(root);
    const byName = new Map(statuses.map(status => [status.name, status]));
    expect(byName.has('TalentTree')).toBe(true);
    expect(byName.has('BrokenType')).toBe(true);
    // NoImpl 无 implementedBy,不进契约索引
    expect(byName.has('NoImpl')).toBe(false);
  });

  it('完整实现 → 三契约方法皆 true', () => {
    const statuses = collectUserTypeContractStatuses(root);
    const talent = statuses.find(status => status.name === 'TalentTree');
    expect(talent).toBeDefined();
    expect(talent?.methods).toEqual({
      createObjFromDict: true,
      getDictFromObj: true,
      isSameType: true
    });
    expect(talent?.implFile).toContain('scripts/user_type/talent.py');
    expect(talent?.implementedBy).toBe('talent.TalentTreeImpl');
    expect(typeof talent?.implLine).toBe('number');
  });

  it('缺 createObjFromDict 的实现 → 该字段 false,其余 true', () => {
    const statuses = collectUserTypeContractStatuses(root);
    const broken = statuses.find(status => status.name === 'BrokenType');
    expect(broken?.methods).toEqual({
      createObjFromDict: false,
      getDictFromObj: true,
      isSameType: true
    });
  });

  it('implementedBy 指向缺失文件 → implFile 为空(缺方法诊断静默,兜底诊断接管)', () => {
    write(root, 'scripts/entity_defs/types.xml', [
      '<root>',
      '  <GhostType>',
      '    <implementedBy>ghost.GhostImpl</implementedBy>',
      '  </GhostType>',
      '</root>'
    ].join('\n'));
    const statuses = collectUserTypeContractStatuses(root);
    const ghost = statuses.find(status => status.name === 'GhostType');
    expect(ghost).toBeDefined();
    expect(ghost?.implFile).toBeUndefined();
    expect(ghost?.methods).toEqual({ createObjFromDict: false, getDictFromObj: false, isSameType: false });
  });

  it('序列化契约文档(口径①):双向注明 wire/db→mem 与 mem→wire/db', () => {
    const doc = userTypeSerializationContractDoc('talent.TalentTreeImpl');
    expect(doc).toContain('talent.TalentTreeImpl');
    expect(doc).toContain('wire/db→mem');
    expect(doc).toContain('createObjFromDict');
    expect(doc).toContain('mem→wire/db');
    expect(doc).toContain('getDictFromObj');
  });

  it('裸 PYTHON 标注(口径②):整值 pickle 进出,不走 dict 转换', () => {
    const doc = pythonPickleContractDoc();
    expect(doc).toContain('pickle');
    expect(doc).toContain('不走 dict 转换');
  });
});
