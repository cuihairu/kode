#!/usr/bin/env node
// C-21:从 docs/knowledge/api-*.md(EN 正本)与 docs/zh/knowledge/ 中文孪生抽取
// 结构化 API 文档库。单一事实源 = 知识页(KB-API 批次已做源码 grounding),
// 生成物禁手工编辑;hover 文档库与 kode-server 嵌入面同源共享。
//
// 产物:
//   crates/kode-server/assets/api-docs.json   kode-server 嵌入正本(RPC/MCP 面)
//   src/generated/apiDocs.ts                  TS 镜像(hover 面;parity 测试锁一致)
//
// 用法:
//   node scripts/generate-api-docs.mjs            # 生成/重写(确定性)
//   node scripts/generate-api-docs.mjs --check    # 只校验内容一致(CI 防漂移)
//
// 解析口径(知识页三种成员形态统一抽取):
//   1) 标题面:`###/#### \`<签名>\` [*限定]`——签名必须含 `.` 或 `(`(裸节
//      标题如 `Callbacks`/`Attributes` 只是上下文,不产条目);分组标题按
//      ` / ` ` — ` 拆条;摘要 = 标题后首段。
//   2) 表格面:表头列角色推断——名字列(Function/Name/API/Member/Method/
//      Callback/Attribute)、签名列(Signature)、语义列(Semantics/Fires
//      when/Notes/…)、溯源列(Registration/Grounding/Evidence)。签名列
//      含 `(` 时是真签名(回填条目 signature),否则按散文摘要补位(这些
//      表的"Signature"列常是描述);偏差对照表(含 Verdict/claim 列或所在
//      节为 deviation/3.7 对照)与 References 节不产条目。
//   3) 列表面:`- \`签名\` / \`签名\` — 说明` 行;签名标题节内的列表是
//      该 API 的参数说明,不产条目(否则 `- \`errorCode\` is ...` 会把参数
//      名当成 API)。
//   token 纪律:含空白的 token 必须是真签名(`X.y(...)` 或 `name(...)`,
//      散文短语/文件名/dunder(`__x__`)一律不认);名字列反引号逗号组
//      (`\`a\`, \`b\`, \`c\`)逐个落条;裸名 kind=callback 仅认 `onXxx`
//      生命周期形态。owner/kind 缺省由最近 h2/h3 标题定;zh 摘要按条目键
//      (domain|owner|member)从中文孪生对齐,缺失留空(渲染面回退 en),
//      不猜不编。sourceRefs = 溯源列/行内 `path/file.cpp:line` 取前 3。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

// 页 → 域(base/cell 面 hover 按脚本目录优先;其余域走唯一命中回退)
const PAGES = [
  { file: 'api-baseapp.md', domain: 'base' },
  { file: 'api-baseapp-entity.md', domain: 'base' },
  { file: 'api-cellapp.md', domain: 'cell' },
  { file: 'api-cellapp-entity.md', domain: 'cell' },
  { file: 'api-client.md', domain: 'client' },
  { file: 'api-bots.md', domain: 'bots' },
  { file: 'api-interfaces.md', domain: 'interfaces' },
  { file: 'api-loginapp-dbmgr-logger.md', domain: 'server' },
  { file: 'api-core-concepts.md', domain: 'core' }
];

const ESCAPED_PIPE = '\x00';
const SIGNATURE_TOKEN_RE = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)(\(.*)?$/s;
const CONSTANT_RE = /^[A-Z_][A-Z0-9_]*$/;
const PATH_REF_RE = /((?:kbe\/src\/)?(?:lib|server|client_lib)\/[a-z0-9_\/]+\.(?:cpp|h)):(\d+(?:-\d+)?)/g;
const BARE_REF_RE = /\b([a-z0-9_]+\.(?:cpp|h)):(\d+(?:-\d+)?)/gi;
const NAME_HEADER_RE = /^(function|signature|callback|attribute|member|method|api|name|entry)/i;
const SIG_COL_RE = /^(signature|sig)\b/i;
const SUM_HEADER_RE = /(semantics|description|fires?d? when|behavior|verified|notes|meaning|summary|purpose|trigger|actually does|source material)/i;
const REF_HEADER_RE = /(registration|impl|grounding|evidence|anchor|source)/i;
const SKIP_CONTEXT_RE = /(deviation|source material vs|references|coverage summary|open evidence)/i;
const SKIP_HEADER_RE = /(verdict|claim)/i;

function unescapePipes(text) {
  return text.replaceAll('\\|', ESCAPED_PIPE);
}

function restoreAndClean(text) {
  return text.replaceAll(ESCAPED_PIPE, '|').replace(/\s+/g, ' ').trim();
}

function stripBackticks(text) {
  return text.replace(/`([^`]*)`/g, '$1');
}

/** 上下文(h2/h3 标题)→ {owner, kind} 缺省 */
function contextOwnerKind(title) {
  let owner = '';
  if (/proxy/i.test(title)) {
    owner = 'proxy';
  } else if (/\bentities\b|\bentity\b/i.test(title)) {
    owner = 'entity';
  } else if (/KBEngine|module|function|member|portal|entry[- ]script|constant|error code/i.test(title)) {
    owner = 'KBEngine';
  }
  let kind = '';
  if (/callback/i.test(title)) {
    kind = 'callback';
  } else if (/attribute/i.test(title)) {
    kind = 'attr';
  } else if (/constant|error code/i.test(title)) {
    kind = 'constant';
  }
  return { owner, kind };
}

/** 限定词兼容全角括号(中文孪生:*（回调）*) */
function qualifierOf(text) {
  return ((text.match(/\*[（(]([^)）]*)[)）]\*/) || [])[1] || '').trim();
}

/** 一段文本(标题/名字列单元格)拆出签名 token 列表 */
function extractTokens(text) {
  const backticked = [...text.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(Boolean);
  const qualifier = qualifierOf(text.replace(/`[^`]+`/g, ''));
  if (backticked.length > 0) {
    return backticked.map(rawSig => ({ rawSig, qualifier }));
  }
  // 无反引号:按 ` / ` ` — ` 分组,组内自带限定词形态
  return text
    .split(/\s+[\/—]\s+/)
    .map(part => ({ rawSig: part.replace(/\*[（(][^)）]*[)）]\*/, '').trim(), qualifier: qualifierOf(part) }));
}

const CALLBACK_RE = /callback|回调/i;

/** token → 条目骨架;认不得的 token(散文/文件名/dunder)返回 null */
function skeletonFromToken(rawSig, qualifier, context, kindHint = '') {
  if (CONSTANT_RE.test(rawSig)) {
    return { owner: 'constant', member: rawSig, kind: 'constant', signature: rawSig, qualifier };
  }
  // 文件名/跨页引用不是签名(`basetypes.md`、`api-baseapp.md` 等)
  if (/\.(md|cpp|h|hpp|xml|py|json|txt|chm)$/i.test(rawSig)) {
    return null;
  }
  const sig = SIGNATURE_TOKEN_RE.exec(rawSig);
  if (sig) {
    const kind = CALLBACK_RE.test(qualifier)
      ? 'callback'
      : sig[3]
        ? 'method'
        : 'attr';
    // `entities` 字典行文档的是其中 Entity 对象的属性,归 entity 面
    const owner = sig[1] === 'entities' ? 'entity' : sig[1];
    return { owner, member: sig[2], kind, signature: rawSig, qualifier };
  }
  // 含空白的裸文本不是签名(`watcher queries`、`movement request handled
  // by …` 之类的散文单元格)
  if (/\s/.test(rawSig)) {
    return null;
  }
  // dunder 复刻钩子(`__reduce_ex__`)不是用户 API 面
  if (/^__\w*_$/.test(rawSig)) {
    return null;
  }
  const bare = /^([A-Za-z_]\w*)(\(.*)?$/s.exec(rawSig);
  if (!bare || rawSig.includes('.')) {
    return null;
  }
  const owner = context.owner;
  if (!owner) {
    return null;
  }
  // kind 缺省:限定词 callback > 表头角色(callback/attribute)> 节上下文 >
  // method(模块函数节里的裸名列表按方法面收录)
  let kind = CALLBACK_RE.test(qualifier)
    ? 'callback'
    : (kindHint || context.kind || 'method');
  // 裸名 callback 只认 `onXxx` 生命周期形态(参数名/杂项不冒充回调)
  if (kind === 'callback' && !/^on[A-Z]/.test(bare[1])) {
    kind = 'method';
  }
  return { owner, member: bare[1], kind, signature: rawSig, qualifier };
}

function collectRefs(text, limit = 3) {
  const refs = [];
  const push = ref => {
    if (ref && !refs.includes(ref) && refs.length < limit) {
      refs.push(ref);
    }
  };
  PATH_REF_RE.lastIndex = 0;
  let m;
  while ((m = PATH_REF_RE.exec(text)) !== null) {
    push(`${m[1]}:${m[2]}`);
  }
  if (refs.length === 0) {
    BARE_REF_RE.lastIndex = 0;
    while ((m = BARE_REF_RE.exec(text)) !== null) {
      push(`${m[1]}:${m[2]}`);
    }
  }
  return refs;
}

/** 表头行 → 列角色(名字/签名/语义/溯源索引);名字列识别不了返回 null */
function tableRoles(headerCells) {
  const name = [];
  const sig = [];
  const sum = [];
  const ref = [];
  let kindHint = '';
  headerCells.forEach((cell, index) => {
    const label = stripBackticks(cell).trim();
    if (SIG_COL_RE.test(label)) {
      sig.push(index);
    } else if (NAME_HEADER_RE.test(label)) {
      name.push(index);
      if (/^callback$/i.test(label)) {
        kindHint = 'callback';
      } else if (/^attribute$/i.test(label)) {
        kindHint = 'attr';
      }
    } else if (REF_HEADER_RE.test(label)) {
      ref.push(index);
    } else if (SUM_HEADER_RE.test(label)) {
      sum.push(index);
    }
  });
  if (name.length === 0) {
    return null;
  }
  return { name, sig, sum, ref, kindHint };
}

function splitTableRow(line) {
  return unescapePipes(line.trim())
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(restoreAndClean);
}

/**
 * 解析一页 → Map<entryKey, entry>(含 summary;不带 zh)。
 * priority: heading(3) > table(2) > bullet(1),高优先已存在不覆盖。
 */
function parsePage(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const entries = new Map();
  let context = { owner: '', kind: '' };
  let skipSection = false;
  let pendingHeading = null; // {skeletons, startLine} 等首段摘要的标题条目
  let sigHeadingSection = false; // 当前 h3/h4 是签名标题 → 其内列表是参数说明

  const keyOf = e => `${e.domain}|${e.owner}|${e.member}`;

  const put = (skeleton, summary, refs, priority, page) => {
    if (!skeleton || !skeleton.member) {
      return;
    }
    const entry = {
      member: skeleton.member,
      owner: skeleton.owner,
      domain: page.domain,
      kind: skeleton.kind,
      signature: skeleton.signature,
      qualifier: skeleton.qualifier,
      summaryEn: summary.slice(0, 600),
      summaryZh: '',
      sourceRefs: refs,
      page: page.file.replace(/\.md$/, '')
    };
    const key = keyOf(entry);
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, { ...entry, priority });
      return;
    }
    if (existing.priority < priority) {
      entries.set(key, { ...entry, priority });
    } else if (existing.priority === priority) {
      // 同优先级:带参签名 > callback 标注 > 先到先得
      const betterSig = !existing.signature.includes('(') && entry.signature.includes('(');
      const betterKind = existing.kind !== 'callback' && entry.kind === 'callback';
      const betterSummary = existing.summaryEn === '' && entry.summaryEn !== '';
      if (betterSig || betterKind || betterSummary) {
        entries.set(key, { ...entry, priority });
      }
    }
  };

  const page = { file: path.basename(filePath), domain: PAGES.find(p => p.file === path.basename(filePath))?.domain ?? '' };

  let tableRolesCache = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const h2 = /^## (.+)$/.exec(line);
    const h3 = /^### (.+)$/.exec(line);
    const h4 = /^#### (.+)$/.exec(line);
    if (h2) {
      context = contextOwnerKind(h2[1]);
      skipSection = SKIP_CONTEXT_RE.test(h2[1]);
      pendingHeading = null;
      sigHeadingSection = false;
      tableRolesCache = null;
      continue;
    }
    if (h3 || h4) {
      const title = (h3 || h4)[1].trim();
      const sub = contextOwnerKind(title);
      context = { owner: sub.owner || context.owner, kind: sub.kind || context.kind };
      skipSection = SKIP_CONTEXT_RE.test(title);
      tableRolesCache = null;
      // h3/h4 反引号签名标题 → 标题面条目;裸节标题(`Callbacks` 等)只是
      // 上下文切换,不产条目
      const skeletons = extractTokens(title)
        .map(t => skeletonFromToken(t.rawSig, t.qualifier, context))
        .filter(s => s && /[.(]/.test(s.signature));
      if (skeletons.length > 0) {
        pendingHeading = { skeletons, startLine: i + 1 };
        sigHeadingSection = true;
      } else {
        pendingHeading = null;
        sigHeadingSection = false;
      }
      continue;
    }

    if (skipSection) {
      continue;
    }

    // 标题面条目的摘要:标题后首个非空段(到下一个标题为止)
    if (pendingHeading) {
      const trimmed = line.trim();
      if (trimmed === '') {
        if (pendingHeading.bodyStarted) {
          pendingHeading = null; // 首段已收,后续段不再挂
        }
        continue;
      }
      const body = collectBodyUntilNextHeading(lines, pendingHeading.startLine);
      const blocks = body.split(/\n\s*\n/).map(b => restoreAndClean(stripBackticks(b))).filter(Boolean);
      const summary = blocks.length > 0 ? blocks[0] : '';
      const refs = collectRefs(body);
      for (const skeleton of pendingHeading.skeletons) {
        put(skeleton, summary, refs, 3, page);
      }
      pendingHeading = null;
      continue;
    }

    // 表格行
    if (line.trim().startsWith('|')) {
      const cells = splitTableRow(line);
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) {
        continue; // 分隔行
      }
      if (!tableRolesCache) {
        const roles = tableRoles(cells);
        // 偏差对照表(Verdict/claim 列)与纯排版表都不产条目
        tableRolesCache = roles && !cells.some(c => SKIP_HEADER_RE.test(stripBackticks(c)))
          ? roles
          : { skip: true };
        continue; // 表头行自身不产条目
      }
      if (tableRolesCache.skip) {
        continue;
      }
      const roles = tableRolesCache;
      const nameText = restoreAndClean(roles.name.map(idx => cells[idx] || '').join(' '));
      const sigText = restoreAndClean(stripBackticks(roles.sig.map(idx => cells[idx] || '').join(' ')));
      const summary = restoreAndClean(stripBackticks(roles.sum.map(idx => cells[idx] || '').join(' '))).replaceAll('`', '');
      const refs = collectRefs(restoreAndClean(roles.ref.map(idx => cells[idx] || '').join(' ')));
      for (const token of extractTokens(nameText)) {
        const skeleton = skeletonFromToken(token.rawSig, token.qualifier, context, roles.kindHint);
        if (!skeleton) {
          continue;
        }
        let entrySummary = summary;
        if (sigText) {
          if (/\(/.test(sigText)) {
            // 真签名列:回填条目签名(名字列常是裸名)
            skeleton.signature = sigText;
          } else if (!entrySummary) {
            // 这些表的"Signature"列其实是描述(「debug assert hook」)
            entrySummary = restoreAndClean(stripBackticks(sigText));
          }
        }
        put(skeleton, entrySummary, refs, 2, page);
      }
      continue;
    }

    // 列表面:`- \`签名\` / \`签名\` — 说明`;必须是真列表行(续行散文以
    // 反引号开头也不冒充);签名标题节内的列表是参数说明,跳过
    const bulletPrefix = /^[-*]\s+/.exec(line);
    // bullet 的 token 分隔只有 ` / ` `、`;` — ` 是 token 与摘要的分界
    const bulletSection = bulletPrefix
      ? /^(?:`[^`]+`(?:\s*[\/,]\s*`[^`]+`)*)/.exec(line.slice(bulletPrefix[0].length))
      : null;
    if (bulletSection && !sigHeadingSection) {
      const tokenSpan = bulletSection[0];
      const tail = line.slice(bulletPrefix[0].length).slice(tokenSpan.length);
      let summary = restoreAndClean(stripBackticks(tail.replace(/^\s*[—:：-]\s*/, ''))).replaceAll('`', '');
      // 行首溯源括注(`\`onRestore()\` (\`entity.cpp:...\`, …): prose`)不算摘要
      const refParen = /^\(([^()]*(?:\.(?:cpp|h))[^()]*)\)[,，;]?\s*/.exec(summary);
      if (refParen) {
        summary = summary.slice(refParen[0].length);
      }
      const refs = collectRefs(line);
      for (const token of extractTokens(tokenSpan)) {
        put(skeletonFromToken(token.rawSig, token.qualifier, context), summary, refs, 1, page);
      }
      continue;
    }
    if (!line.trim().startsWith('|')) {
      tableRolesCache = null; // 表格结束
    }
  }
  return entries;
}

function collectBodyUntilNextHeading(lines, start) {
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^#{2,4} /.test(lines[i])) {
      break;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

const pageEntries = new Map(); // entryKey → entry
// 逐页:EN 页产条目;zh 页按同键补 summaryZh
for (const page of PAGES) {
  const enPath = path.join(repoRoot, 'docs', 'knowledge', page.file);
  const zhPath = path.join(repoRoot, 'docs', 'zh', 'knowledge', page.file);
  const enEntries = parsePage(enPath);
  if (fs.existsSync(zhPath)) {
    const zhEntries = parsePage(zhPath);
    for (const [key, zhEntry] of zhEntries) {
      const en = enEntries.get(key);
      if (en && zhEntry.summaryEn) {
        en.summaryZh = zhEntry.summaryEn; // zh 页的"summary"即中文摘要
      }
    }
  }
  for (const [key, entry] of enEntries) {
    const { priority, ...clean } = entry;
    const existing = pageEntries.get(key);
    // 同域两页(如 base 两页)撞键时保留有摘要的一方
    if (!existing || (existing.summaryEn === '' && clean.summaryEn !== '')) {
      pageEntries.set(key, clean);
    }
  }
}

const entries = [...pageEntries.values()].sort((a, b) =>
  a.domain.localeCompare(b.domain) ||
  a.owner.localeCompare(b.owner) ||
  a.member.localeCompare(b.member) ||
  a.signature.localeCompare(b.signature));

if (entries.length < 120) {
  console.error(`generate-api-docs: 条目数异常(${entries.length} < 120),知识页结构可能变了`);
  process.exit(1);
}

const manifest = {
  version: 1,
  generatedFrom: PAGES.map(p => `docs/knowledge/${p.file}`),
  entryCount: entries.length,
  entries
};
const jsonText = JSON.stringify(manifest, null, 2) + '\n';

const tsText = `// 生成的 API 文档库 TS 镜像(C-21)。禁手工编辑——
// 由 scripts/generate-api-docs.mjs 从 docs/knowledge/api-*.md 抽取,
// 与 crates/kode-server/assets/api-docs.json 同源(tests/apiDocsParity.test.ts 锁一致)。

/** 单条 API 文档条目(与 kode-server assets/api-docs.json 同 schema) */
export interface ApiDocEntry {
  readonly member: string;
  readonly owner: string;
  readonly domain: string;
  readonly kind: 'method' | 'callback' | 'attr' | 'constant';
  readonly signature: string;
  readonly qualifier: string;
  readonly summaryEn: string;
  readonly summaryZh: string;
  readonly sourceRefs: readonly string[];
  readonly page: string;
}

export const API_DOC_LIBRARY_VERSION = ${manifest.version};
export const API_DOC_ENTRY_COUNT = ${manifest.entryCount};

export const API_DOC_ENTRIES: readonly ApiDocEntry[] = ${JSON.stringify(entries, null, 2)};
`;

const outputs = [
  { file: path.join(repoRoot, 'crates', 'kode-server', 'assets', 'api-docs.json'), text: jsonText },
  { file: path.join(repoRoot, 'src', 'generated', 'apiDocs.ts'), text: tsText }
];

if (checkOnly) {
  let drifted = 0;
  for (const out of outputs) {
    if (!fs.existsSync(out.file) || fs.readFileSync(out.file, 'utf8') !== out.text) {
      console.error(`drift: ${path.relative(repoRoot, out.file)}`);
      drifted += 1;
    }
  }
  if (drifted > 0) {
    console.error('generate-api-docs: 生成物与知识页不一致,运行 node scripts/generate-api-docs.mjs 再生成');
    process.exit(1);
  }
  console.log(`ok: api-docs ${manifest.entryCount} entries`);
  process.exit(0);
}

for (const out of outputs) {
  fs.mkdirSync(path.dirname(out.file), { recursive: true });
  fs.writeFileSync(out.file, out.text);
  console.log(`wrote ${path.relative(repoRoot, out.file)} (${manifest.entryCount} entries)`);
}
