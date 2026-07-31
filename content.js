const DEFAULTS = { hotkey: 'Control' };
const cfg = { ...DEFAULTS };
chrome.storage.local.get(DEFAULTS).then((v) => Object.assign(cfg, v));
chrome.storage.onChanged.addListener((c) => {
  for (const k in c) if (k in cfg) cfg[k] = c[k].newValue;
});

const MARK = 'aiTranslation';
const BLOCKS = /^(P|LI|BLOCKQUOTE|H[1-6]|DD|DT|TD|FIGCAPTION|PRE|ARTICLE|SECTION|MAIN|DIV)$/;

/** 已经是中文的文本不翻译 */
function isChinese(text) {
  const dense = text.replace(/\s/g, '');
  return dense.length > 0 && (text.match(/[一-鿿]/g)?.length || 0) / dense.length > 0.3;
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

/* ---------- 加载动画：三点跳动，颜色随宿主文字 ---------- */

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

let pageStyled = false;
function dots() {
  if (!pageStyled) {
    pageStyled = true;
    const style = document.createElement('style');
    style.textContent = DOTS_CSS;
    (document.head || document.documentElement).append(style);
  }
  const el = document.createElement('span');
  el.className = 'ai-tr-dots';
  el.append(...[0, 0, 0].map(() => document.createElement('i')));
  return el;
}

/* ---------- 划词：Shadow DOM 气泡 ---------- */

let tip;
function tooltip() {
  if (tip) return tip;
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    .tip{position:fixed;max-width:380px;min-width:2em;padding:10px 12px;border-radius:10px;
      font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      color:#f5f5f5;background:#23252b;box-shadow:0 6px 24px rgba(0,0,0,.28);
      white-space:pre-wrap;word-break:break-word;user-select:text}
    .tip[hidden]{display:none}
    .err{color:#ff8a80}
    ${DOTS_CSS}
  </style><div class="tip" hidden></div>`;
  document.documentElement.appendChild(host);
  tip = shadow.querySelector('.tip');
  return tip;
}

/** content 可以是字符串或 DOM 节点（加载动画） */
function showTip(rect, content, isError) {
  const el = tooltip();
  if (typeof content === 'string') el.textContent = content;
  else el.replaceChildren(content);
  el.classList.toggle('err', !!isError);
  el.hidden = false;
  el.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - el.offsetWidth - 8))}px`;
  const below = rect.bottom + 8;
  el.style.top = `${below + el.offsetHeight > innerHeight ? Math.max(8, rect.top - el.offsetHeight - 8) : below}px`;
}

let pending;
const hideTip = () => {
  pending?.cancel();
  if (tip) tip.hidden = true;
};

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
    } catch (e) {
      return resolve({ error: e.message });
    }
    let partial = '';
    port.onMessage.addListener((m) => {
      if (m.chunk !== undefined) onPartial((partial = m.chunk));
      else if (m.error) resolve({ error: m.error });
      else if (m.done) resolve({ text: m.text });
    });
    port.onDisconnect.addListener(() => resolve(partial ? { text: partial } : { error: '连接中断，请重试' }));
    port.postMessage(payload);
  });
  task.cancel = () => port?.disconnect(); // 断开即中止后台请求
  return task;
}

async function translateSelection(range, text) {
  const rect = range.getBoundingClientRect();
  const context = isTerm(text) ? sentenceAround(range) : '';
  showTip(rect, dots());
  pending = requestTranslation({ text, context }, (partial) => !tip.hidden && showTip(rect, partial));
  const { text: out, error } = await pending;
  if (!tip.hidden) showTip(rect, error || out, !!error);
}

/* ---------- 段落：复制原段落样式插入译文 ---------- */

/** 这些元素插同级节点会打乱列表编号 / 表格结构，改为插在其内部 */
const INSIDE = /^(LI|TD|TH|DT|DD)$/;

function existingTranslation(block) {
  const inner = block.lastElementChild;
  if (inner?.dataset?.[MARK]) return inner;
  const next = block.nextElementSibling;
  return next?.dataset?.[MARK] ? next : null;
}

/** 创建承载译文的节点，使其与原文渲染样式一致 */
function createTarget(block) {
  let el;
  if (INSIDE.test(block.tagName)) {
    el = document.createElement('div'); // 继承字体/字号/行高/颜色，且不参与列表计数
    block.append(el);
  } else {
    el = document.createElement(block.tagName);
    el.className = block.className;
    const style = block.getAttribute('style');
    if (style) el.setAttribute('style', style);
    block.after(el);
  }
  el.dataset[MARK] = '1';
  return el;
}

async function translateBlock(block) {
  const done = existingTranslation(block);
  if (done) return done.remove(); // 再按一次 = 收起译文

  const source = block.innerText.trim(); // 必须在插入占位节点之前取
  const target = createTarget(block);
  target.replaceChildren(dots());

  const task = requestTranslation({ text: source }, (partial) => {
    if (target.isConnected) target.textContent = partial;
    else task.cancel(); // 译文被收起 / 页面变化，停止请求
  });
  const { text, error } = await task;
  if (!target.isConnected) return;
  target.textContent = error || text;
  if (error) target.style.color = '#c62828';
}

/* ---------- 触发：单独按下并松开 Ctrl（组合键不触发） ---------- */

let hovered = null;
let armed = false;

addEventListener('mouseover', (e) => (hovered = e.target), true);
addEventListener('keydown', (e) => (armed = e.key === cfg.hotkey && !e.repeat), true);
addEventListener('mousedown', () => ((armed = false), hideTip()), true);
addEventListener('scroll', hideTip, true);
addEventListener('blur', () => (armed = false));

addEventListener(
  'keyup',
  (e) => {
    if (e.key === 'Escape') return hideTip();
    if (e.key !== cfg.hotkey || !armed) return;
    armed = false;

    const sel = getSelection();
    const selected = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    if (selected) {
      if (!isChinese(selected)) translateSelection(sel.getRangeAt(0), selected);
      return;
    }
    const block = findBlock(hovered);
    if (block && !isChinese(block.innerText)) translateBlock(block);
  },
  true
);
