/**
 * 编排台的数据层：一个 JSON 文件、串行原子写、惰性加载。
 *
 *   <DSH_HOME>/orchestra/orchestra.json
 *
 * 画布、任务、知识库、设置都在一份文件里；会话正文永远留在 DSH 会话日志，
 * 这里只存「哪条会话扮演哪个节点」以及任务书、验收标准这类编排元数据。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeBoard } from './boards.js';

export const SCHEMA_VERSION = 1;
const FILE_NAME = 'orchestra.json';

let cache = null;
let loading = null;
let writeChain = Promise.resolve();

export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return fromEnv === '' ? join(homedir(), '.dsh') : fromEnv;
}

export function dataDir() {
  return join(dshHome(), 'orchestra');
}

export function dataFile() {
  return join(dataDir(), FILE_NAME);
}

/** 内置知识库：一级是最硬的禁忌，每个严格对话都会带上；其余等级按项目/任务勾选。 */
export function seedKb() {
  return [
    {
      id: 'kb-l1-1',
      level: 1,
      title: '不捏造、不虚报',
      text: '不得虚构事实、伪造执行结果或声称做了没有做的事。没做、没验证、做不到，就明确写出来。',
      tags: ['诚实', '结果'],
      locked: true,
      enabled: true,
      createdAt: 0,
    },
    {
      id: 'kb-l1-2',
      level: 1,
      title: '不擅自破坏',
      text: '不得删除、覆盖、重写用户未明确授权的文件或数据；任何不可逆操作必须先说明风险并等待确认。',
      tags: ['安全', '文件'],
      locked: true,
      enabled: true,
      createdAt: 0,
    },
    {
      id: 'kb-l1-3',
      level: 1,
      title: '不泄露秘密',
      text: '不得把密钥、令牌、密码、个人隐私或未公开的商业数据写进输出、提交到仓库或发送给外部服务。',
      tags: ['安全', '隐私'],
      locked: true,
      enabled: true,
      createdAt: 0,
    },
    {
      id: 'kb-l1-4',
      level: 1,
      title: '不绕过验收',
      text: '不得为了通过验收而删改验收标准、伪造证据或跳过检查。无法通过时如实报告阻塞点与已完成部分。',
      tags: ['验收', '诚实'],
      locked: true,
      enabled: true,
      createdAt: 0,
    },
    {
      id: 'kb-l2-1',
      level: 2,
      title: '只改边界内',
      text: '只修改任务边界里点名的文件与范围；需要越界时先停下来，把越界原因写进结果报告，交给总对话决定。',
      tags: ['边界'],
      locked: false,
      enabled: true,
      createdAt: 0,
    },
    {
      id: 'kb-l2-2',
      level: 2,
      title: '先读后改',
      text: '改动任何既有文件前先完整读一遍相关段落，沿用项目已有的写法与约定，不做顺手重构。',
      tags: ['工程'],
      locked: false,
      enabled: true,
      createdAt: 0,
    },
  ];
}

export function defaultState() {
  return {
    version: SCHEMA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: {
      injectLevel1Globally: true,
      // 默认不主动唤醒总对话：用户选择了「我点派发才开工、验收也要我点」的节奏。
      notifyMasterOnChildDone: false,
      // 子任务通过后，归档它的子会话，并从画布活跃区收起来。
      autoArchiveChild: true,
      // pass = 验收通过时归档；finished = 子对话一跑完就归档。
      archiveOn: 'pass',
      defaultCwd: '',
    },
    bridge: {
      currentSessionId: '',
      currentSessionTitle: '',
      at: 0,
    },
    kb: seedKb(),
    boards: [],
  };
}

function clone(value) {
  return structuredClone(value);
}

/** 把旧文件补齐成当前形状；未知字段保留，缺失字段补默认值。 */
export function normalizeState(raw) {
  const base = defaultState();
  if (raw === null || typeof raw !== 'object') return base;
  const state = {
    ...base,
    ...raw,
    version: SCHEMA_VERSION,
    settings: { ...base.settings, ...(raw.settings ?? {}) },
    bridge: { ...base.bridge, ...(raw.bridge ?? {}) },
    kb: Array.isArray(raw.kb) ? raw.kb : base.kb,
    boards: Array.isArray(raw.boards) ? raw.boards.map((board) => normalizeBoard(board)) : [],
  };
  state.kb = state.kb
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `kb-${randomUUID()}`,
      level: clampInt(entry.level, 1, 4, 1),
      title: asText(entry.title, 80),
      text: asText(entry.text, 4000),
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string').slice(0, 8) : [],
      locked: entry.locked === true,
      enabled: entry.enabled !== false,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
    }))
    .filter((entry) => entry.text !== '');
  return state;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function asText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > max ? text.slice(0, max) : text;
}

export async function loadState() {
  if (cache !== null) return cache;
  if (loading !== null) return loading;
  loading = (async () => {
    try {
      const raw = await readFile(dataFile(), 'utf8');
      cache = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        process.stderr.write(`[orchestra] 读取 ${dataFile()} 失败，使用空数据：${error instanceof Error ? error.message : String(error)}\n`);
      }
      cache = defaultState();
      await persist(cache);
    }
    return cache;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function persist(state) {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const target = dataFile();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(temp, body, 'utf8');
  await rename(temp, target);
}

/** 读一份可变副本（调用方随便改，不会污染缓存）。 */
export async function snapshot() {
  return clone(await loadState());
}

/**
 * 串行读改写：fn(state) 可以直接修改并返回新 state；抛错则不落盘。
 * 返回落盘后的可变副本。
 */
export function mutate(fn) {
  const run = writeChain.then(async () => {
    const state = clone(await loadState());
    const result = await fn(state);
    const next = result === undefined ? state : result;
    next.version = SCHEMA_VERSION;
    next.updatedAt = Date.now();
    cache = next;
    await persist(next);
    return clone(next);
  });
  // 一次失败不能堵死后续所有写入。
  writeChain = run.catch(() => undefined);
  return run;
}

/** 测试用：清掉进程内缓存，下次从磁盘重新读。 */
export function resetCache() {
  cache = null;
  loading = null;
  writeChain = Promise.resolve();
}
