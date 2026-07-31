const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  noThink: true,
  extraBody: '',
};

const MAX_CONCURRENT = 10;
let inFlight = 0;

const cache = new Map();
const skipExtras = new Set(); // 记录拒绝额外参数的端点，避免每次都试探

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

async function errorMessage(res) {
  const body = await res.text().catch(() => '');
  return parseJson(body)?.error?.message || body.slice(0, 300) || `HTTP ${res.status}`;
}

/** 有 context 时按「查词」处理：结合所在句子给出该词的确切义项 */
function buildMessages(text, context, lang) {
  if (!context)
    return [
      {
        role: 'system',
        content: `你是专业翻译引擎。把用户输入翻译成${lang}，要求准确、通顺、符合中文表达习惯。直接输出译文本身：不要解释、不要加引号、不要复述原文、不要输出思考过程，保留原有换行、数字与专有名词。`,
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

/** 逐块回调译文增量；返回完整译文 */
async function translate(text, onChunk = () => {}, signal, context = '') {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  if (!cfg.apiKey) throw new Error('请先在插件选项中配置 API Key');

  const key = `${cfg.model} ${cfg.targetLang} ${context} ${text}`;
  if (cache.has(key)) {
    onChunk(cache.get(key));
    return cache.get(key);
  }

  // 命中缓存不占名额；真正要发请求时才计数，满了直接拒绝
  if (inFlight >= MAX_CONCURRENT) throw new Error(`同时进行的翻译已达 ${MAX_CONCURRENT} 个上限，请稍后再试`);
  inFlight++;
  try {
    const out = await request(cfg, text, context, onChunk, signal);
    if (cache.size > 300) cache.clear();
    cache.set(key, out);
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

  const post = (extra) =>
    fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ ...body, ...extra }),
    });

  let res = await post(useExtras ? extras : null);
  if (!res.ok && useExtras && res.status === 400) {
    skipExtras.add(url + cfg.model); // 端点不认这些参数，本次会话内不再发送
    res = await post(null);
  }
  if (!res.ok) throw new Error(await errorMessage(res));

  const out = res.headers.get('content-type')?.includes('event-stream')
    ? await readStream(res, onChunk)
    : await readJson(res, onChunk);
  if (!out) throw new Error('模型未返回内容');
  return out;
}

async function readStream(res, onChunk) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
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
      if (alive && e.name !== 'AbortError') port.postMessage({ error: e.message });
    }
    if (alive) port.disconnect();
  });
});

/* 一次性通道：供设置页「测试」使用 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'translate') return;
  translate(msg.text).then(
    (text) => sendResponse({ text }),
    (err) => sendResponse({ error: err.message })
  );
  return true;
});
