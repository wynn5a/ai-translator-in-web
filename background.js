importScripts('config.js', 'markers.js'); // 配置模型 + 结构标记语法

const MAX_CONCURRENT = 10;
const CACHE_KEY = '__cache';
const CACHE_MAX = 300;
const TIMEOUT = 30000; // 首字节 / 相邻分片之间的最长等待
const STREAM_INTERVAL = 25; // 合并高频 token，避免每个 SSE 分片都跨扩展端口发送

let inFlight = 0;
const skipLevel = new Map(); // 端点+模型 → 参数降级到第几档，避免每次都从头试探

const fail = (message, code) => Object.assign(new Error(message), { code });

/** Map 按插入顺序淘汰最旧的，直到不超过 max */
const trim = (map, max) => {
  for (const k of map.keys()) {
    if (map.size <= max) break;
    map.delete(k);
  }
};

/* ---------- 缓存：落盘，Service Worker 休眠后仍然有效 ---------- */

let cache = null;
let cacheLoading = null;
let saveTimer;

async function getCache() {
  if (cache) return cache;
  cacheLoading ??= chrome.storage.local
    .get(CACHE_KEY)
    .then((stored) => (cache ??= new Map(stored[CACHE_KEY] || [])))
    .finally(() => (cacheLoading = null));
  return cacheLoading;
}

function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ [CACHE_KEY]: [...cache] }), 1500);
}

/* ---------- 术语表：跨段落、跨页面统一同一个词的译法 ----------

   按「站点 + 目标语言」分作用域。三个来源，前两个不花钱：
     1. 查词结果      选中一个词得到的释义，本身就是一条对照
     2. 短译文        标题、表头、按钮、链接文字这类整块就是一个词组的译文
     3. 术语抽取      长段落译完之后，再用一次请求从原文/译文里抽 ≤6 条术语
   抽取发生在译文已经显示给用户之后，不占用户等待时间；可以在设置里关掉。
   注入时只带上「原文里真的出现了」的条目，所以提示词开销与段落内容成正比。 */

const GLOSSARY_KEY = '__glossary';
const TERMS_PER_SCOPE = 80; // 每个站点保留的术语条数
const SCOPES_MAX = 30; // 保留多少个站点的术语表
const INJECT_MAX = 12; // 单次请求最多注入多少条
const TERM_MAX = 40; // 超过这个长度的就不是术语，是句子
const EXTRACT_MIN = 120; // 更短的段落靠「短译文直接入表」就够了，不值得再花一次请求
const EXTRACT_CONCURRENT = 2; // 术语抽取的并发上限，与翻译的名额分开算

let glossary = null;
let glossaryLoading = null;
let glossaryTimer;
let extracting = 0;

async function getGlossary() {
  if (glossary) return glossary;
  glossaryLoading ??= chrome.storage.local
    .get(GLOSSARY_KEY)
    .then(
      (stored) =>
        (glossary ??= new Map(
          (stored[GLOSSARY_KEY] || []).map(([scope, terms]) => [scope, new Map(terms)])
        ))
    )
    .finally(() => (glossaryLoading = null));
  return glossaryLoading;
}

function saveGlossary() {
  clearTimeout(glossaryTimer);
  glossaryTimer = setTimeout(
    () => chrome.storage.local.set({ [GLOSSARY_KEY]: [...glossary].map(([scope, terms]) => [scope, [...terms]]) }),
    1500
  );
}

/** 目标语言参与作用域：同一站点译成不同语言是两张表 */
const scopeOf = (cfg, page) => (page?.site ? `${page.site}\x01${cfg.targetLang}` : '');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LATIN = /^[\w\s.+#/'’-]+$/;
const HAS_LETTER = /[a-zA-Z一-鿿぀-ヿ가-힯Ѐ-ӿ]/;

/** 拉丁词要卡词边界，否则「AI」会在「said」里命中；中日韩没有词边界，按子串 */
const appears = (term, text) =>
  LATIN.test(term) ? new RegExp(`(^|[^\\w])${escapeRe(term)}([^\\w]|$)`, 'i').test(text) : text.includes(term);

/** 记一条术语；后来的译法覆盖先前的，并刷新为最近使用 */
async function remember(scope, term, target) {
  term = term.trim();
  target = target.trim();
  if (!scope || !term || !target) return;
  if (term.length > TERM_MAX || target.length > TERM_MAX * 2) return;
  if (term.includes('\n') || target.includes('\n')) return;
  if (!HAS_LETTER.test(term)) return; // 纯数字、纯符号不是术语

  const g = await getGlossary();
  const terms = g.get(scope) || new Map();
  g.delete(scope), g.set(scope, terms); // 作用域也按 LRU
  terms.delete(term), terms.set(term, target);
  trim(terms, TERMS_PER_SCOPE);
  trim(g, SCOPES_MAX);
  saveGlossary();
}

/** 取出在这段文字里真的出现了的术语，长的优先——短词更可能是偶然命中 */
async function glossaryFor(scope, text) {
  if (!scope) return [];
  const terms = (await getGlossary()).get(scope);
  if (!terms) return [];
  return [...terms]
    .filter(([term]) => appears(term, text))
    .sort((a, b) => b[0].length - a[0].length)
    .slice(0, INJECT_MAX);
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

/** 真正进入完整请求档的额外参数；用户配置覆盖自动判断。 */
const requestExtras = (cfg) => ({
  ...(cfg.noThink ? noThinkParams(cfg.baseUrl, cfg.model) : null),
  ...parseJson(cfg.extraBody),
});

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

/* ---------- 提示词 ----------

   各任务共用一套「角色 + 页面背景 + 术语表 + 编号规则 + 输出约束」的结构：
   term     查词（选中一个词/短语，结合所在句子给义项）
   text     划词翻译（选中的句子或片段）
   block    段落翻译（可能带行内占位标记，见 content.js 的 encodeInline）
   glossary 术语抽取（不面向用户，见 extractTerms） */

const RULES = [
  '忠实完整：不增不减、不改立场、不做总结、不加译者注。',
  '原样保留：数字、日期、时间、单位、货币、代码、命令、路径、文件名、变量名、URL、邮箱、@账号、#话题。',
  '专有名词（人名、公司、产品、框架、API）保留原文；已有公认译名的用译名。',
  '术语按该领域内的通行译法，不自造、不音译。',
  '保持原文的语域和语气：正式的别译成口语，口语的别译成书面语，营销文案保留其调性。',
  '本来就是目标语言的片段原样输出。',
  '保持分段：原文的换行和空行原样保留，原文有几段就译成几段，不要合并成一段，也不要另起新段。',
];

const TAG_RULE =
  '文中 <b1>…</b1> 是段落标记，<n1/> 是换行，<t1>…</t1> 是行内标记，<x1/> 是不可翻译的片段（代码、图片等）。' +
  '所有标记原样保留，编号和数量都不能变（编号可能不连续，照原样用）；' +
  '只翻译标记之间的文字，标记可随译文语序移动位置，但不要新增、删除或合并标记。' +
  '分段以标记为准：<b1>…</b1> 各自是独立的一段，<n1/> 处必须换行，' +
  '原文分几段译文就分几段，绝不能把几段合并成一段。' +
  '标记连编号一起照抄，不要改写成别的写法：换行只能是 <n1/>，不许换成 <br>、<br/> 或任何 HTML 标签。';

const TERM_RULES = [
  '按这句话里的实际用法选义项，不要罗列其他义项。',
  '词性跟着原词：动词给动词，名词给名词。',
  '专有名词、产品名、代码标识符保留原文。',
  '该语境下有多个同样贴切的说法时用「/」分隔，最多两个。',
];

const GLOSSARY_RULES = [
  '只输出确实出现在原文里的词或短语，写法与原文完全一致。',
  '最多 6 条，优先专业术语、专有名词、产品名和固定表达；普通词汇、常见动词、整句都不要。',
  '译文里保留了原文写法的术语也要列出（例如 Pod=Pod）。',
  '每行一条，格式为「原文=译文」，不要编号、不要解释、不要输出思考过程。',
  '没有值得记录的术语时，只输出一个「无」字。',
];

// 提示词一改，旧译文就不该再拿出来用：这里 +1，缓存整体作废
const PROMPT_VERSION = 4;
// 结果完整性规则改变时单独递增，避免继续命中旧版本可能截断的译文
const CACHE_VERSION = 2;

const numbered = (list) => list.map((s, i) => `${i + 1}. ${s}`).join('\n');

/** 已确定的译法：让同一个词在整站的每一段里都译成同一个样子 */
const termsLine = (terms) =>
  terms?.length
    ? `【术语表】以下译法在本站已经确定，原文出现时必须沿用，不要另译：\n${terms
        .map(([term, target]) => `${term} → ${target}`)
        .join('\n')}`
    : '';

/** 页面背景：让模型知道这段文字属于哪个站点、哪个主题，术语才不会跑偏 */
function pageLine(page) {
  if (!page?.site) return '';
  const where = page.title ? `${page.site} 的页面《${page.title}》` : page.site;
  // 这两项常常整段就是原文本身（X 的 document.title 就是推文），模型会顺手照抄，
  // 连带把译文写成原文语言：明确它只是背景，不是待译内容
  return (
    `【来源】${where}${page.desc ? `\n【页面简介】${page.desc}` : ''}\n` +
    '以上只用来判断主题和领域，它本身不是待译内容：不要翻译它，也不要照抄其中的文字或语言。'
  );
}

const join = (...parts) => parts.filter(Boolean).join('\n\n');

/** 上一次输出把标记弄丢或写错了：重发时把缺的那几个点名列出来 */
const repairLine = (missing) =>
  missing?.length
    ? `注意：上一次的译文丢失或改动了这些标记：${missing.join(' ')}。这次每个标记都必须原样出现，一个都不能少。`
    : '';

function buildMessages(job, lang) {
  const { kind, text, context, page, tagged, carry, part, terms, repair } = job;

  if (kind === 'glossary')
    return [
      {
        role: 'system',
        content: join(
          '你是术语抽取器。用户给出同一段文字的原文和译文，请找出其中的专业术语、专有名词和固定表达，输出它们的对照，供后续段落沿用同一译法。',
          `要求：\n${numbered(GLOSSARY_RULES)}`
        ),
      },
      { role: 'user', content: text },
    ];

  if (kind === 'term')
    return [
      {
        role: 'system',
        content: join(
          `你是双语词典。用户给出一个句子和其中的词或短语，请结合该句语境判断它的确切含义，只给出这个词或短语的${lang}释义。`,
          pageLine(page),
          termsLine(terms),
          `要求：\n${numbered(TERM_RULES)}`,
          `只输出${lang}释义本身：不要翻译整句、不要解释、不要加引号、不要输出思考过程。`
        ),
      },
      { role: 'user', content: `句子：${context}\n需要翻译的词或短语：${text}` },
    ];

  return [
    {
      role: 'system',
      content: join(
        `你是资深译者，把用户给出的${kind === 'block' ? '网页正文' : '文字'}翻译成${lang}。`,
        pageLine(page),
        termsLine(terms),
        kind === 'text' ? '这是用户在网页上选中的片段，可能不是完整句子。照原样翻译，不要补全、不要扩写。' : '',
        `要求：\n${numbered(tagged ? [...RULES, TAG_RULE] : RULES)}`,
        tagged ? repairLine(repair) : '',
        part ? `这是一段长文的第 ${part[0]}/${part[1]} 部分，只翻译发给你的这部分。` : '',
        carry ? `前一部分译文的结尾是「…${carry}」，术语、人称和语气要接得上，不要重复已经翻译过的内容。` : '',
        // 语言必须在末位再说一遍：【来源】【页面简介】可能整段都是原文语言
        //（X 的 document.title 就是推文原文），开头那句「翻译成 X」会被它压过去
        `只输出${lang}译文本身：不要复述原文、不要加引号、不要任何说明或思考过程。`
      ),
    },
    { role: 'user', content: text },
  ];
}

/** 有的模型分不清 system 和正文，会把提示词整段照抄出来当译文。
    拿真正发出去的提示词行当指纹，命中就从那里截断：宁可少一段，也不能把提示词显示给用户。
    短行（「要求：」）不参与，正文里可能真的出现。 */
function stripEcho(out, prompt) {
  let at = out.length;
  for (const line of Array.isArray(prompt) ? prompt : echoLines(prompt)) {
    const i = out.indexOf(line);
    if (i >= 0 && i < at) at = i;
  }
  return out.slice(0, at).trim();
}

/** 流式时每个分片都要过一遍 stripEcho，指纹行只算一次 */
const echoLines = (prompt) => prompt.split('\n').filter((line) => line.length >= 12);

/** 思考模型在「关闭思考」参数被端点拒绝时，会把推理过程写在 <think>…</think> 里混进正文；
    流式传到一半时结束标记还没到，整段都先藏着 */
const stripThink = (s) => s.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/^\s*<\/think>/i, '');

/* ---------- 标记完整性：模型漏标记那一段就退化成纯文本，丢链接和分段，值得再要一次 ---------- */

/** 译文里缺了哪些原文标记（每缺一个算一条）；多出来的不算，render 会把它们丢掉 */
function missingTags(source, out) {
  const want = markerCounts(source);
  const got = markerCounts(out);
  const missing = [];
  for (const [tag, n] of want) for (let i = (got.get(tag) || 0); i < n; i++) missing.push(tag);
  return missing;
}

/* ---------- 长段落分片：整段直发会漏译、后半段质量下滑，还可能撞输出上限 ---------- */

const CHUNK_LIMIT = 1400; // 源字符数；多数段落一次发完，不触发分片
const MIN_RECOVERY_CHUNK = 240; // 达到最大输出仍截断时最多递归拆到这个量级

const CJK_STOP = /[。！？；…]/; // 中文句末标点后面没有空格，不能要求空白
const ASCII_STOP = /[.!?;]/;
const CLOSERS = /["'”’）)\]】》」』]/;

/**
 * 可安全断开的位置：必须在占位标记之外（否则标记会被切成两半），
 * 且落在换行（hard）或句末标点（soft）之后。
 * 断点连同后面的分隔空白一起吃掉，这样它归到前一片的 sep 里，拼回译文时不会丢。
 */
function breakpoints(text) {
  const stops = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') {
      const m = markerAt(text, i);
      if (m) {
        // 只有行内标记算深度：段落标记跨了分片也能还原，切在段落中间是允许的，
        // 否则一个超长段落里一个断点都找不到，只能硬切
        if (m[2] === 't') depth += m[1] ? -1 : m[4] ? 0 : 1;
        i += m[0].length - 1;
        continue;
      }
    }
    if (depth) continue;
    const cjk = CJK_STOP.test(ch);
    if (!cjk && ch !== '\n' && !ASCII_STOP.test(ch)) continue;
    let j = i + 1;
    if (ch !== '\n') while (j < text.length && CLOSERS.test(text[j])) j++;
    const punct = j;
    while (j < text.length && /\s/.test(text[j])) j++;
    // 英文句点必须后接空白才算句末，否则 v1.2.3 和 e.g. 都会被当成一句话结束
    if (cjk || ch === '\n' || j > punct || j >= text.length) stops.push({ at: j, hard: ch === '\n' });
  }
  return stops;
}

/** 硬切点落在标记里面时挪到标记前；标记本身比整片还长时才挪到标记后，避免空片死循环 */
function markerSafeCut(source, start, cut) {
  const markerStart = source.lastIndexOf('<', cut - 1);
  if (markerStart < start) return cut;
  const marker = markerAt(source, markerStart);
  if (!marker || markerStart + marker[0].length <= cut) return cut;
  return markerStart > start ? markerStart : markerStart + marker[0].length;
}

/** 切成 [{ text, sep }]，sep 是被 trim 掉的分隔空白，拼回译文时补上 */
function splitChunks(source, limit = CHUNK_LIMIT) {
  if (source.length <= limit) return [{ text: source, sep: '' }];
  const stops = breakpoints(source);
  const chunks = [];
  let stopIndex = 0;
  for (let start = 0; start < source.length; ) {
    const room = start + limit;
    let cut = source.length;
    if (room < source.length) {
      while (stops[stopIndex]?.at <= start) stopIndex++;
      let soft;
      let hard;
      for (let i = stopIndex; i < stops.length && stops[i].at <= room; i++) {
        soft = stops[i];
        if (soft.hard) hard = soft;
      }
      // 段落边界优先，但太靠前就宁可用句子边界，免得切出很碎的片
      cut = (hard && hard.at - start >= limit * 0.6 ? hard : soft)?.at ?? markerSafeCut(source, start, room);
    }
    const raw = source.slice(start, cut);
    const text = raw.trimEnd();
    chunks.push({ text: text.trimStart(), sep: raw.slice(text.length) });
    start = cut;
  }
  return chunks.filter((c) => c.text);
}

/** 串行翻译各分片：后一片带上前一片译文的结尾，保证术语和语气连贯 */
async function translateChunks(cfg, job, chunks, onChunk, signal) {
  let done = '';
  for (let i = 0; i < chunks.length; i++) {
    const { text, sep } = chunks[i];
    const sub = {
      ...job,
      text,
      terms: await glossaryFor(job.scope, text), // 按分片各自命中的术语注入，不整段全发
      carry: done ? done.trimEnd().slice(-160) : job.carry || '',
      part: chunks.length > 1 ? [i + 1, chunks.length] : null,
    };
    let out;
    try {
      out = await translateOne(cfg, sub, (p) => onChunk(done + p), signal);
    } catch (error) {
      if (error.code !== 'truncated' || text.length <= MIN_RECOVERY_CHUNK * 2) throw error;
      const smaller = splitChunks(text, Math.ceil(text.length / 2));
      if (smaller.length < 2) throw error;
      out = await translateChunks(cfg, { ...job, carry: sub.carry }, smaller, (p) => onChunk(done + p), signal);
    }
    done += out + (i < chunks.length - 1 ? sep || '\n' : '');
    if (i === chunks.length - 1) done = done.trimEnd(); // 最后一帧与终稿一字不差，前端不必再画一遍
    onChunk(done);
  }
  return done;
}

/**
 * 翻译一片；带标记的译文若丢了标记，点名重发一次（温度 0），两次里取丢得少的那份。
 * 只在出错时多花一次请求，正常情况零开销。
 * 补发不走流式回调：先保持完整首稿，采用补发结果时再替换。
 */
async function translateOne(cfg, sub, onChunk, signal) {
  const out = await request(cfg, sub, onChunk, signal);
  if (!sub.tagged || sub.repair) return out;
  const missing = missingTags(sub.text, out);
  if (!missing.length) return out;
  // 流末尾若还在 25ms 合并窗口里会被 readStream 取消；补发可能等 30 秒，先确保完整首稿已经显示
  onChunk(out);
  let retry;
  try {
    retry = await request(cfg, { ...sub, repair: [...new Set(missing)] }, () => {}, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    return out; // 重发失败就用第一份：文字是完整的，只是丢了结构
  }
  return missingTags(sub.text, retry).length < missing.length ? retry : out;
}

/* ---------- 主流程 ---------- */

/** JSON 对象的键顺序不影响请求行为，也不该制造不同的缓存键。 */
function canonicalJson(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
  };
  return JSON.stringify(canonical(value));
}

/** 只纳入会改变提示词或请求行为的配置；API Key 和 profile 名称绝不进入缓存。 */
function cacheKeyFor(cfg, job) {
  return canonicalJson([
    CACHE_VERSION,
    PROMPT_VERSION,
    cfg.baseUrl.replace(/\/+$/, ''),
    cfg.model,
    cfg.targetLang,
    requestExtras(cfg),
    job.kind,
    !!job.tagged,
    {
      site: job.page?.site || '',
      title: job.page?.title || '',
      desc: job.page?.desc || '',
    },
    job.context || '',
    job.text,
  ]);
}

/** 一次翻译固定使用同一份配置，并把后处理需要的上下文随结果返回。 */
async function translateWithContext(job, onChunk = () => {}, signal) {
  const { active: cfg } = await loadConfig(); // 当前 profile，切换后下一次翻译立即生效
  if (!cfg.apiKey) throw fail('还没有配置 API Key', 'no-key');

  const c = await getCache();
  const scope = scopeOf(cfg, job.page);
  const key = cacheKeyFor(cfg, job);
  const hit = c.get(key);
  if (hit !== undefined) {
    c.delete(key), c.set(key, hit); // 命中即刷新为最近使用；只是换了顺序，不值得整张表重写一遍落盘
    onChunk(hit);
    return { text: hit, cfg, scope, fromCache: true };
  }

  // 命中缓存不占名额；真正要发请求时才计数，满了直接拒绝
  if (inFlight >= MAX_CONCURRENT) throw fail(`同时进行的翻译已达 ${MAX_CONCURRENT} 个上限，请稍后再试`);
  inFlight++;
  try {
    // 分片只占一个并发名额：它们本来就是串行的
    const out = await translateChunks(cfg, { ...job, scope }, splitChunks(job.text), onChunk, signal);
    c.set(key, out);
    for (const k of c.keys()) {
      if (c.size <= CACHE_MAX) break;
      c.delete(k);
    }
    saveCache();
    return { text: out, cfg, scope, fromCache: false };
  } finally {
    inFlight--;
  }
}

/** 对设置页等只关心译文的调用方保留简单接口。 */
async function translate(job, onChunk = () => {}, signal) {
  return (await translateWithContext(job, onChunk, signal)).text;
}

/* ---------- 往术语表里记：翻译完成之后才做，不占用户等待时间 ---------- */

const visible = (text) => stripMarkers(text).trim(); // 去掉结构占位标记

/** 整块就是一个词组的译文（标题、表头、按钮、链接文字），可以直接当术语用 */
const isPhrase = (s) => s.length <= TERM_MAX && !s.includes('\n') && s.split(/\s+/).length <= 6;

async function harvest(job, result, signal) {
  const { text: out, cfg, scope, fromCache } = result;
  if (!scope || !out) return;

  // 查词的结果本身就是一条对照；模型给了「甲/乙」两个说法时只取第一个
  if (job.kind === 'term') return remember(scope, job.text, out.split(/[/／]/)[0]);

  const source = visible(job.text);
  const target = visible(out);
  if (isPhrase(source) && isPhrase(target)) return remember(scope, source, target);
  if (!cfg.glossary || fromCache || source.length < EXTRACT_MIN) return;
  if (extracting >= EXTRACT_CONCURRENT) return; // 抽术语是可选项，挤不进去就算了

  extracting++;
  try {
    await extractTerms(cfg, scope, source, target, signal);
  } catch {
    /* 抽术语失败不影响译文，用户不需要知道 */
  } finally {
    extracting--;
  }
}

async function extractTerms(cfg, scope, source, target, signal) {
  const text = `原文：\n${source.slice(0, 3000)}\n\n译文：\n${target.slice(0, 3000)}`;
  const out = await request(cfg, { kind: 'glossary', text }, () => {}, signal);
  if (out.trim() === '无') return;

  for (const line of out.split('\n').slice(0, 8)) {
    const at = line.indexOf('=');
    if (at < 1) continue;
    const term = line.slice(0, at).trim();
    // 模型偶尔会编出原文里没有的词，或者把整句塞进来，一律丢掉
    if (term && appears(term, source)) await remember(scope, term, line.slice(at + 1));
  }
}

/* ---------- 请求 ---------- */

/* 查词和抽术语要唯一解，段落要通顺，所以温度分档 */
const TEMPERATURE = { term: 0, text: 0.2, block: 0.3, glossary: 0 };
const temperatureOf = (job) => (job.repair ? 0 : TEMPERATURE[job.kind] ?? 0.2); // 补标记要的是听话，不是通顺

/** 防止长段落被端点的默认输出上限截断；o 系 / gpt-5 换了字段名 */
const MAX_OUTPUT_TOKENS = 4096;
const initialOutputTokens = (length) => Math.min(MAX_OUTPUT_TOKENS, Math.max(512, Math.ceil(length * 3)));

function tokenLimit(model, tokens) {
  return /^(o[1-9]|gpt-5)/i.test(model)
    ? { max_completion_tokens: tokens }
    : { max_tokens: tokens };
}

function requestVariants(cfg, job, outputTokens) {
  const tuning = { temperature: temperatureOf(job), ...tokenLimit(cfg.model, outputTokens) };
  const extras = requestExtras(cfg);
  return [{ ...tuning, ...extras }, tuning, {}].filter(
    (variant, index, all) => index === 0 || JSON.stringify(variant) !== JSON.stringify(all[index - 1])
  );
}

async function request(cfg, job, onChunk, signal) {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const messages = buildMessages(job, cfg.targetLang);
  const body = { model: cfg.model, stream: true, messages };
  const fingerprint = echoLines(messages[0].content);
  const clean = (s) => stripEcho(stripThink(s), fingerprint);
  // 三档参数：全量 → 只留调参 → 一个不带。
  // 400 往下降一档并记住，因为 o 系拒绝 temperature、部分中转站拒绝一切未知字段。
  const endpoint = url + cfg.model;
  let outputTokens = initialOutputTokens(job.text.length);
  let retriedTruncation = false;
  let level = skipLevel.get(endpoint) ?? 0;

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
    for (;;) {
      const variants = requestVariants(cfg, job, outputTokens);
      level = Math.min(level, variants.length - 1);
      let res;
      for (;;) {
        res = await post(variants[level]);
        if (res.ok || res.status !== 400 || level >= variants.length - 1) break;
        skipLevel.set(endpoint, ++level); // 本次会话内直接从这一档起步
        alive();
      }
      if (!res.ok) throw fail(await errorMessage(res), `http-${res.status}`);

      const result = res.headers.get('content-type')?.includes('event-stream')
        ? await readStream(res, (text) => onChunk(clean(text)), alive)
        : await readJson(res);
      const out = clean(result.text);
      if (!['length', 'max_tokens'].includes(result.finishReason)) {
        if (!out)
          throw fail(
            result.text
              ? '模型没有翻译，只把提示词复述了一遍，换个模型试试'
              : '模型没有返回内容，换个模型或稍后再试'
          );
        return out;
      }

      const nextTokens = MAX_OUTPUT_TOKENS;
      const nextVariants = requestVariants(cfg, job, nextTokens);
      const nextLevel = Math.min(level, nextVariants.length - 1);
      const canIncrease =
        !retriedTruncation &&
        nextTokens > outputTokens &&
        canonicalJson(variants[level]) !== canonicalJson(nextVariants[nextLevel]);
      if (!canIncrease)
        throw fail('模型输出达到长度上限，已停止以免显示或缓存不完整译文', 'truncated');
      outputTokens = nextTokens;
      retriedTruncation = true;
      alive();
    }
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

/**
 * 一个时间窗只发送最后一份累计文本。cancel 用在完成、报错和中止路径，
 * 最终结果由 translateChunks 同步发送，不让残留 timer 在结束后补发旧帧。
 */
function createLatestEmitter(emit, schedule = setTimeout, cancelTimer = clearTimeout) {
  let timer = null;
  let latest;

  const push = (value) => {
    latest = value;
    if (timer !== null) return;
    timer = schedule(() => {
      timer = null;
      emit(latest);
    }, STREAM_INTERVAL);
  };

  const cancel = () => {
    if (timer === null) return;
    cancelTimer(timer);
    timer = null;
  };

  return { push, cancel };
}

async function readStream(res, onChunk, alive) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const updates = createLatestEmitter(onChunk);
  let buf = '';
  let out = '';
  let finishReason = '';
  try {
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
        const choice = parseJson(payload)?.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) updates.push((out += delta.content)); // reasoning_content 直接忽略
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
    return { text: out.trim(), finishReason };
  } finally {
    updates.cancel();
  }
}

/** 端点不支持 stream 时的回退 */
async function readJson(res) {
  const choice = (await res.json().catch(() => null))?.choices?.[0];
  return {
    text: choice?.message?.content?.trim() || '',
    finishReason: choice?.finish_reason || '',
  };
}

/* ---------- 单词发音：Google TTS 取音频，交给 offscreen 页播放 ----------

   用的是 translate.google.com 的非官方端点：不要 key，但会限流，也可能哪天就变。
   所以发音失败只回一句话给气泡上的按钮，翻译本身不受影响。 */

const TTS_LIMIT = 200; // 再长这个端点直接返回 400

const ttsUrl = (text, lang) =>
  'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
  `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;

let creatingOffscreen = null; // 连点两次会并发建文档，第二次必然报错

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: '播放选中单词的发音',
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function speak(text, lang) {
  if (!text || !lang) throw new Error('这段文字无法发音');
  if (text.length > TTS_LIMIT) throw new Error('这段文字太长，无法发音');
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'play', url: ttsUrl(text, lang) });
  if (res?.error) throw new Error(res.error);
}

/* ---------- 与内容脚本 / 设置页通信 ---------- */

/* 流式通道：内容脚本连接后发一条 job，收到若干 {chunk} 后以 {done} 或 {error} 结束 */
chrome.runtime.onConnect.addListener((port) => {
  const ctrl = new AbortController();
  let alive = true;
  port.onDisconnect.addListener(() => ((alive = false), ctrl.abort())); // 气泡关掉就中止请求

  port.onMessage.addListener(async (job) => {
    try {
      const result = await translateWithContext(
        job,
        (text) => alive && port.postMessage({ chunk: text }),
        ctrl.signal
      );
      if (alive) port.postMessage({ done: true, text: result.text });
      // 先把译文交给用户，再抽术语。端口留到这一步之后才断，
      // Service Worker 便不会在抽取途中被回收（收起译文会中止它）
      await harvest(job, result, ctrl.signal);
    } catch (e) {
      if (alive && e.name !== 'AbortError') port.postMessage({ error: e.message, code: e.code });
    }
    if (alive) port.disconnect();
  });
});

/** 清空时先替换内存实例；尚未完成的冷启动读取随后只能拿到这两张新空表。 */
async function clearStoredData() {
  cache = new Map();
  glossary = new Map();
  clearTimeout(saveTimer);
  clearTimeout(glossaryTimer);
  await chrome.storage.local.remove([CACHE_KEY, GLOSSARY_KEY]);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // 发给播放页的消息，这里不管
  switch (msg?.type) {
    case 'speak': // 气泡上的喇叭按钮
      speak(msg.text, msg.lang).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ error: err.message })
      );
      return true;
    case 'translate': // 设置页「测试连接」
      translate({ kind: 'text', text: msg.text }).then(
        (text) => sendResponse({ text }),
        (err) => sendResponse({ error: err.message })
      );
      return true;
    case 'openOptions':
      chrome.runtime.openOptionsPage();
      return false;
    case 'clearCache':
      clearStoredData().then(() => sendResponse({ ok: true }));
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
  ensureProfiles(); // 从 1.1 升级上来：旧的扁平配置变成「默认」profile
  if (reason === 'install') chrome.runtime.openOptionsPage(); // 装完直接进配置，不用先撞一次错误
});
chrome.runtime.onStartup.addListener(() => (createMenus(), ensureProfiles()));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const type = info.menuItemId === 'tr-sel' ? 'translate-selection' : 'translate-block';
  chrome.tabs.sendMessage(tab.id, { type }, { frameId: info.frameId ?? 0 }).catch(() => {});
});
