/** 用一个假的 API 跑画布前端，便于本地目测 / 无头浏览器冒烟。node scripts/ui-mock.mjs [port] */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'app');
const port = Number(process.argv[2] ?? 0);

const now = Date.now();
const board = {
  id: 'b-demo',
  name: '登录页改版',
  goal: '把登录页换成新的设计，并保证旧接口仍然可用',
  cwd: 'D:\\work\\login',
  masterSessionId: 'session-demo',
  masterTitle: '总对话 · 登录页改版',
  createdAt: now,
  updatedAt: now,
  nodes: [
    { id: 'm1', type: 'master', x: 40, y: 220, title: '总对话', sessionId: 'session-demo', masterTitle: '总对话 · 登录页改版' },
    { id: 't1', type: 'task', x: 380, y: 60, title: '读旧登录实现', goal: '找到旧登录页入口、样式与接口调用', boundary: '只读 src/login/**；不要改任何文件；输入只有仓库', inputs: '仓库 D:\\work\\login', deliverables: '一份入口清单', acceptance: ['列出入口文件', '列出旧接口'], kbLevels: [1, 2], kbIds: [], status: 'passed', childSessionId: 'session-child-1', childTitle: '读旧登录实现 · 子对话', result: { status: 'done', summary: '入口在 src/login/index.tsx，接口在 src/api/auth.ts', artifacts: ['src/login/index.tsx'], checks: [{ criterion: '列出入口文件', pass: true, evidence: 'src/login/index.tsx' }], at: now }, verdict: { verdict: 'pass', score: 92, checks: [], reasons: ['证据充分'], followup: '', at: now }, rounds: [], dispatchedAt: now, finishedAt: now, error: '', kbLevels: [1, 2] },
    { id: 't2', type: 'task', x: 380, y: 330, title: '实现新登录页', goal: '按新设计实现登录页，保留旧接口', boundary: '只改 src/login/** 与 src/styles/login.css；不要动后端', inputs: '上一任务的入口清单', deliverables: '可运行的登录页', acceptance: ['新样式生效', '旧接口仍可用', '构建通过'], kbLevels: [1, 2, 3], kbIds: [], status: 'review', childSessionId: 'session-child-2', childTitle: '实现新登录页 · 子对话', result: { status: 'done', summary: '新登录页已完成，tsc 与构建通过；手测旧接口仍可用。', artifacts: ['src/login/index.tsx', 'src/styles/login.css'], checks: [{ criterion: '新样式生效', pass: true, evidence: '截图对比' }, { criterion: '旧接口仍可用', pass: true, evidence: '手测登录成功' }, { criterion: '构建通过', pass: true, evidence: 'pnpm build 0 error' }], at: now }, verdict: null, rounds: [], dispatchedAt: now, finishedAt: now, error: '', kbLevels: [1, 2, 3] },
    { id: 'k1', type: 'kb', x: 40, y: 480, title: '不要动生产配置', level: 2, text: '不要改 .env.production / 部署脚本；需要改先停下来报告。', kbId: '' },
  ],
  edges: [
    { id: 'e1', from: 'm1', to: 't1', kind: 'dispatch' },
    { id: 'e2', from: 'm1', to: 't2', kind: 'dispatch' },
    { id: 'e3', from: 't1', to: 't2', kind: 'depends' },
    { id: 'e4', from: 'k1', to: 't2', kind: 'constraint' },
  ],
};

const kb = [
  { id: 'kb-l1-1', level: 1, title: '不捏造、不虚报', text: '不得虚构事实、伪造执行结果。', locked: true, enabled: true, tags: [], createdAt: 0 },
  { id: 'kb-l2-1', level: 2, title: '只改边界内', text: '只修改任务边界里点名的文件与范围。', locked: false, enabled: true, tags: [], createdAt: 0 },
];

const sessions = [
  { id: 'session-demo', title: '总对话 · 登录页改版', cwd: 'D:\\work\\login', running: false, updatedAt: now },
  { id: 'session-child-1', title: '读旧登录实现 · 子对话', cwd: 'D:\\work\\login', running: false, updatedAt: now },
  { id: 'session-child-2', title: '实现新登录页 · 子对话', cwd: 'D:\\work\\login', running: false, updatedAt: now },
];

const messages = {
  'session-demo': [
    { role: 'user', text: '把登录页换成新的设计，旧的接口不要动。', seq: 0, at: now - 60000 },
    { role: 'assistant', text: '我拆成两个任务：先读旧实现，再改新页面。验收标准已经写进任务节点。', seq: 1, at: now - 56000 },
  ],
  'session-child-2': [
    { role: 'user', text: '【任务】实现新登录页……', seq: 0, at: now - 30000 },
    { role: 'assistant', text: '新登录页已完成，构建通过。', seq: 1, at: now - 12000 },
  ],
};

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

let taskSeq = 10;
function mockTask(body) {
  taskSeq += 1;
  return {
    id: `t-mock-${taskSeq}`,
    type: 'task',
    x: Number.isFinite(body.x) ? body.x : 500,
    y: Number.isFinite(body.y) ? body.y : 200,
    title: body.title ?? '新任务',
    goal: body.goal ?? '',
    boundary: '',
    inputs: '',
    deliverables: '',
    acceptance: ['按目标完成，并逐条说明完成情况'],
    kbLevels: [1, 2],
    kbIds: [],
    status: 'draft',
    childSessionId: '',
    childTitle: '',
    dispatchedAt: 0,
    finishedAt: 0,
    error: '',
    result: null,
    verdict: null,
    roundNote: '',
    rounds: [],
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (path === '/orchestra/' || path === '/orchestra') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(join(appDir, 'index.html'), 'utf8'));
      return;
    }
    if (path === '/orchestra/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(await readFile(join(appDir, 'app.js'), 'utf8'));
      return;
    }
    if (path === '/orchestra/style.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      res.end(await readFile(join(appDir, 'style.css'), 'utf8'));
      return;
    }
    if (path === '/orchestra/api/state') {
      return json(res, 200, { settings: { injectLevel1Globally: true, notifyMasterOnChildDone: false, defaultCwd: '' }, bridge: { currentSessionId: 'session-demo', currentSessionTitle: '总对话 · 登录页改版' }, kb, kbStats: { 1: 1, 2: 1, 3: 0, 4: 0 }, levels: [], boards: [{ id: board.id, name: board.name, goal: board.goal, cwd: board.cwd, masterSessionId: board.masterSessionId, masterTitle: board.masterTitle, updatedAt: board.updatedAt, counts: { tasks: 2, running: 0, review: 1, passed: 1 } }], dataDir: '<DSH_HOME>/orchestra' });
    }
    if (path === `/orchestra/api/boards/${board.id}` && req.method === 'PATCH') {
      const body = await readBody(req);
      for (const key of ['name', 'goal', 'cwd', 'masterSessionId', 'masterTitle', 'followCurrent']) {
        if (body[key] !== undefined) board[key] = body[key];
      }
      board.updatedAt = Date.now();
      return json(res, 200, { board });
    }
    if (path === `/orchestra/api/boards/${board.id}`) {
      return json(res, 200, { board, kb, levels: [], settings: { injectLevel1Globally: true } });
    }
    if (path === '/orchestra/api/pulse') {
      return json(res, 200, { boardUpdatedAt: board.updatedAt, masterRunning: false, bridge: { currentSessionId: 'session-demo' }, tasks: [] });
    }
    if (path === '/orchestra/api/sessions') {
      return json(res, 200, { items: sessions });
    }
    if (path === `/orchestra/api/boards/${board.id}/messages`) {
      const sessionId = url.searchParams.get('sessionId');
      const list = messages[sessionId] ?? [];
      return json(res, 200, { sessionId, messages: list, running: false, lastSeq: list.at(-1)?.seq ?? -1 });
    }
    if (req.method === 'POST' && path === `/orchestra/api/boards/${board.id}/tasks/new`) {
      const body = await readBody(req);
      const task = mockTask(body);
      board.nodes.push(task);
      board.updatedAt = Date.now();
      return json(res, 201, { task, boardUpdatedAt: board.updatedAt });
    }
    if (req.method === 'PUT' && path === `/orchestra/api/boards/${board.id}/graph`) {
      const body = await readBody(req);
      const existing = new Map(board.nodes.map((node) => [node.id, node]));
      board.nodes = body.nodes.map((node) => ({ ...(existing.get(node.id) ?? {}), ...node }));
      board.edges = body.edges ?? [];
      board.updatedAt = Date.now();
      return json(res, 200, { board });
    }
    const archiveMatch = /^\/orchestra\/api\/boards\/([^/]+)\/tasks\/([^/]+)\/archive$/.exec(path);
    if (req.method === 'POST' && archiveMatch !== null) {
      const body = await readBody(req);
      const task = board.nodes.find((node) => node.id === decodeURIComponent(archiveMatch[2]));
      if (task === undefined) return json(res, 404, { error: { message: 'no task' } });
      task.archivedAt = body.archived === false ? 0 : Date.now();
      board.updatedAt = Date.now();
      return json(res, 200, { taskId: task.id, archived: task.archivedAt > 0 });
    }
    return json(res, 404, { error: { message: `mock 没有这个接口：${path}` } });
  } catch (error) {
    return json(res, 500, { error: { message: String(error) } });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock: http://127.0.0.1:${server.address().port}/orchestra/`);
});
