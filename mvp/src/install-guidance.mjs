import {accessSync, constants, realpathSync} from 'node:fs';
import {basename, delimiter, dirname, join, resolve} from 'node:path';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function installGuidance(command, env = process.env) {
  const dirs = (env.PATH || '').split(delimiter);
  let first;
  for (const dir of dirs) {
    const candidate = resolve(dir || '.', 'evalme-mvp');
    try { accessSync(candidate, constants.X_OK); first = candidate; break; } catch {}
  }
  let ready = false;
  if (first) {
    try { ready = realpathSync(first) === realpathSync(command); } catch {}
  }
  if (ready) return ['PATH 已就绪，可直接运行：', '  evalme-mvp init'];
  const lines = [first
    ? 'PATH 中有另一个 evalme-mvp 优先匹配，请先使用本次安装的入口：'
    : '当前 PATH 尚未包含可用的 EvalMe 启动入口。'];
  const shell = basename(env.SHELL || '');
  const bin = dirname(command);
  if (shell === 'zsh' || shell === 'bash') {
    const setting = `export PATH=${quote(bin)}:"$PATH"`;
    lines.push('在当前终端执行，即可直接使用：', `  ${setting}`, shell === 'zsh' ? '  rehash' : '  hash -r', '  evalme-mvp init');
    const rc = shell === 'zsh'
      ? join(env.ZDOTDIR || env.HOME || dirname(dirname(bin)), '.zshrc')
      : join(env.HOME || dirname(dirname(bin)), '.bashrc');
    lines.push(`希望新终端也生效：将上面的 export 行添加一次到 ${rc}（已有等效配置则无需重复）。`);
    if (shell === 'bash') lines.push('Bash 登录终端还需由登录配置加载 ~/.bashrc。');
  } else if (shell === 'fish') {
    lines.push('在 Fish 中执行（持久生效）：', `  fish_add_path ${quote(bin)}`, '  evalme-mvp init');
  } else {
    lines.push(`请在所用 shell 的 PATH 配置中加入 ${bin}。`);
  }
  lines.push(`无需修改配置也可立即运行：${quote(command)} init`, '安装器未修改 shell 配置；子进程无法改变当前终端的 PATH。');
  return lines;
}
