import {install} from '../src/lifecycle.mjs';
import {installGuidance} from '../src/install-guidance.mjs';
try {
  if(process.argv.length!==4 || process.argv[2]!=='--source') throw Error('Expected --source /absolute/package');
  const result=await install(process.argv[3]);
  console.log(`EvalMe ${result.version} 已安装，Skill 已放入 ~/.agents/skills/evalme-mvp。`);
  console.log(installGuidance(result.command).join('\n'));
  console.log('新开 Agent 会话即可发现 Skill；Pi 也可 /reload。');
} catch(e) {console.error(`${e.code||'INSTALL_FAILED'}: ${e.safeMessage||e.message}`);process.exitCode=1;}
