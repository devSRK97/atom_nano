"use strict";
/* Original renderer functions + original CSS in a blank, isolated Chromium page.
 * All IPC is mocked. No Electron application/user profile is launched. */
const fs=require("fs"),path=require("path"),ts=require("typescript"),{chromium}=require("playwright");
const ROOT=path.resolve(__dirname,"../..");
const app=fs.readFileSync(path.join(ROOT,"src/renderer/app.js"),"utf8");
const sf=ts.createSourceFile("app.js",app,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function fn(name){const n=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!n)throw Error("Missing original helper "+name);return n.getText(sf);}
const helpers=["h","openModal","closeModal","modalShell","chooseDialog","promptDialog"].map(fn).join("\n");
let moduleSource=fs.readFileSync(path.join(ROOT,"src/renderer/dbm.js"),"utf8").replace("export async function mountDbManager","async function mountDbManager");
const marker="  /* ---- boot ---- */";
if(!moduleSource.includes(marker))throw Error("Missing UI audit insertion point");
moduleSource=moduleSource.replace(marker,'globalThis.__ui={AT,tabs:()=>tabs,conns:()=>conns,openInTab,closeTab,switchTab,drawConnForm,runQuery,renderBrowse,selectObject,insertRowDialog,renderStruct,addColumnDialog,checkHealth,disconnectConn,connStatus,startCellEdit,resultBlock,confirm};\n'+marker);
moduleSource+="\nglobalThis.__utils={formatSQL,splitSQL,fmtBytes,vgrid,qName};globalThis.mountDbManager=mountDbManager;";
const results=[];
let browser;
async function setup(){
  const context=await browser.newContext({viewport:{width:1200,height:800}});
  await context.route("**/*",route=>route.request().url()==="http://audit.invalid/"?route.fulfill({status:200,contentType:"text/html",body:'<!doctype html><html><head></head><body><div id="mount" style="height:760px"></div><div id="modalRoot"></div></body></html>'}):route.abort());
  const page=await context.newPage();await page.goto("http://audit.invalid/");
  await page.addStyleTag({content:fs.readFileSync(path.join(ROOT,"src/renderer/styles.css"),"utf8")});
  await page.addScriptTag({content:"(()=>{const $=id=>document.getElementById(id);const icon=()=>'<svg></svg>';"+helpers+";globalThis.__helpers={h,icon,chooseDialog,promptDialog,modalShell,closeModal};})();"});
  await page.evaluate(()=>{
    window.__profiles=[{id:"a",name:"Audit A",kind:"sqlite",file:":memory:",policy:{}},{id:"b",name:"Audit B",kind:"postgres",database:"synthetic",policy:{}}];
    window.__calls=[];window.__toasts=[];window.__menus=[];
    window.__cols=[{name:"id",type:"INTEGER",key:"PRI",nullable:false},{name:"v",type:"TEXT",key:"",nullable:true}];
    const record=(method,...args)=>__calls.push({method,args});
    const db={
      kinds:async()=>["sqlite","postgres","mysql","oracle","mssql","mongodb","redis"].map(id=>({id,name:id,installed:true,fields:id==="sqlite"?["file"]:["host","port","database","password"],types:[{t:"numeric",prec:true},{t:"text"},{t:"varchar",len:true,dlen:255}]})),
      list:async()=>structuredClone(__profiles),
      schema:async id=>{record("schema",id);return {items:[{name:"t",type:"table",rows:0}],tableCount:1,viewCount:0};},
      columns:async(...args)=>{record("columns",...args);return structuredClone(__cols);},
      browse:async(...args)=>{record("browse",...args);return {columns:["id","v"],rows:[[1,"old"]],ms:1,rowCount:1};},
      tableInfo:async(...args)=>{record("tableInfo",...args);return {columns:structuredClone(__cols),indexes:[],foreignKeys:[],ddl:""};},
      query:async(...args)=>{record("query",...args);return {columns:[],rows:[],affected:1,ms:1,message:"OK"};},
      updateRows:async(...args)=>{record("updateRows",...args);return {affected:0,message:"0 rows"};},
      deleteRows:async(...args)=>{record("deleteRows",...args);return {affected:0,message:"0 rows"};},
      insertRow:async(...args)=>{record("insertRow",...args);await new Promise(r=>setTimeout(r,100));return {affected:1};},
      save:async c=>{record("save",structuredClone(c));const i=__profiles.findIndex(x=>x.id===c.id);if(i>=0)__profiles[i]=structuredClone(c);else __profiles.push(structuredClone(c));return structuredClone(c);},
      disconnect:async(...args)=>{record("disconnect",...args);return true;},
      ping:async(...args)=>{record("ping",...args);return {ok:true};},
      addColumn:async(...args)=>{record("addColumn",...args);return {sql:"preview"};},
      renameColumn:async(...args)=>{record("renameColumn",...args);return {};},
      dropColumn:async(...args)=>{record("dropColumn",...args);throw Error("synthetic old column missing");},
      count:async()=>({count:1,ms:1}),onIoProgress:()=>()=>{},
      reorderColumns:async()=>({sql:"ALTER TABLE t ..."}),
      remove:async()=>({ok:true}),installDriver:async()=>({ok:true})
    };
    window.__deps={...__helpers,atom:{db},toast:(...args)=>__toasts.push(args),showContextMenu:(_x,_y,items)=>__menus.push(items)};
  });
  await page.addScriptTag({content:moduleSource});
  await page.evaluate(()=>mountDbManager(document.getElementById("mount"),__deps));
  await page.waitForTimeout(35);
  return {page,context};
}
async function check(id,title,fn,category="reproduction"){
  let p;
  try{p=await setup();const evidence=await fn(p.page);results.push({id,title,category,passed:true,evidence});}
  catch(e){results.push({id,title,category,passed:false,error:e.stack});}
  finally{if(p)await p.context.close();}
}
function assert(v,msg){if(!v)throw Error(msg);}
(async()=>{
browser=await chromium.launch({headless:true});
await check("DB-U01","Format changes quoted SQL data",async p=>{const r=await p.evaluate(()=>({input:"INSERT INTO t(v) VALUES ('hello   from,world')",output:__utils.formatSQL("INSERT INTO t(v) VALUES ('hello   from,world')")}));assert(!r.output.includes("'hello   from,world'"),"literal intact");return r;});
await check("DB-U02","SQL editor split removes required token separators and breaks dollar quoting",async p=>{const r=await p.evaluate(()=>({comment:__utils.splitSQL("SELECT/* c */1;"),dollar:__utils.splitSQL("DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;")}));assert(r.comment[0]==="SELECT1"&&r.dollar.length===3,"not reproduced");return r;});
await check("DB-U03","Positive: byte size thresholds render correctly",async p=>{const r=await p.evaluate(()=>[1,1024,1048576].map(n=>({bytes:n,display:__utils.fmtBytes(n)})));assert(r[0].display==="1 B"&&r[1].display==="1 KB"&&r[2].display==="1.0 MB","incorrect units");return r;},"positive-control");
await check("DB-U04","Browse clamps Next to an approximate zero-row estimate",async p=>{const r=await p.evaluate(async()=>{__deps.atom.db.browse=async(...args)=>{__calls.push({method:"browse",args});return {columns:["id","v"],rows:Array.from({length:200},(_,i)=>[i,"value"]),ms:1};};const t=__ui.AT();__ui.selectObject(t,{name:"t",type:"table",rows:0});t.mode="browse";await __ui.renderBrowse(t);const next=t.wsEl.querySelector('[title="Next page (Alt+→)"]');const wasDisabled=next.disabled;next.click();await new Promise(r=>setTimeout(r,25));return {nextWasDisabled:wasDisabled,offset:t.browse.offset,requestedOffsets:__calls.filter(x=>x.method==="browse").map(x=>x.args[2].offset)};});assert(!r.nextWasDisabled&&r.offset===0,"not clamped");return r;});
await check("DB-U05","UI replaces a cell even when backend affected zero rows",async p=>{await p.evaluate(async()=>{const t=__ui.AT();__ui.selectObject(t,{name:"t",type:"table"});await __ui.renderBrowse(t);t.wsEl.querySelector(".dbm-browse-panel").style.display="";});await p.waitForTimeout(40);const r=await p.evaluate(async()=>{const t=__ui.AT(),cell=t.wsEl.querySelector('.dbm-browse-panel .dbm-vrow[data-ri="0"]').children[2];cell.ondblclick(new MouseEvent("dblclick"));const inp=cell.querySelector("input");inp.value="new";inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));await new Promise(r=>setTimeout(r,40));return {displayedValue:t.browse.result.rows[0][1],updates:__calls.filter(x=>x.method==="updateRows").length};});assert(r.displayedValue==="new"&&r.updates===1,"not reproduced");return r;});
await check("DB-U06","Insert button allows duplicate submissions while first write is pending",async p=>{const r=await p.evaluate(async()=>{const t=__ui.AT();__ui.selectObject(t,{name:"t",type:"table"});await __ui.insertRowDialog(t);const inputs=document.querySelectorAll(".dbm-ins-field input");inputs[1].value="new";const b=[...document.querySelectorAll(".modal-foot button")].find(x=>x.textContent==="Insert");b.click();b.click();const calls=__calls.filter(x=>x.method==="insertRow").length;await new Promise(r=>setTimeout(r,140));return {calls};});assert(r.calls===2,"not duplicated");return r;});
await check("DB-U07","Closing the final busy tab can send later statements to another connection",async p=>{const r=await p.evaluate(async()=>{let release;let n=0;__deps.atom.db.query=async(id,text)=>{__calls.push({method:"query",args:[id,text]});if(++n===1)await new Promise(r=>release=r);return {columns:[],rows:[],affected:1,ms:1};};const t=__ui.AT();t._ed.value="INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)";const run=__ui.runQuery(t);__ui.closeTab(t.id);__ui.openInTab(__ui.conns().find(c=>c.id==="b"));release();await run;return {queries:__calls.filter(x=>x.method==="query").map(x=>x.args)};});assert(r.queries[0][0]==="a"&&r.queries[1][0]==="b","cross-connection race not reproduced");return r;});
await check("DB-U08","A failed later statement hides successful earlier statements",async p=>{const r=await p.evaluate(async()=>{let n=0;__deps.atom.db.query=async()=>{if(++n===2)throw Error("second statement failed");return {columns:[],rows:[],affected:1,ms:1};};const t=__ui.AT();t._ed.value="INSERT INTO t VALUES (1); SELECT broken";await __ui.runQuery(t);return {executed:n,successfulLogEntries:t.log.filter(x=>x.ok).length,resultText:t._res.textContent};});assert(r.executed===2&&r.successfulLogEntries===0,"success retained");return r;});
await check("DB-U09","Cancel connection editing retains unsaved policy in renderer state",async p=>{const r=await p.evaluate(()=>{const t=__ui.AT();__ui.drawConnForm(t.conn);const box=[...document.querySelectorAll(".dbm-policy-row")].find(x=>x.textContent.includes("Block writes")).querySelector("input");box.checked=true;box.dispatchEvent(new Event("change"));[...document.querySelectorAll(".dbm-form-actions button")].find(x=>x.textContent==="Cancel").click();return {rendererPolicy:t.conn.policy.blockWrite,savedPolicy:__profiles[0].policy.blockWrite??false};});assert(r.rendererPolicy&&!r.savedPolicy,"not divergent");return r;});
await check("DB-U10","Repeated plain Open creates extra connection tabs",async p=>{const r=await p.evaluate(()=>{const c=__ui.conns()[0];const before=__ui.tabs().length;__ui.openInTab(c);__ui.openInTab(c);return {before,after:__ui.tabs().length};});assert(r.after===r.before+2,"tab reused");return r;});
await check("DB-U11","An in-flight health response reverses manual disconnect",async p=>{const r=await p.evaluate(async()=>{let release;__deps.atom.db.ping=()=>new Promise(r=>release=r);const c=__ui.conns()[0];__ui.connStatus.set(c.id,"reconnecting");const ping=__ui.checkHealth(true);await __ui.disconnectConn(c);const afterDisconnect=__ui.connStatus.get(c.id);release({ok:true,ms:1});await ping;return {afterDisconnect,afterPing:__ui.connStatus.get(c.id)};});assert(r.afterDisconnect==="off"&&r.afterPing==="live","no stale override");return r;});
await check("DB-U12","Closing confirmation with X leaves its promise pending",async p=>{const r=await p.evaluate(async()=>{const choice=__ui.confirm("Audit","Synthetic question","Apply");document.querySelector(".mh-close").click();const result=await Promise.race([choice.then(v=>({resolved:v})),new Promise(r=>setTimeout(()=>r({pending:true}),50))]);return result;});assert(r.pending,"dialog settled");return r;});
await check("DB-U13","Positive: grid redraw retains the draft through confirmation",async p=>{const r=await p.evaluate(async()=>{const g=__utils.vgrid({columns:["v"],rows:[["old"]]});g.el.style.height="200px";document.body.append(g.el);await new Promise(r=>requestAnimationFrame(r));let saves=0,savedValue=null;const cell=g.el.querySelector(".dbm-vrow").children[1];__ui.startCellEdit(g,cell,0,0,(_ri,_ci,v)=>{saves++;savedValue=v;});cell.querySelector("input").value="unsaved";g.refresh();await new Promise(r=>setTimeout(r,40));const dialogs=document.querySelectorAll(".modal").length;const save=[...document.querySelectorAll(".modal-foot button")].find(x=>x.textContent==="Save");if(save)save.click();await new Promise(r=>setTimeout(r,15));return {dialogs,saves,savedValue};});assert(r.dialogs===1&&r.saves===1&&r.savedValue==="unsaved","draft was not preserved");return r;},"positive-control");
await check("DB-U14","Rename-plus-drop queues old column name and forgets failed work",async p=>{const r=await p.evaluate(async()=>{__deps.chooseDialog=async()=>"yes";const t=__ui.AT();__ui.selectObject(t,{name:"t",type:"table"});t.pending={table:"t",renames:new Map([["v","renamed"]]),drops:new Set(["v"]),order:["id","v"],dropIdx:new Set()};await __ui.renderStruct(t);const save=[...t.wsEl.querySelectorAll(".dbm-pending button")].find(x=>x.textContent==="Save");save.click();await new Promise(r=>setTimeout(r,40));return {operations:__calls.filter(x=>["renameColumn","dropColumn"].includes(x.method)),remainingRenames:t.pending.renames.size,remainingDrops:t.pending.drops.size};});assert(r.operations.length===2&&r.operations[1].args[2]==="v"&&r.remainingDrops===0,"not reproduced");return r;});
await check("DB-U15","Switching structure objects silently discards pending edits",async p=>{const r=await p.evaluate(async()=>{const t=__ui.AT();__ui.selectObject(t,{name:"t",type:"table"});t.pending={table:"t",renames:new Map([["v","renamed"]]),drops:new Set(),order:["id","v"],dropIdx:new Set()};__ui.selectObject(t,{name:"other",type:"table"});await __ui.renderStruct(t);return {table:t.pending.table,renames:t.pending.renames.size};});assert(r.table==="other"&&r.renames===0,"pending retained");return r;});
await check("DB-U16","Add-column keeps hidden precision after changing type",async p=>{const r=await p.evaluate(async()=>{const t=__ui.AT();await __ui.addColumnDialog(t,{name:"t",type:"table"});const modal=document.querySelector(".dbm-ac");const name=modal.querySelector('input[placeholder="column_name"]');name.value="newcol";name.dispatchEvent(new Event("input"));const precision=modal.querySelector('input[placeholder="precision"]');precision.value="10";precision.dispatchEvent(new Event("input"));const scale=modal.querySelector('input[placeholder="scale"]');scale.value="2";scale.dispatchEvent(new Event("input"));const type=modal.querySelector(".dbm-ac-type");type.value="text";type.dispatchEvent(new Event("change"));await new Promise(r=>setTimeout(r,230));return {spec:__calls.filter(x=>x.method==="addColumn").at(-1).args[2]};});assert(r.spec.type==="text"&&r.spec.precision==="10"&&r.spec.scale==="2","stale fields cleared");return r;});

await check("DB-U17","Browse interprets database object name as HTML",async p=>{const r=await p.evaluate(async()=>{const t=__ui.AT();const name='<b data-audit-marker="yes">object</b>';__ui.selectObject(t,{name,type:"table"});await __ui.renderBrowse(t);return {injectedElement:!!t.wsEl.querySelector('[data-audit-marker="yes"]'),label:t.wsEl.querySelector(".dbm-browse-name").textContent};});assert(r.injectedElement,"name escaped");return {...r,scope:"Markup insertion only. Production CSP blocks inline scripts; no code-execution claim."};});
await check("DB-U18","Virtual grid has no table/grid semantics or keyboard cell controls",async p=>{const r=await p.evaluate(async()=>{const g=__utils.vgrid({columns:["id","value"],rows:[[1,"one"],[2,"two"]]});document.body.append(g.el);await new Promise(r=>requestAnimationFrame(r));return {role:g.el.getAttribute("role"),cellRoles:g.el.querySelectorAll('[role="gridcell"],td').length,tabbableCells:g.el.querySelectorAll(".dbm-vcell[tabindex]").length,headers:g.el.querySelectorAll('th,[role="columnheader"]').length};});assert(!r.role&&r.cellRoles===0&&r.headers===0,"semantics exist");return r;});
await check("DB-U19","Grid virtualizes rows but builds every visible row column",async p=>{const r=await p.evaluate(async()=>{const n=5000,m=100,rows=Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>i+":"+j));const start=performance.now();const g=__utils.vgrid({columns:Array.from({length:m},(_,i)=>"col"+i),rows});g.el.style.cssText="height:300px;width:500px;flex:none";document.body.append(g.el);await new Promise(r=>requestAnimationFrame(r));return {sourceRows:n,sourceColumns:m,renderedRows:g.el.querySelectorAll(".dbm-vrow").length,renderedCells:g.el.querySelectorAll(".dbm-vcell").length,headers:g.el.querySelectorAll(".dbm-vgrid-hcell").length,firstFrameMs:+(performance.now()-start).toFixed(2)};});assert(r.renderedRows<100&&r.headers===101,"measurement failed");return r;},"measurement");
await check("DB-U20","Positive: basic query result renders",async p=>{const r=await p.evaluate(async()=>{__deps.atom.db.query=async()=>({columns:["id","v"],rows:[[1,"hello"]],ms:2});const t=__ui.AT();t._ed.value="SELECT 1";await __ui.runQuery(t);await new Promise(r=>requestAnimationFrame(r));return {text:t._res.textContent,status:t._st.textContent};});assert(r.text.includes("hello")&&r.status.includes("1 statement"),"render failed");return r;},"positive-control");
await browser.close();
const out={at:new Date().toISOString(),scope:"Original renderer/CSS and app dialog helpers, blank Chromium page, all IPC mocked; no real application profile.",total:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results};
fs.writeFileSync(path.join(__dirname,"ui-results.json"),JSON.stringify(out,null,2)+"\n");
console.log(JSON.stringify({total:out.total,passed:out.passed,failed:out.failed,failures:results.filter(x=>!x.passed)}));
if(out.failed)process.exitCode=1;
})().catch(async e=>{console.error(e.stack);if(browser)await browser.close();process.exitCode=1;});
