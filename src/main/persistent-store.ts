import {promises as fs} from 'node:fs';
import path from 'node:path';

export interface StoreRecovery {
  recovered: boolean;
  source: 'primary'|'backup'|'temporary'|'empty';
  warning?: string;
}

interface PersistentStoreOptions<T> {
  directory: string;
  fileName: string;
  empty: T;
  parse: (value: unknown) => T;
}

const exists = async (file: string) => fs.access(file).then(() => true).catch(() => false);

export class PersistentJsonStore<T> {
  private readonly options: PersistentStoreOptions<T>;
  private readonly file: string;
  private readonly backupFile: string;
  private readonly temporaryFile: string;
  private data: T;
  private updateQueue: Promise<void> = Promise.resolve();
  private recovery: StoreRecovery = {recovered: false, source: 'empty'};

  constructor(options: PersistentStoreOptions<T>) {
    this.options = options;
    this.file = path.join(options.directory, options.fileName);
    this.backupFile = this.file + '.bak';
    this.temporaryFile = this.file + '.tmp';
    this.data = structuredClone(options.empty);
  }

  async load() {
    await fs.mkdir(this.options.directory, {recursive: true});
    const candidates: Array<{file: string; source: StoreRecovery['source']}> = [
      {file: this.file, source: 'primary'},
      {file: this.backupFile, source: 'backup'},
      {file: this.temporaryFile, source: 'temporary'},
    ];
    let firstError = '';
    for (const candidate of candidates) {
      if (!await exists(candidate.file)) continue;
      try {
        const parsed = this.options.parse(JSON.parse(await fs.readFile(candidate.file, 'utf8')));
        this.data = parsed;
        this.recovery = {
          recovered: candidate.source !== 'primary',
          source: candidate.source,
          warning: candidate.source === 'primary' ? undefined : `已从${candidate.source === 'backup' ? '备份文件' : '临时文件'}恢复数据`,
        };
        if (candidate.source !== 'primary') await this.save();
        else await fs.rm(this.temporaryFile, {force: true});
        return this.recovery;
      } catch (error) {
        firstError ||= `${candidate.file}: ${error instanceof Error ? error.message : String(error)}`;
        await this.quarantine(candidate.file);
      }
    }
    const primaryExists = await exists(this.file);
    if (primaryExists) await this.quarantine(this.file);
    const backupExists = await exists(this.backupFile);
    if (backupExists) await this.quarantine(this.backupFile);
    const temporaryExists = await exists(this.temporaryFile);
    if (temporaryExists) await this.quarantine(this.temporaryFile);
    this.data = structuredClone(this.options.empty);
    this.recovery = {
      recovered: false,
      source: 'empty',
      warning: firstError ? `数据文件无法读取，已保留损坏文件：${firstError}` : undefined,
    };
    await this.save();
    return this.recovery;
  }

  getRecovery() {
    return {...this.recovery};
  }

  get() {
    return structuredClone(this.data);
  }

  async update(fn: (data: T) => void) {
    let snapshot: T | undefined;
    const operation = this.updateQueue.then(async () => {
      const next = structuredClone(this.data);
      fn(next);
      this.options.parse(next);
      this.data = next;
      await this.save();
      snapshot = this.get();
    });
    this.updateQueue = operation.catch(() => undefined);
    await operation;
    return snapshot as T;
  }

  private async quarantine(file: string) {
    const target = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, target).catch(async () => {
      await fs.copyFile(file, target).catch(() => undefined);
      await fs.rm(file, {force: true}).catch(() => undefined);
    });
  }

  private async save() {
    await fs.mkdir(this.options.directory, {recursive: true});
    const content = JSON.stringify(this.data, null, 2);
    const handle = await fs.open(this.temporaryFile, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await exists(this.file)) {
      await fs.copyFile(this.file, this.backupFile);
    }
    await fs.rm(this.file, {force: true});
    await fs.rename(this.temporaryFile, this.file);
  }
}
