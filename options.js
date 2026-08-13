/* 依赖 config.js：PROFILE_FIELDS / GLOBAL_FIELDS / loadConfig / ensureProfiles / newProfileId */

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

/* ---------- 模型列表 ----------

   OpenAI 兼容端点都带 GET /models，所以模型是选出来的，不用手抄名字。
   但中转站的这张表并不总是可靠（缺接口、列一堆用不了的名字），
   所以下拉框末尾永远留一个「手动输入」，且当前已选的模型无论在不在表里都保留。 */

const CUSTOM = '__custom__'; // 不会和真实模型名相撞
const MODELS_TIMEOUT = 10000;
const MODELS_HINT = { 401: '密钥无效或已过期', 403: '无权访问', 404: '这个地址没有 /models 接口' };
// 同一张表里常混着嵌入、语音、画图等模型，翻译用不上
const NOT_CHAT = /embed|whisper|tts|speech|audio|image|dall-?e|moderation|rerank|davinci|babbage/i;

const modelCache = new Map(); // `${baseUrl}\n${apiKey}` → 模型名数组
const modelKey = () => `${$('baseUrl').value.trim()}\n${$('apiKey').value.trim()}`;
const modelHint = (text) => ($('modelHint').textContent = text);
const getModel = () => ($('model').value === CUSTOM ? $('modelCustom').value.trim() : $('model').value);

async function fetchModels(baseUrl, apiKey) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(MODELS_TIMEOUT),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 120);
    try {
      detail = JSON.parse(body)?.error?.message || detail;
    } catch {}
    throw new Error(MODELS_HINT[res.status] || `HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }
  const raw = await res.json();
  const all = [
    ...new Set(
      (Array.isArray(raw) ? raw : raw?.data || raw?.models || [])
        .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
        .filter((s) => typeof s === 'string' && s.trim())
    ),
  ].sort((a, b) => a.localeCompare(b, 'en'));
  if (!all.length) throw new Error('返回的列表是空的');
  const chat = all.filter((m) => !NOT_CHAT.test(m));
  return chat.length ? chat : all; // 过滤把整张表滤空了，说明这些名字不按常规命名，那就全给出来
}

/** 重建下拉框：表里的模型 + 当前值（可能不在表里）+ 手动输入 */
function renderModels(list, selected) {
  const names = [...new Set(selected ? [...list, selected] : list)].sort((a, b) => a.localeCompare(b, 'en'));
  const sel = $('model');
  sel.replaceChildren(
    ...names.map((m) => {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      return o;
    })
  );
  const custom = document.createElement('option');
  custom.value = CUSTOM;
  custom.textContent = '手动输入…';
  sel.append(custom);
  sel.value = names.includes(selected) ? selected : names[0] ?? CUSTOM;
  $('modelCustom').hidden = sel.value !== CUSTOM;
}

let loadSeq = 0; // 并发的几次获取里只认最后发起的那一次

/** force：忽略缓存，用户点了 ↻ */
async function loadModels(force) {
  const baseUrl = $('baseUrl').value.trim();
  const apiKey = $('apiKey').value.trim();
  const key = modelKey();
  const keep = getModel();

  const cached = modelCache.get(key);
  if (cached && !force) {
    renderModels(cached, keep);
    return modelHint(`共 ${cached.length} 个模型`);
  }
  if (!baseUrl || (!apiKey && !force)) return modelHint('填好接口地址和密钥后自动获取模型列表');

  const seq = ++loadSeq;
  $('loadModels').classList.add('busy');
  modelHint('正在获取模型列表…');
  try {
    const list = await fetchModels(baseUrl, apiKey);
    if (seq !== loadSeq) return; // 期间又改了地址或换了配置
    modelCache.set(key, list);
    renderModels(list, keep);
    modelHint(`共 ${list.length} 个模型`);
  } catch (e) {
    if (seq !== loadSeq) return;
    renderModels([], keep); // 拿不到表也要能继续用原来的模型
    modelHint(`获取模型列表失败（${errText(e)}），可选「手动输入」`);
  } finally {
    if (seq === loadSeq) $('loadModels').classList.remove('busy');
  }
}

const errText = (e) =>
  e.name === 'TimeoutError' ? '超时' : e.name === 'TypeError' ? '连不上这个接口地址' : e.message;

$('model').onchange = () => {
  const custom = $('model').value === CUSTOM;
  $('modelCustom').hidden = !custom;
  if (custom) $('modelCustom').focus();
};

$('loadModels').onclick = () => loadModels(true);
// 换了地址或密钥就是换了一家服务商，列表跟着换
$('baseUrl').onchange = () => loadModels(false);
$('apiKey').onchange = () => loadModels(false);

/* ---------- profile ---------- */

let profiles = [];
let activeId = '';

const current = () => profiles.find((p) => p.id === activeId);

/** 同名的 profile 在下拉框里分不清，自动补个序号 */
function uniqueName(base) {
  const taken = new Set(profiles.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

function renderProfiles() {
  $('profile').replaceChildren(
    ...profiles.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name || '未命名';
      return o;
    })
  );
  $('profile').value = activeId;
  $('delProfile').disabled = profiles.length < 2; // 至少留一个
  disarmDelete();
}

function fillForm(p) {
  $('name').value = p.name;
  for (const k in PROFILE_FIELDS) {
    if (k === 'model') continue; // 下拉框里未必有这个 option，交给 renderModels
    const el = $(k);
    if (el.type === 'checkbox') el.checked = p[k];
    else el.value = p[k];
  }
  renderModels(modelCache.get(modelKey()) ?? [], p.model);
}

/** 读表单；额外参数不是合法 JSON 时返回 null 并给出提示 */
function readForm() {
  const extra = $('extraBody').value.trim();
  if (extra) {
    try {
      JSON.parse(extra);
    } catch {
      say('bad', '额外请求参数无法解析', '需要是一个 JSON 对象，例如 {"reasoning_effort":"none"}');
      return null;
    }
  }
  const p = { id: activeId, name: $('name').value.trim() || '未命名' };
  for (const k in PROFILE_FIELDS) {
    const el = $(k);
    p[k] = el.type === 'checkbox' ? el.checked : el.value.trim() || PROFILE_FIELDS[k];
  }
  p.extraBody = extra;
  p.model = getModel() || PROFILE_FIELDS.model;
  return p;
}

const persist = () =>
  chrome.storage.local.set({ profiles, activeProfileId: activeId, hotkey: $('hotkey').value });

/** 把表单写回当前 profile 并落盘；失败（JSON 非法）返回 false */
async function save() {
  const p = readForm();
  if (!p) return false;
  const renamed = current().name !== p.name;
  profiles[profiles.indexOf(current())] = p;
  await persist();
  if (renamed) renderProfiles();
  return true;
}

ensureProfiles().then((cfg) => {
  ({ profiles } = cfg);
  activeId = cfg.active.id;
  $('hotkey').value = cfg.hotkey;
  showHotkey(cfg.hotkey);
  renderProfiles();
  fillForm(cfg.active);
  loadModels(false);
});

// 切换配置：先把当前编辑内容存进原 profile，避免切走就丢
$('profile').onchange = async (e) => {
  const next = e.target.value;
  const edited = readForm();
  if (!edited) return void (e.target.value = activeId); // JSON 非法，留在原处让用户改
  profiles[profiles.indexOf(current())] = edited;
  activeId = next;
  await persist();
  renderProfiles(); // 原 profile 可能刚被改了名字
  fillForm(current());
  loadModels(false); // 这套配置可能指向另一家服务商
  say('ok', `已切换到「${current().name}」`, '下一次翻译就用这套配置');
};

$('addProfile').onclick = async () => {
  if (!(await save())) return;
  const p = { ...current(), id: newProfileId(), name: uniqueName(`${current().name} 副本`) };
  profiles.push(p);
  activeId = p.id;
  await persist();
  renderProfiles();
  fillForm(p);
  $('name').select();
  say('ok', '已新建配置', '密钥等内容从上一套复制而来，改完记得保存');
};

/* 删除要点两次：扩展页里 confirm() 不可靠，用按钮自身做二次确认 */
let armTimer;
function disarmDelete() {
  clearTimeout(armTimer);
  const b = $('delProfile');
  b.classList.remove('arm');
  b.textContent = '−';
}

$('delProfile').onclick = async () => {
  const b = $('delProfile');
  if (!b.classList.contains('arm')) {
    b.classList.add('arm');
    b.textContent = '确认删除';
    say('bad', `再点一次删除「${current().name}」`, '删除后无法恢复');
    const warning = statusEl.firstChild; // 按钮复位时把这条提示一起撤掉，免得留下过期的警告
    armTimer = setTimeout(() => {
      disarmDelete();
      if (statusEl.firstChild === warning) statusEl.replaceChildren();
    }, 5000);
    return;
  }
  const gone = current();
  profiles = profiles.filter((p) => p !== gone);
  activeId = profiles[0].id;
  await persist();
  renderProfiles();
  fillForm(current());
  say('ok', `已删除「${gone.name}」`, `当前配置为「${current().name}」`);
};

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
  say('ok', '译文缓存与术语表已清空');
};

/* ---------- 保存与测试 ---------- */

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
