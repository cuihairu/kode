import { describe, expect, it } from 'vitest';
import {
  DefElementNode,
  findAncestorElement,
  findDeepestElementAtOffset,
  findTextNodeAtOffset,
  getDirectChildElement,
  getDirectChildElementsByName,
  getElementText,
  getLineNumberAt,
  getScalarChildValue,
  getScalarChildValues,
  hasTruthyChildTag,
  isElementNode,
  parseDefDocument
} from '../src/defParser';

// 行号带注释,断言全部基于这些行号(1 基)
const DEF_TEXT = [
  '<root>',                              // 1
  '  <Properties>',                      // 2
  '    <health Utype="101">',            // 3
  '      <Type>UINT32</Type>',           // 4
  '      <Flags>BASE_AND_CLIENT</Flags>',// 5
  '    </health>',                       // 6
  '    <bag>',                           // 7
  '      <Type>',                        // 8
  '        ARRAY',                       // 9
  '        <of>UINT32</of>',             // 10
  '      </Type>',                       // 11
  '      <Flags>CELL_PUBLIC</Flags>',    // 12
  '    </bag>',                          // 13
  '  </Properties>',                     // 14
  '  <BaseMethods>',                     // 15
  '    <attack>',                        // 16
  '      <Arg>UINT32</Arg>',             // 17
  '      <Exposed/>',                    // 18
  '    </attack>',                       // 19
  '  </BaseMethods>',                    // 20
  '</root>'                              // 21
].join('\n');

describe('parseDefDocument', () => {
  const document = parseDefDocument(DEF_TEXT);

  it('builds a tree whose root is the first element', () => {
    expect(document.root).not.toBeNull();
    expect(document.root!.name).toBe('root');
    expect(isElementNode(document.root)).toBe(true);
  });

  it('resolves element names and attributes', () => {
    const health = getDirectChildElement(
      getDirectChildElement(document.root, 'Properties'),
      'health'
    );

    expect(health).toBeDefined();
    expect(health!.attributes['Utype']).toBe('101');
  });

  it('records exact offsets for tags', () => {
    const health = getDirectChildElement(
      getDirectChildElement(document.root, 'Properties'),
      'health'
    )!;

    expect(DEF_TEXT.slice(health.tagStart, health.tagEnd)).toBe(
      '<health Utype="101">'
    );
    expect(DEF_TEXT.slice(health.closeTagStart, health.closeTagEnd)).toBe('</health>');
    expect(DEF_TEXT.slice(health.contentStart, health.contentEnd)).toBe(
      '\n      <Type>UINT32</Type>\n      <Flags>BASE_AND_CLIENT</Flags>\n    '
    );
  });

  it('supports self-closing elements', () => {
    const exposed = getDirectChildElement(
      getDirectChildElement(document.root, 'BaseMethods'),
      'attack'
    )!.children.filter(isElementNode).find(child => child.name === 'Exposed')!;

    expect(exposed.selfClosing).toBe(true);
    expect(getElementText(exposed)).toBe('');
  });

  it('reads scalar child values in order and per name', () => {
    const health = getDirectChildElement(
      getDirectChildElement(document.root, 'Properties'),
      'health'
    )!;

    expect(getScalarChildValue(health, 'Type')).toBe('UINT32');
    expect(getScalarChildValue(health, 'Missing')).toBeUndefined();

    const attack = getDirectChildElement(
      getDirectChildElement(document.root, 'BaseMethods'),
      'attack'
    )!;
    expect(getScalarChildValues(attack, 'Arg')).toEqual(['UINT32']);
    expect(getScalarChildValues(attack, 'Missing')).toEqual([]);
  });

  it('treats self-closing and empty children as truthy flags', () => {
    const attack = getDirectChildElement(
      getDirectChildElement(document.root, 'BaseMethods'),
      'attack'
    )!;

    expect(hasTruthyChildTag(attack, 'Exposed')).toBe(true);
    expect(hasTruthyChildTag(attack, 'Missing')).toBe(false);
  });

  it('hasTruthyChildTag rejects explicit false', () => {
    const doc = parseDefDocument('<root><prop><Exposed>false</Exposed></prop></root>');
    const prop = getDirectChildElement(doc.root, 'prop')!;
    expect(hasTruthyChildTag(prop, 'Exposed')).toBe(false);
  });

  it('nests containers with <of> child elements', () => {
    const bagType = getDirectChildElement(
      getDirectChildElement(document.root, 'Properties'),
      'bag'
    )!.children.filter(isElementNode).find(child => child.name === 'Type')!;

    expect(getElementText(bagType).trim()).toBe('ARRAY');
    const of = getDirectChildElement(bagType, 'of');
    expect(of).toBeDefined();
    expect(getElementText(of!).trim()).toBe('UINT32');
  });

  it('finds repeated children by name', () => {
    const properties = getDirectChildElement(document.root, 'Properties')!;
    expect(
      getDirectChildElementsByName(properties, 'health').map(node => node.name)
    ).toEqual(['health']);
    expect(getDirectChildElementsByName(properties, 'missing')).toEqual([]);
  });
});

describe('defParser offsets and lookups', () => {
  const document = parseDefDocument(DEF_TEXT);

  it('converts offsets to 1-based line numbers', () => {
    expect(getLineNumberAt(document, 0)).toBe(1);
    // 第 10 行 '<of>UINT32</of>' 的行首偏移
    const lineStart = document.lineStarts[9];
    expect(DEF_TEXT.slice(lineStart).split('\n')[0]).toBe('        <of>UINT32</of>');
    expect(getLineNumberAt(document, lineStart)).toBe(10);
    expect(getLineNumberAt(document, DEF_TEXT.length)).toBe(21);
    expect(getLineNumberAt(document, DEF_TEXT.length + 1000)).toBe(21);
  });

  it('finds the deepest element at an offset', () => {
    const properties = getDirectChildElement(document.root, 'Properties')!;
    const health = getDirectChildElement(properties, 'health')!;
    const typeNode = getDirectChildElement(health, 'Type')!;

    const offsetInsideType = DEF_TEXT.indexOf('UINT32');
    expect(findDeepestElementAtOffset(document.root, offsetInsideType)).toBe(typeNode);

    const offsetInsideHealth = health.contentStart;
    expect(findDeepestElementAtOffset(document.root, offsetInsideHealth)).toBe(health);
    expect(findDeepestElementAtOffset(document.root, 0)).toBe(document.root);
    expect(findDeepestElementAtOffset(document.root, -1)).toBeNull();
  });

  it('finds text nodes at offsets', () => {
    const offset = DEF_TEXT.indexOf('BASE_AND_CLIENT');
    const textNode = findTextNodeAtOffset(document.root, offset);

    expect(textNode).not.toBeNull();
    expect(textNode!.text.trim()).toBe('BASE_AND_CLIENT');
    expect(DEF_TEXT.slice(textNode!.startOffset, textNode!.endOffset)).toBe('BASE_AND_CLIENT');
    expect(findTextNodeAtOffset(document.root, 0)).toBeNull();
  });

  it('walks ancestors from elements and text nodes', () => {
    const offset = DEF_TEXT.indexOf('BASE_AND_CLIENT');
    const textNode = findTextNodeAtOffset(document.root, offset)!;

    expect(findAncestorElement(textNode, 'health')!.name).toBe('health');
    expect(findAncestorElement(textNode, ['BaseMethods', 'Properties'])!.name).toBe('Properties');
    expect(findAncestorElement(textNode, 'not-present')).toBeNull();

    const health = findAncestorElement(textNode, 'health') as DefElementNode;
    expect(findAncestorElement(health, 'health')!.name).toBe('health');
  });
});

describe('parseDefDocument edge cases', () => {
  it('returns an empty document for empty input without throwing', () => {
    const document = parseDefDocument('');

    expect(document.root).toBeNull();
    expect(document.nodes).toEqual([]);
    expect(getLineNumberAt(document, 0)).toBe(1);
  });

  it('keeps whitespace-only text nodes when parsing', () => {
    const document = parseDefDocument('<root>  </root>');
    const root = document.root!;

    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({ kind: 'text' });
  });
});
