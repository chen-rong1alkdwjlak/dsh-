/**
 * 编排台（dsh-orchestra）—— 宿主半区。
 *
 *   ① /orchestra/api：画布、任务、知识库、计划/派发/验收的 JSON 接口；
 *   ② 会话桥：用 ctx.sessionController 创建「子对话」并送任务书，用 session/event 跟踪回合；
 *   ③ 面向总对话的两个工具：orchestra_board / orchestra_dispatch；
 *   ④ 一级禁忌注入：把知识库 1 级条目写进每个会话的系统提示（可关）。
 *
 * 数据：<DSH_HOME>/orchestra/orchestra.json。会话正文不复制，仍归 DSH 会话日志。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadState, mutate, snapshot, defaultState, dataDir, dataFile } from './lib/store.js';
import { LEVELS, addKbEntry, updateKbEntry, removeKbEntry, resolveKb, renderLevel1Global, kbStats } from './lib/kb.js';
import { composePlanPrompt, composeTaskBrief, composeVerifyPrompt, composeFollowupPrompt, composeCompletionNotice, parsePlan, parseResult, parseVerdict } from './lib/brief.js';
import { createBoard, sanitizeGraph, applyPlan, dependenciesOf, isRunnable, boardSummary, statusMeta, newTaskNode } from './lib/boards.js';
import { SessionBridge, eventsToMessages, assistantTextBetween } from './lib/sessions.js';

const PACKAGE = 'dsh-orchestra';
const API_PREFIX = '/orchestra/api';
const PAGE_PREFIX = '/orchestra';

const JOBS = new Map();
let bridge = null;
// 先用内置一级禁忌垫底：首帧的系统提示不会因为磁盘还没读完而漏掉禁忌。
let latestKb = defaultState().kb;
let latestSettings = { injectLevel1Globally: true };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asText(value, max = 4000) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function nowIso() {
  return new Date().toISOString();
}

function touch(board) {
  board.updatedAt = Date.now();
}

function findBoard(state, boardId) {
  const board = state.boards.find((candidate) => candidate.id === boardId);
  if (board === undefined) throw new HttpError(404, '编排板不存在');
  return board;
}

function findTask(board, taskId) {
  const task = board.nodes.find((node) => node.id === taskId && node.type === 'task');
  if (task === undefined) throw new HttpError(404, '任务节点不存在');
  return task;
}

function masterOf(board) {
  const master = board.nodes.find((node) => node.type === 'master');
  if (master === undefined) throw new HttpError(400, '编排板没有总对话节点');
  return master;
}

function requireMasterSession(board) {
  const sessionId = board.masterSessionId || masterOf(board).sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new HttpError(400, '还没有绑定总对话：先在画布上选中总对话节点，绑定一个 DSH 会话');
  }
  return sessionId;
}

function syncKbCache(state) {
  latestKb = state.kb;
  latestSettings = state.settings;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function pruneJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of JOBS) {
    if (job.createdAt < cutoff) JOBS.delete(id);
  }
  if (JOBS.size > 40) {
    const sorted = [...JOBS.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt);
    for (const [id] of sorted.slice(0, JOBS.size - 40)) JOBS.delete(id);
  }
}

function newJob(type, boardId, taskId = '') {
  pruneJobs();
  const job = { id: `job-${randomUUID().slice(0, 8)}`, type, boardId, taskId, status: 'running', createdAt: Date.now(), result: null, error: '', warnings: [] };
  JOBS.set(job.id, job);
  return job;
}

/* ────────────────────────────── 计划 / 派发 / 验收 ───────────────────────────── */

function resolveMasterKb(state, board) {
  return resolveKb(board, { id: '__master__', type: 'task', kbLevels: [1, 2], kbIds: [] }, state.kb);
}

function startPlanJob(boardId, hint) {
  const job = newJob('plan', boardId);
  void (async () => {
    try {
      const state = await snapshot();
      const board = findBoard(state, boardId);
      const sessionId = requireMasterSession(board);
      const prompt = composePlanPrompt({ board, kb: state.kb, resolved: resolveMasterKb(state, board), hint });
      const turn = await bridge.promptAndWait(sessionId, prompt, { timeoutMs: 240000 });
      const plan = parsePlan(turn.text);
      job.plan = plan;
      job.text = turn.text;
      const created = await mutate((draft) => {
        const target = findBoard(draft, boardId);
        const nodes = applyPlan(target, plan.tasks);
        touch(target);
        job.createdTaskIds = nodes.map((node) => node.id);
      });
      job.status = 'done';
      job.boardUpdatedAt = created.updatedAt;
      job.warnings = plan.warnings;
    } catch (error) {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
    }
  })();
  return job;
}

function startVerifyJob(boardId, taskId) {
  const job = newJob('verify', boardId, taskId);
  void (async () => {
    try {
      const state = await snapshot();
      const board = findBoard(state, boardId);
      const task = findTask(board, taskId);
      if (task.result === null) throw new Error('任务还没有结果，无法复核');
      const sessionId = requireMasterSession(board);
      const prompt = composeVerifyPrompt({ board, task, kb: state.kb });
      const turn = await bridge.promptAndWait(sessionId, prompt, { timeoutMs: 240000 });
      const verdict = parseVerdict(turn.text);
      await mutate((draft) => {
        const targetBoard = findBoard(draft, boardId);
        const targetTask = findTask(targetBoard, taskId);
        targetTask.verdict = { ...verdict, at: Date.now() };
        touch(targetBoard);
      });
      job.status = 'done';
      job.verdict = verdict;
    } catch (error) {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
    }
  })();
  return job;
}

async function dispatchTask(boardId, taskId, { force = false } = {}) {
  const state = await snapshot();
  const board = findBoard(state, boardId);
  const task = findTask(board, taskId);
  if (task.status === 'running' || task.status === 'dispatching') throw new HttpError(409, '这个任务已经在运行');
  const deps = dependenciesOf(board, task);
  if (!force) {
    const blocked = deps.filter((dep) => dep.status !== 'passed');
    if (blocked.length > 0) {
      throw new HttpError(409, `前置任务还没通过：${blocked.map((dep) => dep.title).join('、')}`);
    }
  }
  if (task.goal.trim() === '' && task.title.trim() === '') throw new HttpError(400, '任务缺少标题/目标');
  const masterSessionId = requireMasterSession(board);

  // 先把状态落盘，再发消息；这样 turn/end 到达时一定能找到对应任务。
  const childSessionId = await bridge.createChild({ cwd: board.cwd });
  await mutate((draft) => {
    const targetBoard = findBoard(draft, boardId);
    const targetTask = findTask(targetBoard, taskId);
    targetTask.status = 'dispatching';
    targetTask.childSessionId = childSessionId;
    targetTask.childTitle = `${targetTask.title} · 子对话`;
    targetTask.error = '';
    targetTask.result = null;
    targetTask.verdict = null;
    targetTask.dispatchedAt = Date.now();
    targetTask.finishedAt = 0;
    targetTask.archivedAt = 0;
    touch(targetBoard);
  });

  const brief = composeTaskBrief({
    board,
    task,
    kb: state.kb,
    predecessors: deps.map((dep) => ({ title: dep.title, result: dep.result })),
    roundNote: task.roundNote ?? '',
  });
  try {
    const requestId = await bridge.prompt(childSessionId, brief);
    await mutate((draft) => {
      const targetBoard = findBoard(draft, boardId);
      const targetTask = findTask(targetBoard, taskId);
      // 极快的子对话可能在 prompt 返回前就结束了；不要把它从 review 拉回 running。
      if (targetTask.status === 'dispatching') {
        targetTask.status = 'running';
        targetTask.dispatchRequestId = requestId;
      }
      touch(targetBoard);
    });
    return { boardId, taskId, childSessionId, masterSessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutate((draft) => {
      const targetBoard = findBoard(draft, boardId);
      const targetTask = findTask(targetBoard, taskId);
      targetTask.status = 'error';
      targetTask.error = message;
      touch(targetBoard);
    });
    throw new HttpError(500, `子对话创建了，但任务书没有送达：${message}`);
  }
}

/** 通过或撤销 DSH 工作区归档；会话不在时抛错，由调用方转成可读提示。 */
async function setChildArchived(sessionId, archived, { force = false } = {}) {
  const registry = bridge?.ctx?.get('workspaceRegistry');
  if (registry === undefined || typeof registry.archiveSession !== 'function') {
    throw new Error('当前部署没有挂载工作区归档服务');
  }
  if (archived) await registry.archiveSession(sessionId, force ? { stopActivity: true } : undefined);
  else await registry.unarchiveSession(sessionId);
}

async function acceptTask(boardId, taskId, { pass, note = '' }) {
  const state = await snapshot();
  const board = findBoard(state, boardId);
  const task = findTask(board, taskId);
  if (pass === true) {
    let archived = false;
    let archiveError = '';
    if (state.settings.autoArchiveChild !== false && state.settings.archiveOn !== 'finished' && task.childSessionId !== '') {
      try {
        await setChildArchived(task.childSessionId, true);
        archived = true;
      } catch (error) {
        archiveError = error instanceof Error ? error.message : String(error);
      }
    }
    await mutate((draft) => {
      const targetBoard = findBoard(draft, boardId);
      const targetTask = findTask(targetBoard, taskId);
      targetTask.status = 'passed';
      targetTask.acceptedAt = Date.now();
      targetTask.roundNote = '';
      if (archived) targetTask.archivedAt = Date.now();
      touch(targetBoard);
    });
    return { taskId, status: 'passed', archived, archiveError };
  }

  const roundNote = asText(note, 2000) || task.verdict?.followup || '请按验收标准重新检查未通过的部分，只修改问题范围。';
  if (task.childSessionId === '') {
    await mutate((draft) => {
      const targetBoard = findBoard(draft, boardId);
      const targetTask = findTask(targetBoard, taskId);
      targetTask.status = 'draft';
      targetTask.roundNote = roundNote;
      touch(targetBoard);
    });
    return { taskId, status: 'draft', note: roundNote };
  }

  const followup = composeFollowupPrompt({ task, note: roundNote });
  try {
    await bridge.prompt(task.childSessionId, followup);
  } catch (error) {
    throw new HttpError(500, `打回消息没有送达子对话：${error instanceof Error ? error.message : String(error)}`);
  }
  await mutate((draft) => {
    const targetBoard = findBoard(draft, boardId);
    const targetTask = findTask(targetBoard, taskId);
    targetTask.rounds.push({ at: Date.now(), note: roundNote, result: targetTask.result });
    targetTask.status = 'running';
    targetTask.result = null;
    targetTask.verdict = null;
    targetTask.dispatchedAt = Date.now();
    targetTask.finishedAt = 0;
    touch(targetBoard);
  });
  return { taskId, status: 'running', note: roundNote };
}

function errorTextOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';
  const parts = [value.name, value.code, value.message].filter((part) => typeof part === 'string' && part.trim() !== '');
  return parts.join(': ');
}

/** turn/end 的 reason 是否表示失败；失败时返回一段可读原因。 */
function turnFailure(reason) {
  if (reason === null || typeof reason !== 'object') return '';
  if (reason.kind === 'error') return errorTextOf(reason.error) || '本轮执行失败';
  if (reason.kind === 'cancelled' || reason.kind === 'canceled' || reason.kind === 'aborted') return '本轮被取消或中断';
  return '';
}

/** 子对话一轮结束：收结果、进「待验收」，可选通知总对话。 */
async function onChildTurnEnd(sessionId) {
  const state = await snapshot();
  const found = [];
  for (const board of state.boards) {
    for (const task of board.nodes) {
      if (task.type === 'task' && task.childSessionId === sessionId && (task.status === 'running' || task.status === 'dispatching')) {
        found.push({ boardId: board.id, taskId: task.id, board });
      }
    }
  }
  if (found.length === 0) return;
  let inspected = null;
  try {
    inspected = await bridge.inspect(sessionId);
  } catch (error) {
    await mutate((draft) => {
      for (const item of found) {
        const board = findBoard(draft, item.boardId);
        const task = findTask(board, item.taskId);
        if (task.status !== 'running' && task.status !== 'dispatching') continue;
        task.status = 'error';
        task.error = `读取子对话结果失败：${error instanceof Error ? error.message : String(error)}`;
        task.finishedAt = Date.now();
        touch(board);
      }
    });
    return;
  }
  const events = inspected?.events ?? [];
  const lastUserSeq = [...events].reverse().find((event) => event.type === 'user/message')?.seq ?? -1;
  const endEvent = [...events].reverse().find((event) => event.type === 'turn/end');
  const text = assistantTextBetween(events, lastUserSeq, endEvent?.seq);
  const failure = turnFailure(endEvent?.data?.reason);
  const result = failure === ''
    ? parseResult(text, { fallbackSummary: text })
    : { status: 'failed', summary: failure, artifacts: [], checks: [], raw: text, parsed: false };
  result.at = Date.now();

  const archiveFinished = failure === '' && state.settings.autoArchiveChild !== false && state.settings.archiveOn === 'finished';
  const archivedTaskIds = new Set();
  if (archiveFinished) {
    for (const item of found) {
      const task = item.board.nodes.find((node) => node.id === item.taskId);
      if (task === undefined || task.childSessionId === '') continue;
      try {
        // 刚收到 turn/end 时 Agent 可能还没完全 idle；完成即归档允许顺带停掉残留活动。
        await setChildArchived(task.childSessionId, true, { force: true });
        archivedTaskIds.add(task.id);
      } catch (error) {
        ctxError(`完成即归档失败（${task.title}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  let notifyBoard = null;
  let notifyTask = null;
  await mutate((draft) => {
    for (const item of found) {
      const board = findBoard(draft, item.boardId);
      const task = findTask(board, item.taskId);
      if (task.status !== 'running' && task.status !== 'dispatching') continue;
      task.status = failure === '' ? 'review' : 'error';
      task.finishedAt = Date.now();
      task.result = result;
      task.error = failure;
      if (archivedTaskIds.has(task.id)) task.archivedAt = Date.now();
      touch(board);
      if (failure === '' && draft.settings.notifyMasterOnChildDone === true && (board.masterSessionId ?? '') !== '') {
        notifyBoard = board;
        notifyTask = task;
      }
    }
  });

  if (notifyBoard !== null && notifyTask !== null) {
    const notice = composeCompletionNotice({ board: notifyBoard, task: notifyTask });
    bridge.prompt(notifyBoard.masterSessionId, notice).catch((error) => {
      ctxError(`通知总对话失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

let ctxError = (message) => process.stderr.write(`[orchestra] ${message}\n`);

/* ─────────────────────────────────── 工具 ─────────────────────────────────── */

function registerTools(ctx, disposers) {
  const tools = ctx.get('tools');
  if (tools === undefined) return;

  const boardForAgent = async (agent) => {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('这个工具只能在总对话里使用（没有会话身份）');
    const state = await snapshot();
    const board = state.boards.find((candidate) => candidate.masterSessionId === sessionId);
    if (board === undefined) {
      throw new Error('当前会话还没有绑定为任何编排板的总对话。先在侧栏「编排台」里创建编排板并绑定本会话。');
    }
    return { state, board };
  };

  disposers.push(
    tools.register({
      name: 'orchestra_board',
      description:
        '【编排台】查看当前总对话所属编排板：任务列表、状态、验收标准与依赖。'
        + '只在被绑定为总对话的会话里可用；子对话调用会被拒绝。',
      parameters: { type: 'object', additionalProperties: false, properties: { boardId: { type: 'string', description: '可选：指定编排板 id；默认用当前会话绑定的板。' } } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const lines = [`编排板：${value.board.name}（${value.tasks.length} 个任务）`, value.board.goal ? `目标：${value.board.goal}` : ''];
          for (const task of value.tasks) lines.push(`- [${task.status}] ${task.title}（${task.id}）${task.childSessionId ? ` · 子对话 ${task.childSessionId}` : ''}`);
          return [{ type: 'text', text: lines.filter(Boolean).join('\n') }];
        },
      },
      async execute(args, exec) {
        const state = await snapshot();
        const board = args?.boardId ? findBoard(state, args.boardId) : (await boardForAgent(exec.agent)).board;
        return {
          board: { id: board.id, name: board.name, goal: board.goal, masterSessionId: board.masterSessionId },
          tasks: master.nodes.filter((node) => node.type === 'task').map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            statusLabel: statusMeta(task.status).label,
            acceptance: task.acceptance,
            childSessionId: task.childSessionId,
            dependsOn: dependenciesOf(master, task).map((dep) => dep.title),
          })),
        };
      },
    }),
  );

  disposers.push(
    tools.register({
      name: 'orchestra_dispatch',
      description:
        '【编排台】把一个已存在的任务节点派发给新的隔离子对话。'
        + '只在被绑定为总对话的会话里可用。派发后子对话看不到本对话与其它子对话，只能看到任务书。'
        + '前置任务必须已通过（除非传 force=true）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId'],
        properties: {
          taskId: { type: 'string', description: '任务节点 id，先用 orchestra_board 查。' },
          boardId: { type: 'string', description: '可选：编排板 id。' },
          force: { type: 'boolean', description: '忽略未通过的前置依赖（谨慎）。' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: `已派发：${value.taskId} → 子对话 ${value.childSessionId}` }],
      },
      async execute(args, exec) {
        const resolved = await boardForAgent(exec.agent);
        const board = args?.boardId ? findBoard(resolved.state, args.boardId) : resolved.board;
        const task = findTask(board, args.taskId);
        return dispatchTask(board.id, task.id, { force: args.force === true });
      },
    }),
  );

  disposers.push(
    tools.register({
      name: 'orchestra_accept',
      description:
        '【编排台】通过或驳回一个待验收的子任务。驳回会带着修改要求把任务打回给同一个子对话重做。'
        + '只在被绑定为总对话的会话里可用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'pass'],
        properties: {
          taskId: { type: 'string', description: '任务节点 id。' },
          pass: { type: 'boolean', description: 'true 通过，false 驳回重做。' },
          note: { type: 'string', description: '驳回时给子对话的最小修改要求。' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: value.status === 'passed' ? `已通过 ${value.taskId}` : `已打回 ${value.taskId}，子对话继续运行` }],
      },
      async execute(args, exec) {
        const { state, board } = await boardForAgent(exec.agent);
        findTask(board, args.taskId);
        return acceptTask(board.id, args.taskId, { pass: args.pass === true, note: args.note });
      },
    }),
  );
}

/* ────────────────────────────────── 系统提示 ───────────────────────────────── */

function buildGlobalTabooSection() {
  if (latestSettings.injectLevel1Globally === false) return '';
  return renderLevel1Global(latestKb);
}

/* ─────────────────────────────────── HTTP ─────────────────────────────────── */

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4 * 1024 * 1024) throw new HttpError(413, '请求体太大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendText(res, status, contentType, body) {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function isTrustedHost(header) {
  if (typeof header !== 'string' || header === '') return true;
  const host = header.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

async function handleApi(req, res) {
  try {
    if (!isTrustedHost(req.headers.host)) throw new HttpError(403, '只接受本机访问');
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.slice(API_PREFIX.length) || '/';
    const method = req.method ?? 'GET';
    const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req);
    const result = await route(method, path, url.searchParams, body, req);
    if (result === undefined) throw new HttpError(404, `没有这个接口：${method} ${path}`);
    sendJson(res, result.status ?? 200, result.body);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) ctxError(`API 错误：${message}`);
    sendJson(res, status, { error: { message } });
  }
}

async function route(method, path, query, body, req) {
  const segments = path.split('/').filter(Boolean);

  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    return { body: { name: PACKAGE, dataDir: dataDir(), dataFile: dataFile(), levels: LEVELS, now: nowIso() } };
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'state') {
    const state = await snapshot();
    return {
      body: {
        settings: state.settings,
        bridge: state.bridge,
        kb: state.kb,
        kbStats: kbStats(state.kb),
        levels: LEVELS,
        boards: state.boards.map(boardSummary),
        dataDir: dataDir(),
      },
    };
  }
  if (method === 'POST' && segments.length === 2 && segments[0] === 'bridge' && segments[1] === 'current') {
    const state = await mutate((draft) => {
      draft.bridge = {
        currentSessionId: asText(body.sessionId, 120),
        currentSessionTitle: asText(body.title, 200),
        at: Date.now(),
      };
    });
    return { body: { bridge: state.bridge } };
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'sessions') {
    const limit = Math.max(1, Math.min(100, Number(query.get('limit') ?? 60)));
    return { body: { items: await bridge.listSessions(limit) } };
  }
  if (method === 'PATCH' && segments.length === 1 && segments[0] === 'settings') {
    const state = await mutate((draft) => {
      if (typeof body.injectLevel1Globally === 'boolean') draft.settings.injectLevel1Globally = body.injectLevel1Globally;
      if (typeof body.notifyMasterOnChildDone === 'boolean') draft.settings.notifyMasterOnChildDone = body.notifyMasterOnChildDone;
      if (typeof body.autoArchiveChild === 'boolean') draft.settings.autoArchiveChild = body.autoArchiveChild;
      if (body.archiveOn === 'pass' || body.archiveOn === 'finished') draft.settings.archiveOn = body.archiveOn;
      if (typeof body.defaultCwd === 'string') draft.settings.defaultCwd = asText(body.defaultCwd, 500);
      syncKbCache(draft);
    });
    return { body: { settings: state.settings } };
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'pulse') {
    const state = await snapshot();
    const boardId = query.get('boardId') ?? '';
    const board = state.boards.find((candidate) => candidate.id === boardId);
    return {
      body: {
        stateUpdatedAt: state.updatedAt,
        boardUpdatedAt: board?.updatedAt ?? 0,
        masterSessionId: board?.masterSessionId ?? '',
        masterRunning: board?.masterSessionId ? bridge.isRunning(board.masterSessionId) : false,
        bridge: state.bridge,
        tasks: board?.nodes.filter((node) => node.type === 'task').map((task) => ({ id: task.id, status: task.status, finishedAt: task.finishedAt })) ?? [],
      },
    };
  }

  // 知识库
  if (segments[0] === 'kb') {
    if (method === 'GET' && segments.length === 1) {
      const state = await snapshot();
      return { body: { levels: LEVELS, entries: state.kb, stats: kbStats(state.kb) } };
    }
    if (method === 'POST' && segments.length === 1) {
      let entry;
      await mutate((draft) => {
        entry = addKbEntry(draft, body);
        syncKbCache(draft);
      });
      return { status: 201, body: { entry } };
    }
    if ((method === 'PATCH' || method === 'DELETE') && segments.length === 2) {
      const id = decodeURIComponent(segments[1]);
      let entry = null;
      await mutate((draft) => {
        if (method === 'PATCH') entry = updateKbEntry(draft, id, body);
        else removeKbEntry(draft, id);
        syncKbCache(draft);
      });
      return { body: { entry, removed: method === 'DELETE' ? id : undefined } };
    }
  }

  // 编排板
  if (segments[0] === 'boards') {
    if (method === 'GET' && segments.length === 1) {
      const state = await snapshot();
      return { body: { boards: state.boards.map(boardSummary) } };
    }
    if (method === 'POST' && segments.length === 1) {
      let board;
      await mutate((draft) => {
        board = createBoard({
          name: body.name ?? '新编排板',
          goal: body.goal ?? '',
          cwd: body.cwd ?? draft.settings.defaultCwd ?? '',
          masterSessionId: body.masterSessionId ?? draft.bridge.currentSessionId ?? '',
          masterTitle: body.masterTitle ?? draft.bridge.currentSessionTitle ?? '',
          followCurrent: body.followCurrent === true,
        });
        draft.boards.push(board);
      });
      return { status: 201, body: { board } };
    }
    const boardId = segments[1] !== undefined ? decodeURIComponent(segments[1]) : '';
    if (method === 'GET' && segments.length === 2) {
      const state = await snapshot();
      const board = findBoard(state, boardId);
      return { body: { board, kb: state.kb, levels: LEVELS, settings: state.settings } };
    }
    if (method === 'PATCH' && segments.length === 2) {
      let board;
      await mutate((draft) => {
        board = findBoard(draft, boardId);
        if (typeof body.name === 'string' && body.name.trim() !== '') board.name = asText(body.name, 80);
        if (typeof body.goal === 'string') board.goal = asText(body.goal, 4000);
        if (typeof body.cwd === 'string') board.cwd = asText(body.cwd, 500);
        if (body.masterSessionId !== undefined) {
          board.masterSessionId = asText(body.masterSessionId, 120);
          board.masterTitle = asText(body.masterTitle, 200);
          const master = masterOf(board);
          master.sessionId = board.masterSessionId;
          master.masterTitle = board.masterTitle;
        }
        if (typeof body.followCurrent === 'boolean') board.followCurrent = body.followCurrent;
        touch(board);
      });
      return { body: { board } };
    }
    if (method === 'DELETE' && segments.length === 2) {
      await mutate((draft) => {
        const index = draft.boards.findIndex((candidate) => candidate.id === boardId);
        if (index < 0) throw new HttpError(404, '编排板不存在');
        draft.boards.splice(index, 1);
      });
      return { body: { removed: boardId } };
    }
    if (method === 'PUT' && segments.length === 3 && segments[2] === 'graph') {
      let board;
      await mutate((draft) => {
        board = findBoard(draft, boardId);
        sanitizeGraph(board, body);
        touch(board);
      });
      return { body: { board } };
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'plan') {
      const job = startPlanJob(boardId, asText(body.hint, 2000));
      return { status: 202, body: { jobId: job.id, job } };
    }
    if (method === 'GET' && segments.length === 4 && segments[2] === 'jobs') {
      const job = JOBS.get(decodeURIComponent(segments[3]));
      if (job === undefined) throw new HttpError(404, '任务不存在或已过期');
      return { body: { job } };
    }
    if (method === 'POST' && segments.length === 4 && segments[2] === 'tasks' && segments[3] === 'new') {
      let task;
      let boardUpdatedAt = 0;
      await mutate((draft) => {
        const board = findBoard(draft, boardId);
        const existing = board.nodes.filter((node) => node.type === 'task');
        const maxY = board.nodes.reduce((max, node) => Math.max(max, node.y), 0);
        task = newTaskNode({
          title: asText(body.title, 120) || '未命名任务',
          x: Number.isFinite(body.x) ? body.x : 360 + (existing.length % 2) * 300,
          y: Number.isFinite(body.y) ? body.y : maxY + 160,
          goal: asText(body.goal, 2000),
        });
        board.nodes.push(task);
        touch(board);
        boardUpdatedAt = board.updatedAt;
      });
      return { status: 201, body: { task, boardUpdatedAt } };
    }
    if (method === 'POST' && segments.length === 4 && segments[2] === 'master' && segments[3] === 'model') {
      const state = await snapshot();
      const board = findBoard(state, boardId);
      const sessionId = requireMasterSession(board);
      const model = body.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';
      try {
        await bridge.service().selectModel({ sessionId, provider: 'deepseek-web', model });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new HttpError(400, `切换网页模型失败：${message}。请先安装并登录 dsh-deepseek-web-login（设置 → DeepSeek 网页登录），再重试。`);
      }
      return { body: { provider: 'deepseek-web', model } };
    }
    if (method === 'POST' && segments.length === 4 && segments[2] === 'master' && segments[3] === 'send') {
      const state = await snapshot();
      const board = findBoard(state, boardId);
      const sessionId = requireMasterSession(board);
      const text = asText(body.text, 20000);
      if (text === '') throw new HttpError(400, '消息不能为空');
      await bridge.prompt(sessionId, text);
      return { body: { ok: true } };
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'bind-master') {
      let board;
      await mutate((draft) => {
        board = findBoard(draft, boardId);
        board.masterSessionId = asText(body.sessionId, 120);
        board.masterTitle = asText(body.title, 200);
        board.followCurrent = body.followCurrent === true;
        const master = masterOf(board);
        master.sessionId = board.masterSessionId;
        master.masterTitle = board.masterTitle;
        touch(board);
      });
      return { body: { board } };
    }
    if (method === 'GET' && segments.length === 3 && segments[2] === 'messages') {
      const state = await snapshot();
      const board = findBoard(state, boardId);
      const sessionId = asText(query.get('sessionId') ?? '', 120) || requireMasterSession(board);
      const limit = Math.max(1, Math.min(100, Number(query.get('limit') ?? 40)));
      const inspected = await bridge.inspect(sessionId).catch((error) => {
        throw new HttpError(404, `读不到会话：${error instanceof Error ? error.message : String(error)}`);
      });
      return {
        body: {
          sessionId,
          messages: eventsToMessages(inspected?.events ?? [], limit),
          running: bridge.isRunning(sessionId),
          lastSeq: (inspected?.events ?? []).at(-1)?.seq ?? -1,
        },
      };
    }
    if (method === 'POST' && segments.length === 5 && segments[2] === 'tasks' && segments[4] === 'dispatch') {
      const taskId = decodeURIComponent(segments[3]);
      return { body: await dispatchTask(boardId, taskId, { force: body.force === true }) };
    }
    if (method === 'POST' && segments.length === 5 && segments[2] === 'tasks' && segments[4] === 'verify') {
      const taskId = decodeURIComponent(segments[3]);
      const job = startVerifyJob(boardId, taskId);
      return { status: 202, body: { jobId: job.id, job } };
    }
    if (method === 'POST' && segments.length === 5 && segments[2] === 'tasks' && segments[4] === 'accept') {
      const taskId = decodeURIComponent(segments[3]);
      const result = await acceptTask(boardId, taskId, { pass: body.pass === true, note: asText(body.note, 2000) });
      return { body: result };
    }
    if (method === 'POST' && segments.length === 5 && segments[2] === 'tasks' && segments[4] === 'archive') {
      const taskId = decodeURIComponent(segments[3]);
      const archived = body.archived !== false;
      const state = await snapshot();
      const board = findBoard(state, boardId);
      const task = findTask(board, taskId);
      if (task.childSessionId !== '') {
        try {
          await setChildArchived(task.childSessionId, archived);
        } catch (error) {
          throw new HttpError(500, `归档子会话失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await mutate((draft) => {
        const targetBoard = findBoard(draft, boardId);
        const targetTask = findTask(targetBoard, taskId);
        targetTask.archivedAt = archived ? Date.now() : 0;
        touch(targetBoard);
      });
      return { body: { taskId, archived } };
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'dispatch-all') {
      const state = await snapshot();
      const board = findBoard(state, boardId);
      const results = [];
      for (const task of board.nodes.filter((node) => node.type === 'task')) {
        if (!isRunnable(board, task)) continue;
        try {
          results.push(await dispatchTask(boardId, task.id));
        } catch (error) {
          results.push({ taskId: task.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { body: { dispatched: results.filter((item) => item.childSessionId !== undefined).length, results } };
    }
  }

  return undefined;
}

/* ───────────────────────────────── 静态页面 ───────────────────────────────── */

async function serveAppFile(res, fileName, contentType) {
  try {
    const url = new URL(`./app/${fileName}`, import.meta.url);
    const body = await readFile(url, 'utf8');
    sendText(res, 200, contentType, body);
  } catch (error) {
    sendText(res, 404, 'text/plain; charset=utf-8', `找不到 ${fileName}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function page() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>编排台</title><link rel="stylesheet" href="/orchestra/style.css"></head><body><div id="app"></div><script src="/orchestra/app.js"></script></body></html>`;
}

/* ─────────────────────────────────── 挂载 ─────────────────────────────────── */

export const name = PACKAGE;
export const inject = ['webServer', 'sessions'];

export function apply(ctx) {
  ctxError = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`[orchestra] ${message}`);
    else process.stderr.write(`[orchestra] ${message}\n`);
  };
  bridge = new SessionBridge(ctx, {
    onEvent: (session, event) => {
      if (event?.type !== 'turn/end') return;
      void onChildTurnEnd(session.id).catch((error) => ctxError(`收取子对话结果失败：${error instanceof Error ? error.message : String(error)}`));
    },
  });

  // 先加载一次，给系统提示与 API 一个同步可读的缓存；后续每次写入都会刷新。
  void loadState().then(syncKbCache).catch((error) => ctxError(`读取数据失败：${error instanceof Error ? error.message : String(error)}`));

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handleApi });
    return dispose;
  }, 'orchestra: api');

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: PAGE_PREFIX, handler: (_req, res) => {
        res.writeHead(302, { location: `${PAGE_PREFIX}/` });
        res.end();
      } }),
      ctx.webServer.register({ kind: 'exact', path: `${PAGE_PREFIX}/`, handler: (_req, res) => sendText(res, 200, 'text/html; charset=utf-8', page()) }),
      ctx.webServer.register({ kind: 'exact', path: `${PAGE_PREFIX}/app.js`, handler: (_req, res) => void serveAppFile(res, 'app.js', 'text/javascript; charset=utf-8') }),
      ctx.webServer.register({ kind: 'exact', path: `${PAGE_PREFIX}/style.css`, handler: (_req, res) => void serveAppFile(res, 'style.css', 'text/css; charset=utf-8') }),
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 卸载时忽略重复释放
        }
      }
    };
  }, 'orchestra: page');

  ctx.effect(() => {
    const local = [];
    try {
      registerTools(ctx, local);
      const systemPrompt = ctx.get('systemPrompt');
      if (systemPrompt !== undefined) {
        local.push(
          systemPrompt.section({
            name: 'orchestra-taboos',
            order: 8700,
            text: () => buildGlobalTabooSection(),
          }),
        );
      }
    } catch (error) {
      ctxError(`工具/提示注册失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return () => {
      for (const dispose of local) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
    };
  }, 'orchestra: tools');

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => bridge.notify(session, event));
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'orchestra: session events');
}

export { PACKAGE, API_PREFIX };
