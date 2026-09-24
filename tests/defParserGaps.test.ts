import { describe, expect, it } from 'vitest';
import {
  DefElementNode,
  findAncestorElement,
  getDirectChildElement,
  getDirectTextNodes,
  getElementText,
  parseDefDocument
} from '../src/defParser';
import type { DefTextNode } from '../src/defParser';

// defParser 的遍历工具与文本定位缺口:getDirectTextNodes/getElementText
// 的空参守卫、findAncestorElement 的 null 守卫与文本节点 parent 回溯、
// assignTextNodePosition 的两个回退分支(实体解码后 indexOf 落空、
// 空 CDATA 文本),全部走真实 parseDefDocument 产物。

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
});
