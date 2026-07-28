import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileAsync, fetchBuffer, readJson, rootDir, sha256 } from './lib.mjs';

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(path, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}

async function validate(binary, expectedVersion) {
  const { stdout } = await execFileAsync(binary, ['version']);
  if (!stdout.includes(`sing-box version ${expectedVersion}`)) {
    throw new Error(`sing-box 版本不匹配，期望 ${expectedVersion}，实际输出：${stdout.trim()}`);
  }
  return binary;
}

export async function ensureSingBox() {
  const config = (await readJson(resolve(rootDir, 'src/upstreams.json'))).sing_box;
  if (process.env.SING_BOX_BIN) return validate(resolve(process.env.SING_BOX_BIN), config.version);

  try {
    const { stdout } = await execFileAsync('which', ['sing-box']);
    if (stdout.trim()) return validate(stdout.trim(), config.version);
  } catch {
    // 使用校验过的官方二进制缓存。
  }

  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`无法自动安装当前平台的 sing-box ${config.version}，请通过 SING_BOX_BIN 指定`);
  }
  const target = resolve(rootDir, `.cache/sing-box/${config.version}/sing-box`);
  if (await executable(target)) return validate(target, config.version);

  const temporary = await mkdtemp(join(tmpdir(), 'network-rules-dist-sing-box-'));
  try {
    const archive = await fetchBuffer(config.linux_x64_glibc.url);
    const digest = sha256(archive);
    if (digest !== config.linux_x64_glibc.sha256) throw new Error(`sing-box 压缩包校验失败：${digest}`);
    const archivePath = join(temporary, basename(config.linux_x64_glibc.url));
    await writeFile(archivePath, archive);
    await execFileAsync('tar', ['-xzf', archivePath, '-C', temporary]);
    const extracted = await findFile(temporary, 'sing-box');
    if (!extracted) throw new Error('官方压缩包中没有找到 sing-box');
    await execFileAsync('install', ['-D', '-m', '0755', extracted, target]);
    await chmod(target, 0o755);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return validate(target, config.version);
}
