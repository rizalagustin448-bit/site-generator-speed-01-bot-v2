// solve.js — single-pass static site generator (fresh implementation).
// Entry: run(input) -> { outputPath: text } for one case.
// Input: { site: {title, base_url, per_page, recent}, templates: {name: text},
//          files: [{path, content}] }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const FM_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);

function escInto(parts, s, a, b) {
  let start = a;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) parts.push(s.slice(start, i));
      parts.push(rep);
      start = i + 1;
    }
  }
  if (b > start) parts.push(s.slice(start, b));
}

const ESC_RE = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escStr(s) {
  return s.replace(ESC_RE, (ch) => ESC_MAP[ch]);
}

function slugify(s) {
  const n = s.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let dash = false;
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) {
      if (dash && out.length > 0) out += '-';
      out += n[i];
      dash = false;
    } else if (c >= 65 && c <= 90) {
      if (dash && out.length > 0) out += '-';
      out += String.fromCharCode(c + 32);
      dash = false;
    } else {
      dash = true;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

function validDate(ds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return false;
  if (ds < '1970-01-01' || ds > '2099-12-31') return false;
  const y = +ds.slice(0, 4), m = +ds.slice(5, 7), d = +ds.slice(8, 10);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

function dateLong(ds) {
  const y = ds.slice(0, 4), m = +ds.slice(5, 7), d = +ds.slice(8, 10);
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

// ---------- front matter ----------

function parseQuoted(v, key) {
  let out = '';
  for (let i = 1; i < v.length; i++) {
    const ch = v[i];
    if (ch === '\\') {
      const nx = v[i + 1];
      if (nx === '"' || nx === '\\') { out += nx; i++; }
      else return { error: 'key "' + key + '": a quoted string holds an escape other than \\" or \\\\' };
    } else if (ch === '"') {
      if (i !== v.length - 1) return { error: 'key "' + key + '": a quoted string holds a stray quote' };
      return { value: out };
    } else out += ch;
  }
  return { error: 'key "' + key + '": a quoted string is not closed' };
}

function validateKeyValue(key, value) {
  // returns {value} or {error}; value already trailing-trimmed
  if (key === 'title' || key === 'summary') {
    if (value.charCodeAt(0) === 34) return parseQuoted(value, key);
    if (value.charCodeAt(0) === 91) return { error: 'key "' + key + '": a bare string opens on [' };
    return { value };
  }
  if (key === 'date') {
    if (!validDate(value)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value };
  }
  if (key === 'tags') {
    if (value.length < 2 || value.charCodeAt(0) !== 91 || value.charCodeAt(value.length - 1) !== 93) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = value.slice(1, -1);
    if (inner === '') return { value: [] };
    const items = inner.split(',');
    const tags = [];
    for (let it of items) {
      it = it.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      if (it === '' || it.indexOf('"') !== -1 || it.indexOf('[') !== -1 || it.indexOf(']') !== -1) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      tags.push(it);
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (value === 'true') return { value: true };
    if (value === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (!/^[a-z0-9-]+$/.test(value)) return { error: 'key "layout": not a template name' };
    return { value };
  }
  if (key === 'slug') {
    if (value.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) return { error: 'key "slug": not a slug' };
    return { value };
  }
  return { value };
}

function parseFrontMatter(lines, closeIdx) {
  // lines[0] === '---', lines[closeIdx] === '---'; returns {fm} or {error}
  const fm = {};
  const seen = new Set();
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    const n = i + 1;
    if (line.trim() === '') continue;
    if (line.charCodeAt(0) === 35) continue; // # comment
    const m = /^([a-z_]+):(?: (.*)|)$/.exec(line);
    if (!m) return { error: 'line ' + n + ' is not "key: value"' };
    const key = m[1];
    if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (seen.has(key)) return { error: 'key "' + key + '" is given twice' };
    seen.add(key);
    const value = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
    if (value === '') return { error: 'key "' + key + '" has no value' };
    const r = validateKeyValue(key, value);
    if (r.error) return { error: r.error };
    fm[key] = r.value;
  }
  if (fm.title === undefined) return { error: 'no title' };
  return { fm };
}

// ---------- templates ----------
// Node types: 0 text, 1 escaped var, 2 raw var, 3 for, 4 if, 5 include.

function isPath(s) {
  return /^[_A-Za-z][_A-Za-z0-9]*(\.[_A-Za-z][_A-Za-z0-9]*)*$/.test(s);
}

function parseTemplate(text) {
  let pos = 0;
  const L = text.length;

  function standalone(segStart, ni, end) {
    const pend = text.slice(segStart, ni);
    const lastNl = pend.lastIndexOf('\n');
    const head = lastNl === -1 ? pend : pend.slice(lastNl + 1);
    if (!/^[ \t]*$/.test(head)) return { textEnd: ni, nextPos: end + 2 };
    const after = text.slice(end + 2);
    const nlIdx = after.indexOf('\n');
    const tail = nlIdx === -1 ? after : after.slice(0, nlIdx);
    if (!/^[ \t]*$/.test(tail)) return { textEnd: ni, nextPos: end + 2 };
    return {
      textEnd: lastNl === -1 ? segStart : segStart + lastNl + 1,
      nextPos: nlIdx === -1 ? L : end + 2 + nlIdx + 1,
    };
  }

  function parseSeq(stop) {
    const nodes = [];
    let segStart = pos;
    const flushTo = (endIdx) => {
      if (endIdx > segStart) nodes.push({ t: 0, s: text.slice(segStart, endIdx) });
    };
    while (pos < L) {
      const b3 = text.indexOf('{{{', pos);
      const b2 = text.indexOf('{{', pos);
      const bt = text.indexOf('{%', pos);
      let ni = -1, nk = 0;
      if (b3 !== -1) { ni = b3; nk = 3; }
      if (b2 !== -1 && (ni === -1 || b2 < ni)) { ni = b2; nk = 2; }
      if (bt !== -1 && (ni === -1 || bt < ni)) { ni = bt; nk = 1; }
      if (ni === -1) { pos = L; break; }
      if (nk === 3 || nk === 2) {
        const close = nk === 3 ? '}}}' : '}}';
        const end = text.indexOf(close, ni + nk);
        if (end === -1) return { error: nk === 3 ? 'a {{{ is not closed' : 'a {{ is not closed' };
        const inner = text.slice(ni + nk, end).trim();
        if (!isPath(inner)) return { error: '"' + inner + '" is not a path' };
        flushTo(ni);
        nodes.push({ t: nk === 3 ? 2 : 1, p: inner.split('.') });
        pos = end + nk;
        segStart = pos;
        continue;
      }
      const end = text.indexOf('%}', ni + 2);
      if (end === -1) return { error: 'a {% is not closed' };
      const inner = text.slice(ni + 2, end).trim();
      let m;
      if ((m = /^for\s+([_A-Za-z][_A-Za-z0-9_]*)\s+in\s+(.+)$/.exec(inner))) {
        const pth = m[2].trim();
        if (!isPath(pth)) return { error: '"' + pth + '" is not a path' };
        const st = standalone(segStart, ni, end);
        flushTo(st.textEnd);
        pos = st.nextPos;
        const bodyRes = parseSeq(2);
        if (bodyRes.error) return bodyRes;
        if (bodyRes.term === null) return { error: 'a for is not closed' };
        if (bodyRes.term !== 'endfor') {
          return { error: bodyRes.term === 'else' ? 'an else with no open if' : 'an endif with no open if' };
        }
        nodes.push({ t: 3, v: m[1], p: pth.split('.'), body: bodyRes.nodes });
        segStart = pos;
      } else if (inner === 'for' || inner.startsWith('for ') || inner.startsWith('for\t')) {
        return { error: '{% ' + inner + ' %} is not a tag' };
      } else if ((m = /^if\s+(not\s+)?(.+)$/.exec(inner))) {
        const pth = m[2].trim();
        if (!isPath(pth)) return { error: '"' + pth + '" is not a path' };
        const st = standalone(segStart, ni, end);
        flushTo(st.textEnd);
        pos = st.nextPos;
        const thenRes = parseSeq(1);
        if (thenRes.error) return thenRes;
        if (thenRes.term === null) return { error: 'an if is not closed' };
        if (thenRes.term === 'endfor') return { error: 'an endfor with no open for' };
        let els = null;
        if (thenRes.term === 'else') {
          const elseRes = parseSeq(1);
          if (elseRes.error) return elseRes;
          if (elseRes.term === null) return { error: 'an if is not closed' };
          if (elseRes.term === 'else') return { error: 'an else with no open if' };
          if (elseRes.term === 'endfor') return { error: 'an endfor with no open for' };
          els = elseRes.nodes;
        }
        nodes.push({ t: 4, p: pth.split('.'), neg: !!m[1], then: thenRes.nodes, els });
        segStart = pos;
      } else if (inner === 'if' || inner.startsWith('if ') || inner.startsWith('if\t')) {
        return { error: '{% ' + inner + ' %} is not a tag' };
      } else if (inner === 'else' || inner === 'endif' || inner === 'endfor') {
        if (stop === 0) {
          return { error: inner === 'else' ? 'an else with no open if' : inner === 'endif' ? 'an endif with no open if' : 'an endfor with no open for' };
        }
        const st = standalone(segStart, ni, end);
        flushTo(st.textEnd);
        pos = st.nextPos;
        segStart = pos;
        return { nodes, term: inner };
      } else if ((m = /^include\s+"([^"]*)"$/.exec(inner))) {
        const st = standalone(segStart, ni, end);
        flushTo(st.textEnd);
        nodes.push({ t: 5, name: m[1] });
        pos = st.nextPos;
        segStart = pos;
      } else {
        return { error: '{% ' + inner + ' %} is not a tag' };
      }
    }
    flushTo(L);
    return { nodes, term: null };
  }

  const r = parseSeq(0);
  if (r.error) return { error: r.error };
  return { nodes: r.nodes };
}

function resolvePath(segs, scopes) {
  let v;
  let found = false;
  for (let s = scopes.length - 1; s >= 0; s--) {
    const sc = scopes[s];
    v = sc[segs[0]];
    if (v !== undefined) { found = true; break; }
  }
  if (!found) return undefined;
  for (let i = 1; i < segs.length; i++) {
    if (v === null || v === undefined) return undefined;
    v = v[segs[i]];
  }
  return v;
}

function truthy(v) {
  if (v === undefined || v === null || v === false) return false;
  if (v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function stringifyValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += stringifyValue(v[i]);
    }
    return out;
  }
  return '';
}

// Static analysis: does a template's rendering depend only on case-global
// values (site, tags, recent)? If so, its output is identical on every page
// of the case and can be cached. Returns {ok, edges} where edges = longest
// include chain below the template (for the depth-8 include limit).
const STATIC_GLOBALS = new Set(['site', 'tags', 'recent']);
function analyzeStatic(nodes, tpls, statics, visiting, memo) {
  let edges = 0;
  for (let n = 0; n < nodes.length; n++) {
    const nd = nodes[n];
    if (nd.t === 0) continue;
    if (nd.t === 1 || nd.t === 2) {
      if (!statics.has(nd.p[0])) return { ok: false, edges: 0 };
      continue;
    }
    if (nd.t === 3) {
      if (!statics.has(nd.p[0])) return { ok: false, edges: 0 };
      const inner = new Set(statics);
      inner.add(nd.v);
      inner.add('loop');
      const r = analyzeStatic(nd.body, tpls, inner, visiting, memo);
      if (!r.ok) return { ok: false, edges: 0 };
      if (r.edges > edges) edges = r.edges;
      continue;
    }
    if (nd.t === 4) {
      if (!statics.has(nd.p[0])) return { ok: false, edges: 0 };
      const r1 = analyzeStatic(nd.then, tpls, statics, visiting, memo);
      if (!r1.ok) return { ok: false, edges: 0 };
      if (r1.edges > edges) edges = r1.edges;
      if (nd.els) {
        const r2 = analyzeStatic(nd.els, tpls, statics, visiting, memo);
        if (!r2.ok) return { ok: false, edges: 0 };
        if (r2.edges > edges) edges = r2.edges;
      }
      continue;
    }
    if (nd.t === 5) {
      const sub = tpls.get(nd.name);
      if (!sub) continue;
      if (visiting.has(nd.name)) return { ok: false, edges: 0 };
      let r = memo.get(nd.name);
      if (!r) {
        visiting.add(nd.name);
        r = analyzeStatic(sub, tpls, STATIC_GLOBALS, visiting, memo);
        visiting.delete(nd.name);
        memo.set(nd.name, r);
      }
      if (!r.ok) return { ok: false, edges: 0 };
      if (r.edges + 1 > edges) edges = r.edges + 1;
      continue;
    }
  }
  return { ok: true, edges };
}

function annotateStaticIncludes(tpls) {
  const memo = new Map();
  for (const nodes of tpls.values()) {
    const walk = (list) => {
      for (const nd of list) {
        if (nd.t === 3) walk(nd.body);
        else if (nd.t === 4) { walk(nd.then); if (nd.els) walk(nd.els); }
        else if (nd.t === 5) {
          const sub = tpls.get(nd.name);
          if (sub) {
            let r = memo.get(nd.name);
            if (!r) {
              r = analyzeStatic(sub, tpls, STATIC_GLOBALS, new Set([nd.name]), memo);
              memo.set(nd.name, r);
            }
            nd.cache = r.ok;
            nd.cedges = r.edges;
          }
        }
      }
    };
    walk(nodes);
  }
}

function renderNodes(nodes, scopes, tpls, out, depth, cache) {
  for (let n = 0; n < nodes.length; n++) {
    const nd = nodes[n];
    if (nd.t === 0) { out.push(nd.s); continue; }
    if (nd.t === 1 || nd.t === 2) {
      const s = stringifyValue(resolvePath(nd.p, scopes));
      if (nd.t === 1) out.push(escStr(s));
      else out.push(s);
      continue;
    }
    if (nd.t === 3) {
      const arr = resolvePath(nd.p, scopes);
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const scope = Object.create(null);
      const loop = { index: 0, first: false, last: false, length: arr.length };
      scope.loop = loop;
      scopes.push(scope);
      for (let i = 0; i < arr.length; i++) {
        loop.index = i + 1;
        loop.first = i === 0;
        loop.last = i === arr.length - 1;
        scope[nd.v] = arr[i];
        scope.loop = loop;
        renderNodes(nd.body, scopes, tpls, out, depth, cache);
      }
      scopes.pop();
      continue;
    }
    if (nd.t === 4) {
      const tv = truthy(resolvePath(nd.p, scopes));
      if ((tv && !nd.neg) || (!tv && nd.neg)) renderNodes(nd.then, scopes, tpls, out, depth, cache);
      else if (nd.els) renderNodes(nd.els, scopes, tpls, out, depth, cache);
      continue;
    }
    if (nd.t === 5) {
      if (depth >= 8) continue;
      const sub = tpls.get(nd.name);
      if (!sub) continue;
      if (nd.cache && depth + 1 + nd.cedges < 8) {
        let s = cache.get(nd.name);
        if (s === undefined) {
          const tmp = [];
          renderNodes(sub, scopes, tpls, tmp, depth + 1, cache);
          s = tmp.join('');
          cache.set(nd.name, s);
        }
        out.push(s);
        continue;
      }
      renderNodes(sub, scopes, tpls, out, depth + 1, cache);
      continue;
    }
  }
}

function renderTemplate(nodes, ctx, tpls, cache) {
  const out = [];
  const root = Object.create(null);
  Object.assign(root, ctx);
  renderNodes(nodes, [root], tpls, out, 0, cache);
  return out.join('');
}

// ---------- markdown inline ----------

function findStrongClose(s, from, n) {
  let j = from;
  while (j < n - 1) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE.has(s[j + 1])) { j += 2; continue; }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
    j++;
  }
  return -1;
}

function findEmClose(s, from, n) {
  let j = from;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE.has(s[j + 1])) { j += 2; continue; }
    if (c === 42) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 42) { j += 2; continue; }
      if (j > from) return j;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

function pushEscaped(out, s, a, b) {
  if (b <= a) return;
  out.push(s.slice(a, b).replace(ESC_RE, (ch) => ESC_MAP[ch]));
}

const MARK_RE = /[\\`*\[]/g;

function renderInline(s, a, b, ctx, out) {
  let i = a;
  let plain = a;
  while (i < b) {
    MARK_RE.lastIndex = i;
    const m = MARK_RE.exec(s);
    const ni = m && m.index < b ? m.index : -1;
    if (ni === -1) break;
    const c = s.charCodeAt(ni);
    if (c === 92) {
      const nx = ni + 1 < b ? s[ni + 1] : '';
      if (nx !== '' && ESCAPABLE.has(nx)) {
        pushEscaped(out, s, plain, ni);
        out.push(nx === '&' ? '&amp;' : nx === '<' ? '&lt;' : nx === '>' ? '&gt;' : nx === '"' ? '&quot;' : nx === "'" ? '&#39;' : nx);
        i = ni + 2;
        plain = i;
        continue;
      }
      i = ni + 1;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', ni + 1);
      if (j !== -1 && j < b && j > ni + 1) {
        pushEscaped(out, s, plain, ni);
        out.push('<code>');
        pushEscaped(out, s, ni + 1, j);
        out.push('</code>');
        i = j + 1;
        plain = i;
        continue;
      }
      i = ni + 1;
      continue;
    }
    if (c === 42) {
      if (ni + 1 < b && s.charCodeAt(ni + 1) === 42) {
        const close = findStrongClose(s, ni + 2, b);
        if (close !== -1 && close !== ni + 2) {
          pushEscaped(out, s, plain, ni);
          out.push('<strong>');
          renderInline(s, ni + 2, close, ctx, out);
          out.push('</strong>');
          i = close + 2;
          plain = i;
          continue;
        }
        i = ni + 2;
        continue;
      }
      const close = findEmClose(s, ni + 1, b);
      if (close !== -1) {
        pushEscaped(out, s, plain, ni);
        out.push('<em>');
        renderInline(s, ni + 1, close, ctx, out);
        out.push('</em>');
        i = close + 1;
        plain = i;
        continue;
      }
      i = ni + 1;
      continue;
    }
    const res = tryLink(s, ni, b, ctx);
    if (res) {
      pushEscaped(out, s, plain, ni);
      out.push(res.html);
      i = res.next;
      plain = i;
      continue;
    }
    i = ni + 1;
  }
  pushEscaped(out, s, plain, b);
}

function tryLink(s, i, n, ctx) {
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE.has(s[j + 1])) { j += 2; continue; }
    if (c === 93) break;
    j++;
  }
  if (j >= n) return null;
  if (j + 1 >= n || s.charCodeAt(j + 1) !== 40) return null;
  let k = j + 2;
  while (k < n && s.charCodeAt(k) !== 41) k++;
  if (k >= n) return null;
  const target = s.slice(j + 2, k);
  if (target.length === 0) return null;
  for (let t = 0; t < target.length; t++) {
    const cc = target.charCodeAt(t);
    if (cc === 32 || cc === 9 || cc === 10 || cc === 13) return null;
  }
  const parts = [];
  renderInline(s, i + 1, j, ctx, parts);
  const href = ctx.resolveLink(target);
  return { html: '<a href="' + escStr(href) + '">' + parts.join('') + '</a>', next: k + 1 };
}

// ---------- markdown blocks ----------

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(start, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingMatch(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(h));
  if (text === '') return null;
  return { level: h, text };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function listMarker(line) {
  if (line.charCodeAt(0) === 45 && line.charCodeAt(1) === 32) {
    return { ordered: false, num: 0, text: trimLine(line.slice(2)) };
  }
  if (line.charCodeAt(0) === 42 && line.charCodeAt(1) === 32) {
    return { ordered: false, num: 0, text: trimLine(line.slice(2)) };
  }
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i > 0 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
    return { ordered: true, num: parseInt(line.slice(0, i), 10), text: trimLine(line.slice(i + 2)) };
  }
  return null;
}

function countWordsLines(lines, start) {
  let n = 0;
  for (let li = start; li < lines.length; li++) {
    const body = lines[li];
    let inWord = false;
    for (let i = 0; i < body.length; i++) {
      if (body.charCodeAt(i) <= 32) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    }
  }
  return n;
}

function renderMarkdown(lines, startIdx, ctx) {
  const out = [];
  const toc = [];
  const headingIds = new Map();
  let excerpt = '';
  let excerptDone = false;
  let i = startIdx;
  const L = lines.length;
  const words = countWordsLines(lines, startIdx);
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const parts = ['<pre><code'];
      if (lang !== '') parts.push(' class="language-' + escStr(lang) + '"');
      parts.push('>');
      i++;
      while (i < L && !isFenceClose(lines[i])) {
        escInto(parts, lines[i], 0, lines[i].length);
        parts.push('\n');
        i++;
      }
      if (i < L) i++;
      parts.push('</code></pre>\n');
      out.push(parts.join(''));
      continue;
    }
    const hd = headingMatch(line);
    if (hd) {
      const base = slugify(hd.text);
      const cnt = (headingIds.get(base) || 0) + 1;
      headingIds.set(base, cnt);
      const id = cnt === 1 ? base : base + '-' + cnt;
      if (hd.level === 2 || hd.level === 3) {
        const hp = [];
        renderInline(hd.text, 0, hd.text.length, ctx, hp);
        toc.push({ level: hd.level, id, html: hp.join('') });
      }
      out.push('<h' + hd.level + ' id="' + escStr(id) + '">');
      renderInline(hd.text, 0, hd.text.length, ctx, out);
      out.push('</h' + hd.level + '>\n');
      i++;
      continue;
    }
    if (isHr(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const qlines = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimLine(t);
        if (t !== '') qlines.push(t);
        i++;
      }
      if (qlines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        const qtext = qlines.join('\n');
        renderInline(qtext, 0, qtext.length, ctx, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const lm = listMarker(line);
    if (lm) {
      const items = [];
      const ordered = lm.ordered;
      const startNum = lm.num;
      while (i < L) {
        const l2 = lines[i];
        const m2 = listMarker(l2);
        if (m2 && m2.ordered === ordered) { items.push(m2.text); i++; continue; }
        if (l2.length >= 2 && l2.charCodeAt(0) === 32 && l2.charCodeAt(1) === 32 && !isBlank(l2)) {
          items[items.length - 1] += '\n' + trimLine(l2);
          i++;
          continue;
        }
        break;
      }
      const parts = [ordered ? (startNum === 1 ? '<ol>\n' : '<ol start="' + startNum + '">\n') : '<ul>\n'];
      for (const it of items) {
        parts.push('<li>');
        renderInline(it, 0, it.length, ctx, parts);
        parts.push('</li>\n');
      }
      parts.push(ordered ? '</ol>\n' : '</ul>\n');
      out.push(parts.join(''));
      continue;
    }
    const plines = [];
    while (i < L) {
      const l2 = lines[i];
      if (isBlank(l2)) break;
      if (fenceOpen(l2) !== null || headingMatch(l2) || isHr(l2)) break;
      plines.push(trimLine(l2));
      i++;
    }
    const ptext = plines.join('\n');
    const parts = [];
    renderInline(ptext, 0, ptext.length, ctx, parts);
    const inner = parts.join('');
    if (!excerptDone) { excerpt = inner; excerptDone = true; }
    out.push('<p>' + inner + '</p>\n');
  }
  return { html: out.join(''), excerpt, toc, readingMinutes: Math.max(1, Math.ceil(words / 200)) };
}

// ---------- links ----------

function normalizeRel(srcDir, path) {
  const segs = srcDir === '' ? [] : srcDir.split('/');
  const parts = path.split('/');
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (segs.length > 0) segs.pop(); continue; }
    segs.push(p);
  }
  return segs.join('/');
}

function dirOf(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

// ---------- run ----------

export function run(input) {
  const site = input.site || {};
  const base = String(site.base_url || '').replace(/\/+$/, '');
  const perPage = site.per_page || 10;
  const recentN = site.recent || 0;
  const report = [];

  const tplNames = Object.keys(input.templates || {}).sort();
  const tpls = new Map();
  for (const name of tplNames) {
    const r = parseTemplate(input.templates[name]);
    if (r.error) report.push('template "' + name + '": ' + r.error);
    else tpls.set(name, r.nodes);
  }
  annotateStaticIncludes(tpls);
  const tplCache = new Map();

  const files = (input.files || []).slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const docs = [];
  const statics = [];
  const pageBySource = new Map();
  const staticSet = new Set();
  const usedSlugs = new Map();

  for (const f of files) {
    const path = f.path;
    if (!path.endsWith('.md')) { statics.push(f); staticSet.add(path); continue; }
    const rawContent = String(f.content);
    const content = rawContent.indexOf('\r') === -1 ? rawContent : rawContent.replace(/\r\n?/g, '\n');
    const lines = content.split('\n');
    if (lines[0] !== '---') { report.push('refused ' + path + ': no front matter'); continue; }
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') { close = i; break; }
    }
    if (close === -1) { report.push('refused ' + path + ': the front matter is not closed'); continue; }
    const fmRes = parseFrontMatter(lines, close);
    if (fmRes.error) { report.push('refused ' + path + ': ' + fmRes.error); continue; }
    const fm = fmRes.fm;
    if (path.startsWith('tags/')) { report.push('refused ' + path + ": tags/ is the generator's own"); continue; }
    if (path.startsWith('page/')) { report.push('refused ' + path + ": page/ is the generator's own"); continue; }
    const isPost = path.startsWith('posts/');
    if (isPost && fm.date === undefined) { report.push('refused ' + path + ': a post needs a date'); continue; }
    const layoutName = fm.layout || (isPost ? 'post' : 'page');
    if (!tpls.has(layoutName)) { report.push('refused ' + path + ': layout "' + layoutName + '" is no template that parses'); continue; }
    if (fm.draft === true) { report.push('draft ' + path); continue; }
    const dir = isPost ? 'posts' : dirOf(path);
    let slugBase = fm.slug || slugify(fm.title);
    let used = usedSlugs.get(dir);
    if (!used) { used = new Set(); usedSlugs.set(dir, used); }
    let slug = slugBase;
    let n = 2;
    while (used.has(slug)) { slug = slugBase + '-' + n; n++; }
    used.add(slug);
    const url = base + '/' + (dir === '' ? '' : dir + '/') + slug + '/';
    const outPath = (dir === '' ? '' : dir + '/') + slug + '/index.html';
    const doc = { path, isPost, dir, slug, url, outPath, layoutName, fm, lines, close };
    docs.push(doc);
    pageBySource.set(path, doc);
  }

  const broken = new Set();
  function resolveLink(target, srcPath) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
    let p = target, frag = '';
    const h = target.indexOf('#');
    if (h !== -1) { p = target.slice(0, h); frag = target.slice(h); }
    const norm = normalizeRel(dirOf(srcPath), p);
    const pg = pageBySource.get(norm);
    if (pg) return pg.url + frag;
    if (staticSet.has(norm)) return base + '/' + norm + frag;
    broken.add('broken-link ' + srcPath + ' -> ' + target);
    return target;
  }

  for (const doc of docs) {
    const ctx = { resolveLink: (t) => resolveLink(t, doc.path) };
    const md = renderMarkdown(doc.lines, doc.close + 1, ctx);
    doc.content = md.html;
    doc.excerpt = md.excerpt;
    doc.toc = md.toc;
    doc.readingMinutes = md.readingMinutes;
  }

  const posts = docs.filter((d) => d.isPost).sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  function docTags(doc) {
    const seen = new Set();
    const out = [];
    for (const name of (doc.fm.tags || [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug, url: '' });
    }
    return out;
  }

  const tagMap = new Map();
  for (const post of posts) {
    post.tagList = docTags(post);
    for (const t of post.tagList) {
      let g = tagMap.get(t.slug);
      if (!g) {
        g = { name: t.name, slug: t.slug, url: base + '/tags/' + t.slug + '/', count: 0, posts: [] };
        tagMap.set(t.slug, g);
      }
      g.count++;
      g.posts.push(post);
    }
  }
  const tags = [...tagMap.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const tagUrlBySlug = new Map(tags.map((t) => [t.slug, t.url]));

  function cardOf(doc) {
    const tagsOut = doc.tagList.map((t) => {
      const g = tagMap.get(t.slug);
      return { name: g ? g.name : t.name, slug: t.slug, url: g ? g.url : '' };
    });
    return {
      title: doc.fm.title,
      url: doc.url,
      date: doc.fm.date || '',
      date_long: doc.fm.date ? dateLong(doc.fm.date) : '',
      summary: doc.fm.summary || '',
      excerpt: doc.excerpt,
      reading_minutes: doc.readingMinutes,
      tags: tagsOut,
    };
  }

  const postIndex = new Map(posts.map((p, i) => [p, i]));
  const recent = posts.slice(0, recentN).map(cardOf);
  const tagsCtx = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.count, posts: t.posts.map(cardOf) }));

  for (const doc of docs) {
    doc.tagList = doc.tagList || docTags(doc);
    for (const t of doc.tagList) t.url = tagUrlBySlug.get(t.slug) || '';
    const card = cardOf(doc);
    let newer = null, older = null;    if (doc.isPost) {
      const idx = postIndex.get(doc);
      if (idx > 0) {
        const np = posts[idx - 1];
        newer = { title: np.fm.title, url: np.url, date: np.fm.date, date_long: dateLong(np.fm.date) };
      }
      if (idx < posts.length - 1) {
        const op = posts[idx + 1];
        older = { title: op.fm.title, url: op.url, date: op.fm.date, date_long: dateLong(op.fm.date) };
      }
    }
    doc.page = Object.assign({}, card, {
      slug: doc.slug,
      content: doc.content,
      toc: doc.toc,
      newer,
      older,
      is_post: doc.isPost,
    });
  }

  const out = {};
  let pageCount = 0, postCount = 0;
  for (const doc of docs) {
    const nodes = tpls.get(doc.layoutName);
    out[doc.outPath] = renderTemplate(nodes, { site, tags: tagsCtx, recent, page: doc.page }, tpls, tplCache);
    if (doc.isPost) postCount++; else pageCount++;
  }

  let tagPageCount = 0;
  if (tpls.has('index')) {
    const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
    const nodes = tpls.get('index');
    for (let p = 1; p <= totalPages; p++) {
      const slice = posts.slice((p - 1) * perPage, p * perPage).map(cardOf);
      const pager = {
        number: p,
        total: totalPages,
        url: p === 1 ? base + '/' : base + '/page/' + p + '/',
        newer_url: p === 1 ? '' : (p === 2 ? base + '/' : base + '/page/' + (p - 1) + '/'),
        older_url: p === totalPages ? '' : base + '/page/' + (p + 1) + '/',
      };
      const path = p === 1 ? 'index.html' : 'page/' + p + '/index.html';
      out[path] = renderTemplate(nodes, { site, tags: tagsCtx, recent, posts: slice, pager }, tpls, tplCache);
    }
  }
  if (tpls.has('tag')) {
    const nodes = tpls.get('tag');
    for (const t of tags) {
      const tagObj = { name: t.name, slug: t.slug, url: t.url, count: t.count, posts: t.posts.map(cardOf) };
      out['tags/' + t.slug + '/index.html'] = renderTemplate(nodes, { site, tags: tagsCtx, recent, tag: tagObj }, tpls, tplCache);
      tagPageCount++;
    }
  }
  if (tpls.has('tags')) {
    out['tags/index.html'] = renderTemplate(tpls.get('tags'), { site, tags: tagsCtx, recent }, tpls, tplCache);
  }
  for (const st of statics) {
    if (Object.prototype.hasOwnProperty.call(out, st.path)) {
      report.push('shadowed ' + st.path + ': a built page has its path');
      continue;
    }
    out[st.path] = st.content;
  }

  for (const b of broken) report.push(b);
  report.sort();
  report.push('built ' + pageCount + ' pages, ' + postCount + ' posts, ' + tagPageCount + ' tags and ' + statics.length + ' static files');
  out['build-report.txt'] = report.map((l) => l + '\n').join('');
  return out;
}
