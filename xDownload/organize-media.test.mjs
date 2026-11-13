import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('sorts into groups of 100, preserves data, previews, and rebalances new files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-organize-test-'));
  try {
    const script = path.join(root, 'organize-media.mjs');
    await writeFile(script, await readFile(new URL('./organize-media.mjs', import.meta.url)));
    const photo = path.join(root, 'XD', 'photo');
    const video = path.join(root, 'XD', 'video');
    await Promise.all([photo, video].map(dir => mkdir(dir, { recursive: true })));
    function filename(index, type) {
      const time = new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString();
      return `author_title_${time.slice(0, 10)}_${time.slice(11, 19).replaceAll(':', '')}_1_${type}.${type === 'photo' ? 'jpg' : 'mp4'}`;
    }
    await Promise.all(Array.from({ length: 201 }, (_, index) => writeFile(path.join(photo, filename(index, 'photo')), `photo-${index}`)));
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(path.join(video, filename(index, 'video')), `video-${index}`)));
    // Explicit write times make ordering deterministic even with parallel fixture creation.
    for (let index = 0; index < 201; index++) await utimes(path.join(photo, filename(index, 'photo')), 1000 + index, 1000 + index);
    await writeFile(path.join(photo, 'active.jpg.part'), 'unfinished');
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: path.join(root, 'XD'), encoding: 'utf8' });
    assert.equal(run('--dry-run').status, 0);
    assert.equal((await readdir(photo)).length, 202);
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    for (const [group, count] of [['1', 100], ['2', 100], ['3', 1]]) assert.equal((await readdir(path.join(photo, group))).length, count);
    for (let index = 0; index < 201; index++) {
      const group = String(Math.floor(index / 100) + 1);
      assert.equal(await readFile(path.join(photo, group, filename(index, 'photo')), 'utf8'), `photo-${index}`);
    }
    assert.equal((await readdir(video)).length, 100, 'exactly 100 files must remain ungrouped');
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /需移动 0 个/);
    const earlier = 'author_title_2026-01-01_000000_1_photo.jpg';
    await writeFile(path.join(photo, earlier), 'earlier');
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(photo, '3', earlier), 'utf8'), 'earlier');
    assert.equal((await readdir(path.join(photo, '3'))).length, 2);
    assert.equal(await readFile(path.join(photo, 'active.jpg.part'), 'utf8'), 'unfinished');
    // Duplicate names are rejected before any files are moved.
    await writeFile(path.join(photo, earlier), 'duplicate');
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /同名文件/);
    assert.equal(await readFile(path.join(photo, earlier), 'utf8'), 'duplicate');
  } finally {
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('media-organize-test-')) await rm(root, { recursive: true, force: true });
  }
});
