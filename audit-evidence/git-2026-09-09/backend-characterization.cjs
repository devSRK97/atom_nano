"use strict";
// Audit characterization: original source is loaded read-only. All Git mutations
// and exports target a fresh temporary fixture tree. No network remotes are used.
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm");
const cp = require("child_process"), {createRequire} = require("module");
const project = path.resolve(process.argv[2] || "E:/Mac/AtomNano");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomnano-git-audit-"));
function owned(p) {
  const absolute = path.resolve(p);
  if (!absolute.startsWith(root + path.sep)) throw new Error("Outside audit fixture: " + absolute);
  return absolute;
}
for (const k of Object.keys(process.env)) if (/^GIT_/i.test(k)) delete process.env[k];
const emptyConfig = owned(path.join(root, "empty.gitconfig"));
fs.writeFileSync(emptyConfig, "");
Object.assign(process.env, {GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1",
 GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_AUTHOR_NAME: "Audit Fixture",
 GIT_AUTHOR_EMAIL: "audit@example.invalid", GIT_COMMITTER_NAME: "Audit Fixture", GIT_COMMITTER_EMAIL: "audit@example.invalid"});
const gitSource = path.join(project, "src/main/git.js");
const rq = createRequire(gitSource);
const safeFs = new Proxy(fs, {get(target,k) {
 if (["rmSync","unlinkSync","writeFileSync"].includes(k)) return (p,...args) => target[k](owned(p),...args);
 return target[k];
}});
const safeCp = {...cp, execFile(file,args,opts,cb) {owned(opts.cwd); return cp.execFile(file,args,opts,cb);}};
const moduleBox = {exports:{}};
vm.runInNewContext(fs.readFileSync(gitSource,"utf8"), {module:moduleBox,exports:moduleBox.exports,
 require:(id)=>id==="fs"?safeFs:id==="child_process"?safeCp:rq(id),process,Buffer,console}, {filename:gitSource});
const api = moduleBox.exports;
function g(cwd,args) {owned(cwd);return cp.execFileSync("git",args,{cwd,encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();}
function write(repo,file,content) {const p=owned(path.join(repo,file)); fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,content);}
function init(name,files={"base.txt":"base\n"}) {
 const repo=owned(path.join(root,name));fs.mkdirSync(repo);g(repo,["init","-b","main"]);
 g(repo,["config","core.autocrlf","false"]);g(repo,["config","commit.gpgsign","false"]);
 g(repo,["config","core.hooksPath",owned(path.join(root,"no-hooks"))]);
 if(files){for(const [f,c] of Object.entries(files))write(repo,f,c);g(repo,["add","-A"]);g(repo,["commit","-m","base"]);}
 return repo;
}
async function attempt(fn) {try{return {value:await fn()};}catch(e){return {error:e.message};}}
const checks=[];
async function check(id,title,kind,fn) {
 try{const r=await fn();checks.push({id,title,kind,matched:!!r.matched,evidence:r.evidence});}
 catch(e){checks.push({id,title,kind,matched:false,harnessError:e.stack});}
 console.log(JSON.stringify(checks.at(-1)));
}
async function main() {
 await check("G01","Porcelain paths are quoted and unusable for staging","reproduction",async()=>{
  const r=init("quoted");write(r,"space name.txt","space\n");write(r,"caf\u00e9.txt","unicode\n");
  const st=await api.status(r);const row=st.files.find(f=>f.path.includes("space"));
  const result=await attempt(()=>api.stage(r,[row.path]));
  return {matched:row.path!=="space name.txt"&&!!result.error,evidence:{paths:st.files.map(f=>f.path),stageError:result.error}};
 });
 await check("G02","Unborn status reports branch No","reproduction",async()=>{
  const r=init("unborn",null);write(r,"new.txt","new\n");const st=await api.status(r);
  return {matched:st.branch==="No",evidence:{actual:st.branch,expected:"main"}};
 });
 await check("G03","Unstage-all fails before first commit; per-file unstage works","reproduction",async()=>{
  const r=init("unborn-unstage",null);write(r,"new.txt","new\n");await api.stage(r,["new.txt"]);
  const a=await attempt(()=>api.unstage(r,["new.txt"])),b=await attempt(()=>api.unstageAll(r));
  return {matched:!a.error&&!!b.error,evidence:{file:a.error,all:b.error}};
 });
 await check("G04","Discard on unborn added file unstages and deletes it","positive",async()=>{
  const r=init("unborn-discard",null);write(r,"new.txt","new\n");await api.stage(r,["new.txt"]);
  const result=await api.discard(r,["new.txt"]);
  return {matched:result.ok&&!fs.existsSync(path.join(r,"new.txt"))&&!g(r,["ls-files"]).includes("new.txt"),
   evidence:{result,status:g(r,["status","--porcelain"]),index:g(r,["ls-files"])}};
 });
 await check("G05","Clean tracked file becomes all-added diff","reproduction",async()=>{
  const r=init("clean-diff");const a=await api.fileDiff(r,"base.txt"),b=await api.diff(r,"base.txt");
  return {matched:a.mode==="untracked"&&a.text.includes("+base")&&b.text.includes("+base"),evidence:{fileDiffMode:a.mode,fileDiff:a.text,diff:b.text}};
 });
 await check("G06","Empty staged diff shows entire unstaged file","reproduction",async()=>{
  const r=init("staged-empty");write(r,"base.txt","changed\n");const a=await api.diff(r,"base.txt",{staged:true});
  return {matched:a.text.includes("+changed"),evidence:{nativeCached:g(r,["diff","--cached"]),apiText:a.text}};
 });
 await check("G07","Selected commit preserves unrelated staged change","positive",async()=>{
  const r=init("select",{"a.txt":"a0\n","b.txt":"b0\n"});write(r,"b.txt","b1\n");await api.stage(r,["b.txt"]);write(r,"a.txt","a1\n");
  await api.commitFiles(r,"selected",["a.txt"]);
  return {matched:g(r,["show","HEAD:b.txt"])==="b0"&&g(r,["diff","--cached","--name-only"])==="b.txt",
   evidence:{committedB:g(r,["show","HEAD:b.txt"]),staged:g(r,["diff","--cached","--name-only"])}};
 });
 await check("G08","Amend sequence includes unselected staged file","reproduction",async()=>{
  const r=init("amend",{"a.txt":"a0\n","b.txt":"b0\n"});write(r,"b.txt","b1\n");await api.stage(r,["b.txt"]);
  write(r,"a.txt","a1\n");await api.stage(r,["a.txt"]);await api.commit(r,"amended",{amend:true});
  return {matched:g(r,["show","HEAD:b.txt"])==="b1",evidence:{selected:["a.txt"],unselectedCommitted:g(r,["show","HEAD:b.txt"])}};
 });
 await check("G09","Working-tree preview omits staged content that selected commit includes","reproduction",async()=>{
  const r=init("partial",{"a.txt":"zero\nzero\n"});write(r,"a.txt","staged\nzero\n");await api.stage(r,["a.txt"]);write(r,"a.txt","staged\nunstaged\n");
  const d=await api.diff(r,"a.txt",{staged:false});await api.commitFiles(r,"all selected",["a.txt"]);
  return {matched:!d.text.includes("+staged")&&g(r,["show","HEAD:a.txt"]).includes("staged\nunstaged"),
   evidence:{preview:d.text,committed:g(r,["show","HEAD:a.txt"])}};
 });
 await check("G10","Unversion followed by selected-file commit tracks file again","reproduction",async()=>{
  const r=init("unversion");await api.untrack(r,["base.txt"]);const before=await api.status(r);
  const result=await attempt(()=>api.commitFiles(r,"remove tracking",["base.txt"]));
  return {matched:g(r,["ls-files"]).includes("base.txt"),evidence:{statusBefore:before.files,result,statusAfter:g(r,["status","--porcelain"]),tracked:g(r,["ls-files"])}};
 });
 await check("G11","Committing rename destination leaves old path in HEAD","reproduction",async()=>{
  const r=init("rename-commit");g(r,["mv","base.txt","renamed.txt"]);const st=await api.status(r);
  await api.commitFiles(r,"renamed",st.files.map(f=>f.path));
  const names=g(r,["ls-tree","-r","--name-only","HEAD"]);
  return {matched:names.includes("base.txt")&&names.includes("renamed.txt"),evidence:{rows:st.files,tree:names,index:g(r,["status","--porcelain"])}};
 });
 await check("G12","Discard of renamed path fails to restore original path","reproduction",async()=>{
  const r=init("rename-discard");g(r,["mv","base.txt","renamed.txt"]);const result=await attempt(()=>api.discard(r,["renamed.txt"]));
  return {matched:!fs.existsSync(path.join(r,"base.txt")),evidence:{result,originalExists:fs.existsSync(path.join(r,"base.txt")),destinationExists:fs.existsSync(path.join(r,"renamed.txt")),status:g(r,["status","--porcelain"])}};
 });
 await check("G13","Pathspec brackets stage another file as well","reproduction",async()=>{
  const r=init("pathspec");write(r,"a[1].txt","literal\n");write(r,"a1.txt","neighbor\n");await api.stage(r,["a[1].txt"]);
  const names=g(r,["diff","--cached","--name-only"]);
  return {matched:names.includes("a1.txt"),evidence:{selected:"a[1].txt",staged:names}};
 });
 await check("G14","Create-branch input -D deletes the start-point branch","reproduction",async()=>{
  const r=init("branch-option");g(r,["branch","victim"]);const result=await attempt(()=>api.branchCreate(r,"-D",{from:"victim",checkout:false}));
  return {matched:!g(r,["branch","--list","victim"]),evidence:{result,remaining:g(r,["branch","--format=%(refname:short)"])}};
 });
 await check("G15","Soft reset with ref --hard discards working changes","reproduction",async()=>{
  const r=init("reset-option");write(r,"base.txt","unsaved\n");const result=await attempt(()=>api.reset(r,"--hard","soft"));
  return {matched:fs.readFileSync(path.join(r,"base.txt"),"utf8")==="base\n",evidence:{result,file:fs.readFileSync(path.join(r,"base.txt"),"utf8")}};
 });
 await check("G16","Tag creation input -d deletes existing tag","reproduction",async()=>{
  const r=init("tag-option");g(r,["tag","victim"]);const result=await attempt(()=>api.tagCreate(r,"-d",{ref:"victim"}));
  return {matched:!g(r,["tag","--list","victim"]),evidence:{result,tags:g(r,["tag","--list"])}};
 });
 await check("G17","Push defaults origin despite configured upstream name","reproduction",async()=>{
  const r=init("push"),origin=owned(path.join(root,"origin.git")),upstream=owned(path.join(root,"upstream.git"));
  g(r,["init","--bare",origin]);g(r,["init","--bare",upstream]);g(r,["remote","add","origin",origin]);g(r,["remote","add","upstream",upstream]);
  g(r,["push","-u","upstream","HEAD:review"]);write(r,"base.txt","next\n");g(r,["commit","-am","next"]);
  await api.pushBranch(r,{branch:"main"});
  const head=g(r,["rev-parse","HEAD"]),o=g(origin,["rev-parse","refs/heads/main"]),u=g(upstream,["rev-parse","refs/heads/review"]);
  return {matched:o===head&&u!==head,evidence:{tracking:g(r,["rev-parse","--abbrev-ref","@{upstream}"]),originUpdated:o===head,upstreamUpdated:u===head}};
 });
 await check("G18","Merge into a remote ref leaves merge commit detached","reproduction",async()=>{
  const r=init("remote-target");g(r,["update-ref","refs/remotes/origin/main","HEAD"]);g(r,["checkout","-b","feature"]);
  write(r,"feature.txt","feature\n");g(r,["add","-A"]);g(r,["commit","-m","feature"]);
  const before=g(r,["rev-parse","refs/remotes/origin/main"]);const result=await api.mergeBranches(r,"feature","origin/main","");
  return {matched:(await api.currentBranch(r))==="HEAD"&&g(r,["rev-parse","refs/remotes/origin/main"])===before,
   evidence:{result,current:await api.currentBranch(r),targetRefUnchanged:g(r,["rev-parse","refs/remotes/origin/main"])===before}};
 });
 await check("G19","Merge commit info and file diff omit first-parent change","reproduction",async()=>{
  const r=init("merge-info");g(r,["checkout","-b","feature"]);write(r,"feature.txt","feature\n");g(r,["add","-A"]);g(r,["commit","-m","feature"]);
  g(r,["checkout","main"]);write(r,"main.txt","main\n");g(r,["add","-A"]);g(r,["commit","-m","main"]);g(r,["merge","--no-ff","--no-edit","feature"]);
  const info=await api.commitInfo(r,"HEAD"),diff=await api.commitFileDiff(r,"HEAD","feature.txt");
  return {matched:info.files.length===0&&!diff.text&&g(r,["diff","--name-only","HEAD^1","HEAD"])==="feature.txt",
   evidence:{files:info.files,apiDiff:diff,firstParentFiles:g(r,["diff","--name-only","HEAD^1","HEAD"])}};
 });
 await check("G20","Commit ZIP duplicates COMMIT.txt metadata name","reproduction",async()=>{
  const r=init("zip-name",{"COMMIT.txt":"real project file\n","other.txt":"other\n"}),out=owned(path.join(root,"duplicate.zip"));
  await api.commitZip(r,"HEAD",out);const entries=rq("./zipper").unzip(fs.readFileSync(out));
  return {matched:entries.filter(e=>e.name==="COMMIT.txt").length===2,evidence:{entries:entries.map(e=>({name:e.name,bytes:e.data.length}))}};
 });
 await check("G21","Space-containing filesystem remote is missing from list","reproduction",async()=>{
  const r=init("remote-space");g(r,["remote","add","origin",owned(path.join(root,"space remote.git"))]);
  const result=await api.remotes(r);
  return {matched:result.remotes.length===0,evidence:{native:g(r,["remote","-v"]),parsed:result.remotes}};
 });
 await check("G22","Remote checkout silently uses unrelated same-named local branch","reproduction",async()=>{
  const r=init("track-collision");g(r,["branch","feature"]);write(r,"base.txt","remote\n");g(r,["commit","-am","remote"]);
  g(r,["update-ref","refs/remotes/origin/feature","HEAD"]);const remote=g(r,["rev-parse","origin/feature"]);await api.checkoutRemote(r,"origin/feature");
  return {matched:g(r,["rev-parse","HEAD"])!==remote,evidence:{current:await api.currentBranch(r),matchesChosenRemote:g(r,["rev-parse","HEAD"])===remote,tracking:g(r,["for-each-ref","--format=%(upstream)","refs/heads/feature"])}};
 });
 await check("G23","Accept deleted side of modify/delete conflict fails","reproduction",async()=>{
  const r=init("delete-conflict");g(r,["checkout","-b","incoming"]);g(r,["rm","base.txt"]);g(r,["commit","-m","delete"]);
  g(r,["checkout","main"]);write(r,"base.txt","ours\n");g(r,["commit","-am","modify"]);
  const merge=await api.merge(r,"incoming"),result=await attempt(()=>api.resolveWith(r,["base.txt"],"theirs"));
  return {matched:merge.conflict&&!!result.error,evidence:{mergeConflict:merge.conflict,error:result.error}};
 });
 await check("G24","Continue without operation is rejected by native empty-message check","positive",async()=>{
  const r=init("continue-none");write(r,"base.txt","staged\n");await api.stage(r,["base.txt"]);
  const before=g(r,["rev-parse","HEAD"]),result=await attempt(()=>api.mergeContinue(r)),after=g(r,["rev-parse","HEAD"]);
  return {matched:before===after&&!!result.error,evidence:{result,headChanged:before!==after,subject:g(r,["log","-1","--format=%s"])}};
 });
 await check("G25","Abort bisect routes to merge abort","reproduction",async()=>{
  const r=init("bisect");write(r,"base.txt","second\n");g(r,["commit","-am","second"]);g(r,["bisect","start"]);g(r,["bisect","bad"]);g(r,["bisect","good","HEAD~1"]);
  const st=await api.repoState(r),result=await attempt(()=>api.mergeAbort(r));
  return {matched:st.op==="bisect"&&!!result.error,evidence:{op:st.op,error:result.error}};
 });
 await check("G26","Stale stash index drops a different stash after new stash","reproduction",async()=>{
  const r=init("stash-index");write(r,"base.txt","wanted\n");await api.stashSave(r,{message:"wanted"});
  const selected=(await api.stashList(r)).stashes[0];write(r,"base.txt","newer\n");await api.stashSave(r,{message:"newer"});
  await api.stashDrop(r,selected.index);const remaining=(await api.stashList(r)).stashes;
  return {matched:remaining.some(s=>s.hash===selected.hash),evidence:{selected,remaining}};
 });
 await check("G27","Full archive preserves binary bytes","positive",async()=>{
  const bytes=Buffer.from([0,255,128,1,13,10]);const r=init("archive",{"binary.bin":bytes}),out=owned(path.join(root,"full.zip"));
  await api.archiveZip(r,"HEAD",out);const f=rq("./zipper").unzip(fs.readFileSync(out)).find(x=>x.name==="binary.bin");
  return {matched:!!f&&f.data.equals(bytes),evidence:{bytes:f&&[...f.data]}};
 });
 await check("G28","Native checkout protects conflicting uncommitted changes","positive",async()=>{
  const r=init("checkout-protect");g(r,["checkout","-b","other"]);write(r,"base.txt","other\n");g(r,["commit","-am","other"]);g(r,["checkout","main"]);write(r,"base.txt","local\n");
  const result=await attempt(()=>api.checkout(r,"other"));
  return {matched:!!result.error&&fs.readFileSync(path.join(r,"base.txt"),"utf8")==="local\n",evidence:{blocked:!!result.error,current:await api.currentBranch(r)}};
 });

 await check("G29","Pull conflict is a resolved result with ok false","positive",async()=>{
  const r=init("pull-conflict"),bare=owned(path.join(root,"pull-remote.git"));g(r,["init","--bare",bare]);g(r,["remote","add","origin",bare]);g(r,["push","-u","origin","main"]);
  const clone=owned(path.join(root,"pull-clone"));g(r,["clone",bare,clone]);g(clone,["checkout","main"]);g(clone,["config","core.autocrlf","false"]);
  write(clone,"base.txt","remote\n");g(clone,["commit","-am","remote"]);g(clone,["push","origin","main"]);
  write(r,"base.txt","local\n");g(r,["commit","-am","local"]);const result=await api.pull(r);
  return {matched:result.ok===false&&result.conflict===true,evidence:{ok:result.ok,conflict:result.conflict,status:g(r,["status","--porcelain"])}};
 });
 await check("G30","Tag remote failure leaves local tag already deleted","reproduction",async()=>{
  const r=init("tag-remote-failure");g(r,["tag","v1"]);const result=await attempt(()=>api.tagDelete(r,"v1",{remote:"missing"}));
  return {matched:!!result.error&&!g(r,["tag","--list","v1"]),evidence:{result,localTagStillExists:!!g(r,["tag","--list","v1"])}};
 });
 await check("G31","Commit ZIP silently skips quoted Unicode path","reproduction",async()=>{
  const r=init("zip-omit",{"caf\u00e9.txt":"unicode\n","plain.txt":"plain\n"}),out=owned(path.join(root,"omit.zip"));
  const result=await api.commitZip(r,"HEAD",out),entries=rq("./zipper").unzip(fs.readFileSync(out));
  return {matched:result.ok&&result.files===1&&!entries.some(e=>e.name==="caf\u00e9.txt"),evidence:{result,names:entries.map(e=>e.name)}};
 });
 await check("G32","Historical binary file decodes into replacement characters","reproduction",async()=>{
  const r=init("file-at-binary",{"binary.bin":Buffer.from([0,255,128,1])});const result=await api.fileAt(r,"HEAD","binary.bin");
  return {matched:result.content.includes("\ufffd"),evidence:{contentCodePoints:[...result.content].map(c=>c.codePointAt(0)),binaryFlag:!!result.binary}};
 });
 await check("G33","Rebase continue can return another conflict","positive",async()=>{
  const r=init("rebase-two",{"a.txt":"base\n","b.txt":"base\n"});g(r,["checkout","-b","feature"]);write(r,"a.txt","feature-a\n");g(r,["commit","-am","feature-a"]);
  write(r,"b.txt","feature-b\n");g(r,["commit","-am","feature-b"]);g(r,["checkout","main"]);write(r,"a.txt","main-a\n");write(r,"b.txt","main-b\n");g(r,["commit","-am","main"]);
  const first=await api.rebase(r,"main",{branch:"feature"});await api.resolveWith(r,["a.txt"],"theirs");const second=await api.mergeContinue(r);
  return {matched:first.conflict&&second.conflict&&second.ok===false,evidence:{firstConflict:first.conflict,secondConflict:second.conflict,op:second.op,remaining:(await api.status(r)).files.filter(f=>f.conflict).map(f=>f.path)}};
 });

 const out={project,fixtureRoot:root,git:cp.execFileSync("git",["--version"],{encoding:"utf8"}).trim(),node:process.version,
  checks,summary:{total:checks.length,matched:checks.filter(x=>x.matched).length,unexpected:checks.filter(x=>!x.matched).map(x=>x.id)}};
 const dest=path.resolve(process.argv[3]||path.join(root,"results.json"));
 fs.writeFileSync(dest,JSON.stringify(out,null,2)+"\n");
 console.log(JSON.stringify({summary:out.summary,fixtureRoot:root,results:dest}));
 if(out.summary.unexpected.length)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
