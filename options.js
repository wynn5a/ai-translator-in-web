const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  hotkey: 'Control',
  noThink: true,
  extraBody: '',
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

chrome.storage.local.get(DEFAULTS).then((cfg) => {
  for (const k in DEFAULTS) {
    const el = $(k);
    if (el.type === 'checkbox') el.checked = cfg[k];
    else el.value = cfg[k];
  }
  $('kbdHint').textContent = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }[cfg.hotkey];
});

$('hotkey').onchange = (e) => ($('kbdHint').textContent = e.target.selectedOptions[0].textContent);

$('reveal').onclick = () => {
  const el = $('apiKey');
  const shown = el.type === 'text';
  el.type = shown ? 'password' : 'text';
  $('reveal').textContent = shown ? '显示' : '隐藏';
};

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
