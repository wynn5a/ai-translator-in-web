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

test('提示词版本号参与缓存键，改了提示词旧译文要作废', () => {
  assert.ok(Number.isInteger(background.read('PROMPT_VERSION')));
  assert.ok(/PROMPT_VERSION,/.test(require('node:fs').readFileSync(`${__dirname}/../background.js`, 'utf8')));
});
