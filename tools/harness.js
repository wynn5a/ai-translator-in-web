/* ================= 测试用的加载器 =================

   把 content.js / background.js 原样跑进一个 vm 上下文里（不是复制粘贴片段），
   函数声明会挂到上下文的全局对象上，const 声明取不到，用 read(ctx, '名字') 读。

   DOM 只实现 render 真正用到的那几个方法。**它模拟不了 CSS**——
   display / white-space / flex 子项 blockify 都要真实排版引擎，
   所以 encodeInline 的测试在 tools/test.html 里跑，这里只测纯逻辑。 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* ---------- 最小 DOM ---------- */

const VOID = new Set(['BR', 'IMG', 'HR', 'INPUT']);

class Txt {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
  }
  cloneNode() {
    return new Txt(this.data);
  }
}

class El {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    return this;
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  append(...nodes) {
    // 真实 DOM 里 append 一个 fragment 会把它的孩子摊平进来，render 依赖这个行为
    for (const n of nodes) this.childNodes.push(...(n.tagName === '#FRAGMENT' ? n.childNodes : [n]));
  }
  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }
  cloneNode(deep) {
    const el = new El(this.tagName);
    el.attrs = new Map(this.attrs);
    if (deep) el.childNodes = this.childNodes.map((n) => n.cloneNode(true));
    return el;
  }
}

/** 序列化成 HTML，用于断言 */
function html(node) {
  if (node.nodeType === 3) return node.data;
  const inner = node.childNodes.map(html).join('');
  if (node.tagName === '#FRAGMENT') return inner;
  const tag = node.tagName.toLowerCase();
  const attrs = [...node.attrs].map(([k, v]) => ` ${k}="${v}"`).join('');
  return VOID.has(node.tagName) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${inner}</${tag}>`;
}

const el = (tagName, attrs = {}) => {
  const node = new El(tagName);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const makeDocument = () => ({
  createElement: (tag) => new El(tag),
  createDocumentFragment: () => new El('#fragment'),
  addEventListener() {},
  documentElement: new El('html'),
  head: new El('head'),
  querySelector: () => null,
});

/* ---------- 加载被测脚本 ---------- */

const chromeStub = () => ({
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
  runtime: {
    connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }),
    sendMessage: async () => ({}),
    onMessage: { addListener() {} },
    onConnect: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  contextMenus: { create() {}, removeAll() {}, onClicked: { addListener() {} } },
  tabs: { sendMessage: async () => {} },
  offscreen: { hasDocument: async () => true, createDocument: async () => {} },
});

function run(files, extra) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextDecoder,
    AbortController,
    DOMException,
    URL,
    chrome: chromeStub(),
    ...extra,
  };
  const ctx = vm.createContext(sandbox);
  for (const f of files) vm.runInContext(source(f), ctx, { filename: f });
  ctx.read = (expr) => vm.runInContext(expr, ctx); // const 声明只能这样取
  return ctx;
}

/** content.js：加载时会读配置、注册一堆监听，全部给桩 */
const loadContent = () =>
  run(['config.js', 'markers.js', 'content.js'], {
    document: makeDocument(),
    Text: Txt,
    location: { hostname: 'test.local' },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    performance: { now: () => 0 },
    // 只有 encodeInline 会用到，而 encodeInline 的测试在浏览器里跑
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', whiteSpace: 'normal' }),
  });

/** background.js：顶上的 importScripts 换成直接把依赖跑在同一个上下文里 */
const loadBackground = () =>
  run(['config.js', 'markers.js', 'background.js'], { importScripts() {}, fetch: async () => {} });

module.exports = { loadContent, loadBackground, html, el, El, Txt };
