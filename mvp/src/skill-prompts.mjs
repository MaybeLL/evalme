import * as p from '@clack/prompts';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {scanSkills,installSkill,resolveSkillsDir} from './skill-install.mjs';
const output=process.stderr;
const clean=v=>String(v).replace(/[\x00-\x1f\x7f-\x9f]/g,' ');
const labels={current:'已就绪',outdated:'可更新',modified:'用户已修改',unknown:'无法识别'};
async function answer(promise){const v=await promise;if(p.isCancel(v))throw Object.assign(new Error('cancelled'),{code:'CANCELLED'});return v;}
export async function setupSkill(flags,{cliPath,home=homedir()}={}) {
 if(flags.json||flags['non-interactive']||!process.stdin.isTTY)return;
 try {
  const entries=await scanSkills({home,cliPath});
  for(const e of entries.filter(e=>e.status!=='missing')) {
   p.log.info(`Skill ${labels[e.status]}：${clean(e.path)}${e.real_path&&e.real_path!==e.path?` → ${clean(e.real_path)}`:''}${e.aliases.length?`\n其他位置：${e.aliases.map(clean).join('、')}`:''}`,{output});
  }
  if(entries.some(e=>e.status==='current')) {
   p.log.info('文件检查不代表 Agent 已加载。Pi 可 /reload，其他 Agent 请新开会话。',{output});return;
  }
  const outdated=entries.filter(e=>e.status==='outdated');
  const update=outdated.length>0;
  if(entries.some(e=>['modified','unknown'].includes(e.status)))p.log.warn('修改过或无法识别的副本会保留。请另选目录；更新受管理的修改版可用 skill install --force --skills-dir <目录>，覆盖前会备份。',{output});
  if(!(await answer(p.confirm({message:update?'是否更新 Agent Skill？':'是否安装 Agent Skill？',initialValue:true,active:update?'更新':'安装',inactive:'暂时跳过',vertical:true,output}))))return;
  const preset=[join(home,'.agents/skills'),join(home,'.claude/skills'),join(home,'.codex/skills')];
  const roots=[...new Set([...preset,...entries.filter(e=>e.status!=='missing').map(e=>e.directory)])];
  const selected=await answer(p.select({message:'将 Skill 安装到哪里？（目录内创建 evalme-mvp）',output,showInstructions:false,
   initialValue:update?outdated[0].directory:preset[0],options:[...roots.map(value=>({value,label:clean(value),hint:value===preset[0]?'默认，共享目录':undefined})),{value:'custom',label:'自定义路径…'}]}));
  const directory=selected==='custom'?resolveSkillsDir(await answer(p.text({message:'Skills 根目录（支持 ~/ 或绝对路径）',output,validate:v=>{try{resolveSkillsDir(v,home);}catch{return '请输入绝对路径或 ~/ 开头的路径。';}}})),home):selected;
  const target=join(directory,'evalme-mvp');
  if(!(await answer(p.confirm({message:`安装或更新到 ${clean(target)}？`,initialValue:true,active:'确认',inactive:'取消',vertical:true,output}))))return;
  const r=await installSkill({home,cliPath,skillsDir:directory});
  p.log.success(`Skill 已安装：${clean(r.path)}`,{output});
  p.log.info('Pi 可 /reload，其他 Agent 请新开会话。文件检查不代表 Agent 已加载。',{output});
 }catch(e) {
  if(e.code==='CANCELLED')p.log.info('已跳过 Skill 配置，数据库连接配置保持不变。',{output});
  else p.log.warn(`Skill 配置未完成（${clean(e.code||'INSTALL_FAILED')}），数据库连接配置保持不变。可运行 evalme-mvp skill install --skills-dir <目录> 重试。`,{output});
 }
}
