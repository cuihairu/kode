import { describe, expect, it } from 'vitest';
import {
  DefElementNode,
  findAncestorElement,
  getDirectChildElement,
  getDirectTextNodes,
  getElementText,
  getScalarChildValue,
  parseDefDocument
} from '../src/defParser';
import type { DefNode, DefTextNode } from '../src/defParser';

// defParser 的遍历工具与文本定位缺口:getDirectTextNodes/getElementText
// 的空参守卫、findAncestorElement 的 null 守卫与文本节点 parent 回溯、
// assignTextNodePosition 的两个回退分支(实体解码后 indexOf 落空、
// 空 CDATA 文本),全部走真实 parseDefDocument 产物。批63 分支补测另见
// 末两段:getScalarChildValue 的空白值回落、顶层非元素节点下
// findFirstElement 的跳节点与 null 回落。

const parse = (text: string): DefElementNode => {
  const document = parseDefDocument(text);
  const root = document.root;
  if (!root) {
    throw new Error('fixture must have a root element');
  }
  return root;
};

const firstTextNode = (element: DefElementNode): DefTextNode => {
  const [textNode] = getDirectTextNodes(element);
  if (!textNode) {
    throw new Error('fixture must contain a text node');
  }
  return textNode;
};

describe('getDirectTextNodes', () => {
  it('returns an empty array for a null node', () => {
    expect(getDirectTextNodes(undefined)).toEqual([]);
    expect(getDirectTextNodes(null)).toEqual([]);
  });

  it('collects only the direct text children of an element', () => {
    const root = parse('<root><a>hello</a></root>');
    const a = getDirectChildElement(root, 'a');

    expect(a).toBeDefined();
    const textNodes = getDirectTextNodes(a);
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0].text).toBe('hello');
    expect(textNodes[0].parent).toBe(a);
  });
});

describe('getElementText', () => {
  it('returns an empty string for a null node', () => {
    expect(getElementText(undefined)).toBe('');
    expect(getElementText(null)).toBe('');
  });

  it('concatenates adjacent text children including cdata', () => {
    const root = parse('<root><a><![CDATA[x]]>y</a></root>');
    const a = getDirectChildElement(root, 'a');

    expect(getElementText(a)).toBe('xy');
  });
});

describe('findAncestorElement', () => {
  it('returns null for a null node', () => {
    expect(findAncestorElement(undefined, 'root')).toBeNull();
    expect(findAncestorElement(null, ['root'])).toBeNull();
  });

  it('walks up from a text node through its parent chain', () => {
    const root = parse('<root><a>hello</a></root>');
    const a = getDirectChildElement(root, 'a');
    const textNode = firstTextNode(a);

    // 文本节点自身非 element,从 parent 起找;字符串名与数组名两形态
    expect(findAncestorElement(textNode, 'root')).toBe(root);
    expect(findAncestorElement(textNode, ['nope', 'root'])).toBe(root);
    expect(findAncestorElement(a, ['root'])).toBe(root);
  });

  it('returns null when the chain is exhausted without a match', () => {
    const root = parse('<root><a>x</a></root>');
    expect(findAncestorElement(root, ['no-such'])).toBeNull();
  });
});

describe('assignTextNodePosition fallbacks via parseDefDocument', () => {
  it('collapses to the search offset when decoded text cannot be found literally', () => {
    // '&quot;' 解码为 '"',解码产物在原文中已不存在,indexOf 落空回退
    // searchOffset(即 <a> 开标结束处)
    const root = parse('<root><a>&quot;</a></root>');
    const a = getDirectChildElement(root, 'a');
    const textNode = firstTextNode(a);

    expect(textNode.text).toBe('"');
    expect(textNode.startOffset).toBe(9);
    expect(textNode.endOffset).toBe(9);
  });

  it('keeps an empty cdata text at the search offset', () => {
    const root = parse('<root><a><![CDATA[]]></a></root>');
    const a = getDirectChildElement(root, 'a');
    const textNode = firstTextNode(a);

    expect(textNode.text).toBe('');
    expect(textNode.startOffset).toBe(textNode.endOffset);
    expect(textNode.startOffset).toBeGreaterThanOrEqual(9);
  });

  it('keeps a top-level CDATA text node out of the root lookup', () => {
    // 批63 分支:首个元素之前的顶层非元素节点 —— 顶层 CDATA 是 fxp 唯一
    // 会入树的非元素节点(注释不产出、<?pi?> 被 isNonElementXmlNode 跳过),
    // findFirstElement 的 for 循环必须跳过后才拿到 <root>
    const document = parseDefDocument('<![CDATA[leading]]><root><a>1</a></root>');
    const kinds = document.nodes.map((node: DefNode) => node.kind);

    expect(kinds).toEqual(['text', 'element']);
    expect(document.root?.name).toBe('root');
    // 顶层文本自身也被归一化并定位(CDATA 原文起止)
    const leading = document.nodes[0] as DefTextNode;
    expect(leading.kind).toBe('text');
    expect(leading.text).toBe('leading');
    expect(document.text.slice(leading.startOffset, leading.endOffset)).toBe('leading');
    // root 的子树不受顶层文本影响
    expect(document.root?.children.map(node => node.kind)).toEqual(['element']);
  });

  it('falls back to a null root when the document holds no element', () => {
    // 批63 分支:循环走完仍未遇到 element 节点 → findFirstElement 返回 null
    const document = parseDefDocument('<![CDATA[only]]>');

    expect(document.nodes.map((node: DefNode) => node.kind)).toEqual(['text']);
    expect(document.root).toBeNull();
    const only = document.nodes[0] as DefTextNode;
    expect(only.text).toBe('only');
    expect(document.text.slice(only.startOffset, only.endOffset)).toBe('only');
  });

  it('skips processing instructions from the node tree at any depth', () => {
    // fxp preserveOrder 把 <?pi?> 产成 '?pi' 键(注释默认忽略不产出),
    // 归一化循环对其 continue:顶层与子节点位置的处理指令都不入节点树
    const document = parseDefDocument([
      '<?render mode="fast"?>',
      '<root>',
      '  <?stage one?>',
      '  <Child/>',
      '</root>'
    ].join('\n'));

    expect(document.nodes).toHaveLength(1);
    expect(document.root?.name).toBe('root');
    expect(getDirectChildElement(document.root as DefElementNode, 'Child')).toBeTruthy();
  });
});

// 批63 分支:getScalarChildValue 的 `value || undefined` 右臂 —— 子元素存在
// 但文本为空/纯空白时不回空串,而是与"无该子元素"同形返回 undefined。
describe('getScalarChildValue blank fallback', () => {
  const hpOf = (text: string): DefElementNode => {
    const root = parse(text);
    const hp = getDirectChildElement(root, 'hp');
    if (!hp) {
      throw new Error('fixture must contain <hp>');
    }
    return hp;
  };

  it('returns undefined for a whitespace-only scalar child', () => {
    const hp = hpOf('<root><hp><DetailLevel>   </DetailLevel><Name>NEAR</Name></hp></root>');

    // 子元素确实存在,命中点是 trim 后空串的 `|| undefined`,而非 !child 早退
    const blank = getDirectChildElement(hp, 'DetailLevel');
    expect(blank).toBeDefined();
    expect(getElementText(blank)).toBe('   ');
    expect(getScalarChildValue(hp, 'DetailLevel')).toBeUndefined();

    // 正向对照:非空值原样返回
    expect(getScalarChildValue(hp, 'Name')).toBe('NEAR');
    // 缺标签对照:!child 早退
    expect(getScalarChildValue(hp, 'Absent')).toBeUndefined();
  });

  it('returns undefined for a self-closing scalar child', () => {
    const hp = hpOf('<root><hp><DetailLevel/></hp></root>');
    const blank = getDirectChildElement(hp, 'DetailLevel');

    expect(blank).toBeDefined();
    expect(blank?.children).toEqual([]);
    expect(getElementText(blank)).toBe('');
    expect(getScalarChildValue(hp, 'DetailLevel')).toBeUndefined();
  });
});
