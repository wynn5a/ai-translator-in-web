/* ================= 结构占位标记 =================

   content.js 把网页结构编码成 <bN> / <nN/> / <tN> / <xN/>，
   background.js 再用同一套语法检查完整性并寻找安全分片点。
   模型常会改动空白、斜杠、大小写或尖括号；归一规则必须只有这一份，
   否则后台认为完整的输出可能在页面里无法还原。 */

const MARKER_PATTERN = /<(\/?)([txbn])(\d+)(\/?)>/g;
const MARKER_AT_PATTERN = /<(\/?)([txbn])(\d+)(\/?)>/y;
const HTML_BREAK_PATTERN = /<\s*br\s*\/?\s*>/gi;
const SLOPPY_BREAK_PATTERN = /<+\s*\/?\s*[nN](\d+)\s*\/?\s*>+/g;
const SLOPPY_MARKER_PATTERN = /<+\s*(\/?)\s*([txb])(\d+)\s*(\/?)\s*>+/g;

/**
 * 宽容处理模型写歪的标记。换行标记大小写都认；其余只认小写，
 * 避免把正文里的 List<T1>、Vec<B2> 当成结构标记。
 */
function normalizeMarkers(text) {
  return text
    .replace(HTML_BREAK_PATTERN, '<n0/>')
    .replace(SLOPPY_BREAK_PATTERN, '<n$1/>')
    .replace(SLOPPY_MARKER_PATTERN, (_, close, kind, number, selfClose) => {
      return `<${close}${kind}${number}${selfClose}>`;
    });
}

/** 遍历规范标记；每次返回独立迭代器，不向调用方暴露正则的 lastIndex。 */
function markerMatches(text) {
  return text.matchAll(MARKER_PATTERN);
}

/** 只在指定位置匹配规范标记，供长段落分片扫描使用。 */
function markerAt(text, index) {
  MARKER_AT_PATTERN.lastIndex = index;
  return MARKER_AT_PATTERN.exec(text);
}

function stripMarkers(text) {
  return text.replace(MARKER_PATTERN, '');
}

/**
 * 标记多重集：换行只数数量（渲染不依赖编号），
 * 其余按「斜杠 + 类型 + 编号」计数。
 */
function markerCounts(text) {
  const counts = new Map();
  for (const match of markerMatches(normalizeMarkers(text))) {
    const [, close, kind, number] = match;
    const key = kind === 'n' ? '<n/>' : `<${close}${kind}${number}>`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
