/* ===========================================================================
 * check_setting.js —— 设定一致性（术语表：旧名 / 现用名 / 标签词）
 * ---------------------------------------------------------------------------
 * 用法：node 工具/check_setting.js <卡包目录|某个.json> [--json]
 * 退出码：有「必须修」＝1，否则 0；用法错＝2。
 *
 * 术语表从哪来（先卡包、后本库，逐级回退）：
 *   ① <卡包目录>/模板/术语表.json   ← 卡包自己的口径优先
 *   ② <本库>/模板/术语表.json       ← 没有上一份时用这份（脚本用 __dirname 定位，不写死绝对路径）
 * 结构（照 模板/术语表.json）：
 *   { "terms": ["灰渡", "铜筹"],                              ← 现用名：只做计数读数
 *     "forbidden": [{"旧名": "河港市", "应为": "灰渡"}] }      ← 旧名：出现即必须修
 *   terms 也可以写成对象数组（{"term":"灰渡","上界":3,"备注":"…"}，只是多一列读数）；
 *   另支持可选的 "tags": ["兽耳"] 做标签词计数。
 *
 * 判法：
 *   ① forbidden 的「旧名」出现在任何条目正文（或卡片字段）⇒ **必须修**，逐处报文件与次数；
 *   ② terms / tags 只计数读数 ⇒ 通过项，不判失败（判断留给人）。
 * 只读不写。词表与结构示例见 模板/术语表.json。
 * ==========================================================================*/
'use strict';

const TOOL = 'check_setting.js';
const USAGE = '用法：node 工具/check_setting.js <卡包目录|某个.json> [--json]';

// 卡包自己的优先，没有就回退本库那份；都没有才算必须修
// ⚠ GLOSSARY_REL / LIB_GLOSSARY 两个路径常量放在共享块之后（要用 path，且它由共享块 require）
function loadGlossary(packRoot) {
  const cands = [
    { file: path.join(packRoot, GLOSSARY_REL), from: '卡包自己的' },
    { file: LIB_GLOSSARY, from: '本库回退的' },
  ];
  for (const c of cands) {
    if (!fs.existsSync(c.file)) continue;
    try {
      return { file: c.file, from: c.from, json: JSON.parse(fs.readFileSync(c.file, 'utf8')), err: null };
    } catch (e) {
      return { file: c.file, from: c.from, json: null, err: e.message };
    }
  }
  return { file: null, from: null, json: null, err: null };
}

// 术语表里字段名取几种常见写法，认不出就跳过（不猜）
const strOf = (o, keys) => {
  for (const k of keys) if (o && typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
  return '';
};

// 不重叠计数（术语／标签这类短词不需要重叠匹配）
function countOcc(text, word) {
  if (!word) return 0;
  let n = 0, i = 0;
  for (;;) { const j = text.indexOf(word, i); if (j === -1) return n; n++; i = j + word.length; }
}

/* ===========================================================================
 * 公共小工具 —— 四个 check 脚本各自内嵌一份（本库刻意不做共享模块：
 * 每个脚本都能单独复制到别的卡包里跑，不依赖同目录的其它文件）。
 * 契约见 03_检查器.md：三档输出 ✓/!/✗ ＋ 末尾「=== 结论：N 必须修 / M 提示 ===」，
 * 退出码：有必须修＝1、否则 0、用法错＝2。
 * ======================================================================== */

const fs = require('fs');
const path = require('path');

// 三档标记：pass＝通过项 / hint＝提示项（人自己判断）/ fail＝必须修项
const MARK = { pass: '✓', hint: '!', fail: '✗' };

/* ---------------------------- 目标解析 ---------------------------- */
// 参数可以是卡包目录，也可以直接是某个 JSON 文件。
// 卡包目录优先只看 01_卡片/（没有才递归扫整包）；成品、历史、工具、模板一律不扫。
const SKIP_DIR = /^(03_成品|_历史|工具|模板|node_modules|\.git)$/;

function findJsonFiles(input) {
  const res = { root: null, files: [], errors: [] };
  const p = path.resolve(String(input));
  if (!fs.existsSync(p)) { res.errors.push('路径不存在：' + p); return res; }
  if (fs.statSync(p).isFile()) {
    res.root = path.dirname(p);
    if (/\.json$/i.test(p)) res.files.push(p);
    else res.errors.push('不是 .json 文件：' + p);
    return res;
  }
  res.root = p;
  const cardDir = path.join(p, '01_卡片');
  const base = fs.existsSync(cardDir) && fs.statSync(cardDir).isDirectory() ? cardDir : p;
  (function walk(d, depth) {
    if (depth > 3) return;
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(path.join(d, e.name), depth + 1); }
      else if (/\.json$/i.test(e.name)) res.files.push(path.join(d, e.name));
    }
  })(base, 0);
  res.files.sort();
  return res;
}

function isWorldbook(j) {
  return !!j && typeof j === 'object' && !Array.isArray(j) && !!j.entries && typeof j.entries === 'object';
}
// 卡片：有 spec（chara_card_v2/v3）或有 data 外壳或有 first_mes（v1 平铺）
function isCard(j) {
  return !!j && typeof j === 'object' && !Array.isArray(j) && !isWorldbook(j) &&
    (typeof j.spec === 'string' || (!!j.data && typeof j.data === 'object') || typeof j.first_mes === 'string');
}

// 把目标目录/文件读成 { cards:[{rel,json}], books:[...], others:[...], errors:[...] }
function loadTargets(input) {
  const res = findJsonFiles(input);
  res.cards = []; res.books = []; res.others = [];
  for (const f of res.files) {
    const rel = path.relative(res.root, f) || path.basename(f);
    let json;
    try { json = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { res.errors.push('JSON 解析失败：' + rel + ' —— ' + e.message); continue; }
    const rec = { file: f, rel, json };
    if (isWorldbook(json)) res.books.push(rec);
    else if (isCard(json)) res.cards.push(rec);
    else res.others.push(rec);
  }
  return res;
}

/* ---------------------------- 条目与文本 ---------------------------- */
// 条目取值：世界书导出形态 entries 是字典（"0":{…}），卡片内嵌 character_book.entries 是数组
function entriesOf(obj) {
  const src = obj && obj.entries ? obj.entries : null;
  const out = [];
  if (Array.isArray(src)) { for (const e of src) if (e && typeof e === 'object') out.push(e); }
  else if (src && typeof src === 'object') { for (const k of Object.keys(src)) { const e = src[k]; if (e && typeof e === 'object') out.push(e); } }
  return out;
}

// 条目从哪来：优先独立的世界书 JSON；没有才退回卡片里的 data.character_book
// （两份都有时只认独立世界书，免得同一批条目被数两遍）
function entrySources(t) {
  if (t.books.length) {
    return t.books.map((b) => ({
      rel: b.rel,
      name: String(b.json.name || path.basename(b.rel, '.json')),
      entries: entriesOf(b.json),
    }));
  }
  const out = [];
  for (const c of t.cards) {
    const cb = c.json.data && c.json.data.character_book;
    const es = cb ? entriesOf(cb) : [];
    if (es.length) out.push({ rel: c.rel + '（内嵌 character_book）', name: String(cb.name || '内嵌世界书'), entries: es });
  }
  return out;
}

// 卡片正文只取一份：顶层有就用顶层，没有才看 data。
// 为什么：ST 是「v2 外壳 ＋ v1 平铺」，同一个字段两处同文，两处都数会把字数与词频翻倍。
const CARD_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions'];

function cardTexts(card) {
  const out = [];
  const d = card.data && typeof card.data === 'object' ? card.data : {};
  for (const k of CARD_FIELDS) {
    const top = typeof card[k] === 'string' && card[k].trim() ? card[k] : '';
    const v = top || (typeof d[k] === 'string' ? d[k] : '');
    if (v && v.trim()) out.push({ label: '卡片 ' + k, text: v });
  }
  const ags = Array.isArray(card.alternate_greetings) && card.alternate_greetings.length
    ? card.alternate_greetings
    : (Array.isArray(d.alternate_greetings) ? d.alternate_greetings : []);
  ags.forEach((g, i) => { if (typeof g === 'string' && g.trim()) out.push({ label: '卡片 alternate_greetings[' + i + ']', text: g }); });
  return out;
}

function entryTexts(src) {
  return src.entries
    .map((e, i) => ({ raw: e, label: comment(e) || '条目 #' + (e.uid === undefined ? i : e.uid), text: String(e.content === undefined || e.content === null ? '' : e.content) }))
    .filter((x) => x.text.trim() !== '');
}

function comment(e) { return String(e && e.comment !== undefined && e.comment !== null ? e.comment : '').trim(); }

// 条目编号：comment 开头的 C<数字>.<数字>（层号自定，见 02_卡结构.md 三）
function entryCode(e) {
  const m = comment(e).match(/^([A-Za-z]\d+(?:\.\d+)*)/);
  return m ? m[1] : '';
}

/* ---------------------------- 文本小工具 ---------------------------- */
// 引号剥离：破折号与负向指令共用（引号里是照录的台词／清单，不是给模型的指令）
const stripQuotes = (s) => String(s)
  .replace(/"[^"]*"/g, '')
  .replace(/「[^」]*」/g, '')
  .replace(/“[^”]*”/g, '')
  .replace(/『[^』]*』/g, '')
  .replace(/'[^']*'/g, '');

const noSpaceLen = (s) => String(s).replace(/\s/g, '').length;
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/* ---------------------------- 输出与汇总 ---------------------------- */
// quiet（--json 或 check_all 汇总时）只收结果不打印；
// 每条输出都以「  ✓ / ! / ✗ 」开头，末尾才是不带缩进的结论行。
function createReporter(tool, target, opts) {
  const opt = opts || {};
  const quiet = !!(opt.json || opt.silent);
  const items = [], notes = [];
  const say = (level, text) => {
    items.push({ level, text });
    if (!quiet) console.log('  ' + MARK[level] + ' ' + text);
  };
  const rep = {
    note(text) { notes.push(String(text)); if (!quiet) console.log(String(text)); },
    pass(t) { say('pass', t); },
    hint(t) { say('hint', t); },
    fail(t) { say('fail', t); },
    finish() {
      const mustFix = items.filter((i) => i.level === 'fail').length;
      const hints = items.filter((i) => i.level === 'hint').length;
      const passes = items.filter((i) => i.level === 'pass').length;
      const conclusion = '=== 结论：' + mustFix + ' 必须修 / ' + hints + ' 提示 ===';
      if (!quiet) console.log(conclusion);
      return { tool, target: path.resolve(String(target)), mustFix, hints, passes, exit: mustFix ? 1 : 0, conclusion, notes, items };
    },
  };
  return rep;
}

// 统一开头：解析目标、打印读了哪些文件、把错误摊开
function commonHead(rep, tool, target) {
  const t = loadTargets(target);
  rep.note('=== ' + tool + ' ===');
  rep.note('目标：' + path.resolve(String(target)));
  if (t.cards.length) rep.note('  卡片：' + t.cards.map((c) => c.rel).join('、'));
  if (t.books.length) rep.note('  世界书：' + t.books.map((b) => b.rel).join('、'));
  if (t.others.length) rep.note('  跳过（既不是卡片也不是世界书）：' + t.others.map((o) => o.rel).join('、'));
  for (const e of t.errors) rep.note('  · ' + e);
  if (t.files.length === 0) rep.fail('这个目标下没找到任何 JSON：' + path.resolve(String(target)));
  for (const b of t.books) if (entriesOf(b.json).length === 0) rep.note('  · ' + b.rel + '：entries 是空的');
  return t;
}

/* ---------------------------- 参数与入口 ---------------------------- */
function parseArgv(argv) {
  const opt = { json: false, help: false, target: null, flags: {} };
  for (const a of argv) {
    if (a === '--json') opt.json = true;
    else if (a === '--help' || a === '-h') opt.help = true;
    else if (a.startsWith('--')) opt.flags[a.slice(2)] = true;
    else if (!opt.target) opt.target = a;
  }
  return opt;
}

function main(tool, usage, run) {
  const opt = parseArgv(process.argv.slice(2));
  if (opt.help) { console.log(usage); process.exit(0); }
  if (!opt.target) { console.error(usage); process.exit(2); }
  const r = run(opt.target, opt);
  if (opt.json) console.log(JSON.stringify(r, null, 2));
  process.exit(r.exit);
}

/* 术语表两个候选路径（共享块已 require path；__dirname 就是本脚本所在的 工具/ 目录） */
const GLOSSARY_REL = path.join('模板', '术语表.json');            // 卡包自己的
const LIB_GLOSSARY = path.resolve(__dirname, '..', GLOSSARY_REL); // 本库的（回退用）

/* --------------------------------- 体检 --------------------------------- */
function run(target, opt) {
  const rep = createReporter(TOOL, target, opt);
  const t = commonHead(rep, TOOL, target);
  const packRoot = t.root || path.resolve(String(target));
  const rel2lib = (p) => { const r = path.relative(path.resolve(__dirname, '..'), p); return r.startsWith('..') ? p : r; };

  const g = loadGlossary(packRoot);
  if (!g.file) {
    rep.fail('找不到术语表：卡包内 ' + GLOSSARY_REL + ' 与本库 ' + LIB_GLOSSARY + ' 都没有');
    return rep.finish();
  }
  if (g.err) {
    rep.fail('术语表读不了：' + rel2lib(g.file) + ' —— ' + g.err);
    return rep.finish();
  }
  // 只接受数组：terms 的元素可以是纯字符串（模板写法）也可以是对象（带 上界／备注）
  const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
  const terms = asArray(g.json.terms);
  const forbidden = asArray(g.json.forbidden).filter((x) => typeof x === 'object');
  const tags = asArray(g.json.tags);
  rep.note('  术语表：' + g.from + ' ' + rel2lib(g.file) +
    '（现用 ' + terms.length + ' 条 · 禁用 ' + forbidden.length + ' 条 · 标签 ' + tags.length + ' 条）');
  const shapeBad = (g.json.terms !== undefined && !Array.isArray(g.json.terms)) ||
    (g.json.forbidden !== undefined && !Array.isArray(g.json.forbidden)) ||
    (g.json.terms === undefined && g.json.forbidden === undefined);
  if (shapeBad) {
    rep.fail('术语表格式不对：需要 terms / forbidden 两个数组（照 模板/术语表.json 的写法：terms 是名字的数组，forbidden 里每项写「旧名」「应为」）');
  }

  // 扫的正文＝卡片字段 ＋ 世界书条目（与 check_style.js 同一份语料）
  const sources = [];
  for (const c of t.cards) for (const x of cardTexts(c.json)) sources.push({ label: x.label, text: x.text });
  for (const s of entrySources(t)) for (const x of entryTexts(s)) sources.push({ label: x.label, text: x.text });
  if (sources.length === 0) {
    rep.fail('没有可体检的正文：卡片字段与世界书条目都是空的');
    return rep.finish();
  }

  /* ① 禁用旧名：出现即必须修 ------------------------------------------- */
  if (forbidden.length === 0) {
    rep.hint('forbidden 是空的：这份术语表没登记「旧名 → 现用名」，旧名一项无从查起');
  }
  for (const f of forbidden) {
    const old = strOf(f, ['旧名', 'old', 'name']);
    const should = strOf(f, ['应为', 'new', '正确', '现用名']);
    const note = strOf(f, ['说明', 'note', '备注']);
    if (!old) { rep.hint('术语表里有一条 forbidden 没写「旧名」，跳过：' + JSON.stringify(f)); continue; }
    const hits = [];
    let total = 0;
    for (const s of sources) { const n = countOcc(s.text, old); if (n) { total += n; hits.push(s.label + ' ×' + n); } }
    if (total) {
      rep.fail('禁用旧名「' + old + '」出现 ' + total + ' 处，应为「' + should + '」：' + hits.join('、') + (note ? '（' + note + '）' : ''));
    } else {
      rep.pass('旧名「' + old + '」：0 处（全文已是「' + should + '」）');
    }
  }

  /* ② 现用术语：只计数读数 --------------------------------------------- */
  if (terms.length === 0) rep.hint('terms 是空的：没有可计数的现用术语（把卡里在用的名字列进 模板/术语表.json 就能得到计数读数）');
  for (const raw of terms) {
    const x = typeof raw === 'string' ? { term: raw.trim() } : (typeof raw === 'object' ? raw : {});
    const w = strOf(x, ['term', '术语', 'name']);
    if (!w) { rep.hint('术语表里有一条 terms 没写名字，跳过：' + JSON.stringify(raw)); continue; }
    const hits = [];
    let total = 0;
    for (const s of sources) { const n = countOcc(s.text, w); if (n) { total += n; hits.push(s.label + ' ×' + n); } }
    const cap = x['上界'];
    const extra = [];
    if (cap !== undefined) extra.push('术语表上界 ' + cap);
    if (strOf(x, ['备注', 'note'])) extra.push(strOf(x, ['备注', 'note']));
    rep.pass('术语「' + w + '」：' + total + ' 处' + (hits.length ? '（' + hits.join('、') + '）' : '') +
      (extra.length ? ' · ' + extra.join(' · ') : '') + (cap !== undefined && total > Number(cap) ? ' ⚠ 超过术语表上界' : ''));
  }

  /* ③ 标签词：只计数读数 ------------------------------------------------ */
  if (tags.length) {
    const found = [];
    for (const raw of tags) {
      const x = typeof raw === 'string' ? { tag: raw.trim() } : (typeof raw === 'object' ? raw : {});
      const w = strOf(x, ['tag', '标签', 'name']);
      if (!w) continue;
      let total = 0;
      for (const s of sources) total += countOcc(s.text, w);
      found.push(w + ' ×' + total);
    }
    rep.pass('标签词计数：' + found.join('、'));
  }

  return rep.finish();
}

main(TOOL, USAGE, run);
