import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDefDocument } from '../src/defParser';
import { getCustomTypeInfos } from '../src/definitionWorkspace';

// definitionWorkspace 批64 分支补测:extractCustomTypeRawValue 的 `|| 'ALIAS'`
// 哨兵(仅 implementedBy/Properties 子元素时)、parseCustomTypeStructure 的
// root-null 兜底臂(实体解码后的 '<' 令再包装 tokenize 失败)、以及
// findCustomTypePythonFileByImplementation 的前导点 implementedBy 行为锁定
// (firstSegment 为空字符串的假臂与外层 if 同处一个 ignore 区间,分支条目
// 已被摘除,此处锁定的是行为本身,不贡献分支分母)。

const write = (root: string, relative: string, content: string): void => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-branch-'));

  write(root, 'scripts/entity_defs/types.xml', [
    '<root>',
    '  <ALONE>',
    '    <implementedBy>item.doll</implementedBy>',
    '  </ALONE>',
    '  <OK><Type>UINT8</Type></OK>',
    '  <LT>a &lt; b</LT>',
    '  <DOTED>',
    '    <Type>UINT8</Type>',
    '    <implementedBy>.a.b</implementedBy>',
    '  </DOTED>',
    '  <DOTTED_OK>',
    '    <Type>UINT8</Type>',
    '    <implementedBy>a.b</implementedBy>',
    '  </DOTTED_OK>',
    '</root>'
  ].join('\n'));
  // 正对照用:user_type 根下仅有 a.py,a/b.py 不存在
  write(root, 'scripts/user_type/a.py', '# sentinel a\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('extractCustomTypeRawValue ALIAS sentinel', () => {
  it("falls back to 'ALIAS' when a type element only carries implementedBy children", () => {
    const infos = getCustomTypeInfos(root);

    // implementedBy/Properties 子元素被跳过,无文本块 ⇒ chunks 为空 ⇒ `|| 'ALIAS'`
    const alone = infos.find(info => info.name === 'ALONE');
    expect(alone?.rawValue).toBe('ALIAS');
    expect(alone?.aliasType).toBe('ALIAS');
    expect(alone?.implementedBy).toBe('item.doll');

    // 对照:常规 Type 子元素照常渲染,不落哨兵
    const ok = infos.find(info => info.name === 'OK');
    expect(ok?.rawValue).toBe('<Type>UINT8</Type>');
    // aliasType 只在 rawValue 上取裸标识符前缀,'<' 开头无匹配归一 'ALIAS'
    expect(ok?.aliasType).toBe('ALIAS');
  });
});

describe('parseCustomTypeStructure root-null fallback', () => {
  it('yields empty children when the raw value cannot be re-tokenized', () => {
    const lt = getCustomTypeInfos(root).find(info => info.name === 'LT');

    // &lt; 实体解码出裸 '<',再包装 <root>a < b</root> 令 tokenize 失败
    expect(lt?.rawValue).toBe('a < b');
    expect(() => parseDefDocument(`<root>${lt?.rawValue}</root>`)).toThrow();
    expect(lt?.structure.children).toEqual([]);
  });
});

describe('findCustomTypePythonFileByImplementation leading-dot module', () => {
  it("adds no first-segment candidate for '.a.b' while 'a.b' does", () => {
    const infos = getCustomTypeInfos(root);

    // 正对照:'a.b' → 'a/b' 与首段 'a' 都进候选,a.py 经首段命中
    expect(infos.find(info => info.name === 'DOTTED_OK')?.pythonFilePath)
      .toContain(path.join('user_type', 'a.py'));

    // 前导点:'.a.b' → '/a/b',split('/') 首段为空字符串 ⇒ 只剩 '/a/b'(文件
    // 不存在)与类型名,pythonFilePath 归一 undefined
    expect(infos.find(info => info.name === 'DOTED')?.pythonFilePath).toBeUndefined();
  });
});
