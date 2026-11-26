const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemeClusters(text) {
  if (!text) return [];
  return [...segmenter.segment(text)].map(item => item.segment);
}

function cellWidth(cluster) {
  if (/^\p{Mark}+$/u.test(cluster)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(cluster)) return 2;
  const code = cluster.codePointAt(0);
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text) {
  let sum = 0;
  for (const cluster of graphemeClusters(text)) {
    sum += cellWidth(cluster);
  }
  return sum;
}

export function cleanText(value, limit = 120) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export function part(text, code = 39, bold = false, dim = false) {
  return { text, code, bold, dim };
}

export function subtle(text) {
  return part(text, 39, false, true);
}

export function plainText(parts) {
  return parts.map(item => item.text).join('');
}

export function fitParts(parts, maxWidth) {
  if (displayWidth(plainText(parts)) <= maxWidth) return parts;
  if (maxWidth <= 0) return [];
  if (maxWidth === 1) return [subtle('…')];
  const result = [];
  let left = maxWidth - 1;
  for (const item of parts) {
    let text = '';
    for (const cluster of graphemeClusters(item.text)) {
      const size = cellWidth(cluster);
      if (size > left) break;
      text += cluster;
      left -= size;
    }
    if (text) result.push({ ...item, text });
    if (text !== item.text) break;
  }
  result.push(subtle('…'));
  return result;
}

export function paintParts(parts, maxWidth, color = true) {
  const fitted = fitParts(parts, maxWidth);
  if (!color) return plainText(fitted);
  return fitted
    .map(item => {
      const prefix = item.bold ? '1;' : item.dim ? '2;' : '';
      return `\x1b[${prefix}${item.code}m${item.text}\x1b[0m`;
    })
    .join('');
}

export function makeBar(value, code, size) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return [];
  const filled = Math.min(size, Math.max(0, Math.round((value / 100) * size)));
  const parts = [];
  if (filled > 0) parts.push(part('█'.repeat(filled), code));
  if (size - filled > 0) parts.push(subtle('░'.repeat(size - filled)));
  return parts;
}

export function isLightBackground(env = process.env) {
  return /(?:^|;)(?:7|15)$/.test(env.COLORFGBG || '');
}

export function shouldUseColor(noColorFlag = false, env = process.env) {
  return !noColorFlag && !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb';
}
