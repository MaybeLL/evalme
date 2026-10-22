import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installGuidance} from '../src/install-guidance.mjs';

test('installation guidance distinguishes usable PATH, missing entry and shadowing without changing profiles', t => {
  const home = mkdtempSync(join(tmpdir(), 'evalme-path-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  const bin = join(home, '.local/bin'); mkdirSync(bin, {recursive:true});
  const command = join(bin, 'evalme-mvp'); writeFileSync(command, '#!/bin/sh\n', {mode:0o700});
  const env = {HOME:home, SHELL:'/bin/zsh', PATH:bin};
  assert.deepEqual(installGuidance(command, env), ['PATH 已就绪，可直接运行：', '  evalme-mvp init']);
  const missing = installGuidance(command, {...env, PATH:'/nonexistent', ZDOTDIR:join(home, 'custom')}).join('\n');
  assert.match(missing, /export PATH=/); assert.match(missing, /rehash/);
  assert.ok(missing.includes(join(home, 'custom/.zshrc')));
  const other = join(home, 'other'); mkdirSync(other); writeFileSync(join(other, 'evalme-mvp'), '#!/bin/sh\n', {mode:0o700});
  assert.match(installGuidance(command, {...env, PATH:other+':'+bin}).join('\n'), /另一个/);
  assert.match(installGuidance(command, {...env, PATH:'', SHELL:'/bin/bash'}).join('\n'), /hash -r/);
  assert.match(installGuidance(command, {...env, PATH:'', SHELL:'/bin/fish'}).join('\n'), /fish_add_path/);
  assert.match(installGuidance(command, {...env, PATH:'', SHELL:''}).join('\n'), /无需修改配置也可立即运行/);
});
