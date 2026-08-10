import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);
const generatorDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const rootDir = resolve(process.env.NETWORK_RULES_ROOT || generatorDir);
export const outputDir = resolve(rootDir, process.env.NETWORK_RULES_OUTPUT_DIR || '.');

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function readJsonIfPresent(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

export async function writeJson(path, value) {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function resetDirectory(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

export async function fetchBuffer(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'inderiva/network-rules-dist' },
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`下载失败（已重试 3 次）：${url}；${lastError?.message ?? lastError}`);
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function uniqueSorted(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function validateCountSafety(value, options) {
  if (!Number.isInteger(value) || value < options.minimum || value > options.maximum) {
    throw new Error(`${options.tag} 数量 ${value} 超出安全范围 ${options.minimum}-${options.maximum}`);
  }
  if (Number.isInteger(options.previous) && options.previous > 0) {
    const changeRatio = Math.abs(value - options.previous) / options.previous;
    if (changeRatio > options.maximumChangeRatio) {
      throw new Error(`${options.tag} 数量相对上次变化 ${(changeRatio * 100).toFixed(1)}%，超过安全阈值`);
    }
  }
  return value;
}

export function ruleValues(value, context = 'rule field') {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== 'string')) throw new Error(`${context} 必须是字符串或字符串数组`);
  return values;
}

export function countRuleEntries(source) {
  const fields = ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'ip_cidr'];
  return source.rules.reduce(
    (total, rule) => total + fields.reduce((sum, field) => sum + ruleValues(rule[field], field).length, 0),
    0
  );
}

export function validateRuleSetSafety(source, options) {
  if (!source || !Array.isArray(source.rules)) throw new Error(`${options.tag} 不是有效的规则集源`);
  const allowedFields = new Set(options.allowedFields);
  for (const [index, rule] of source.rules.entries()) {
    for (const field of Object.keys(rule)) {
      if (!allowedFields.has(field)) throw new Error(`${options.tag} 出现未审核字段 rules[${index}].${field}`);
      for (const value of ruleValues(rule[field], `${options.tag}.${field}`)) {
        if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${options.tag}.${field} 包含无效值`);
        if (field === 'domain_suffix' && options.rejectSingleLabelSuffix && !value.includes('.')) {
          throw new Error(`${options.tag} 出现高风险顶级后缀：${value}`);
        }
        if (field === 'domain_regex' && ['.', '.*', '^.*$', '^.+$'].includes(value)) {
          throw new Error(`${options.tag} 出现全匹配正则：${value}`);
        }
        if (field === 'domain_regex' && options.rejectUniversalRegex) {
          try {
            const expression = new RegExp(value);
            const probes = ['example.com', 'service.invalid', 'a.b.example'];
            if (probes.every((probe) => expression.test(probe))) {
              throw new Error(`${options.tag} 出现疑似全匹配正则：${value}`);
            }
          } catch (error) {
            if (error.message.startsWith(`${options.tag} 出现`)) throw error;
          }
        }
        if (field === 'ip_cidr' && ['0.0.0.0/0', '::/0'].includes(value)) {
          throw new Error(`${options.tag} 出现全网 CIDR：${value}`);
        }
      }
    }
  }
  const entries = countRuleEntries(source);
  return validateCountSafety(entries, {
    tag: options.tag,
    minimum: options.minimumEntries,
    maximum: options.maximumEntries,
    previous: options.previousEntries,
    maximumChangeRatio: options.maximumChangeRatio
  });
}
