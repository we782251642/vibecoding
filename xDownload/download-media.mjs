/**
 * 媒体批量下载脚本（Node.js 20+，无需安装依赖）
 *
 * 在命令行进入此脚本所在目录，然后运行：
 *   node ./download-media.mjs "JSON文件路径" "输出目录"
 * 启动后输入数字并回车：1 = 仅图片，2 = 仅视频，3 = 图片和视频。
 * 必须明确选择；输入无效时重新提示，Ctrl+C 可取消。
 * 例如：
 *   node ./download-media.mjs "C:/Users/MoWen/Downloads/bookmark-gallery-likes-2026-11-11 (1).json" "./downloaded-media"
 * 只检查数据、不访问任何链接：
 *   node ./download-media.mjs "JSON文件路径" --dry-run
 * 仅重试输出目录同一输入文件最新报告中的失败项（仍可选择图片/视频）：
 *   node ./download-media.mjs "JSON文件路径" "输出目录" --retry-failed
 * 默认使用下方 PROXY_URL 常量指定的代理，无需在命令中输入代理参数。
 * 修改 PROXY_URL 可更换地址，设为 '' 可关闭脚本自动启用代理。
 * 代理需要支持 --use-env-proxy 的 Node.js，如本机 v22.22.2。
 * 仍可通过 --proxy http://127.0.0.1:7890 临时覆盖常量；--dry-run 不建立网络连接。
 *
 * 输出目录可省略，默认使用当前工作目录下的 downloaded-media。
 * 从 posts[].media[] 下载 photo 的 url 和 video 的 videoUrl。
 * 文件名：作者名称_帖子名称_帖子ID_帖子序号_媒体序号_类型.扩展名
 * 作者优先使用 author.name，其次 author.handle；帖子优先使用 name，
 * 没有 name 时使用 text（去除链接）的前 48 个 UTF-16 单元。
 * 缺少名称时使用“未知作者”或“无标题”，非法文件名字符会替换为下划线。
 * 作者名称最多 32 个 UTF-16 单元，保留帖子和媒体序号以防重名。
 *
 * 下载时显示速度、大小、文件数量和预计剩余时间；大小未知时会明确标注。
 * 最多同时下载 4 个文件，每个文件最多尝试 3 次。
 * 完成后保存 download-report_年月日_时分秒_毫秒_唯一标识.json，保留历史报告。
 * 文件名时间使用北京时间（Asia/Shanghai）；仍兼容旧版 download-report.json。
 * 重复运行时，用本地 SHA-256 记录及服务器已知大小验证已有文件，验证通过则跳过。
 * 无校验记录或文件损坏时重新下载；download-state.json 保存校验记录，请保留。
 * 下载后检查非空、响应声明大小和传输完整性，再将临时文件改为正式文件。
 * 服务器未提供大小时只能验证传输正常结束，不能证明源文件内容完整。
 */
import { readFile, mkdir, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { clearLine, cursorTo, createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';

// 默认代理地址：修改此常量即可；设为 '' 可关闭脚本自动启用代理。
const PROXY_URL = 'http://127.0.0.1:7890';

// Node.js 20+，无需安装依赖。
const args = process.argv.slice(2);
const proxyIndex = args.indexOf('--proxy');
let explicitProxy;
if (proxyIndex !== -1) {
  explicitProxy = args[proxyIndex + 1];
  try {
    if (!['http:', 'https:'].includes(new URL(explicitProxy).protocol)) throw new Error();
  } catch {
    console.error('--proxy 后需要提供 HTTP(S) 代理地址，例如 http://127.0.0.1:7890');
    process.exit(1);
  }
  args.splice(proxyIndex, 2);
}
const dryRun = args.includes('--dry-run');
const retryFailed = args.includes('--retry-failed');
const positional = args.filter(arg => !['--dry-run', '--retry-failed'].includes(arg));
const proxy = explicitProxy ?? PROXY_URL;
if (!positional[0] || positional.length > 2) {
  console.log('用法：node download-media.mjs <JSON文件> [输出目录] [--retry-failed] [--proxy http://127.0.0.1:7890] [--dry-run]');
  process.exitCode = 1;
} else if (!dryRun && proxy && !process.execArgv.includes('--use-env-proxy')) {
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
    console.error('当前 Node.js 不支持内置代理，请升级到 Node.js 22.21+ 或 24.5+。');
    process.exitCode = 1;
  } else {
    console.log('已启用 HTTP(S) 代理。');
    const child = spawnSync(process.execPath, ['--use-env-proxy', ...process.argv.slice(1)], {
      stdio: 'inherit', env: { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy },
    });
    if (child.error) console.error(`启动失败：${child.error.message}`);
    process.exitCode = child.status ?? 1;
  }
} else {
  main().catch(error => {
    console.error(`程序失败：${error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const input = path.resolve(positional[0]);
  const output = path.resolve(positional[1] ?? 'downloaded-media');
  const data = JSON.parse((await readFile(input, 'utf8')).replace(/^\uFEFF/, ''));
  if (!Array.isArray(data.posts)) throw new Error('JSON 根对象必须包含 posts 数组');
  const previousReport = await readLatestReport(output, input);
  if (retryFailed && (!previousReport || !Array.isArray(previousReport.failures)
    || path.resolve(previousReport.input ?? '') !== input)) {
    throw new Error('--retry-failed 需要输出目录中存在同一输入文件的下载报告（download-report_*.json 或旧版 download-report.json）');
  }
  const failedKeys = new Set((previousReport?.failures ?? []).map(jobKey));
  const statePath = path.join(output, 'download-state.json');
  const savedState = await readJsonIfExists(statePath);
  const state = savedState?.version === 1 && savedState.files && typeof savedState.files === 'object'
    ? savedState : { version: 1, files: {} };
  let saveQueue = Promise.resolve();
  const saveState = () => {
    saveQueue = saveQueue.then(() => writeJsonAtomic(statePath, state));
    return saveQueue;
  };
  const selection = await selectMediaType();
  const jobs = [];
  let ignored = 0;
  let filtered = 0;
  for (const [postIndex, post] of data.posts.entries()) {
    if (!Array.isArray(post?.media)) continue;
    for (const [mediaIndex, media] of post.media.entries()) {
      if (!['photo', 'video'].includes(media?.type)) { ignored++; continue; }
      if (selection !== 'all' && media.type !== selection) { filtered++; continue; }
      const url = media.type === 'photo' ? media.url : media.videoUrl;
      let parsed;
      let error;
      try {
        parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error();
      } catch { error = '媒体地址缺失或不是有效的 HTTP(S) 地址'; }
      const candidateExt = parsed ? path.extname(parsed.pathname) : '';
      const extension = /^\.[a-z0-9]{1,5}$/i.test(candidateExt)
        ? candidateExt : media.type === 'photo' ? '.jpg' : '.mp4';
      const postId = String(post.id ?? postIndex + 1).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
      const authorName = filenamePart(post.author?.name, '', 32)
        || filenamePart(post.author?.handle, '未知作者', 32);
      const postName = filenamePart(post.name, '', 48)
        || filenamePart(typeof post.text === 'string' ? post.text.replace(/https?:\/\/\S+/gi, '') : '', '无标题', 48);
      // 包含帖子序号，防止重复帖子或不可信 ID 造成覆盖、路径穿越。
      const filename = `${authorName}_${postName}_${postId}_${postIndex + 1}_${mediaIndex + 1}_${media.type}${extension}`;
      const job = { postId: post.id ?? null, mediaIndex: mediaIndex + 1, type: media.type,
        url: typeof url === 'string' ? url : null, filename, ...(error ? { error } : {}) };
      if (retryFailed && !failedKeys.has(jobKey(job))) { filtered++; continue; }
      jobs.push(job);
    }
  }
  console.log(`帖子 ${data.posts.length} 条，待下载 ${jobs.length} 个（照片 ${jobs.filter(j => j.type === 'photo').length}，视频 ${jobs.filter(j => j.type === 'video').length}），忽略其他类型 ${ignored} 个。`);
  console.log(`按选择排除 ${filtered} 个文件。`);
  if (dryRun) {
    console.log(`仅检查数据，没有访问任何链接。无效地址 ${jobs.filter(j => j.error).length} 个。`);
    return;
  }
  if (!jobs.length) { console.log('没有符合条件的文件，无需下载；保留原报告。'); return; }
  await mkdir(output, { recursive: true });
  const progress = createProgress(jobs);
  progress.start();
  // 先查询大小；不支持 HEAD 的服务器会在实际下载时再次尝试读取大小。
  let probeIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (probeIndex < jobs.length) {
      const job = jobs[probeIndex++];
      if (!job.error) {
        try {
          const response = await fetch(job.url, {
            method: 'HEAD', signal: AbortSignal.timeout(15_000),
            headers: { 'Accept-Encoding': 'identity' },
          });
          if (response.ok) progress.setSize(job, response);
          await response.body?.cancel();
        } catch { /* 大小未知不影响下载。 */ }
      }
      progress.probed++;
    }
  }));
  progress.phase = '下载中';
  const results = new Array(jobs.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      try {
        if (job.error) throw new Error(job.error);
        const record = state.files[job.filename];
        const existing = await verifyExisting(job, output, record, progress.size(job));
        if (existing) {
          progress.restore(job, existing.bytes);
          results[index] = { ...job, status: 'skipped', ...existing };
        } else {
          const verified = await download(job, output, progress);
          state.files[job.filename] = { url: job.url, ...verified };
          await saveState();
          results[index] = { ...job, status: 'success', ...verified };
        }
      } catch (error) {
        results[index] = { ...job, status: 'failed', error: describeError(error) };
      }
      completed++;
      progress.completed = completed;
      if (results[index].status === 'failed') progress.failed++;
      const label = { success: '成功', skipped: '已验证，跳过', failed: '失败' }[results[index].status];
      progress.log(`[${completed}/${jobs.length}] ${label} ${job.filename}`);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  } finally {
    progress.stop();
  }
  // 保留未在本次运行中处理的失败项，避免只重试图片后丢失视频失败记录。
  const merged = new Map();
  if (previousReport?.input === input) {
    for (const result of previousReport.results ?? previousReport.failures ?? []) merged.set(jobKey(result), result);
  }
  for (const result of results) merged.set(jobKey(result), result);
  const failures = [...merged.values()].filter(result => result.status === 'failed');
  const currentFailures = results.filter(result => result.status === 'failed');
  const skipped = results.filter(result => result.status === 'skipped').length;
  const report = { input, output, finishedAt: new Date().toISOString(), total: jobs.length,
    succeeded: results.filter(result => result.status === 'success').length,
    skipped, failed: currentFailures.length, pendingFailed: failures.length,
    ignored, selection, filtered, retryFailed, failures, results: [...merged.values()], currentResults: results };
  const reportPath = path.join(output, reportFilename());
  await writeFile(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
  console.log(`\n下载完成：新下载成功 ${report.succeeded} 个，已验证跳过 ${skipped} 个，本次失败 ${report.failed} 个。待重试失败共 ${failures.length} 个。`);
  for (const item of failures) console.log(`失败：${item.filename}\n  地址：${item.url ?? '缺失'}\n  原因：${item.error}`);
  console.log(`完整报告：${reportPath}`);
  if (currentFailures.length) process.exitCode = 1;
}

function jobKey(job) {
  return JSON.stringify([job.postId, job.mediaIndex, job.type, job.url]);
}

function reportFilename(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const stamp = `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}_${String(now.getUTCMilliseconds()).padStart(3, '0')}`;
  return `download-report_${stamp}_${randomUUID()}.json`;
}

async function readLatestReport(output, input) {
  let entries;
  try { entries = await readdir(output, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const candidates = await Promise.all(entries
    .filter(entry => entry.isFile() && /^download-report(?:_[\w-]+)?\.json$/.test(entry.name))
    .map(async entry => {
      const filename = path.join(output, entry.name);
      return { filename, modified: (await stat(filename)).mtimeMs };
    }));
  candidates.sort((a, b) => b.modified - a.modified || b.filename.localeCompare(a.filename));
  for (const candidate of candidates) {
    const report = await readJsonIfExists(candidate.filename);
    if (typeof report?.input === 'string' && path.resolve(report.input) === input) return report;
  }
  return null;
}

async function readJsonIfExists(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, filename);
}

async function verifyExisting(job, output, record, expectedSize) {
  if (!record || record.url !== job.url || !record.sha256 || !(record.bytes > 0)) return null;
  const filename = path.join(output, job.filename);
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size !== record.bytes || (expectedSize !== null && info.size !== expectedSize)) return null;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    if (hash.digest('hex') !== record.sha256) return null;
    return { bytes: record.bytes, sha256: record.sha256, sizeVerified: expectedSize !== null || record.sizeVerified === true };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function responseSize(response) {
  const raw = response.headers.get('content-length');
  const size = raw === null ? NaN : Number(raw);
  const encoding = response.headers.get('content-encoding');
  return Number.isSafeInteger(size) && size >= 0 && (!encoding || encoding === 'identity') ? size : null;
}

async function selectMediaType() {
  console.log('\n请选择下载类型：\n  1. 仅图片\n  2. 仅视频\n  3. 图片和视频');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    process.stdout.write('请输入 1、2 或 3，然后回车：');
    for await (const line of input) {
      const choice = { '1': 'photo', '2': 'video', '3': 'all' }[line.trim()];
      if (choice) {
        console.log(`已选择：${choice === 'photo' ? '仅图片' : choice === 'video' ? '仅视频' : '图片和视频'}。`);
        return choice;
      }
      process.stdout.write('输入无效，请输入 1、2 或 3：');
    }
    throw new Error('未选择下载类型，已取消下载');
  } finally {
    input.close();
  }
}

function filenamePart(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ').trim();
  // 按完整 Unicode 字符截断，避免切断表情符号的代理对。
  let result = '';
  for (const character of cleaned) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result.replace(/[. ]+$/g, '') || fallback;
}

function describeError(error) {
  const parts = [];
  for (let current = error; current; current = current.cause) {
    parts.push([current.code, current.message].filter(Boolean).join(': '));
  }
  return parts.join(' → ');
}

async function download(job, output, progress) {
  const destination = path.join(output, job.filename);
  const temporary = `${destination}.part`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      progress.reset(job);
      // 超时覆盖连接和完整文件传输；失败最多尝试三次。
      const signal = AbortSignal.timeout(300_000);
      const response = await fetch(job.url, { signal, headers: { 'Accept-Encoding': 'identity' } });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (response.status === 206) {
        await response.body?.cancel();
        throw new Error('服务器意外返回部分文件（HTTP 206），拒绝保存为完整文件');
      }
      if (!response.body) throw new Error('响应没有文件内容');
      const contentType = response.headers.get('content-type') ?? '';
      if (/text\/html|application\/json/i.test(contentType)) {
        await response.body.cancel();
        throw new Error(`服务器返回了非媒体内容：${contentType}`);
      }
      const expectedSize = responseSize(response);
      progress.setSize(job, response);
      const hash = createHash('sha256');
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          progress.add(job, chunk.length);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(temporary), { signal });
      if (bytes === 0) throw new Error('完整性检查失败：下载文件为空');
      if (expectedSize !== null && bytes !== expectedSize) {
        throw new Error(`完整性检查失败：应为 ${expectedSize} 字节，实际 ${bytes} 字节`);
      }
      if ((await stat(temporary)).size !== bytes) throw new Error('完整性检查失败：磁盘文件大小与接收字节数不一致');
      const sha256 = hash.digest('hex');
      await rename(temporary, destination);
      progress.finish(job);
      if (expectedSize === null) progress.log(`提示：${job.filename} 服务器未提供大小，已记录 SHA-256，但无法核对源文件总大小。`);
      return { bytes, sha256, sizeVerified: expectedSize !== null };
    } catch (error) {
      progress.reset(job);
      await rm(temporary, { force: true });
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function createProgress(jobs) {
  const states = new Map(jobs.map(job => [job, { size: null, bytes: 0 }]));
  let transferred = 0;
  let previousBytes = 0;
  let previousTime = Date.now();
  let speed = 0;
  let timer;
  let ticks = 0;
  function erase() {
    if (process.stdout.isTTY) { cursorTo(process.stdout, 0); clearLine(process.stdout, 0); }
  }
  const progress = {
    phase: '查询大小', probed: 0, completed: 0, failed: 0,
    setSize(job, response) {
      states.get(job).size = responseSize(response);
    },
    size(job) { return states.get(job).size; },
    restore(job, bytes) { states.get(job).bytes = bytes; states.get(job).size = bytes; },
    add(job, bytes) { states.get(job).bytes += bytes; transferred += bytes; },
    reset(job) { states.get(job).bytes = 0; },
    finish(job) { const state = states.get(job); state.size = state.bytes; },
    render(force = false) {
      const now = Date.now();
      const elapsed = now - previousTime;
      if (elapsed > 0) speed = (transferred - previousBytes) * 1000 / elapsed;
      previousTime = now;
      previousBytes = transferred;
      // 重定向到文件或日志时每五秒输出一次，避免刷屏。
      if (!process.stdout.isTTY && !force && ++ticks % 10 !== 0) return;
      let downloaded = 0, total = 0, remaining = 0, unknown = 0;
      for (const state of states.values()) {
        downloaded += state.bytes;
        if (state.size === null) unknown++;
        else { total += state.size; remaining += Math.max(0, state.size - state.bytes); }
      }
      const sizeText = unknown ? `已知 ${formatBytes(total)}，${unknown} 个大小未知` : formatBytes(total);
      const remainingText = unknown ? `至少 ${formatBytes(remaining)}` : formatBytes(remaining);
      const percent = !unknown && total > 0 ? ` ${(downloaded / total * 100).toFixed(1)}%` : '';
      const eta = !unknown && speed > 0 && !progress.failed
        ? `${Math.ceil(remaining / speed)} 秒` : '未知';
      const phase = progress.phase === '查询大小' ? `查询大小 ${progress.probed}/${jobs.length}` : progress.phase;
      const line = `${phase} | 完成 ${progress.completed}/${jobs.length}（失败 ${progress.failed}） | 已下载 ${formatBytes(downloaded)} | 总大小 ${sizeText} | 剩余 ${remainingText}${percent} | 速度 ${formatBytes(speed)}/s | 预计剩余 ${eta}`;
      erase();
      process.stdout.write(line + (process.stdout.isTTY ? '' : '\n'));
    },
    log(message) { erase(); console.log(message); },
    start() { progress.render(true); timer = setInterval(() => progress.render(), 500); },
    stop() {
      clearInterval(timer);
      progress.phase = '下载结束';
      progress.render(true);
      if (process.stdout.isTTY) process.stdout.write('\n');
    },
  };
  return progress;
}
