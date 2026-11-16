#!/usr/bin/env node
// RUST-170 真机验证:对 Pyright 真实语言服务器进程验证 stub 优先级与跳转目标
// (go-to-definition 返回的真实 URI),不凭猜测宣称跳源成功。
// 用法: node scripts/verify/lsp-stub-priority.mjs [--server pyright]
//       node scripts/verify/lsp-stub-priority.mjs --emit-fixture <dir>
// 输出: JSON 证据(每变体 expected/actual/pass),全部变体 pass 时 exit 0。
//
// 优先级口径(两真实服务器实测,见 docs/review/2026-11-17-rust-170-stub-priority-
// realenv.md):绝对 import 的解析序=stubPath > extraPaths > 同目录 .pyi——
// importer 自身目录不是绝对 import 的搜索根,同名 .pyi 只在无其他来源时兜底
// 命中(旧文档口径「同名 .pyi 最优先」是错的)。四变体分别裁掉上层,断言
// 定义跳转逐级落位。
//
// Pylance 车道:server.bundle.js 脱离 VS Code 宿主对 initialize 零响应
// (VS Code 耦合,首轮实测),不能独立驱动;Pylance 侧由真机套件
// src/test/electron/suite/pylanceStubPriority.test.ts(runTest.js --pylance)
// 在真 VS Code + 真扩展宿主内逐级裁层验证,--emit-fixture 就是为它建夹具。

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SERVERS = {
  pyright: { cmd: 'pyright-langserver', args: ['--stdio'] }
};

const SAME_DIR_PYI = `def addTimer(interval: float) -> int:
    """tier1 same-dir decoy"""
    ...

`;

const STUB_PATH_PYI = `def addTimer(interval: float, repeat: int = 0) -> int:
    """tier2 stubPath"""
    ...

def cancelTimer(timerId: int) -> None:
    ...

`;

const EXTRA_PATHS_PYI = `def addTimer(interval: float, repeat: int = 0) -> str:
    """tier3 extraPaths"""
    ...

`;

const AVATAR_PY = `import KBEngine


class Avatar:
    def onEnter(self):
        KBEngine.addTimer(1.0)
`;

// ---- 最小 LSP 客户端(Content-Length 帧 + 请求关联) ----
class Lsp {
  constructor(proc) {
    this.proc = proc;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    proc.stdout.on('data', chunk => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    proc.stderr.on('data', () => {/* 服务器 stderr(license 横幅等)不入证据 */});
  }

  drain() {
    for (;;) {
      const headEnd = this.buf.indexOf('\r\n\r\n');
      if (headEnd < 0) return;
      const head = this.buf.slice(0, headEnd).toString();
      const match = /Content-Length: (\d+)/i.exec(head);
      if (!match) {
        this.buf = this.buf.slice(headEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headEnd + 4;
      if (this.buf.length < bodyStart + length) return;
      const body = this.buf.slice(bodyStart, bodyStart + length).toString();
      this.buf = this.buf.slice(bodyStart + length);
      const message = JSON.parse(body);
      if (message.id !== undefined && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    }
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, message => {
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, timeoutMs);
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this.proc.stdin.write(body);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildFixture(ws, tiers) {
  mkdirSync(join(ws, 'scripts/entity'), { recursive: true });
  if (tiers.sameDir) writeFileSync(join(ws, 'scripts/KBEngine.pyi'), SAME_DIR_PYI);
  if (tiers.stubPath) {
    mkdirSync(join(ws, '.kbengine/stubs'), { recursive: true });
    writeFileSync(join(ws, '.kbengine/stubs/KBEngine.pyi'), STUB_PATH_PYI);
  }
  if (tiers.extraPaths) {
    mkdirSync(join(ws, 'extraroot'), { recursive: true });
    writeFileSync(join(ws, 'extraroot/KBEngine.pyi'), EXTRA_PATHS_PYI);
  }
  writeFileSync(join(ws, 'scripts/entity/Avatar.py'), AVATAR_PY);
  // 两服务器同读 pyrightconfig.json(Pylance 兼容 pyright 配置面),一个夹具服务两条车道
  writeFileSync(
    join(ws, 'pyrightconfig.json'),
    JSON.stringify(
      {
        stubPath: '.kbengine/stubs',
        extraPaths: ['extraroot'],
        reportMissingModuleSource: 'none'
      },
      null,
      2
    )
  );
}

function locateCall(text) {
  // 目标:KBEngine.addTimer 调用点上的 addTimer 标识符(ASCII 夹具,UTF-16 列=字符数)
  const at = text.indexOf('KBEngine.addTimer');
  if (at < 0) throw new Error('fixture call site missing');
  const before = text.slice(0, at);
  const line = before.split('\n').length - 1;
  const character = at - (before.lastIndexOf('\n') + 1) + 'KBEngine.'.length;
  return { line, character };
}

function normalizeDefinition(result) {
  if (!result) return [];
  const array = Array.isArray(result) ? result : [result];
  return array.map(entry =>
    entry.targetUri
      ? { uri: entry.targetUri, line: entry.targetSelectionRange.start.line, character: entry.targetSelectionRange.start.character }
      : { uri: entry.uri, line: entry.range.start.line, character: entry.range.start.character }
  );
}

function summarizeHover(hover) {
  if (!hover) return null;
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  const texts = contents.map(item =>
    typeof item === 'string' ? item : (item.value ?? '')
  );
  return texts.join('\n').slice(0, 400);
}

async function runVariant(serverKey, name, tiers, expectedSuffix) {
  const ws = mkdtempSync(join(tmpdir(), `lsp-stub-${serverKey}-`));
  buildFixture(ws, tiers);
  const { cmd, args } = SERVERS[serverKey];
  const proc = spawn(cmd, args, { cwd: ws });
  const lsp = new Lsp(proc);
  try {
    const init = await lsp.request('initialize', {
      processId: process.pid,
      rootUri: `file://${ws}`,
      workspaceFolders: [{ uri: `file://${ws}`, name: 'ws' }],
      capabilities: {}
    });
    lsp.notify('initialized', {});
    const avatarPath = join(ws, 'scripts/entity/Avatar.py');
    const text = readFileSync(avatarPath, 'utf8');
    lsp.notify('textDocument/didOpen', {
      textDocument: { uri: `file://${avatarPath}`, languageId: 'python', version: 1, text }
    });
    const position = locateCall(text);
    let definition = null;
    let hover = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(500);
      definition = await lsp.request('textDocument/definition', {
        textDocument: { uri: `file://${avatarPath}` },
        position
      });
      const normalized = normalizeDefinition(definition);
      if (normalized.length > 0) {
        hover = await lsp.request('textDocument/hover', {
          textDocument: { uri: `file://${avatarPath}` },
          position
        });
        break;
      }
    }
    const normalized = normalizeDefinition(definition);
    const actual = normalized.map(entry => entry.uri);
    const pass =
      normalized.length > 0 &&
      normalized.every(entry => entry.uri.endsWith(expectedSuffix));
    await lsp.request('shutdown', null).catch(() => undefined);
    return {
      variant: name,
      tiers,
      expectedSuffix,
      actualUris: actual,
      definitionLines: normalized.map(entry => entry.line + 1),
      hover: summarizeHover(hover),
      serverInfo: init?.serverInfo ?? null,
      pass
    };
  } finally {
    proc.kill();
    proc.stdin?.end();
    rmSync(ws, { recursive: true, force: true });
  }
}

// 期望以真实进程实测为准(pyright 1.1.414 第一轮跑出的就是裁定证据;
// Pylance 2026.4.1 真机套件同裁定,见 electron 车道):绝对 import 解析序
// stubPath > extraPaths > 同目录 .pyi。
const VARIANTS = [
  {
    name: 'A 三层并存:stubPath 胜出',
    tiers: { sameDir: true, stubPath: true, extraPaths: true },
    expectedSuffix: '/.kbengine/stubs/KBEngine.pyi'
  },
  {
    name: 'B 裁掉同目录:stubPath 仍胜(同目录不参与)',
    tiers: { sameDir: false, stubPath: true, extraPaths: true },
    expectedSuffix: '/.kbengine/stubs/KBEngine.pyi'
  },
  {
    name: 'C 同目录与 stubPath 皆缺:回退 extraPaths',
    tiers: { sameDir: false, stubPath: false, extraPaths: true },
    expectedSuffix: '/extraroot/KBEngine.pyi'
  },
  {
    name: 'D 无 stubPath:extraPaths 胜同目录(同目录不参与)',
    tiers: { sameDir: true, stubPath: false, extraPaths: true },
    expectedSuffix: '/extraroot/KBEngine.pyi'
  }
];

const emitFixtureAt = process.argv.includes('--emit-fixture')
  ? process.argv[process.argv.indexOf('--emit-fixture') + 1]
  : null;
if (emitFixtureAt) {
  buildFixture(emitFixtureAt, { sameDir: true, stubPath: true, extraPaths: true });
  // Pylance 车道补 VS Code 设置面:Pylance 读 python.analysis.*(不读
  // pyrightconfig.json,该文件只服务对照车道);同时把 kode 自身的 stub
  // 同步关掉,避免其激活链写设置污染测量面。
  mkdirSync(join(emitFixtureAt, '.vscode'), { recursive: true });
  writeFileSync(
    join(emitFixtureAt, '.vscode/settings.json'),
    JSON.stringify(
      {
        'python.analysis.stubPath': '.kbengine/stubs',
        'python.analysis.extraPaths': ['extraroot'],
        'kbengine.showFinalConfigOnOpen': false,
        'kbengine.python.stubExport': false,
        'kbengine.python.extraPathsSync': false
      },
      null,
      2
    )
  );
  process.stderr.write(`fixture emitted at ${emitFixtureAt}\n`);
  process.exit(0);
}

const requested = process.argv.includes('--server')
  ? process.argv[process.argv.indexOf('--server') + 1]
  : null;
const serverKeys = requested ? [requested] : Object.keys(SERVERS);
const evidence = {};
let allPass = true;

for (const serverKey of serverKeys) {
  const variants = [];
  for (const variant of VARIANTS) {
    process.stderr.write(`[${serverKey}] ${variant.name} ...\n`);
    variants.push(await runVariant(serverKey, variant.name, variant.tiers, variant.expectedSuffix));
  }
  evidence[serverKey] = variants;
  const failed = variants.filter(variant => !variant.pass);
  if (failed.length > 0) {
    allPass = false;
    process.stderr.write(`[${serverKey}] FAILED: ${failed.map(v => v.variant).join(' | ')}\n`);
  } else {
    process.stderr.write(`[${serverKey}] all ${variants.length} variants pass\n`);
  }
}

console.log(JSON.stringify(evidence, null, 2));
process.exit(allPass ? 0 : 1);
