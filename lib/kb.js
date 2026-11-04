/**
 * 分级知识库。
 *
 *   1 级 = 最高等级禁忌，所有严格对话（总对话 + 每个子对话）无条件带上，不可关闭；
 *   2 级 = 项目禁忌，同一个编排板里的每个子任务都带上；
 *   3 级 = 任务约束，按任务勾选或由禁忌节点连线附加；
 *   4 级 = 参考资料，只在任务显式引用时带上，不算禁令。
 *
 * 存储里只放文本；渲染成提示词的部分集中在 renderKbSections()。
 */
import { randomUUID } from 'node:crypto';

export const LEVELS = [
  { level: 1, name: '一级禁忌', short: 'L1', tone: 'critical', description: '最高等级。总对话与每个子对话都必须遵守，不可关闭。' },
  { level: 2, name: '二级禁忌', short: 'L2', tone: 'warning', description: '项目级禁忌。同一编排板里的每个子任务都带上。' },
  { level: 3, name: '三级约束', short: 'L3', tone: 'info', description: '任务级约束。按任务勾选，或从禁忌节点连线附加。' },
  { level: 4, name: '参考资料', short: 'L4', tone: 'muted', description: '知识/背景，只在任务显式引用时附带，不算禁令。' },
];

export function levelMeta(level) {
  return LEVELS.find((item) => item.level === level) ?? LEVELS[0];
}

export function levelLabel(level) {
  return levelMeta(level).name;
}

export function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    if (left.level !== right.level) return left.level - right.level;
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.title.localeCompare(right.title, 'zh-Hans-CN');
  });
}

/** 只留文本非空、确实存在于知识库里的条目。 */
function usable(entries) {
  return entries.filter((entry) => entry !== undefined && entry !== null && typeof entry.text === 'string' && entry.text.trim() !== '');
}

function entryFromNode(node) {
  if (node === null || typeof node !== 'object') return undefined;
  if (node.kbId !== undefined && node.kbId !== '') return undefined;
  const text = typeof node.text === 'string' ? node.text.trim() : '';
  if (text === '') return undefined;
  return {
    id: `node:${node.id}`,
    level: Number.isInteger(node.level) ? node.level : 3,
    title: typeof node.title === 'string' && node.title.trim() !== '' ? node.title.trim() : '来自节点的约束',
    text,
    tags: [],
    locked: false,
    enabled: true,
    nodeId: node.id,
  };
}

/**
 * 计算一个任务实际生效的知识库条目。
 * @param {object} board 编排板（用到 nodes / edges）
 * @param {object} task 任务节点
 * @param {Array<object>} kb 全量知识库
 */
export function resolveKb(board, task, kb) {
  const byId = new Map(kb.map((entry) => [entry.id, entry]));
  const explicit = new Set(Array.isArray(task?.kbIds) ? task.kbIds : []);
  const levels = new Set(Array.isArray(task?.kbLevels) ? task.kbLevels : [1, 2]);

  // 从「禁忌节点 / 便签节点」连到本任务的线，等于把该节点的文本附到任务上。
  const attached = [];
  for (const edge of Array.isArray(board?.edges) ? board.edges : []) {
    if (edge?.to !== task?.id) continue;
    if (edge.kind !== 'constraint') continue;
    const node = (board.nodes ?? []).find((candidate) => candidate.id === edge.from);
    if (node === undefined) continue;
    const linked = node.kbId !== undefined && node.kbId !== '' ? byId.get(node.kbId) : undefined;
    if (linked !== undefined) explicit.add(linked.id);
    else {
      const derived = entryFromNode(node);
      if (derived !== undefined) attached.push(derived);
    }
  }

  const take = (level) => {
    if (level === 1) return sortEntries(usable(kb.filter((entry) => entry.level === 1)));
    if (level === 2) return sortEntries(usable(kb.filter((entry) => entry.level === 2 && entry.enabled !== false)));
    const picked = [];
    if (levels.has(level)) {
      for (const entry of kb) if (entry.level === level && entry.enabled !== false) picked.push(entry);
    }
    for (const id of explicit) {
      const entry = byId.get(id);
      if (entry !== undefined && entry.level === level && entry.enabled !== false) picked.push(entry);
    }
    return sortEntries(usable(attached.filter((entry) => entry.level === level)).concat(usable(picked)));
  };

  return {
    level1: take(1),
    level2: take(2),
    level3: take(3),
    level4: sortEntries(usable(attached.filter((entry) => entry.level >= 4))).concat(
      sortEntries(usable(kb.filter((entry) => entry.level === 4 && explicit.has(entry.id) && entry.enabled !== false))),
    ),
  };
}

/** 只取一级禁忌：用于全局系统提示注入。 */
export function level1Entries(kb) {
  return sortEntries(usable(kb.filter((entry) => entry.level === 1)));
}

function renderList(entries) {
  return entries.map((entry) => `- ${entry.title}：${entry.text}`).join('\n');
}

/**
 * 渲染成提示词块。空等级不产生标题，避免给模型一堆空壳。
 * @param {{level1:Array,level2:Array,level3:Array,level4:Array}} resolved
 * @param {{includeReference?: boolean}} options
 */
export function renderKbSections(resolved, options = {}) {
  const blocks = [];
  if (resolved.level1.length > 0) {
    blocks.push(`### 一级禁忌（最高等级 · 违反任意一条即视为本次执行失败）\n${renderList(resolved.level1)}`);
  }
  if (resolved.level2.length > 0) {
    blocks.push(`### 二级禁忌（本项目所有任务共同遵守）\n${renderList(resolved.level2)}`);
  }
  if (resolved.level3.length > 0) {
    blocks.push(`### 三级约束（本任务附加）\n${renderList(resolved.level3)}`);
  }
  if (options.includeReference !== false && resolved.level4.length > 0) {
    blocks.push(`### 参考资料（背景知识，不是禁令）\n${renderList(resolved.level4)}`);
  }
  return blocks.join('\n\n');
}

export function renderLevel1Global(kb) {
  const entries = level1Entries(kb);
  if (entries.length === 0) return '';
  return [
    '## 全局禁忌（一级 · 最高优先级）',
    '以下禁忌适用于每一个严格对话（包括所有子对话）；违反任意一条，该次执行都算失败。',
    renderList(entries),
  ].join('\n');
}

export function validateKbInput(input, { partial = false } = {}) {
  const patch = {};
  if (!partial || input.level !== undefined) {
    const level = Number(input.level);
    if (!Number.isInteger(level) || level < 1 || level > 4) throw new Error('level 必须是 1–4 的整数');
    patch.level = level;
  }
  if (!partial || input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title === '') throw new Error('title 不能为空');
    patch.title = title.slice(0, 80);
  }
  if (!partial || input.text !== undefined) {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text === '') throw new Error('text 不能为空');
    patch.text = text.slice(0, 4000);
  }
  if (input.tags !== undefined) {
    patch.tags = Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim()).slice(0, 8) : [];
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled !== false;
  return patch;
}

export function addKbEntry(state, input) {
  const patch = validateKbInput(input);
  const entry = {
    id: `kb-${randomUUID()}`,
    ...patch,
    tags: patch.tags ?? [],
    locked: false,
    enabled: patch.enabled !== false,
    createdAt: Date.now(),
  };
  state.kb.push(entry);
  return entry;
}

export function updateKbEntry(state, id, input) {
  const entry = state.kb.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error('知识库条目不存在');
  const patch = validateKbInput(input, { partial: true });
  if (entry.locked && patch.level !== undefined && patch.level !== 1) {
    throw new Error('内置一级禁忌不能降级；可以修改文本，或新增低等级条目');
  }
  Object.assign(entry, patch);
  return entry;
}

export function removeKbEntry(state, id) {
  const index = state.kb.findIndex((candidate) => candidate.id === id);
  if (index < 0) throw new Error('知识库条目不存在');
  if (state.kb[index].locked) throw new Error('一级内置禁忌不可删除；可以修改文本，或新增条目');
  state.kb.splice(index, 1);
}

export function kbStats(kb) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const entry of kb) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
  return counts;
}
