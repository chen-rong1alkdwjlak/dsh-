/**
 * 编排台 —— 画布前端（纯 DOM + SVG，无构建步骤）。
 *
 * 与宿主半区只走 /orchestra/api；与 DSH 页面的桥接只走 postMessage：
 *   - 父窗口 → 这里：orchestra:current-session / orchestra:theme
 *   - 这里 → 父窗口：orchestra:open-session / orchestra:request-current / orchestra:ready
 */
(() => {
  'use strict';

  const API = '/orchestra/api';
  const SOURCE = 'dsh-orchestra';
  const LEVELS = {
    1: { name: '一级禁忌', short: 'L1', tone: 'critical', hint: '最高等级，总对话与每个子对话强制遵守' },
    2: { name: '二级禁忌', short: 'L2', tone: 'warning', hint: '本项目所有任务共同遵守' },
    3: { name: '三级约束', short: 'L3', tone: 'info', hint: '按任务勾选或由禁忌节点连线附加' },
    4: { name: '参考资料', short: 'L4', tone: 'muted', hint: '背景知识，只在任务引用时附带' },
  };
  const STATUS = {
    draft: { label: '待派发', tone: 'muted' },
    dispatching: { label: '正在派发', tone: 'info' },
    running: { label: '子对话运行中', tone: 'info' },
    review: { label: '待验收', tone: 'warning' },
    passed: { label: '已通过', tone: 'ok' },
    rejected: { label: '已驳回', tone: 'danger' },
    error: { label: '出错', tone: 'danger' },
  };
  const EDGE_COLOR = { dispatch: 'var(--accent)', depends: 'var(--line-strong)', constraint: 'var(--warn)', result: 'var(--ok)' };

  const S = {
    home: null,
    board: null,
    boardId: '',
    selectedId: '',
    selectedEdgeId: '',
    camera: { x: 60, y: 40, k: 1 },
    dirty: false,
    revision: 0,
    saving: false,
    saveTimer: null,
    planning: false,
    showArchived: false,
    job: null,
    jobTimer: null,
    followTimer: null,
    bridgeSession: null,
    sessions: [],
    sessionsLoaded: false,
    chat: { open: false, target: 'master', sessionId: '', messages: [], running: false, lastSeq: -1, loading: false },
    modal: null,
    toastTimer: null,
    dragging: false,
    wire: null,
    pollBusy: false,
    fitted: new Set(),
  };

  const D = {};

  /* ───────────────────────────── 基础工具 ───────────────────────────── */

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'text') el.textContent = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    // textarea 的 value 不是 HTML 属性；input/select 也用属性更可靠地初始化。
    if (props && props.value !== undefined && (tag === 'textarea' || tag === 'input' || tag === 'select')) el.value = props.value;
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      el.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
    return el;
  }

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function fmtTime(value) {
    if (!Number.isFinite(value) || value <= 0) return '';
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function short(text, max = 80) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  function basename(path) {
    if (typeof path !== 'string' || path.trim() === '') return '';
    const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] ?? '';
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
    return data ?? {};
  }

  function toast(message, tone = '') {
    if (D.toast === undefined) return;
    D.toast.textContent = message;
    D.toast.className = `toast show ${tone}`;
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => {
      D.toast.className = 'toast';
    }, tone === 'error' ? 5200 : 3000);
  }

  function postToParent(type, payload = {}) {
    try {
      window.parent?.postMessage({ source: SOURCE, type, ...payload }, window.location.origin);
    } catch {
      // 独立打开时没有父窗口
    }
  }

  function storedFollow(boardId) {
    try {
      const value = window.localStorage.getItem(`dsh-orchestra:follow:${boardId}`);
      return value === null ? null : value !== '0';
    } catch {
      return null;
    }
  }

  function storeFollow(boardId, value) {
    try {
      window.localStorage.setItem(`dsh-orchestra:follow:${boardId}`, value ? '1' : '0');
    } catch {
      // 隐私模式忽略
    }
  }

  function statusOf(status) {
    return STATUS[status] ?? STATUS.draft;
  }

  function nodeWidth(node) {
    return node.type === 'master' ? 290 : node.type === 'task' ? 268 : node.type === 'kb' ? 236 : 220;
  }

  function nodeById(id) {
    return S.board?.nodes.find((node) => node.id === id);
  }

  function taskNodes() {
    return S.board?.nodes.filter((node) => node.type === 'task') ?? [];
  }

  function activeTaskNodes() {
    return taskNodes().filter((task) => !(task.archivedAt > 0));
  }

  function isNodeVisible(node) {
    return node.type === 'master' || !(node.archivedAt > 0) || S.showArchived === true;
  }

  function dependenciesOf(task) {
    if (S.board === undefined) return [];
    return S.board.edges
      .filter((edge) => edge.kind === 'depends' && edge.to === task.id)
      .map((edge) => nodeById(edge.from))
      .filter(Boolean);
  }

  function isRunnable(task) {
    return dependenciesOf(task).every((dep) => dep.status === 'passed');
  }

  /* ───────────────────────────── 启动 ───────────────────────────── */

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== SOURCE) return;
    if (data.type === 'orchestra:current-session') {
      S.bridgeSession = data.session ?? null;
      if (S.board !== null) {
        const changed = syncMasterToBridge({ render: false });
        if (changed) {
          renderTopbar();
          renderBoard();
        } else {
          renderInspector();
        }
      }
      return;
    }
    if (data.type === 'orchestra:theme') {
      document.documentElement.dataset.theme = data.dark === true ? 'dark' : 'light';
      return;
    }
    if (data.type === 'orchestra:bridge-error') toast(data.message ?? '桥接失败', 'error');
  });

  async function boot() {
    buildShell();
    postToParent('orchestra:ready');
    postToParent('orchestra:request-current');
    try {
      const state = await api('/state');
      S.home = state;
      const fromHash = /board=([^&]+)/.exec(location.hash)?.[1];
      const wanted = decodeURIComponent(fromHash ?? '');
      const board = state.boards.find((item) => item.id === wanted) ?? state.boards[0];
      if (board === undefined) {
        renderTopbar();
        renderEmpty();
        return;
      }
      await loadBoard(board.id);
    } catch (error) {
      renderTopbar();
      renderEmpty(error.message);
    }
  }

  /* ───────────────────────────── 骨架 ───────────────────────────── */

  function buildShell() {
    const app = document.getElementById('app');
    app.className = 'app';
    app.innerHTML = '';
    D.app = app;

    D.topbar = h('header', { class: 'topbar' });
    D.rail = h('aside', { class: 'rail' });
    D.edgeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    D.edgeSvg.setAttribute('class', 'edges');
    D.edgeDefs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    D.edgeSvg.append(D.edgeDefs);
    for (const [kind, color] of Object.entries(EDGE_COLOR)) {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', `arrow-${kind}`);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      path.style.fill = color;
      marker.append(path);
      D.edgeDefs.append(marker);
    }
    D.edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    D.edgeSvg.append(D.edgeGroup);

    D.nodes = h('div', { class: 'nodes' });
    D.world = h('div', { class: 'world' }, D.edgeSvg, D.nodes);
    D.canvas = h('div', { class: 'canvas', id: 'canvas' }, D.world);
    D.stage = h('main', { class: 'stage' }, D.canvas, h('div', { class: 'canvas-hint', text: '拖拽空白平移 · 滚轮缩放 · 双击空白新建任务 · 从节点右侧圆点拖到左侧圆点连线' }));
    D.inspector = h('aside', { class: 'inspector' });
    D.body = h('div', { class: 'body' }, D.rail, D.stage, D.inspector);

    D.chatDrawer = buildChatDrawer();
    D.modalRoot = h('div', { class: 'modal-root' });
    D.toast = h('div', { class: 'toast' });

    app.append(D.topbar, D.body, D.chatDrawer, D.modalRoot, D.toast);

    buildRail();
    bindCanvas();
    const flush = () => {
      if (S.board === null || S.dirty !== true || S.saving) return;
      try {
        void fetch(`${API}/boards/${encodeURIComponent(S.boardId)}/graph`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nodes: wireNodes(), edges: S.board.edges }),
          keepalive: true,
        });
      } catch {
        // 页面卸载期间尽力而为
      }
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', () => {
      if (S.viewMoved !== true) fitView();
    });
    // DSH 主面板的尺寸经常在挂载后一两帧才稳定（侧栏动画、窗口恢复）。
    // 只在这段「刚打开」的窗口里自动适配一次；之后新增/拖拽都不再动镜头，
    // 否则每加一个节点整个画布都会跳一下，看起来像位置被重置。
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        if (S.viewMoved !== true && S.board !== null) fitView();
      });
      observer.observe(D.stage);
      setTimeout(() => observer.disconnect(), 2000);
    }
    setInterval(tick, 2000);
  }

  function buildRail() {
    D.rail.innerHTML = '';
    const add = (label, title, action) =>
      D.rail.append(h('button', { class: 'btn', title, onclick: action, html: label }));
    add(glyphPlus() + '任务', '新增任务节点', () => addTask());
    add(glyphNote() + '便签', '新增便签', () => addNote());
    add(glyphShield() + '禁忌', '新增禁忌节点', () => addKbNode());
    add(glyphLayout() + '整理', '重新排布所有节点（会覆盖手动位置）', () => tidyLayout());
    D.rail.append(h('div', { class: 'rail-label', text: '视图' }));
    D.rail.append(
      h('div', { class: 'zoom-box' },
        h('button', { class: 'btn btn-ghost', title: '缩小', text: '−', onclick: () => zoomBy(0.85) }),
        h('button', { class: 'btn btn-ghost', title: '放大', text: '＋', onclick: () => zoomBy(1.18) }),
        h('button', { class: 'btn btn-ghost', title: '适配视图', text: '⤢', onclick: fitView }),
        h('button', { class: 'btn btn-ghost', title: '回到原点', text: '⌂', onclick: () => { S.camera = { x: 60, y: 40, k: 1 }; applyCamera(); } }),
      ),
    );
  }

  function glyphPlus() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="margin-right:4px"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
  function glyphNote() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="margin-right:4px"><path d="M6 4h9l4 4v12H6z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M15 4v4h4" stroke="currentColor" stroke-width="1.7"/></svg>';
  }
  function glyphShield() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="margin-right:4px"><path d="M12 3l7 3v6c0 4.2-2.9 7.5-7 9-4.1-1.5-7-4.8-7-9V6z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  function glyphLayout() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="margin-right:4px"><rect x="3" y="4" width="7" height="6" rx="1.2" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="4" width="7" height="6" rx="1.2" stroke="currentColor" stroke-width="1.6"/><rect x="8.5" y="14" width="7" height="6" rx="1.2" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 10v2h11v-2M12 12v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  }

  /* ───────────────────────────── 顶栏 ───────────────────────────── */

  function renderTopbar() {
    D.topbar.innerHTML = '';
    D.topbar.append(
      h('div', { class: 'brand' },
        h('span', { class: 'brand-mark', html: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="6" r="2.4" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="18" r="2.4" stroke="currentColor" stroke-width="1.8"/><path d="M8 7.6l8 8.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' }),
        '编排台',
        h('span', { class: 'brand-sub', text: 'Orchestra' }),
      ),
    );

    const select = h('select', { class: 'board-select', title: '切换编排板' });
    for (const board of S.home?.boards ?? []) {
      select.append(h('option', { value: board.id, text: board.name, selected: board.id === S.boardId }));
    }
    select.addEventListener('change', () => loadBoard(select.value));
    D.topbar.append(select);
    D.topbar.append(h('button', { class: 'btn btn-sm', text: '＋ 新建', title: '新建编排板', onclick: () => openBoardModal(true) }));
    if (S.board !== null) {
      D.topbar.append(h('button', { class: 'btn btn-sm btn-ghost', text: '板设置', title: '名称 / 目标 / 工作目录', onclick: () => openBoardModal(false) }));
    }
    D.topbar.append(h('span', { class: 'save-state', text: S.saving ? '保存中…' : S.dirty ? '未保存' : '已保存' }));
    D.topbar.append(h('span', { class: 'spacer' }));

    if (S.board !== null) {
      const archivedCount = taskNodes().filter((task) => task.archivedAt > 0).length;
      D.topbar.append(...[
        h('button', { class: 'btn', onclick: planTasks, disabled: S.planning, title: '让总对话把目标拆成可验收的子任务' },
          S.planning ? h('span', { class: 'spinner' }) : null,
          S.planning ? '拆解中…' : '拆解任务',
        ),
        h('button', { class: 'btn', onclick: dispatchAll, title: '按依赖顺序派发当前可运行的任务', text: '批量派发' }),
        h('button', { class: 'btn', onclick: () => openChat('master'), title: '总对话', text: '总对话' }),
        archivedCount > 0 ? h('button', { class: 'btn', title: '显示/隐藏已归档的任务节点', text: `${S.showArchived ? '隐藏归档' : '已归档'} ${archivedCount}`, onclick: () => { S.showArchived = !S.showArchived; renderBoard(); } }) : null,
        h('button', { class: 'btn', onclick: openKbModal, title: '分级知识库', text: '知识库' }),
        h('button', { class: 'btn btn-ghost icon-btn', onclick: openSettingsModal, title: '设置', text: '⚙' }),
      ].filter(Boolean));
    }
  }

  /* ───────────────────────────── 加载 / 空态 ───────────────────────────── */

  async function loadBoard(boardId) {
    if (S.dirty) await saveGraph(true);
    try {
      const data = await api(`/boards/${encodeURIComponent(boardId)}`);
      S.board = data.board;
      if (S.board.followCurrent === undefined) {
        const stored = storedFollow(boardId);
        if (stored !== null) S.board.followCurrent = stored;
      }
      S.boardId = data.board.id;
      S.home = { ...(S.home ?? {}), boards: (S.home?.boards ?? []).map((item) => item.id === data.board.id ? { ...item, name: data.board.name } : item) };
      S.home.kb = data.kb;
      S.home.settings = data.settings;
      S.home.levels = data.levels;
      S.selectedId = '';
      S.selectedEdgeId = '';
      S.dirty = false;
      location.hash = `board=${data.board.id}`;
      const summary = (S.home?.boards ?? []).find((item) => item.id === data.board.id);
      if (summary !== undefined) Object.assign(summary, { name: data.board.name, updatedAt: data.board.updatedAt });
      // 打开板时立刻把总对话对准当前 DSH 对话（板默认跟随）。
      syncMasterToBridge({ render: false });
      renderTopbar();
      renderBoard();
      if (!S.fitted.has(data.board.id)) {
        S.fitted.add(data.board.id);
        S.viewMoved = false;
        requestAnimationFrame(() => requestAnimationFrame(fitView));
        // 面板尺寸在首帧后可能才稳定（尤其 DSH 主面板），再补一次适配。
        setTimeout(() => { if (S.viewMoved !== true && S.board?.id === data.board.id) fitView(); }, 400);
      }
    } catch (error) {
      toast(`读取编排板失败：${error.message}`, 'error');
      renderEmpty(error.message);
    }
  }

  async function refreshBoard() {
    if (S.board === null) return;
    const data = await api(`/boards/${encodeURIComponent(S.boardId)}`);
    mergeServerBoard(data.board);
    S.home.kb = data.kb;
    S.home.settings = data.settings;
    renderBoard();
  }

  const TASK_RUNTIME_FIELDS = ['status', 'childSessionId', 'childTitle', 'dispatchedAt', 'finishedAt', 'archivedAt', 'error', 'result', 'verdict', 'rounds', 'roundNote'];

  /**
   * 轮询/动作后的板刷新只合并「运行态」，节点坐标与正在编辑的字段以本地为准。
   * 这样新增、派发、验收都不会把用户摆好的位置拉回服务端旧值。
   */
  function mergeServerBoard(fresh) {
    if (fresh === null || fresh === undefined || fresh.id === undefined) return;
    if (S.board === null || S.board.id !== fresh.id) {
      S.board = fresh;
      return;
    }
    const localById = new Map(S.board.nodes.map((node) => [node.id, node]));
    const freshIds = new Set(fresh.nodes.map((node) => node.id));
    // 旧宿主没有 followCurrent 字段；用本地偏好兜底，避免刚取消跟随又被服务端刷回 true。
    const follow = fresh.followCurrent === undefined ? S.board.followCurrent !== false : fresh.followCurrent !== false;
    const followBridge = follow && S.bridgeSession?.id;
    const nodes = fresh.nodes.map((node) => {
      const local = localById.get(node.id);
      if (local === undefined) return node;
      const merged = { ...local };
      if (node.type === 'master') {
        merged.sessionId = followBridge ? S.bridgeSession.id : node.sessionId;
        merged.masterTitle = followBridge ? (S.bridgeSession.title ?? '') : node.masterTitle;
      }
      if (node.type === 'task') {
        for (const field of TASK_RUNTIME_FIELDS) merged[field] = node[field];
      }
      return merged;
    });
    // 本地刚加、服务端响应里还没有的节点先留着；否则保存/轮询的竞态会让它闪一下消失。
    for (const node of S.board.nodes) {
      if (!freshIds.has(node.id)) nodes.push(node);
    }
    S.board = {
      ...fresh,
      followCurrent: follow,
      masterSessionId: followBridge ? S.bridgeSession.id : fresh.masterSessionId,
      masterTitle: followBridge ? (S.bridgeSession.title ?? '') : fresh.masterTitle,
      nodes,
      edges: fresh.edges,
    };
  }

  function renderEmpty(error = '') {
    D.nodes.innerHTML = '';
    D.edgeGroup.innerHTML = '';
    D.inspector.innerHTML = '<h3>还没有编排板</h3><div class="sub">建一块板，把总对话与子任务连起来。</div>';
    D.stage.querySelector('.empty-state')?.remove();
    const card = h('div', { class: 'empty-card' },
      h('h2', { text: '建一块编排板' }),
      h('p', { text: error || '总对话负责拆解与验收；每个子对话只拿到自己的任务书，互相隔离。' }),
      h('div', { class: 'field' }, h('label', { text: '名称' }), h('input', { id: 'empty-name', placeholder: '例如：登录页改版' })),
      h('div', { class: 'field' }, h('label', { text: '总目标（可选）' }), h('textarea', { id: 'empty-goal', placeholder: '这块板要达成的结果' })),
      h('div', { class: 'field' }, h('label', { text: '工作目录（可选）' }), h('input', { id: 'empty-cwd', placeholder: '子对话的 cwd；留空沿用 DSH 默认' })),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', text: '创建编排板', onclick: async () => {
          const name = document.getElementById('empty-name').value.trim() || '新编排板';
          const goal = document.getElementById('empty-goal').value.trim();
          const cwd = document.getElementById('empty-cwd').value.trim();
          try {
            const created = await api('/boards', { method: 'POST', body: { name, goal, cwd, masterSessionId: S.bridgeSession?.id ?? '', masterTitle: S.bridgeSession?.title ?? '' } });
            await loadBoard(created.board.id);
          } catch (err) {
            toast(err.message, 'error');
          }
        } }),
        h('button', { class: 'btn btn-ghost', text: '看看用法', onclick: openHelpModal }),
      ),
    );
    D.stage.append(h('div', { class: 'empty-state' }, card));
  }

  /* ───────────────────────────── 画布渲染 ───────────────────────────── */

  function renderBoard() {
    renderTopbar();
    D.stage.querySelector('.empty-state')?.remove();
    D.nodes.innerHTML = '';
    D.edgeGroup.innerHTML = '';
    D.nodeEls = new Map();
    if (S.board === null) return;
    for (const node of S.board.nodes) {
      if (!isNodeVisible(node)) continue;
      const el = nodeEl(node);
      D.nodeEls.set(node.id, el);
      D.nodes.append(el);
    }
    requestAnimationFrame(() => {
      drawEdges();
      applyCamera();
    });
    renderInspector();
  }

  function applyCamera() {
    D.world.style.transform = `translate(${S.camera.x}px, ${S.camera.y}px) scale(${S.camera.k})`;
  }

  function screenToWorld(clientX, clientY) {
    const rect = D.stage.getBoundingClientRect();
    return {
      x: (clientX - rect.left - S.camera.x) / S.camera.k,
      y: (clientY - rect.top - S.camera.y) / S.camera.k,
    };
  }

  function nodeEl(node) {
    const width = nodeWidth(node);
    const el = h('div', {
      class: `node ${node.type}${node.archivedAt ? ' archived' : ''}${node.id === S.selectedId ? ' selected' : ''}`,
      dataset: { id: node.id },
      style: { left: `${node.x}px`, top: `${node.y}px`, width: `${width}px` },
    });
    el.append(h('div', { class: 'port port-in', dataset: { port: 'in', id: node.id }, title: '输入' }));
    el.append(h('div', { class: 'port port-out', dataset: { port: 'out', id: node.id }, title: '输出' }));

    if (node.type === 'master') {
      const running = isSessionRunning(node.sessionId);
      el.append(
        h('div', { class: 'node-head' },
          h('span', { class: `node-dot ${running ? 'info' : 'muted'}` }),
          h('span', { class: 'node-title', text: node.title || '总对话' }),
          h('span', { class: 'node-kind', text: 'MASTER' }),
        ),
        h('div', { class: 'node-body' },
          h('div', { class: 'node-goal', text: node.sessionId === '' ? '还没有绑定 DSH 会话。选中此节点，在右侧绑定当前对话。' : (node.masterTitle || node.sessionId) }),
          h('div', { class: 'node-meta' },
            h('span', { class: `chip ${running ? 'info' : ''}`, text: running ? '运行中' : node.sessionId ? '空闲' : '未绑定' }),
            h('span', { class: `chip ${S.board?.followCurrent !== false ? 'ok' : ''}`, text: S.board?.followCurrent !== false ? '跟随当前' : '固定绑定' }),
            h('span', { class: 'chip', text: `任务 ${activeTaskNodes().length}` }),
            h('span', { class: 'chip', text: `待验收 ${activeTaskNodes().filter((task) => task.status === 'review').length}` }),
          ),
          h('div', { class: 'node-foot' },
            node.sessionId ? h('button', { class: 'btn btn-sm', dataset: { act: 'open-session', id: node.sessionId }, text: '打开对话' }) : null,
            h('button', { class: 'btn btn-sm', dataset: { act: 'chat', target: 'master' }, text: '聊天' }),
          ),
        ),
      );
    } else if (node.type === 'task') {
      const meta = statusOf(node.status);
      const deps = dependenciesOf(node);
      el.append(
        h('div', { class: 'node-head' },
          h('span', { class: `node-dot ${meta.tone}` }),
          h('span', { class: 'node-title', text: node.title }),
          h('span', { class: 'node-kind', text: 'TASK' }),
          h('button', { class: 'node-del', dataset: { act: 'delete', id: node.id }, title: '删除节点', text: '×' }),
        ),
        h('div', { class: 'node-body' },
          h('div', { class: 'node-goal', text: node.goal || '（未填写目标）' }),
          h('div', { class: 'node-meta' },
            h('span', { class: `chip ${meta.tone}`, text: meta.label }),
            node.acceptance?.length ? h('span', { class: 'chip', text: `验收 ${node.acceptance.length}` }) : null,
            deps.length ? h('span', { class: `chip ${deps.every((dep) => dep.status === 'passed') ? 'ok' : 'warning'}`, text: `依赖 ${deps.filter((dep) => dep.status === 'passed').length}/${deps.length}` }) : null,
            node.result?.status === 'blocked' ? h('span', { class: 'chip danger', text: '阻塞' }) : null,
          ),
          node.result?.summary ? h('div', { class: 'node-result', text: short(node.result.summary, 120) }) : null,
          node.childSessionId ? h('div', { class: 'node-session', text: `子对话 · ${node.childTitle || node.childSessionId}` }) : null,
          h('div', { class: 'node-foot' },
            h('button', { class: 'btn btn-sm', dataset: { act: 'select', id: node.id }, text: '检查' }),
            node.status === 'draft' || node.status === 'error' ? h('button', { class: 'btn btn-sm', dataset: { act: 'dispatch', id: node.id }, text: '派发' }) : null,
            node.status === 'passed' || node.archivedAt ? h('button', { class: 'btn btn-sm', dataset: { act: 'archive', id: node.id, archived: node.archivedAt ? '0' : '1' }, text: node.archivedAt ? '取消归档' : '归档' }) : null,
            node.childSessionId ? h('button', { class: 'btn btn-sm', dataset: { act: 'open-session', id: node.childSessionId }, text: '打开' }) : null,
          ),
        ),
      );
    } else if (node.type === 'kb') {
      const level = LEVELS[node.level] ?? LEVELS[3];
      el.append(
        h('div', { class: 'node-head' },
          h('span', { class: 'node-dot warning' }),
          h('span', { class: 'node-title', text: node.title || '禁忌 / 约束' }),
          h('span', { class: 'node-kind', text: 'KB' }),
          h('button', { class: 'node-del', dataset: { act: 'delete', id: node.id }, title: '删除节点', text: '×' }),
        ),
        h('div', { class: 'node-body' },
          h('div', { class: 'node-meta' }, h('span', { class: `chip ${level.tone}`, text: `${level.short} ${level.name}` })),
          h('div', { class: 'node-goal', text: node.text || '（未填写内容；双击编辑）' }),
        ),
      );
    } else {
      el.append(
        h('div', { class: 'node-head' },
          h('span', { class: 'node-dot muted' }),
          h('span', { class: 'node-title', text: node.title || '便签' }),
          h('span', { class: 'node-kind', text: 'NOTE' }),
          h('button', { class: 'node-del', dataset: { act: 'delete', id: node.id }, title: '删除节点', text: '×' }),
        ),
        h('div', { class: 'node-body' }, h('div', { class: 'node-goal', text: node.text || '（空）' })),
      );
    }

    el.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button') || event.target.closest('.port')) return;
      selectNode(node.id);
      if (event.target.closest('.node-head')) startNodeDrag(event, node, el);
    });
    el.addEventListener('dblclick', (event) => {
      if (event.target.closest('button') || event.target.closest('.port')) return;
      openChatForNode(node);
    });
    return el;
  }

  function drawEdges() {
    if (D.edgeGroup === undefined || S.board === null) return;
    for (const child of [...D.edgeGroup.children]) child.remove();
    for (const edge of S.board.edges) {
      const from = D.nodeEls.get(edge.from);
      const to = D.nodeEls.get(edge.to);
      if (from === undefined || to === undefined) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', `wire${edge.id === S.selectedEdgeId ? ' selected' : ''}`);
      path.setAttribute('d', edgePath(from, to));
      path.style.stroke = EDGE_COLOR[edge.kind] ?? 'var(--line-strong)';
      path.setAttribute('marker-end', `url(#arrow-${edge.kind})`);
      path.dataset.id = edge.id;
      path.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        S.selectedEdgeId = edge.id;
        S.selectedId = '';
        renderNodesSelection();
        drawEdges();
        renderInspector();
      });
      D.edgeGroup.append(path);
    }
  }

  function edgePath(fromEl, toEl) {
    const fx = fromEl.offsetLeft + fromEl.offsetWidth;
    const fy = fromEl.offsetTop + fromEl.offsetHeight / 2;
    const tx = toEl.offsetLeft;
    const ty = toEl.offsetTop + toEl.offsetHeight / 2;
    const dx = Math.max(40, Math.abs(tx - fx) * 0.45);
    return `M ${fx} ${fy} C ${fx + dx} ${fy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  }

  function renderNodesSelection() {
    for (const [id, el] of D.nodeEls ?? []) el.classList.toggle('selected', id === S.selectedId);
  }

  function selectNode(id) {
    S.selectedId = id;
    S.selectedEdgeId = '';
    renderNodesSelection();
    drawEdges();
    renderInspector();
  }

  function isSessionRunning(sessionId) {
    return S.chat.runningSessionIds?.has?.(sessionId) === true;
  }

  /* ───────────────────────────── 画布交互 ───────────────────────────── */

  function bindCanvas() {
    D.nodes.addEventListener('click', onNodeAction);
    D.canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      if (event.target.closest('.node') || event.target.closest('path.wire')) return;
      S.selectedId = '';
      S.selectedEdgeId = '';
      renderNodesSelection();
      drawEdges();
      renderInspector();
      startPan(event);
    });
    D.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const before = screenToWorld(event.clientX, event.clientY);
      const factor = Math.exp(-event.deltaY * 0.0014);
      const next = Math.min(2.6, Math.max(0.25, S.camera.k * factor));
      if (next === S.camera.k) return;
      S.camera.k = next;
      const rect = D.stage.getBoundingClientRect();
      S.camera.x = event.clientX - rect.left - before.x * next;
      S.camera.y = event.clientY - rect.top - before.y * next;
      S.viewMoved = true;
      applyCamera();
    }, { passive: false });
    D.canvas.addEventListener('dblclick', (event) => {
      if (event.target.closest('.node') || event.target.closest('path.wire')) return;
      const point = screenToWorld(event.clientX, event.clientY);
      addTask(point);
    });
  }

  function startPan(event) {
    const start = { x: event.clientX, y: event.clientY, cx: S.camera.x, cy: S.camera.y };
    D.canvas.classList.add('panning');
    const move = (ev) => {
      S.viewMoved = true;
      S.camera.x = start.cx + (ev.clientX - start.x);
      S.camera.y = start.cy + (ev.clientY - start.y);
      applyCamera();
    };
    const up = () => {
      D.canvas.classList.remove('panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startNodeDrag(event, node, el) {
    event.preventDefault();
    S.dragging = true;
    // 用户开始摆位置后就不再自动适配镜头，避免加节点时整张图跳走。
    S.viewMoved = true;
    try {
      el.setPointerCapture?.(event.pointerId);
    } catch {
      // 某些嵌入环境不支持指针捕获；window 监听仍然可用
    }
    const start = { x: event.clientX, y: event.clientY, nx: node.x, ny: node.y };
    const move = (ev) => {
      node.x = Math.round(start.nx + (ev.clientX - start.x) / S.camera.k);
      node.y = Math.round(start.ny + (ev.clientY - start.y) / S.camera.k);
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      drawEdges();
      S.dirty = true;
      S.revision += 1;
      D.topbar.querySelector('.save-state').textContent = '未保存';
    };
    const up = () => {
      S.dragging = false;
      try {
        el.releasePointerCapture?.(event.pointerId);
      } catch {
        // 已自动释放
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      scheduleSave();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function bindPortDrag() {
    D.nodes.addEventListener('pointerdown', (event) => {
      const port = event.target.closest('.port-out');
      if (port === null) return;
      const node = nodeById(port.dataset.id);
      if (node === undefined) return;
      event.stopPropagation();
      event.preventDefault();
      const fromEl = D.nodeEls.get(node.id);
      const start = { x: fromEl.offsetLeft + fromEl.offsetWidth, y: fromEl.offsetTop + fromEl.offsetHeight / 2 };
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'temp');
      D.edgeGroup.append(path);
      let target = null;
      const move = (ev) => {
        const point = screenToWorld(ev.clientX, ev.clientY);
        const dx = Math.max(40, Math.abs(point.x - start.x) * 0.45);
        path.setAttribute('d', `M ${start.x} ${start.y} C ${start.x + dx} ${start.y}, ${point.x - dx} ${point.y}, ${point.x} ${point.y}`);
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const hit = el?.closest?.('.port-in');
        const nextTarget = hit === null || hit === undefined ? null : nodeById(hit.dataset.id);
        if (target?.el !== undefined) target.el.classList.remove('active');
        target = nextTarget === null || nextTarget === undefined ? null : { el: D.nodeEls.get(nextTarget.id), node: nextTarget };
        target?.el?.classList.add('active');
      };
      const up = (ev) => {
        path.remove();
        target?.el?.classList.remove('active');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const hit = el?.closest?.('.port-in');
        if (hit === null || hit === undefined) return;
        const toNode = nodeById(hit.dataset.id);
        if (toNode === undefined) return;
        connect(node, toNode);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function connect(fromNode, toNode) {
    if (fromNode.id === toNode.id) return;
    let kind = null;
    if (fromNode.type === 'master' && toNode.type === 'task') kind = 'dispatch';
    else if (fromNode.type === 'task' && toNode.type === 'master') kind = 'result';
    else if (fromNode.type === 'task' && toNode.type === 'task') kind = 'depends';
    else if ((fromNode.type === 'kb' || fromNode.type === 'note') && toNode.type === 'task') kind = 'constraint';
    if (kind === null) {
      toast('这条连线不合法：任务只能连总对话/其它任务，禁忌/便签只能连任务', 'error');
      return;
    }
    if (S.board.edges.some((edge) => edge.from === fromNode.id && edge.to === toNode.id && edge.kind === kind)) {
      toast('这条线已经有了');
      return;
    }
    if (kind === 'depends' && reachesTask(toNode, fromNode)) {
      toast('这条依赖会形成环，已拒绝', 'error');
      return;
    }
    S.board.edges.push({ id: `e-${Math.random().toString(36).slice(2, 9)}`, from: fromNode.id, to: toNode.id, kind });
    S.dirty = true;
    drawEdges();
    scheduleSave();
  }

  /* ───────────────────────────── 画布上的增删 ───────────────────────────── */

  function nodeApproxHeight(node) {
    return D.nodeEls?.get(node.id)?.offsetHeight ?? (node.type === 'task' ? 150 : node.type === 'master' ? 140 : 100);
  }

  /** 在当前视野中心找一个不和现有节点重叠的位置；找不到就按螺旋向外让。 */
  function freePosition(width, height) {
    const center = centerWorld();
    const rects = S.board.nodes.filter((node) => isNodeVisible(node)).map((node) => ({ x: node.x, y: node.y, w: nodeWidth(node), h: nodeApproxHeight(node) }));
    const collides = (x, y) =>
      rects.some((rect) => !(x + width + 24 <= rect.x || rect.x + rect.w + 24 <= x || y + height + 24 <= rect.y || rect.y + rect.h + 24 <= y));
    if (!collides(center.x, center.y)) return center;
    const step = 90;
    for (let ring = 1; ring <= 10; ring += 1) {
      for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const x = center.x + sx * ring * step;
        const y = center.y + sy * ring * step;
        if (!collides(x, y)) return { x, y };
      }
    }
    const maxX = S.board.nodes.reduce((max, node) => Math.max(max, node.x + nodeWidth(node)), 0);
    return { x: maxX + 90, y: center.y };
  }

  async function addTask(point) {
    if (S.board === null) return;
    // 先把待保存的拖拽位置落盘，避免新增接口读到旧图、轮询再把位置合并回去。
    if (S.dirty) await saveGraph(true);
    const at = point ?? freePosition(268, 150);
    S.viewMoved = true;
    try {
      const created = await api(`/boards/${encodeURIComponent(S.boardId)}/tasks/new`, { method: 'POST', body: { title: '新任务', x: Math.round(at.x), y: Math.round(at.y) } });
      S.board.nodes.push(created.task);
      if (Number.isFinite(created.boardUpdatedAt)) S.board.updatedAt = created.boardUpdatedAt;
      S.selectedId = created.task.id;
      renderBoard();
      focusInspectorField('task-title');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function addNote() {
    if (S.board === null) return;
    const at = freePosition(220, 100);
    S.viewMoved = true;
    S.board.nodes.push({ id: `n-${Math.random().toString(36).slice(2, 8)}`, type: 'note', x: Math.round(at.x), y: Math.round(at.y), title: '便签', text: '' });
    S.dirty = true;
    renderBoard();
    scheduleSave();
  }

  function addKbNode() {
    if (S.board === null) return;
    const at = freePosition(236, 110);
    S.viewMoved = true;
    S.board.nodes.push({ id: `k-${Math.random().toString(36).slice(2, 8)}`, type: 'kb', x: Math.round(at.x), y: Math.round(at.y), title: '项目约束', level: 2, text: '', kbId: '' });
    S.dirty = true;
    renderBoard();
    scheduleSave();
  }

  function centerWorld() {
    const rect = D.stage.getBoundingClientRect();
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /** 显式整理：把总对话放最左，任务按依赖分层，便签/禁忌收到左下。 */
  function tidyLayout() {
    if (S.board === null) return;
    if (!window.confirm('重新排布所有节点？这会覆盖你手动摆的位置。')) return;
    const master = S.board.nodes.find((node) => node.type === 'master');
    if (master !== undefined) {
      master.x = 40;
      master.y = 220;
    }
    const layers = new Map();
    const layerOf = (task, seen) => {
      if (layers.has(task.id)) return layers.get(task.id);
      if (seen.has(task.id)) return 0;
      seen.add(task.id);
      const deps = dependenciesOf(task);
      const layer = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => layerOf(dep, seen)));
      layers.set(task.id, layer);
      return layer;
    };
    const columns = new Map();
    for (const task of activeTaskNodes()) {
      const layer = layerOf(task, new Set());
      if (!columns.has(layer)) columns.set(layer, []);
      columns.get(layer).push(task);
    }
    for (const [layer, tasks] of [...columns.entries()].sort((left, right) => left[0] - right[0])) {
      tasks.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'));
      tasks.forEach((task, index) => {
        task.x = 360 + layer * 320;
        task.y = 90 + index * 190;
      });
    }
    let extraY = 520;
    for (const node of S.board.nodes) {
      if (node.type !== 'kb' && node.type !== 'note') continue;
      if (!isNodeVisible(node)) continue;
      node.x = 40;
      node.y = extraY;
      extraY += 140;
    }
    S.viewMoved = false;
    S.dirty = true;
    renderBoard();
    scheduleSave();
    setTimeout(fitView, 80);
  }

  function deleteNode(node) {
    if (node === undefined || node === null) return;
    if (node.type === 'master') {
      toast('总对话节点不能删除；可以在右侧改绑会话', 'error');
      return;
    }
    if (node.childSessionId && (node.status === 'running' || node.status === 'dispatching')) {
      toast('子对话正在运行，先等它结束再删节点', 'error');
      return;
    }
    const extra = node.childSessionId ? '\n它的子对话仍会保留在 DSH 侧栏（不会删除会话）。' : '';
    if (!window.confirm(`删除节点「${node.title}」？连线也会一起删除。${extra}`)) return;
    S.board.nodes = S.board.nodes.filter((candidate) => candidate.id !== node.id);
    S.board.edges = S.board.edges.filter((edge) => edge.from !== node.id && edge.to !== node.id);
    if (S.selectedId === node.id) S.selectedId = '';
    S.dirty = true;
    renderBoard();
    scheduleSave();
  }

  function deleteSelection() {
    if (S.selectedEdgeId !== '') {
      S.board.edges = S.board.edges.filter((edge) => edge.id !== S.selectedEdgeId);
      S.selectedEdgeId = '';
      S.dirty = true;
      renderBoard();
      scheduleSave();
      return;
    }
    deleteNode(nodeById(S.selectedId));
  }

  function onNodeAction(event) {
    const target = event.target.closest('[data-act]');
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    const action = target.dataset.act;
    const id = target.dataset.id;
    if (action === 'select') {
      selectNode(id);
      return;
    }
    if (action === 'dispatch') {
      const task = nodeById(id);
      if (task !== undefined) void dispatchOne(task);
      return;
    }
    if (action === 'open-session') {
      if (id) postToParent('orchestra:open-session', { sessionId: id });
      return;
    }
    if (action === 'chat') {
      openChat(target.dataset.target ?? 'master');
      return;
    }
    if (action === 'delete') {
      deleteNode(nodeById(id));
      return;
    }
    if (action === 'archive') {
      const task = nodeById(id);
      if (task !== undefined) void archiveTask(task, target.dataset.archived === '1');
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      if (S.modal !== null) closeModal();
      else if (S.chat.open) toggleChat(false);
      else if (S.selectedId !== '' || S.selectedEdgeId !== '') {
        S.selectedId = '';
        S.selectedEdgeId = '';
        renderNodesSelection();
        drawEdges();
        renderInspector();
      }
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      deleteSelection();
    }
  }

  /* ───────────────────────────── 保存 ───────────────────────────── */

  function scheduleSave() {
    S.dirty = true;
    S.revision += 1;
    const stateEl = D.topbar.querySelector('.save-state');
    if (stateEl) stateEl.textContent = '未保存';
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => saveGraph(false), 700);
  }

  function wireNodes() {
    return S.board.nodes.map((node) => {
      const base = { id: node.id, type: node.type, x: node.x, y: node.y, title: node.title };
      if (node.type === 'master') return { ...base, sessionId: node.sessionId, masterTitle: node.masterTitle };
      if (node.type === 'task') {
        return {
          ...base,
          goal: node.goal,
          boundary: node.boundary,
          inputs: node.inputs,
          deliverables: node.deliverables,
          acceptance: node.acceptance,
          kbLevels: node.kbLevels,
          kbIds: node.kbIds,
        };
      }
      if (node.type === 'kb') return { ...base, kbId: node.kbId ?? '', level: node.level, text: node.text };
      return { ...base, text: node.text };
    });
  }

  async function saveGraph(silent = false) {
    if (S.board === null) return;
    if (S.saving) {
      // 正在保存时又有新改动：等这次结束再补一次，避免最后一次编辑丢失。
      S.dirty = true;
      clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(() => saveGraph(silent), 400);
      return;
    }
    clearTimeout(S.saveTimer);
    S.saving = true;
    const revision = S.revision;
    const stateEl = D.topbar.querySelector('.save-state');
    if (stateEl) stateEl.textContent = '保存中…';
    try {
      const data = await api(`/boards/${encodeURIComponent(S.boardId)}/graph`, { method: 'PUT', body: { nodes: wireNodes(), edges: S.board.edges } });
      // 只合并服务端的运行态；坐标与正在编辑的字段以本地为准。
      // 保存期间用户又拖了/加了东西时，不能拿这次响应的旧坐标覆盖它。
      mergeServerBoard(data.board);
      if (S.revision === revision) {
        S.dirty = false;
        if (stateEl) stateEl.textContent = '已保存';
      } else {
        S.dirty = true;
        if (stateEl) stateEl.textContent = '未保存';
        clearTimeout(S.saveTimer);
        S.saveTimer = setTimeout(() => saveGraph(false), 400);
      }
      if (!silent) return;
    } catch (error) {
      S.dirty = true;
      if (stateEl) stateEl.textContent = '保存失败';
      toast(`保存失败：${error.message}`, 'error');
    } finally {
      S.saving = false;
    }
  }

  /* ───────────────────────────── 检查器 ───────────────────────────── */

  function renderInspector() {
    if (D.inspector === undefined) return;
    if (S.board === null) return;
    const node = S.selectedId === '' ? undefined : nodeById(S.selectedId);
    const edge = S.selectedEdgeId === '' ? undefined : S.board.edges.find((item) => item.id === S.selectedEdgeId);
    D.inspector.innerHTML = '';
    if (edge !== undefined) {
      D.inspector.append(
        h('h3', { text: '连线' }),
        h('div', { class: 'sub', text: edgeKindLabel(edge.kind) }),
        h('div', { class: 'kv' }, h('span', { text: '从' }), h('span', { text: nodeById(edge.from)?.title ?? edge.from })),
        h('div', { class: 'kv' }, h('span', { text: '到' }), h('span', { text: nodeById(edge.to)?.title ?? edge.to })),
        h('div', { class: 'section' }, h('button', { class: 'btn btn-danger', text: '删除连线', onclick: deleteSelection })),
      );
      return;
    }
    if (node === undefined) {
      renderBoardInspector();
      return;
    }
    if (node.type === 'task') renderTaskInspector(node);
    else if (node.type === 'master') renderMasterInspector(node);
    else if (node.type === 'kb') renderKbNodeInspector(node);
    else renderNoteInspector(node);
    bindInspectorFields();
  }

  function renderBoardInspector() {
    const active = activeTaskNodes();
    const counts = {
      tasks: active.length,
      running: active.filter((task) => task.status === 'running' || task.status === 'dispatching').length,
      review: active.filter((task) => task.status === 'review').length,
      passed: active.filter((task) => task.status === 'passed').length,
      archived: taskNodes().filter((task) => task.archivedAt > 0).length,
    };
    D.inspector.append(
      h('h3', { text: S.board.name }),
      h('div', { class: 'sub', text: `编排板 · 更新于 ${fmtTime(S.board.updatedAt) || '—'}` }),
      h('div', { class: 'kv' }, h('span', { text: '总目标' }), h('span', { text: short(S.board.goal || '（未填写）', 40) })),
      h('div', { class: 'kv' }, h('span', { text: '工作目录' }), h('span', { class: 'mono', text: S.board.cwd || '默认' })),
      h('div', { class: 'kv' }, h('span', { text: '任务 / 运行 / 待验收 / 通过' }), h('span', { text: `${counts.tasks} / ${counts.running} / ${counts.review} / ${counts.passed}` })),
      counts.archived > 0 ? h('div', { class: 'kv' }, h('span', { text: '已归档' }), h('span', { text: `${counts.archived} 个（顶栏可切换显示）` })) : null,
      h('div', { class: 'section' },
        h('div', { class: 'sub', text: '操作路径' }),
        h('div', { class: 'muted', style: { lineHeight: '19px' } },
          '① 选中总对话节点，绑定当前 DSH 会话；② 点顶栏「拆解任务」，总对话会生成可验收的任务节点；③ 逐个检查边界与验收标准，点「派发」；④ 子对话跑完后，看结果、点通过或打回。',
        ),
      ),
      h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('button', { class: 'btn', text: '分级知识库', onclick: openKbModal }),
          h('button', { class: 'btn', text: '设置', onclick: openSettingsModal }),
        ),
      ),
      h('div', { class: 'section' }, h('div', { class: 'sub', text: '一级禁忌会写进本机每个严格对话的系统提示；二级跟随本板；三级按任务勾选。' })),
    );
  }

  function renderMasterInspector(node) {
    const running = isSessionRunning(node.sessionId);
    if (!S.sessionsLoaded) {
      S.sessionsLoaded = true;
      void loadSessions().then(() => {
        if (S.selectedId === node.id) renderInspector();
      });
    }
    D.inspector.append(
      h('h3', { text: node.title || '总对话' }),
      h('div', { class: 'sub', text: '总对话：负责拆解、派发、验收；本身不直接做子任务。' }),
      h('label', { class: 'row', style: { margin: '2px 0 10px' } },
        h('input', { type: 'checkbox', checked: S.board.followCurrent !== false, onchange: (event) => void setFollowCurrent(event.target.checked) }),
        h('span', { text: '跟随当前 DSH 对话（切换会话时自动改绑总对话）' }),
      ),
      h('div', { class: 'field' },
        h('label', { text: '节点标题' }),
        h('input', { dataset: { field: 'title' }, value: node.title }),
      ),
      h('div', { class: 'field' },
        h('label', { text: '绑定的 DSH 会话' }),
        h('select', { id: 'master-session-select' },
          h('option', { value: '', text: node.sessionId === '' ? '（未绑定）' : '（保持不变）', selected: node.sessionId === '' }),
          ...(S.sessions.some((session) => session.id === node.sessionId) ? [] : node.sessionId ? [h('option', { value: node.sessionId, text: node.masterTitle || node.sessionId, selected: true })] : []),
          ...S.sessions.map((session) => h('option', { value: session.id, text: `${session.title}${session.running ? ' · 运行中' : ''}`, selected: session.id === node.sessionId })),
        ),
      ),
      h('div', { class: 'row', style: { marginBottom: '10px' } },
        h('button', { class: 'btn btn-sm', text: '刷新会话列表', onclick: async () => { await loadSessions(); renderInspector(); } }),
        h('button', { class: 'btn btn-sm', text: '固定绑定选中会话', onclick: () => bindMaster(document.getElementById('master-session-select').value, '', false) }),
      ),
      h('div', { class: 'section' },
        h('div', { class: 'sub', text: S.bridgeSession ? `当前 DSH 对话：${S.bridgeSession.title}` : '当前没有检测到 DSH 对话（从侧栏面板打开时会自动桥接）' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-primary', text: '用当前对话作总对话', disabled: S.bridgeSession === null, onclick: () => bindMaster(S.bridgeSession?.id ?? '', S.bridgeSession?.title ?? '', true) }),
          node.sessionId ? h('button', { class: 'btn', text: '打开', onclick: () => postToParent('orchestra:open-session', { sessionId: node.sessionId }) }) : null,
        ),
      ),
      h('div', { class: 'section' },
        h('div', { class: 'kv' }, h('span', { text: '状态' }), h('span', { text: running ? '运行中' : node.sessionId ? '空闲' : '未绑定' })),
        h('div', { class: 'kv' }, h('span', { text: '会话 id' }), h('span', { class: 'mono', text: node.sessionId || '—' })),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn', text: '打开聊天', onclick: () => openChat('master') }),
          h('button', { class: 'btn btn-ghost', text: '让总对话拆解', onclick: planTasks }),
        ),
      ),
    );
  }

  function renderTaskInspector(node) {
    const meta = statusOf(node.status);
    const deps = dependenciesOf(node);
    const runnable = isRunnable(node);
    D.inspector.append(
      h('h3', { text: node.title }),
      h('div', { class: 'sub', text: `任务节点 · ${meta.label}${node.childSessionId ? ` · 子对话 ${node.childSessionId.slice(0, 12)}…` : ''}` }),
      node.archivedAt ? h('div', { class: 'result-box', style: { marginBottom: '10px' }, text: `已归档 · ${fmtTime(node.archivedAt)}\n顶栏「已归档」可以切换是否在画布上显示。` }) : null,
      h('div', { class: 'field' }, h('label', { text: '标题' }), h('input', { id: 'task-title', dataset: { field: 'title' }, value: node.title })),
      h('div', { class: 'field' }, h('label', { text: '目标（子对话要达成什么）' }), h('textarea', { dataset: { field: 'goal' }, value: node.goal })),
      h('div', { class: 'field' }, h('label', { text: '边界（只做什么 / 不要碰什么 / 输入）' }), h('textarea', { class: 'tall', dataset: { field: 'boundary' }, value: node.boundary })),
      h('div', { class: 'field' }, h('label', { text: '输入材料' }), h('textarea', { dataset: { field: 'inputs' }, value: node.inputs })),
      h('div', { class: 'field' }, h('label', { text: '交付物与格式' }), h('textarea', { dataset: { field: 'deliverables' }, value: node.deliverables })),
      h('div', { class: 'field' },
        h('label', { text: '验收标准（一行一条，子对话会逐条自检）' }),
        h('textarea', { class: 'tall', dataset: { field: 'acceptance' }, value: (node.acceptance ?? []).join('\n') }),
      ),
      h('div', { class: 'field' },
        h('label', { text: '附加知识库等级' }),
        h('div', { class: 'tag-list' },
          ...[1, 2, 3, 4].map((level) => h('label', { class: 'chip', style: { cursor: 'pointer' } },
            h('input', { type: 'checkbox', dataset: { kbLevel: String(level) }, checked: (node.kbLevels ?? []).includes(level), style: { marginRight: '4px' } }),
            `${LEVELS[level].short} ${LEVELS[level].name}`,
          )),
        ),
      ),
      h('div', { class: 'section' },
        h('div', { class: 'kv' }, h('span', { text: '依赖' }), h('span', { text: deps.length === 0 ? '无' : deps.map((dep) => `${dep.title}(${statusOf(dep.status).label})`).join('、') })),
        h('div', { class: 'kv' }, h('span', { text: '子对话' }), h('span', { class: 'mono', text: node.childSessionId || '—' })),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn btn-primary', text: node.childSessionId ? '重新派发' : '派发', disabled: node.status === 'running' || node.status === 'dispatching', onclick: () => dispatchOne(node) }),
          node.childSessionId ? h('button', { class: 'btn', text: '打开子对话', onclick: () => postToParent('orchestra:open-session', { sessionId: node.childSessionId }) }) : null,
          h('button', { class: 'btn', text: '聊天/结果', onclick: () => openChat('task', node) }),
        ),
        !runnable && deps.length > 0 ? h('div', { class: 'faint', style: { marginTop: '6px' }, text: '前置任务未全部通过；派发时会先征求是否强制。' }) : null,
        node.roundNote ? h('div', { class: 'faint', style: { marginTop: '6px' }, text: `上次驳回要求：${node.roundNote}` }) : null,
      ),
    );

    if (node.result !== null) {
      D.inspector.append(
        h('div', { class: 'section' },
          h('div', { class: 'row' }, h('b', { text: '子对话结果' }), h('span', { class: `chip ${node.result.status === 'done' ? 'ok' : 'warning'}`, text: node.result.status })),
          h('div', { class: 'result-box', style: { marginTop: '8px' }, text: node.result.summary || '（没有摘要）' }),
          Array.isArray(node.result.artifacts) && node.result.artifacts.length > 0
            ? h('div', { class: 'tag-list', style: { marginTop: '6px' } }, ...node.result.artifacts.map((item) => h('span', { class: 'chip', text: short(item, 40) })))
            : null,
          node.result.checks?.length ? h('div', { class: 'checklist', style: { marginTop: '8px' } }, ...node.result.checks.map((check) => checkRow(check))) : null,
        ),
      );
    }

    if (node.verdict !== null) {
      const pass = node.verdict.verdict === 'pass';
      D.inspector.append(
        h('div', { class: `verdict-box ${pass ? 'pass' : 'fail'}` },
          h('div', { class: 'row' }, h('b', { text: pass ? '总对话判定：通过' : '总对话判定：不通过' }), h('span', { class: 'chip', text: `score ${node.verdict.score}` })),
          node.verdict.reasons?.length ? h('div', { style: { marginTop: '4px' }, text: node.verdict.reasons.join('；') }) : null,
          node.verdict.followup ? h('div', { class: 'faint', style: { marginTop: '4px' }, text: `打回要求：${node.verdict.followup}` }) : null,
        ),
      );
    }

    D.inspector.append(
      h('div', { class: 'section' },
        h('div', { class: 'sub', text: '人工验收（你选择的任务节奏）' }),
        h('div', { class: 'field' }, h('label', { text: '驳回要求（打回时写进子对话）' }), h('textarea', { id: 'round-note', placeholder: '例如：第 2 条验收标准缺证据，补一张对比截图' })),
        h('div', { class: 'row' },
          h('button', { class: 'btn', text: '让总对话先复核', disabled: node.result === null, onclick: () => verifyOne(node) }),
          h('button', { class: 'btn btn-primary', text: '通过', disabled: node.status !== 'review', onclick: () => acceptOne(node, true) }),
          h('button', { class: 'btn btn-danger', text: '驳回并打回', disabled: node.status !== 'review', onclick: () => acceptOne(node, false) }),
        ),
      ),
    );
    if (node.error) D.inspector.append(h('div', { class: 'section' }, h('div', { class: 'result-box', style: { borderColor: 'var(--danger-soft)' }, text: node.error })));
    D.inspector.append(
      h('div', { class: 'section' },
        h('div', { class: 'row' },
          node.status === 'passed' || node.archivedAt ? h('button', { class: 'btn', text: node.archivedAt ? '取消归档' : '归档', onclick: () => archiveTask(node, !(node.archivedAt > 0)) }) : null,
          h('button', { class: 'btn btn-danger', text: '删除节点', onclick: () => deleteNode(node) }),
        ),
        h('div', { class: 'faint', style: { marginTop: '6px' }, text: '删除节点不会删除它的 DSH 会话；归档会把子会话从侧栏收起来。' }),
      ),
    );
  }

  function checkRow(check) {
    return h('div', { class: `check-item ${check.pass ? 'pass' : 'fail'}` },
      h('span', { class: 'mark', text: check.pass ? '✓' : '✗' }),
      h('span', {}, h('b', { text: short(check.criterion || '未命名标准', 60) }), check.evidence ? h('span', { class: 'faint', text: ` — ${short(check.evidence, 90)}` }) : null),
    );
  }

  function renderKbNodeInspector(node) {
    D.inspector.append(
      h('h3', { text: node.title || '禁忌节点' }),
      h('div', { class: 'sub', text: '把节点连到任务上，就等于把这段约束附加给该任务。' }),
      h('div', { class: 'field' }, h('label', { text: '标题' }), h('input', { dataset: { field: 'title' }, value: node.title })),
      h('div', { class: 'field' },
        h('label', { text: '等级' }),
        h('select', { dataset: { field: 'level' } }, ...[1, 2, 3, 4].map((level) => h('option', { value: String(level), text: `${LEVELS[level].name}（${LEVELS[level].hint}）`, selected: node.level === level }))),
      ),
      h('div', { class: 'field' }, h('label', { text: '约束内容' }), h('textarea', { class: 'tall', dataset: { field: 'text' }, value: node.text })),
      h('div', { class: 'row' },
        h('button', { class: 'btn', text: '存进知识库', onclick: async () => {
          try {
            const created = await api('/kb', { method: 'POST', body: { level: node.level, title: node.title, text: node.text } });
            node.kbId = created.entry.id;
            toast('已存进分级知识库');
            scheduleSave();
          } catch (error) { toast(error.message, 'error'); }
        } }),
        node.kbId ? h('span', { class: 'chip ok', text: `已关联 ${node.kbId}` }) : h('span', { class: 'chip', text: '未关联知识库' }),
      ),
      h('div', { class: 'section' }, h('button', { class: 'btn btn-danger', text: '删除节点', onclick: () => deleteNode(node) })),
    );
  }

  function renderNoteInspector(node) {
    D.inspector.append(
      h('h3', { text: '便签' }),
      h('div', { class: 'sub', text: '只给自己看；连到任务上会作为「总对话转交的约束」写进任务书。' }),
      h('div', { class: 'field' }, h('label', { text: '标题' }), h('input', { dataset: { field: 'title' }, value: node.title })),
      h('div', { class: 'field' }, h('label', { text: '内容' }), h('textarea', { class: 'tall', dataset: { field: 'text' }, value: node.text })),
      h('div', { class: 'section' }, h('button', { class: 'btn btn-danger', text: '删除节点', onclick: () => deleteNode(node) })),
    );
  }

  function bindInspectorFields() {
    const node = nodeById(S.selectedId);
    if (node === undefined) return;
    D.inspector.querySelectorAll('[data-field]').forEach((input) => {
      input.addEventListener('input', () => {
        if (input.dataset.field === 'acceptance') node.acceptance = input.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8);
        else if (input.dataset.field === 'level') node.level = Number(input.value);
        else node[input.dataset.field] = input.value;
        S.dirty = true;
        scheduleSave();
        if (input.dataset.field === 'title') {
          const el = D.nodeEls?.get(node.id)?.querySelector('.node-title');
          if (el) el.textContent = input.value;
        }
      });
    });
    D.inspector.querySelectorAll('[data-kb-level]').forEach((input) => {
      input.addEventListener('change', () => {
        const level = Number(input.dataset.kbLevel);
        const set = new Set(node.kbLevels ?? []);
        if (input.checked) set.add(level); else set.delete(level);
        node.kbLevels = [...set].sort((a, b) => a - b);
        scheduleSave();
      });
    });
  }

  function focusInspectorField(id) {
    requestAnimationFrame(() => {
      const input = document.getElementById(id);
      if (input) {
        input.focus();
        input.select?.();
      }
    });
  }

  function edgeKindLabel(kind) {
    return { dispatch: '派发（总对话 → 任务）', depends: '依赖（任务 → 任务，只传结果摘要）', constraint: '附加约束（禁忌/便签 → 任务）', result: '结果（任务 → 总对话）' }[kind] ?? kind;
  }

  /* ───────────────────────────── 动作 ───────────────────────────── */

  /** 跟随当前 DSH 对话：把总对话节点指向 bridge 里的会话。 */
  function syncMasterToBridge({ render = true } = {}) {
    if (S.board === null || S.board.followCurrent === false || !S.bridgeSession?.id) return false;
    const master = S.board.nodes.find((node) => node.type === 'master');
    if (master === undefined) return false;
    if (master.sessionId === S.bridgeSession.id && S.board.masterSessionId === S.bridgeSession.id) return false;
    const title = S.bridgeSession.title ?? '';
    master.sessionId = S.bridgeSession.id;
    master.masterTitle = title;
    S.board.masterSessionId = S.bridgeSession.id;
    S.board.masterTitle = title;
    scheduleFollowPersist();
    if (render) {
      renderTopbar();
      renderBoard();
    }
    return true;
  }

  function scheduleFollowPersist() {
    clearTimeout(S.followTimer);
    S.followTimer = setTimeout(async () => {
      if (S.board === null || S.board.followCurrent === false || !S.bridgeSession?.id) return;
      try {
        const data = await api(`/boards/${encodeURIComponent(S.boardId)}`, {
          method: 'PATCH',
          body: { followCurrent: true, masterSessionId: S.bridgeSession.id, masterTitle: S.bridgeSession.title ?? '' },
        });
        if (data.board !== undefined) mergeServerBoard(data.board);
      } catch {
        // 持久化失败不影响当前显示；下一次切换会话会再试
      }
    }, 250);
  }

  async function setFollowCurrent(enabled) {
    if (S.board === null) return;
    S.board.followCurrent = enabled;
    storeFollow(S.boardId, enabled);
    try {
      const body = { followCurrent: enabled };
      if (enabled && S.bridgeSession?.id) {
        body.masterSessionId = S.bridgeSession.id;
        body.masterTitle = S.bridgeSession.title ?? '';
      }
      const data = await api(`/boards/${encodeURIComponent(S.boardId)}`, { method: 'PATCH', body });
      if (enabled) {
        S.bridgeSession = S.bridgeSession ?? null;
        syncMasterToBridge({ render: false });
      }
      if (data.board !== undefined) {
        mergeServerBoard(data.board);
        if (enabled && S.bridgeSession?.id) {
          const master = S.board.nodes.find((node) => node.type === 'master');
          if (master !== undefined) {
            master.sessionId = S.bridgeSession.id;
            master.masterTitle = S.bridgeSession.title ?? '';
          }
          S.board.masterSessionId = S.bridgeSession.id;
          S.board.masterTitle = S.bridgeSession.title ?? '';
        }
      }
      S.board.followCurrent = enabled;
      renderTopbar();
      renderBoard();
      toast(enabled ? '总对话会跟随当前 DSH 对话' : '总对话已固定绑定当前会话');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function bindMaster(sessionId, title, followCurrent = false) {
    if (!sessionId) {
      toast('先选择一个会话', 'error');
      return;
    }
    try {
      const data = await api(`/boards/${encodeURIComponent(S.boardId)}/bind-master`, { method: 'POST', body: { sessionId, title, followCurrent } });
      S.board = data.board;
      S.board.followCurrent = followCurrent;
      storeFollow(S.boardId, followCurrent);
      S.home.boards = S.home.boards.map((item) => item.id === S.board.id ? { ...item, masterSessionId: sessionId, masterTitle: title } : item);
      renderBoard();
      toast(followCurrent ? '总对话已跟随当前对话' : '总对话已绑定');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function loadSessions() {
    try {
      const data = await api('/sessions?limit=80');
      S.sessions = data.items;
      S.sessionsLoaded = true;
    } catch (error) {
      toast(`会话列表读取失败：${error.message}`, 'error');
    }
  }

  async function planTasks() {
    if (S.board === null) return;
    if (!S.board.masterSessionId) {
      toast('先绑定总对话：选中总对话节点，点「用当前对话作总对话」', 'error');
      return;
    }
    if (S.planning) return;
    S.planning = true;
    renderTopbar();
    try {
      const { jobId } = await api(`/boards/${encodeURIComponent(S.boardId)}/plan`, { method: 'POST', body: {} });
      const job = await waitJob(jobId, '总对话正在拆解任务');
      if (job.status === 'error') {
        showJobError('拆解失败', job.error);
      } else {
        await refreshBoard();
        showPlanResult(job);
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      S.planning = false;
      renderTopbar();
    }
  }

  function reachesTask(start, target) {
    const stack = [start];
    const seen = new Set();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.id === target.id) return true;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      for (const edge of S.board.edges) {
        if (edge.kind !== 'depends' || edge.from !== node.id) continue;
        const next = nodeById(edge.to);
        if (next !== undefined) stack.push(next);
      }
    }
    return false;
  }

  async function dispatchOne(task) {
    const runnable = isRunnable(task);
    if (task.childSessionId && ['review', 'passed', 'rejected'].includes(task.status)) {
      if (!window.confirm(`「${task.title}」已经有一个子对话。重新派发会新开一个隔离子对话（旧的仍保留在 DSH 侧栏），确定吗？`)) return;
    }
    if (!runnable) {
      if (!window.confirm('前置任务还没全部通过。仍然强制派发吗？')) return;
    }
    try {
      await api(`/boards/${encodeURIComponent(S.boardId)}/tasks/${encodeURIComponent(task.id)}/dispatch`, { method: 'POST', body: { force: !runnable } });
      toast(`已派发：${task.title}`);
      await refreshBoard();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function dispatchAll() {
    const runnable = taskNodes().filter((task) => task.status === 'draft' && isRunnable(task));
    if (runnable.length === 0) {
      toast('当前没有可派发的任务（要么在跑，要么前置未通过）');
      return;
    }
    if (!window.confirm(`派发 ${runnable.length} 个可运行任务？\n${runnable.map((task) => `· ${task.title}`).join('\n')}`)) return;
    try {
      const data = await api(`/boards/${encodeURIComponent(S.boardId)}/dispatch-all`, { method: 'POST', body: {} });
      toast(`已派发 ${data.dispatched} 个任务`);
      await refreshBoard();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function verifyOne(task) {
    try {
      const { jobId } = await api(`/boards/${encodeURIComponent(S.boardId)}/tasks/${encodeURIComponent(task.id)}/verify`, { method: 'POST', body: {} });
      const job = await waitJob(jobId, `总对话正在复核「${task.title}」`);
      if (job.status === 'error') {
        showJobError('复核失败', job.error);
        return;
      }
      await refreshBoard();
      showVerdict(job.verdict, task);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function acceptOne(task, pass) {
    const note = document.getElementById('round-note')?.value ?? '';
    if (!pass && note.trim() === '' && !window.confirm('没有写驳回要求，直接用「按验收标准重新检查」打回？')) return;
    try {
      const result = await api(`/boards/${encodeURIComponent(S.boardId)}/tasks/${encodeURIComponent(task.id)}/accept`, { method: 'POST', body: { pass, note } });
      if (pass && result.archiveError) toast(`已通过，但归档失败：${result.archiveError}`, 'error');
      else toast(pass ? (result.archived ? `已通过并归档：${task.title}` : `已通过：${task.title}`) : `已打回：${task.title}`, pass ? 'ok' : '');
      await refreshBoard();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function archiveTask(task, archived) {
    try {
      await api(`/boards/${encodeURIComponent(S.boardId)}/tasks/${encodeURIComponent(task.id)}/archive`, { method: 'POST', body: { archived } });
      toast(archived ? `已归档：${task.title}` : `已取消归档：${task.title}`, 'ok');
      await refreshBoard();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function waitJob(jobId, title) {
    openJobModal(title);
    const started = Date.now();
    for (;;) {
      const data = await api(`/boards/${encodeURIComponent(S.boardId)}/jobs/${encodeURIComponent(jobId)}`);
      const job = data.job;
      if (job.status !== 'running') return job;
      if (Date.now() - started > 6 * 60 * 1000) throw new Error('等待超时（6 分钟）');
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  function openChatForNode(node) {
    if (node.type === 'master') openChat('master');
    else if (node.type === 'task') openChat('task', node);
  }

  function openChat(target, task) {
    S.chat.open = true;
    S.chat.target = target;
    if (task !== undefined) S.selectedId = task.id;
    D.chatDrawer.classList.add('open');
    renderChatHead();
    void refreshChat(true);
  }

  function toggleChat(open) {
    S.chat.open = open;
    D.chatDrawer.classList.toggle('open', open);
    if (open) void refreshChat(true);
  }

  /* ───────────────────────────── 聊天 ───────────────────────────── */

  function buildChatDrawer() {
    const list = h('div', { class: 'chat-list' });
    const title = h('div', { class: 'chat-title', text: '总对话' });
    const sub = h('div', { class: 'chat-sub', text: '' });
    const masterTab = h('button', { class: 'chat-tab active', text: '总对话' });
    masterTab.addEventListener('click', () => { S.chat.target = 'master'; renderChatHead(); void refreshChat(true); });
    const taskTab = h('button', { class: 'chat-tab', text: '当前子对话' });
    taskTab.addEventListener('click', () => { S.chat.target = 'task'; renderChatHead(); void refreshChat(true); });
    const input = h('textarea', { placeholder: '给总对话发消息…（Enter 发送，Shift+Enter 换行）' });
    const send = h('button', { class: 'btn btn-primary', text: '发送' });
    const drawer = h('div', { class: 'chat-drawer' },
      h('div', { class: 'chat-head' },
        h('div', { class: 'grow' }, title, sub),
        h('button', { class: 'btn btn-ghost icon-btn', text: '×', title: '关闭', onclick: () => toggleChat(false) }),
      ),
      h('div', { class: 'chat-tabs' }, masterTab, taskTab),
      list,
      h('div', { class: 'chat-compose' }, input, send),
    );
    const doSend = async () => {
      const text = input.value.trim();
      if (text === '') return;
      if (S.board?.masterSessionId === undefined || S.board.masterSessionId === '') {
        toast('先绑定总对话', 'error');
        return;
      }
      input.value = '';
      try {
        await api(`/boards/${encodeURIComponent(S.boardId)}/master/send`, { method: 'POST', body: { text } });
        S.chat.messages.push({ role: 'user', text, at: Date.now(), seq: -1 });
        renderChatMessages();
        setTimeout(() => void refreshChat(true), 500);
      } catch (error) {
        toast(error.message, 'error');
      }
    };
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void doSend();
      }
    });
    D.chatList = list;
    D.chatTitle = title;
    D.chatSub = sub;
    D.chatInput = input;
    D.chatSend = send;
    D.chatTabs = { master: masterTab, task: taskTab };
    return drawer;
  }

  function chatSessionId() {
    if (S.board === null) return '';
    if (S.chat.target === 'master') return S.board.masterSessionId ?? '';
    const selected = nodeById(S.selectedId);
    if (selected?.type === 'task') return selected.childSessionId || '';
    const withChild = taskNodes().find((item) => item.childSessionId !== '');
    return withChild?.childSessionId ?? '';
  }

  function renderChatHead() {
    if (D.chatDrawer === undefined) return;
    const sessionId = chatSessionId();
    const task = S.chat.target === 'task' ? nodeById(S.selectedId) : undefined;
    D.chatTitle.textContent = S.chat.target === 'master' ? (S.board?.masterTitle || '总对话') : (task?.title ? `${task.title} · 子对话` : '子对话');
    D.chatSub.textContent = sessionId === '' ? '还没有会话' : sessionId;
    D.chatTabs.master.classList.toggle('active', S.chat.target === 'master');
    D.chatTabs.task.classList.toggle('active', S.chat.target === 'task');
    const readonly = S.chat.target === 'task';
    D.chatInput.disabled = readonly;
    D.chatInput.placeholder = readonly ? '子对话只读：它只接收任务书，由总对话驱动' : '给总对话发消息…（Enter 发送，Shift+Enter 换行）';
    D.chatSend.disabled = readonly;
  }

  async function refreshChat(forceScroll = false) {
    if (!S.chat.open || S.board === null) return;
    const sessionId = chatSessionId();
    if (sessionId === '') {
      S.chat.messages = [];
      S.chat.running = false;
      renderChatMessages();
      return;
    }
    if (S.chat.loading) return;
    S.chat.loading = true;
    try {
      const data = await api(`/boards/${encodeURIComponent(S.boardId)}/messages?sessionId=${encodeURIComponent(sessionId)}&limit=80`);
      if (data.lastSeq !== S.chat.lastSeq || data.messages.length !== S.chat.messages.length) {
        const nearBottom = D.chatList.scrollTop + D.chatList.clientHeight >= D.chatList.scrollHeight - 60;
        S.chat.messages = data.messages;
        S.chat.lastSeq = data.lastSeq;
        S.chat.running = data.running;
        renderChatMessages();
        if (nearBottom || forceScroll) D.chatList.scrollTop = D.chatList.scrollHeight;
      }
      S.chat.running = data.running;
      renderChatHead();
    } catch (error) {
      if (S.chat.messages.length === 0) {
        S.chat.messages = [{ role: 'system', text: `读不到会话：${error.message}` }];
        renderChatMessages();
      }
    } finally {
      S.chat.loading = false;
    }
  }

  function renderChatMessages() {
    if (D.chatList === undefined) return;
    D.chatList.innerHTML = '';
    if (S.chat.messages.length === 0) {
      D.chatList.append(h('div', { class: 'faint', style: { textAlign: 'center', marginTop: '20px' }, text: S.chat.target === 'task' ? '子对话还没有消息' : '还没有消息。可以先在总对话里说目标，再点「拆解任务」。' }));
      return;
    }
    for (const message of S.chat.messages) {
      const bubble = h('div', { class: `bubble ${message.role}` });
      bubble.append(h('div', { text: message.text }));
      if (message.at) bubble.append(h('div', { class: 'bubble-meta', text: fmtTime(message.at) }));
      D.chatList.append(bubble);
    }
    if (S.chat.running) {
      D.chatList.append(h('div', { class: 'faint', style: { padding: '2px 4px' }, html: '<span class="spinner"></span> 正在运行…' }));
    }
    D.chatList.scrollTop = D.chatList.scrollHeight;
  }

  /* ───────────────────────────── 轮询 ───────────────────────────── */

  async function tick() {
    if (S.board === null || S.pollBusy || S.saving || S.dirty || S.dragging) return;
    S.pollBusy = true;
    try {
      const pulse = await api(`/pulse?boardId=${encodeURIComponent(S.boardId)}`);
      if (pulse.boardUpdatedAt !== S.board.updatedAt) {
        const data = await api(`/boards/${encodeURIComponent(S.boardId)}`);
        mergeServerBoard(data.board);
        S.home.kb = data.kb;
        S.home.settings = data.settings;
        renderTopbar();
        renderBoard();
      }
      S.chat.runningSessionIds = new Set();
      if (pulse.masterRunning === true && S.board.masterSessionId) S.chat.runningSessionIds.add(S.board.masterSessionId);
      for (const task of taskNodes()) {
        if (task.childSessionId && (task.status === 'running' || task.status === 'dispatching')) S.chat.runningSessionIds.add(task.childSessionId);
      }
      if (S.chat.open) await refreshChat(false);
    } catch {
      // 轮询失败静默，下一轮再试
    } finally {
      S.pollBusy = false;
    }
  }

  /* ───────────────────────────── 弹窗 ───────────────────────────── */

  function openModal({ title, body, foot, wide = false }) {
    closeModal();
    const modal = h('div', { class: 'modal', style: wide ? { width: 'min(860px, calc(100vw - 40px))' } : {} },
      h('div', { class: 'modal-head' }, h('h2', { text: title }), h('button', { class: 'btn btn-ghost icon-btn', text: '×', onclick: closeModal })),
      h('div', { class: 'modal-body' }, body),
      foot === undefined ? null : h('div', { class: 'modal-foot' }, foot),
    );
    const mask = h('div', { class: 'modal-mask', onclick: closeModal });
    D.modalRoot.innerHTML = '';
    D.modalRoot.append(mask, modal);
    D.modalRoot.classList.add('open');
    S.modal = { modal };
    return modal;
  }

  function closeModal() {
    if (D.modalRoot === undefined) return;
    D.modalRoot.classList.remove('open');
    D.modalRoot.innerHTML = '';
    S.modal = null;
  }

  function openJobModal(title) {
    const body = h('div', {},
      h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', { text: '等待总对话回复…' })),
      h('p', { class: 'faint', style: { marginTop: '10px' }, text: '计划/复核会在总对话完成这一轮后自动解析；不要关闭页面。' }),
    );
    openModal({ title, body });
  }

  function showJobError(title, message) {
    openModal({
      title,
      body: h('div', {}, h('p', { style: { color: 'var(--danger)' }, text: message }), h('p', { class: 'faint', text: '可以检查总对话是否绑定了可用会话、模型是否可用，然后重试。' })),
      foot: h('button', { class: 'btn', text: '关闭', onclick: closeModal }),
    });
  }

  function showPlanResult(job) {
    const plan = job.plan?.tasks ?? [];
    const body = h('div', {},
      h('p', { class: 'muted', text: `已生成 ${plan.length} 个任务节点，全部是「待派发」。检查每条的边界与验收标准，再逐个派发。` }),
      job.warnings?.length ? h('div', { class: 'result-box', style: { borderColor: 'var(--warn-soft)' }, text: job.warnings.join('\n') }) : null,
      h('div', { class: 'plan-list', style: { marginTop: '10px' } },
        ...plan.map((task, index) => h('div', { class: 'plan-item' },
          h('b', { text: `${index + 1}. ${task.title}` }),
          h('p', { text: task.goal }),
          h('ul', {}, ...(task.acceptance ?? []).map((item) => h('li', { text: item }))),
        )),
      ),
    );
    openModal({
      title: '拆解完成',
      body,
      wide: true,
      foot: h('div', { class: 'row' },
        h('button', { class: 'btn', text: '关闭', onclick: closeModal }),
        h('button', { class: 'btn btn-primary', text: '去画布检查', onclick: () => { closeModal(); fitView(); } }),
      ),
    });
  }

  function showVerdict(verdict, task) {
    if (verdict === undefined || verdict === null) return;
    const pass = verdict.verdict === 'pass';
    openModal({
      title: `总对话复核：${task.title}`,
      body: h('div', {},
        h('div', { class: `verdict-box ${pass ? 'pass' : 'fail'}` },
          h('div', { class: 'row' }, h('b', { text: pass ? '判定通过' : '判定不通过' }), h('span', { class: 'chip', text: `score ${verdict.score}` })),
          h('div', { class: 'checklist', style: { marginTop: '8px' } }, ...(verdict.checks ?? []).map((check) => checkRow(check))),
          verdict.reasons?.length ? h('div', { style: { marginTop: '6px' }, text: verdict.reasons.join('；') }) : null,
          verdict.followup ? h('div', { style: { marginTop: '6px' }, text: `打回要求：${verdict.followup}` }) : null,
        ),
        h('p', { class: 'faint', text: '复核只是建议；最终通过/驳回仍由你点。' }),
      ),
      foot: h('div', { class: 'row' },
        h('button', { class: 'btn', text: '关闭', onclick: closeModal }),
        h('button', { class: 'btn btn-primary', text: '通过', onclick: async () => { closeModal(); await acceptOne(task, true); } }),
        h('button', { class: 'btn btn-danger', text: '驳回并打回', onclick: async () => { closeModal(); await acceptOne(task, false); } }),
      ),
    });
  }

  function openKbModal(editId = '') {
    const entries = S.home?.kb ?? [];
    const body = h('div', {});
    body.append(h('p', { class: 'faint', text: '一级禁忌会写进本机每个严格对话的系统提示；二级跟随当前编排板；三级按任务勾选或连线附加；四级只是参考资料。' }));
    for (const level of [1, 2, 3, 4]) {
      const list = entries.filter((entry) => entry.level === level);
      const group = h('div', { class: 'kb-group' },
        h('div', { class: 'kb-group-head' },
          h('span', { class: `chip ${LEVELS[level].tone}`, text: `${LEVELS[level].short} ${LEVELS[level].name}` }),
          h('span', { class: 'kb-desc', text: LEVELS[level].hint }),
        ),
      );
      if (list.length === 0) group.append(h('div', { class: 'faint', style: { padding: '4px 2px' }, text: '（暂无）' }));
      for (const entry of list) {
        group.append(h('div', { class: 'kb-entry' },
          h('div', { class: 'kb-entry-head' },
            h('span', { class: 'kb-entry-title', text: entry.title }),
            entry.locked ? h('span', { class: 'chip critical', text: '内置锁定' }) : null,
            h('div', { class: 'kb-entry-actions' },
              h('button', { class: 'btn btn-sm', text: '编辑', onclick: () => openKbModal(entry.id) }),
              h('button', { class: 'btn btn-sm btn-ghost', text: '删除', disabled: entry.locked, onclick: async () => {
                if (!window.confirm(`删除「${entry.title}」？`)) return;
                try { await api(`/kb/${encodeURIComponent(entry.id)}`, { method: 'DELETE' }); await reloadHome(); openKbModal(); } catch (error) { toast(error.message, 'error'); }
              } }),
            ),
          ),
          h('div', { class: 'kb-entry-text', text: entry.text }),
        ));
      }
      body.append(group);
    }

    const editing = entries.find((entry) => entry.id === editId);
    const form = h('div', { class: 'kb-form' },
      h('div', { class: 'field' }, h('label', { text: '等级' }),
        h('select', { id: 'kb-level' }, ...[1, 2, 3, 4].map((level) => h('option', { value: String(level), text: LEVELS[level].name, selected: (editing?.level ?? 2) === level }))),
      ),
      h('div', { class: 'field' }, h('label', { text: '标题' }), h('input', { id: 'kb-title', value: editing?.title ?? '', placeholder: '例如：不要动生产数据库' })),
      h('div', { class: 'field full' }, h('label', { text: '内容（直接写进提示词）' }), h('textarea', { id: 'kb-text', class: 'tall', value: editing?.text ?? '' })),
    );
    body.append(h('div', { class: 'section' }, h('b', { text: editing ? '编辑条目' : '新增条目' }), form));
    openModal({
      title: '分级知识库',
      body,
      wide: true,
      foot: h('div', { class: 'row' },
        h('button', { class: 'btn', text: '关闭', onclick: closeModal }),
        h('button', { class: 'btn btn-primary', text: editing ? '保存修改' : '新增', onclick: async () => {
          const payload = { level: Number(document.getElementById('kb-level').value), title: document.getElementById('kb-title').value, text: document.getElementById('kb-text').value };
          try {
            if (editing) await api(`/kb/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: payload });
            else await api('/kb', { method: 'POST', body: payload });
            await reloadHome();
            openKbModal();
          } catch (error) { toast(error.message, 'error'); }
        } }),
      ),
    });
  }

  async function reloadHome() {
    const state = await api('/state');
    S.home = state;
  }

  function openSettingsModal() {
    const settings = S.home?.settings ?? {};
    const body = h('div', {},
      h('label', { class: 'row', style: { marginBottom: '10px' } },
        h('input', { type: 'checkbox', id: 'set-inject', checked: settings.injectLevel1Globally !== false }),
        h('span', { text: '把一级禁忌注入本机每个会话的系统提示（最高等级）' }),
      ),
      h('label', { class: 'row', style: { marginBottom: '10px' } },
        h('input', { type: 'checkbox', id: 'set-notify', checked: settings.notifyMasterOnChildDone === true }),
        h('span', { text: '子对话完成时自动把结果摘要发回总对话（会触发总对话一轮）' }),
      ),
      h('label', { class: 'row', style: { marginBottom: '10px' } },
        h('input', { type: 'checkbox', id: 'set-archive', checked: settings.autoArchiveChild !== false }),
        h('span', { text: '自动归档已完成的子任务（子会话从侧栏收起，节点从活跃画布收起）' }),
      ),
      h('div', { class: 'field' },
        h('label', { text: '归档时机' }),
        h('select', { id: 'set-archive-on' },
          h('option', { value: 'pass', text: '验收通过时归档（推荐，先验收再收走）', selected: settings.archiveOn !== 'finished' }),
          h('option', { value: 'finished', text: '子对话一跑完就归档（不等验收）', selected: settings.archiveOn === 'finished' }),
        ),
      ),
      h('div', { class: 'field' }, h('label', { text: '新编排板默认工作目录' }), h('input', { id: 'set-cwd', value: settings.defaultCwd ?? '' })),
      h('p', { class: 'faint', text: '数据目录：' + (S.home?.dataDir ?? '') }),
    );
    openModal({
      title: '设置',
      body,
      foot: h('div', { class: 'row' },
        h('button', { class: 'btn', text: '关闭', onclick: closeModal }),
        h('button', { class: 'btn btn-primary', text: '保存', onclick: async () => {
          try {
            const data = await api('/settings', { method: 'PATCH', body: {
              injectLevel1Globally: document.getElementById('set-inject').checked,
              notifyMasterOnChildDone: document.getElementById('set-notify').checked,
              autoArchiveChild: document.getElementById('set-archive').checked,
              archiveOn: document.getElementById('set-archive-on').value,
              defaultCwd: document.getElementById('set-cwd').value,
            } });
            S.home.settings = data.settings;
            toast('设置已保存', 'ok');
            closeModal();
          } catch (error) { toast(error.message, 'error'); }
        } }),
      ),
    });
  }

  function openBoardModal(isNew) {
    const board = isNew ? null : S.board;
    const body = h('div', {},
      h('div', { class: 'field' }, h('label', { text: '名称' }), h('input', { id: 'board-name', value: board?.name ?? '' })),
      h('div', { class: 'field' }, h('label', { text: '总目标' }), h('textarea', { id: 'board-goal', class: 'tall', value: board?.goal ?? '' })),
      h('div', { class: 'field' }, h('label', { text: '工作目录（子对话的 cwd）' }), h('input', { id: 'board-cwd', value: board?.cwd ?? '' })),
    );
    openModal({
      title: isNew ? '新建编排板' : '编排板设置',
      body,
      foot: h('div', { class: 'row', style: { width: '100%' } },
        isNew ? null : h('button', { class: 'btn btn-danger', text: '删除编排板', onclick: () => deleteBoard() }),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', text: '取消', onclick: closeModal }),
        h('button', { class: 'btn btn-primary', text: isNew ? '创建' : '保存', onclick: async () => {
          const name = document.getElementById('board-name').value.trim() || '新编排板';
          const goal = document.getElementById('board-goal').value;
          const cwd = document.getElementById('board-cwd').value.trim();
          try {
            if (isNew) {
              const created = await api('/boards', { method: 'POST', body: { name, goal, cwd, masterSessionId: S.bridgeSession?.id ?? '', masterTitle: S.bridgeSession?.title ?? '' } });
              closeModal();
              await loadBoard(created.board.id);
            } else {
              const updated = await api(`/boards/${encodeURIComponent(S.boardId)}`, { method: 'PATCH', body: { name, goal, cwd } });
              S.board = updated.board;
              await reloadHome();
              renderTopbar();
              renderBoard();
              closeModal();
            }
          } catch (error) { toast(error.message, 'error'); }
        } }),
      ),
    });
  }

  async function deleteBoard() {
    if (S.board === null) return;
    if (!window.confirm(`删除编排板「${S.board.name}」？\n画布与任务记录会删除，DSH 会话和子对话不会被删除。`)) return;
    try {
      await api(`/boards/${encodeURIComponent(S.boardId)}`, { method: 'DELETE' });
      closeModal();
      await reloadHome();
      const next = S.home.boards[0];
      if (next !== undefined) {
        await loadBoard(next.id);
      } else {
        S.board = null;
        S.boardId = '';
        location.hash = '';
        renderTopbar();
        renderEmpty();
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function openHelpModal() {
    openModal({
      title: '怎么用',
      body: h('div', { style: { lineHeight: '21px' } },
        h('p', { text: '1. 建一块编排板，并把「总对话」绑定到当前 DSH 会话。' }),
        h('p', { text: '2. 写清总目标，点顶栏「拆解任务」；总对话会输出一份 JSON 计划，插件把它变成任务节点。' }),
        h('p', { text: '3. 逐个检查任务的边界与验收标准，点「派发」；每个任务会新开一个隔离子对话，只收到自己的任务书。' }),
        h('p', { text: '4. 子对话跑完会停在「待验收」；看结果、可以让总对话先复核，最后你点通过或驳回打回。' }),
        h('p', { class: 'faint', text: '一级禁忌永远生效；子对话之间没有消息通道，前置结果只由总对话转交摘要。' }),
      ),
      foot: h('button', { class: 'btn', text: '知道了', onclick: closeModal }),
    });
  }

  /* ───────────────────────────── 视图操作 ───────────────────────────── */

  function zoomBy(factor) {
    const rect = D.stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const before = screenToWorld(cx, cy);
    S.camera.k = Math.min(2.6, Math.max(0.25, S.camera.k * factor));
    S.camera.x = cx - rect.left - before.x * S.camera.k;
    S.camera.y = cy - rect.top - before.y * S.camera.k;
    S.viewMoved = true;
    applyCamera();
  }

  function fitView() {
    if (S.board === null || D.nodeEls === undefined) return;
    const nodes = S.board.nodes;
    if (nodes.length === 0) {
      S.camera = { x: 60, y: 40, k: 1 };
      applyCamera();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      if (!isNodeVisible(node)) continue;
      const el = D.nodeEls.get(node.id);
      const w = el?.offsetWidth ?? nodeWidth(node);
      const height = el?.offsetHeight ?? 120;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + w);
      maxY = Math.max(maxY, node.y + height);
    }
    const rect = D.stage.getBoundingClientRect();
    const pad = 70;
    const k = Math.min(1.2, Math.max(0.25, Math.min((rect.width - pad * 2) / Math.max(1, maxX - minX), (rect.height - pad * 2) / Math.max(1, maxY - minY))));
    S.camera.k = k;
    S.camera.x = (rect.width - (maxX - minX) * k) / 2 - minX * k;
    S.camera.y = (rect.height - (maxY - minY) * k) / 2 - minY * k;
    applyCamera();
  }

  /* ───────────────────────────── 启动 ───────────────────────────── */

  boot().catch((error) => {
    document.getElementById('app').innerHTML = `<div style="padding:24px;color:#e06a60">编排台启动失败：${esc(error.message)}</div>`;
  });

  // 节点拖线在骨架建好后绑定一次（事件委托）。
  const waitForNodes = setInterval(() => {
    if (D.nodes === undefined) return;
    clearInterval(waitForNodes);
    bindPortDrag();
  }, 50);
})();
