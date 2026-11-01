import { describe, expect, it } from 'vitest';
import { MessageChannel } from 'worker_threads';
import { parseDefDocument, type DefDocument, type DefElementNode } from '../src/defParser';

// IDE-REV-039:DefDocument 经 worker postMessage 回传(structured clone)。
// DefDocument/DefElementNode 全是 plain object,但 parent/document 回引成环
// ——本测试锁「克隆保持环回引与内部同一性」这一设计前提:节点身份
// (node.document === document)、parent 链、位置与文本。MessageChannel 的
// postMessage 与 worker_threads 同走 structured clone,同一算法。

const findElement = (node: DefElementNode | null | undefined, name: string): DefElementNode | undefined => {
  if (!node) { return undefined; }
  for (const child of node.children) {
    if (child.kind === 'element') {
      if (child.name === name) { return child; }
      const nested = findElement(child, name);
      if (nested) { return nested; }
    }
  }
  return undefined;
};

describe('DefDocument structured clone 回环(IDE-REV-039 设计前提)', () => {
  it('克隆后环回引与内部同一性保持:node.document===document、parent 链、位置、文本', async () => {
    const text = '<root>\n  <Properties>\n    <hp><Type>UINT32</Type><Persistent>true</Persistent></hp>\n  </Properties>\n</root>';
    const document = parseDefDocument(text);
    const channel = new MessageChannel();
    const received = await new Promise<DefDocument>(resolve => {
      channel.port1.on('message', (message: { document: DefDocument }) => { resolve(message.document); });
      channel.port2.postMessage({ document });
    });
    channel.port1.close();
    channel.port2.close();

    expect(received.text).toBe(document.text);
    expect(received.nodes.length).toBe(document.nodes.length);
    expect(received.root?.name).toBe('root');
    // 环回引:克隆文档内的元素指向克隆文档自身(内部同一性克隆后保持)
    expect(received.root?.document).toBe(received);
    // parent 链:hp → Properties → root
    const hp = findElement(received.root, 'hp');
    expect(hp).toBeTruthy();
    expect(hp?.parent?.name).toBe('Properties');
    expect(hp?.parent?.parent).toBe(received.root);
    // 位置与源文档逐字段一致
    const originalHp = findElement(document.root, 'hp');
    expect(hp?.tagStart).toBe(originalHp?.tagStart);
    expect(hp?.tagEnd).toBe(originalHp?.tagEnd);
    expect(hp?.contentStart).toBe(originalHp?.contentStart);
    expect(hp?.closeTagEnd).toBe(originalHp?.closeTagEnd);
    expect(hp?.selfClosing).toBe(originalHp?.selfClosing);
  });
});
