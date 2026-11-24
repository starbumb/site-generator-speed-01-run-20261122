// Fast drop-in for makefun-site 1.0.0: run(input) returns the same output tree, byte for byte.
// Written from the reference semantics (front matter, Markdown subset, template dialect, slug
// rule, build report) with hot paths optimised: single-pass Markdown rendering, bulk inline
// escaping, cached slugs/dates, and templates compiled to functions.

const SLUG_MAX = 64;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

const ESC_TEST = /[&<>"']/;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

function slugRaw(text) {
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) { ascii = false; break; }
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (!ascii) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    gap = false;
    for (let i = 0; i < plain.length; i++) {
      const code = plain.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  }
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
    while (out.endsWith('-')) out = out.slice(0, -1);
  }
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDateRaw(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  if (nl0 === -1) return { error: 'the front matter is not closed' };
  const headLines = [];
  let pos = nl0 + 1;
  let bodyStart = -1;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    headLines.push(line);
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
  }
  const data = {};
  for (let k = 0; k < headLines.length; k++) {
    const line = headLines[k];
    if (FM_BLANK.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: 'line ' + (k + 2) + ' is not "key: value"' };
    const key = m[1];
    let raw = m[2] ?? '';
    let e = raw.length;
    while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HAS_WS = /\s/;

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line[0];
  if (c === ' ' || c === '\t') return isBlank(line);
  if (c === '`') return FENCE_OPEN.test(line);
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return HR.test(line);
  return false;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  let start = 0;
  for (let i = 0; i <= rel.length; i++) {
    if (i !== rel.length && rel[i] !== '/') continue;
    const seg = rel.slice(start, i);
    start = i + 1;
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function linkHref(ctx, target) {
  if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(ctx.dirParts, rel);
  if (path !== null) {
    const hit = ctx.bySource.get(path);
    if (hit !== undefined) return hit.url + frag;
    if (ctx.staticPaths.has(path)) return ctx.base + '/' + path + frag;
  }
  ctx.broken.add('broken-link ' + ctx.sourcePath + ' -> ' + target);
  return target;
}

const INLINE_SPECIAL = /[\\`*[]/g;
const ESCAPABLE_CHAR = /[&<>"']/;

function inline(s, ctx) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const hit = INLINE_SPECIAL.exec(s);
    const j = hit === null ? n : hit.index;
    if (j > i) { const chunk = s.slice(i, j); out += ESCAPABLE_CHAR.test(chunk) ? esc(chunk) : chunk; i = j; continue; }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) { out += esc(s[i + 1]); i += 2; }
      else { out += '\\'; i++; }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) { out += '<code>' + esc(s.slice(i + 1, k)) + '</code>'; i = k + 1; }
      else { out += '`'; i++; }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) { out += '<strong>' + inline(s.slice(i + 2, k), ctx) + '</strong>'; i = k + 2; }
        else { out += '**'; i += 2; }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) { out += '<em>' + inline(s.slice(i + 1, k), ctx) + '</em>'; i = k + 1; }
        else { out += '*'; i++; }
      }
      continue;
    }
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !HAS_WS.test(target)) {
      out += '<a href="' + esc(linkHref(ctx, target)) + '">' + inline(s.slice(i + 1, k), ctx) + '</a>';
      i = m + 1;
    } else { out += '['; i++; }
  }
  return out;
}

function renderMarkdown(src, ctx, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    const c0 = line[0];
    if (c0 === undefined || ((c0 === ' ' || c0 === '\t') && isBlank(line))) { i++; continue; }
    if (c0 === '`') {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        const bodyLines = [];
        i++;
        while (i < total && !FENCE_CLOSE.test(lines[i])) { bodyLines.push(esc(lines[i])); i++; }
        i++;
        const cls = lang === '' ? '' : ' class="language-' + esc(lang) + '"';
        blocks.push('<pre><code' + cls + '>' + (bodyLines.length === 0 ? '' : bodyLines.join('\n') + '\n') + '</code></pre>');
        continue;
      }
    } else if (c0 === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, ctx);
        blocks.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '>') {
      const kept = [];
      while (i < total && lines[i][0] === '>') {
        let l = lines[i].slice(1);
        if (l.startsWith(' ')) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') kept.push(l);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(kept.join('\n'), ctx) + '</p>\n</blockquote>');
      continue;
    } else if (c0 === '-' || c0 === '*') {
      if (HR.test(line)) { blocks.push('<hr>'); i++; continue; }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < total) {
          const m = BULLET.exec(lines[i]);
          if (m !== null) { items.push([trimLine(m[1])]); i++; }
          else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        let html = '<ul>\n';
        for (const parts of items) html += '<li>' + inline(parts.join('\n'), ctx) + '</li>\n';
        blocks.push(html + '</ul>');
        continue;
      }
    } else if (c0 >= '0' && c0 <= '9') {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        const start = Number(ordered[1]);
        const items = [];
        while (i < total) {
          const m = ORDERED.exec(lines[i]);
          if (m !== null) { items.push([trimLine(m[2])]); i++; }
          else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        let html = (start !== 1 ? '<ol start="' + start + '">' : '<ol>') + '\n';
        for (const parts of items) html += '<li>' + inline(parts.join('\n'), ctx) + '</li>\n';
        blocks.push(html + '</ol>');
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) { body.push(trimLine(lines[i])); i++; }
    const html = inline(body.join('\n'), ctx);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const T_SPACES = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = T_SPACES.test(src.slice(lineStart, open)) && T_SPACES.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

const HELPERS = { tx: textOf, es: esc };

function compileTemplate(nodes) {
  let counter = 0;
  // Emit statements resolving `path` from `scopeVar` into a fresh temp; returns the temp name.
  const resolve = (path, scopeVar, out) => {
    const id = counter++;
    const q = 'q' + id;
    const w = 'w' + id;
    out.push('let ' + q + '=undefined;{let ' + w + '=' + scopeVar + ';while(' + w + '!==null&&!Object.hasOwn(' + w + '.vars,' + JSON.stringify(path[0]) + '))' + w + '=' + w + '.parent;if(' + w + '!==null){' + q + '=' + w + '.vars[' + JSON.stringify(path[0]) + '];');
    for (let k = 1; k < path.length; k++) {
      const key = JSON.stringify(path[k]);
      out.push('if(' + q + '!==null&&typeof ' + q + '==="object"&&Object.hasOwn(' + q + ',' + key + '))' + q + '=' + q + '[' + key + '];else ' + q + '=undefined;');
    }
    out.push('}}');
    return q;
  };
  const truthyOf = (q) => '(Array.isArray(' + q + ')?' + q + '.length>0:' + q + '!==undefined&&' + q + '!==null&&' + q + '!==false&&' + q + '!==""&&' + q + '!==0)';
  const gen = (list, scopeVar, out) => {
    for (const n of list) {
      if (n.kind === 'text') out.push('O.push(' + JSON.stringify(n.text) + ');');
      else if (n.kind === 'var') {
        const q = resolve(n.path, scopeVar, out);
        out.push('O.push(H.es(typeof ' + q + '==="string"?' + q + ':H.tx(' + q + ')));');
      } else if (n.kind === 'raw') {
        const q = resolve(n.path, scopeVar, out);
        out.push('O.push(typeof ' + q + '==="string"?' + q + ':H.tx(' + q + '));');
      } else if (n.kind === 'if') {
        const q = resolve(n.path, scopeVar, out);
        out.push('if(' + (n.not ? '!' : '') + truthyOf(q) + '){');
        gen(n.then, scopeVar, out);
        if (n.else !== null) { out.push('}else{'); gen(n.else, scopeVar, out); }
        out.push('}');
      } else if (n.kind === 'for') {
        const xs = resolve(n.path, scopeVar, out);
        const id = counter++;
        const kk = 'k' + id;
        const vv = 'v' + id;
        const ss = 's' + id;
        out.push('if(Array.isArray(' + xs + ')){for(let ' + kk + '=0;' + kk + '<' + xs + '.length;' + kk + '++){const ' + vv + '={};' + vv + '[' + JSON.stringify(n.name) + ']=' + xs + '[' + kk + '];' + vv + '.loop={index:' + kk + '+1,first:' + kk + '===0,last:' + kk + '===' + xs + '.length-1,length:' + xs + '.length};const ' + ss + '={vars:' + vv + ',parent:' + scopeVar + '};');
        gen(n.body, ss, out);
        out.push('}}');
      } else if (n.kind === 'include') {
        const id = counter++;
        out.push('{const t' + id + '=C.templates.get(' + JSON.stringify(n.name) + ');if(t' + id + '!==undefined&&D<' + INCLUDE_DEPTH + ')t' + id + '(' + scopeVar + ',C,D+1,O);}');
      }
    }
  };
  const parts = [];
  gen(nodes, 'S', parts);
  const factory = new Function('H', 'return function(S,C,D,O){' + parts.join('') + '}');
  return factory(HELPERS);
}

// ---------------------------------------------------------------- build

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

function wordsOf(text) {
  // The reference counts runs of non-whitespace; its whitespace set is space, \t-\r
  // and the Unicode spaces checked below (the same set JavaScript's \s matches).
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32 || (code >= 9 && code <= 13)) { inWord = false; continue; }
    if (code >= 160 &&
      (code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 ||
       code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279)) { inWord = false; continue; }
    if (!inWord) { inWord = true; count++; }
  }
  return count;
}

export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) { v = slugRaw(text); slugCache.set(text, v); }
    return v;
  };
  const dateCache = new Map();
  const longDate = (date) => {
    let v = dateCache.get(date);
    if (v === undefined) { v = longDateRaw(date); dateCache.set(date, v); }
    return v;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();
  const output = {};

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const rawSources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) rawSources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  const sources = [];
  for (const s of rawSources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    sources.push(s);
  }

  const bySource = new Map();
  const taken = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  for (const s of sources) {
    const dir = dirOf(s.path);
    const ctx = { dirParts: dir === '' ? [] : dir.split('/'), sourcePath: s.path, bySource, staticPaths, base, broken };
    const md = renderMarkdown(s.body, ctx, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const ownTags = (s) => {
    const list = s.data.tags ?? [];
    if (list.length === 0) return list;
    const seen = new Set();
    const out = [];
    for (const name of list) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  for (const t of tags) t.cardTag = { name: t.name, slug: t.slug, url: t.url };

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.cardTag ?? { name: t.name, slug: t.slug, url: t.url }),
  });

  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars, parent: null }, ctx, 0, out);
    return out.join('');
  };

  for (const s of sources) output[s.outDir + '/index.html'] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      site, tags: allTags, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { site, tags: allTags, recent, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageTotal = 0;
  for (const s of sources) if (!s.post) pageTotal++;
  lines.push('built ' + pageTotal + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
