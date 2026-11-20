// Run from repository root. Current source with filesystem/VS Code transport fixtures.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
function load(file, deps) {
  const box = {exports:{}, require:name => Object.hasOwn(deps,name) ? deps[name] : require(name),
    Buffer, process, setTimeout, clearTimeout, setImmediate};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText,box,{filename:file});
  return box.exports;
}
(async()=>{
  const writes=[];
  const client={start:async()=>{},dispose:async()=>{},
    openDocument:(uri,lang,version,text)=>writes.push({op:'open',version,text}),
    changeDocument:(uri,version,text)=>writes.push({op:'change',version,text}),
    closeDocument:()=>writes.push({op:'close'})};
  const {KodeCoreGate}=load('src/backend/kodeCoreGate.ts',{
    './kodeCoreClient':{KodeCoreTransportError:class extends Error{}}, './fileChangeBypass':{}
  });
  const gate=new KodeCoreGate({clientFactory:()=>client});
  gate.setConfig({backend:'rust',serverPath:'/fake-server',shadowTimeoutMs:2000});
  let readStarted, finishRead;
  const started=new Promise(r=>{readStarted=r;});
  const uri={fsPath:'/fixture/A.def'};
  const vscode={Uri:{file:fsPath=>({fsPath})},workspace:{textDocuments:[],fs:{
    readFile:async()=>{readStarted();return new Promise(r=>{finishRead=r;});}
  }}};
  const {mirrorCorpusToRust}=load('src/kodeCoreCorpusMirror.ts',{'vscode':vscode,'./scanRoots':{}});
  // Warm endpoints are unrelated to race; actual gate mirrorDocument is retained.
  gate.beginBackgroundScan=async()=>{};gate.scanComplete=async()=>{};
  const scan=mirrorCorpusToRust(gate,async glob=>glob==='**/*.def'?[uri]:[],()=>[]);
  await started;
  vscode.workspace.textDocuments=[{uri,languageId:'kbengine-def',version:2,getText:()=>'<new/>'}];
  await gate.mirrorDocument(uri.fsPath,'kbengine-def',2,'<new/>');
  finishRead(Buffer.from('<old/>'));await scan;
  assert.deepEqual(writes.map(w=>w.op),['open','close','open']);
  assert.equal(writes.at(-1).version,1);assert.equal(writes.at(-1).text,'<old/>');
  console.log('RESP-007: actual mirror + gate emit open(v2,new), close, open(v1,old)');

  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kode-resp-probe-'));
  try {
    const ws=path.join(tmp,'ws'), ext=path.join(tmp,'assets');
    fs.mkdirSync(ws);fs.mkdirSync(path.join(ext,'.kbengine','inferred'),{recursive:true});
    const copy=path.join(ext,'.kbengine','inferred','A.py');fs.writeFileSync(copy,'class A: pass');
    const roots=load('src/scanRoots.ts',{
      vscode:{Uri:{file:fsPath=>({fsPath})},workspace:{workspaceFolders:[{uri:{fsPath:ws}}],
        findFiles:async()=>[],getConfiguration:()=>({get:(key,fallback)=>key==='assetsRoot'?ext:fallback})}},
      './configDerive':{getConfigDerivedScanRoot:()=>null},
      './languageServiceMetrics':{startLanguageServiceOperation:()=>({startSubPhase:()=>()=>{},countFileDiscovery(){},end(){}})},
      './workspaceDiscovery':{resetDiscoveryMemo(){},resolveDiscoveredConfigRoot:()=>null},
      './backend/managedDir':{resolveManagedDirName:()=>({name:'.kbengine'})},
      './backend/pythonScanRules':load('src/backend/pythonScanRules.ts',{})
    });
    const found=await roots.findFilesAcrossRoots('**/*.py');
    assert.equal(found.length,1);assert.equal(found[0].fsPath,copy);
    console.log('RESP-008: actual external walk returns .kbengine/inferred/A.py (managed copy leaked)');
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
