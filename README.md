# AI 划词翻译（Chrome MV3）

选中文字或悬停段落后按一下 <kbd>Ctrl</kbd>，用任意 OpenAI 兼容模型翻译成中文。

## 功能

- **划词翻译**：选中非中文单词/句子 → 按 <kbd>Ctrl</kbd> → 选区下方弹出译文气泡（Shadow DOM 隔离，不受页面样式影响）。
- **按语境查词**：选中的若是 5 个词以内的词/短语，会自动带上它**所在的那一句**一起发给模型，只返回该词在此语境下的释义（如 river *bank* → 河岸，而不是银行）。同一个词在段落里出现多次也能定位到正确的句子。
- **加载动画**：等待时显示三点跳动，段落内插的动画颜色继承原文（`currentColor`），不突兀。
- **段落翻译**：不选中任何文字，鼠标悬停在段落上 → 按 <kbd>Ctrl</kbd> → 在原段落下方插入译文，复用原段落的标签、class 与内联样式，视觉上与原文一致；再按一次收起。列表项 `<li>` 和表格单元格 `<td>/<th>` 的译文插在元素**内部**，不会打乱 `<ol>` 的编号或表格的列结构。
- 触发键为「单独按下并松开」，`Ctrl+C` 等组合键不会误触发；<kbd>Esc</kbd>、点击、滚动关闭气泡（并中止正在进行的请求）。
- **流式输出**：译文边生成边显示，不用等整段跑完。
- **关闭思考**：按 Base URL / 模型名自动下发对应服务商的「禁用思考」参数，端点不认就自动去掉重试一次并记住。
- 已经是中文的内容自动跳过；同一段文本结果会缓存，避免重复计费。
- **并发上限 10**：同时进行的翻译请求最多 10 个，已满时新任务直接拒绝并提示（命中缓存不占名额，请求结束或被中止立即归还）。

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本目录。
3. 点击工具栏图标，填写接口地址 / 密钥 / 模型，点「测试连接」——成功会显示耗时和一句样例译文（绿色），失败会显示服务端返回的原始错误（红色）。

## 配置

| 项 | 说明 | 示例 |
| --- | --- | --- |
| Base URL | OpenAI 兼容端点，插件会追加 `/chat/completions` | `https://api.openai.com/v1`、`https://api.deepseek.com/v1`、`http://localhost:11434/v1` |
| API Key | Bearer Token | `sk-...` |
| 模型 | 模型名 | `gpt-4o-mini`、`deepseek-chat`、`qwen-plus` |
| 目标语言 | 翻译目标 | `简体中文` |
| 触发键 | Ctrl / Alt / Shift | `Ctrl` |
| 关闭模型思考 | 勾选后按下表自动下发禁用思考参数 | 默认开启 |
| 额外请求参数 | 合并进请求体的 JSON，用于覆盖上面的自动判断 | `{"reasoning_effort":"none"}` |

### 「关闭思考」自动匹配规则

| Base URL / 模型 命中 | 下发参数 |
| --- | --- |
| `openrouter` | `{"reasoning":{"enabled":false}}` |
| `localhost` / `127.0.0.1` / `ollama` / `vllm` / `lmstudio` | `{"think":false,"chat_template_kwargs":{"enable_thinking":false}}` |
| `qwen` / `dashscope` / `aliyuncs` | `{"enable_thinking":false}` |
| `glm` / `zhipu` / `bigmodel` / `kimi` / `moonshot` / `minimax` | `{"thinking":{"type":"disabled"}}` |
| `gpt-5.1+` | `{"reasoning_effort":"none"}` |
| `gpt-5` / `o1`–`o9` / `grok` | `{"reasoning_effort":"minimal"}` |
| 其他（如 `gpt-4o`、`deepseek-chat`、`claude-*`） | 不传（这些模型默认就不思考） |

匹配不准时，在「额外请求参数」里手填即可覆盖。

配置保存在 `chrome.storage.local`（仅本机，不会同步到 Google 账号）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | MV3 清单 |
| `background.js` | Service Worker：读配置、调用模型、缓存结果 |
| `content.js` | 触发键监听、气泡渲染、段落译文插入 |
| `options.html/js` | 设置页（同时作为工具栏弹窗） |
