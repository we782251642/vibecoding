// 使用说明见 readme.md 的“五、分批整理媒体文件”。不需要安装依赖。
// 配置：相对路径以本脚本所在文件夹为基准；也可填写绝对路径。
const OUTPUT_DIRECTORY = 'XD';
// 每个编号目录最多放置的文件数，必须为正整数。
const FILES_PER_FOLDER = 100;
// 文件名中发表时间对应的时区偏移；应与下载脚本的 POST_DATE_TIME_ZONE 一致。
const POST_DATE_OFFSET = '+08:00';

import { readdir, stat, mkdir, rename, writeFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const explicitOutput = outputIndex === -1 ? null : args[outputIndex + 1];
if (outputIndex !== -1 && explicitOutput && !explicitOutput.startsWith('--')) args.splice(outputIndex, 2);
const output = explicitOutput
  ? path.resolve(explicitOutput) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), OUTPUT_DIRECTORY);
const dryRun = args.includes('--dry-run');
if (args.some(arg => arg !== '--dry-run')) {
  console.error('用法：node organize-media.mjs [--dry-run] [--output 输出目录]');
  process.exitCode = 1;
} else {
  main().catch(error => { console.error(`整理失败：${error.message}`); process.exitCode = 1; });
}

async function main() {
  if (!Number.isSafeInteger(FILES_PER_FOLDER) || FILES_PER_FOLDER < 1) throw new Error('FILES_PER_FOLDER 必须为正整数');
  console.log(`整理目录：${output}${dryRun ? '（仅预览，不移动文件）' : ''}`);
  // 提前检查两个目录，避免第二个目录有重名问题时只整理了一半。
  const plans = await Promise.all(['photo', 'video'].map(plan));
  for (const item of plans) await execute(item);
}

async function plan(type) {
  const directory = path.join(output, type);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { type, directory, moves: [], count: 0 }; throw error; }
  if (entries.some(entry => entry.name.startsWith('.organize-'))) {
    throw new Error(`${directory} 有未完成的整理暂存目录。请先根据其中 plan.json 恢复文件，保留暂存目录以免丢失文件。`);
  }
  const files = [];
  const names = new Set();
  async function collect(relative, list) {
    for (const entry of list) {
      // 不跟随符号链接，不移动未完成下载及临时文件。
      if (!entry.isFile() || /\.(?:part|tmp|log|json|bak)$/i.test(entry.name)) continue;
      if (names.has(entry.name.toLowerCase())) throw new Error(`${directory} 存在同名文件 ${entry.name}，请先处理重名，未移动任何文件`);
      names.add(entry.name.toLowerCase());
      const source = path.join(relative, entry.name);
      const info = await stat(path.join(directory, source));
      const match = entry.name.match(/_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})_\d+_(?:photo|video)(?:_[a-f\d]+)?\.[^.]+$/i);
      const posted = match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${POST_DATE_OFFSET}`) : NaN;
      files.push({ source, name: entry.name, time: Number.isFinite(posted) ? posted : info.mtimeMs });
    }
  }
  await collect('', entries);
  const numbered = entries.filter(entry => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name));
  for (const entry of numbered) await collect(entry.name, await readdir(path.join(directory, entry.name), { withFileTypes: true }));
  files.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name, 'en') || a.source.localeCompare(b.source));
  if (files.length <= FILES_PER_FOLDER && !numbered.length) return { type, directory, moves: [], count: files.length };
  const moves = files.map((file, index) => ({ source: file.source,
    destination: path.join(String(Math.floor(index / FILES_PER_FOLDER) + 1), file.name) }))
    .filter(move => move.source !== move.destination);
  return { type, directory, moves, count: files.length, numbered: numbered.map(entry => entry.name) };
}

async function execute({ type, directory, moves, count, numbered = [] }) {
  console.log(`${type}：共 ${count} 个文件，需移动 ${moves.length} 个，${count > FILES_PER_FOLDER ? `分为 ${Math.ceil(count / FILES_PER_FOLDER)} 组` : '未超过分组上限'}。`);
  if (dryRun || !moves.length) return;
  // 先全部暂存再放入目标，避免重新分组时覆盖尚未移出的文件。
  const staging = path.join(directory, `.organize-${randomUUID()}`);
  await mkdir(staging);
  const manifest = moves.map((move, index) => ({ ...move, staged: String(index) }));
  await writeFile(path.join(staging, 'plan.json'), JSON.stringify({ directory, phase: 'staging', moves: manifest }, null, 2));
  try {
    for (const move of manifest) await rename(path.join(directory, move.source), path.join(staging, move.staged));
    await writeFile(path.join(staging, 'plan.json'), JSON.stringify({ directory, phase: 'publishing', moves: manifest }, null, 2));
    for (const move of manifest) {
      const destination = path.join(directory, move.destination);
      await mkdir(path.dirname(destination), { recursive: true });
      try { await stat(destination); throw new Error(`目标文件已存在：${destination}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(path.join(staging, move.staged), destination);
    }
    await unlink(path.join(staging, 'plan.json'));
    await rmdir(staging);
    for (const name of numbered) {
      try { await rmdir(path.join(directory, name)); }
      catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
    console.log(`${type}：整理完成。`);
  } catch (error) {
    throw new Error(`${error.message}。暂存文件和移动清单保留在 ${staging}，请勿删除。`);
  }
}
