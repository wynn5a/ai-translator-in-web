/* ================= 单词发音的播放端 =================

   音频不能在内容脚本里播：媒体加载受宿主页面的 CSP `media-src` 管，
   GitHub、Jira 这类站点会把 data: / blob: 全拦掉。这个页面是扩展自己的
   文档，用扩展的 CSP，也不受站点样式和脚本影响。

   offscreen 文档开着就会一直吊住 Service Worker，所以播完要主动关掉。 */

const IDLE_CLOSE = 10_000; // 播完再留一会儿：连点同一个词不必重开文档

const audio = new Audio();
let objectUrl = ''; // 正在播的那份音频
let closeTimer;

function idle() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => window.close(), IDLE_CLOSE);
}

function revoke() {
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrl = '';
}

// 播完（或解码失败）就放掉 blob，并开始计时关闭文档
audio.onended = audio.onerror = () => (revoke(), idle());

async function play(url) {
  clearTimeout(closeTimer);
  audio.pause();
  revoke();
  // 先 fetch：扩展页带着 host_permissions，不走 CORS（内容脚本里会被拦），
  // 而且拿得到状态码，能把「限流」和「挂了」分开说。
  // 请求本身发不出去时退回直接让 <audio> 去载 —— 媒体加载不受 CORS 限制。
  let res;
  try {
    res = await fetch(url);
  } catch {
    audio.src = url;
    return audio.play();
  }
  if (!res.ok) throw new Error(res.status === 429 ? '发音请求过于频繁，稍后再试' : '发音服务暂时不可用');
  objectUrl = URL.createObjectURL(await res.blob());
  audio.src = objectUrl;
  await audio.play(); // AUDIO_PLAYBACK 用途的 offscreen 文档不受自动播放限制
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'play') return false;
  play(msg.url).then(
    () => sendResponse({ ok: true }),
    (e) => (revoke(), idle(), sendResponse({ error: e.message }))
  );
  return true;
});

idle(); // 建好却没等到消息（发送方中途出错）时不把文档留在后台
