// Baseline a773c7c0263f5de85960acf1f7c1c5849c95cbc6; run with node from the checkout root.
// Uses installed TypeScript and the repository vscode stub; only temporary fixture files are written.
const fs=require('fs');const perf=require('perf_hooks').performance;const ts=require(process.cwd()+'/node_modules/typescript');const Module=require('module');const old=Module._load;
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f);
Module._load=function(id){if(id==='vscode')return require(process.cwd()+'/tests/helpers/vscodeStub.ts');return old.apply(this,arguments)};
const load=n=>require(process.cwd()+'/src/'+n+'.ts');

(async()=>{const os=require('os'),path=require('path'),vs=require(process.cwd()+'/tests/helpers/vscodeStub.ts');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kode-gen-concurrency-'));
try{
const {KBEngineCodeGenerator}=load('codeGenerator');const gen=Object.create(KBEngineCodeGenerator.prototype);
gen.config={generatePython:false,registerInEntitiesXml:false};gen.getExistingEntities=()=>[];gen.collectGenerationConflicts=()=>[];gen.confirmGenerationPlan=async()=>true;
gen.generateDefFile=async entity=>{const file=path.join(tmp,entity.config.name+'.def');fs.writeFileSync(file,'<root/>');return file};
let names=['First','Second'];vs.window.showInputBox=async()=>names.shift();vs.window.showQuickPick=async(options,config)=>config.placeHolder.includes('实体类型')?options[0]:config.placeHolder.includes('父实体')?undefined:{value:false};
let releaseFirst,firstReached;const reached=new Promise(r=>firstReached=r);let prompts=0;
vs.window.showInformationMessage=async(message)=>{if(message!=='是否打开生成的文件？')return undefined;if(++prompts===1){firstReached();return new Promise(r=>releaseFirst=r)}return '否'};
vs.workspace.openTextDocument=async()=>{throw Error('simulated open failure')};vs.window.showErrorMessage=()=>undefined;
const first=gen.showWizard();await reached;await gen.showWizard();const before={first:fs.existsSync(path.join(tmp,'First.def')),second:fs.existsSync(path.join(tmp,'Second.def'))};releaseFirst('是');await first;
console.log(JSON.stringify({test:'overlappingGeneratorRollbackDeletesOtherInvocation',before,after:{first:fs.existsSync(path.join(tmp,'First.def')),second:fs.existsSync(path.join(tmp,'Second.def'))}}));
}finally{fs.rmSync(tmp,{recursive:true,force:true})}})().catch(e=>{console.error(e.stack);process.exitCode=1});
