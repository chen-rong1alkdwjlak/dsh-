import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractTaggedJson, parsePlan, parseResult, parseVerdict, composeTaskBrief, composePlanPrompt } from '../lib/brief.js';
import { resolveKb, level1Entries, removeKbEntry, addKbEntry } from '../lib/kb.js';
import { createBoard, applyPlan, dependenciesOf, isRunnable, sanitizeGraph, newTaskNode } from '../lib/boards.js';
import { eventsToMessages, assistantTextBetween } from '../lib/sessions.js';
import { snapshot, mutate, resetCache, dataFile, defaultState } from '../lib/store.js';

const KB = defaultState().kb;

test('extractTaggedJson 容忍前后废话与代码围栏', () => {
  const text = '好的，计划如下：\n<orchestra-plan>\n```json\n{"tasks":[{"title":"A"}]}\n```\n</orchestra-plan>\n完毕';
  const parsed = extractTaggedJson(text, 'orchestra-plan');
  assert.equal(parsed.tasks[0].title, 'A');
  assert.equal(extractTaggedJson('没有 JSON', 'orchestra-plan'), null);
});

test('parsePlan 解析标题依赖与默认验收', () => {
  const text = JSON.stringify({
    tasks: [
      { title: '读代码', goal: '读', acceptance: ['列出入口'] },
      { title: '改实现', goal: '改', dependsOn: ['读代码'], acceptance: ['通过测试'] },
      { title: '写文档', goal: '写', dependsOn: ['改实现'] },
    ],
  });
  const plan = parsePlan(`<orchestra-plan>${text}</orchestra-plan>`);
  assert.equal(plan.tasks.length, 3);
  assert.deepEqual(plan.tasks[1].dependsOn, [0]);
  assert.deepEqual(plan.tasks[2].dependsOn, [1]);
  assert.equal(plan.tasks[2].acceptance.length, 1);
  assert.match(plan.warnings.join(' '), /没有验收标准/);
});

test('parsePlan 去掉环依赖', () => {
  const text = JSON.stringify({
    tasks: [
      { title: 'A', dependsOn: ['B'] },
      { title: 'B', dependsOn: ['A'] },
    ],
  });
  const plan = parsePlan(`<orchestra-plan>${text}</orchestra-plan>`);
  const deps = plan.tasks.flatMap((task) => task.dependsOn);
  assert.ok(deps.length < 2);
  assert.match(plan.warnings.join(' '), /循环依赖/);
});

test('parseResult 有标签与无标签两条路', () => {
  const tagged = parseResult('<orchestra-result>{"status":"blocked","summary":"缺权限","checks":[{"criterion":"改文件","pass":false,"evidence":"拒绝"}]}</orchestra-result>');
  assert.equal(tagged.status, 'blocked');
  assert.equal(tagged.checks[0].pass, false);
  const plain = parseResult('我完成了，但只改了一个文件。');
  assert.equal(plain.status, 'done');
  assert.match(plain.summary, /只改了一个文件/);
  assert.equal(plain.parsed, false);
});

test('parseVerdict 只认 pass，其余算 fail', () => {
  const verdict = parseVerdict('<orchestra-verdict>{"verdict":"pass","score":93,"checks":[],"reasons":["证据齐"]}</orchestra-verdict>');
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.score, 93);
  const fail = parseVerdict('<orchestra-verdict>{"verdict":"maybe","score":300}</orchestra-verdict>');
  assert.equal(fail.verdict, 'fail');
  assert.equal(fail.score, 100);
});

test('任务书包含隔离规则、等级一禁忌、边界、验收与前置摘要', () => {
  const board = createBoard({ name: '测试板', goal: '做完', cwd: 'D:\\work' });
  const task = newTaskNode({ title: '实现登录', goal: '实现登录页', acceptance: ['能登录', '错误有提示'] });
  task.boundary = '只改 src/login.ts；不要碰数据库';
  task.dependsOn = [];
  const brief = composeTaskBrief({
    board,
    task,
    kb: KB,
    predecessors: [{ title: '读代码', result: { summary: '入口在 src/app.ts' } }],
  });
  assert.match(brief, /你没有、也无法获得总对话或其他子对话的上下文/);
  assert.match(brief, /一级禁忌/);
  assert.match(brief, /只改 src\/login\.ts/);
  assert.match(brief, /能登录/);
  assert.match(brief, /入口在 src\/app\.ts/);
  assert.match(brief, /orchestra-result/);
});

test('总对话拆解提示包含二级禁忌，不包含三级', () => {
  const board = createBoard({ name: '板', goal: '目标' });
  const prompt = composePlanPrompt({ board, kb: KB, resolved: resolveKb(board, { id: 'x', kbLevels: [1, 2] }, KB) });
  assert.match(prompt, /二级禁忌/);
  assert.match(prompt, /只改边界内/);
  assert.doesNotMatch(prompt, /三级约束（本任务附加）/);
  assert.match(prompt, /orchestra-plan/);
});

test('一级禁忌不受 enabled 影响，三级要显式勾选或连线', () => {
  const kb = [
    { id: '1', level: 1, title: 'L1', text: '一级内容', enabled: false, locked: true },
    { id: '2', level: 2, title: 'L2', text: '二级内容', enabled: true },
    { id: '3', level: 3, title: 'L3', text: '三级内容', enabled: true },
    { id: '4', level: 4, title: 'L4', text: '四级内容', enabled: true },
  ];
  const board = createBoard({ name: 'b' });
  const task = newTaskNode({ title: 't' });
  task.kbLevels = [1, 2];
  const plain = resolveKb(board, task, kb);
  assert.equal(plain.level1.length, 1);
  assert.equal(plain.level2.length, 1);
  assert.equal(plain.level3.length, 0);
  assert.equal(plain.level4.length, 0);

  task.kbLevels = [1, 2, 3];
  assert.equal(resolveKb(board, task, kb).level3.length, 1);

  // 禁忌节点连线
  board.nodes.push({ id: 'k', type: 'kb', level: 3, text: '连线来的约束', title: '节点', x: 0, y: 0 });
  board.edges.push({ id: 'e', from: 'k', to: task.id, kind: 'constraint' });
  assert.equal(resolveKb(board, task, kb).level3.length, 2);
  assert.equal(level1Entries(kb).length, 1);
});

test('计划落图：节点、派发连线与依赖顺序', () => {
  const board = createBoard({ name: '流程' });
  const plan = parsePlan(`<orchestra-plan>${JSON.stringify({ tasks: [
    { title: '甲', acceptance: ['a'] },
    { title: '乙', dependsOn: ['甲'], acceptance: ['b'] },
  ] })}</orchestra-plan>`);
  const created = applyPlan(board, plan.tasks);
  assert.equal(created.length, 2);
  assert.equal(board.edges.filter((edge) => edge.kind === 'dispatch').length, 2);
  assert.equal(board.edges.filter((edge) => edge.kind === 'depends').length, 1);
  const [first, second] = created;
  assert.deepEqual(dependenciesOf(board, second).map((node) => node.id), [first.id]);
  assert.equal(isRunnable(board, second), false);
  first.status = 'passed';
  assert.equal(isRunnable(board, second), true);
});

test('整图保存只覆盖可编辑字段，运行态以服务端为准', () => {
  const board = createBoard({ name: '板' });
  const task = newTaskNode({ title: '原任务', x: 10, y: 20 });
  task.status = 'running';
  task.childSessionId = 'session-x';
  task.result = { status: 'done', summary: '结果' };
  board.nodes.push(task);

  sanitizeGraph(board, {
    nodes: [
      { id: board.nodes[0].id, type: 'master', x: 0, y: 0, title: '总对话' },
      { id: task.id, type: 'task', x: 99, y: 88, title: '改名', status: 'passed', childSessionId: '伪造', goal: '新目标' },
    ],
    edges: [],
  });
  const saved = board.nodes.find((node) => node.id === task.id);
  assert.equal(saved.x, 99);
  assert.equal(saved.title, '改名');
  assert.equal(saved.goal, '新目标');
  assert.equal(saved.status, 'running');
  assert.equal(saved.childSessionId, 'session-x');
  assert.equal(saved.result.summary, '结果');
});

test('知识库：内置一级锁定不可删，新增条目可删', () => {
  const state = defaultState();
  assert.throws(() => removeKbEntry(state, 'kb-l1-1'), /不可删除/);
  const entry = addKbEntry(state, { level: 2, title: '临时', text: '内容' });
  assert.equal(state.kb.filter((item) => item.id === entry.id).length, 1);
  removeKbEntry(state, entry.id);
  assert.equal(state.kb.filter((item) => item.id === entry.id).length, 0);
});

test('store：落盘、重读、串行写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestra-store-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  resetCache();
  try {
    await loadAndSeed();
    const first = await snapshot();
    assert.equal(first.boards.length, 0);
    await mutate((state) => {
      state.boards.push(createBoard({ name: '持久化' }));
    });
    await mutate((state) => {
      state.settings.defaultCwd = 'D:\\x';
    });
    resetCache();
    const reloaded = await snapshot();
    assert.equal(reloaded.boards[0].name, '持久化');
    assert.equal(reloaded.settings.defaultCwd, 'D:\\x');
    assert.ok(dataFile().startsWith(dir));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    resetCache();
    await rm(dir, { recursive: true, force: true });
  }
});

async function loadAndSeed() {
  // 第一次读会创建默认文件
  const { loadState } = await import('../lib/store.js');
  return loadState();
}

test('会话消息：跳过运行时上下文与技能目录，保留真实问答', () => {
  const events = [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真实提问' }] } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder><available_skills>' }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答' }] } } },
  ];
  const messages = eventsToMessages(events, 10);
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(messages[0].text, '真实提问');
  assert.equal(assistantTextBetween(events, 0, 3), '回答');
});
