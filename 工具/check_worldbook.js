/* ===========================================================================
 * check_worldbook.js —— 世界书结构（字段完整性 / 类型与范围 / 位置双轨 / 命名 / uid）
 * ---------------------------------------------------------------------------
 * 用法：node 工具/check_worldbook.js <卡包目录|某个.json> [--json]
 * 退出码：有「必须修」＝1，否则 0；用法错＝2。
 *
 * 查五样（口径见 02_卡结构.md、04_铁律与坑.md 三）：
 *   ① 字段完整性：每个条目必须有 uid／comment／key／content／constant／order／
 *      position／depth／probability，缺一即必须修（ST 会给缺的字段塞默认值，
 *      于是「你以为写了 position: 4，实际按默认 0 注入」）。
 *   ② 类型与范围：probability 0–100、depth 0–10、order 必须是数字（超范围＝必须修）。
 *   ③ 位置双轨（**本库要教的经典坑**）：position 的顶层写叙梦档（5–10）、
 *      extensions 写酒馆档（0–7），同一个槽位相差 5；depth／probability
 *      两轨同值。两轨都写但不满足 ⇒ 必须修；只写一轨按输出端判：
 *      酒馆只写 extensions、叙梦只写顶层正常，双端缺一轨＝必须修。
 *   ④ comment 命名规范 `C<数字>.<数字> 名称`：不合规 ⇒ 提示（编号是给作者自己看的坐标系）。
 *   ⑤ uid 重复 ⇒ 必须修。
 * 只读不写。位置双轨也可单独只报形态：见 04_铁律与坑.md 三。
 * ==========================================================================*/
'use strict';

const TOOL = 'check_worldbook.js';
const USAGE = '用法：node 工具/check_worldbook.js <卡包目录|某个.json> [--输出端=酒馆|叙梦|双端] [--json]';

/* 输出端：决定「位置」按哪一端的规矩查（见 05_输出端与平台.md） */
const OUTPUT_ALIAS = {
  '酒馆': 'st', 'st': 'st', 'sillytavern': 'st', 'SillyTavern': 'st',
  '叙梦': 'xm', 'xm': 'xm',
  '双端': 'both', 'both': 'both', '双': 'both',
};
const OUTPUT_LABEL = { st: '酒馆', xm: '叙梦', both: '双端' };


/* 条目必备字段（照 ST 世界书导出；position/depth/probability 可在顶层或 extensions） */
const REQUIRED_FIELDS = ['uid', 'comment', 'key', 'content', 'constant', 'order'];
const DUAL_FIELDS = ['position', 'depth', 'probability'];
/* 范围表：0–100 / 0–10 */
const RANGES = [['probability', 0, 100], ['depth', 0, 10]];
/* 双轨位置字段；position 两轨差 5，另两个字段两轨同值 */
const POS_FIELDS = ['position', 'depth', 'probability'];
const POS_OFFSET = 5;
const POS_TOP_MIN = 5, POS_TOP_MAX = 10;
const POS_EXT_MIN = 0, POS_EXT_MAX = 7;
/* comment 命名规范：C<数字>.<数字> 名称 */
const COMMENT_RE = /^[A-Za-z]\d+(?:\.\d+)*\s+\S/;
/* 逐条罗列上限 */
const LIST_CAP = 20;

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null;
const num = (v) => (typeof v === 'number' ? v : (String(v).trim() === '' ? NaN : Number(v)));
const isNumeric = (v) => isFinite(num(v));
// 两轨值相等？两边都像数字就按数字比（ST 有的导出把 depth 写成 "4"）
function sameValue(a, b) {
  if (isNumeric(a) && isNumeric(b)) return num(a) === num(b);
  return String(a) === String(b);
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
  const opt = { json: false, help: false, target: null, flags: {}, output: null };
  for (const a of argv) {
    if (a === '--json') opt.json = true;
    else if (a === '--help' || a === '-h') opt.help = true;
    else if (a.startsWith('--输出端=') || a.startsWith('--platform=')) opt.output = a.slice(a.indexOf('=') + 1);
    else if (a.startsWith('--')) opt.flags[a.slice(2)] = true;
    else if (!opt.target) opt.target = a;
  }
  return opt;
}

function main(tool, usage, run) {
  const opt = parseArgv(process.argv.slice(2));
  if (opt.help) { console.log(usage); process.exit(0); }
  if (!opt.target) { console.error(usage); process.exit(2); }
  if (opt.output !== null && !OUTPUT_ALIAS[String(opt.output).trim()]) {
    console.error('输出端只认 酒馆 / 叙梦 / 双端（收到：' + opt.output + '）\n' + usage);
    process.exit(2);
  }
  const r = run(opt.target, opt);
  if (opt.json) console.log(JSON.stringify(r, null, 2));
  process.exit(r.exit);
}

/* --------------------------------- 体检 --------------------------------- */
function run(target, opt) {
  const mode = OUTPUT_ALIAS[String(opt.output || '酒馆').trim()] || 'st';
  const rep = createReporter(TOOL, target, opt);
  const t = commonHead(rep, TOOL, target);
  const srcs = entrySources(t);
  const all = [];
  for (const s of srcs) for (const e of s.entries) all.push({ e, src: s, label: comment(e) || 'uid ' + e.uid });
  const tag = (x) => (srcs.length > 1 ? x.src.name + ' · ' : '') + x.label;

  if (all.length === 0) {
    rep.fail('没找到任何条目：世界书 JSON 里没有 entries，卡片里也没有 data.character_book');
    return rep.finish();
  }
  rep.note('  世界书：' + srcs.map((s) => s.name + '（' + s.entries.length + ' 条）').join('、'));
  rep.note('  输出端：' + OUTPUT_LABEL[mode] + '（位置按这一端的规矩查；--输出端= 可改，见 05_输出端与平台.md）');

  /* ① 字段完整性 ------------------------------------------------------- */
  const missingCount = new Map();
  let missRows = 0;
  for (const x of all) {
    const et = x.e.extensions && typeof x.e.extensions === 'object' ? x.e.extensions : null;
    const miss = REQUIRED_FIELDS.filter((f) => !has(x.e, f));
    for (const f of DUAL_FIELDS) {
      if (!has(x.e, f) && !has(et, f)) miss.push(f);
    }
    if (!miss.length) continue;
    missRows++;
    for (const f of miss) missingCount.set(f, (missingCount.get(f) || 0) + 1);
    if (missRows <= LIST_CAP) {
      rep.fail('字段完整性：' + tag(x) + ' 缺 ' + miss.join('、') + '（ST 会给缺的字段塞默认值，实跑口径就不是你写的了）');
    }
  }
  if (missRows === 0) {
    rep.pass('字段完整性：' + all.length + ' 个条目九个字段齐全（' + REQUIRED_FIELDS.concat(DUAL_FIELDS).join('／') + '；位置三件可在顶层或 extensions）');
  } else if (missRows > LIST_CAP) {
    rep.hint('字段完整性：另有 ' + (missRows - LIST_CAP) + ' 个条目也缺字段未列出（共 ' + missRows + ' 条）');
  }
  if (missingCount.size) {
    rep.note('  缺得最多的字段：' + [...missingCount.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => f + ' ×' + n).join('、'));
  }

  /* ② 类型与范围 ------------------------------------------------------- */
  let rangeBad = 0;
  for (const x of all) {
    const et = x.e.extensions && typeof x.e.extensions === 'object' ? x.e.extensions : null;
    for (const [f, lo, hi] of RANGES) {
      const tracks = [['顶层', x.e], ['extensions', et]];
      for (const [where, obj] of tracks) {
        if (!obj || !has(obj, f)) continue;
        const v = num(obj[f]);
        if (!isFinite(v) || v < lo || v > hi) {
          rangeBad++;
          rep.fail('类型范围：' + tag(x) + ' 的 ' + (where === '顶层' ? f : where + '.' + f) + '＝' + JSON.stringify(obj[f]) + '（应为 ' + lo + '–' + hi + ' 的数字）');
        }
      }
    }
    if (has(x.e, 'order') && !isNumeric(x.e.order)) {
      rangeBad++;
      rep.fail('类型范围：' + tag(x) + ' 的 order＝' + JSON.stringify(x.e.order) + '（应为数字，注入顺序靠它排）');
    } else if (has(x.e, 'order') && typeof x.e.order !== 'number') {
      rep.hint('类型范围：' + tag(x) + ' 的 order 是字符串「' + x.e.order + '」，建议写纯数字');
    }
    if (has(x.e, 'constant') && typeof x.e.constant !== 'boolean') {
      rep.hint('类型范围：' + tag(x) + ' 的 constant＝' + JSON.stringify(x.e.constant) + '（应为 true/false）');
    }
  }
  if (rangeBad === 0) rep.pass('类型范围：probability 0–100、depth 0–10、order 数字，' + all.length + ' 个条目全部合规');

  /* ③ 位置双轨 --------------------------------------------------------- */
  let dualBad = 0, offTableTotal = 0;
  const solo = [], agree = [];
  for (const f of POS_FIELDS) {
    const onlyTop = [], onlyExt = [], same = [], diff = [], offTable = [];
    for (const x of all) {
      const et = x.e.extensions && typeof x.e.extensions === 'object' ? x.e.extensions : null;
      const top = has(x.e, f), ext = has(et, f);
      if (top && ext) {
        if (f === 'position') {
          // 位置是唯一「两端编号差 5」的字段：顶层＝叙梦档，extensions＝酒馆档。
          // 纯酒馆模式不比较两轨（酒馆只读 extensions，范围由 ③′ 查）。
          if (mode === 'st') continue;
          const tv = num(x.e[f]), ev = num(et[f]);
          if (isFinite(ev) && ev >= POS_EXT_MIN && ev <= 5 && isFinite(tv) && tv === ev + POS_OFFSET) {
            same.push({ x, a: x.e[f], b: et[f] });
          } else if (isFinite(ev) && (ev === 6 || ev === 7)) {
            offTable.push(x);
          } else {
            diff.push({ x, a: x.e[f], b: et[f], want: isFinite(ev) ? ev + POS_OFFSET : null });
          }
        } else {
          (sameValue(x.e[f], et[f]) ? same : diff).push({ x, a: x.e[f], b: et[f] });
        }
      } else if (top) onlyTop.push(x);
      else if (ext) onlyExt.push(x);
    }
    for (const d of diff) {
      dualBad++;
      if (dualBad <= LIST_CAP) {
        if (f === 'position') {
          rep.fail('位置双轨：' + tag(d.x) + ' 的 position 顶层＝' + JSON.stringify(d.a) + ' 与 extensions＝' + JSON.stringify(d.b) +
            ' 不是同槽位（叙梦档应比酒馆档大 ' + POS_OFFSET + '；顶层应为 ' + (d.want === null ? 'extensions + 5' : d.want) + '）');
        } else {
          rep.fail('位置双轨：' + tag(d.x) + ' 的 ' + f + ' 顶层＝' + JSON.stringify(d.a) + ' 与 extensions＝' + JSON.stringify(d.b) +
            ' 不一致（depth／probability 两轨必须同值）');
        }
      }
    }
    if (diff.length > LIST_CAP) rep.hint('位置双轨：另有 ' + (diff.length - LIST_CAP) + ' 条 ' + f + ' 两轨不一致未列出');
    for (let i = 0; i < offTable.length && i < LIST_CAP; i++) {
      rep.hint('位置双轨：' + tag(offTable[i]) + ' 的 extensions.position＝' + JSON.stringify(offTable[i].e.extensions.position) +
        '（酒馆新档位 6／7 不在 +5 对照表里，顶层请人工核对，不判必须修）');
    }
    offTableTotal += offTable.length;
    if (onlyTop.length || onlyExt.length) solo.push({ f, onlyTop, onlyExt });
    if (same.length && !diff.length && !onlyTop.length && !onlyExt.length) {
      agree.push(f + (f === 'position' ? ' 同槽位差 ' + POS_OFFSET + '：' + same.length + ' 条' : ' 两轨一致 ' + same.length + ' 条') +
        (offTable.length ? '（另有 ' + offTable.length + ' 条 extensions.position 6／7 不在对照表，已提示）' : ''));
    }
  }
  if (agree.length) rep.pass('位置双轨：' + agree.join(' · '));
  if (agree.length === 0 && dualBad === 0 && solo.length === 0 && offTableTotal === 0) {
    rep.pass('位置双轨：position／depth／probability 都没有两轨打架，也没有条目同时写两轨');
  }
  for (const s of solo) {
    if (s.f === 'position' && mode === 'xm' && s.onlyExt.length === 0) continue;   // 叙梦只写顶层＝正常
    if (s.f === 'position' && mode === 'st' && s.onlyTop.length === 0) continue;   // 酒馆只写 extensions＝正常
    const parts = [];
    if (s.onlyTop.length) parts.push('只写顶层 ' + s.onlyTop.length + ' 条');
    if (s.onlyExt.length) parts.push('只写 extensions ' + s.onlyExt.length + ' 条');
    rep.hint('位置双轨：' + s.f + ' ' + parts.join(' · ') + '；只写一轨也能跑，但另一端可能读不到，按输出端补齐');
  }

  /* ③′ 输出端形态（位置按哪一端的规矩查） ------------------------------- */
  let outBad = 0;
  const topPos = (x) => (has(x.e, 'position') ? num(x.e.position) : null);
  const extPos = (x) => {
    const et = x.e.extensions && typeof x.e.extensions === 'object' ? x.e.extensions : null;
    return et && has(et, 'position') ? num(et.position) : null;
  };
  const outFail = (msg) => { outBad++; if (outBad <= LIST_CAP) rep.fail(msg); };

  if (mode === 'xm') {
    // 叙梦读顶层：界面档位 5–10；extensions 若写，按酒馆档 0–7 查范围
    for (const x of all) {
      const v = topPos(x), e2 = extPos(x);
      if (v === null) {
        outFail('输出端（叙梦）：' + tag(x) + ' 没写顶层 position（叙梦只读顶层；只写 extensions 会落到默认位置）');
      } else if (!isFinite(v) || v < POS_TOP_MIN || v > POS_TOP_MAX) {
        outFail('输出端（叙梦）：' + tag(x) + ' 的顶层 position＝' + JSON.stringify(x.e.position) +
          '（叙梦界面档位是 5–10，顶层只认这个范围）');
      }
      if (e2 !== null && (!isFinite(e2) || e2 < POS_EXT_MIN || e2 > POS_EXT_MAX)) {
        outFail('输出端（叙梦）：' + tag(x) + ' 的 extensions.position＝' + JSON.stringify(x.e.extensions.position) +
          '（extensions 是酒馆档，只认 0–7）');
      }
    }
    if (outBad === 0) rep.pass('输出端（叙梦）：' + all.length + ' 条顶层都在 5–10；extensions 若写也在 0–7');
  } else if (mode === 'st') {
    let onlyTop = 0, onlyExt = 0;
    for (const x of all) {
      const v = topPos(x), e2 = extPos(x);
      if (v !== null && (!isFinite(v) || v < POS_TOP_MIN || v > POS_TOP_MAX)) {
        outFail('输出端（酒馆）：' + tag(x) + ' 的顶层 position＝' + JSON.stringify(x.e.position) +
          '（顶层按叙梦档写 5–10；纯酒馆卡建议只写 extensions）');
      }
      if (e2 !== null && (!isFinite(e2) || e2 < POS_EXT_MIN || e2 > POS_EXT_MAX)) {
        outFail('输出端（酒馆）：' + tag(x) + ' 的 extensions.position＝' + JSON.stringify(x.e.extensions.position) + '（酒馆档位只有 0–7）');
      }
      if (e2 !== null) onlyExt++;
      if (v !== null && e2 === null) onlyTop++;
    }
    if (onlyTop) rep.hint('输出端（酒馆）：' + onlyTop + ' 条只写了顶层 position，没写 extensions（酒馆读 extensions，运行时可能按默认位置；建议补 extensions）');
    if (outBad === 0) rep.pass('输出端（酒馆）：' + all.length + ' 条位置字段都在 5–10／0–7 的轨道范围内' + (onlyExt ? '；其中 ' + onlyExt + ' 条写了 extensions' : ''));
  } else {
    // 双端：顶层写叙梦档 5–10，extensions 写酒馆档 0–7，同槽位相差 5
    for (const x of all) {
      const v = topPos(x), e2 = extPos(x);
      if (v === null) {
        outFail('输出端（双端）：' + tag(x) + ' 没写顶层 position（叙梦那一端读不到）');
      } else if (!isFinite(v) || v < POS_TOP_MIN || v > POS_TOP_MAX) {
        outFail('输出端（双端）：' + tag(x) + ' 的顶层 position＝' + JSON.stringify(x.e.position) + '（叙梦档是 5–10）');
      }
      if (e2 === null) {
        outFail('输出端（双端）：' + tag(x) + ' 没写 extensions.position（酒馆那一端读不到）');
      } else if (!isFinite(e2) || e2 < POS_EXT_MIN || e2 > POS_EXT_MAX) {
        outFail('输出端（双端）：' + tag(x) + ' 的 extensions.position＝' + JSON.stringify(x.e.extensions.position) + '（酒馆档只有 0–7）');
      } else if (e2 <= 5 && v !== null && isFinite(v) && v !== e2 + POS_OFFSET) {
        outFail('输出端（双端）：' + tag(x) + ' 两轨不是同槽位（顶层 ' + v + ' / extensions ' + e2 + '，应满足顶层 = extensions + 5）');
      }
    }
    if (outBad === 0) rep.pass('输出端（双端）：' + all.length + ' 条两轨齐全、顶层 5–10、extensions 0–7，同槽位差 5');
  }
  if (outBad > LIST_CAP) rep.hint('输出端（' + OUTPUT_LABEL[mode] + '）：另有 ' + (outBad - LIST_CAP) + ' 条同类问题未列出');

  /* ④ comment 命名规范 -------------------------------------------------- */
  const badName = all.filter((x) => has(x.e, 'comment') && String(x.e.comment).trim() && !COMMENT_RE.test(String(x.e.comment).trim()));
  const emptyName = all.filter((x) => !has(x.e, 'comment') || !String(x.e.comment).trim());
  if (badName.length === 0 && emptyName.length === 0) {
    rep.pass('命名规范：' + all.length + ' 个条目都是「C<数字>.<数字> 名称」（例：' + tag(all[0]) + '）');
  } else {
    for (const x of badName.slice(0, LIST_CAP)) rep.hint('命名规范：' + tag(x) + ' 不合规（写成 C<数字>.<数字> 名称，例：C1.1 米拉）');
    for (const x of emptyName.slice(0, LIST_CAP)) rep.hint('命名规范：uid ' + x.e.uid + ' 的 comment 是空的（ST 列表里会看不见它）');
    const rest = badName.length + emptyName.length - Math.min(badName.length, LIST_CAP) - Math.min(emptyName.length, LIST_CAP);
    if (rest > 0) rep.hint('命名规范：另有 ' + rest + ' 条不合规未列出（共 ' + (badName.length + emptyName.length) + ' 条）');
  }

  /* ⑤ uid 重复 --------------------------------------------------------- */
  const byUid = new Map();
  for (const x of all) {
    if (!has(x.e, 'uid')) continue;
    const k = String(x.e.uid);
    if (!byUid.has(k)) byUid.set(k, []);
    byUid.get(k).push(x);
  }
  const dupUid = [...byUid.entries()].filter(([, list]) => list.length > 1);
  if (dupUid.length === 0) {
    rep.pass('uid：' + all.length + ' 个条目 uid 无重复（' + byUid.size + ' 个不同值）');
  } else {
    for (const [k, list] of dupUid) rep.fail('uid 重复：uid ' + k + ' 被 ' + list.length + ' 个条目共用（' + list.map(tag).join('、') + '）—— 改一个，别让 ST 自己撞');
  }

  /* 结构读数 ----------------------------------------------------------- */
  const consts = all.filter((x) => x.e.constant === true).length;
  const chars = noSpaceLen(all.map((x) => String(x.e.content || '')).join('\n'));
  rep.pass('结构读数：条目 ' + all.length + ' 条 · 常驻 ' + consts + ' 条 · 触发 ' + (all.length - consts) + ' 条 · 正文 ' + fmt(chars) + ' 字（去空白）');

  return rep.finish();
}

main(TOOL, USAGE, run);
