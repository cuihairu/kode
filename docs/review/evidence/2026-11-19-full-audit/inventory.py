"""Run from repo root. Inventory + lexical risk screening, NOT a correctness verdict."""
import csv,hashlib,json,re,subprocess
from pathlib import Path
out=Path('docs/review/evidence/2026-11-19-full-audit')
files=subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard']).decode().split('\0')
code={'.ts','.tsx','.js','.jsx','.mjs','.cjs','.rs','.py','.sh','.ps1','.bat','.cmd','.cpp','.c','.h','.hpp','.lua','.cs','.vue','.svelte','.html'}
config={'.json','.yaml','.yml','.toml'}
patterns={
 'sync_io':r'\b(?:readFileSync|readdirSync|statSync|execSync|spawnSync|writeFileSync)\b|std::fs::(?:read|read_to_string|read_dir)',
 'process':r'\b(?:spawn|execFile|exec|Command::new|wait_with_output)\s*\(',
 'lifecycle':r'\b(?:setInterval|setTimeout|dispose|shutdown|terminate)\s*\(',
 'shared_state':r'\b(?:new Map|new Set|Mutex|RwLock|static mut)\b',
 'errors':r'\b(?:unwrap|expect)\s*\(|catch\s*(?:\([^)]*\))?\s*\{',
 'webview':r'innerHTML|enableScripts|onDidReceiveMessage|isTrusted',
 'writes':r'\b(?:writeFile|write_file|execute_insert|commit|rename|remove_file|unlink)\s*\(',
 'await_boundary':r'\bawait\b|\.await\b',
}
rows=[]
for name in sorted(set(files)):
 p=Path(name)
 if not p.is_file() or name.startswith(str(out)) or name.startswith('docs/review/evidence/2026-11-19-responsiveness/'):
  continue
 kind='code' if p.suffix in code or name=='packages/kode-mcp/bin/kode-mcp' else 'config' if p.suffix in config else None
 if kind is None:continue
 data=p.read_bytes()
 try:text=data.decode('utf8')
 except UnicodeDecodeError:continue
 role='test/fixture' if '/tests/' in '/'+name or '/test/' in '/'+name or '/fixtures/' in '/'+name else 'generated' if '/generated/' in name or '/typings/' in '/'+name else 'implementation/tooling'
 flags={key:len(re.findall(pattern,text)) for key,pattern in patterns.items()}
 rows.append(dict(path=name,kind=kind,role=role,lines=len(text.splitlines()),bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),review='lexical-screen-only',**flags))
with (out/'file-inventory.csv').open('w',newline='') as f:
 writer=csv.DictWriter(f,fieldnames=rows[0].keys(),lineterminator='\n');writer.writeheader();writer.writerows(rows)
summary={'files':len(rows),'code_files':sum(r['kind']=='code' for r in rows),'config_files':sum(r['kind']=='config' for r in rows),'lines':sum(r['lines'] for r in rows),'scope':'git tracked + nonignored untracked textual code/config; excludes audit evidence; ignored build outputs/dependencies not reviewed','groups':{}}
for r in rows:
 parts=r['path'].split('/');group='/'.join(parts[:2]) if parts[0] in ('crates','plugins','packages','.github') else parts[0] if len(parts)>1 else '(root)'
 g=summary['groups'].setdefault(group,{'files':0,'lines':0});g['files']+=1;g['lines']+=r['lines']
(out/'inventory-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k!='groups'},ensure_ascii=False))
