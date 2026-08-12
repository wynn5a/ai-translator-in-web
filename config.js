/* ================= 配置模型 =================

   AI 配置按 profile 组织：一个 profile 就是一套「接口地址 + 密钥 + 模型 + 目标语言」，
   可以随时切换。触发键和站点开关是全局的，不随 profile 变。

   存储结构（chrome.storage.local）：
     profiles         [{ id, name, baseUrl, apiKey, model, targetLang, noThink, glossary, extraBody }]
     activeProfileId  当前生效的 profile id
     hotkey           触发键
     disabledHosts    停用的域名
     __cache          译文缓存（见 background.js）
     __glossary       术语表，按「站点 + 目标语言」分组（见 background.js）

   本文件在后台、内容脚本、设置页三处都以普通脚本加载，只向全局暴露下面这些名字。 */

const PROFILE_FIELDS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  noThink: true,
  glossary: true,
  extraBody: '',
};

const GLOBAL_FIELDS = {
  hotkey: 'Control',
  disabledHosts: [],
};

// 首个 profile 用固定 id：多个上下文同时迁移旧配置时结果也一致，不会各造一个
const FIRST_PROFILE_ID = 'default';

const CONFIG_QUERY = { profiles: null, activeProfileId: '', ...PROFILE_FIELDS, ...GLOBAL_FIELDS };

const newProfileId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const pick = (src, shape) =>
  Object.fromEntries(Object.keys(shape).map((k) => [k, src?.[k] ?? shape[k]]));

/** 从存储原样还原出 { profiles, active, hotkey, disabledHosts }，不写入 */
function resolveConfig(raw) {
  const stored = Array.isArray(raw.profiles) && raw.profiles.length ? raw.profiles : null;
  const profiles = stored
    ? // 补齐缺失字段：早先版本存下的 profile 里没有后来新增的项，读出来时统一填默认值
      stored.map((p) => ({ id: p.id, name: p.name, ...pick(p, PROFILE_FIELDS) }))
    : // 还没有 profile：把旧版的扁平配置（或纯默认值）当作第一个 profile
      [{ id: FIRST_PROFILE_ID, name: '默认', ...pick(raw, PROFILE_FIELDS) }];
  const active = profiles.find((p) => p.id === raw.activeProfileId) || profiles[0];
  return { profiles, active, ...pick(raw, GLOBAL_FIELDS) };
}

/** 只读加载。内容脚本在每个 frame 里都会跑，不能写存储，否则多个 frame 会互相踩 */
async function loadConfig() {
  return resolveConfig(await chrome.storage.local.get(CONFIG_QUERY));
}

/** 加载并把旧版扁平配置固化成第一个 profile；幂等，只在后台和设置页调用 */
async function ensureProfiles() {
  const raw = await chrome.storage.local.get(CONFIG_QUERY);
  const cfg = resolveConfig(raw);
  if (Array.isArray(raw.profiles) && raw.profiles.length) return cfg;
  await chrome.storage.local.set({ profiles: cfg.profiles, activeProfileId: cfg.active.id });
  await chrome.storage.local.remove(Object.keys(PROFILE_FIELDS));
  return cfg;
}
