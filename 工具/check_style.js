/* ===========================================================================
 * check_style.js —— 文风体检（破折号 / AI 腔词表 / 负向指令预算 / 跨条目引用）
 * ---------------------------------------------------------------------------
 * 用法：node 工具/check_style.js <卡包目录|某个.json> [--json]
 * 退出码：有「必须修」＝1，否则 0；用法错＝2。
 *
 * 查四样（口径见 04_铁律与坑.md 五、七）：
 *   ① 破折号 ——（双写）与 —（单写）：**自撰 0 容忍**。引号里的照录台词不算——
 *      判定前先剥引号（"" 「」 “” 『』 ''），剥完还有破折号才算自撰。
 *   ② AI 腔词表：逐处报位置与词；**密度 ≥3 处/千字判必须修**。
 *   ③ 负向指令预算：统计 不要/别/禁止/… ，预算＝max(6, 去空白字数÷2000)，超了必须修。
 *      同样先剥引号：引号里是角色在说话（「别谢」），不是给模型的指令。
 *   ④ 跨条目引用（正文提到别的条目编号，如 C1.1）：**只提示**，不判失败。
 *
 * 要改词表就改下面 AI_CLICHE_WORDS / NEGATIVE_WORDS 两个常量（03_检查器.md 有表）。
 * 只读不写：本脚本不改任何文件。
 * ==========================================================================*/
'use strict';

const TOOL = 'check_style.js';
const USAGE = '用法：node 工具/check_style.js <卡包目录|某个.json> [--json]';

/* ------------------------------ 词表（改这里） ------------------------------ */
// AI 腔：一多就露机器味（04_铁律与坑.md 七）。按词的整串匹配，不看大小写。
const AI_CLICHE_WORDS = [
  '仿佛', '彷佛', '不禁', '不由得', '嘴角勾起', '嘴角微微勾起', '嘴角上扬',
  '眼中闪过', '眼底闪过', '眸光微闪', '空气仿佛凝固', '宣告着', '诉说着', '无声地诉说',
  '一丝', '一抹', '深邃', '复杂的情感', '心中一紧', '深吸一口气',
  '若有所思', '意味深长', '不易察觉', '几不可闻', '缓缓开口', '轻轻叹了口气', '微微一顿',
];

// 负向指令：这几类句子多了，模型会变得畏手畏脚（04_铁律与坑.md 五）
const NEGATIVE_WORDS = ['不要', '别', '禁止', '切勿', '不许', '不能', '严禁', '避免'];
// ⚠ 只有「别」是单字，直接数会误伤「特别／别人／告别／个别」这类词：
//   所以它只认**句读之后**（，。！？；：、 换行 引号后）或**你／请／千万＋别**的位置。
//   其余六个都是双字词，直接数。
const NEGATIVE_RE = /不要|禁止|切勿|不许|不能|严禁|避免|(?<=^|[，。！？；：、\s「『"'（(])别|(?<=你|请|千万)别/;
// 计数要用带 g 的版本：不带 g 的 match() 一行只返回第一个命中，长行会被数漏
const NEGATIVE_RE_G = new RegExp(NEGATIVE_RE.source, 'g');

/* AI 腔密度上限（处/千字）：≥ 就判必须修 —— 03_检查器.md 的表格口径 */
const AI_DENSITY_LIMIT = 3;
/* 自撰破折号：0 容忍 */
const DASH_LIMIT = 0;
/* 逐处罗列的上限（多了没人看，剩下的只报数） */
const LIST_CAP = 20;

const negativeBudget = (chars) => Math.max(6, chars / 2000);   // max(6, 去空白字数÷2000)
const round1 = (n) => Math.round(n * 10) / 10;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

/* --------------------------------- 体检 --------------------------------- */
function run(target, opt) {
  const rep = createReporter(TOOL, target, opt);
  const t = commonHead(rep, TOOL, target);

  // 要体检的正文＝卡片字段 ＋ 世界书条目正文（引号剥离在各项里各做各的）
  const sources = [];
  for (const c of t.cards) for (const x of cardTexts(c.json)) sources.push(x);
  const srcs = entrySources(t);
  for (const s of srcs) for (const x of entryTexts(s)) sources.push(x);

  if (sources.length === 0) {
    rep.fail('没有可体检的正文：卡片字段与世界书条目都是空的');
    return rep.finish();
  }
  const all = sources.map((s) => s.text).join('\n');
  const chars = noSpaceLen(all);
  rep.pass('规模：正文 ' + fmt(chars) + ' 字（去空白）· 卡片 ' + t.cards.length + ' 个 · 条目 ' +
    srcs.reduce((n, s) => n + s.entries.length, 0) + ' 条');

  /* ① 破折号 ---------------------------------------------------------- */
  // 逐行判：剥掉引号后还有 U+2014 ⇒ 自撰（判必须修）；只剩引号里 ⇒ 照录，不计脏项。
  const dashSelf = [], dashQuoted = [];
  for (const s of sources) {
    s.text.split(/\r?\n/).forEach((line, i) => {
      if (!line.includes('\u2014')) return;
      const out = stripQuotes(line);
      const hit = { src: s.label, line: i + 1, type: out.includes('——') ? '双写 ——' : '单写 —' };
      if (out.includes('\u2014')) dashSelf.push(hit); else dashQuoted.push(hit);
    });
  }
  if (dashSelf.length) {
    for (const h of dashSelf) {
      rep.fail('破折号（自撰）：' + h.src + ' 正文第 ' + h.line + ' 行 ' + h.type + '，阈值 ' + DASH_LIMIT + '（中文里该用逗号、句号就断句）');
    }
  } else {
    rep.pass('破折号：自撰 0 处（阈值 ' + DASH_LIMIT + '）' + (dashQuoted.length
      ? '·引号内照录 ' + dashQuoted.length + ' 处不计（' + dashQuoted.slice(0, 6).map((h) => h.src + ' 第 ' + h.line + ' 行').join('、') + '）'
      : ''));
  }

  /* ② AI 腔词表 ------------------------------------------------------- */
  const aiRe = new RegExp(AI_CLICHE_WORDS.slice().sort((a, b) => b.length - a.length).map(escRe).join('|'), 'g');
  const aiHits = [];
  for (const s of sources) {
    s.text.split(/\r?\n/).forEach((line, i) => {
      for (const w of line.match(aiRe) || []) aiHits.push({ src: s.label, line: i + 1, word: w });
    });
  }
  const per1k = chars ? aiHits.length / (chars / 1000) : 0;
  if (per1k >= AI_DENSITY_LIMIT) {
    rep.fail('AI 腔词表：' + aiHits.length + ' 处 · 密度 ' + round1(per1k).toFixed(2) + ' 处/千字 ≥ ' + AI_DENSITY_LIMIT + '（超密度，见 04_铁律与坑.md 七）');
  } else if (aiHits.length) {
    rep.hint('AI 腔词表：' + aiHits.length + ' 处 · 密度 ' + round1(per1k).toFixed(2) + ' 处/千字（限 ' + AI_DENSITY_LIMIT + '，未超）');
  } else {
    rep.pass('AI 腔词表：0 处 · 密度 0.00 处/千字（限 ' + AI_DENSITY_LIMIT + '）');
  }
  for (const h of aiHits.slice(0, LIST_CAP)) rep.hint('AI 腔：' + h.word + ' ← ' + h.src + ' 第 ' + h.line + ' 行');
  if (aiHits.length > LIST_CAP) rep.hint('AI 腔：另有 ' + (aiHits.length - LIST_CAP) + ' 处未列出（共 ' + aiHits.length + ' 处）');

  /* ③ 负向指令预算 ----------------------------------------------------- */
  const negHits = [];
  for (const s of sources) {
    s.text.split(/\r?\n/).forEach((line, i) => {
      const noq = stripQuotes(line);
      if (!noq.trim()) return;
      for (const w of noq.match(NEGATIVE_RE_G) || []) negHits.push({ src: s.label, line: i + 1, word: w });
    });
  }
  const budget = negativeBudget(chars);
  if (negHits.length > budget) {
    rep.fail('负向指令：' + negHits.length + ' 处 / 预算 ' + round1(budget) + '（超 ' + (negHits.length - Math.floor(budget)) +
      ' 处；预算＝max(6, 去空白字数÷2000)，优先写正向口径）');
    for (const h of negHits.slice(0, 12)) rep.hint('负向指令位置：' + h.word + ' ← ' + h.src + ' 第 ' + h.line + ' 行');
    if (negHits.length > 12) rep.hint('负向指令位置：另有 ' + (negHits.length - 12) + ' 处未列出（共 ' + negHits.length + ' 处）');
  } else {
    rep.pass('负向指令：' + negHits.length + ' 处 / 预算 ' + round1(budget) +
      '（' + fmt(chars) + ' 字 → max(6, ' + round1(chars / 2000) + ')，词表 ' + NEGATIVE_WORDS.join('／') + '）');
  }

  /* ④ 跨条目引用（只提示） ---------------------------------------------- */
  const codeSet = new Set();
  for (const s of srcs) for (const e of s.entries) { const c = entryCode(e); if (c) codeSet.add(c); }
  const refs = [];
  for (const s of srcs) {
    for (const x of entryTexts(s)) {
      const own = entryCode(x.raw);
      const seen = new Set();
      for (const m of String(x.text).match(/[A-Za-z]\d+(?:\.\d+)*/g) || []) {
        if (m === own || !codeSet.has(m) || seen.has(m)) continue;
        seen.add(m);
        refs.push({ from: x.label, to: m });
      }
    }
  }
  if (refs.length) {
    for (const r of refs) rep.hint('跨条目引用：' + r.from + ' 提到 ' + r.to + '（只提示：确认被引的条目在那一轮一定在场）');
  } else {
    rep.pass('跨条目引用：0 处（正文提到别的条目编号时只提示、不判失败）');
  }

  return rep.finish();
}

main(TOOL, USAGE, run);
