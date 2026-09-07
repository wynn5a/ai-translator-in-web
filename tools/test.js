/* ================= 纯逻辑测试：node --test tools/test.js =================

   守住两条最容易被静默破坏的东西：
     1. render 对模型输出的容错——分段标记被写歪、换成 <br>、丢掉、编号乱编时，
        还原出来的分段必须完全一样，且不能把标签残渣当正文显示出来；
     2. 长段落分片不能切坏占位标记，拼回去必须与原文一字不差。

   涉及 CSS 的（display / white-space / flex 子项）在 tools/test.html 里跑，
   node 里的 DOM 桩模拟不出排版引擎。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadContent, loadBackground, html, el } = require('./harness');

const content = loadContent();
const background = loadBackground();

/** 跑一遍 render，返回还原出来的 HTML */
function render(text, parts = []) {
  const target = el('div');
  content.render(target, text, parts);
  return html(target).replace(/^<div>|<\/div>$/g, '');
}

/* ---------- render：模型把分段标记写歪的各种姿势 ---------- */

test('分段标记写歪时还原结果不变', () => {
  // 原文是三段，编码后是 A。<n1/>\n<n2/>\nB。<n3/>\n<n4/>\nC。
  const 期望 = 'A。<br><br>B。<br><br>C。';
  const 各种写法 = {
    规范: 'A。<n1/>\n<n2/>\nB。<n3/>\n<n4/>\nC。',
    '标记挪到换行前面': 'A。\n<n1/>\n<n2/>B。\n<n3/><n4/>\nC。',
    '连在一起没有换行': 'A。<n1/><n2/>B。<n3/><n4/>C。',
    '换成真正的 <br/>': 'A。<br/>\n<br/>\nB。<br/>\n<br/>\nC。',
    '换成 <br> 不带斜杠': 'A。<br><br>B。<br><br>C。',
    '换成 < br /> 带空格': 'A。< br />< br />B。< br />< br />C。',
    '标记里多了空格': 'A。<n1 />\n<n2 />\nB。<n3 />\n<n4 />\nC。',
    '写成闭合标记': 'A。</n1>\n</n2>\nB。</n3>\n</n4>\nC。',
    '漏了自闭合斜杠': 'A。<n1>\n<n2>\nB。<n3>\n<n4>\nC。',
    '多打一个右尖括号': 'A。<n1/>>\n<n2/>>\nB。<n3/>\n<n4/>\nC。',
    '多打一个左尖括号': 'A。<<n1/>\n<<n2/>\nB。<n3/>\n<n4/>\nC。',
    '换行标记大写': 'A。<N1/>\n<N2/>\nB。<N3/>\n<N4/>\nC。',
    '编号乱编': 'A。<n7/>\n<n8/>\nB。<n9/>\n<n99/>\nC。',
    '标记全丢只剩换行': 'A。\n\nB。\n\nC。',
  };
  for (const [名字, 输出] of Object.entries(各种写法)) assert.equal(render(输出), 期望, 名字);
});

test('换行既不翻倍也不吞掉', () => {
  assert.equal(render('A。<n1/>\nB。'), 'A。<br>B。', '标记后面那个排版换行要吃掉');
  assert.equal(render('A。<n1/>B。'), 'A。<br>B。', '模型没带换行也只出一个');
  assert.equal(render('A。<n1/>\n\n\nB。'), 'A。<br><br><br>B。', '模型自己多打的空行留着，宁可多不可少');
  assert.equal(render('A。\nB。'), 'A。<br>B。', '裸换行照样是换行');
  assert.equal(render('A。 <n1/> B。'), 'A。<br>B。', '标记就是行边界，紧贴它的空格不该留成行首空格');
});

test('正文里的尖括号不会被当成标记吃掉', () => {
  assert.equal(render('如果 5 < 6 成立'), '如果 5 < 6 成立');
  assert.equal(render('设 a < b 3 > c'), '设 a < b 3 > c', '字母和数字之间有空白就不是标记');
  assert.equal(render('写一个 <div> 标签'), '写一个 <div> 标签');
  // 行内/段落标记只认小写，就是为了留出这一手：大写的泛型参数在译文里很常见
  assert.equal(render('泛型写成 List<T1> 就行', [el('a')]), '泛型写成 List<T1> 就行');
  assert.equal(render('Vec<B2> 和 Map<X3>', [el('a'), el('a'), el('a')]), 'Vec<B2> 和 Map<X3>');
});

test('流式过程中半截标记不露出来', () => {
  for (const 半截 of ['A。<', 'A。<n', 'A。<n1', 'A。<n1/', 'A。<b', 'A。<br', 'A。</', 'A。</t'])
    assert.equal(render(半截), 'A。', 半截);
  assert.equal(render('A。<n1/>\n<n2/>\nB'), 'A。<br><br>B', '传到一半的正文照常显示');
});

/* ---------- render：行内结构还原 ---------- */

test('行内标记套回原元素，属性保留但去掉 id 和行内事件', () => {
  const link = el('a', { href: '/x', class: 'c', id: 'nope', onclick: 'evil()' });
  assert.equal(render('点 <t1>这里</t1>', [link]), '点 <a href="/x" class="c">这里</a>');
});

test('不可翻译片段整体克隆搬回', () => {
  const code = el('code', { class: 'k' });
  code.append(el('span'));
  assert.equal(render('运行 <x1/> 即可', [code]), '运行 <code class="k"><span></span></code> 即可');
});

test('段落标记还原成原来的块元素', () => {
  const p = el('p', { class: 'body' });
  assert.equal(render('<b1>甲</b1>\n\n<b2>乙</b2>', [p, p]), '<p class="body">甲</p><p class="body">乙</p>');
});

test('段落标记编号对不上时退化成换行，不把两段并成一段', () => {
  assert.equal(render('<b8>甲</b8>\n\n<b9>乙</b9>', []), '<br>甲<br><br>乙<br>');
});

test('模型漏掉行内标记时退化成纯文本，文字不丢', () => {
  assert.equal(render('点这里', [el('a')]), '点这里');
});

/* ---------- 长段落分片 ---------- */

const { splitChunks, breakpoints } = background;
const CHUNK_LIMIT = background.read('CHUNK_LIMIT');

/** 分片必须无损：正文加上被 trim 掉的分隔空白，要能一字不差地拼回原文 */
const rejoin = (chunks) => chunks.map((c) => c.text + c.sep).join('');

test('分片拼回原文一字不差', () => {
  const src = ('这是一个很长的句子，用来把长度撑过分片上限。' + 'Another sentence here. ').repeat(60);
  const chunks = splitChunks(src);
  assert.ok(chunks.length > 1, '应该真的切开了');
  assert.equal(rejoin(chunks), src);
});

test('没有句子断点时，硬切也不能落在结构标记内部', () => {
  const markers = ['<t1>', '</t1>', '<x2/>', '<n3/>', '<b4>', '</b4>'];
  for (const marker of markers) {
    for (let inside = 1; inside < marker.length; inside++) {
      const src = `${'a'.repeat(CHUNK_LIMIT - inside)}${marker}${'b'.repeat(CHUNK_LIMIT)}`;
      const chunks = splitChunks(src);
      assert.equal(rejoin(chunks), src, `${marker} 的第 ${inside} 个字符处`);

      let boundary = 0;
      for (const chunk of chunks.slice(0, -1)) {
        boundary += chunk.text.length + chunk.sep.length;
        const markerStart = src.indexOf(marker);
        const markerEnd = markerStart + marker.length;
        assert.ok(
          boundary <= markerStart || boundary >= markerEnd,
          `切点 ${boundary} 落在 ${marker} 内部（${markerStart}–${markerEnd}）`
        );
      }
    }
  }
});

test('切点绝不落在行内标记内部', () => {
  const inner = '这是一段被 t 标记包住的很长的文字，中间有。句号，也有 English. sentences. '.repeat(30);
  const src = `开头。<t1>${inner}</t1>结尾。`;
  for (const { text } of splitChunks(src)) {
    const opens = [...text.matchAll(/<t(\d+)>/g)].map((m) => m[1]);
    const closes = [...text.matchAll(/<\/t(\d+)>/g)].map((m) => m[1]);
    // 允许跨片的 t 标记只出现半边，但绝不能把 `<t1` 这样的标记本身切成两半
    assert.ok(!/<\/?[txbn]\d*$/.test(text), `标记被切断了：${text.slice(-12)}`);
    assert.ok(opens.length <= 1 && closes.length <= 1);
  }
});

test('优先切在段落边界，其次才是句子边界', () => {
  const para = '一句话。'.repeat(40); // 160 字
  const src = [para, para, para, para, para, para, para, para, para, para].join('<n1/>\n');
  const chunks = splitChunks(src, 400);
  for (const { text } of chunks) assert.ok(!/<n\d*$|^n\d+\/>/.test(text), '换行标记被切断');
  assert.equal(rejoin(chunks), src);
});

test('段落标记不参与深度，超长单段仍能找到断点', () => {
  const long = '这是一句话。'.repeat(300); // 单段远超上限
  const src = `<b1>${long}</b1>`;
  assert.ok(src.length > CHUNK_LIMIT);
  const stops = breakpoints(src);
  assert.ok(stops.length > 1, '段落标记里面必须还能断句，否则只能硬切');
  assert.equal(rejoin(splitChunks(src)), src);
});

test('行内标记参与深度，标记里面不产生断点', () => {
  const stops = breakpoints('外面。<t1>里面。还是里面。</t1>外面。');
  const inside = stops.filter((s) => s.at > 4 && s.at < '外面。<t1>里面。还是里面。</t1>'.length - 5);
  assert.equal(inside.length, 0);
});

/* ---------- 提示词 ---------- */

const systemOf = (job) => background.buildMessages(job, '简体中文')[0].content;

test('带标记时提示词必须讲清楚标记规则', () => {
  const sys = systemOf({ kind: 'block', text: 'x', tagged: true });
  for (const 关键点 of ['<b1>', '<n1/>', '<t1>', '<x1/>', '编号和数量都不能变'])
    assert.ok(sys.includes(关键点), `提示词里缺了「${关键点}」`);
  assert.ok(/不许换成\s*<br>/.test(sys), '必须禁止模型把换行标记改写成 HTML 的 <br>');
  assert.ok(sys.includes('绝不能把几段合并成一段'));
});

test('不带标记时不塞标记规则，但仍要求保持分段', () => {
  const sys = systemOf({ kind: 'block', text: 'x', tagged: false });
  assert.ok(!sys.includes('<t1>'));
  assert.ok(sys.includes('保持分段'));
});

test('段落相邻内容只作为 system 上下文，不混入待译正文', () => {
  const job = {
    kind: 'block',
    text: 'Target paragraph.',
    surrounding: {
      heading: 'Architecture',
      before: 'The service starts here.',
      after: 'The client connects next.',
    },
  };
  const messages = background.buildMessages(job, '简体中文');
  for (const text of ['Architecture', 'The service starts here.', 'The client connects next.', '不要翻译、复述'])
    assert.ok(messages[0].content.includes(text));
  assert.equal(messages[1].content, job.text);
});

test('四种任务的提示词各不相同', () => {
  const kinds = ['block', 'text', 'term', 'glossary'];
  const all = kinds.map((kind) => systemOf({ kind, text: 'x', context: 'y' }));
  assert.equal(new Set(all).size, kinds.length);
  assert.ok(all[2].includes('双语词典'));
  assert.ok(all[3].includes('术语抽取器'));
});

test('模型把提示词照抄出来时不当译文显示', () => {
  const { stripEcho } = background;
  const sys = systemOf({ kind: 'block', text: 'x', page: { site: 'unfair.so', title: 'Pay less' } });
  assert.equal(stripEcho(`Paste your site.\n\n${sys}`, sys), 'Paste your site.', '提示词之后的全砍掉');
  assert.equal(stripEcho(sys, sys), '', '整段都是提示词就什么都不剩，外层会报错');
  assert.equal(stripEcho('正常译文。要求：明天交。', sys), '正常译文。要求：明天交。', '短行不能误伤正文');
});

test('思考模型混进正文的 <think> 块被去掉，流式半截也不露出来', () => {
  const stripThink = background.read('stripThink');
  assert.equal(stripThink('<think>先想想。</think>\n译文。'), '\n译文。');
  assert.equal(stripThink('<think>还在想'), '', '结束标记没到之前整段藏着');
  assert.equal(stripThink('</think>译文。'), '译文。', '有的模型只吐结束标记');
  assert.equal(stripThink('正常译文。'), '正常译文。');
});

test('标记完整性检查：漏掉的标记被点名，写歪的不算漏', () => {
  const missingTags = (s, o) => [...background.missingTags(s, o)]; // vm 里的数组不是本境的 Array，deepEqual 会挑剔
  const src = '点 <t1>这里</t1> 运行 <x2/><n1/>\n<b3>第二段</b3>';
  assert.deepEqual(missingTags(src, '点 <t1>这里</t1> 运行 <x2/><n1/>\n<b3>第二段</b3>'), []);
  assert.deepEqual(missingTags(src, '点 <t1>这里</t1> 运行 <x2/><br>\n<b3 >第二段</b3>'), [], '<br> 和空格都归一');
  assert.deepEqual(missingTags(src, '点这里 运行 <x2/><n1/>\n<b3>第二段</b3>'), ['<t1>', '</t1>']);
  assert.deepEqual(missingTags(src, '点 <t1>这里</t1> 运行 <n1/>\n<b3>第二段</b3>'), ['<x2>']);
  assert.deepEqual(missingTags(src, '点 <t1>这里</t1> 运行 <x2/>\n<b3>第二段</b3>'), ['<n/>']);
  assert.deepEqual(missingTags('A。<n1/>\n<n2/>\nB。', 'A。<n7/><n8/>B。'), [], '换行标记只数个数');
  assert.deepEqual(missingTags('用 <t1>List</t1>', '用 List<T1>'), ['<t1>', '</t1>'], '大写泛型不是标记');
});

test('术语收集沿用翻译开始时的配置上下文', async () => {
  const scope = 'docs.example\x01简体中文';
  const result = {
    text: '共享模块',
    cfg: { targetLang: '简体中文', glossary: true },
    scope,
    fromCache: false,
  };
  await background.harvest({ kind: 'term', text: 'shared module' }, result);
  const glossary = await background.getGlossary();
  assert.equal(glossary.get(scope).get('shared module'), '共享模块');
  background.read('clearTimeout(glossaryTimer)');
});

test('译文交付后取消时不再把尚未完成的术语写入表中', async () => {
  const isolated = loadBackground();
  const glossaryLoad = deferred();
  isolated.chrome.storage.local.get = () => glossaryLoad.promise;
  const ctrl = new AbortController();
  const harvest = isolated.harvest(
    { kind: 'term', text: 'shared module' },
    {
      text: '共享模块',
      cfg: { targetLang: '简体中文', glossary: true },
      scope: 'docs.example\x01简体中文',
      fromCache: false,
    },
    ctrl.signal
  );

  ctrl.abort();
  glossaryLoad.resolve({});
  await assert.rejects(harvest, (error) => error.name === 'AbortError');
  assert.equal((await isolated.getGlossary()).size, 0);
});

/* ---------- 缓存键 ---------- */

const cacheCfg = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'secret-a',
  model: 'qwen-plus',
  targetLang: '简体中文',
  noThink: true,
  extraBody: '',
};
const cacheJob = {
  kind: 'block',
  text: 'Translate this paragraph.',
  tagged: false,
  page: { site: 'example.com', title: 'Guide', desc: 'Technical documentation' },
};

test('缓存键覆盖所有影响提示词和请求行为的输入', () => {
  const key = background.cacheKeyFor(cacheCfg, cacheJob);
  const changed = [
    [{ ...cacheCfg, noThink: false }, cacheJob],
    [{ ...cacheCfg, extraBody: '{"seed":1}' }, cacheJob],
    [cacheCfg, { ...cacheJob, tagged: true }],
    [cacheCfg, { ...cacheJob, page: { ...cacheJob.page, desc: 'Product landing page' } }],
    [cacheCfg, { ...cacheJob, surrounding: { before: 'Previous paragraph' } }],
  ];
  for (const [cfg, job] of changed) assert.notEqual(background.cacheKeyFor(cfg, job), key);
  assert.notEqual(background.cacheKeyFor(cacheCfg, cacheJob, [[['paragraph', '段落']]]), key);
});

test('缓存键忽略密钥、profile 名称和无意义的 JSON 顺序', () => {
  const first = {
    ...cacheCfg,
    noThink: false,
    extraBody: '{"reasoning":{"effort":"low","summary":"auto"},"seed":1}',
    name: '日常',
  };
  const second = {
    ...first,
    apiKey: 'secret-b',
    name: '备用',
    baseUrl: `${first.baseUrl}/`,
    extraBody: '{"seed":1,"reasoning":{"summary":"auto","effort":"low"}}',
  };
  const key = background.cacheKeyFor(first, cacheJob);
  assert.equal(background.cacheKeyFor(second, cacheJob), key);
  assert.ok(!key.includes(first.apiKey));
  assert.ok(!key.includes(second.apiKey));
  assert.ok(!key.includes(first.name));
  assert.ok(!key.includes(second.name));
});

test('相关术语更新后不命中旧译文缓存', async () => {
  const isolated = loadBackground();
  isolated.testCfg = { ...cacheCfg };
  isolated.requests = [];
  isolated.read(`
    cache = new Map();
    glossary = new Map([['example.com\\x01简体中文', new Map([['paragraph', '段落']])]]);
    loadConfig = async () => ({ active: testCfg });
    request = async (_cfg, job) => {
      requests.push(job.terms);
      return requests.length === 1 ? '首稿' : '新译文';
    };
  `);
  const job = { ...cacheJob, text: 'Translate this paragraph.' };

  assert.equal((await isolated.translateWithContext(job)).text, '首稿');
  assert.equal((await isolated.translateWithContext(job)).text, '首稿', '术语未变时应命中缓存');
  await isolated.remember('example.com\x01简体中文', 'unrelated', '无关');
  assert.equal((await isolated.translateWithContext(job)).text, '首稿', '无关术语不应让缓存失效');
  await isolated.remember('example.com\x01简体中文', 'paragraph', '段');
  assert.equal((await isolated.translateWithContext(job)).text, '新译文', '术语变化后必须重新翻译');
  assert.deepEqual(
    [...isolated.requests].map((terms) => [...terms].map((term) => [...term])),
    [
      [['paragraph', '段落']],
      [['paragraph', '段']],
    ]
  );
  isolated.read('clearTimeout(saveTimer); clearTimeout(glossaryTimer)');
});

/* ---------- 前后台流式通信 ---------- */

function fakePort() {
  let receive;
  let disconnect;
  return {
    port: {
      onMessage: { addListener: (listener) => (receive = listener) },
      onDisconnect: { addListener: (listener) => (disconnect = listener) },
      postMessage() {},
      disconnect() {},
    },
    receive: (message) => receive(message),
    drop: () => disconnect(),
  };
}

test('流式连接中断时不把已收到的半截当成完整译文', async () => {
  const isolated = loadContent();
  const channel = fakePort();
  let cancelledFrame = 0;
  const painted = [];
  isolated.chrome.runtime.connect = () => channel.port;
  isolated.requestAnimationFrame = () => 7;
  isolated.cancelAnimationFrame = (frame) => (cancelledFrame = frame);

  const task = isolated.requestTranslation({ kind: 'text', text: 'source' }, (text) => painted.push(text));
  channel.receive({ chunk: '未完成的译' });
  channel.drop();

  const result = await task;
  assert.equal(result.text, undefined);
  assert.equal(result.error, '连接中断，请重试');
  assert.equal(result.code, 'disconnect');
  assert.equal(cancelledFrame, 7, '排队中的半截不能在错误提示后重新画出来');
  assert.deepEqual(painted, []);
});

test('收到完成消息后端口正常关闭仍保留完整译文', async () => {
  const isolated = loadContent();
  const channel = fakePort();
  isolated.chrome.runtime.connect = () => channel.port;
  isolated.cancelAnimationFrame = () => {};

  const task = isolated.requestTranslation({ kind: 'text', text: 'source' }, () => {});
  channel.receive({ done: true, text: '完整译文' });
  channel.drop();

  assert.equal((await task).text, '完整译文');
});

test('主动取消立即结束任务，端口随后断开也不误报连接错误', async () => {
  const isolated = loadContent();
  const channel = fakePort();
  isolated.chrome.runtime.connect = () => channel.port;
  isolated.cancelAnimationFrame = () => {};

  const task = isolated.requestTranslation({ kind: 'text', text: 'source' }, () => {});
  task.cancel();
  channel.drop();

  assert.equal((await task).cancelled, true);
  await task.closed;
});

test('译文交付和后台任务关闭是两个独立阶段', async () => {
  const isolated = loadContent();
  const channel = fakePort();
  isolated.chrome.runtime.connect = () => channel.port;
  isolated.cancelAnimationFrame = () => {};

  const task = isolated.requestTranslation({ kind: 'text', text: 'source' }, () => {});
  channel.receive({ done: true, text: '完整译文' });
  assert.equal((await task).text, '完整译文');

  let closed = false;
  task.closed.then(() => (closed = true));
  await Promise.resolve();
  assert.equal(closed, false, 'done 后仍可通过同一个任务句柄取消后台术语收集');

  channel.drop();
  await task.closed;
  assert.equal(closed, true);
});

/* ---------- 后台流式更新合并 ---------- */

function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    schedule(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    run() {
      const jobs = [...pending.values()];
      pending.clear();
      jobs.forEach((fn) => fn());
    },
    get size() {
      return pending.size;
    },
  };
}

test('高频流式更新每个时间窗只发送最新文本', () => {
  const timers = fakeTimers();
  const emitted = [];
  const updates = background.createLatestEmitter(
    (text) => emitted.push(text),
    (fn) => timers.schedule(fn),
    (id) => timers.cancel(id)
  );

  updates.push('a');
  updates.push('ab');
  updates.push('abc');
  assert.equal(timers.size, 1, '同一个时间窗只安排一个 timer');
  assert.deepEqual(emitted, []);

  timers.run();
  assert.deepEqual(emitted, ['abc']);

  updates.push('abcd');
  timers.run();
  assert.deepEqual(emitted, ['abc', 'abcd'], '下一个时间窗仍能继续发送');
});

test('流式完成或中止时取消尚未发送的旧帧', () => {
  const timers = fakeTimers();
  const emitted = [];
  const updates = background.createLatestEmitter(
    (text) => emitted.push(text),
    (fn) => timers.schedule(fn),
    (id) => timers.cancel(id)
  );

  updates.push('partial');
  updates.cancel();
  timers.run();
  assert.deepEqual(emitted, []);
});

/* ---------- 响应完整性 ---------- */

function jsonResponse(text, finishReason) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({
      choices: [{ message: { content: text }, finish_reason: finishReason }],
    }),
  };
}

function streamResponse(events) {
  const value = new Uint8Array(
    Buffer.from(`${events.map((event) => `data: ${JSON.stringify(event)}\n`).join('')}data: [DONE]\n`)
  );
  let sent = false;
  return {
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value };
        },
      }),
    },
  };
}

test('流式与非流式响应都保留 finish_reason', async () => {
  const streamed = await background.readStream(
    streamResponse([
      { choices: [{ delta: { content: '未完成' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]),
    () => {},
    () => {}
  );
  assert.equal(streamed.text, '未完成');
  assert.equal(streamed.finishReason, 'length');

  const json = await background.readJson(jsonResponse('完成', 'stop'));
  assert.equal(json.text, '完成');
  assert.equal(json.finishReason, 'stop');
});

test('输出截断时自动提高 token 上限后重试', async () => {
  const isolated = loadBackground();
  const bodies = [];
  const responses = [jsonResponse('未完成', 'length'), jsonResponse('完整译文', 'stop')];
  isolated.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return responses.shift();
  };
  const cfg = { ...cacheCfg, model: 'gpt-4o-mini', noThink: false };
  const out = await isolated.request(cfg, { kind: 'text', text: 'short source' }, () => {});

  assert.equal(out, '完整译文');
  assert.deepEqual(
    bodies.map((body) => body.max_tokens),
    [512, 4096]
  );
});

test('无法再提高 token 上限时明确报告截断', async () => {
  const isolated = loadBackground();
  let requests = 0;
  isolated.fetch = async () => {
    requests++;
    return jsonResponse('仍未完成', 'length');
  };
  const cfg = { ...cacheCfg, model: 'gpt-4o-mini', noThink: false };
  const job = { kind: 'block', text: 'x'.repeat(1400), tagged: false };

  await assert.rejects(
    () => isolated.request(cfg, job, () => {}),
    (error) => error.code === 'truncated' && error.message.includes('长度上限')
  );
  assert.equal(requests, 1);
});

test('截断且无法恢复的译文不会进入缓存', async () => {
  const isolated = loadBackground();
  isolated.testCfg = { ...cacheCfg, model: 'gpt-4o-mini', noThink: false };
  isolated.read(`
    cache = new Map();
    loadConfig = async () => ({ active: testCfg });
  `);
  isolated.fetch = async () => jsonResponse('未完成', 'length');

  await assert.rejects(
    () => isolated.translateWithContext({ kind: 'text', text: 'short source' }),
    (error) => error.code === 'truncated'
  );
  assert.equal((await isolated.getCache()).size, 0);
});

test('初始化期间取消的任务不会命中缓存或发出请求', async () => {
  const isolated = loadBackground();
  const configLoad = deferred();
  let requests = 0;
  isolated.fetch = async () => {
    requests++;
    return jsonResponse('不应发出', 'stop');
  };
  isolated.configLoad = configLoad.promise;
  isolated.testCfg = { ...cacheCfg };
  isolated.read('loadConfig = async () => (await configLoad, { active: testCfg })');

  const ctrl = new AbortController();
  const task = isolated.translateWithContext({ kind: 'text', text: 'source' }, () => {}, ctrl.signal);
  ctrl.abort();
  configLoad.resolve();

  await assert.rejects(task, (error) => error.name === 'AbortError');
  assert.equal(requests, 0);
});

test('最大 token 仍截断时自动把源文分成更小的安全分片', async () => {
  const isolated = loadBackground();
  isolated.requestLengths = [];
  isolated.read(`
    request = async (_cfg, job) => {
      requestLengths.push(job.text.length);
      if (job.text.length > 500) throw Object.assign(new Error('truncated'), { code: 'truncated' });
      return job.text;
    }
  `);
  const source = 'a'.repeat(1000);
  const out = await isolated.translateChunks(
    {},
    { kind: 'block', text: source, tagged: false, scope: '' },
    [{ text: source, sep: '' }],
    () => {}
  );

  assert.equal(out.replace(/\n/g, ''), source);
  assert.deepEqual([...isolated.requestLengths], [1000, 500, 500]);
});

/* ---------- 冷启动存储 ---------- */

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test('并发冷启动只读取一次并共享同一份缓存', async () => {
  const isolated = loadBackground();
  const load = deferred();
  let reads = 0;
  isolated.chrome.storage.local.get = () => {
    reads++;
    return load.promise;
  };

  const first = isolated.getCache();
  const second = isolated.getCache();
  assert.equal(reads, 1);

  load.resolve({ __cache: [['source', 'target']] });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a.get('source'), 'target');
});

test('并发冷启动只读取一次并共享同一份术语表', async () => {
  const isolated = loadBackground();
  const load = deferred();
  let reads = 0;
  isolated.chrome.storage.local.get = () => {
    reads++;
    return load.promise;
  };

  const first = isolated.getGlossary();
  const second = isolated.getGlossary();
  assert.equal(reads, 1);

  load.resolve({ __glossary: [['example.com\x01简体中文', [['term', '术语']]]] });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a.get('example.com\x01简体中文').get('term'), '术语');
});

test('清空操作不会被尚未完成的冷启动读取回填', async () => {
  const isolated = loadBackground();
  const cacheLoad = deferred();
  const glossaryLoad = deferred();
  isolated.chrome.storage.local.get = (key) => (key === '__cache' ? cacheLoad.promise : glossaryLoad.promise);

  const pendingCache = isolated.getCache();
  const pendingGlossary = isolated.getGlossary();
  await isolated.clearStoredData();

  cacheLoad.resolve({ __cache: [['old', '旧译文']] });
  glossaryLoad.resolve({ __glossary: [['old-scope', [['old', '旧术语']]]] });
  const [cache, glossary] = await Promise.all([pendingCache, pendingGlossary]);
  assert.equal(cache.size, 0);
  assert.equal(glossary.size, 0);
});

test('补标记的重发提示词点名缺失的标记，且温度为 0', () => {
  const sys = systemOf({ kind: 'block', text: 'x', tagged: true, repair: ['<t1>', '</t1>'] });
  assert.ok(sys.includes('<t1> </t1>'));
  assert.ok(sys.includes('一个都不能少'));
  assert.ok(!systemOf({ kind: 'block', text: 'x', tagged: true }).includes('上一次'));
  assert.equal(background.read('temperatureOf')({ kind: 'block', repair: ['<t1>'] }), 0);
  assert.equal(background.read('temperatureOf')({ kind: 'block' }), 0.3);
});

test('补标记请求开始前先显示完整首稿', async () => {
  const isolated = loadBackground();
  isolated.events = [];
  isolated.read(`
    request = async (_cfg, job) => {
      events.push(job.repair ? 'repair-start' : 'initial-start');
      return job.repair ? '<t1>译文</t1>' : '译文';
    }
  `);

  const out = await isolated.translateOne(
    {},
    { text: '<t1>source</t1>', tagged: true },
    (text) => isolated.events.push(`show:${text}`)
  );

  assert.deepEqual([...isolated.events], ['initial-start', 'show:译文', 'repair-start']);
  assert.equal(out, '<t1>译文</t1>');
});

test('提示词版本号参与缓存键，改了提示词旧译文要作废', () => {
  assert.ok(Number.isInteger(background.read('PROMPT_VERSION')));
  assert.ok(Number.isInteger(background.read('CACHE_VERSION')));
  assert.ok(/PROMPT_VERSION,/.test(require('node:fs').readFileSync(`${__dirname}/../background.js`, 'utf8')));
});
