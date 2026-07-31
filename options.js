const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  hotkey: 'Control',
  noThink: true,
  extraBody: '',
};

const HOTKEY_LABEL = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
const HOTKEY_HINT = {
  Control: '',
  Alt: 'Alt 单击在部分网站上有自己的行为，如有冲突可换一个。',
  Shift: '中文输入法常用单击 Shift 切换中英，容易误触发。',
};

const SAMPLE = 'Hello, world.';
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
let clearTimer;

/** kind: ok | bad */
function say(kind, title, detail) {
  clearTimeout(clearTimer);
  const b = document.createElement('b');
  b.textContent = title;
  statusEl.replaceChildren(b);
  if (detail) {
    const s = document.createElement('span');
    s.textContent = detail;
    statusEl.append(s);
  }
  statusEl.className = kind;
  if (kind === 'ok') clearTimer = setTimeout(() => statusEl.replaceChildren(), 6000);
}

const busy = (title) => {
  clearTimeout(clearTimer);
  const b = document.createElement('b');
  b.textContent = title;
  statusEl.replaceChildren(b);
  statusEl.className = '';
};

function showHotkey(key) {
  $('kbdHint').textContent = HOTKEY_LABEL[key];
  $('hotkeyHint').textContent = HOTKEY_HINT[key];
}

chrome.storage.local.get(DEFAULTS).then((cfg) => {
  for (const k in DEFAULTS) {
    const el = $(k);
    if (el.type === 'checkbox') el.checked = cfg[k];
    else el.value = cfg[k];
  }
  showHotkey(cfg.hotkey);
});

$('hotkey').onchange = (e) => showHotkey(e.target.value);

$('reveal').onclick = () => {
  const el = $('apiKey');
  const shown = el.type === 'text';
  el.type = shown ? 'password' : 'text';
  $('reveal').textContent = shown ? '显示' : '隐藏';
};

/* ---------- 按站点开关：作为工具栏弹窗打开时才有意义 ---------- */

let siteHost = '';
const getDisabled = async () => (await chrome.storage.local.get({ disabledHosts: [] })).disabledHosts;

chrome.tabs?.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  if (!/^https?:/.test(tab?.url || '')) return; // 设置页自身、chrome:// 等
  siteHost = new URL(tab.url).hostname;
  $('siteName').textContent = siteHost;
  $('siteOn').checked = !(await getDisabled()).includes(siteHost);
  $('siteRow').hidden = false;
});

$('siteOn').onchange = async (e) => {
  const disabled = await getDisabled();
  const next = e.target.checked ? disabled.filter((h) => h !== siteHost) : [...new Set([...disabled, siteHost])];
  await chrome.storage.local.set({ disabledHosts: next });
  say('ok', e.target.checked ? `已在 ${siteHost} 启用` : `已在 ${siteHost} 停用`);
};

$('clearCache').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  say('ok', '译文缓存已清空');
};

/* ---------- 保存与测试 ---------- */

async function save() {
  const extra = $('extraBody').value.trim();
  if (extra) {
    try {
      JSON.parse(extra);
    } catch {
      say('bad', '额外请求参数无法解析', '需要是一个 JSON 对象，例如 {"reasoning_effort":"none"}');
      return false;
    }
  }
  const cfg = {};
  for (const k in DEFAULTS) {
    const el = $(k);
    cfg[k] = el.type === 'checkbox' ? el.checked : el.value.trim() || DEFAULTS[k];
  }
  cfg.extraBody = extra;
  await chrome.storage.local.set(cfg);
  return true;
}

$('save').onclick = async () => (await save()) && say('ok', '已保存');

$('test').onclick = async () => {
  if (!(await save())) return;
  busy('正在连接…');
  const t0 = performance.now();
  const res = await chrome.runtime.sendMessage({ type: 'translate', text: SAMPLE });
  const ms = Math.round(performance.now() - t0);
  if (res.error) say('bad', '连接失败', res.error);
  else say('ok', `连接成功 · ${ms}ms`, `${SAMPLE} → ${res.text}`);
};
