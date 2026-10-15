/* ===========================================================================
 * export_json.js —— 出「导入用 JSON」：从成品 PNG 的 chara 块解回，原样落一份 .json
 * ---------------------------------------------------------------------------
 * 为什么要有这一步：卡片 JSON 从平台导入时，世界书必须是**合并进来的**那一段。
 * 源件 `01_卡片/<名>_卡片.json` 里的 `data.character_book` 往往是空壳（entries: []），
 * 世界书是 `build_card.js` 出图时才合并进去的 —— 所以「直接把源件发过去」发出去的
 * 是一张能开场、却没有任何规则的空卡（所有检查器都会放过它，因为源件本身没坏）。
 *
 * 本脚本的做法：从**成品 PNG 的 chara 块**解回字节，原样写成 JSON。
 * 不另拼一份 —— 那正是平台从 PNG 里读到的字节，两者语义必然一致，不会各拼各的拼歪。
 * 代价是必须先跑过 `build_card.js`（`rebuild_all` 那类总脚本要把顺序排好）。
 *
 * 用法：
 *   node 工具/export_json.js <卡包目录> [--png=<成品.png>] [--out=<文件>] [--json]
 *     --png=<路径>   指定读哪张成品 PNG（默认在 <卡包>/03_成品/ 里找）
 *     --out=<路径>   指定写出的 JSON（默认 <卡包>/03_成品/<卡名>_导入用.json）
 *     --json         只打印摘要、不写文件
 *   node 工具/export_json.js --check <某份.json>
 *     只对一份已经拿到的 JSON 跑自检、不写任何东西（用来验证别人发来的件）
 *
 * 退出码：0 通过 / 1 自检不过 / 2 用法错。
 * 只用 Node 内置模块，零依赖；路径一律相对卡包，不写死任何绝对路径。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOOL = 'export_json.js';
const USAGE = [
  '用法：',
  '  node 工具/export_json.js <卡包目录> [--png=<成品.png>] [--out=<文件>] [--json]',
  '  node 工具/export_json.js --check <某份.json>',
].join('\n');

const OUT_DIR = '03_成品';
const CHARA_KEY = 'chara';
const SUFFIX = '_导入用.json';

// 与 build_card.js 同一张表：顶层与 data 里都可能有、且应当一致的字段
const FLAT_FIELDS = [
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creatorcomment', 'avatar', 'talkativeness', 'fav', 'tags', 'create_date',
  'creator_notes', 'system_prompt', 'post_history_instructions', 'character_book',
  'alternate_greetings', 'group_only_greetings', 'extensions', 'character_version',
  'creator', 'spec', 'spec_version',
];
// 没有这几样，导入之后要么没名字、要么开不了场
const NEEDED = ['name', 'description', 'first_mes'];
// 这几样两层必须逐字一致：有的前端读顶层那份，有的读 data 那份，不一致就是「导入后两个样」
const CORE = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];

/* --------------------------------- 小工具 --------------------------------- */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha8 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8).toUpperCase();
const bytes = (n) => n.toLocaleString('en-US');
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '') || '未命名';
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const entryCount = (book) => {
  if (!isObj(book) || !isObj(book.entries)) return 0;
  return Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries).length;
};

// 扫 PNG 块，取某个 tEXt 关键字的值（原样字符串）
function readTextChunk(buf, key) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG（文件签名不对）');
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 12 + len > buf.length) throw new Error('PNG 截断了：' + buf.toString('latin1', off + 4, off + 8));
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z >= 0 && data.toString('latin1', 0, z) === key) return data.subarray(z + 1).toString('latin1');
    }
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return null;
}

/* --------------------------------- 自检 ---------------------------------
 * 六项：规格、入口字段、世界书非空、世界书名对得上、两层同名字段一致、与来源 PNG 逐字节一致
 * 返回 { mustFix: [...], notes: [...], facts: {...} }
 * ------------------------------------------------------------------------ */
function selfCheck(j, raw) {
  const mustFix = [];
  const notes = [];
  const facts = {};

  if (!isObj(j)) { mustFix.push('顶层不是 JSON 对象（导入件应当是一份对象）'); return { mustFix, notes, facts }; }

  // ① 规格
  facts.spec = j.spec || '（没有 spec 字段）';
  if (j.spec !== 'chara_card_v2') mustFix.push('spec 不是 chara_card_v2（拿到的是：' + facts.spec + '）—— 多半不是卡片 JSON，而是世界书或别的件');

  // ② 入口字段
  const has = (f) => (j[f] !== undefined && String(j[f]).trim() !== '') ||
    (isObj(j.data) && j.data[f] !== undefined && String(j.data[f]).trim() !== '');
  const missing = NEEDED.filter((f) => !has(f));
  facts.name = String(j.name || (isObj(j.data) && j.data.name) || '').trim();
  if (missing.length) mustFix.push('缺入口字段：' + missing.join('、') + '（导入之后要么没名字、要么开不了场）');

  // ③ 世界书必须已经合并进来
  const book = (isObj(j.data) && isObj(j.data.character_book)) ? j.data.character_book : null;
  const n = entryCount(book);
  facts.entries = n;
  facts.bookName = book ? String(book.name || '').trim() : '';
  if (!book) mustFix.push('data.character_book 整段不在：导入件里没有规则（世界书没合并进来）');
  else if (n === 0) mustFix.push('data.character_book.entries 是空的：导入件里没有规则（世界书没合并进来）');
  else notes.push('世界书 ' + n + ' 条已合并进 data.character_book');

  // ④ 世界书名与 extensions.world 对得上
  const worldRef = (isObj(j.extensions) && String(j.extensions.world || '').trim()) ||
    (isObj(j.data) && isObj(j.data.extensions) && String(j.data.extensions.world || '').trim()) || '';
  facts.worldRef = worldRef || null;
  if (worldRef && facts.bookName && worldRef !== facts.bookName) {
    mustFix.push('世界书名对不上：extensions.world 是「' + worldRef + '」，data.character_book.name 是「' + facts.bookName + '」');
  }

  // ⑤ 顶层与 data 两层：核心六件必须逐字一致（前端读哪一层不定）；其余不同只提示
  const data = isObj(j.data) ? j.data : {};
  const diffCore = [];
  const diffOther = [];
  let same = 0;
  for (const f of FLAT_FIELDS) {
    if (j[f] === undefined || data[f] === undefined) continue;
    if (JSON.stringify(j[f]) === JSON.stringify(data[f])) { same++; continue; }
    if (CORE.includes(f)) diffCore.push(f); else diffOther.push(f);
  }
  facts.sameFields = same;
  facts.diffOther = diffOther;
  if (diffCore.length) mustFix.push('核心字段两层不一致：' + diffCore.join('、') + '（顶层与 data 各写了一份，导入后可能两个样；改成同值再重出成品）');
  if (diffOther.length) {
    const extra = diffOther.map((f) => (f === 'character_book' ? 'character_book（顶层是源件形态、世界书是空的；导入读的是 data 那一层，成品本来就这样）' : f));
    notes.push('另有 ' + diffOther.length + ' 个字段两层不同：' + extra.join('、') + '（多为 v1/v2 兼容镜像，不影响导入）');
  }
  if (same && !diffCore.length && !diffOther.length) notes.push('两层同名字段 ' + same + ' 个逐字一致');

  // ⑥ 与来源 PNG 的 chara 块逐字节一致（只在从 PNG 走这条路时有）
  if (raw) {
    const back = Buffer.from(raw.b64, 'base64');
    facts.sameAsPng = back.equals(raw.bytes);
    if (!facts.sameAsPng) mustFix.push('落盘的字节与 PNG 里 chara 块的字节不一致（base64 往返没有对上）');
    else notes.push('与来源 PNG 的 chara 块逐字节一致');
  }

  return { mustFix, notes, facts };
}

/* ------------------------------ 从 PNG 到 JSON ------------------------------ */
function run(packDir, opt) {
  const pack = path.resolve(String(packDir));
  const lines = [];
  const info = { tool: TOOL, pack, ok: false, mustFix: 0, notes: 0, errors: [], out: null };
  const say = (s) => { lines.push(s); if (!opt.json) console.log(s); };
  const stop = (msg) => { info.errors.push(msg); say('  ✗ ' + msg); info.mustFix = 1; info.lines = lines; return info; };

  say('=== ' + TOOL + ' ===');
  say('卡包：' + pack);
  if (!fs.existsSync(pack) || !fs.statSync(pack).isDirectory()) return stop('卡包目录不存在：' + pack);

  // 找成品 PNG
  let pngPath = opt.png ? path.resolve(pack, opt.png) : null;
  if (pngPath) {
    if (!fs.existsSync(pngPath)) return stop('--png= 指的文件不在：' + pngPath);
  } else {
    const dir = path.join(pack, OUT_DIR);
    if (!fs.existsSync(dir)) return stop('没有 ' + OUT_DIR + '/ 目录：先跑 node 工具/build_card.js <卡包目录>');
    const list = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
    if (!list.length) return stop(OUT_DIR + '/ 里没有 PNG：先跑 node 工具/build_card.js <卡包目录>');
    if (list.length > 1) {
      say('  ! ' + OUT_DIR + '/ 里有 ' + list.length + ' 张 PNG（' + list.join('、') + '），按名字排序取第一张；要指定就用 --png=');
    }
    pngPath = path.join(dir, list[0]);
  }
  const pngBuf = fs.readFileSync(pngPath);
  const relPng = path.relative(pack, pngPath) || pngPath;
  info.png = { rel: relPng, bytes: pngBuf.length };

  // 解 chara 块
  let b64 = null;
  try { b64 = readTextChunk(pngBuf, CHARA_KEY); }
  catch (e) { return stop('PNG 读不了：' + relPng + ' —— ' + e.message); }
  if (!b64) return stop('这张 PNG 里没有 tEXt 块「' + CHARA_KEY + '」：它不是本库出的成品（或是在别的工具里做过、把块弄丢了）');
  let jsonBytes = null, j = null;
  try {
    jsonBytes = Buffer.from(b64, 'base64');
    j = JSON.parse(jsonBytes.toString('utf8'));
  } catch (e) { return stop('chara 块解不回 JSON：' + e.message); }
  const name = safeName(String(j.name || (isObj(j.data) && j.data.name) || ''));
  say('  来源：' + relPng + '（' + bytes(pngBuf.length) + ' 字节）· chara 块 base64 ' + bytes(b64.length) + ' 字节 → JSON ' + bytes(jsonBytes.length) + ' 字节');
  say('  卡名：' + (name === '未命名' ? '（卡片里没有 name）' : name));

  // 自检
  const res = selfCheck(j, { b64, bytes: jsonBytes });
  info.mustFix = res.mustFix.length;
  info.notes = res.notes.length;
  info.facts = res.facts;
  for (const n of res.notes) say('  ! ' + n);
  for (const m of res.mustFix) say('  ✗ ' + m);
  say('  === 结论：' + res.mustFix.length + ' 必须修 / ' + res.notes.length + ' 提示 ===');
  if (res.mustFix.length) { info.errors.push('自检不过，没有写出导入件'); info.lines = lines; return info; }

  // 落盘：**原样**写 PNG 里那份字节，不重新序列化
  const outPath = opt.out ? path.resolve(pack, opt.out) : path.join(pack, OUT_DIR, name + SUFFIX);
  info.out = { rel: path.relative(pack, outPath) || outPath, bytes: jsonBytes.length, sha8: sha8(jsonBytes), entries: res.facts.entries };
  if (opt.json) {
    say('  只打印摘要（--json）：没有写任何文件；本来会写到 ' + info.out.rel);
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, jsonBytes);
    const back = fs.readFileSync(outPath);
    if (!back.equals(jsonBytes) || sha8(back) !== info.out.sha8) return stop('写出后回读的指纹对不上：' + info.out.rel);
    say('  写出：' + info.out.rel + '（' + bytes(back.length) + ' 字节 · sha8 ' + info.out.sha8 + ' · 世界书 ' + res.facts.entries + ' 条）');
    say('  ✓ 回读自检：字节与 PNG 里 chara 块一致');
  }
  info.ok = true;
  info.lines = lines;
  return info;
}

/* --------------------------- --check：只查一份 JSON --------------------------- */
function checkFile(file, opt) {
  const p = path.resolve(String(file));
  const lines = [];
  const info = { tool: TOOL, mode: 'check', file: p, ok: false, mustFix: 0, notes: 0, errors: [] };
  const say = (s) => { lines.push(s); if (!opt.json) console.log(s); };
  say('=== ' + TOOL + ' --check ===');
  say('文件：' + p);
  if (!fs.existsSync(p)) { info.errors.push('文件不在：' + p); say('  ✗ 文件不在：' + p); info.mustFix = 1; info.lines = lines; return info; }
  const buf = fs.readFileSync(p, 'utf8');
  let j = null;
  try { j = JSON.parse(buf); }
  catch (e) { info.errors.push('JSON 解析失败：' + e.message); say('  ✗ JSON 解析失败：' + e.message); info.mustFix = 1; info.lines = lines; return info; }
  const res = selfCheck(j, null);
  info.mustFix = res.mustFix.length;
  info.notes = res.notes.length;
  info.facts = res.facts;
  for (const n of res.notes) say('  ! ' + n);
  for (const m of res.mustFix) say('  ✗ ' + m);
  say('  === 结论：' + res.mustFix.length + ' 必须修 / ' + res.notes.length + ' 提示 ===');
  info.ok = res.mustFix.length === 0;
  if (!info.ok) info.errors.push('这份件不能直接当导入件用');
  info.lines = lines;
  return info;
}

/* --------------------------------- 入口 --------------------------------- */
const argv = process.argv.slice(2);
const opt = { json: false, png: null, out: null, check: null, target: null, help: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--check') { opt.check = argv[++i] || null; }
  else if (a.startsWith('--check=')) opt.check = a.slice('--check='.length).trim();
  else if (a === '--json') opt.json = true;
  else if (a.startsWith('--png=')) opt.png = a.slice('--png='.length).trim();
  else if (a.startsWith('--out=')) opt.out = a.slice('--out='.length).trim();
  else if (a === '--help' || a === '-h') opt.help = true;
  else if (!a.startsWith('--') && !opt.target) opt.target = a;
}
if (opt.help) { console.log(USAGE); process.exit(0); }
if (opt.check) {
  if (!opt.check.trim()) { console.error(USAGE); process.exit(2); }
  const r = checkFile(opt.check, opt);
  if (opt.json) console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
if (!opt.target) { console.error(USAGE); process.exit(2); }
const result = run(opt.target, opt);
if (opt.json) console.log(JSON.stringify(result, null, 2));
if (result.errors.length) console.error('出不了导入件：' + result.errors.join('；'));
process.exit(result.ok ? 0 : 1);
