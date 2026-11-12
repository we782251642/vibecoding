// 使用说明见同目录 readme.md。
// # 可配置常量（集中配置区）
// ## 1. 输出与网络
// 下载根目录：相对路径基于脚本所在文件夹；也可填写绝对路径。
const OUTPUT_DIRECTORY = 'XD';
// 下载和报告保存完成后自动整理文件；设为 false 可关闭（--dry-run 始终不整理）。
const AUTO_ORGANIZE = true;
// 默认 HTTP(S) 代理地址；空字符串 '' 关闭自动代理，--proxy 可临时覆盖。
const PROXY_URL = 'http://127.0.0.1:7890';
// 同时处理的文件数：正整数，过大会增加网络、磁盘和服务器压力。
const DOWNLOAD_CONCURRENCY = 4;
// 每次下载的完整超时时间，单位毫秒，必须大于 0（默认 5 分钟）。
const DOWNLOAD_TIMEOUT_MS = 300_000;
// 每个文件最多尝试次数（包含首次下载），正整数。
const DOWNLOAD_MAX_ATTEMPTS = 3;
// 下载重试基础等待时间，单位毫秒；实际等待 = 此值 × 已尝试次数。
const DOWNLOAD_RETRY_DELAY_MS = 1000;

// ## 2. 文件命名与日志
// 作者及帖子标题的长度上限，单位 UTF-16 单元，均为正整数。
// 调整后会影响新文件命名；过长可能超过系统路径限制。
const AUTHOR_NAME_MAX_LENGTH = 32;
const POST_NAME_MAX_LENGTH = 48;
// 帖子发表时间的时区；日期格式为 YYYY-MM-DD_HHmmss。
const POST_DATE_TIME_ZONE = 'Asia/Shanghai';
// 日志文件名的时区，使用有效 IANA 时区名称。
const REPORT_TIME_ZONE = 'Asia/Shanghai';

// ## 3. 进度显示
// 终端进度刷新间隔，单位毫秒，必须大于 0。
const PROGRESS_REFRESH_MS = 500;
// 输出重定向到日志时，每隔多少次刷新打印一行，正整数（默认约 5 秒）。
const LOG_PROGRESS_EVERY_TICKS = 10;
// 配置区结束

import { readFile, mkdir, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { clearLine, cursorTo, createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// 根据脚本位置自动计算，无需配置。
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

async function writeJsonAtomic(filename, value, operations = {}) {
  const io = { writeFile, rename, rm, delay, ...operations };
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { await io.rename(temporary, filename); return; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4) throw error;
        await io.delay(100 * 2 ** attempt);
      }
    }
  } finally {
    await io.rm(temporary, { force: true }).catch(() => {});
  }
}

// 一次保存失败后，后续保存仍然可以继续执行。
function createSaveQueue() {
  let queue = Promise.resolve();
  return operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
}

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
if (!positional[0] || positional.length !== 1) {
  console.log('用法：node download-media.mjs <JSON文件> [--retry-failed] [--proxy http://127.0.0.1:7890] [--dry-run]');
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
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try { await run(input[Symbol.asyncIterator]()); }
  finally { input.close(); }
}

async function run(inputLines) {
  const input = path.resolve(positional[0]);
  const output = path.resolve(SCRIPT_DIRECTORY, OUTPUT_DIRECTORY);
  const logDirectory = path.join(output, 'log');
  const originalInput = await readFile(input, 'utf8');
  const data = JSON.parse(originalInput.replace(/^\uFEFF/, ''));
  if (!Array.isArray(data.posts)) throw new Error('JSON 根对象必须包含 posts 数组');
  const checkpointName = `download-checkpoint_${createHash('sha256').update(input).digest('hex').slice(0, 20)}.json`;
  const checkpointPath = path.join(logDirectory, checkpointName);
  const checkpoint = await readJsonIfExists(checkpointPath)
    ?? await readJsonIfExists(path.join(output, '日志', checkpointName))
    ?? await readJsonIfExists(path.join(output, checkpointName));
  if (checkpoint?.input === input && Array.isArray(checkpoint.downloads)) {
    const saved = new Map(checkpoint.downloads.map(item => [jobKey(item), item.download]));
    for (const post of data.posts) {
      for (const [mediaIndex, media] of (post?.media ?? []).entries()) {
        const key = jobKey({ postId: post.id ?? null, mediaIndex: mediaIndex + 1,
          type: media.type, url: media.type === 'photo' ? media.url : media.videoUrl });
        const record = saved.get(key);
        if (record && (!media.download || (record.updatedAt ?? '') > (media.download.updatedAt ?? ''))) {
          media.download = record;
        }
      }
    }
  }
  const reports = await readDownloadReports(output);
  const previousReport = reports.find(report =>
    typeof report?.input === 'string' && path.resolve(report.input) === input);
  const hasMarkedFailures = data.posts.some(post => post?.media?.some(media =>
    media?.download?.status === 'failed' && media.download.url === (media.type === 'photo' ? media.url : media.videoUrl)));
  if (retryFailed && !hasMarkedFailures && !previousReport) {
    throw new Error('--retry-failed 需要输入 JSON 中有失败标识，或输出目录中存在同一输入文件的下载报告');
  }
  const failedKeys = new Set((previousReport?.failures ?? []).map(jobKey));
  const statePath = path.join(logDirectory, 'download-state.json');
  const legacyState = await readJsonIfExists(path.join(output, 'download-state.json'));
  const savedState = await readJsonIfExists(statePath)
    ?? await readJsonIfExists(path.join(output, '日志', 'download-state.json'));
  const state = savedState?.version === 1 && savedState.files && typeof savedState.files === 'object'
    ? savedState : { version: 1, files: {} };
  if (legacyState?.version === 1 && legacyState.files && typeof legacyState.files === 'object') {
    state.files = { ...legacyState.files, ...state.files };
  }
  const historyByUrl = new Map();
  const addHistory = record => {
    if (!record || typeof record.url !== 'string' || !safeMediaFilename(record.filename)) return;
    if (!historyByUrl.has(record.url)) historyByUrl.set(record.url, []);
    historyByUrl.get(record.url).push(record);
  };
  for (const [filename, record] of Object.entries(state.files)) addHistory({ ...record, filename });
  for (const report of reports) {
    const records = Array.isArray(report.results) ? report.results : report.currentResults;
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (['success', 'skipped', 'downloaded'].includes(record?.status)) addHistory(record);
    }
  }
  const queueStateSave = createSaveQueue();
  const saveState = () => queueStateSave(() => writeJsonAtomic(statePath, state));
  const selection = await selectMediaType(inputLines);
  const jobs = [];
  const mediaByJob = new Map();
  const usedFilenames = new Set();
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
      const postedDate = formatPostedDate(post.postedAt);
      const authorName = filenamePart(post.author?.name, '', AUTHOR_NAME_MAX_LENGTH)
        || filenamePart(post.author?.handle, '未知作者', AUTHOR_NAME_MAX_LENGTH);
      const postName = filenamePart(post.name, '', POST_NAME_MAX_LENGTH)
        || filenamePart(typeof post.text === 'string' ? post.text.replace(/https?:\/\/\S+/gi, '') : '', '无标题', POST_NAME_MAX_LENGTH);
      // 保留媒体序号，防止同一帖子的多张图片重名。
      let filename = path.join(media.type === 'photo' ? 'photo' : 'video',
        `${authorName}_${postName}_${postedDate}_${mediaIndex + 1}_${media.type}${extension}`);
      // 同作者、同标题、同时间的不同帖子可能重名，按需追加短标识。
      const baseFilename = filename;
      let collision = 0;
      while (usedFilenames.has(filename) || (state.files[filename] && state.files[filename].url !== url)) {
        const suffix = createHash('sha256').update(JSON.stringify([url, post.id, postIndex, mediaIndex, collision++])).digest('hex').slice(0, 10);
        filename = `${baseFilename.slice(0, -extension.length)}_${suffix}${extension}`;
      }
      usedFilenames.add(filename);
      const job = { postId: post.id ?? null, mediaIndex: mediaIndex + 1, type: media.type,
        url: typeof url === 'string' ? url : null, filename, ...(error ? { error } : {}) };
      const marked = media.download;
      const failed = marked?.url === job.url
        ? marked.status === 'failed' : failedKeys.has(jobKey(job));
      if (retryFailed && !failed) { filtered++; continue; }
      jobs.push(job);
      mediaByJob.set(job, media);
    }
  }
  console.log(`帖子 ${data.posts.length} 条，待下载 ${jobs.length} 个（照片 ${jobs.filter(j => j.type === 'photo').length}，视频 ${jobs.filter(j => j.type === 'video').length}），忽略其他类型 ${ignored} 个。`);
  console.log(`按选择排除 ${filtered} 个文件。`);
  if (dryRun) {
    console.log(`仅检查数据，没有访问任何链接。无效地址 ${jobs.filter(j => j.error).length} 个。`);
    return;
  }
  if (!jobs.length) {
    console.log('没有符合条件的文件，无需下载；保留原报告。');
    organizeAfterDownload(output);
    return;
  }
  const existingByJob = new Map();
  // 整理脚本可能移动文件；按实际位置建立索引，仍须通过大小和哈希校验。
  const localFiles = await indexLocalMedia(output);
  let checkIndex = 0;
  console.log('正在对比本地下载记录…');
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) }, async () => {
    while (checkIndex < jobs.length) {
      const job = jobs[checkIndex++];
      if (job.error) continue;
      const marked = mediaByJob.get(job).download;
      const candidates = [...(historyByUrl.get(job.url) ?? [])];
      if (marked?.status === 'downloaded' && marked.output === output
        && safeMediaFilename(marked.filename)) candidates.unshift(marked);
      for (const record of candidates) {
        let existing;
        try { existing = await verifyExisting({ ...job, filename: record.filename }, output, record, null, localFiles); }
        catch (error) {
          console.warn(`历史文件暂时无法校验：${record.filename}（${describeError(error)}）`);
          continue;
        }
        if (!existing) continue;
        job.filename = existing.filename;
        existingByJob.set(job, existing);
        break;
      }
    }
  }));
  const pending = jobs.filter(job => !existingByJob.has(job));
  console.log(`符合条件 ${jobs.length} 个，已下载可跳过 ${existingByJob.size} 个，待下载 ${pending.length} 个。`);
  const count = pending.length ? await selectDownloadCount(inputLines, pending.length) : 0;
  const deferred = pending.length - count;
  const selected = new Set(pending.slice(0, count));
  const chosen = jobs.filter(job => existingByJob.has(job) || selected.has(job));
  jobs.splice(0, jobs.length, ...chosen);
  console.log(`本次下载 ${count} 个，跳过已下载 ${existingByJob.size} 个，其余 ${deferred} 个留待下次。`);
  // 首次更新前备份；串行、原子替换，避免并发下载交叉写入 JSON。
  try { await writeFile(`${input}.before-download.bak`, originalInput, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await Promise.all(['photo', 'video', 'log'].map(name => mkdir(path.join(output, name), { recursive: true })));
  const queueInputSave = createSaveQueue();
  let inputLocked = false;
  const saveInput = (retryOriginal = false) => queueInputSave(async () => {
    const downloads = [];
    for (const post of data.posts) {
      for (const [mediaIndex, media] of (post?.media ?? []).entries()) {
        if (!media.download) continue;
        downloads.push({ postId: post.id ?? null, mediaIndex: mediaIndex + 1, type: media.type,
          url: media.type === 'photo' ? media.url : media.videoUrl, download: media.download });
      }
    }
    // Checkpoint in the output directory remains usable even when the source is locked.
    await writeJsonAtomic(checkpointPath, { input, downloads });
    if (inputLocked && !retryOriginal) return;
    try {
      await writeJsonAtomic(input, data);
      inputLocked = false;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      if (!inputLocked) console.warn(`原 JSON 暂时无法更新，继续下载；状态已保存在：${checkpointPath}`);
      inputLocked = true;
    }
  });
  for (const post of data.posts) {
    for (const media of post?.media ?? []) {
      if (!['photo', 'video'].includes(media?.type)) continue;
      const url = media.type === 'photo' ? media.url : media.videoUrl;
      if (!media.download || media.download.url !== url) {
        media.download = { status: 'pending', url: url ?? null };
      }
    }
  }
  await saveInput();
  const progress = createProgress(jobs);
  // 已下载项只使用本地校验结果；未选中的项已从 jobs 排除。
  // 新文件在 GET 响应中读取大小，不再等待额外的 HEAD 请求。
  for (const job of jobs) {
    const existing = existingByJob.get(job);
    if (existing) progress.restore(job, existing.bytes);
  }
  progress.start();
  const results = new Array(jobs.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      try {
        if (job.error) throw new Error(job.error);
        const marked = mediaByJob.get(job).download;
        const record = state.files[job.filename]
          ?? (marked?.status === 'downloaded' && marked.filename === job.filename
            && marked.output === output ? marked : null);
        const existing = existingByJob.get(job)
          ?? await verifyExisting(job, output, record, progress.size(job), localFiles);
        if (existing) {
          job.filename = existing.filename;
          progress.restore(job, existing.bytes);
          state.files[job.filename] = { url: job.url, ...existing };
          await saveState();
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
      const result = results[index];
      mediaByJob.get(job).download = {
        status: result.status === 'failed' ? 'failed' : 'downloaded',
        url: job.url, output, filename: job.filename, updatedAt: new Date().toISOString(),
        ...(result.status === 'failed' ? { error: result.error } : {
          bytes: result.bytes, sha256: result.sha256, sizeVerified: result.sizeVerified,
        }),
      };
      // 原 JSON 被占用时使用输出目录检查点；检查点也无法保存时才报错。
      await saveInput();
      completed++;
      progress.completed = completed;
      if (results[index].status === 'failed') progress.failed++;
      const label = { success: '成功', skipped: '已验证，跳过', failed: '失败' }[results[index].status];
      progress.log(`[${completed}/${jobs.length}] ${label} ${job.filename}`);
    }
  }
  try {
    const workers = await Promise.allSettled(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) }, worker));
    const rejected = workers.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    await saveInput(true);
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
    ignored, selection, filtered, deferred, requested: count, retryFailed, failures, results: [...merged.values()], currentResults: results };
  const reportPath = path.join(logDirectory, reportFilename());
  await writeFile(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
  console.log(`\n下载完成：新下载成功 ${report.succeeded} 个，已验证跳过 ${skipped} 个，本次失败 ${report.failed} 个。待重试失败共 ${failures.length} 个。`);
  for (const item of failures) console.log(`失败：${item.filename}\n  地址：${item.url ?? '缺失'}\n  原因：${item.error}`);
  console.log(`完整报告：${reportPath}`);
  if (inputLocked) console.warn(`原 JSON 仍被占用；完整状态保留在 ${checkpointPath}，下次运行会自动读取。`);
  if (currentFailures.length) process.exitCode = 1;
  organizeAfterDownload(output);
}

function organizeAfterDownload(output) {
  if (!AUTO_ORGANIZE || dryRun) return;
  console.log('\n开始自动整理下载文件…');
  const result = spawnSync(process.execPath, [path.join(SCRIPT_DIRECTORY, 'organize-media.mjs'), '--output', output], {
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    console.error(`自动整理失败：${result.error?.message ?? `整理脚本退出码 ${result.status ?? result.signal}`}。下载报告已保留，可稍后单独运行整理脚本。`);
    process.exitCode = 1;
  } else {
    console.log('自动整理完成。');
  }
}

function jobKey(job) {
  return JSON.stringify([job.postId, job.mediaIndex, job.type, job.url]);
}

function reportFilename(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: REPORT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const stamp = `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}_${String(now.getUTCMilliseconds()).padStart(3, '0')}`;
  return `download-report_${stamp}_${randomUUID()}.json`;
}

function safeMediaFilename(filename) {
  if (typeof filename !== 'string') return false;
  const parts = filename.split(/[\\/]/);
  const basename = parts.at(-1);
  return parts.length <= 3 && (parts.length === 1 || ['photo', 'video', '图片', '视频'].includes(parts[0]))
    && (parts.length < 3 || /^[1-9]\d*$/.test(parts[1]))
    && !!basename && !basename.includes(':') && basename !== '.' && basename !== '..';
}

async function readDownloadReports(output) {
  const candidates = (await Promise.all([output, path.join(output, 'log'), path.join(output, '日志')].map(async directory => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(entries
      .filter(entry => entry.isFile() && /^download-report(?:_[\w-]+)?\.json$/.test(entry.name))
      .map(async entry => {
        const filename = path.join(directory, entry.name);
        return { filename, modified: (await stat(filename)).mtimeMs };
      }));
  }))).flat();
  candidates.sort((a, b) => b.modified - a.modified || b.filename.localeCompare(a.filename));
  const reports = [];
  for (const candidate of candidates) {
    try {
      const report = await readJsonIfExists(candidate.filename);
      if (report && typeof report === 'object') reports.push(report);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.warn(`忽略无法解析的历史报告：${candidate.filename}`);
    }
  }
  return reports;
}

async function readJsonIfExists(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function indexLocalMedia(output) {
  const index = new Map();
  async function scan(relative = '') {
    let entries;
    try { entries = await readdir(path.join(output, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const filename = path.join(relative, entry.name);
      if (entry.isFile() && safeMediaFilename(filename)) {
        if (!index.has(entry.name)) index.set(entry.name, []);
        index.get(entry.name).push(filename);
      } else if (entry.isDirectory() && ((!relative && ['photo', 'video', '图片', '视频'].includes(entry.name))
        || (relative && !relative.includes(path.sep) && /^[1-9]\d*$/.test(entry.name)))) {
        await scan(filename);
      }
    }
  }
  await scan();
  return index;
}

async function verifyExisting(job, output, record, expectedSize, localFiles = new Map()) {
  if (!record || record.url !== job.url || !record.sha256 || !(record.bytes > 0)) return null;
  if (!safeMediaFilename(job.filename)) return null;
  const candidates = new Set([job.filename, ...(localFiles.get(path.basename(job.filename)) ?? [])]);
  for (const relative of candidates) {
  const filename = path.join(output, relative);
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size !== record.bytes || (expectedSize !== null && info.size !== expectedSize)) continue;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    if (hash.digest('hex') !== record.sha256) continue;
    return { filename: relative, bytes: record.bytes, sha256: record.sha256, sizeVerified: expectedSize !== null || record.sizeVerified === true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

function responseSize(response) {
  const raw = response.headers.get('content-length');
  const size = raw === null ? NaN : Number(raw);
  const encoding = response.headers.get('content-encoding');
  return Number.isSafeInteger(size) && size >= 0 && (!encoding || encoding === 'identity') ? size : null;
}

async function selectMediaType(lines) {
  console.log('\n请选择下载类型：\n  1. 仅图片\n  2. 仅视频\n  3. 图片和视频');
    process.stdout.write('请输入 1、2 或 3，然后回车：');
    while (true) {
      const { value: line, done } = await lines.next();
      if (done) throw new Error('未选择下载类型，已取消下载');
      const choice = { '1': 'photo', '2': 'video', '3': 'all' }[line.trim()];
      if (choice) {
        console.log(`已选择：${choice === 'photo' ? '仅图片' : choice === 'video' ? '仅视频' : '图片和视频'}。`);
        return choice;
      }
      process.stdout.write('输入无效，请输入 1、2 或 3：');
    }
}

async function selectDownloadCount(lines, total) {
  process.stdout.write(`请输入本次下载数量（1-${total}，输入 0 下载全部）：`);
  while (true) {
    const { value, done } = await lines.next();
    if (done) throw new Error('未选择下载数量，已取消下载');
    const text = value.trim();
    const count = /^\d+$/.test(text) ? Number(text) : NaN;
    if (Number.isSafeInteger(count) && count >= 0 && count <= total) return count === 0 ? total : count;
    process.stdout.write(`输入无效，请输入 1-${total} 的整数，或输入 0 下载全部：`);
  }
}

function formatPostedDate(value) {
  if (typeof value !== 'string' || !value.trim()) return '未知日期';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知日期';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: POST_DATE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
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
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      progress.reset(job);
      // 超时覆盖连接和完整文件传输；失败最多尝试三次。
      const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
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
      if (attempt === DOWNLOAD_MAX_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * DOWNLOAD_RETRY_DELAY_MS));
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
    phase: '下载中', completed: 0, failed: 0,
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
      if (!process.stdout.isTTY && !force && ++ticks % LOG_PROGRESS_EVERY_TICKS !== 0) return;
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
      const line = `${progress.phase} | 完成 ${progress.completed}/${jobs.length}（失败 ${progress.failed}） | 已下载 ${formatBytes(downloaded)} | 总大小 ${sizeText} | 剩余 ${remainingText}${percent} | 速度 ${formatBytes(speed)}/s | 预计剩余 ${eta}`;
      erase();
      process.stdout.write(line + (process.stdout.isTTY ? '' : '\n'));
    },
    log(message) { erase(); console.log(message); },
    start() { progress.render(true); timer = setInterval(() => progress.render(), PROGRESS_REFRESH_MS); },
    stop() {
      clearInterval(timer);
      progress.phase = '下载结束';
      progress.render(true);
      if (process.stdout.isTTY) process.stdout.write('\n');
    },
  };
  return progress;
}
