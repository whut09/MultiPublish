import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {PersistentJsonStore} from './persistent-store.ts';

const empty = {accounts: [], drafts: []};
const parse = value => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.accounts) || !Array.isArray(value.drafts)) {
    throw new Error('invalid fixture');
  }
  return value;
};

const makeStore = directory => new PersistentJsonStore({directory, fileName: 'data.json', empty, parse});

test('keeps the previous valid snapshot when the primary file is corrupted', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'multipublish-store-'));
  const store = makeStore(directory);
  await store.load();
  await store.update(data => data.accounts.push('first'));
  await store.update(data => data.accounts.push('second'));
  await fs.writeFile(path.join(directory, 'data.json'), '{"accounts":[', 'utf8');
  const recovered = makeStore(directory);
  const status = await recovered.load();
  assert.equal(status.source, 'backup');
  assert.deepEqual(recovered.get(), {accounts: ['first'], drafts: []});
  const quarantined = (await fs.readdir(directory)).filter(name => name.includes('.corrupt-'));
  assert.equal(quarantined.length, 1);
});

test('recovers a fully written temporary file when the primary is missing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'multipublish-store-'));
  await fs.writeFile(path.join(directory, 'data.json.tmp'), JSON.stringify({accounts: ['temporary'], drafts: []}), 'utf8');
  const store = makeStore(directory);
  const status = await store.load();
  assert.equal(status.source, 'temporary');
  assert.deepEqual(store.get(), {accounts: ['temporary'], drafts: []});
  assert.equal(await fs.readFile(path.join(directory, 'data.json'), 'utf8').then(value => value.includes('temporary')), true);
});

test('serializes concurrent updates without losing changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'multipublish-store-'));
  const store = makeStore(directory);
  await store.load();
  await Promise.all(Array.from({length: 20}, (_, index) => store.update(data => data.accounts.push(String(index)))));
  assert.equal(store.get().accounts.length, 20);
});

test('does not retain mutations from a failed update callback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'multipublish-store-'));
  const store = makeStore(directory);
  await store.load();
  await assert.rejects(() => store.update(data => {
    data.accounts.push('should-not-persist');
    throw new Error('intentional failure');
  }));
  assert.deepEqual(store.get(), empty);
});
