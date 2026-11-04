/**
 * 会话桥：把「总对话 / 子对话」这样的业务概念落到 DSH 的真实 Session 上。
 *
 * 只用公开面：
 *   ctx.sessionController.create / prompt / inspect / list
 *   ctx.sessions.get / ctx.sessions.list
 *   ctx.on('session/event', (session, event) => …)
 *
 * 子对话是普通 Session（不是 subagent），因此天然看不到总对话、也看不到兄弟任务；
 * 它们之间没有任何消息通道。跨任务信息由编排台显式写进任务书。
 */
import { randomUUID } from 'node:crypto';

const INJECTED_USER_SOURCE_KINDS = new Set(['skill-catalog']);
const RUNTIME_CONTEXT_OPENER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.';
const SKILL_CATALOG_OPENER = '<system-reminder>';
const SKILL_CATALOG_MARKER = '<available_skills>';

export function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      if (block?.type === 'text') return [block.text];
      if (block?.type === 'tool-call') return [block.name, block.arguments];
      if (block?.type === 'tool-result') return contentText(block.content);
      return [];
    })
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join('\n');
}

export function isInjectedUserEvent(event) {
  const source = event?.data?.source;
  if (typeof source?.kind === 'string' && INJECTED_USER_SOURCE_KINDS.has(source.kind)) return true;
  const text = contentText(event?.data?.content);
  if (text.trimStart().startsWith(RUNTIME_CONTEXT_OPENER)) return true;
  if (text.trimStart().startsWith(SKILL_CATALOG_OPENER) && text.includes(SKILL_CATALOG_MARKER)) return true;
  return false;
}

function eventTime(event) {
  const value = event?.at ?? event?.time ?? event?.data?.at;
  return Number.isFinite(value) ? value : 0;
}

/** 从事件流里取聊天消息（跳过 harness 自己注入的运行时上下文/技能目录）。 */
export function eventsToMessages(events, limit = 40) {
  const messages = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'user/message') {
      if (isInjectedUserEvent(event)) continue;
      const text = contentText(event.data?.content).trim();
      if (text === '') continue;
      messages.push({ role: 'user', text, seq: event.seq, at: eventTime(event) });
      continue;
    }
    if (event?.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content).trim();
      if (text === '') continue;
      messages.push({ role: 'assistant', text, seq: event.seq, at: eventTime(event) });
      continue;
    }
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason;
      if (reason?.kind === 'error') {
        messages.push({ role: 'system', text: `本轮执行失败：${reason.error?.message ?? '未知错误'}`, seq: event.seq, at: eventTime(event) });
      }
    }
  }
  return messages.slice(-Math.max(1, limit));
}

/** 取一段序号区间内 assistant 的文本（用于解析结果/计划/复核）。 */
export function assistantTextBetween(events, fromExclusive, toInclusive) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.type === 'assistant/message' && event.seq > fromExclusive && (toInclusive === undefined || event.seq <= toInclusive))
    .map((event) => contentText(event.data?.message?.content))
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

function basename(path) {
  if (typeof path !== 'string' || path.trim() === '') return '';
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

export class SessionBridge {
  constructor(ctx, { onEvent } = {}) {
    this.ctx = ctx;
    this.waiters = new Set();
    this.listeners = new Set();
    this.running = new Map();
    this.onEventHook = onEvent;
  }

  service() {
    const service = this.ctx.get('sessionController');
    if (service === undefined) {
      throw new Error('找不到 sessionController：当前部署没有挂载会话控制器，编排台无法创建或驱动会话');
    }
    return service;
  }

  /** host 侧 session/event 监听转进来。 */
  notify(session, event) {
    if (event?.type === 'turn/start') this.running.set(session.id, true);
    if (event?.type === 'turn/end') this.running.set(session.id, false);
    for (const waiter of [...this.waiters]) {
      try {
        waiter.onEvent?.(session, event);
      } catch {
        // 单个 waiter 的错误不影响其它观察者
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(session, event);
      } catch {
        // 观察者异常不应打断事件流
      }
    }
    this.onEventHook?.(session, event);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(sessionId) {
    const live = this.ctx.sessions.get(sessionId);
    if (live !== undefined && this.running.has(sessionId)) return this.running.get(sessionId) === true;
    return this.running.get(sessionId) === true;
  }

  titleOf(sessionId) {
    const live = this.ctx.sessions.get(sessionId);
    if (live === undefined) return '';
    try {
      const snapshot = this.ctx.get('sessionProjections')?.snapshot(live);
      const title = snapshot?.values?.title;
      return typeof title === 'string' ? title : '';
    } catch {
      return '';
    }
  }

  async lastSeq(sessionId) {
    const live = this.ctx.sessions.get(sessionId);
    if (live !== undefined) return Number.isFinite(live.seq) ? live.seq : 0;
    const inspected = await this.inspect(sessionId);
    const events = inspected?.events ?? [];
    return events.length === 0 ? -1 : events[events.length - 1].seq;
  }

  async inspect(sessionId) {
    return this.service().inspect(sessionId);
  }

  async listSessions(limit = 60) {
    // 用 Host 的 live Session 列表：它是本进程当前持有的会话（当前对话、本插件创建的子对话都在），
    // 不依赖 Remote 端的 listState 注入，也不会因为冷日志迁移而失败。
    const live = this.ctx.sessions.list();
    return live
      .slice(0, limit)
      .map((session) => ({
        id: session.id,
        title: this.titleOf(session.id) || basename(session.header?.cwd) || session.id.slice(0, 10),
        cwd: session.header?.cwd ?? '',
        running: this.running.get(session.id) === true,
        updatedAt: session.header?.createdAt ?? 0,
        parentSessionId: session.header?.parentSession ?? '',
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async createChild({ cwd } = {}) {
    const request = cwd !== undefined && cwd.trim() !== '' ? { cwd: cwd.trim() } : {};
    const created = await this.service().create(request);
    return created.sessionId;
  }

  async prompt(sessionId, text, requestId = randomUUID()) {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('消息不能为空');
    const controller = new AbortController();
    const accepted = await this.service().prompt(
      {
        sessionId,
        content: [{ type: 'text', text }],
        mode: 'queue',
        requestId,
      },
      controller.signal,
    );
    if (accepted?.accepted !== true) throw new Error('DSH 没有接受这条消息');
    return requestId;
  }

  /**
   * 发一条消息并等这一轮结束，返回这一轮 assistant 的文本与事件区间。
   * 用 requestId → user/message.source.rpcId 对齐，避免把上一轮的 turn/end 当成本轮。
   */
  async promptAndWait(sessionId, text, { timeoutMs = 240000 } = {}) {
    const requestId = randomUUID();
    const waiter = this.createWaiter(sessionId, requestId, timeoutMs);
    try {
      await this.prompt(sessionId, text, requestId);
      const settled = await waiter.promise;
      return await this.readTurn(sessionId, settled);
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  createWaiter(sessionId, requestId, timeoutMs) {
    let settled = false;
    let timer = null;
    let userSeq = null;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      this.waiters.delete(waiter);
      fn(value);
    };
    const waiter = {
      sessionId,
      requestId,
      onEvent: (session, event) => {
        if (session.id !== sessionId) return;
        if (userSeq === null) {
          if (event.type === 'user/message' && event.data?.source?.rpcId === requestId) {
            userSeq = event.seq;
          }
          return;
        }
        if (event.type === 'turn/end' && event.seq > userSeq) {
          finish(resolvePromise, { userSeq, endSeq: event.seq, requestId });
        }
      },
      cancel: () => finish(rejectPromise, new Error('已取消')),
      promise,
    };
    timer = setTimeout(() => finish(rejectPromise, new Error(`等待会话回复超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    this.waiters.add(waiter);
    return waiter;
  }

  /** 等这一轮结束，再读事件（事件可能比 inspect 快照晚一拍，重试几次）。 */
  async readTurn(sessionId, { userSeq, endSeq }) {
    let inspected = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      inspected = await this.inspect(sessionId);
      const events = inspected?.events ?? [];
      if (events.some((event) => event.seq >= endSeq)) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const events = inspected?.events ?? [];
    return { events, text: assistantTextBetween(events, userSeq, endSeq) };
  }
}
