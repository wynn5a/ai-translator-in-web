/* ================= 配置 ================= */

const DEFAULTS = { hotkey: 'Control', targetLang: '简体中文', disabledHosts: [] };
const cfg = { ...DEFAULTS };
const HOST = location.hostname;
let enabled = true;

chrome.storage.local.get(DEFAULTS).then((v) => (Object.assign(cfg, v), syncEnabled()));
chrome.storage.onChanged.addListener((c) => {
  for (const k in c) if (k in cfg) cfg[k] = c[k].newValue;
  if (c.disabledHosts) syncEnabled();
});

function syncEnabled() {
  enabled = !(cfg.disabledHosts || []).includes(HOST);
  if (!enabled) (hideTip(), highlight(null));
}

const MARK = 'aiTranslation'; // → data-ai-translation
const BLOCKS = /^(P|LI|BLOCKQUOTE|H[1-6]|DD|DT|TD|FIGCAPTION|PRE|ARTICLE|SECTION|MAIN|DIV)$/;
const LONG_TEXT = 2000; // 超过此长度的段落先确认再翻译
const HOLD_MAX = 1200; // 按住热键超过此时长视为「另有用途」，不触发

/* ---------- 语种判断：与目标语言一致才跳过 ---------- */

const SCRIPTS = [
  ['ja', /[぀-ヿ]/g, 0.05], // 假名出现即判为日语（日文含汉字）
  ['ko', /[가-힯]/g, 0.3],
  ['zh', /[㐀-䶿一-鿿]/g, 0.3],
  ['ru', /[Ѐ-ӿ]/g, 0.3],
  ['en', /[A-Za-z]/g, 0.3],
];

const TARGETS = [
  [/中文|汉语|漢語|chinese|mandarin/i, 'zh'],
  [/日本語|日语|japanese/i, 'ja'],
  [/한국|韩语|korean/i, 'ko'],
  [/русск|俄语|russian/i, 'ru'],
  [/english|英语|英文/i, 'en'],
];

function detectScript(text) {
  const s = text.slice(0, 800);
  const counts = SCRIPTS.map(([, re]) => (s.match(re) || []).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return '';
  for (let i = 0; i < SCRIPTS.length; i++) if (counts[i] / total > SCRIPTS[i][2]) return SCRIPTS[i][0];
  return '';
}

/** 只有识别出的语种与目标语言相同才跳过；目标语言无法识别时一律翻译 */
function alreadyTarget(text) {
  const target = TARGETS.find(([re]) => re.test(cfg.targetLang))?.[1];
  return !!target && detectScript(text) === target;
}

/** 从鼠标所在节点向上找到最近的、含足量文字的块级元素 */
function findBlock(node) {
  for (let el = node?.nodeType === 3 ? node.parentElement : node; el && el !== document.body; el = el.parentElement) {
    if (el.dataset?.[MARK] || !BLOCKS.test(el.tagName)) continue;
    if (getComputedStyle(el).display === 'inline') continue;
    const text = el.innerText?.trim();
    if (text && text.length >= 8) return el;
  }
  return null;
}

/* ---------- 注入页面的样式：加载动画 / 悬停高亮 / 译文标记 ---------- */

const DOTS_CSS = `
.ai-tr-dots{display:inline-flex;align-items:center;gap:.28em;vertical-align:baseline}
.ai-tr-dots i{width:.42em;height:.42em;border-radius:50%;background:currentColor;
  animation:ai-tr-bounce 1.1s infinite ease-in-out both}
.ai-tr-dots i:nth-child(2){animation-delay:.16s}
.ai-tr-dots i:nth-child(3){animation-delay:.32s}
@keyframes ai-tr-bounce{0%,70%,100%{opacity:.22;transform:translateY(0) scale(.85)}
  35%{opacity:.9;transform:translateY(-.3em) scale(1)}}
@media (prefers-reduced-motion:reduce){.ai-tr-dots i{animation:ai-tr-fade 1.1s infinite}}
@keyframes ai-tr-fade{0%,100%{opacity:.25}50%{opacity:.9}}`;

const PAGE_CSS = `${DOTS_CSS}
[data-ai-tr-hover]{outline:2px solid rgba(47,111,237,.55)!important;outline-offset:2px!important;
  border-radius:3px;transition:outline-color .12s}
.ai-tr-retry{all:unset;cursor:pointer;text-decoration:underline;font:inherit}`;

let pageStyled = false;
function injectPageCss() {
  if (pageStyled) return;
  pageStyled = true;
  const style = document.createElement('style');
  style.textContent = PAGE_CSS;
  (document.head || document.documentElement).append(style);
}

function dots() {
  injectPageCss();
  const el = document.createElement('span');
  el.className = 'ai-tr-dots';
  el.append(...[0, 0, 0].map(() => document.createElement('i')));
  return el;
}

/* ---------- 划词气泡：Shadow DOM，锚点跟随滚动 ---------- */

const TIP_CSS = `
.tip{position:fixed;box-sizing:border-box;width:max-content;max-width:min(380px,calc(100vw - 16px));
  min-width:2em;padding:10px 12px;border-radius:10px;
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:#f5f5f5;background:#23252b;box-shadow:0 6px 24px rgba(0,0,0,.28);
  white-space:pre-wrap;word-break:break-word;user-select:text}
@media (prefers-color-scheme:light){
  .tip{color:#1c1e21;background:#fff;border:1px solid #e3e5e9;box-shadow:0 6px 24px rgba(0,0,0,.14)}}
.tip[hidden]{display:none}
.tip.err .body{color:#ff8a80}
@media (prefers-color-scheme:light){.tip.err .body{color:#c4362c}}
.tip.hint .body{opacity:.75;font-size:13px}
.bar{display:flex;gap:8px;margin-top:9px}
.bar[hidden]{display:none}
.bar button{font:inherit;font-size:12px;line-height:1.4;padding:3px 10px;border-radius:6px;cursor:pointer;
  border:1px solid currentColor;background:transparent;color:inherit;opacity:.7}
.bar button:hover{opacity:1}`;

/**
 * 页面的 `!important` 规则会命中这个顶层 div（Jira 就把它变成 display:none），
 * 宿主一旦不渲染，shadow 里的气泡连布局盒都没有，visibility 还会继承进去。
 * 所以宿主样式必须用 !important 钉死：行内 !important 压得住页面的 !important。
 */
const HOST_CSS =
  'all:initial!important;position:fixed!important;top:0!important;left:0!important;' +
  'width:0!important;height:0!important;display:block!important;z-index:2147483647!important';

let tipHost, tipEl, tipBody, tipBar;
let anchor = null; // { rect() }
let flip = null; // 首帧决定展开方向，流式追加时不再改变
let hintTimer;

function ensureTip() {
  if (tipEl) return;
  tipHost = document.createElement('div');
  tipHost.style.cssText = HOST_CSS;
  const shadow = tipHost.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    `<style>${TIP_CSS}${DOTS_CSS}</style>` +
    '<div class="tip" hidden><div class="body"></div><div class="bar" hidden></div></div>';
  document.documentElement.append(tipHost);
  tipEl = shadow.querySelector('.tip');
  tipBody = shadow.querySelector('.body');
  tipBar = shadow.querySelector('.bar');
}

const rangeAnchor = (range) => ({ rect: () => range.getBoundingClientRect() });

/** 选区节点被页面改动、拿不到矩形时的退路：锚在鼠标处 */
let mouse = { x: innerWidth / 2, y: innerHeight / 2 };
const pointAnchor = () => ({
  rect: () => ({ left: mouse.x, right: mouse.x, top: mouse.y, bottom: mouse.y, width: 0 }),
});

/** 长段落的矩形很高，锚在它顶部一小段上，气泡才不会跑到屏幕外 */
const blockAnchor = (block) => ({
  rect: () => {
    const r = block.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: Math.min(r.bottom, r.top + 26), width: r.width };
  },
});

function openAt(a) {
  clearTimeout(hintTimer);
  anchor = a;
  flip = null;
}

/** content 可以是字符串或 DOM 节点（加载动画） */
function showTip(content, { error = false, hint = false, actions = [] } = {}) {
  ensureTip();
  if (typeof content === 'string') tipBody.textContent = content;
  else tipBody.replaceChildren(content);
  tipEl.classList.toggle('err', error);
  tipEl.classList.toggle('hint', hint);
  tipBar.replaceChildren(
    ...actions.map(({ label, onClick }) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = onClick;
      return b;
    })
  );
  tipBar.hidden = !actions.length;
  tipEl.hidden = false;
  place();
}

function place() {
  if (!tipEl || tipEl.hidden) return;
  let r = anchor?.rect();
  if (!r || (!r.width && !r.top && !r.left)) {
    anchor = pointAnchor(); // 锚点失效（页面把选区节点换掉了）：退到鼠标处，不让气泡凭空消失
    r = anchor.rect();
  }
  if (r.bottom < 0 || r.top > innerHeight) {
    tipEl.style.visibility = 'hidden'; // 锚点滚出视口：藏起来但不中断翻译
    return;
  }
  tipEl.style.visibility = '';
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  if (flip === null) flip = r.bottom + 10 + h > innerHeight && r.top - 10 - h > 8;
  tipEl.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  if (flip) {
    // 向上展开时钉住底边，内容变长不会让气泡整体上跳
    tipEl.style.top = 'auto';
    tipEl.style.bottom = `${Math.max(8, innerHeight - r.top + 10)}px`;
  } else {
    tipEl.style.bottom = 'auto';
    tipEl.style.top = `${Math.max(8, Math.min(r.bottom + 10, innerHeight - h - 8))}px`;
  }
}

let raf = 0;
const reposition = () => {
  if (raf || !tipEl || tipEl.hidden) return;
  raf = requestAnimationFrame(() => ((raf = 0), place()));
};
addEventListener('scroll', reposition, true);
addEventListener('resize', reposition);

let pending = null;
function hideTip() {
  clearTimeout(hintTimer);
  pending?.cancel();
  pending = null;
  anchor = null;
  if (tipEl) (tipEl.hidden = true), tipBar.replaceChildren();
}

/** 一闪而过的弱提示 */
function flash(a, text) {
  openAt(a);
  showTip(text, { hint: true });
  hintTimer = setTimeout(hideTip, 1600);
}

/* ---------- 语境：短词/短语取所在句子一起送给模型 ---------- */

const isTerm = (t) => t.split(/\s+/).length <= 5 && !/[.!?。！？]/.test(t);

function sentenceAround(range) {
  const block = findBlock(range.startContainer);
  if (!block) return '';

  // 用选区在块内的真实字符偏移定位，避免同一个词多次出现时取错句子
  const head = document.createRange();
  head.setStart(block, 0);
  head.setEnd(range.startContainer, range.startOffset);
  const full = block.textContent;
  const at = head.toString().length;
  const end = at + range.toString().length;

  const before = [...full.slice(0, at).matchAll(/[.!?。！？;；]\s/g)].pop();
  const after = full.slice(end).search(/[.!?。！？](\s|$)/);
  const sentence = full
    .slice(before ? before.index + before[0].length : 0, after < 0 ? full.length : end + after + 1)
    .replace(/\s+/g, ' ')
    .trim();

  return sentence.length > end - at ? sentence.slice(0, 600) : '';
}

/* ---------- 后台通信（流式） ---------- */

function requestTranslation(payload, onPartial) {
  let port;
  const task = new Promise((resolve) => {
    try {
      port = chrome.runtime.connect();
    } catch {
      return resolve({ error: '扩展已更新或被禁用，请刷新页面后重试', code: 'reload' });
    }
    let partial = '';
    port.onMessage.addListener((m) => {
      if (m.chunk !== undefined) onPartial((partial = m.chunk));
      else if (m.error) resolve({ error: m.error, code: m.code });
      else if (m.done) resolve({ text: m.text });
    });
    port.onDisconnect.addListener(() => resolve(partial ? { text: partial } : { error: '连接中断，请重试' }));
    port.postMessage(payload);
  });
  task.cancel = () => port?.disconnect(); // 断开即中止后台请求
  return task;
}

function errorActions(code, retry) {
  const actions = [{ label: '重试', onClick: retry }];
  if (code === 'no-key') actions.unshift({ label: '去设置', onClick: () => chrome.runtime.sendMessage({ type: 'openOptions' }) });
  return actions;
}

/* ---------- 划词翻译 ---------- */

/** range 可能为 null（选区节点已被页面替换，只剩文本） */
async function runSelection(text, range) {
  openAt(range ? rangeAnchor(range) : pointAnchor());
  const context = range && isTerm(text) ? sentenceAround(range) : '';
  showTip(dots());

  const task = (pending = requestTranslation({ text, context }, (p) => pending === task && showTip(p)));
  const { text: out, error, code } = await task;
  if (pending !== task) return; // 已被 Esc / 点击 / 新的翻译取代
  pending = null;
  if (error) showTip(error, { error: true, actions: errorActions(code, () => runSelection(text, range)) });
  else showTip(out);
}

/* ---------- 段落翻译：复制原段落样式插入译文 ---------- */

/** 这些元素插同级节点会打乱列表编号 / 表格结构，改为插在其内部 */
const INSIDE = /^(LI|TD|TH|DT|DD)$/;
const running = new WeakMap(); // 译文节点 → 进行中的请求

function existingTranslation(block) {
  const inner = block.lastElementChild;
  if (inner?.dataset?.[MARK]) return inner;
  const next = block.nextElementSibling;
  return next?.dataset?.[MARK] ? next : null;
}

/** 用 <br> 还原换行，而不是给译文加 white-space —— 渲染样式必须和原文完全一致 */
function fillText(el, text) {
  const lines = text.split('\n');
  el.replaceChildren(
    ...lines.flatMap((line, i) => (i ? [document.createElement('br'), new Text(line)] : [new Text(line)]))
  );
}

/** 创建承载译文的节点，使其与原文渲染样式一致 */
function createTarget(block) {
  let el;
  if (INSIDE.test(block.tagName)) {
    el = document.createElement('div'); // 继承字体/字号/行高/颜色，且不参与列表计数
    block.append(el);
  } else {
    el = document.createElement(block.tagName);
    // 原样搬过来，让页面 CSS 用同样的规则命中它；id 不能重复，行内事件不该复制
    for (const { name, value } of block.attributes)
      if (name !== 'id' && !name.startsWith('on')) el.setAttribute(name, value);
    block.after(el);
  }
  el.dataset[MARK] = '1';
  return el;
}

function blockError(block, target, error, code) {
  target.style.color = '#c62828';
  const msg = document.createElement('span');
  msg.textContent = `${error} `;
  const retry = document.createElement('button');
  retry.className = 'ai-tr-retry';
  retry.textContent = '重试';
  retry.onclick = () => (target.remove(), runBlock(block, true));
  target.replaceChildren(msg, retry);
  if (code === 'no-key') {
    const open = document.createElement('button');
    open.className = 'ai-tr-retry';
    open.textContent = '去设置';
    open.onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });
    target.append(document.createTextNode(' · '), open);
  }
}

async function runBlock(block, force) {
  const done = existingTranslation(block);
  if (done) {
    running.get(done)?.cancel(); // 收起译文 = 立即中止请求，不等下一个分片
    return done.remove();
  }

  const source = block.innerText.trim(); // 必须在插入占位节点之前取
  if (!source) return;
  if (!force && source.length > LONG_TEXT) {
    openAt(blockAnchor(block));
    return showTip(`这段有 ${source.length} 字，翻译会消耗较多额度。`, {
      hint: true,
      actions: [{ label: '继续翻译', onClick: () => (hideTip(), runBlock(block, true)) }],
    });
  }

  const target = createTarget(block);
  target.replaceChildren(dots());
  const task = requestTranslation({ text: source }, (p) => {
    if (target.isConnected) fillText(target, p);
    else task.cancel(); // 页面变化导致节点消失，停止请求
  });
  running.set(target, task);

  const { text, error, code } = await task;
  running.delete(target);
  if (!target.isConnected) return;
  if (error) blockError(block, target, error, code);
  else fillText(target, text);
}

/* ---------- 触发：单独按下并松开热键（组合键不触发） ---------- */

const MODS = { Control: 'ctrlKey', Alt: 'altKey', Shift: 'shiftKey' };
const ALL_MODS = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'];
const otherModifier = (e) => ALL_MODS.some((m) => e[m] && m !== MODS[cfg.hotkey]);

let hovered = null;
let rightClicked = null;
let armedAt = 0;
let marked = null;

/** 事件 target 会被重定向到 host，但选区节点可能直接落在 shadow 树里 */
const insideTip = (node) =>
  !!tipHost && (node === tipHost || tipHost.contains(node) || node?.getRootNode?.()?.host === tipHost);

function highlight(el) {
  if (marked === el) return;
  if (marked) delete marked.dataset.aiTrHover;
  marked = el;
  if (el) (injectPageCss(), (el.dataset.aiTrHover = '1'));
}

function candidate() {
  if (!hovered || insideTip(hovered)) return null;
  return findBlock(hovered);
}

/* ---------- 选区缓存 ---------- */

/**
 * 页面自定义的划词菜单常会把选区收走：focus 到隐藏输入框、removeAllRanges()、
 * 或在选区所在节点里插入菜单节点。此时 getSelection() 已经是空的，
 * 但用户看到的仍是「我选了字」，所以记住最近一次有效选区作为退路。
 */
let saved = null; // { range, text, raw }

function rememberSelection() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || insideTip(sel.anchorNode)) return; // 选区被收走时保留上一次
  const text = sel.toString().trim(); // Selection 的文本是按渲染取的，跨段落带换行
  if (!text) return;
  const range = sel.getRangeAt(0).cloneRange();
  saved = { range, text, raw: range.toString() }; // raw 只用来判断 range 还指着同一段文字
}

/** 当前该翻译的选区：优先实时选区，其次缓存；range 已失效时只保留文本 */
function activeSelection() {
  rememberSelection();
  if (!saved) return null;
  const { range, text, raw } = saved;
  const alive = range.startContainer.isConnected && range.toString() === raw;
  return alive ? saved : { range: null, text };
}

/** 按住热键期间高亮将被翻译的段落；有选区时走划词路径，不高亮 */
function previewTarget() {
  highlight(activeSelection() ? null : candidate());
}

function disarm() {
  armedAt = 0;
  highlight(null);
}

function trigger() {
  const sel = activeSelection();
  if (sel) {
    const anchor = sel.range ? rangeAnchor(sel.range) : pointAnchor();
    if (alreadyTarget(sel.text)) return flash(anchor, `已经是${cfg.targetLang}`);
    return runSelection(sel.text, sel.range);
  }
  const block = candidate();
  if (!block) {
    // 静默失败最难查：让用户知道热键收到了，只是鼠标底下没有可翻译的目标
    if (hovered && !insideTip(hovered)) flash(pointAnchor(), '这里没找到可翻译的段落');
    return;
  }
  if (alreadyTarget(block.innerText)) return flash(blockAnchor(block), `已经是${cfg.targetLang}`);
  runBlock(block, false);
}

addEventListener(
  'mouseover',
  (e) => ((hovered = e.target), (mouse = { x: e.clientX, y: e.clientY }), armedAt && previewTarget()),
  true
);
// 捕获阶段先记下选区：页面菜单可能在自己的 mouseup 里就把选区收走了
addEventListener('mouseup', rememberSelection, true);
document.addEventListener('selectionchange', rememberSelection, true);
// 新的点击 = 新的意图，缓存作废（若页面菜单特意保住了选区，实时选区仍在，不受影响）
addEventListener('mousedown', (e) => (insideTip(e.target) ? disarm() : ((saved = null), disarm(), hideTip())), true);
addEventListener('wheel', disarm, { capture: true, passive: true }); // Ctrl+滚轮缩放后松手不该触发
addEventListener('contextmenu', (e) => ((rightClicked = e.target), disarm()), true);
addEventListener('blur', disarm);
document.addEventListener('visibilitychange', disarm);

addEventListener(
  'keydown',
  (e) => {
    if (!enabled) return;
    if (e.key === cfg.hotkey && !e.repeat && !otherModifier(e)) (armedAt = performance.now()), previewTarget();
    else disarm();
  },
  true
);

addEventListener(
  'keyup',
  (e) => {
    if (e.key === 'Escape') return hideTip();
    if (!enabled || e.key !== cfg.hotkey || !armedAt) return;
    const held = performance.now() - armedAt;
    disarm();
    if (held <= HOLD_MAX) trigger();
  },
  true
);

/* ---------- 右键菜单入口 ---------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'translate-selection') {
    const sel = activeSelection();
    if (sel) runSelection(sel.text, sel.range);
  } else if (msg?.type === 'translate-block') {
    const block = findBlock(rightClicked || hovered);
    if (block) runBlock(block, false);
  }
});
