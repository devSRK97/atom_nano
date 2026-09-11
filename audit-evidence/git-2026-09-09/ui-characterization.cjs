"use strict";
// Original UI source runs in a fresh, headless Chromium document. All IPC calls
// are fixture stubs; this never launches AtomNano or reads its user profile.
const fs=require("fs"),path=require("path"),{createRequire}=require("module");
const project=path.resolve(process.argv[2]||"E:/Mac/AtomNano");
const rq=createRequire(path.join(project,"package.json"));
const ts=rq("typescript"),{chromium}=rq("playwright");
const app=fs.readFileSync(path.join(project,"src/renderer/app.js"),"utf8");
const ast=ts.createSourceFile("app.js",app,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function fn(name){let n=ast.statements.find(x=>ts.isFunctionDeclaration(x)&&x.name?.text===name);if(!n){const visit=x=>{if(ts.isFunctionDeclaration(x)&&x.name?.text===name)n=x;else if(!n)ts.forEachChild(x,visit);};visit(ast);}if(!n)throw Error(name);return n.getText(ast);}
const gc=fs.readFileSync(path.join(project,"src/renderer/gitcenter.js"),"utf8").replace(/^export /gm,"");
const diff=fs.readFileSync(path.join(project,"src/renderer/diff.js"),"utf8").replace(/^export /gm,"");
const conf=fs.readFileSync(path.join(project,"src/renderer/conflicts.js"),"utf8").replace(/^export /gm,"");
const css=fs.readFileSync(path.join(project,"src/renderer/styles.css"),"utf8");
const functions={};for(const n of ["loadConflictFile","markFileResolved","renderConflictCard","bulkResolve","completeMerge","openCommitProgressModal","confirmDialog","reloadBranches"])functions[n]=fn(n);
const checks=[];
async function main(){
 const browser=await chromium.launch({headless:true});
 async function setup(){
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:"reduce"});
  await page.route("**/*",route=>route.abort());
  await page.setContent('<!doctype html><html><body><button id="outside">Outside</button><div id="modalRoot"></div></body></html>');
  await page.addStyleTag({content:css});
  await page.addScriptTag({content:"window.auditH=("+fn("h")+");"});
  await page.addScriptTag({content:diff+"\nwindow.diffFns={parseUnifiedDiff,processHunk};"});
  await page.addScriptTag({content:conf+"\nwindow.confFns={parseConflicts,assembleResolved,previewFor};"});
  await page.addScriptTag({content:"(()=>{const h=window.auditH;let gDiffView='split';"+
   ["diffCode","unifiedRow","splitCell","splitRow","renderDiffContent"].map(fn).join("\n")+
   "\nwindow.realDiff={render:renderDiffContent,set(v){gDiffView=v},get(){return gDiffView}};})();"});
  await page.addScriptTag({content:gc+"\nwindow.audit={S,setDeps(d){D=d},openGitCenter,close,selectRepo,refreshAll,act,forAll,setTab,enterCompare,renderMain,doPush};"});
  await page.evaluate(()=>{
   window.calls=[];window.notices=[];window.waiters={};
   window.defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};
   window.fixtureInfo=(repo)=>({marker:repo,current:repo+"-main",locals:[{name:repo+"-main",current:true},{name:"feature"}],remotes:[],state:{op:""}});
   window.fixtureStatus=(repo)=>({repo:true,branch:repo+"-main",upstream:"origin/"+repo+"-main",ahead:1,files:[{path:"a.txt",label:"Modified",x:" ",y:"M",unstaged:true,staged:false}],clean:false});
   const h=window.auditH;
   window.deps={h,icon:(_n,n=14)=>'<svg width="'+n+'" height="'+n+'"></svg>',
    projectRoot:()=>"project",repoName:r=>r,baseName:s=>s.split(/[\\/]/).at(-1),
    fileMeta:()=>({ic:"file",cls:""}),esc:s=>String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;"),
    toast:(text,kind)=>notices.push({text,kind}),refreshGit:async()=>{},refreshTree:()=>{},
    openConflictResolver:()=>{},openInEditor:()=>{},showMenuAt:()=>{},
    chooseDialog:async()=> "yes",promptDialog:()=>{},getDiffView:()=>realDiff.get(),setDiffView:v=>realDiff.set(v),
    parseUnifiedDiff:diffFns.parseUnifiedDiff,renderDiffContent:realDiff.render,
    diffEmpty:(_ic,title,sub)=>h("div",{},title,sub),
    modalShell:({title,body,footer})=>{const back=h("div",{class:"modal-backdrop"},h("div",{class:"modal"},title,body,footer));document.getElementById("modalRoot").append(back);return back;},
    atom:{git:{
      repos:async()=>["A","B"],status:async r=>window.fixtureStatus(r),branchesDetailed:async r=>window.fixtureInfo(r),
      diff:async()=>({text:"diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"}),
      fileDiff:async()=>({text:""}),fetch:async r=>{calls.push({op:"fetch",repo:r});return{ok:true};},
      commitFiles:async(r,msg,paths)=>{calls.push({op:"commitFiles",repo:r,msg,paths});return{ok:true};},
      commitOpts:async(r,msg,opts)=>{calls.push({op:"commitOpts",repo:r,msg,opts});return{ok:true};},
      stage:async(r,paths)=>{calls.push({op:"stage",repo:r,paths});return{ok:true};},
      pushBranch:async(r,opts)=>{calls.push({op:"pushBranch",repo:r,opts});return{ok:true};},
      log:async()=>({commits:[],hasMore:false}),tags:async()=>({tags:[]}),remotes:async()=>({remotes:[]}),
      stashList:async()=>({stashes:[]}),aheadBehind:async()=>({onlyA:0,onlyB:1}),
      commitsBetween:async()=>({commits:[]}),changedBetween:async()=>({files:[]})
     },files:{reveal:async()=>{}},clipboard:{write:()=>{}},shell:{openExternal:async()=>{}}}};
   audit.setDeps(deps);
  });
  return page;
 }
 async function check(id,title,kind,run){
  const page=await setup();
  try{const r=await run(page);checks.push({id,title,kind,matched:!!r.matched,evidence:r.evidence});}
  catch(e){checks.push({id,title,kind,matched:false,harnessError:e.stack});}
  finally{await page.close();}
  console.log(JSON.stringify(checks.at(-1)));
 }
 async function open(p){await p.evaluate(()=>audit.openGitCenter(deps,{repo:"A"}));}
 await check("U01","Late repository read overwrites current repository info","reproduction",async p=>{
  await open(p);
  return p.evaluate(async()=>{
   waiters.a=defer();deps.atom.git.branchesDetailed=r=>r==="A"?waiters.a.promise:Promise.resolve(fixtureInfo(r));
   const first=audit.selectRepo("A");await audit.selectRepo("B");waiters.a.resolve(fixtureInfo("A"));await first;
   return{matched:audit.S.repo==="B"&&audit.S.info.marker==="A",evidence:{repo:audit.S.repo,infoOwner:audit.S.info.marker}};
  });
 });
 await check("U02","Commit draft and amend flag carry into another repository","reproduction",async p=>{
  await open(p);return p.evaluate(async()=>{
   audit.S.chg.msg="message for A";audit.S.chg.amend=true;await audit.selectRepo("B");
   return{matched:audit.S.chg.amend&&document.querySelector(".gitc-msg").value==="message for A",evidence:{repo:audit.S.repo,amend:audit.S.chg.amend,message:document.querySelector(".gitc-msg").value}};
  });
 });
 await check("U03","Pending push from A offers push on repository B","reproduction",async p=>{
  await open(p);await p.evaluate(async()=>{audit.S.pendingPush=true;await audit.selectRepo("B");window.op=audit.refreshAll();});
  await p.waitForSelector(".gitc-pop-msg");
  const evidence=await p.locator(".gitc-pop-msg").textContent();
  await p.getByRole("button",{name:"Cancel",exact:true}).click();
  await p.evaluate(()=>window.op);
  return{matched:evidence.includes("B-main"),evidence};
 });
 await check("U04","Commit-and-push follows repository switched while commit runs","reproduction",async p=>{
  await open(p);
  await p.evaluate(()=>{
   waiters.commit=defer();deps.atom.git.commitFiles=(r,msg,paths)=>{calls.push({op:"commitFiles",repo:r,msg,paths});return waiters.commit.promise;};
   const ta=document.querySelector(".gitc-msg");ta.value="commit A";ta.dispatchEvent(new Event("input"));
   [...document.querySelectorAll("button")].find(b=>b.textContent==="Commit & Push").click();
  });
  await p.waitForFunction(()=>calls.some(x=>x.op==="commitFiles"));
  await p.evaluate(async()=>{await audit.selectRepo("B");waiters.commit.resolve({ok:true});});
  await p.waitForSelector(".gitc-pop");
  const evidence=await p.evaluate(()=>({calls,title:document.querySelector(".gitc-pop-head").textContent}));
  await p.getByRole("button",{name:"Cancel",exact:true}).click();
  return{matched:evidence.calls[0].repo==="A"&&evidence.title.includes("B-main"),evidence};
 });
 await check("U05","Amend commits repository B after staging repository A","reproduction",async p=>{
  await open(p);await p.evaluate(async()=>{
   audit.S.chg.amend=true;await audit.renderMain();
   waiters.stage=defer();deps.atom.git.stage=(r,paths)=>{calls.push({op:"stage",repo:r,paths});return waiters.stage.promise;};
   const ta=document.querySelector(".gitc-msg");ta.value="amend A";ta.dispatchEvent(new Event("input"));
   [...document.querySelectorAll("button")].find(b=>b.textContent.startsWith("Amend (")).click();
  });
  await p.waitForFunction(()=>calls.some(x=>x.op==="stage"));
  await p.evaluate(async()=>{await audit.selectRepo("B");waiters.stage.resolve({ok:true});});
  await p.waitForFunction(()=>calls.some(x=>x.op==="commitOpts"));
  return p.evaluate(()=>({matched:calls.find(x=>x.op==="stage").repo==="A"&&calls.find(x=>x.op==="commitOpts").repo==="B",evidence:calls}));
 });
 await check("U06","Pull-all reports conflict result as success","reproduction",async p=>{
  await open(p);return p.evaluate(async()=>{
   await audit.forAll("Pull",async()=>({ok:false,conflict:true}));
   return{matched:notices.some(x=>x.kind==="checkCircle"&&x.text==="Pull done for 2 repos"),evidence:notices};
  });
 });
 await check("U07","Failed compare still enables Merge and Rebase","reproduction",async p=>{
  await open(p);await p.evaluate(()=>{
   const bad=async()=>{throw Error("fixture comparison failed");};
   deps.atom.git.aheadBehind=deps.atom.git.commitsBetween=deps.atom.git.changedBetween=bad;
   audit.S.source="feature";audit.S.target="A-main";audit.enterCompare();
  });
  await p.waitForFunction(()=>audit.S.cmp.ready);
  return p.evaluate(()=>({matched:!document.querySelector(".mergebtn").disabled&&!document.querySelector(".rebasebtn").disabled,
   evidence:{ready:audit.S.cmp.ready,mergeDisabled:document.querySelector(".mergebtn").disabled,errors:document.querySelector(".gitc-content").textContent}}));
 });
 await check("U08","History search appends a late obsolete result","reproduction",async p=>{
  await open(p);await p.evaluate(()=>{
   deps.atom.git.log=async(_r,o)=>{if(!o.search)return{commits:[],hasMore:false};waiters[o.search]=defer();return waiters[o.search].promise;};
   audit.setTab("history");
  });
  const input=p.getByPlaceholder("Search subjects & messages…");
  await input.fill("old");await p.waitForFunction(()=>!!waiters.old);
  await input.fill("new");await p.waitForFunction(()=>!!waiters.new);
  await p.evaluate(()=>waiters.new.resolve({commits:[{hash:"new",full:"new",subject:"new"}],hasMore:false}));
  await p.waitForFunction(()=>audit.S.hist.commits.length===1);
  await p.evaluate(()=>waiters.old.resolve({commits:[{hash:"old",full:"old",subject:"old"}],hasMore:false}));
  await p.waitForFunction(()=>audit.S.hist.commits.length===2);
  return p.evaluate(()=>({matched:audit.S.hist.search==="new"&&audit.S.hist.commits.some(c=>c.full==="old"),evidence:{search:audit.S.hist.search,commits:audit.S.hist.commits.map(c=>c.full)}}));
 });
 await check("U09","Refresh replaces focused commit textarea","reproduction",async p=>{
  await open(p);return p.evaluate(async()=>{
   const old=document.querySelector(".gitc-msg");old.focus();old.value="draft";old.dispatchEvent(new Event("input"));await audit.refreshAll();
   return{matched:!old.isConnected&&document.activeElement!==document.querySelector(".gitc-msg"),evidence:{oldConnected:old.isConnected,active:document.activeElement.tagName,draft:document.querySelector(".gitc-msg").value}};
  });
 });
 await check("U10","Closing during initial discovery rejects the open operation","reproduction",async p=>{
  await p.evaluate(()=>{waiters.repos=defer();deps.atom.git.repos=()=>waiters.repos.promise;window.op=audit.openGitCenter(deps).then(()=>null,e=>e.message);audit.close();waiters.repos.resolve([]);});
  const error=await p.evaluate(()=>window.op);return{matched:!!error,evidence:{error}};
 });
 await check("U11","Busy strip permits a keyboard-activated second Git operation","reproduction",async p=>{
  await open(p);await p.evaluate(()=>{waiters.fetch=defer();deps.atom.git.fetch=r=>{calls.push({op:"fetch",repo:r});return waiters.fetch.promise;};});
  const button=p.getByRole("button",{name:"Fetch",exact:true});await button.click();await button.focus();await p.keyboard.press("Enter");
  const evidence=await p.evaluate(()=>({calls:calls.length,busy:audit.S.busy,disabled:document.querySelector(".gitc-act").disabled}));
  await p.evaluate(()=>waiters.fetch.resolve({ok:true}));return{matched:evidence.calls===2,evidence};
 });
 await check("U12","Conflict read race can write file A contents to file B","reproduction",async p=>{
  await p.evaluate(functions=>{
   const h=auditH,icon=()=>"",parseConflicts=confFns.parseConflicts,assembleResolved=confFns.assembleResolved;
   const _merge={repo:"A",files:["a.txt","b.txt"],index:0,path:"",parsed:null,choices:{},custom:{}};
   const overlay=h("div",{class:"merge-overlay"},h("div",{class:"merge-body"}));document.body.append(overlay);
   const pending={},writes=[];
   const atom={files:{read:f=>{pending[f]=defer();return pending[f].promise;},write:async(p,c)=>{writes.push({path:p,content:c});}},git:{stage:async()=>{},status:async()=>({files:[]})}};
   const ensureMergeOverlay=()=>overlay,renderMergeFile=()=>{},refreshGit=async()=>{},conflictedFiles=()=>[],renderMergeDone=()=>{},toast=()=>{},esc=s=>s,repoName=s=>s;
   eval(functions.loadConflictFile+"\n"+functions.markFileResolved+"\nwindow.resolver={_merge,pending,writes,loadConflictFile,markFileResolved};");
  },functions);
  return p.evaluate(async()=>{
   const r=resolver;const first=r.loadConflictFile();r._merge.index=1;const second=r.loadConflictFile();
   r.pending["A/b.txt"].resolve({content:"<<<<<<< HEAD\nB ours\n=======\nB theirs\n>>>>>>> incoming\n"});await second;
   r.pending["A/a.txt"].resolve({content:"<<<<<<< HEAD\nA ours\n=======\nA theirs\n>>>>>>> incoming\n"});await first;
   r._merge.choices={0:"ours"};await r.markFileResolved();
   return{matched:r.writes[0].path==="A/b.txt"&&r.writes[0].content==="A ours\n",evidence:r.writes};
  });
 });
 await check("U13","Line-level Keep mine takes upstream side during rebase","reproduction",async p=>{
  return p.evaluate(functions=>{
   const h=auditH,icon=()=>"",previewFor=confFns.previewFor;
   const parsed=confFns.parseConflicts("<<<<<<< HEAD\nupstream\n=======\nmy commit\n>>>>>>> feature\n");
   const _merge={parsed,choices:{},custom:{}},renderMergeFile=()=>{},resolveConflict=(id,choice)=>{_merge.choices[id]=choice;},editConflict=()=>{},sidePane=()=>h("div");
   eval(functions.renderConflictCard+"\nwindow.card=renderConflictCard(parsed.segments.find(s=>s.type==='conflict'));");
   document.body.append(window.card);[...window.card.querySelectorAll("button")].find(b=>b.textContent==="Keep mine").click();
   const result=confFns.assembleResolved(parsed,_merge.choices);
   return{matched:result==="upstream\n",evidence:{button:"Keep mine",operation:"rebase",result,expected:"my commit\n"}};
  },functions);
 });
 await check("U14","Complete resolver closes and reports success on next rebase conflict","reproduction",async p=>{
  return p.evaluate(async functions=>{
   const _merge={repo:"A"},conflictedFiles=()=>[],atom={git:{mergeContinue:async()=>({ok:false,conflict:true,op:"rebase",branch:"HEAD"})}};
   let closed=false;const msgs=[],closeMerge=()=>{closed=true;},toast=(text,kind)=>msgs.push({text,kind}),esc=s=>s,repoName=s=>s,refreshGit=async()=>{},refreshTree=()=>{};
   eval(functions.completeMerge+"\nwindow.finish=completeMerge;");await window.finish();
   return{matched:closed&&msgs.some(x=>x.kind==="checkCircle"),evidence:{closed,msgs}};
  },functions);
 });
 await check("U15","Conflict save changes CRLF line endings to LF","reproduction",async p=>{
  return p.evaluate(async functions=>{
   const h=auditH,icon=()=>"",parseConflicts=confFns.parseConflicts,assembleResolved=confFns.assembleResolved;
   const _merge={repo:"A",files:["a.txt"],index:0,path:"",parsed:null,choices:{},custom:{}};
   const overlay=h("div",{class:"merge-overlay"},h("div",{class:"merge-body"}));document.body.append(overlay);
   const writes=[];const atom={files:{read:async()=>({content:"<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> incoming\r\n"}),write:async(p,c)=>writes.push({p,c})},git:{stage:async()=>{},status:async()=>({files:[]})}};
   const ensureMergeOverlay=()=>overlay,renderMergeFile=()=>{},refreshGit=async()=>{},conflictedFiles=()=>[],renderMergeDone=()=>{},toast=()=>{},esc=s=>s,repoName=s=>s;
   eval(functions.loadConflictFile+"\n"+functions.markFileResolved+"\nwindow.crlfTest={loadConflictFile,markFileResolved};");
   await crlfTest.loadConflictFile();_merge.choices={0:"ours"};await crlfTest.markFileResolved();
   return{matched:writes[0].c==="ours\n",evidence:{inputEol:"CRLF",output:writes[0].c}};
  },functions);
 });
 await check("U16","Unified diff parser drops changed lines resembling file headers","reproduction",async p=>{
  return p.evaluate(()=>{
   const parsed=diffFns.parseUnifiedDiff("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n--- old comment\n+++ new comment\n");
   return{matched:parsed.adds===0&&parsed.dels===0,evidence:parsed};
  });
 });
 await check("U17","Unterminated conflict does not round-trip all input text","reproduction",async p=>{
  return p.evaluate(()=>{
   const input="before\n<<<<<<< ours\none\n||||||| base\nbase text\n=======\nincoming text\n";
   const parsed=confFns.parseConflicts(input),output=confFns.assembleResolved(parsed);
   return{matched:!output.includes("incoming text")&&!output.includes("base text"),evidence:{input,output,count:parsed.count,conflictSegments:parsed.segments.filter(s=>s.type==="conflict").length}};
  });
 });
 await check("U18","Commit-and-push retry repeats commit after push alone failed","reproduction",async p=>{
  await p.evaluate(functions=>{
   const h=auditH,icon=()=>"",esc=s=>s,repoName=s=>s,state={git:{statuses:{A:{branch:"main"}}}};
   const closeModal=el=>el.remove(),refreshGit=async()=>{},refreshTree=()=>{},modalShell=deps.modalShell;
   let commits=0,pushes=0;
   const atom={git:{commitFiles:async()=>{commits++;if(commits>1)throw Error("nothing to commit");return{ok:true,branch:"main"};},
    push:async()=>{pushes++;throw Error("fixture rejected");}}};
   eval(functions.openCommitProgressModal+"\nwindow.progressTest={open:openCommitProgressModal,counts:()=>({commits,pushes})};");
  },functions);
  await p.evaluate(()=>progressTest.open([{repo:"A",files:["a.txt"]}],"message",true));
  await p.getByRole("button",{name:"Retry failed"}).click();
  await p.waitForFunction(()=>progressTest.counts().commits===2);
  return p.evaluate(()=>({matched:progressTest.counts().commits===2&&progressTest.counts().pushes===1,evidence:{...progressTest.counts(),text:document.querySelector(".commit-progress").textContent}}));
 });
 await check("U19","Git overlay and progress still animate with reduced motion","reproduction",async p=>{
  await open(p);return p.evaluate(()=>{
   audit.S.back.classList.add("busy");document.querySelector(".gitc-progress").classList.add("on");
   const evidence={reduced:matchMedia("(prefers-reduced-motion: reduce)").matches,
    overlay:getComputedStyle(document.querySelector(".gitc-overlay")).animationName,
    progress:getComputedStyle(document.querySelector(".gitc-progress"),"::before").animationName};
   return{matched:evidence.reduced&&evidence.overlay!=="none"&&evidence.progress!=="none",evidence};
  });
 });
 await check("U20","Large Changes view mounts all rows and records render cost","measurement",async p=>{
  await open(p);const result=await p.evaluate(async()=>{
   const s=audit.S.statuses.A;s.files=Array.from({length:5000},(_,i)=>({path:"file-"+i+".txt",label:"Modified",unstaged:true,staged:false,x:" ",y:"M"}));
   audit.S.chg.selInit=false;const start=performance.now();await audit.renderMain();const elapsedMs=performance.now()-start;
   return{matched:document.querySelectorAll(".gitc-tree-file").length===5000,evidence:{files:5000,rows:document.querySelectorAll(".gitc-tree-file").length,domNodes:document.querySelectorAll(".gitc-content *").length,elapsedMs:Math.round(elapsedMs)}};
  });return result;
 });
 await check("U21","Git dialog lacks dialog semantics and contains plain div rows","reproduction",async p=>{
  await open(p);return p.evaluate(()=>({matched:!document.querySelector(".gitc-panel").hasAttribute("role")&&document.querySelector(".gitc-tree-file").tabIndex===-1,
   evidence:{panelRole:document.querySelector(".gitc-panel").getAttribute("role"),ariaModal:document.querySelector(".gitc-panel").getAttribute("aria-modal"),rowTabIndex:document.querySelector(".gitc-tree-file").tabIndex}}));
 });

 await check("U22","Status failure is presented as a clean working tree","reproduction",async p=>{
  await open(p);return p.evaluate(async()=>{
   deps.atom.git.status=async()=>{throw Error("fixture git status timeout");};await audit.refreshAll();
   const text=document.querySelector(".gitc-content").textContent;
   return{matched:text.includes("Working tree clean")&&!text.includes("timeout"),evidence:{text,status:audit.S.statuses.A}};
  });
 });
 await check("U23","Legacy merge picker reads singular branch fields from plural API","reproduction",async p=>{
  return p.evaluate(async functions=>{
   const h=auditH,atom={git:{branches:async()=>({current:"main",locals:["main","feature"],remotes:["origin/main"]})}},
    state={git:{statuses:{A:{branch:"main"}}}};
   const sourceSel=h("select"),targetSel=h("select"),summaryBar=h("div"),compareBody=h("div"),
    initialMsg=h("div"),mergeBtn=h("button"),createMrBtn=h("button"),mergeStatsChip=h("div"),updateCompareReadiness=()=>{};
   eval(functions.reloadBranches+"\nwindow.reloadLegacy=reloadBranches;");
   await reloadLegacy("A");
   return{matched:sourceSel.options.length===0&&targetSel.options.length===0,evidence:{actualApiFields:["locals","remotes"],sourceOptions:sourceSel.options.length,targetOptions:targetSel.options.length}};
  },functions);
 });
 await check("U24","Legacy merge awaits callback-only confirm dialog","reproduction",async p=>{
  return p.evaluate(async functions=>{
   const h=auditH,closeModal=el=>el.remove(),modalShell=deps.modalShell;
   let eventError="";addEventListener("error",e=>{eventError=e.message;e.preventDefault();},{once:true});
   eval(functions.confirmDialog+"\nwindow.legacyConfirm=confirmDialog;");
   const result=await legacyConfirm({title:"Merge",message:"Merge fixture",confirmLabel:"Merge"});
   [...document.querySelectorAll("button")].find(b=>b.textContent==="Merge").click();
   return{matched:result===undefined&&eventError.includes("onConfirm"),evidence:{returnedUndefined:result===undefined,eventError}};
  },functions);
 });

 await browser.close();
 const result={project,browser:"Playwright Chromium, headless, no AtomNano startup; original component code with fixture IPC",
  checks,summary:{total:checks.length,matched:checks.filter(x=>x.matched).length,unexpected:checks.filter(x=>!x.matched).map(x=>x.id)}};
 fs.writeFileSync(process.argv[3]||path.join(__dirname,"ui-results.json"),JSON.stringify(result,null,2)+"\n");
 console.log(JSON.stringify({summary:result.summary}));if(result.summary.unexpected.length)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
