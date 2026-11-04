/**
 * 任务书与验收的文本协议。
 *
 * 这里是整个插件里唯一「模型看什么」的地方：
 *   composePlanPrompt   总对话拆解任务
 *   composeTaskBrief    给隔离子对话的任务书（边界 + 验收 + 分级禁忌 + 结果格式）
 *   composeVerifyPrompt 总对话按验收标准复核结果
 *   composeFollowupPrompt 驳回后打回给同一个子对话
 * 以及把模型输出解析回结构化 JSON。
 *
 * 设计约束：子对话拿不到总对话上下文，也拿不到兄弟任务；所有跨任务信息
 * 都必须由编排台显式转交，并在文本里写明「这是总对话转交的」。
 */
import { renderKbSections, resolveKb } from './kb.js';

const RESULT_TAG = 'orchestra-result';
const PLAN_TAG = 'orchestra-plan';
const VERDICT_TAG = 'orchestra-verdict';

function limit(text, max) {
  if (typeof text !== 'string') return '';
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function bullets(items) {
  return items
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item, index) => `${index + 1}. ${item.trim()}`)
    .join('\n');
}

/**
 * 总对话的拆解提示。
 * @param {object} params
 * @param {object} params.board
 * @param {Array<object>} params.kb
 * @param {string} [params.hint] 用户补充的拆解偏好
 * @param {Array<object>} [params.resolved] 已解析的知识库分组
 */
export function composePlanPrompt({ board, kb, resolved, hint = '' }) {
  const sections = resolved === undefined ? '' : renderKbSections(resolved, { includeReference: false });
  return [
    '你是编排台的「总对话」。你的职责不是亲自把事情做完，而是把目标拆成若干可独立交付、可独立验收的子任务。',
    '',
    `【编排板】${board.name || '未命名'}${board.cwd ? `\n【工作目录】${board.cwd}` : ''}`,
    `【总目标】${board.goal?.trim() || '（未填写，请按编排板名称推断）'}`,
    sections === '' ? '' : `\n${sections}`,
    hint.trim() === '' ? '' : `\n【本次拆解偏好】${hint.trim()}`,
    '',
    '【拆分规则】',
    '1. 拆成 3–7 个子任务；每个子任务必须能由一个「看不到本对话、也看不到其他子任务」的独立子对话完成。',
    '2. 每个任务只做一件事，并且能在一个回合内交付；不要把同一个文件/模块的多次修改拆给两个任务。',
    '3. 任务之间需要前置成果时，用 dependsOn 指明依赖；依赖只传递「结果摘要」，不是让两个子对话直接交流。',
    '4. boundary 要写清三件事：只处理什么、绝对不要碰什么、允许使用哪些输入。',
    '5. acceptance 是 3–6 条可客观检查的验收标准，必须能对照结果逐条判定通过或不通过；不要写「质量好」这类主观标准。',
    '6. 一级禁忌是硬约束；如果某个任务会触碰一级禁忌，改成不触碰的写法，或把它标成 blocked 风险。',
    '7. 任务标题用中文短语，不超过 20 字；不要输出解释、前言或 markdown 表格。',
    '',
    '【输出格式】只输出下面这一个块，不要有其他文字：',
    `<${PLAN_TAG}>`,
    '{"tasks":[{"title":"任务标题","goal":"要达成什么","boundary":"只处理…；不要碰…；输入只有…","inputs":"需要的材料/文件/上下文","deliverables":"交付物与格式","acceptance":["验收标准1","验收标准2"],"dependsOn":["前置任务标题"],"kbLevels":[1,2]}]}',
    `</${PLAN_TAG}>`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 给隔离子对话的任务书。
 * @param {object} params
 * @param {object} params.board
 * @param {object} params.task
 * @param {Array<object>} params.kb
 * @param {Array<object>} [params.predecessors] 已完成的前置任务（含 result）
 * @param {string} [params.roundNote] 驳回后重做的说明
 */
export function composeTaskBrief({ board, task, kb, predecessors = [], roundNote = '' }) {
  const resolved = resolveForTask(board, task, kb);
  const kbText = renderKbSections(resolved, { includeReference: true });
  const acceptance = bullets(Array.isArray(task.acceptance) ? task.acceptance : []);
  const deps = predecessors
    .map((item) => {
      const summary = typeof item.result?.summary === 'string' && item.result.summary.trim() !== '' ? item.result.summary.trim() : '（前置任务没有留下摘要）';
      return `- ${item.title}：${limit(summary, 1500)}`;
    })
    .join('\n');

  return [
    '你是一个被「总对话」派发的独立子对话。你没有、也无法获得总对话或其他子对话的上下文。',
    '',
    '【隔离规则 · 必须遵守】',
    '- 你只能看到这一份任务书；不要询问、等待或试图联系其他子对话，它们与你互不可见。',
    '- 所有跨任务信息都已经由总对话写进本任务书；缺信息时在结果里写「阻塞原因」，不要自行猜测或扩大范围。',
    '- 结束后只向总对话提交一份结果报告，不要输出额外的寒暄或过程流水账。',
    '',
    `【编排板】${board.name || '未命名'}${board.cwd ? `\n【工作目录】${board.cwd}` : ''}`,
    `【任务】${task.title}`,
    `【目标】${task.goal?.trim() || task.title}`,
    task.boundary?.trim() ? `【边界】\n${task.boundary.trim()}` : '【边界】只做本任务目标内的事；不要顺手改其他内容。',
    task.inputs?.trim() ? `【输入】\n${task.inputs.trim()}` : '',
    task.deliverables?.trim() ? `【交付物】\n${task.deliverables.trim()}` : '',
    '',
    '【验收标准 · 逐条自检，并在结果里给出证据】',
    acceptance === '' ? '1. 按目标完成，并说明改了/产出了什么。' : acceptance,
    roundNote.trim() === '' ? '' : `\n【上一轮被驳回】\n${roundNote.trim()}\n请针对上述问题重做，不要重复已经通过的部分。`,
    kbText === '' ? '' : `\n${kbText}`,
    deps === '' ? '' : `\n【前置任务结果 · 由总对话转交给你，不是你与其他子对话通信得到的】\n${deps}`,
    '',
    '【结果报告】完成（或确认无法完成）后，最后只输出一个块，不要有其他文字：',
    `<${RESULT_TAG}>`,
    '{"status":"done|blocked|failed","summary":"做了什么、结果如何（不超过 800 字）","artifacts":["产出文件或路径"],"checks":[{"criterion":"验收标准原文","pass":true,"evidence":"证据"}]}',
    `</${RESULT_TAG}>`,
    'status 用 done 表示完成并自检通过；blocked 表示缺信息/缺权限；failed 表示尝试过但失败。不要虚报。',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function resolveForTask(board, task, kb) {
  return resolveKb(board, task, kb);
}

/**
 * 总对话复核：只判验收，不重做任务。
 */
export function composeVerifyPrompt({ board, task, kb }) {
  const resolved = resolveForTask(board, task, kb);
  const kbText = renderKbSections(resolved, { includeReference: false });
  const acceptance = bullets(Array.isArray(task.acceptance) ? task.acceptance : []);
  const result = task.result ?? {};
  const checks = Array.isArray(result.checks)
    ? result.checks.map((check) => `- ${check.criterion ?? '-'}：${check.pass === true ? '自检通过' : '自检未通过'}（${check.evidence ?? '无证据'}）`).join('\n')
    : '（子对话没有给出逐条自检）';

  return [
    '你是编排台的「总对话」。现在只做一件事：按验收标准复核一个隔离子对话的结果，并给出结论。',
    '不要重做任务，不要修改验收标准，也不要因为结果写得漂亮就放过没有证据的条目。',
    '',
    `【任务】${task.title}`,
    `【目标】${task.goal ?? ''}`,
    acceptance === '' ? '' : `【验收标准】\n${acceptance}`,
    kbText === '' ? '' : `\n${kbText}`,
    '',
    `【子对话报告】\nstatus: ${result.status ?? 'unknown'}\nsummary: ${limit(result.summary ?? '', 4000)}\nartifacts: ${JSON.stringify(result.artifacts ?? [])}`,
    `【子对话自检】\n${checks}`,
    '',
    '【判定规则】',
    '- 每条验收标准都必须有证据；没有证据就判不通过。',
    '- 只要有一条不通过，verdict 就是 fail，并写清要打回修改的最小范围。',
    '- pass 时也要给出证据摘要，方便人工复核。',
    '',
    '【输出格式】只输出一个块：',
    `<${VERDICT_TAG}>`,
    '{"verdict":"pass|fail","score":0,"checks":[{"criterion":"验收标准原文","pass":true,"evidence":"证据或缺口"}],"reasons":["理由"],"followup":"打回时给子对话的最小修改要求（pass 时留空）"}',
    `</${VERDICT_TAG}>`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** 驳回后打回给同一个子对话。 */
export function composeFollowupPrompt({ task, note }) {
  return [
    '【总对话复核：未通过】',
    note?.trim() === '' ? '请按原验收标准重新检查并修正未通过的部分。' : note.trim(),
    '',
    '只修改上述问题涉及的范围，不要顺手改其他内容，也不要删除已经通过的成果。',
    '完成后重新输出结果报告：',
    `<${RESULT_TAG}>`,
    '{"status":"done|blocked|failed","summary":"本轮修正了什么","artifacts":[],"checks":[{"criterion":"验收标准原文","pass":true,"evidence":"证据"}]}',
    `</${RESULT_TAG}>`,
  ].join('\n');
}

/** 从任意文本里抠出带标签的 JSON；容忍代码围栏与前后废话。 */
export function extractTaggedJson(text, tag) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const tagged = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i').exec(text);
  const candidates = [];
  if (tagged !== null) candidates.push(tagged[1]);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced !== null) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(stripFence(candidate));
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

function stripFence(value) {
  return String(value)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringList(value, maxItems, maxLength) {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value.trim() !== '' ? [value] : [];
  return list
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '')
    .slice(0, maxItems)
    .map((item) => (item.length > maxLength ? `${item.slice(0, maxLength)}…` : item));
}

/**
 * 解析计划。返回 { tasks, warnings }，tasks 里带 dependsOnTitles 与规范化字段。
 * 解析失败抛错，由调用方转成任务失败。
 */
export function parsePlan(text, { maxTasks = 8 } = {}) {
  const parsed = extractTaggedJson(text, PLAN_TAG);
  if (parsed === null) throw new Error('总对话没有输出可解析的计划（缺少 <orchestra-plan> JSON）');
  const rawTasks = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tasks) ? parsed.tasks : [];
  if (rawTasks.length === 0) throw new Error('计划里没有 tasks');
  const warnings = [];
  const tasks = rawTasks.slice(0, maxTasks).map((raw, index) => {
    const title = asString(raw?.title, '') || `任务 ${index + 1}`;
    const acceptance = asStringList(raw?.acceptance, 8, 500);
    if (acceptance.length === 0) warnings.push(`任务「${title}」没有验收标准，已补一条默认标准`);
    return {
      title: title.slice(0, 80),
      goal: asString(raw?.goal, title).slice(0, 2000),
      boundary: asString(raw?.boundary, '').slice(0, 4000),
      inputs: asString(raw?.inputs, '').slice(0, 2000),
      deliverables: asString(raw?.deliverables, '').slice(0, 2000),
      acceptance: acceptance.length > 0 ? acceptance : ['按目标完成，并逐条说明完成情况'],
      dependsOnTitles: asStringList(raw?.dependsOn, 8, 80),
      kbLevels: normalizeLevels(raw?.kbLevels),
    };
  });
  const byTitle = new Map(tasks.map((task, index) => [normalizeTitle(task.title), index]));
  tasks.forEach((task, index) => {
    task.dependsOn = [];
    for (const dep of task.dependsOnTitles) {
      let target = byTitle.get(normalizeTitle(dep));
      if (target === undefined && /^\d+$/.test(dep)) {
        const candidate = Number(dep) - 1;
        if (candidate >= 0 && candidate < tasks.length) target = candidate;
      }
      if (target === undefined || target === index) {
        if (target !== undefined) warnings.push(`任务「${task.title}」的依赖指向了自己，已忽略`);
        continue;
      }
      task.dependsOn.push(target);
    }
    task.dependsOn = [...new Set(task.dependsOn)];
  });
  breakCycles(tasks, warnings);
  return { tasks, warnings };
}

function normalizeTitle(value) {
  return String(value).replace(/\s+/g, '').toLowerCase();
}

function normalizeLevels(value) {
  const list = Array.isArray(value) ? value : [1, 2];
  const levels = list.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 1 && item <= 4);
  return levels.length > 0 ? [...new Set(levels)].sort((a, b) => a - b) : [1, 2];
}

function breakCycles(tasks, warnings) {
  // 去掉让任务回到自身祖先的依赖边；计划最多 8 个任务，深搜足够。
  for (let index = 0; index < tasks.length; index += 1) {
    const keep = [];
    for (const dep of tasks[index].dependsOn) {
      if (reaches(tasks, dep, index, new Set())) {
        warnings.push(`检测到循环依赖：${tasks[index].title} → ${tasks[dep].title}，已移除这条依赖`);
      } else {
        keep.push(dep);
      }
    }
    tasks[index].dependsOn = keep;
  }
}

function reaches(tasks, from, target, seen) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (tasks[from]?.dependsOn ?? []).some((next) => reaches(tasks, next, target, seen));
}

/** 解析子对话结果；没有标签时把最后一段文字当作摘要。 */
export function parseResult(text, { fallbackSummary = '' } = {}) {
  const parsed = extractTaggedJson(text, RESULT_TAG);
  if (parsed !== null) {
    const status = ['done', 'blocked', 'failed'].includes(parsed.status) ? parsed.status : 'done';
    return {
      status,
      summary: asString(parsed.summary, '').slice(0, 8000) || fallbackSummary,
      artifacts: asStringList(parsed.artifacts, 20, 300),
      checks: normalizeChecks(parsed.checks),
      raw: text,
      parsed: true,
    };
  }
  return {
    status: 'done',
    summary: (asString(text, '') || fallbackSummary).slice(0, 8000),
    artifacts: [],
    checks: [],
    raw: text,
    parsed: false,
  };
}

function normalizeChecks(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((check) => ({
    criterion: asString(check?.criterion, '').slice(0, 500),
    pass: check?.pass === true,
    evidence: asString(check?.evidence, '').slice(0, 2000),
  }));
}

/** 解析总对话复核结论。 */
export function parseVerdict(text) {
  const parsed = extractTaggedJson(text, VERDICT_TAG);
  if (parsed === null) throw new Error('总对话没有输出可解析的复核结论（缺少 <orchestra-verdict> JSON）');
  const verdict = parsed.verdict === 'pass' ? 'pass' : 'fail';
  return {
    verdict,
    score: Number.isFinite(Number(parsed.score)) ? Math.max(0, Math.min(100, Math.round(Number(parsed.score)))) : verdict === 'pass' ? 100 : 0,
    checks: normalizeChecks(parsed.checks),
    reasons: asStringList(parsed.reasons, 8, 1000),
    followup: asString(parsed.followup, '').slice(0, 2000),
    raw: text,
  };
}

/** 给总对话的完成通知（作为一条普通用户消息送进总对话，唤醒它继续）。 */
export function composeCompletionNotice({ board, task }) {
  const result = task.result ?? {};
  return [
    '【编排台 · 子任务完成】',
    `任务：${task.title}`,
    `状态：${result.status ?? 'unknown'}`,
    `摘要：${limit(result.summary ?? '（无摘要）', 1500)}`,
    '',
    '这条消息由编排台自动发送。你可以：查看结果、按验收标准复核、决定通过或打回重做。',
    `画布节点：${task.title}（board: ${board.name}）`,
  ].join('\n');
}

export { RESULT_TAG, PLAN_TAG, VERDICT_TAG };
