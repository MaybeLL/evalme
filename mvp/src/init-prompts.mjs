import * as p from '@clack/prompts';
import {isAbsolute} from 'node:path';
import {AppError, invalid} from './config.mjs';
const output = process.stderr;
async function answer(prompt) {
  const value = await prompt;
  if (p.isCancel(value)) {
    p.cancel('已取消，原有配置保持不变。', {output});
    throw new AppError('CANCELLED', '初始化已取消。', 130);
  }
  return value;
}
const text = (message, options = {}) => answer(p.text({message, output, ...options}));
export async function confirmReplacement(target) {
  return answer(p.confirm({message:`将连接配置替换为 ${target}？已有学习数据会保留。`, initialValue:false, active:"替换", inactive:"保留原配置", vertical:true, output}));
}
export async function interactive(flags) {
  if (flags.provider && (flags.provider === 'sqlite' || flags['connection-file'] || flags['non-interactive'] || flags.json)) return flags;
  if (flags.json || flags['non-interactive'] || !process.stdin.isTTY)
    throw invalid('Non-interactive init requires --provider and connection options.');
  p.intro('EvalMe 初始化', {output});
  flags.provider ||= await answer(p.select({message:'请选择数据库（↑/↓ 切换，Enter 确认）', output, showInstructions:false,
    options:[{value:'sqlite',label:'SQLite',hint:'本机保存'}, {value:'postgres',label:'PostgreSQL',hint:'连接共享数据库'}]}));
  if (flags.provider === 'sqlite') {
    flags.path = await text('SQLite 文件绝对路径（回车使用默认位置）', {validate:v => v && !isAbsolute(v) ? '请输入绝对路径。' : undefined}) || undefined;
  } else {
    const existing = await text('已有连接 JSON 路径（可选，回车填写连接信息）');
    if (existing) flags['connection-file'] = existing;
    else {
      const host = await text('PostgreSQL 地址', {validate:v => !v?.trim() ? '请输入服务器地址。' : undefined});
      const port = Number(await text('端口', {defaultValue:'5432', placeholder:'5432', validate:v => v && (!/^\d+$/.test(v) || Number(v)<1 || Number(v)>65535) ? '端口必须是 1–65535 的整数。' : undefined}));
      const database = await text('数据库名称', {defaultValue:'evalme', placeholder:'evalme'});
      const user = await text('应用用户名', {defaultValue:'evalme_app', placeholder:'evalme_app'});
      flags._password = await answer(p.password({message:'数据库密码（隐藏输入）', output, validate:v => !v ? '请输入密码。' : undefined}));
      const tls = await answer(p.select({message:'TLS 连接方式（↑/↓ 切换，Enter 确认）', output, showInstructions:false, options:[
        {value:'verify-full',label:'验证服务器证书',hint:'默认'},
        {value:'none',label:'不使用 TLS',hint:'仅限本机或私有 Tailscale 网络'}]}));
      flags._connectionValues = {host,port,database,user,ssl:tls === 'none' ? false : 'verify-full'};
      if (tls !== 'none') {
        const ca = await text('CA 证书路径（可选，回车使用系统证书）');
        if (ca) flags._connectionValues.ca_file = ca;
      }
    }
    flags['admin-connection-file'] = await text('管理员连接 JSON 路径（可选，仅用于初始化数据库结构）') || undefined;
  }
  p.outro('信息已收集，正在验证并保存连接。', {output});
  return flags;
}
