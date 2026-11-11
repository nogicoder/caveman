#!/usr/bin/env node
// caveman — pure prose linter behind caveman-gate.js
//
// lint(text, opts?) -> { words, violations }
//   Violation = { rule: 'ceremony' | 'articles' | 'long-sentence', excerpt, detail }
//
// No I/O, no state: the gate decides what to do with the result. The linter
// only reports. It never rewrites text and never touches negations.
//
// What counts as prose: everything left after fenced code, inline code, URLs,
// table rows, headings, blockquotes, double-quoted spans (quoted errors are
// payload), git trailers and the "Generated with" footer are removed. HTML
// (Confluence bodies, Artifact pages) is turned into those same lines first.

const LIMITS = {
  minWords: 25,
  articlesPer100: 4,
  sentenceWords: 20,
  maxSentenceViolations: 3,
  maxArticleExcerpts: 3,
  asciiShare: 0.8,
};

// Phrases from skills/caveman/SKILL.md rule 2. "sure" only opens a sentence:
// "make sure" and "not sure" are plain English, "Sure!" is the ceremony.
const CEREMONY = [
  ['sure', /^\W*sure\b/i],
  ['let me', /\blet me\b/i],
  ["I'll now", /\bI(?:'|’)ll now\b|\bI will now\b/i],
  ["I'm going to", /\bI(?:'|’)m going to\b|\bI am going to\b/i],
  ['happy to', /\bhappy to\b/i],
  ['hope this helps', /\bhope this helps\b/i],
  ['just', /\bjust\b/i],
  ['really', /\breally\b/i],
  ['basically', /\bbasically\b/i],
  ['actually', /\bactually\b/i],
  ['simply', /\bsimply\b/i],
];

const BULLET = /^(?:[-*+]|\d+[.)])\s+/;
const TRAILER = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*:\s+\S/;
const WORD = /[\p{L}\p{N}]/u;

function countWords(text) {
  let n = 0;
  for (const token of text.split(/\s+/)) if (WORD.test(token)) n++;
  return n;
}

function stripFences(lines) {
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) { fence = m[1]; continue; }
    kept.push(line);
  }
  return kept;
}

function dropTrailers(lines) {
  const out = lines.filter((l) => !/^\s*co-authored-by:/i.test(l) && !/\u{1F916}\s*Generated with/u.test(l));
  while (out.length && !out[out.length - 1].trim()) out.pop();
  let start = out.length;
  while (start > 0 && out[start - 1].trim()) start--;
  const last = out.slice(start);
  const hasEarlier = out.slice(0, start).some((l) => l.trim());
  if (hasEarlier && last.length && last.every((l) => TRAILER.test(l.trim()))) return out.slice(0, start);
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

// HTML to the line shapes strip() already knows. Only runs on text with two
// or more tags, so a stray "<sha>" in a commit body stays prose. Code, tables,
// scripts and comments go; headings become "# " lines that strip() drops;
// block ends become line breaks so paragraphs never join into one sentence.
function htmlToText(text) {
  if ((text.match(/<\/?[a-z][\w:-]*[\s>\/]/gi) || []).length < 2) return text;
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<(script|style|pre|code|table|svg)\b[\s\S]*?<\/\1\s*>/gi, '\n')
    .replace(/<ac:structured-macro\b[^>]*ac:name="code"[\s\S]*?<\/ac:structured-macro>/gi, '\n')
    .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi, (m, inner) => '\n# ' + inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') + '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|li|ul|ol|section|blockquote|tr|td|th|details|summary)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, name) => (ENTITIES[name.toLowerCase()] != null ? ENTITIES[name.toLowerCase()]
      : /^#\d+$/.test(name) ? String.fromCodePoint(Number(name.slice(1))) : m))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n');
}

function strip(text) {
  let lines = stripFences(htmlToText(String(text).replace(/\r\n?/g, '\n')).split('\n'));
  lines = dropTrailers(lines).filter((l) => !/^\s{0,3}#{1,6}(\s|$)/.test(l) && !/^\s*>/.test(l) && !/^\s*\|/.test(l));
  return lines.join('\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)\S+/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ');
}

const ABBREVIATION = /\b(e\.g|i\.e|vs|etc|cf|approx)\./gi;

const LABEL = /^([^.!?;:]{1,40}?:(?:\*\*|__)?)\s+(?=\S)/;

// A sentence ends at . ! ? (plus closing emphasis or quote marks) or at a
// semicolon, which joins independent clauses. A short "Label:" opening a
// sentence is its own unit, so "Verdict: ..." and "- **Scope:** ..." measure
// the content, not the content plus its heading.
function splitLine(line) {
  const pieces = line
    .replace(ABBREVIATION, (m) => m.replace(/\./g, '\u0001'))
    .split(/(?<=[.!?][*_)"'\]]*|;)\s+/)
    .map((p) => p.replace(/\u0001/g, '.').trim())
    .filter(Boolean);
  const out = [];
  for (const piece of pieces) {
    const m = LABEL.exec(piece);
    if (m && countWords(m[1]) <= 3) out.push(m[1], piece.slice(m[0].length));
    else out.push(piece);
  }
  return out;
}

// Bullets and numbered items each start a sentence. A hard-wrapped line that
// continues in lowercase joins the line above, so a 72-column commit body is
// measured as the prose it is, not as one sentence per row.
function splitSentences(text) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) out.push(...splitLine(buf));
    buf = '';
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = BULLET.test(line);
    const body = line.replace(BULLET, '');
    if (buf && !bullet && /^[a-z]/.test(body) && !/[.!?:;]$/.test(buf.trimEnd())) {
      buf += ' ' + body;
    } else {
      flush();
      buf = body;
    }
  }
  flush();
  return out;
}

function clip(s, max) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function asciiShare(text) {
  const letters = text.match(/\p{L}/gu);
  if (!letters) return 1;
  let ascii = 0;
  for (const c of letters) if (c < '\u0080') ascii++;
  return ascii / letters.length;
}

function countArticles(sentence) {
  return (sentence.match(/\b(?:a|an|the)\b/gi) || []).length;
}

function lint(text, opts) {
  const limits = { ...LIMITS, ...((opts && opts.limits) || {}) };
  const prose = strip(text);
  const words = countWords(prose);
  const violations = [];
  if (words === 0 || asciiShare(prose) < limits.asciiShare) return { words, violations };

  const sentences = splitSentences(prose);

  for (const [phrase, re] of CEREMONY) {
    const hit = sentences.find((s) => re.test(s));
    if (hit) violations.push({ rule: 'ceremony', excerpt: clip(hit, 100), detail: `ceremony phrase "${phrase}"` });
  }

  let longCount = 0;
  for (const s of sentences) {
    const n = countWords(s);
    if (n <= limits.sentenceWords) continue;
    if (longCount++ >= limits.maxSentenceViolations) break;
    violations.push({ rule: 'long-sentence', excerpt: clip(s, 110), detail: `${n} words (limit ${limits.sentenceWords})` });
  }

  // Article density needs a sample: a one-line reply with two "the" is not a
  // trend. A single overlong sentence is a breach at any length.
  if (words < limits.minWords) return { words, violations };

  const articles = sentences.reduce((n, s) => n + countArticles(s), 0);
  const rate = (articles / words) * 100;
  if (rate > limits.articlesPer100) {
    const worst = sentences
      .map((s, i) => ({ s, i, n: countArticles(s) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .slice(0, limits.maxArticleExcerpts)
      .sort((a, b) => a.i - b.i)
      .map((x) => clip(x.s, 90));
    violations.push({
      rule: 'articles',
      excerpt: worst.join(' | '),
      detail: `${articles} a/an/the in ${words} words, ${rate.toFixed(1)} per 100 (limit ${limits.articlesPer100})`,
    });
  }

  return { words, violations };
}

module.exports = { lint, strip, htmlToText, splitSentences, countWords, LIMITS };
