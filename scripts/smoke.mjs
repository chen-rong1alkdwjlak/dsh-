/**
 * 端到端冒烟：用假的 Host 上下文（假会话控制器 + 假模型回复）把
 * 建板 → 拆解 → 派发 → 收结果 → 复核 → 通过 跑一遍，验证路由、事件与数据流。
 *
 *   node scripts/smoke.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'orchestra-smoke-'));
process.env.DSH_HOME = dir;

const routes = [];
const eventHandlers = new Set();
const systemSections = [];
const toolDefs = [];

function makeSession(id, { title = id, cwd = 'D:\\work' } = {}) {
  return { id, title, running: false, seq: 0, header: { id, cwd, createdAt: Date.now() }, events: [] };
}

const sessions = new Map();
const master = makeSession('session-master', { title: '总对话（假）' });
sessions.set(master.id, master);
let childCounter = 0;
const archivedSessions = new Set();

function emit(session, type, data) {
  session.seq += 1;
  const event = { seq: session.seq, type, data };
  session.events.push(event);
  if (type === 'turn/start') session.running = true;
  if (type === 'turn/end') session.running = false;
  for (const handler of eventHandlers) handler(session, event);
}

function replyFor(text) {
  if (text.includes('<orchestra-plan>')) {
    return '<orchestra-plan>{"tasks":[{"title":"读入口","goal":"找到入口文件","acceptance":["列出入口文件"]},{"title":"改实现","goal":"按需求改","dependsOn":["读入口"],"acceptance":["改完能跑通"]}]}</orchestra-plan>';
  }
  if (text.includes('<orchestra-verdict>')) {
    return '<orchestra-verdict>{"verdict":"pass","score":96,"checks":[{"criterion":"改完能跑通","pass":true,"evidence":"假测试通过"}],"reasons":["有证据"]}</orchestra-verdict>';
  }
  if (text.includes('你是一个被「总对话」派发的独立子对话')) {
    return '<orchestra-result>{"status":"done","summary":"假子对话完成了任务","artifacts":["src/x.ts"],"checks":[{"criterion":"改完能跑通","pass":true,"evidence":"假测试通过"}]}</orchestra-result>';
  }
  return '收到，我先记下。';
}

const sessionController = {
  async create(request) {
    childCounter += 1;
    const child = makeSession(`session-child-${childCounter}`, { title: `子对话 ${childCounter}`, cwd: request?.cwd ?? 'D:\\work' });
    sessions.set(child.id, child);
    return { sessionId: child.id };
  },
  async prompt(request) {
    const session = sessions.get(request.sessionId);
    if (session === undefined) throw new Error('no session');
    const text = request.content?.map((part) => part.text ?? '').join('\n') ?? '';
    emit(session, 'user/message', { role: 'user', content: request.content, source: { kind: 'user', rpcId: request.requestId }, surfaceOp: 'append' });
    const reply = replyFor(text);
    setTimeout(() => {
      emit(session, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
      emit(session, 'turn/end', { reason: { kind: 'done' } });
    }, 25);
    return { accepted: true };
  },
  async inspect(sessionId) {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new Error('no session');
    return { meta: session.header, inheritedEventCount: 0, events: [...session.events] };
  },
  async list() {
    return { items: [...sessions.values()].map((session) => ({ sessionId: session.id, cwd: session.header.cwd, running: session.running, updatedAt: Date.now(), blank: session.seq === 0 })) };
  },
  async projections() {
    return { kind: 'sequenced', asOfSeq: 0, values: { title: '' } };
  },
};

const ctx = {
  logger: { warn: (message) => console.warn('[warn]', message), info: () => {}, error: (message) => console.error('[error]', message) },
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  sessions: {
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
  },
  get(name) {
    if (name === 'sessionController') return sessionController;
    if (name === 'sessionProjections') return { snapshot: (session) => ({ values: { title: session.title ?? '' } }) };
    if (name === 'systemPrompt') return { section: (def) => { systemSections.push(def); return () => {}; } };
    if (name === 'tools') return { register: (def) => { toolDefs.push(def); return () => {}; }, get: () => undefined };
    if (name === 'workspaceRegistry') {
      return {
        archiveSession: async (sessionId) => { archivedSessions.add(sessionId); },
        unarchiveSession: async (sessionId) => { archivedSessions.delete(sessionId); },
      };
    }
    return undefined;
  },
  on(event, handler) {
    if (event === 'session/event') eventHandlers.add(handler);
    return () => eventHandlers.delete(handler);
  },
  effect(fn) {
    const dispose = fn();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
};

const plugin = await import('../index.js');
plugin.apply(ctx);

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  for (const route of routes) {
    if (route.kind === 'prefix' && path.startsWith(route.path)) return route.handler(req, res);
    if (route.kind === 'exact' && path === route.path) return route.handler(req, res);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} → ${response.status}: ${data?.error?.message ?? ''}`);
  return data;
}

let passed = 0;
function check(label, condition) {
  if (!condition) throw new Error(`断言失败：${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

try {
  const state0 = await call('/orchestra/api/state');
  check('初始状态可读', Array.isArray(state0.boards) && state0.kb.length >= 4);

  const created = await call('/orchestra/api/boards', { method: 'POST', body: { name: '冒烟板', goal: '把登录页改好', masterSessionId: master.id, masterTitle: master.title } });
  const boardId = created.board.id;
  check('建板并自带总对话节点', created.board.nodes.some((node) => node.type === 'master' && node.sessionId === master.id));

  const planStart = await call(`/orchestra/api/boards/${boardId}/plan`, { method: 'POST', body: {} });
  let planJob;
  for (let i = 0; i < 100; i += 1) {
    const { job } = await call(`/orchestra/api/boards/${boardId}/jobs/${planStart.jobId}`);
    if (job.status !== 'running') { planJob = job; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('拆解任务完成', planJob?.status === 'done');

  const afterPlan = await call(`/orchestra/api/boards/${boardId}`);
  const tasks = afterPlan.board.nodes.filter((node) => node.type === 'task');
  check('任务节点落到画布', tasks.length === 2);
  check('依赖连线存在', afterPlan.board.edges.some((edge) => edge.kind === 'depends'));

  const first = tasks[0];
  const dispatched = await call(`/orchestra/api/boards/${boardId}/tasks/${first.id}/dispatch`, { method: 'POST', body: {} });
  check('派发创建子对话', typeof dispatched.childSessionId === 'string' && dispatched.childSessionId.startsWith('session-child-'));

  let reviewed;
  for (let i = 0; i < 100; i += 1) {
    const { board } = await call(`/orchestra/api/boards/${boardId}`);
    const task = board.nodes.find((node) => node.id === first.id);
    if (task.status === 'review') { reviewed = task; break; }
    if (task.status === 'error') throw new Error(`子任务出错：${task.error}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('子对话结束进入待验收', reviewed !== undefined);
  check('结果被解析', reviewed.result?.summary.includes('假子对话'));

  const verifyStart = await call(`/orchestra/api/boards/${boardId}/tasks/${first.id}/verify`, { method: 'POST', body: {} });
  let verdictJob;
  for (let i = 0; i < 100; i += 1) {
    const { job } = await call(`/orchestra/api/boards/${boardId}/jobs/${verifyStart.jobId}`);
    if (job.status !== 'running') { verdictJob = job; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('复核完成且判定通过', verdictJob?.status === 'done' && verdictJob.verdict.verdict === 'pass');

  const accepted = await call(`/orchestra/api/boards/${boardId}/tasks/${first.id}/accept`, { method: 'POST', body: { pass: true } });
  check('人工通过', accepted.status === 'passed');
  check('通过后归档子会话', accepted.archived === true && archivedSessions.has(dispatched.childSessionId));
  const afterAccept = await call(`/orchestra/api/boards/${boardId}`);
  check('通过的任务被标记归档', afterAccept.board.nodes.find((node) => node.id === first.id).archivedAt > 0);

  const unarchived = await call(`/orchestra/api/boards/${boardId}/tasks/${first.id}/archive`, { method: 'POST', body: { archived: false } });
  const afterUnarchive = await call(`/orchestra/api/boards/${boardId}`);
  check('可以手动取消归档', unarchived.archived === false && afterUnarchive.board.nodes.find((node) => node.id === first.id).archivedAt === 0 && !archivedSessions.has(dispatched.childSessionId));

  const messages = await call(`/orchestra/api/boards/${boardId}/messages?sessionId=${encodeURIComponent(master.id)}`);
  check('总对话消息可读', messages.messages.some((message) => message.role === 'user'));

  check('一级禁忌注入系统提示', systemSections.some((section) => section.name === 'orchestra-taboos'));
  const tabooText = systemSections.find((section) => section.name === 'orchestra-taboos')?.text?.() ?? '';
  check('系统提示包含一级内容', tabooText.includes('不得虚构事实'));

  check('注册了编排台工具', toolDefs.map((tool) => tool.name).sort().join(',') === 'orchestra_accept,orchestra_board,orchestra_dispatch');
  check('工具拒绝非总对话会话', await (async () => {
    try {
      await toolDefs.find((tool) => tool.name === 'orchestra_board').execute({}, { agent: { session: { id: 'session-child-1' } } });
      return false;
    } catch {
      return true;
    }
  })());

  const pageResponse = await fetch(`${base}/orchestra/`);
  check('画布页面可打开', pageResponse.ok && (await pageResponse.text()).includes('app.js'));
  const appResponse = await fetch(`${base}/orchestra/app.js`);
  check('画布脚本可取', appResponse.ok);

  console.log(`\n冒烟通过：${passed} 项检查`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
