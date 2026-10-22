import * as p from '@clack/prompts';
import {AppError,connectionTarget} from './config.mjs';
const output=process.stderr;
const clean=s=>String(s).replace(/[\x00-\x1f\x7f]/g,' ');
async function value(x){const v=await x;if(p.isCancel(v))throw new AppError('CANCELLED','已取消，未执行操作。',130);return v;}
export async function confirmDelete(runtime,plan) {
 const c=plan.counts;
 p.note(`目标：${clean(connectionTarget(runtime))}\n题目系列：${plan.family_id}\n题目版本：${c.tasks} 个\n练习记录：${c.trials} 条\n评价记录：${c.grades} 条\n包含全部历史版本及更正记录；话题保留。\n${runtime.provider==='postgres'?'共享数据库中的删除影响所有连接设备。':'删除当前本机数据库记录。'}`,`永久删除「${clean(plan.title)}」`,{output});
 return value(p.confirm({message:'是否删除题目及全部关联记录？',initialValue:false,active:'删除题目及关联记录',inactive:'取消',vertical:true,output}));
}
export async function confirmMigration(runtime) {
 return value(p.confirm({message:`将 ${clean(connectionTarget(runtime))} 升级为结构 v2？旧 CLI 将不再兼容，请先更新所有设备。不会删除学习记录。`,initialValue:false,active:'升级结构',inactive:'取消',vertical:true,output}));
}
export async function managementCredentials() {
 const user=await value(p.text({message:'临时管理用户名',output,validate:v=>!v?.trim()?'请输入用户名。':undefined}));
 const password=await value(p.password({message:'临时管理密码（仅本次使用，不保存）',output,validate:v=>!v?'请输入密码。':undefined}));
 return {user,password};
}
