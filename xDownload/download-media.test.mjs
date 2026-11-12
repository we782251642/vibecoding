import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Isolate the inline persistence helpers without starting the interactive CLI.
const scriptSource = await readFile(new URL('./download-media.mjs', import.meta.url), 'utf8');
const helperSource = scriptSource.slice(scriptSource.indexOf('async function writeJsonAtomic('),
  scriptSource.indexOf('// Node.js 20+，无需安装依赖。'));
const { writeJsonAtomic, createSaveQueue } = new Function(
  'writeFile', 'rename', 'rm', 'randomUUID', 'delay',
  `${helperSource}\nreturn { writeJsonAtomic, createSaveQueue };`,
)(writeFile, rename, rm, randomUUID, delay);

test('persists media status, verifies skipped files, and retries failures without a report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xdownload-test-'));
  let fail = true;
  let requests = 0;
  let headRequests = 0;
  const gets = { good: 0, bad: 0 };
  const server = createServer((req, res) => {
    requests++;
    if (req.method === 'HEAD') headRequests++;
    const key = req.url === '/good.jpg' ? 'good' : 'bad';
    if (req.method === 'GET') gets[key]++;
    if (key === 'bad' && fail) { res.writeHead(503); res.end(); return; }
    const body = Buffer.from(`fixture-${key}`);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const source = await readFile(new URL('./download-media.mjs', import.meta.url), 'utf8');
    const script = path.join(root, 'download-media.mjs');
    await writeFile(path.join(root, 'organize-media.mjs'), await readFile(new URL('./organize-media.mjs', import.meta.url)));
    await writeFile(script, source.replace("const PROXY_URL = 'http://127.0.0.1:7890';", "const PROXY_URL = '';").replace(
      'const io = { writeFile, rename, rm, delay, ...operations };',
      `const io = { writeFile, rename, rm, delay, ...operations };
       if (process.env.TEST_LOCK_INPUT === '1' && filename.endsWith('input.json')) {
         io.rename = async () => { throw Object.assign(new Error('simulated lock'), { code: 'EPERM' }); };
         io.delay = async () => {};
       }`));
    const input = path.join(root, 'input.json');
    const output = path.join(root, 'XD');
    const logs = path.join(output, 'log');
    const url = `http://127.0.0.1:${server.address().port}`;
    const original = JSON.stringify({ collection: 'fixture', posts: [{ id: '1', postedAt: '2026-10-22T03:09:08.000Z', author: { name: 'test' },
      media: ['good', 'bad'].map(key => ({ type: 'photo', url: `${url}/${key}.jpg` })) }] });
    await writeFile(input, original);
    const run = (flags = [], extraEnv = {}, answers = '1\n0\n') => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, input, ...flags], {
        env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NODE_USE_ENV_PROXY: '0', ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let log = '';
      child.stdout.on('data', chunk => { log += chunk; });
      child.stderr.on('data', chunk => { log += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, log }));
      child.stdin.end(answers);
    });
    const media = async () => JSON.parse(await readFile(input, 'utf8')).posts[0].media;
    const preview = await run(['--dry-run']);
    assert.equal(preview.code, 0);
    assert.doesNotMatch(preview.log, /开始自动整理/);
    assert.equal(await readFile(input, 'utf8'), original);
    assert.deepEqual(gets, { good: 0, bad: 0 });
    const cancelled = await run([], {}, '1\n');
    assert.equal(cancelled.code, 1);
    assert.match(cancelled.log, /未选择下载数量/);
    assert.equal(await readFile(input, 'utf8'), original);
    assert.deepEqual(gets, { good: 0, bad: 0 });
    const limited = await run([], {}, '1\n2.5\n3\n-1\n\n1\n');
    assert.equal(limited.code, 0, limited.log);
    assert.match(limited.log, /自动整理完成/);
    assert.match(limited.log, /输入无效/);
    assert.match(limited.log, /本次下载 1 个/);
    assert.deepEqual(gets, { good: 1, bad: 0 });
    assert.equal(requests, 1, 'only the selected file should make a GET request');
    assert.doesNotMatch(limited.log, /查询大小/);
    assert.equal((await media())[1].download.status, 'pending');
    const first = await run();
    assert.equal(first.code, 1, first.log);
    assert.match(first.log, /自动整理完成/, 'individual download failures must not prevent organizing completed files');
    let items = await media();
    assert.equal(items[0].download.status, 'downloaded');
    assert.match(path.basename(items[0].download.filename), /^test_无标题_2026-10-22_110908_1_photo\.jpg$/);
    assert.equal(items[1].download.status, 'failed');
    assert.match(items[1].download.error, /503/);
    assert.equal(await readFile(`${input}.before-download.bak`, 'utf8'), original);

    // The source JSON alone can restore checksum validation and failure selection.
    for (const name of await readdir(logs)) {
      if (name.endsWith('.json')) await rm(path.join(logs, name));
    }
    fail = false;
    const retry = await run(['--retry-failed']);
    assert.equal(retry.code, 0, retry.log);
    assert.equal(gets.good, 1);
    assert.equal(gets.bad, 4);
    items = await media();
    assert.equal(items[1].download.status, 'downloaded');
    assert.equal(items[1].download.error, undefined);
    const repeat = await run();
    assert.equal(repeat.code, 0, repeat.log);
    assert.match(repeat.log, /已验证跳过 2 个/);
    assert.deepEqual(gets, { good: 1, bad: 4 });

    await writeFile(path.join(output, items[0].download.filename), 'corrupt-good');
    await rm(path.join(output, items[1].download.filename));
    const repaired = await run();
    assert.equal(repaired.code, 0, repaired.log);
    assert.deepEqual(gets, { good: 2, bad: 5 });
    assert.equal(JSON.parse(await readFile(input, 'utf8')).collection, 'fixture');
    assert.equal(await readFile(`${input}.before-download.bak`, 'utf8'), original);

    // A fresh export has no markers, a different input name, and different generated
    // filenames. Only historical reports remain to identify the original files.
    await rm(path.join(logs, 'download-state.json'));
    const freshInput = path.join(root, 'fresh-export.json');
    const freshData = JSON.parse(original);
    freshData.posts[0].author.name = 'renamed-author';
    freshData.posts[0].media.reverse();
    await writeFile(freshInput, JSON.stringify(freshData));
    await writeFile(path.join(logs, 'download-report_broken.json'), '{');
    const beforeRequests = requests;
    const fresh = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, freshInput], {
        env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NODE_USE_ENV_PROXY: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let log = '';
      child.stdout.on('data', chunk => { log += chunk; });
      child.stderr.on('data', chunk => { log += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, log }));
      child.stdin.end('1\n0\n');
    });
    assert.equal(fresh.code, 0, fresh.log);
    assert.match(fresh.log, /已验证跳过 2 个/);
    assert.equal(requests, beforeRequests, 'history matches must not send HEAD or GET');
    const freshItems = JSON.parse(await readFile(freshInput, 'utf8')).posts[0].media;
    assert.equal(freshItems[0].download.filename, items[1].download.filename);
    assert.equal(freshItems[1].download.filename, items[0].download.filename);
    assert.equal(freshItems[0].download.status, 'downloaded');
    assert.equal((await readdir(path.join(output, 'photo'))).filter(name => name.endsWith('.jpg')).length, 2);
    assert.deepEqual((await readdir(output)).sort(), ['photo', 'log', 'video'].sort());

    // Locked source must not stop workers; a checkpoint restores failure markers.
    await writeFile(input, original);
    await rm(path.join(output, items[1].download.filename));
    fail = true;
    const locked = await run([], { TEST_LOCK_INPUT: '1' });
    assert.equal(locked.code, 1, locked.log); // The HTTP failure, not a program crash.
    assert.match(locked.log, /下载完成/);
    assert.match(locked.log, /状态已保存在/);
    assert.doesNotMatch(locked.log, /程序失败/);
    assert.equal(await readFile(input, 'utf8'), original);
    const goodBefore = gets.good;
    const badBefore = gets.bad;
    fail = false;
    const resumed = await run(['--retry-failed']);
    assert.equal(resumed.code, 0, resumed.log);
    assert.equal(gets.good, goodBefore);
    assert.equal(gets.bad, badBefore + 1);
    assert.equal((await media())[1].download.status, 'downloaded');

    // A moved file must be found in numbered folders without HEAD/GET requests.
    const beforeGrouped = requests;
    for (const item of await media()) {
      const grouped = path.join('photo', '1', path.basename(item.download.filename));
      await mkdir(path.join(output, 'photo', '1'), { recursive: true });
      await rename(path.join(output, item.download.filename), path.join(output, grouped));
    }
    const groupedRun = await run();
    assert.equal(groupedRun.code, 0, groupedRun.log);
    assert.equal(requests, beforeGrouped);
    for (const item of await media()) assert.equal(path.dirname(item.download.filename), path.join('photo', '1'));

    // Legacy root-level reports and files still prevent duplicate downloads.
    const legacyItems = await media();
    const legacyResults = [];
    for (const [index, item] of legacyItems.entries()) {
      const filename = path.basename(item.download.filename);
      await rename(path.join(output, item.download.filename), path.join(output, filename));
      legacyResults.push({ ...item.download, filename, type: 'photo', postId: '1', mediaIndex: index + 1,
        status: 'success' });
    }
    await writeFile(path.join(output, 'download-report.json'), JSON.stringify({ input, results: legacyResults }));
    await writeFile(input, original);
    const beforeLegacy = requests;
    const legacy = await run();
    assert.equal(legacy.code, 0, legacy.log);
    assert.match(legacy.log, /已验证跳过 2 个/);
    assert.equal(requests, beforeLegacy);

    await writeFile(input, JSON.stringify({ posts: [{ id: '2', media: [{
      type: 'video', videoUrl: `${url}/video.mp4`,
    }] }] }));
    const video = await run([], {}, '2\n0\n');
    assert.equal(video.code, 0, video.log);
    const videoItem = (await media())[0];
    assert.equal(path.dirname(videoItem.download.filename), 'video');
    assert.equal((await readdir(path.join(output, 'video'))).length, 1);
    assert.equal((await readFile(path.join(output, videoItem.download.filename), 'utf8')), 'fixture-bad');
    assert.equal(headRequests, 0, 'size must come from GET headers, never a separate HEAD request');
    await rename(path.join(root, 'organize-media.mjs'), path.join(root, 'organize-media.disabled'));
    const failedOrganize = await run([], {}, '2\n');
    assert.equal(failedOrganize.code, 1);
    assert.match(failedOrganize.log, /自动整理失败/);
    assert.match(failedOrganize.log, /完整报告/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic save retries Windows locks, preserves the target, and cleans temporary files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xdownload-save-test-'));
  const target = path.join(root, 'state.json');
  try {
    await writeFile(target, '{"old":true}');
    const { rename } = await import('node:fs/promises');
    let attempts = 0;
    await writeJsonAtomic(target, { saved: true }, {
      rename: async (...args) => {
        if (++attempts < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
        await rename(...args);
      }, delay: async () => {},
    });
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { saved: true });
    await assert.rejects(writeJsonAtomic(target, { saved: false }, {
      rename: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
      delay: async () => {},
    }), { code: 'EPERM' });
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { saved: true });
    assert.deepEqual(await readdir(root), ['state.json']);
    const enqueue = createSaveQueue();
    await assert.rejects(enqueue(async () => { throw new Error('first save failed'); }));
    assert.equal(await enqueue(async () => 'recovered'), 'recovered');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
