const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  noThink: true,
  extraBody: '',
};

const MAX_CONCURRENT = 10;
const CACHE_KEY = '__cache';
const CACHE_MAX = 300;
const TIMEOUT = 30000; // 首字节 / 相邻分片之间的最长等待

let inFlight = 0;
const skipExtras = new Set(); // 记录拒绝额外参数的端点，避免每次都试探

const fail = (message, code) => Object.assign(new Error(message), { code });

/* ---------- 缓存：落盘，Service Worker 休眠后仍然有效 ---------- */

let cache = null;
let saveTimer;

async function getCache() {
  if (!cache) cache = new Map((await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || []);
  return cache;
}

function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ [CACHE_KEY]: [...cache] }), 1500);
}

/* ---------- 关闭思考 ---------- */

/** 各家「关闭思考」的写法不同；返回 null 表示该模型本就不思考，无需传参 */
function noThinkParams(baseUrl, model) {
  const k = `${baseUrl} ${model}`.toLowerCase();
  if (k.includes('openrouter')) return { reasoning: { enabled: false } };
  if (/localhost|127\.0\.0\.1|ollama|vllm|lmstudio/.test(k)) // 本地部署：Ollama 用 think，vLLM 用 chat_template_kwargs
    return { think: false, chat_template_kwargs: { enable_thinking: false } };
  if (/qwen|dashscope|aliyuncs/.test(k)) return { enable_thinking: false };
  if (/glm|zhipu|bigmodel|kimi|moonshot|minimax/.test(k)) return { thinking: { type: 'disabled' } };
  if (/gpt-5\.\d|gpt-[6-9]/.test(k)) return { reasoning_effort: 'none' }; // gpt-5.1 起支持 none
  if (/gpt-5|^o[1-9]|grok/.test(model.toLowerCase())) return { reasoning_effort: 'minimal' };
  return null;
}

const parseJson = (s) => {
  try {
    return JSON.parse(s) || null;
  } catch {
    return null;
  }
};

/* ---------- 错误信息：先说人话，再附服务端原文 ---------- */

const HTTP_HINT = {
  400: '请求被拒绝',
  401: '密钥无效或已过期',
  403: '无权访问该模型',
  404: '接口地址或模型不存在（Base URL 通常要以 /v1 结尾）',
  413: '文本太长，超出模型上限',
  429: '请求过于频繁或额度不足',
  500: '服务端错误',
  502: '网关错误',
  503: '服务暂不可用',
  504: '服务端超时',
};

async function errorMessage(res) {
  const body = await res.text().catch(() => '');
  const detail = parseJson(body)?.error?.message || body.slice(0, 200);
  const head = HTTP_HINT[res.status] || `HTTP ${res.status}`;
  return detail ? `${head}：${detail}` : head;
}

/* ---------- 提示词 ---------- */

/** 有 context 时按「查词」处理：结合所在句子给出该词的确切义项 */
function buildMessages(text, context, lang) {
  if (!context)
    return [
      {
        role: 'system',
        content: `你是专业翻译引擎。把用户输入翻译成${lang}，要求准确、通顺、符合目标语言表达习惯。直接输出译文本身：不要解释、不要加引号、不要复述原文、不要输出思考过程，保留原有换行、数字与专有名词。`,
      },
      { role: 'user', content: text },
    ];

  return [
    {
      role: 'system',
      content: `你是专业词典。用户给出一个句子和其中的词或短语，请结合该句语境判断它的确切含义，只输出这个词或短语的${lang}释义，不要翻译整句、不要解释、不要加引号、不要输出思考过程。若该语境下有多个贴切说法，用「/」分隔，最多两个。`,
    },
    { role: 'user', content: `句子：${context}\n需要翻译的词或短语：${text}` },
  ];
}

/* ---------- 主流程 ---------- */

/** 逐块回调译文增量；返回完整译文 */
async function translate(text, onChunk = () => {}, signal, context = '') {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  if (!cfg.apiKey) throw fail('还没有配置 API Key', 'no-key');

  const c = await getCache();
  const key = `${cfg.model}${cfg.targetLang}${context}${text}`;
  const hit = c.get(key);
  if (hit !== undefined) {
    c.delete(key), c.set(key, hit); // 命中即刷新为最近使用
    saveCache();
    onChunk(hit);
    return hit;
  }

  // 命中缓存不占名额；真正要发请求时才计数，满了直接拒绝
  if (inFlight >= MAX_CONCURRENT) throw fail(`同时进行的翻译已达 ${MAX_CONCURRENT} 个上限，请稍后再试`);
  inFlight++;
  try {
    const out = await request(cfg, text, context, onChunk, signal);
    c.set(key, out);
    for (const k of c.keys()) {
      if (c.size <= CACHE_MAX) break;
      c.delete(k);
    }
    saveCache();
    return out;
  } finally {
    inFlight--;
  }
}

async function request(cfg, text, context, onChunk, signal) {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: cfg.model,
    temperature: 0.2,
    stream: true,
    messages: buildMessages(text, context, cfg.targetLang),
  };
  const extras = { ...(cfg.noThink ? noThinkParams(cfg.baseUrl, cfg.model) : null), ...parseJson(cfg.extraBody) };
  const useExtras = Object.keys(extras).length > 0 && !skipExtras.has(url + cfg.model);

  // 内部 controller：把「用户中止」和「长时间无响应」合并成一个信号
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let timer;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(fail('timeout', 'timeout')), TIMEOUT);
  };

  const post = (extra) =>
    fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ ...body, ...extra }),
    });

  alive();
  try {
    // 读配置期间就被取消（气泡关掉、译文收起）：一个字节都不用发
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    let res = await post(useExtras ? extras : null);
    if (!res.ok && useExtras && res.status === 400) {
      skipExtras.add(url + cfg.model); // 端点不认这些参数，本次会话内不再发送
      alive();
      res = await post(null);
    }
    if (!res.ok) throw fail(await errorMessage(res), `http-${res.status}`);

    const out = res.headers.get('content-type')?.includes('event-stream')
      ? await readStream(res, onChunk, alive)
      : await readJson(res, onChunk);
    if (!out) throw fail('模型没有返回内容，换个模型或稍后再试');
    return out;
  } catch (e) {
    if (signal?.aborted) throw e; // 用户主动取消，外层会忽略
    if (e.code === 'timeout' || ctrl.signal.reason?.code === 'timeout')
      throw fail(`等待响应超过 ${TIMEOUT / 1000} 秒，请重试`, 'timeout');
    if (e.name === 'TypeError') throw fail('连不上接口地址，请检查网络和 Base URL', 'network');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function readStream(res, onChunk, alive) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    alive(); // 有数据就重置超时
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const delta = parseJson(payload)?.choices?.[0]?.delta;
      if (delta?.content) onChunk((out += delta.content)); // reasoning_content 直接忽略
    }
  }
  return out.trim();
}

/** 端点不支持 stream 时的回退 */
async function readJson(res, onChunk) {
  const out = (await res.json().catch(() => null))?.choices?.[0]?.message?.content?.trim() || '';
  if (out) onChunk(out);
  return out;
}

/* ---------- 与内容脚本 / 设置页通信 ---------- */

/* 流式通道：内容脚本连接后发一条 {text}，收到若干 {chunk} 后以 {done} 或 {error} 结束 */
chrome.runtime.onConnect.addListener((port) => {
  const ctrl = new AbortController();
  let alive = true;
  port.onDisconnect.addListener(() => ((alive = false), ctrl.abort())); // 气泡关掉就中止请求

  port.onMessage.addListener(async ({ text, context }) => {
    try {
      const out = await translate(text, (p) => alive && port.postMessage({ chunk: p }), ctrl.signal, context);
      if (alive) port.postMessage({ done: true, text: out });
    } catch (e) {
      if (alive && e.name !== 'AbortError') port.postMessage({ error: e.message, code: e.code });
    }
    if (alive) port.disconnect();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'translate': // 设置页「测试连接」
      translate(msg.text).then(
        (text) => sendResponse({ text }),
        (err) => sendResponse({ error: err.message })
      );
      return true;
    case 'openOptions':
      chrome.runtime.openOptionsPage();
      return false;
    case 'clearCache':
      cache = new Map();
      clearTimeout(saveTimer);
      chrome.storage.local.remove(CACHE_KEY).then(() => sendResponse({ ok: true }));
      return true;
    default:
      return false;
  }
});

/* ---------- 安装引导与右键菜单 ---------- */

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'tr-sel', title: '翻译选中文字', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'tr-block', title: '翻译此段落', contexts: ['page'] });
  });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  createMenus();
  if (reason === 'install') chrome.runtime.openOptionsPage(); // 装完直接进配置，不用先撞一次错误
});
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const type = info.menuItemId === 'tr-sel' ? 'translate-selection' : 'translate-block';
  chrome.tabs.sendMessage(tab.id, { type }, { frameId: info.frameId ?? 0 }).catch(() => {});
});
