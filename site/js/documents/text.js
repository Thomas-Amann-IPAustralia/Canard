// Plain text and Markdown documents: headings (# ATX or underlined setext), paragraphs
// separated by blank lines, list items kept together, and light removal of Markdown
// syntax so the text reads (and embeds) as prose.

const ATX_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const LIST_RE = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
const RULE_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Remove inline Markdown: links and images keep their text, emphasis and code marks go. */
export function stripInline(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~(.*?)~~/g, '$1');
}

/**
 * Parse text into { title, blocks }. With markdown: false (a .txt file) the text is
 * left as written, but Markdown-style headings are still recognised.
 */
export function parseText(input, { markdown = true, filename = '' } = {}) {
  const lines = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let fence = null;
  let code = [];
  const clean = (s) => (markdown ? stripInline(s) : s);

  const flush = () => {
    if (!para.length) return;
    // List items and table rows keep their own lines; wrapped prose lines are joined.
    let text = '';
    para.forEach((line, i) => {
      if (i > 0) text += LIST_RE.test(line) || line.includes(' | ') ? '\n' : ' ';
      text += line.trim();
    });
    text = clean(text).replace(/[ \t]+/g, ' ').trim();
    if (text) blocks.push({ kind: 'text', text });
    para = [];
  };

  for (const line of lines) {
    if (fence) {
      if (line.trim().startsWith(fence)) {
        if (code.length) blocks.push({ kind: 'text', text: code.join('\n').trim() });
        fence = null;
        code = [];
      } else {
        code.push(line);
      }
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) { flush(); fence = f[1]; continue; }
    if (line.trim() === '') { flush(); continue; }
    const atx = ATX_RE.exec(line);
    if (atx) {
      flush();
      const text = clean(atx[2]).trim();
      if (text) blocks.push({ kind: 'heading', level: atx[1].length, text });
      continue;
    }
    // Setext: a single line underlined with === (level 1) or --- (level 2).
    if (para.length === 1 && /^\s{0,3}(=+|-+)\s*$/.test(line) && !LIST_RE.test(para[0])) {
      const text = clean(para[0]).trim();
      para = [];
      blocks.push({ kind: 'heading', level: line.trim()[0] === '=' ? 1 : 2, text });
      continue;
    }
    if (RULE_RE.test(line)) { flush(); continue; }
    if (markdown && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue; // table divider
    if (!markdown) { para.push(line); continue; }
    const unquoted = line.replace(/^\s*(>\s?)+/, '');
    para.push(unquoted.includes('|') ? unquoted.replace(/^\s*\|\s*|\s*\|\s*$/g, '').replace(/\s*\|\s*/g, ' | ') : unquoted);
  }
  if (fence && code.length) blocks.push({ kind: 'text', text: code.join('\n').trim() });
  flush();

  const first = blocks.find((b) => b.kind === 'heading' && b.level === 1) || blocks.find((b) => b.kind === 'heading');
  return { title: first?.text || titleFromFilename(filename), date: null, blocks };
}

export function titleFromFilename(filename) {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,5}$/i, '');
  return base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled document';
}
