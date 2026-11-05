/**
 * 编排板的纯数据操作：节点/连线的规范化、计划落图、依赖顺序、状态。
 * 不碰网络、不碰会话，方便单测。
 */
import { randomUUID } from 'node:crypto';

export const NODE_TYPES = ['master', 'task', 'kb', 'note'];
export const EDGE_KINDS = ['dispatch', 'depends', 'constraint', 'result'];
export const TASK_STATUSES = ['draft', 'dispatching', 'running', 'review', 'passed', 'rejected', 'error'];

export const STATUS_META = {
  draft: { label: '待派发', tone: 'muted' },
  dispatching: { label: '正在派发', tone: 'info' },
  running: { label: '子对话运行中', tone: 'info' },
  review: { label: '待验收', tone: 'warning' },
  passed: { label: '已通过', tone: 'ok' },
  rejected: { label: '已驳回', tone: 'danger' },
  error: { label: '出错', tone: 'danger' },
};

export function statusMeta(status) {
  return STATUS_META[status] ?? STATUS_META.draft;
}

export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function text(value, max = 4000) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function number(value, fallback, min = -100000, max = 100000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(max, Math.max(min, parsed)));
}

export function createBoard({ name, goal = '', cwd = '', masterSessionId = '', masterTitle = '', followCurrent = false }) {
  const now = Date.now();
  const board = {
    id: newId('b'),
    name: text(name, 80) || '未命名编排板',
    goal: text(goal, 4000),
    cwd: text(cwd, 500),
    masterSessionId: text(masterSessionId, 120),
    masterTitle: text(masterTitle, 200),
    followCurrent: followCurrent === true,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
  };
  ensureMaster(board);
  return board;
}

export function ensureMaster(board) {
  if (!Array.isArray(board.nodes)) board.nodes = [];
  let master = board.nodes.find((node) => node.type === 'master');
  if (master === undefined) {
    master = {
      id: newId('m'),
      type: 'master',
      x: 40,
      y: 220,
      title: '总对话',
      sessionId: board.masterSessionId ?? '',
      masterTitle: board.masterTitle ?? '',
    };
    board.nodes.unshift(master);
  }
  if ((board.masterSessionId ?? '') !== '') {
    master.sessionId = board.masterSessionId;
    master.masterTitle = board.masterTitle ?? master.masterTitle ?? '';
  } else if (typeof master.sessionId === 'string' && master.sessionId !== '') {
    board.masterSessionId = master.sessionId;
    board.masterTitle = master.masterTitle ?? '';
  }
  return master;
}

/** 把磁盘上的旧数据补齐成当前形状。 */
export function normalizeBoard(raw) {
  const board = {
    id: typeof raw?.id === 'string' && raw.id !== '' ? raw.id : newId('b'),
    name: text(raw?.name, 80) || '未命名编排板',
    goal: text(raw?.goal, 4000),
    cwd: text(raw?.cwd, 500),
    masterSessionId: text(raw?.masterSessionId, 120),
    masterTitle: text(raw?.masterTitle, 200),
    followCurrent: raw?.followCurrent === true,
    createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : Date.now(),
    nodes: [],
    edges: [],
  };
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
  for (const node of nodes) {
    const normalized = normalizeNode(node);
    if (normalized !== null) board.nodes.push(normalized);
  }
  const edges = Array.isArray(raw?.edges) ? raw.edges : [];
  for (const edge of edges) {
    const normalized = normalizeEdge(edge, board.nodes);
    if (normalized !== null) board.edges.push(normalized);
  }
  ensureMaster(board);
  return board;
}

function normalizeNode(node) {
  if (node === null || typeof node !== 'object') return null;
  const type = NODE_TYPES.includes(node.type) ? node.type : 'task';
  const base = {
    id: typeof node.id === 'string' && node.id !== '' ? node.id : newId(type === 'task' ? 't' : type),
    type,
    x: number(node.x, 80),
    y: number(node.y, 160),
    title: text(node.title, 120) || (type === 'task' ? '未命名任务' : type === 'master' ? '总对话' : type === 'kb' ? '禁忌' : '便签'),
  };
  if (type === 'master') {
    return { ...base, sessionId: text(node.sessionId, 120), masterTitle: text(node.masterTitle, 200) };
  }
  if (type === 'task') {
    return {
      ...base,
      goal: text(node.goal, 2000),
      boundary: text(node.boundary, 4000),
      inputs: text(node.inputs, 2000),
      deliverables: text(node.deliverables, 2000),
      acceptance: Array.isArray(node.acceptance) ? node.acceptance.map((item) => text(item, 500)).filter((item) => item !== '').slice(0, 8) : [],
      kbLevels: Array.isArray(node.kbLevels) ? [...new Set(node.kbLevels.map((level) => Number(level)).filter((level) => Number.isInteger(level) && level >= 1 && level <= 4))].sort((a, b) => a - b) : [1, 2],
      kbIds: Array.isArray(node.kbIds) ? node.kbIds.filter((id) => typeof id === 'string') : [],
      status: TASK_STATUSES.includes(node.status) ? node.status : 'draft',
      childSessionId: text(node.childSessionId, 120),
      childTitle: text(node.childTitle, 200),
      dispatchedAt: Number.isFinite(node.dispatchedAt) ? node.dispatchedAt : 0,
      finishedAt: Number.isFinite(node.finishedAt) ? node.finishedAt : 0,
      archivedAt: Number.isFinite(node.archivedAt) ? node.archivedAt : 0,
      error: text(node.error, 1000),
      result: normalizeResult(node.result),
      verdict: normalizeVerdict(node.verdict),
      roundNote: text(node.roundNote, 2000),
      rounds: Array.isArray(node.rounds) ? node.rounds.slice(-10).map((round) => ({ at: Number(round?.at) || 0, note: text(round?.note, 2000), result: normalizeResult(round?.result) })) : [],
    };
  }
  if (type === 'kb') {
    return {
      ...base,
      kbId: text(node.kbId, 120),
      level: Number.isInteger(node.level) ? node.level : 3,
      text: text(node.text, 4000),
    };
  }
  return { ...base, text: text(node.text, 4000) };
}

function normalizeResult(result) {
  if (result === null || typeof result !== 'object') return null;
  return {
    status: ['done', 'blocked', 'failed'].includes(result.status) ? result.status : 'done',
    summary: text(result.summary, 8000),
    artifacts: Array.isArray(result.artifacts) ? result.artifacts.map((item) => text(item, 300)).filter((item) => item !== '').slice(0, 20) : [],
    checks: Array.isArray(result.checks)
      ? result.checks.slice(0, 12).map((check) => ({ criterion: text(check?.criterion, 500), pass: check?.pass === true, evidence: text(check?.evidence, 2000) }))
      : [],
    raw: text(result.raw, 20000),
    parsed: result.parsed === true,
    at: Number.isFinite(result.at) ? result.at : 0,
  };
}

function normalizeVerdict(verdict) {
  if (verdict === null || typeof verdict !== 'object') return null;
  return {
    verdict: verdict.verdict === 'pass' ? 'pass' : 'fail',
    score: Number.isFinite(verdict.score) ? verdict.score : 0,
    checks: Array.isArray(verdict.checks)
      ? verdict.checks.slice(0, 12).map((check) => ({ criterion: text(check?.criterion, 500), pass: check?.pass === true, evidence: text(check?.evidence, 2000) }))
      : [],
    reasons: Array.isArray(verdict.reasons) ? verdict.reasons.map((item) => text(item, 1000)).filter((item) => item !== '').slice(0, 8) : [],
    followup: text(verdict.followup, 2000),
    at: Number.isFinite(verdict.at) ? verdict.at : 0,
  };
}

function normalizeEdge(edge, nodes) {
  if (edge === null || typeof edge !== 'object') return null;
  const from = text(edge.from, 120);
  const to = text(edge.to, 120);
  const kind = EDGE_KINDS.includes(edge.kind) ? edge.kind : 'dispatch';
  if (from === '' || to === '' || from === to) return null;
  const source = nodes.find((node) => node.id === from);
  const target = nodes.find((node) => node.id === to);
  if (source === undefined || target === undefined) return null;
  if (!edgeAllowed(kind, source.type, target.type)) return null;
  return { id: typeof edge.id === 'string' && edge.id !== '' ? edge.id : newId('e'), from, to, kind };
}

function edgeAllowed(kind, fromType, toType) {
  if (kind === 'dispatch' || kind === 'result') return fromType === 'master' && toType === 'task' || (kind === 'result' && fromType === 'task' && toType === 'master');
  if (kind === 'depends') return fromType === 'task' && toType === 'task';
  if (kind === 'constraint') return (fromType === 'kb' || fromType === 'note') && toType === 'task';
  return false;
}

/** 客户端整图保存：只覆盖可编辑字段，运行时字段（状态/子会话/结果）以服务端为准。 */
export function sanitizeGraph(board, input) {
  const incomingNodes = Array.isArray(input?.nodes) ? input.nodes : [];
  const incomingEdges = Array.isArray(input?.edges) ? input.edges : [];
  const existing = new Map(board.nodes.map((node) => [node.id, node]));
  const nextNodes = [];
  const seen = new Set();
  for (const raw of incomingNodes) {
    if (raw === null || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId(raw.type === 'task' ? 't' : 'n');
    if (seen.has(id)) continue;
    seen.add(id);
    const current = existing.get(id);
    if (current !== undefined) {
      nextNodes.push(mergeNode(current, raw));
      continue;
    }
    const created = normalizeNode({ ...raw, id });
    if (created !== null) nextNodes.push(created);
  }
  if (!nextNodes.some((node) => node.type === 'master')) {
    const oldMaster = board.nodes.find((node) => node.type === 'master');
    if (oldMaster !== undefined) nextNodes.unshift(oldMaster);
  }
  board.nodes = nextNodes;
  const edges = [];
  const edgeIds = new Set();
  for (const raw of incomingEdges) {
    const normalized = normalizeEdge(raw, board.nodes);
    if (normalized === null || edgeIds.has(normalized.id)) continue;
    // 同一个 from→to→kind 只留一条
    if (edges.some((edge) => edge.from === normalized.from && edge.to === normalized.to && edge.kind === normalized.kind)) continue;
    edgeIds.add(normalized.id);
    edges.push(normalized);
  }
  board.edges = edges;
  ensureMaster(board);
  return board;
}

function mergeNode(current, raw) {
  const next = { ...current };
  next.x = number(raw.x, current.x);
  next.y = number(raw.y, current.y);
  if (typeof raw.title === 'string' && raw.title.trim() !== '') next.title = text(raw.title, 120);
  if (current.type === 'master') {
    if (typeof raw.sessionId === 'string') next.sessionId = text(raw.sessionId, 120);
    if (typeof raw.masterTitle === 'string') next.masterTitle = text(raw.masterTitle, 200);
  }
  if (current.type === 'task') {
    for (const field of ['goal', 'boundary', 'inputs', 'deliverables']) {
      if (typeof raw[field] === 'string') next[field] = text(raw[field], field === 'boundary' ? 4000 : 2000);
    }
    if (Array.isArray(raw.acceptance)) next.acceptance = raw.acceptance.map((item) => text(item, 500)).filter((item) => item !== '').slice(0, 8);
    if (Array.isArray(raw.kbLevels)) next.kbLevels = [...new Set(raw.kbLevels.map((level) => Number(level)).filter((level) => Number.isInteger(level) && level >= 1 && level <= 4))].sort((a, b) => a - b);
    if (Array.isArray(raw.kbIds)) next.kbIds = raw.kbIds.filter((id) => typeof id === 'string');
  }
  if (current.type === 'kb') {
    if (typeof raw.kbId === 'string') next.kbId = text(raw.kbId, 120);
    if (Number.isInteger(raw.level)) next.level = raw.level;
    if (typeof raw.text === 'string') next.text = text(raw.text, 4000);
  }
  if (current.type === 'note' && typeof raw.text === 'string') next.text = text(raw.text, 4000);
  return next;
}

/**
 * 把解析出来的计划落到画布：tasks 是 parsePlan 的输出（带 dependsOn 索引）。
 * 返回新建的 task 节点 id 列表，顺序与计划一致。
 */
export function applyPlan(board, planTasks) {
  ensureMaster(board);
  const master = board.nodes.find((node) => node.type === 'master');
  const baseY = board.nodes.reduce((max, node) => Math.max(max, node.y), 0) + 140;
  const layers = planLayers(planTasks);
  const created = [];
  for (let index = 0; index < planTasks.length; index += 1) {
    const task = planTasks[index];
    const layer = layers[index];
    const y = baseY + layer * 180 + countInLayer(planTasks, layers, layer, index) * 150;
    const node = normalizeNode({
      id: newId('t'),
      type: 'task',
      title: task.title,
      x: 360 + layer * 320,
      y,
      goal: task.goal,
      boundary: task.boundary,
      inputs: task.inputs,
      deliverables: task.deliverables,
      acceptance: task.acceptance,
      kbLevels: task.kbLevels ?? [1, 2],
      status: 'draft',
    });
    board.nodes.push(node);
    created.push(node);
  }
  for (const node of created) {
    if (board.edges.some((edge) => edge.from === master.id && edge.to === node.id && edge.kind === 'dispatch')) continue;
    board.edges.push({ id: newId('e'), from: master.id, to: node.id, kind: 'dispatch' });
  }
  for (let index = 0; index < planTasks.length; index += 1) {
    for (const dep of planTasks[index].dependsOn ?? []) {
      const from = created[dep];
      const to = created[index];
      if (from === undefined || to === undefined) continue;
      if (board.edges.some((edge) => edge.from === from.id && edge.to === to.id && edge.kind === 'depends')) continue;
      board.edges.push({ id: newId('e'), from: from.id, to: to.id, kind: 'depends' });
    }
  }
  return created;
}

function planLayers(tasks) {
  const memo = new Array(tasks.length).fill(-1);
  const visit = (index, seen) => {
    if (memo[index] >= 0) return memo[index];
    if (seen.has(index)) return 0;
    seen.add(index);
    const deps = tasks[index].dependsOn ?? [];
    memo[index] = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => visit(dep, seen)));
    return memo[index];
  };
  return tasks.map((_, index) => visit(index, new Set()));
}

function countInLayer(tasks, layers, layer, limit) {
  let count = 0;
  for (let index = 0; index < limit; index += 1) if (layers[index] === layer) count += 1;
  return count;
}

export function newTaskNode({ title = '未命名任务', x = 400, y = 200, goal = '', acceptance = [] } = {}) {
  return normalizeNode({
    id: newId('t'),
    type: 'task',
    title,
    x,
    y,
    goal,
    acceptance: Array.isArray(acceptance) && acceptance.length > 0 ? acceptance : ['按目标完成，并逐条说明完成情况'],
    kbLevels: [1, 2],
  });
}

/** 依赖该任务的前置任务（depends 连线）。 */
export function dependenciesOf(board, task) {
  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  return board.edges
    .filter((edge) => edge.kind === 'depends' && edge.to === task.id)
    .map((edge) => byId.get(edge.from))
    .filter((node) => node !== undefined && node.type === 'task');
}

export function dependentsOf(board, task) {
  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  return board.edges
    .filter((edge) => edge.kind === 'depends' && edge.from === task.id)
    .map((edge) => byId.get(edge.to))
    .filter((node) => node !== undefined && node.type === 'task');
}

export function isRunnable(board, task) {
  if (task.status === 'running' || task.status === 'dispatching') return false;
  return dependenciesOf(board, task).every((dep) => dep.status === 'passed');
}

export function boardSummary(board) {
  const tasks = board.nodes.filter((node) => node.type === 'task');
  return {
    id: board.id,
    name: board.name,
    goal: board.goal,
    cwd: board.cwd,
    masterSessionId: board.masterSessionId,
    masterTitle: board.masterTitle,
    followCurrent: board.followCurrent === true,
    updatedAt: board.updatedAt,
    counts: {
      tasks: tasks.length,
      running: tasks.filter((task) => task.status === 'running' || task.status === 'dispatching').length,
      review: tasks.filter((task) => task.status === 'review').length,
      passed: tasks.filter((task) => task.status === 'passed').length,
      archived: tasks.filter((task) => task.archivedAt > 0).length,
    },
  };
}
