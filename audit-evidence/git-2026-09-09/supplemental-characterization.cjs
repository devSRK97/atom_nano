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
 await check("G34","Large selected file list exceeds Windows process argument limit","reproduction",async()=>{
  const r=init("long-path-list"),names=Array.from({length:440},(_,i)=>"file-"+i+"-"+"x".repeat(77)+".txt");
  for(const name of names)write(r,name,"data\n");
  const result=await attempt(()=>api.stage(r,names));await api.stageAll(r);
  return{matched:!!result.error&&g(r,["diff","--cached","--name-only"]).split("\n").length===440,
   evidence:{selected:440,argumentCharacters:names.join(" ").length,result,stageAllSucceeded:true}};
 });
 await check("G35","Discard deletes staged-new file after reset fails with index lock","reproduction",async()=>{
  const r=init("discard-reset-fail");write(r,"added.txt","discarded data\n");await api.stage(r,["added.txt"]);write(r,".git/index.lock","audit fixture lock\n");
  const result=await api.discard(r,["added.txt"]);
  return{matched:result.ok&&!fs.existsSync(path.join(r,"added.txt"))&&g(r,["ls-files"]).includes("added.txt"),
   evidence:{result,fileExists:fs.existsSync(path.join(r,"added.txt")),index:g(r,["ls-files"]),status:g(r,["status","--porcelain"])}};
 });
 await check("G36","Remote tag deletion uses an ambiguous unqualified ref","reproduction",async()=>{
  const r=init("tag-ambiguous"),bare=owned(path.join(root,"tag-remote.git"));g(r,["init","--bare",bare]);g(r,["remote","add","origin",bare]);
  g(r,["branch","v1"]);g(r,["tag","v1"]);g(r,["push","origin","refs/heads/v1:refs/heads/v1","refs/tags/v1:refs/tags/v1"]);
  const result=await attempt(()=>api.tagDelete(r,"v1",{remote:"origin"}));
  return{matched:!!result.error&&!!g(bare,["show-ref","--tags"])&&!g(r,["tag","--list","v1"]),
   evidence:{result,remoteRefs:g(bare,["show-ref"]),localTagExists:!!g(r,["tag","--list","v1"])}};
 });
 const result={project,fixtureRoot:root,checks,summary:{total:checks.length,matched:checks.filter(c=>c.matched).length,unexpected:checks.filter(c=>!c.matched).map(c=>c.id)}};
 fs.writeFileSync(process.argv[3]||path.join(__dirname,"supplemental-results.json"),JSON.stringify(result,null,2)+"\n");
 console.log(JSON.stringify({summary:result.summary,fixtureRoot:root}));if(result.summary.unexpected.length)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
