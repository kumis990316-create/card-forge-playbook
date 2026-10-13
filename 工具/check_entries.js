/* ===========================================================================
 * check_entries.js —— 条目体检（角色条模板 / 数字口径 / 重复句 / 关键词 / 结构读数）
 * ---------------------------------------------------------------------------
 * 用法：node 工具/check_entries.js <卡包目录|某个.json> [--json]
 * 退出码：有「必须修」＝1，否则 0；用法错＝2。
 *
 * 查五样（口径见 02_卡结构.md、04_铁律与坑.md）：
 *   ① 角色条模板：正文同时含 `## 一句话` 与 `## 外形` 的条目＝角色条，
 *      必须再含 `## 标签`／`## 怎么上手`／`## 台词样本`／`## 开门之后`，**缺哪节报哪节**。
 *      （模板原文见 模板/条目模板.md）
 *   ② 数字口径：小节标题里的中文数字（一～十）与紧随的 `- ` 列表行数必须一致，
 *      例：`## 三条设定` 后面恰好 3 条 `- ` 行。多一条少一条都是必须修。
 *   ③ 跨条目重复句：≥14 字、非小节标题、非 `<` 开头的行，在 ≥2 个条目里一模一样 ⇒ **只提示**。
 *   ④ 关键词健康：`constant: false` 的条目 `key` 为空 ⇒ **必须修**（永远不会被触发）。
 *      （另提示单字触发词：容易误触发）
 *   ⑤ 结构读数：条目总数／常驻数／触发数／正文去空白字数／分组计数。
 *      另有：常驻条目正文为空 ⇒ 必须修；触发条目正文为空、正文首尾带空白 ⇒ 提示。
 * 只读不写。
 * ==========================================================================*/
'use strict';

const TOOL = 'check_entries.js';
const USAGE = '用法：node 工具/check_entries.js <卡包目录|某个.json> [--json]';

/* 角色条识别与必备小节（改模板就改这两行） */
const CHAR_MARKERS = ['一句话', '外形'];
const CHAR_SECTIONS = ['标签', '怎么上手', '台词样本', '开门之后'];
/* 跨条目重复句的最小长度（去空白字数） */
const DUP_MIN = 14;
/* 逐条罗列上限 */
const LIST_CAP = 10;
/* 数字口径认的量词。⚠ 只收「后面跟着一串列表项」的量词：
   条／个／项／步／处。**不要加 句／段／种／层**——「## 一句话」是本库角色条的
   固定小节名，加了 句 就会把每个角色条都误判成「说 1 条、下面 0 条」。 */
const CN_NUM = '一二三四五六七八九十';
const CN_UNIT = '条个项步处';

const CN_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

// 小节标题：`## 名称`（含 ### 以上）
const isHeading = (line) => /^\s*#{2,}\s/.test(String(line));
const sectionTitle = (line) => { const m = String(line).match(/^\s*#{2,}\s+(.+?)\s*$/); return m ? m[1] : null; };
const hasSection = (lines, name) => lines.some((l) => sectionTitle(l) === name);

// 小节到下一个标题之间的内容区
function sectionEnd(lines, i) { for (let j = i + 1; j < lines.length; j++) if (isHeading(lines[j])) return j; return lines.length; }
const countListItems = (lines, from, to) => { let n = 0; for (let i = from; i < to; i++) if (/^\s*[-*+]\s+\S/.test(lines[i])) n++; return n; };

// 标题里的中文数字口径：`三条设定`／`第一步`／`设定三` 认，`三围设定` 不认（防误报）
function cnDemand(title) {
  let m = String(title).match(new RegExp('^(.*?)([' + CN_NUM + '])([' + CN_UNIT + '])(.*)$'));
  if (!m) m = String(title).match(new RegExp('^(.*?)([' + CN_NUM + '])$'));
  if (!m) return null;
  return { num: CN_MAP[m[2]], title: String(title) };
}

// 分组：comment 开头的字母部分（C0.1 → C；SUB1 → SUB）
const groupOf = (e) => { const m = comment(e).match(/^([A-Za-z]+)\d/); return m ? m[1] : '未分组'; };

// 查重单元：排除小节标题与 `<` 开头的行，去掉项目符号后去空白 ≥14 字
function dupUnits(lines) {
  const out = [];
  lines.forEach((raw, i) => {
    const t = String(raw).trim();
    if (!t || t.startsWith('<') || isHeading(raw)) return;
    const s = t.replace(/^[-*+]\s+/, '').replace(/^\d+[.、)]\s*/, '').trim();
    if (noSpaceLen(s) < DUP_MIN) return;
    out.push({ s, line: i + 1 });
  });
  return out;
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

/* --------------------------------- 体检 --------------------------------- */
function run(target, opt) {
  const rep = createReporter(TOOL, target, opt);
  const t = commonHead(rep, TOOL, target);
  const srcs = entrySources(t);
  const all = [];
  for (const s of srcs) for (const e of s.entries) all.push({ e, src: s, label: comment(e) || 'uid ' + e.uid });

  if (all.length === 0) {
    rep.fail('没找到任何条目：世界书 JSON 里没有 entries，卡片里也没有 data.character_book');
    return rep.finish();
  }

  /* ⑤ 结构读数（先报，后面各检查引用这个数） ---------------------------- */
  const isConst = (e) => e.constant === true;
  const consts = all.filter((x) => isConst(x.e));
  const triggers = all.filter((x) => !isConst(x.e));
  const chars = noSpaceLen(all.map((x) => String(x.e.content || '')).join('\n'));
  const groups = new Map();
  for (const x of all) groups.set(groupOf(x.e), (groups.get(groupOf(x.e)) || 0) + 1);
  rep.pass('结构读数：条目 ' + all.length + ' 条 · 常驻 ' + consts.length + ' 条 · 触发 ' + triggers.length +
    ' 条 · 正文 ' + fmt(chars) + ' 字（去空白）');
  rep.pass('分组计数：' + [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => g + ' ' + n + ' 条').join(' · '));

  /* ① 角色条模板 ------------------------------------------------------- */
  const roles = all.filter((x) => { const l = String(x.e.content || '').split(/\r?\n/); return CHAR_MARKERS.every((m) => hasSection(l, m)); });
  if (roles.length === 0) {
    rep.pass('角色条模板：本卡包没有角色条（正文含 ' + CHAR_MARKERS.map((m) => '## ' + m).join(' 与 ') + ' 的条目）');
  } else {
    let bad = 0;
    for (const x of roles) {
      const lines = String(x.e.content || '').split(/\r?\n/);
      const miss = CHAR_SECTIONS.filter((m) => !hasSection(lines, m));
      if (miss.length) {
        bad++;
        rep.fail('角色条模板：' + x.label + ' 缺小节 ' + miss.map((m) => '## ' + m).join('、') + '（照 模板/条目模板.md 补齐）');
      }
    }
    if (!bad) rep.pass('角色条模板：' + roles.length + ' 个角色条（' + roles.map((x) => x.label).join('、') + '）四个必备小节齐全');
  }

  /* ② 数字口径 --------------------------------------------------------- */
  let numBad = 0, numChecked = 0;
  for (const x of all) {
    const lines = String(x.e.content || '').split(/\r?\n/);
    lines.forEach((line, i) => {
      const title = sectionTitle(line);
      if (!title) return;
      const d = cnDemand(title);
      if (!d) return;
      numChecked++;
      const n = countListItems(lines, i + 1, sectionEnd(lines, i));
      if (n !== d.num) {
        numBad++;
        rep.fail('数字口径：' + x.label + ' 第 ' + (i + 1) + ' 行「## ' + title + '」说 ' + d.num + ' 条，下面却是 ' + n + ' 条 `- ` 行');
      }
    });
  }
  if (numChecked === 0) rep.hint('数字口径：没有找到「## 三条设定」这类带中文数字的小节标题，这一项没查到东西');
  else if (!numBad) rep.pass('数字口径：' + numChecked + ' 处带数字的小节标题与列表行数一致');

  /* ④ 关键词健康 ------------------------------------------------------- */
  const emptyKey = triggers.filter((x) => !String(x.e.key === undefined || x.e.key === null ? '' : x.e.key).trim());
  if (emptyKey.length === 0) {
    rep.pass('关键词：' + triggers.length + ' 个触发条目都有 key（常驻条目 ' + consts.length + ' 个不需要）');
  } else {
    for (const x of emptyKey) rep.fail('关键词：' + x.label + ' 是 constant: false 但没有 key —— 永远不会被触发（补 key，或把它改成常驻）');
  }
  const singleKeys = [];
  for (const x of triggers) {
    const keys = String(x.e.key || '').split(',').map((k) => k.trim()).filter(Boolean);
    for (const k of keys) if ([...k].length === 1 && !/^[{<]/.test(k)) singleKeys.push({ label: x.label, k });
  }
  for (const s of singleKeys.slice(0, LIST_CAP)) rep.hint('关键词：' + s.label + ' 有单字触发词「' + s.k + '」—— 极易误触发，建议 ≥2 字');
  if (singleKeys.length > LIST_CAP) rep.hint('关键词：另有 ' + (singleKeys.length - LIST_CAP) + ' 个单字触发词未列出');

  /* 内容为空 ----------------------------------------------------------- */
  const emptyContent = all.filter((x) => !String(x.e.content === undefined || x.e.content === null ? '' : x.e.content).trim());
  if (emptyContent.length === 0) {
    rep.pass('内容：' + all.length + ' 个条目都有正文');
  } else {
    for (const x of emptyContent) {
      if (isConst(x.e)) rep.fail('内容：常驻条目 ' + x.label + ' 正文是空的（每轮注入一段空内容）');
      else rep.hint('内容：触发条目 ' + x.label + ' 正文是空的（触发时会注入空内容，但至少不占常驻位）');
    }
  }
  const pad = all.filter((x) => { const c = String(x.e.content || ''); return c.trim() && c !== c.trim(); });
  for (const x of pad.slice(0, LIST_CAP)) rep.hint('内容：' + x.label + ' 正文首尾有空白字符（清掉更省 token）');

  /* ③ 跨条目重复句（只提示） -------------------------------------------- */
  const dupMap = new Map();
  for (const x of all) {
    for (const u of dupUnits(String(x.e.content || '').split(/\r?\n/))) {
      const key = u.s.replace(/\s/g, '');
      if (!dupMap.has(key)) dupMap.set(key, { any: u.s, at: [] });
      dupMap.get(key).at.push(x.label + ' 第 ' + u.line + ' 行');
    }
  }
  const dups = [...dupMap.values()].filter((d) => new Set(d.at.map((s) => s.split(' 第 ')[0])).size >= 2).sort((a, b) => b.at.length - a.at.length);
  if (dups.length === 0) {
    rep.pass('跨条目重复句：0 处（≥' + DUP_MIN + ' 字的整行重复只提示、不判失败）');
  } else {
    rep.hint('跨条目重复句：' + dups.length + ' 处 ≥' + DUP_MIN + ' 字的整行重复（同一句到处粘＝每个条目都变厚，只提示）');
    for (const d of dups.slice(0, LIST_CAP)) rep.hint('重复句：「' + (d.any.length > 30 ? d.any.slice(0, 30) + '…' : d.any) + '」← ' + d.at.join('、'));
    if (dups.length > LIST_CAP) rep.hint('重复句：另有 ' + (dups.length - LIST_CAP) + ' 处未列出（共 ' + dups.length + ' 处）');
  }

  return rep.finish();
}

main(TOOL, USAGE, run);
