/**
 * 用 Chrome DevTools Protocol 检查真实 DSH 页面：
 *   - 侧栏是否出现「编排台」
 *   - 点开后 iframe 是否挂载、画布是否渲染
 *   - 有没有未捕获异常 / console error
 *
 *   node scripts/cdp-check.mjs "http://127.0.0.1:51999/?token=..."
 */
const url = process.argv[2];
if (url === undefined) {
  console.error('用法：node scripts/cdp-check.mjs <url>');
  process.exit(2);
}
const port = 9333;
const { spawn } = await import('node:child_process');
const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(join(tmpdir(), 'orchestra-cdp-'));
const chrome = spawn(chromePath, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--no-proxy-server',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  '--window-size=1600,1000',
  'about:blank',
], { stdio: 'ignore' });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?url=about:blank`, { method: 'PUT' });
      if (response.ok) return await response.json();
    } catch {
      // Chrome 还没起
    }
    await wait(200);
  }
  throw new Error('Chrome 调试端口没起来');
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
const errors = [];
const logs = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
  if (message.method === 'Runtime.consoleAPICalled') {
    logs.push(message.params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '));
  }
};

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
  return result.result?.result?.value;
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await wait(6000);

const sidebar = await evaluate(`Boolean(document.querySelector('button[aria-label="编排台"]'))`);
console.log('侧栏入口：', sidebar ? '有' : '没有');
// 首次启动 DSH 会有「预览版说明」弹窗，挡在面板前面；顺手关掉。
await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => (item.textContent ?? '').trim() === '继续'); button?.click(); return Boolean(button); })()`);
await wait(800);
await evaluate(`document.querySelector('button[aria-label="编排台"]')?.click(); true`);
await wait(4000);

const info = await evaluate(`(() => {
  const frame = document.querySelector('iframe');
  let body = '';
  let fit = {};
  try {
    body = frame?.contentDocument?.body?.innerText ?? '';
    const doc = frame.contentDocument;
    fit = {
      theme: doc.documentElement.dataset.theme ?? '',
      stage: [Math.round(doc.querySelector('.stage')?.getBoundingClientRect().width ?? 0), Math.round(doc.querySelector('.stage')?.getBoundingClientRect().height ?? 0)],
      world: doc.querySelector('.world')?.style.transform ?? '',
      nodes: doc.querySelectorAll('.node').length,
    };
  } catch (error) { body = 'blocked: ' + error.message; }
  return { frames: document.querySelectorAll('iframe').length, src: frame?.getAttribute('src') ?? '', body: body.slice(0, 400), fit, panel: Boolean(document.querySelector('.dsh-orchestra-panel')) };
})()`);
console.log('面板：', JSON.stringify(info, null, 2));
console.log('未捕获异常/console error：', errors.length === 0 ? '无' : errors.slice(0, 6));
console.log('console 输出：', logs.slice(0, 6));

const shotPath = process.argv[3];
if (shotPath !== undefined) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(shotPath, Buffer.from(shot.result.data, 'base64'));
  console.log('截图：', shotPath);
}

ws.close();
chrome.kill();
await wait(800);
for (let attempt = 0; attempt < 5; attempt += 1) {
  try {
    await rm(profile, { recursive: true, force: true });
    break;
  } catch {
    await wait(400);
  }
}
