/**
 * 编排台（dsh-orchestra）—— 浏览器半区。
 *
 * 只做三件事：
 *   ① 在侧栏注册「编排台」入口，在主面板装一个 iframe（/orchestra/）；
 *   ② 把「当前 DSH 会话」推给 iframe，让总对话节点能一键绑定；
 *   ③ 接收 iframe 的「打开某个会话」请求，交给 uiWorkspace 切过去。
 *
 * 真正的画布逻辑在 app/app.js（纯 DOM/SVG，无需构建）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-orchestra',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const PACKAGE = 'dsh-orchestra';
    const PANEL_ID = 'orchestra';
    const TITLE = '编排台';
    const SRC = '/orchestra/';

    const CSS = `
.dsh-orchestra-panel{display:flex;min-height:0;height:100%;width:100%;background:var(--dsw-alias-bg-layer-1,#141519)}
.dsh-orchestra-panel iframe{display:block;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-layer-1,#141519)}
`;

    // 主面板会替换对话界面，mainView 的保留计数在面板打开后会掉到 0；
    // 记住最后一次仍被主界面持有的会话，面板就能继续把它当「当前对话」。
    let lastCurrentSession = null;
    function currentSession(ctx) {
      try {
        const snapshot = ctx.sessions.list.getSnapshot();
        const row = Object.values(snapshot.byId ?? {}).find((candidate) => (candidate.retainedBy?.mainView ?? 0) > 0);
        if (row !== undefined) lastCurrentSession = { id: row.id, title: row.displayTitle ?? row.id };
        return lastCurrentSession;
      } catch {
        return lastCurrentSession;
      }
    }

    function Panel({ ctx }) {
      const frameRef = React.useRef(null);

      React.useEffect(() => {
        const frame = frameRef.current;
        if (frame === null) return undefined;
        const origin = window.location.origin;

        const send = (type, payload = {}) => {
          try {
            frame.contentWindow?.postMessage({ source: PACKAGE, type, ...payload }, origin);
          } catch {
            // iframe 还没就绪时忽略
          }
        };
        const sendCurrent = () => {
          const session = currentSession(ctx);
          send('orchestra:current-session', { session });
        };
        const sendTheme = () => {
          send('orchestra:theme', { dark: document.body?.hasAttribute('data-ds-dark-theme') === true });
        };
        const onLoad = () => {
          sendCurrent();
          sendTheme();
        };
        const onMessage = (event) => {
          if (event.origin !== origin) return;
          const data = event.data;
          if (data === null || typeof data !== 'object' || data.source !== PACKAGE) return;
          if (data.type === 'orchestra:ready') {
            sendCurrent();
            sendTheme();
            return;
          }
          if (data.type === 'orchestra:request-current') {
            sendCurrent();
            return;
          }
          if (data.type === 'orchestra:open-session' && typeof data.sessionId === 'string' && data.sessionId !== '') {
            try {
              ctx.uiWorkspace.openSession(data.sessionId);
            } catch {
              send('orchestra:bridge-error', { message: '打不开这个会话（可能已被归档或删除）' });
            }
          }
        };

        frame.addEventListener('load', onLoad);
        window.addEventListener('message', onMessage);
        const unsubscribe = ctx.sessions.list.subscribe(sendCurrent);
        const themeObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(sendTheme);
        if (themeObserver !== null && document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        if (frame.contentWindow) onLoad();

        return () => {
          frame.removeEventListener('load', onLoad);
          window.removeEventListener('message', onMessage);
          unsubscribe?.();
          themeObserver?.disconnect();
        };
      }, [ctx]);

      return h(
        'div',
        { className: 'dsh-orchestra-panel' },
        h('iframe', { ref: frameRef, src: SRC, title: TITLE, allow: 'clipboard-write' }),
      );
    }

    function Glyph(props) {
      const size = props?.size ?? 18;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M5 6.2h5.2M13.8 6.2H19M5 17.8h5.2M13.8 17.8H19', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 6.2, r: 2.6, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { cx: 12, cy: 17.8, r: 2.6, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M12 8.8v6.4', stroke: 'currentColor', strokeWidth: 1.5, strokeDasharray: '2.4 2.6', strokeLinecap: 'round' }),
      );
    }

    function apply(ctx) {
      // 常驻记录「主界面当前会话」：面板打开后 mainView 计数会清零，
      // 只在面板内读会读到 null，所以从插件加载起就跟着会话列表更新。
      ctx.effect(() => {
        const remember = () => {
          currentSession(ctx);
        };
        const unsubscribe = ctx.sessions.list.subscribe(remember);
        remember();
        return () => unsubscribe?.();
      }, `${PACKAGE}: remember current session`);

      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-plugin', PACKAGE);
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, `${PACKAGE}: styles`);

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 43, label: () => TITLE }, Glyph),
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel, { ctx })),
      );
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace'],
      apply,
      PANEL_ID,
    };
  },
});
