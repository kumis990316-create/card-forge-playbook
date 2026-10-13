/* ===========================================================================
 * build_card.js —— 出成品：把卡片 JSON ＋ 世界书 JSON 写进底图 PNG 的 chara 块
 * ---------------------------------------------------------------------------
 * 用法：node 工具/build_card.js <卡包目录> [--placeholder] [--json] [--name=<卡名>]
 *   --placeholder   底图不在时，就地生成一张 512×768 占位 PNG（不落盘，只在内存里用）
 *   --json          只打印摘要、**不写文件**
 *   --name=<卡名>   指定成品文件名（默认用 卡片里的 name）
 * 退出码：0 成功 / 1 出不了图（缺卡片 JSON、底图坏了……）/ 2 用法错。
 *
 * 读什么：
 *   <卡包>/01_卡片/*.json   —— 用 spec 字段认出卡片 JSON、用 entries 认出世界书 JSON
 *   <卡包>/02_源码/底图.png —— 底图（--placeholder 时不需要它）
 * 写什么：
 *   <卡包>/03_成品/<卡名>.png —— 底图 ＋ 一个 tEXt 块（关键字 chara、值＝base64(JSON)）
 *
 * 写进去的 JSON（ST 兼容形态：**v1 字段平铺在顶层，再拿 data 包一层**）：
 *   { name, description, personality, scenario, first_mes, mes_example, …,
 *     data: { name, description, …, character_book: <世界书 JSON 原样> } }
 * 世界书不做字段翻译（内嵌 v2 的 keys/enabled/insertion_order 是另一套名字，
 * 硬翻会悄悄改口径）；要内嵌形态就在 01_卡片 里直接放那种 JSON。
 *
 * 只用 Node 内置模块（zlib ＋ 手写 PNG 块与 CRC32），不装任何 npm 包。
 * 重新打包＝从底图重建，不在成品上叠块（同一张底图重复跑，结果一致）。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TOOL = 'build_card.js';
const USAGE = '用法：node 工具/build_card.js <卡包目录> [--placeholder] [--json] [--name=<卡名>]';

const CARD_DIR = '01_卡片';
const SRC_DIR = '02_源码';
const OUT_DIR = '03_成品';
const BASE_PNG = '底图.png';
const CHARA_KEY = 'chara';
const PLACEHOLDER_SIZE = [512, 768];

// v1 的七件套 ＋ v2 常平铺在顶层的字段：data 里有、顶层缺的，补到顶层去
const FLAT_FIELDS = [
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creatorcomment', 'avatar', 'talkativeness', 'fav', 'tags', 'create_date',
  'creator_notes', 'system_prompt', 'post_history_instructions', 'character_book',
  'alternate_greetings', 'group_only_greetings', 'extensions', 'character_version',
  'creator', 'spec', 'spec_version',
];

/* ------------------------------- PNG 读写 ------------------------------- */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
// 一个 PNG 块：长度(4) ＋ 类型(4) ＋ 数据 ＋ CRC(4)，CRC 覆盖「类型＋数据」
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function parsePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG（文件签名不对）');
  const chunks = [];
  let off = 8, ihdr = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 12 + len > buf.length) throw new Error('PNG 截断了：' + buf.toString('latin1', off + 4, off + 8));
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = Buffer.from(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IHDR') {
      if (data.length < 13) throw new Error('IHDR 长度不对');
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    }
    chunks.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG 里没有 IHDR');
  return { chunks, ...ihdr };
}

// 在 IHDR 之后插一个 tEXt 块；每个块都重算 CRC（也能顺手修掉来源文件里的坏 CRC）
function insertText(png, key, value) {
  const p = parsePng(png);
  const text = chunk('tEXt', Buffer.concat([Buffer.from(key + '\0', 'latin1'), Buffer.from(value, 'latin1')]));
  const out = [PNG_SIG];
  let placed = false;
  for (const c of p.chunks) {
    out.push(chunk(c.type, c.data));
    if (c.type === 'IHDR' && !placed) { out.push(text); placed = true; }
  }
  return { png: Buffer.concat(out), info: p };
}

// 读回 chara 块（成品自检用）
function readTextChunk(png, key) {
  const p = parsePng(png);
  for (const c of p.chunks) {
    if (c.type !== 'tEXt') continue;
    const z = c.data.indexOf(0);
    if (z < 0) continue;
    if (c.data.toString('latin1', 0, z) === key) return c.data.subarray(z + 1).toString('latin1');
  }
  return null;
}

// --placeholder：手写一张最小合法 PNG（8bit RGB、无隔行、filter 0）
function makePlaceholder(w, h) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 0;
    const t = h > 1 ? y / (h - 1) : 0;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      raw[i] = Math.round(34 + 86 * t);
      raw[i + 1] = Math.round(44 + 64 * t);
      raw[i + 2] = Math.round(56 + 88 * t);
    }
  }
  // 中间横一条浅带：一眼看出这是占位图，不会被误当正式底图
  const y0 = Math.floor(h * 0.46), y1 = Math.floor(h * 0.54);
  for (let y = y0; y < y1; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      raw[i] = 148; raw[i + 1] = 124; raw[i + 2] = 96;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------ 卡片 / 世界书 ------------------------------ */
const isCard = (j) => !!j && typeof j === 'object' && !Array.isArray(j) && !j.entries &&
  (typeof j.spec === 'string' || (!!j.data && typeof j.data === 'object') || typeof j.first_mes === 'string');
const isBook = (j) => !!j && typeof j === 'object' && !Array.isArray(j) && !!j.entries && typeof j.entries === 'object';
const entryCount = (j) => (Array.isArray(j.entries) ? j.entries.length : Object.keys(j.entries).length);
const cardName = (j) => String((j.data && j.data.name) || j.name || '').trim();
const bookName = (j) => String(j.name || '').trim();
// 卡名当文件名用：去掉路径分隔符等在文件名里不合法的字符
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '') || '未命名';

// ST 兼容形态：v1 字段平铺在顶层（顶层缺的从 data 补）＋ data 包一层
function buildPayload(card, book) {
  const data = (card.data && typeof card.data === 'object' && !Array.isArray(card.data)) ? Object.assign({}, card.data) : {};
  const payload = {};
  for (const k of Object.keys(card)) if (k !== 'data') payload[k] = card[k];
  for (const f of FLAT_FIELDS) if (payload[f] === undefined && data[f] !== undefined) payload[f] = data[f];
  if (book) data.character_book = book;
  payload.data = data;
  return payload;
}

/* --------------------------------- 出成品 --------------------------------- */
function run(packDir, opt) {
  const pack = path.resolve(String(packDir));
  const lines = [];
  const info = { tool: TOOL, pack, placeholder: !!opt.placeholder, json: !!opt.json, cards: [], books: [], outputs: [], ok: false, errors: [] };
  const say = (s) => { lines.push(s); if (!opt.json) console.log(s); };
  // 报告里只留读数与文件名，不倒出卡与条目的正文（--json 是摘要，不是搬运正文的通道）
  const strip = () => {
    info.cards = info.cards.map((c) => ({ rel: c.rel, name: cardName(c.json) || '未命名', spec: c.json.spec || null, topFields: Object.keys(c.json).length }));
    info.books = info.books.map((b) => ({ rel: b.rel, name: bookName(b.json) || '未命名', entries: entryCount(b.json) }));
  };
  const stop = (msg) => { info.errors.push(msg); say('  ✗ ' + msg); info.mustFix = 1; info.lines = lines; strip(); return info; };
  say('=== ' + TOOL + ' ===');
  say('卡包：' + pack);
  if (!fs.existsSync(pack) || !fs.statSync(pack).isDirectory()) return stop('卡包目录不存在：' + pack);

  // ① 扫 01_卡片/*.json，认出卡片与世界书
  const cardDir = path.join(pack, CARD_DIR);
  const files = fs.existsSync(cardDir) ? fs.readdirSync(cardDir).filter((f) => /\.json$/i.test(f)).sort() : [];
  if (!files.length) return stop('没找到卡片 JSON：' + path.join(CARD_DIR, '*.json') + ' 里要有带 spec 字段的卡片 JSON');
  for (const f of files) {
    const rel = path.join(CARD_DIR, f);
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(cardDir, f), 'utf8')); }
    catch (e) { say('  ! ' + rel + '：JSON 解析失败，跳过（' + e.message + '）'); continue; }
    if (isBook(j)) { info.books.push({ rel, json: j }); say('  世界书：' + rel + '（' + (bookName(j) || '未命名') + ' · ' + entryCount(j) + ' 条）'); }
    else if (isCard(j)) { info.cards.push({ rel, json: j }); say('  卡片：' + rel + '（name=' + (cardName(j) || '未命名') + ' · spec=' + (j.spec || '无') + '）'); }
    else say('  ! ' + rel + '：既没有 spec 也没有 entries，认不出是卡片还是世界书，跳过');
  }
  if (!info.cards.length) return stop('没认出任何卡片 JSON（卡片的标志是 spec 字段，或 data 外壳 / first_mes）');

  // ② 底图
  let png = null;
  const basePath = path.join(pack, SRC_DIR, BASE_PNG);
  if (fs.existsSync(basePath)) {
    png = fs.readFileSync(basePath);
    try {
      const p = parsePng(png);
      info.base = { rel: path.join(SRC_DIR, BASE_PNG), w: p.w, h: p.h, bitDepth: p.bitDepth, colorType: p.colorType, interlace: p.interlace, bytes: png.length };
      say('  底图：' + info.base.rel + '（' + p.w + '×' + p.h + ' · ' + p.bitDepth + 'bit · colorType ' + p.colorType + ' · ' + png.length + ' 字节）');
      if (p.bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(p.colorType)) say('  ! 底图不是常见的 8bit RGB/RGBA：本脚本只原样搬运像素，不转码');
      if (p.interlace) say('  ! 底图是隔行（Adam7）PNG：本脚本只加 tEXt 块，不动像素');
      if (p.w < 400 || p.h < 600) say('  ! 底图只有 ' + p.w + '×' + p.h + '：ST 角色卡一般用 400×600 或更大');
    } catch (e) {
      return stop('底图不是能读的 PNG：' + basePath + ' —— ' + e.message);
    }
  } else if (opt.placeholder) {
    png = makePlaceholder(PLACEHOLDER_SIZE[0], PLACEHOLDER_SIZE[1]);
    info.base = { rel: '（--placeholder 生成，不落盘）', w: PLACEHOLDER_SIZE[0], h: PLACEHOLDER_SIZE[1], bitDepth: 8, colorType: 2, interlace: 0, bytes: png.length };
    say('  ! 底图不在（' + path.join(SRC_DIR, BASE_PNG) + '），用 --placeholder 现生成一张 ' + PLACEHOLDER_SIZE.join('×') + ' 占位图');
  } else {
    return stop('底图不在：' + basePath + '（要空跑就先放一张进去，或加 --placeholder）');
  }

  // ③ 逐张卡片出图
  if (opt.name && info.cards.length > 1) return stop('--name= 只能配一张卡片用，这个卡包里有 ' + info.cards.length + ' 张');
  const outDir = path.join(pack, OUT_DIR);
  if (!opt.json) fs.mkdirSync(outDir, { recursive: true });

  for (const c of info.cards) {
    const name = safeName(opt.name || cardName(c.json));
    if (!name || name === '未命名') return stop('卡片 ' + c.rel + ' 里没有 name，做不出「<卡名>.png」（可以用 --name=<卡名> 指定）');
    // 世界书配对：名字带同一卡名的优先，只有一本就直接用，其它情况从宽
    let book = null;
    if (info.books.length === 1) book = info.books[0];
    else if (info.books.length > 1) book = info.books.find((b) => bookName(b.json).includes(name)) || info.books[0];
    if (info.books.length > 1) say('  ! 卡包里有 ' + info.books.length + ' 本世界书，' + name + ' 配的是「' + (book ? bookName(book.json) : '没配到') + '」——多本时请一本一个卡包');

    const payload = buildPayload(c.json, book ? book.json : null);
    const json = JSON.stringify(payload);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    const flat = FLAT_FIELDS.filter((f) => payload[f] !== undefined);
    const outRel = path.join(OUT_DIR, name + '.png');
    const rec = { card: c.rel, name, book: book ? { rel: book.rel, name: bookName(book.json), entries: entryCount(book.json) } : null, out: outRel, jsonBytes: Buffer.byteLength(json), base64Bytes: b64.length, flatFields: flat.length };
    info.outputs.push(rec);

    say('  成品：' + outRel + ' · 写入 JSON ' + rec.jsonBytes + ' 字节 → base64 ' + b64.length + ' 字节');
    say('  打包形态：v1 字段平铺 ' + flat.length + ' 个（' + flat.slice(0, 6).join('、') + (flat.length > 6 ? '…' : '') + '）＋ data 一层' +
      (book ? '，世界书原样进 data.character_book（' + entryCount(book.json) + ' 条）' : '，没有配到世界书'));

    if (opt.json) continue;
    const built = insertText(png, CHARA_KEY, b64);
    fs.writeFileSync(path.join(pack, outRel), built.png);

    // 自检：把写出去的成品重新读一遍，chara → base64 → JSON
    const back = readTextChunk(fs.readFileSync(path.join(pack, outRel)), CHARA_KEY);
    if (!back) return stop('写出去的成品里读不到 chara 块：' + outRel);
    let backOk = false, backInfo = '';
    try {
      const backJson = JSON.parse(Buffer.from(back, 'base64').toString('utf8'));
      backOk = backJson.name === payload.name || (backJson.data && backJson.data.name === payload.name);
      backInfo = 'spec=' + (backJson.spec || '无') + ' · name=' + (backJson.name || '无') +
        ' · 顶层字段 ' + Object.keys(backJson).length + ' 个 · data 字段 ' + Object.keys(backJson.data || {}).length + ' 个';
    } catch (e) { backInfo = '解不回 JSON：' + e.message; }
    if (!backOk) return stop('读回来的 chara 不是同一张卡：' + outRel + '（' + backInfo + '）');
    rec.bytes = fs.statSync(path.join(pack, outRel)).size;
    say('  ✓ 成品 ' + rec.bytes + ' 字节 · chara 块关键字 ' + CHARA_KEY + ' · base64 ' + b64.length + ' 字节');
    say('  ✓ 往返自检：chara → base64 → JSON 解回来了（' + backInfo + '）');
  }

  info.ok = true;
  if (opt.json) {
    // --json 只打印摘要（不写文件），把「本来会写出什么」报清楚
    for (const r of info.outputs) delete r.bytes;
    say('  只打印摘要（--json）：没有写任何文件');
  } else {
    say('  ✓ 完成：' + info.outputs.map((r) => r.out).join('、'));
  }
  info.lines = lines;
  delete info.notes;
  delete info.mustFix;
  strip();
  return info;
}

/* --------------------------------- 入口 --------------------------------- */
const argv = process.argv.slice(2);
const opt = { placeholder: false, json: false, name: null, target: null, help: false };
for (const a of argv) {
  if (a === '--placeholder') opt.placeholder = true;
  else if (a === '--json') opt.json = true;
  else if (a.startsWith('--name=')) opt.name = a.slice('--name='.length).trim();
  else if (a === '--help' || a === '-h') opt.help = true;
  else if (!a.startsWith('--') && !opt.target) opt.target = a;
}
if (opt.help) { console.log(USAGE); process.exit(0); }
if (!opt.target) { console.error(USAGE); process.exit(2); }
const result = run(opt.target, opt);
if (opt.json) console.log(JSON.stringify(result, null, 2));
if (result.errors.length) console.error('出不了图：' + result.errors.join('；'));
process.exit(result.ok ? 0 : 1);
