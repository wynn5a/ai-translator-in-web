/* ================= 提示词与后处理的离线评测集 =================

   固定段落的评测集（计划第 14 条）：改提示词前后各跑一次，人工核对译文要点。
   不进 CI——真实调用要花钱，要点核对也需要人眼。

     npm run eval -- --dry-run     只打印发给模型的 prompt，不发请求
     EVAL_BASE_URL=https://api.deepseek.com \
     EVAL_API_KEY=sk-xxx EVAL_MODEL=deepseek-chat npm run eval

   prompt 一律取自生产代码（background.js 的 buildPrompt，经测试用的
   harness 加载），评测永远不会和线上用的提示词脱节。 */

const { loadBackground } = require('./harness');

const LANG = '简体中文';
const BASE = process.env.EVAL_BASE_URL?.replace(/\/+$/, '') || '';
const MODEL = process.env.EVAL_MODEL || '';
const KEY = process.env.EVAL_API_KEY || '';
const DRY = process.argv.includes('--dry-run');

/* 每条用例：待译正文 + 人工确认过的期望要点（一条要点可以给几个可接受的写法，
   用 | 分隔，脚本只做提示，最终判断靠人）。覆盖计划点名的场景：
   标记往返、术语消歧（pitch 三义）、长难句、中英混排、代码保护。 */
const CASES = [
  {
    name: '数字保真：漏数字要能看出来',
    kind: 'block',
    text: 'The library shipped in 2019 and reached version 3.2.1 by 2024, downloading over 1,500,000 times a month.',
    expect: ['2019', '3.2.1', '2024', '1,500,000|150 万|150万'],
  },
  {
    name: '术语消歧 pitch（音乐）：调高',
    kind: 'block',
    text: 'Pitch the sample up by two semitones before you bounce the track.',
    expect: ['音高|升调', '2|两', '半音'],
  },
  {
    name: '术语消歧 pitch（棒球）：投球',
    kind: 'block',
    text: 'The pitcher threw 95 pitches in six innings, and every pitch hit the corner.',
    expect: ['投球|投出的球'],
  },
  {
    name: '术语消歧 pitch（销售）：推销话术',
    kind: 'block',
    text: 'Her pitch to the investors was crisp: 30 seconds, one number, one ask.',
    expect: ['推销|路演|融资陈述|pitch'],
  },
  {
    name: '标记往返：分段标记一个不能少',
    kind: 'block',
    tagged: true,
    text: 'Install the CLI with one command.<n1/>\nThen run the generator inside your project.<b2/>\n<b3/>Commit the result and open a pull request.',
    expect: ['<n1/>', '<b2/>', '<b3/>'],
  },
  {
    name: '代码保护：命令、路径、变量名原样保留',
    kind: 'block',
    text: 'Run npm install --save-dev eslint, then add the ignorePatterns option to eslint.config.js so that dist/ and *.min.js are skipped.',
    expect: ['npm install --save-dev eslint', 'ignorePatterns', 'eslint.config.js', 'dist/', '*.min.js'],
  },
  {
    name: '长难句：从句不丢信息',
    kind: 'block',
    text: 'The committee, whose mandate had been renewed twice amid growing skepticism about whether its findings would ever translate into policy, released a 240-page interim report that quietly conceded most of the criticisms.',
    expect: ['授权|职权', '240', '临时报告|中期报告', '批评'],
  },
  {
    name: '中英混排：外语句子要译出来',
    kind: 'block',
    text: 'As the announcement put it, "no timeline has been set", 但公司内部的目标仍是明年一季度上线。',
    expect: ['没有确定时间表|尚未确定时间', '明年第一季度|明年一季度'],
  },
  {
    name: '分段保真：原文几段译文就几段',
    kind: 'block',
    text: 'First paragraph ends here.\n\nSecond paragraph starts with a number: 42.',
    expect: ['第一段', '42'],
  },
  {
    name: '划词：片段照原样译，不补全',
    kind: 'text',
    text: 'drop the table and start over',
    expect: ['删表|删掉表', '重来|重新开始'],
  },
  {
    name: '查词：所在句定义项',
    kind: 'term',
    text: 'bank',
    context: 'We sat on the bank of the river and watched the herons.',
    expect: ['河岸|岸'],
  },
  {
    name: '成稿通读 polish：修正漏译而不是重写',
    kind: 'polish',
    text: 'The sensor samples at 10 Hz and draws 12 mA.',
    context: '传感器以 10 Hz 采样。',
    expect: ['12 mA|12 毫安', '采样'],
  },
];

/** 用生产代码组装 prompt（与 test.js 相同的加载方式） */
const bg = loadBackground();
const buildPrompt = bg.read('buildPrompt');
const stripMarkers = bg.read('stripMarkers');

function jobOf(c) {
  const job = {
    kind: c.kind,
    text: c.text,
    context: c.context,
    tagged: !!c.tagged,
    terms: [],
  };
  return job;
}

/** 要点核对：一条要点命中任一可选写法即算过。只做提示，最终靠人。 */
function check(out, expect) {
  return expect.map((point) => {
    const options = point.split('|');
    return { point, ok: options.some((o) => out.includes(o)) };
  });
}

async function callApi(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0].message.content.trim();
}

let failed = 0;
async function main() {
  for (const c of CASES) {
    const { messages } = buildPrompt(jobOf(c), LANG);
    if (DRY) {
      console.log(`\n========== ${c.name} ==========`);
      for (const m of messages) console.log(`--- ${m.role} ---\n${m.content}`);
      continue;
    }
    console.log(`\n========== ${c.name} ==========`);
    try {
      const out = await callApi(messages);
      console.log(`【译文】\n${out}`);
      if (c.tagged && c.kind === 'block') {
        const missing = c.expect.filter((p) => p.startsWith('<')).filter((p) => !out.includes(p));
        if (missing.length) console.log(`【标记丢失】${missing.join(' ')}`);
        console.log(`【纯文本】\n${stripMarkers(out)}`);
      }
      const results = check(out, c.expect);
      for (const { point, ok } of results) console.log(`${ok ? '✓' : '✗'} ${point}`);
      if (results.some((r) => !r.ok)) failed++;
    } catch (e) {
      failed++;
      console.error(`✗ 请求失败：${e.message}`);
    }
  }
}

if (!DRY) console.log(`\n${CASES.length - failed}/${CASES.length} 条用例要点齐全（要点核对仅供参考，请人工确认）`);
main();
