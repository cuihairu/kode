// Baseline a773c7c0263f5de85960acf1f7c1c5849c95cbc6; run with node from the checkout root.
// Uses installed TypeScript and the repository vscode stub; only temporary fixture files are written.
const fs=require('fs');const perf=require('perf_hooks').performance;const ts=require(process.cwd()+'/node_modules/typescript');const Module=require('module');const old=Module._load;
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f);
Module._load=function(id){if(id==='vscode')return require(process.cwd()+'/tests/helpers/vscodeStub.ts');return old.apply(this,arguments)};
const load=n=>require(process.cwd()+'/src/'+n+'.ts');

const os=require('os'),path=require('path'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kode-sdk-probe-'));
try {
const sdk=load('clientSdkGenerator');
const xml='<root><Properties><entityId><Type>STRING</Type><Flags>ALL_CLIENTS</Flags></entityId><coins><Type>UINT64</Type><Flags>ALL_CLIENTS</Flags></coins></Properties></root>';
const entity=sdk.parseClientSdkEntity(xml,'Hero');
const map=sdk.buildClientSdkTypeMap([],'typescript');
const output=sdk.generateClientSdkEntityFile(entity,'typescript',map,'2026-10-30');
const file=path.join(tmp,'Hero.ts');fs.writeFileSync(file,output);
const program=ts.createProgram([file],{target:ts.ScriptTarget.ES2020,skipLibCheck:true,types:[],noEmit:true});
console.log(JSON.stringify({test:'generatedSdkHelperCollision',diagnostics:ts.getPreEmitDiagnostics(program).filter(d=>d.file?.fileName===file).map(d=>({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,' ')}))}));
console.log(JSON.stringify({test:'sdkUint64Precision',generatedCoins:output.split('\n').find(x=>x.includes('public coins:')),input:'9007199254740993',roundTrip:BigInt(Number(9007199254740993n)).toString()}));
}finally{fs.rmSync(tmp,{recursive:true,force:true})}
