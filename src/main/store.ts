import {app} from 'electron';
import {PersistentJsonStore} from './persistent-store';
import type {Account, AppData, PublishDraft, PublishTask} from '../shared/types';

const empty: AppData = {accounts: [], drafts: [], tasks: []};
const platforms = new Set(['douyin', 'kuaishou', 'xiaohongshu', 'toutiao', 'weixin', 'bilibili', 'qqmedia']);
const statuses = new Set(['checking', 'logged_in', 'logged_out']);
const taskStatuses = new Set(['pending', 'opening', 'uploading', 'publishing', 'manual_required', 'success', 'failed']);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isString = (value: unknown): value is string => typeof value === 'string';
const records = (value: unknown, name: string) => {
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) throw new Error(`${name}数据结构无效`);
  return value as Record<string, unknown>[];
};

function parseAppData(value: unknown): AppData {
  if (!isRecord(value) || !Array.isArray(value.accounts) || !Array.isArray(value.drafts) || !Array.isArray(value.tasks)) {
    throw new Error('应用数据结构无效');
  }
  const accounts = records(value.accounts, '账号').map(account => {
    if (!isString(account.id) || !platforms.has(String(account.platform)) || !isString(account.name)) throw new Error('账号记录无效');
    return ({
    ...account,
    id: account.id as string,
    platform: account.platform as Account['platform'],
    name: account.name as string,
    createdAt: isString(account.createdAt) ? account.createdAt : new Date(0).toISOString(),
    loginStatus: statuses.has(String(account.loginStatus)) ? account.loginStatus as Account['loginStatus'] : 'checking',
    });
  }) as Account[];
  const drafts = records(value.drafts, '草稿').map(draft => {
    if (!isString(draft.id) || (draft.type !== 'video' && draft.type !== 'image_text') || !isString(draft.title) || !Array.isArray(draft.mediaPaths) || !Array.isArray(draft.accountIds)) throw new Error('草稿记录无效');
    const mediaPaths = draft.mediaPaths as unknown[];
    const accountIds = draft.accountIds as unknown[];
    return ({
    ...draft,
    id: draft.id as string,
    type: draft.type as PublishDraft['type'],
    title: draft.title as string,
    description: isString(draft.description) ? draft.description : '',
    topics: Array.isArray(draft.topics) ? draft.topics.filter(isString) : [],
    mediaPaths: mediaPaths.filter(isString),
    accountIds: accountIds.filter(isString),
    createdAt: isString(draft.createdAt) ? draft.createdAt : new Date(0).toISOString(),
    });
  }) as PublishDraft[];
  const tasks = records(value.tasks, '任务').map(task => {
    if (!isString(task.id) || !isString(task.draftId) || !isString(task.accountId) || !platforms.has(String(task.platform)) || !isString(task.title)) throw new Error('任务记录无效');
    return ({
    ...task,
    id: task.id as string,
    draftId: task.draftId as string,
    accountId: task.accountId as string,
    platform: task.platform as Account['platform'],
    title: task.title as string,
    status: taskStatuses.has(String(task.status)) ? task.status as PublishTask['status'] : 'pending',
    message: isString(task.message) ? task.message : '',
    createdAt: isString(task.createdAt) ? task.createdAt : new Date(0).toISOString(),
    updatedAt: isString(task.updatedAt) ? task.updatedAt : new Date(0).toISOString(),
    });
  }) as PublishTask[];
  return {accounts, drafts, tasks};
}

export class JsonStore extends PersistentJsonStore<AppData> {
  constructor() {
    super({directory: app.getPath('userData'), fileName: 'multipublish-data.json', empty, parse: parseAppData});
  }
}
