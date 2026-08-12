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
    const el = $(k);
    if (el.type === 'checkbox') el.checked = p[k];
    else el.value = p[k];
  }
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
