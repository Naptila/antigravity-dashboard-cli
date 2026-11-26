// @ts-check

/**
 * @typedef {{ text: string, code: number, bold: boolean, dim: boolean }} StyledPart
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Splits a string into user-perceived grapheme clusters.
 * @param {string} text
 * @returns {string[]}
 */
export function graphemeClusters(text) {
  if (!text) return [];
  return [...segmenter.segment(String(text))].map(item => item.segment);
}

/**
 * Computes terminal column width (0, 1, or 2 cells) for a single grapheme cluster.
 * @param {string} cluster
 * @returns {number}
 */
function cellWidth(cluster) {
  if (/^\p{Mark}+$/u.test(cluster)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(cluster)) return 2;
  const code = cluster.codePointAt(0) ?? 0;
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

/**
 * Computes terminal display width of a plain text string.
 * @param {string} text
 * @returns {number}
 */
export function displayWidth(text) {
  let sum = 0;
  for (const cluster of graphemeClusters(text)) {
    sum += cellWidth(cluster);
  }
  return sum;
}

/**
 * Truncates text to fit within `maxWidth` terminal cells, appending `…` when clipped.
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string}
 */
export function truncateDisplay(text, maxWidth) {
  const str = String(text ?? '');
  if (maxWidth <= 0) return '';
  if (displayWidth(str) <= maxWidth) return str;
  if (maxWidth === 1) return '…';

  let out = '';
  let used = 0;
  for (const cluster of graphemeClusters(str)) {
    const w = cellWidth(cluster);
    if (used + w > maxWidth - 1) break;
    out += cluster;
    used += w;
  }
  return out + '…';
}

/**
 * Right-pads `text` with spaces to reach `width` terminal display cells.
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function padEndDisplay(text, width) {
  const str = String(text ?? '');
  const diff = width - displayWidth(str);
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

/**
 * Left-pads `text` with spaces to reach `width` terminal display cells.
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function padStartDisplay(text, width) {
  const str = String(text ?? '');
  const diff = width - displayWidth(str);
  return diff > 0 ? ' '.repeat(diff) + str : str;
}

/**
 * Wraps plain text across lines without exceeding `maxWidth` display cells,
 * preferring whitespace boundaries before falling back to grapheme boundaries.
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function wrapDisplayText(text, maxWidth) {
  const str = String(text ?? '').trim();
  if (!str || maxWidth <= 0) return [];
  if (displayWidth(str) <= maxWidth) return [str];

  const tokens = str.match(/\S+|\s+/g) || [str];
  const lines = [];
  let current = '';
  let currentWidth = 0;

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (current && currentWidth + 1 <= maxWidth) {
        current += ' ';
        currentWidth += 1;
      }
      continue;
    }

    const tokenWidth = displayWidth(token);
    if (currentWidth === 0 && tokenWidth <= maxWidth) {
      current = token;
      currentWidth = tokenWidth;
      continue;
    }

    if (currentWidth > 0 && currentWidth + tokenWidth <= maxWidth) {
      current += token;
      currentWidth += tokenWidth;
      continue;
    }

    if (current.trimEnd()) {
      lines.push(current.trimEnd());
      current = '';
      currentWidth = 0;
    }

    if (tokenWidth <= maxWidth) {
      current = token;
      currentWidth = tokenWidth;
      continue;
    }

    for (const cluster of graphemeClusters(token)) {
      const w = cellWidth(cluster);
      if (currentWidth + w > maxWidth && current) {
        lines.push(current);
        current = cluster;
        currentWidth = w;
      } else {
        current += cluster;
        currentWidth += w;
      }
    }
  }

  if (current.trimEnd()) {
    lines.push(current.trimEnd());
  }
  return lines;
}

/**
 * Strips ANSI escape sequences, control characters, and directional overrides.
 * @param {unknown} value
 * @param {number} [limit=120]
 * @returns {string}
 */
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

/**
 * @param {string} text
 * @param {number} [code=39]
 * @param {boolean} [bold=false]
 * @param {boolean} [dim=false]
 * @returns {StyledPart}
 */
export function part(text, code = 39, bold = false, dim = false) {
  return { text, code, bold, dim };
}

/**
 * @param {string} text
 * @returns {StyledPart}
 */
export function subtle(text) {
  return part(text, 39, false, true);
}

/**
 * @param {StyledPart[]} parts
 * @returns {string}
 */
export function plainText(parts) {
  return parts.map(item => item.text).join('');
}

/**
 * Truncates a sequence of styled parts to `maxWidth` terminal columns.
 * @param {StyledPart[]} parts
 * @param {number} maxWidth
 * @returns {StyledPart[]}
 */
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

/**
 * Renders styled parts within `maxWidth`, optionally emitting SGR ANSI color sequences.
 * @param {StyledPart[]} parts
 * @param {number} maxWidth
 * @param {boolean} [color=true]
 * @returns {string}
 */
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

/**
 * Honors `--no-color`, `NO_COLOR`, and `TERM=dumb`.
 * @param {boolean} [noColorFlag=false]
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function shouldUseColor(noColorFlag = false, env = process.env) {
  return !noColorFlag && !Object.hasOwn(env || {}, 'NO_COLOR') && env?.TERM !== 'dumb';
}
