// Run with node from the Kode bf26cbf checkout root; uses installed TypeScript and fake vscode.
const fs=require('fs');const perf=require('perf_hooks').performance;const ts=require(process.cwd()+'/node_modules/typescript');const Module=require('module');const old=Module._load;
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f);
Module._load=function(id){if(id==='vscode')return require(process.cwd()+'/tests/helpers/vscodeStub.ts');return old.apply(this,arguments)};
const load=n=>require(process.cwd()+'/src/'+n+'.ts');
(async()=>{
const r=load('receiverNoneDiagnostics');
const cases={unguarded:'self.cell.send()',hasattrNone:'if hasattr(self, "cell"):\n    self.cell.send()',hasattrWrongReceiver:'if hasattr(self, "client"):\n    self.cell.send()',orSameLine:'if self.cell or ready: self.cell.send()',nestedReturn:'if self.cell is None:\n    if ready:\n        return\nself.cell.send()',stringReturn:'if self.cell is None:\n    print("return")\nself.cell.send()',aliasInvalidated:'peer = self.cell\npeer = other\nif peer:\n    self.cell.send()',orAnd:'if ready or self.cell and other:\n    self.cell.send()',safeAnd:'if ready and self.cell:\n    self.cell.send()',aliasOnly:'peer = self.cell\npeer.send()'};
for(const [name,body]of Object.entries(cases)){
 const text='class Hero:\n    def run(self):\n'+body.split('\n').map(l=>'        '+l).join('\n')+'\n';
 console.log(JSON.stringify({test:name,findings:r.computeReceiverNoneFindings(text,'/project/scripts/base/Hero.py').map(f=>({kind:f.kind,receiver:f.receiver,line:f.line}))}));}
for (const n of [1000,2000,4000]){const text='class Hero:\n    def run(self):\n'+Array.from({length:n},()=> '        if self.cell:\n            self.cell.send()\n').join('');const st=perf.now();r.computeReceiverNoneFindings(text,'/project/scripts/base/Hero.py');console.log(JSON.stringify({test:'manyGuards',n,ms:+(perf.now()-st).toFixed(2)}));}
const {classifyDefChange}=load('hotReloadDefStructure');
const root=x=>'<root>'+x+'</root>';
for(const [name,a,b]of [['persistent','<Properties><hp><Type>UINT32</Type><Flags>BASE</Flags><Persistent>true</Persistent></hp></Properties>','<Properties><hp><Type>UINT32</Type><Flags>BASE</Flags><Persistent>false</Persistent></hp></Properties>'],['implements','<Implements><Interface>A</Interface></Implements>','<Implements><Interface>B</Interface></Implements>'],['components','<Components><stats>A</stats></Components>','<Components><stats>B</stats></Components>']])console.log(JSON.stringify({test:'def-'+name,verdict:classifyDefChange(root(a),root(b))}));
const {DatabaseQueryResultCache}=load('databaseConnectionRegistry');const {createProfileScopedDriftExecutor}=load('profileDatabaseConnection');let clock=0;const cache=new DatabaseQueryResultCache({now:()=>clock});let calls=[];
const factory=createProfileScopedDriftExecutor('same-profile',cache,async db=>({runQuery:async sql=>{calls.push(db.host);return {columns:[],rows:[{host:db.host}]}},close:async()=>{}}));
const a=await factory({host:'database-A'});await a.runQuery('SHOW TABLES');const b=await factory({host:'database-B'});console.log(JSON.stringify({test:'sameProfileConfigChange',result:await b.runQuery('SHOW TABLES'),calls}));
const {runReadOnlyQueryLifecycle}=load('databaseQueryLifecycle');let ran=0;const o=await runReadOnlyQueryLifecycle(async()=>{ran++;return 1},()=>{}, {now:()=>0,timeoutMs:100,isCancelled:()=>true,sleep:async()=>{}});console.log(JSON.stringify({test:'preCancelledQuery',ran,outcome:o.kind}));
const {createMysqlDriftExecutorWith}=load('databaseDrift');let closed=0;try{await createMysqlDriftExecutorWith(async()=>({createConnection:async()=>({query:async()=>{throw Error('READ ONLY setup failed')},end:async()=>{closed++},destroy:()=>{closed++}})}))({host:'fake',port:3306})}catch{}console.log(JSON.stringify({test:'sessionSetupFailure',closed}));
// Observe listener lifecycle with real guard and fake session events, no real debugging.
const vs=require(process.cwd()+'/tests/helpers/vscodeStub.ts');let listener,live=false,stopCount=0,resolveStart;
vs.debug.onDidStartDebugSession=cb=>{listener=cb;live=true;return{dispose:()=>{live=false}}};vs.debug.startDebugging=()=>new Promise(resolve=>{resolveStart=resolve});vs.debug.stopDebugging=async()=>{stopCount++};
vs.window.withProgress=(_o,fn)=>fn({}, {onCancellationRequested:()=>({dispose(){}})});vs.window.showWarningMessage=()=>Promise.resolve();
const originalGet=vs.workspace.getConfiguration;vs.workspace.getConfiguration=()=>({get:(key,def)=>key==='debug.attachTimeoutMs'?5:def});
const {DebugConfigManager}=load('debugConfig');const mgr=Object.create(DebugConfigManager.prototype);const outcome=await mgr.startAttachGuarded('own',{name:'same-name',type:'debugpy',request:'attach'});const liveAfterTimeout=live;if(live)listener({name:'same-name',id:'late'});resolveStart(true);await new Promise(r=>setImmediate(r));console.log(JSON.stringify({test:'lateAttachAfterTimeout',outcome,liveAfterTimeout,stopCount}));vs.workspace.getConfiguration=originalGet;
})().catch(e=>{console.error(e.stack);process.exitCode=1});
