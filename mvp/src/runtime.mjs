import {readFileSync} from 'node:fs';
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
export function compatibleNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return (major === 22 && minor >= 16) || major === 24;
}
export const runtimeHint = '需要 Node 22.16+（22.x）或 24.x。可选择兼容的已有 Node；无需更改系统默认版本。';
