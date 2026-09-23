// 极简 VS Code snippet 展开器:仅覆盖本项目 snippet 正文用到的语法。
// 变量(${CURRENT_YEAR} 等)取固定值;占位符 ${n:default} 取 default 文本;
// 选择项 ${n|a,b,c|} 取第一项;纯 tabstop $n/$0 展开为空串。
const VARIABLES: Record<string, string> = {
  CURRENT_YEAR: '2026',
  CURRENT_MONTH: '09',
  CURRENT_DATE: '23'
};

export function expandSnippetBody(body: string[]): string {
  let text = body.join('\n');

  for (const [name, value] of Object.entries(VARIABLES)) {
    text = text.split('${' + name + '}').join(value);
  }

  text = text.replace(/\$\{\d+:((?:[^{}]|\$\{[^{}]*\})*)\}/g, (_, nested: string) => {
    return nested.replace(/\$\{[^{}]*\}/g, '');
  });
  text = text.replace(/\$\{\d+\|([^|]*)\|\}/g, (_, choices: string) => choices.split(',')[0]);
  text = text.replace(/\$\{\d+\}/g, '');
  text = text.replace(/\$\d+/g, '');

  return text;
}
