import {install} from '../src/lifecycle.mjs';
try {
  if(process.argv.length!==4 || process.argv[2]!=='--source') throw Error('Expected --source /absolute/package');
  const result=await install(process.argv[3]);
  console.log(`EvalMe ${result.version} 已安装，Skill 已放入 ~/.agents/skills/evalme-mvp。`);
  console.log(`下一步：${result.command} init`);
  console.log('新开 Agent 会话即可发现 Skill；Pi 也可 /reload。');
  if(!result.onPath) console.log(`当前 PATH 未包含 ~/.local/bin，请使用上面的绝对路径；安装器没有修改 shell 配置。`);
} catch(e) {console.error(`${e.code||'INSTALL_FAILED'}: ${e.safeMessage||e.message}`);process.exitCode=1;}
