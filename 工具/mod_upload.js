/* ===========================================================================
 * mod_upload.js：把一份 MOD 包批量上传到叙梦（narochat.com）
 * ---------------------------------------------------------------------------
 * 为什么有这个脚本：叙梦的 MOD 编辑器不支持导入 JSON，世界书等条目只能
 * 在网页里一段一段复制，条目一多就是纯手工体力活。本脚本把整包条目一次
 * 发到平台的更新接口，发完立刻回读校验。
 *
 * 用法：
 *   node 工具/mod_upload.js --list
 *   node 工具/mod_upload.js --pack mod_pack.json --mod <modId> --dry-run
 *   node 工具/mod_upload.js --pack mod_pack.json --mod <modId> --apply --yes
 *
 * 环境变量（不写进任何文件）：
 *   NARO_TOKEN   主凭证，填 DevTools 里 Authorization 头的值（Bearer ... 或裸 token）
 *   NARO_COOKIE  可选，整条 Cookie 头；实测只发 Cookie 会 401，所以主凭证是上一个
 *
 * 退出码：0 成功；1 网络或接口错误；2 用法错误、缺少 --yes、或回读校验不一致。
 * 依赖：Node 18+ 自带的 http/https/net/tls 模块，零 npm 依赖。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const BASE = 'https://narochat.com';
const HOST = 'narochat.com';
const API = BASE + '/fox/api';
const USAGE = [
  '用法：',
  '  node 工具/mod_upload.js --list',
  '  node 工具/mod_upload.js --pack mod_pack.json --mod <modId> --dry-run',
  '  node 工具/mod_upload.js --pack mod_pack.json --mod <modId> --apply --yes',
  '  node 工具/mod_upload.js --pack mod_pack.json --mod <modId> --apply --yes --allow-published',
  '',
  '不带 --apply 时默认就是 --dry-run，不会发写请求。',
  '--apply 必须再加 --yes 才会真的写。',
  '已上架件（purchaseCount > 0）还要再加 --allow-published，否则直接拒绝。',
].join('\n');

// 已实测的四类条目：字段名来自 /fox/api/mods/mine 的真实返回。
// 另外三类编辑器条目（作者助手、自动总结、自定义 CSS）接口字段名未实测，
// 只能走 raw 原样透传，见 normalizeEntry()。
const FRIENDLY_TYPES = ['worldBook', 'systemPrompt', 'historyInstructions', 'regex'];
const RAW_ONLY_TYPES = ['authorAssistant', 'autoSummaryPrompt', 'customCss', 'customCSS'];
const TYPE_ORDER = FRIENDLY_TYPES.concat(RAW_ONLY_TYPES);

class UserError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 1;
  }
}

function fail(message, code) {
  throw new UserError(message, code || 1);
}

function parseArgs(argv) {
  const opt = {
    list: false,
    apply: false,
    dryRun: false,
    yes: false,
    pack: null,
    mod: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opt.list = true;
    else if (a === '--apply') opt.apply = true;
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--yes' || a === '-y') opt.yes = true;
    else if (a === '--allow-published') opt.allowPublished = true;
    else if (a === '--help' || a === '-h') opt.help = true;
    else if (a === '--pack') {
      opt.pack = argv[++i];
      if (!opt.pack) fail('--pack 后面要跟包文件路径。', 2);
    } else if (a.startsWith('--pack=')) {
      opt.pack = a.slice('--pack='.length);
    } else if (a === '--mod') {
      opt.mod = argv[++i];
      if (!opt.mod) fail('--mod 后面要跟 MOD id。', 2);
    } else if (a.startsWith('--mod=')) {
      opt.mod = a.slice('--mod='.length);
    } else {
      fail('看不懂参数：' + a + '\n\n' + USAGE, 2);
    }
  }
  if (opt.list && (opt.apply || opt.pack || opt.mod)) {
    fail('--list 只列账号下的 MOD，不要和 --pack/--mod/--apply 一起用。', 2);
  }
  if (opt.apply && opt.dryRun) fail('--apply 和 --dry-run 只能二选一。', 2);
  if (!opt.list && !opt.apply && !opt.help) opt.dryRun = true;
  return opt;
}

function authHeaders() {
  const token = String(process.env.NARO_TOKEN || '').trim();
  const cookie = String(process.env.NARO_COOKIE || '').trim();
  if (!token && !cookie) {
    fail([
      '缺少凭证，先设环境变量再跑。获取步骤：',
      '  1. 浏览器登录 https://narochat.com，按 F12 打开 DevTools，切到 Network。',
      '  2. 过滤框输入 fox/api，点任意一条 /fox/api/ 请求。',
      '  3. Request Headers 里找 Authorization，复制它的值（形如 Bearer 你的token）。',
      '  4. PowerShell 里执行：$env:NARO_TOKEN="Bearer 你的token"',
      '',
      '说明：实测只发 Cookie 会返回 401（AUTH_1001），所以主凭证是 NARO_TOKEN。',
      'NARO_COOKIE 仍可设，设了会一并带上，但不要把两个变量写进任何文件。',
    ].join('\n'), 2);
  }
  // 平台前置的防护会拦 Node 默认 UA（实测直发返回 451），这里带浏览器同款头。
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Origin: BASE,
    Referer: BASE + '/',
  };
  if (token) headers.Authorization = /^Bearer\s/i.test(token) ? token : 'Bearer ' + token;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

let proxyCache = null;
let proxyChecked = false;

function parseProxy(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    fail('代理地址格式不对，请写成 http://127.0.0.1:17891 这种形式。', 1);
  }
  if (u.protocol !== 'http:') {
    fail('目前只支持 HTTP 代理（http://host:port），不支持 ' + u.protocol, 1);
  }
  const port = Number(u.port || 80);
  if (!u.hostname || !port) fail('代理地址缺少 host 或 port。', 1);
  const auth = u.username
    ? u.username + ':' + decodeURIComponent(u.password || '')
    : null;
  return { host: u.hostname, port, auth };
}

function detectProxy() {
  if (proxyChecked) return proxyCache;
  proxyChecked = true;
  if (process.env.NARO_NO_PROXY === '1') return null;

  for (const k of ['NARO_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    if (process.env[k]) {
      proxyCache = parseProxy(process.env[k]);
      return proxyCache;
    }
  }

  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ], { encoding: 'utf8', windowsHide: true });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out);
      const m = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
      if (enabled && m) {
        let raw = m[1].trim();
        if (raw.includes('=')) {
          const map = {};
          for (const part of raw.split(';')) {
            const i = part.indexOf('=');
            if (i > 0) map[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
          }
          raw = map.https || map.http || '';
        }
        if (raw) proxyCache = parseProxy(raw);
      }
    } catch (e) {
      proxyCache = null;
    }
  }
  return proxyCache;
}

function bypassProxy(host) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!raw) return false;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((p) => {
    if (p === '*') return true;
    p = p.replace(/^\./, '');
    return host === p || host.endsWith('.' + p);
  });
}

function connectTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = net.connect({ host: proxy.host, port: proxy.port });
    } catch (e) {
      reject(e);
      return;
    }
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('代理 CONNECT 超时'));
    }, 15000);
    const failOnce = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    };
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0 || settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      const status = buf.slice(0, idx).split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200/.test(status)) {
        socket.destroy();
        reject(new Error('代理拒绝 CONNECT：' + status));
        return;
      }
      const t = tls.connect({ socket, servername: host }, () => resolve(t));
      t.on('error', (e) => reject(e));
    };
    socket.on('data', onData);
    socket.on('error', failOnce);
    socket.on('close', () => {
      if (!settled) failOnce(new Error('代理连接被关闭'));
    });
    let head = 'CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n';
    if (proxy.auth) head += 'Proxy-Authorization: Basic ' + Buffer.from(proxy.auth).toString('base64') + '\r\n';
    head += '\r\n';
    socket.write(head);
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve(text));
    res.on('error', reject);
  });
}

async function request(method, apiPath, body) {
  const headers = authHeaders();
  let payload = null;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  const proxy = detectProxy();
  const useProxy = proxy && !bypassProxy(HOST);
  let tunnel = null;
  if (useProxy) {
    try {
      tunnel = await connectTunnel(proxy, HOST, 443);
    } catch (e) {
      fail('连代理失败：' + (e && e.message ? e.message : String(e)) +
        '\n如果浏览器能上叙梦、只有脚本不行，可显式设 NARO_PROXY=http://127.0.0.1:端口；' +
        '不走代理就设 NARO_NO_PROXY=1。', 1);
    }
    headers.Host = HOST;
  }

  const transport = tunnel ? http : https;
  const options = { host: HOST, port: 443, path: '/fox/api' + apiPath, method, headers, timeout: 30000 };
  if (tunnel) {
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => tunnel;
    options.agent = agent;
  }

  let res;
  try {
    res = await new Promise((resolve, reject) => {
      const req = transport.request(options, resolve);
      req.setTimeout(30000, () => req.destroy(new Error('请求超时（30 秒）')));
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  } catch (e) {
    fail('网络请求失败：' + (e && e.message ? e.message : String(e)) +
      '\n检查网络、代理与 NARO_TOKEN 是否过期。', 1);
  }

  const text = await readBody(res);
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.statusCode, json, text };
}

function apiError(payload) {
  if (!payload || !payload.json) return '';
  const j = payload.json;
  const msg = (j.error && (j.error.message || j.error.code)) || j.message || j.msg;
  return msg ? String(msg).slice(0, 300) : '';
}

function statusHint(status) {
  if (status === 451) {
    return '\n提示：451 是地区限制。浏览器能打开而脚本不能，多半是流量没走代理；' +
      'Windows 会自动读系统代理，其他系统可设 NARO_PROXY=http://127.0.0.1:端口。';
  }
  if (status === 401) return '\n提示：NARO_TOKEN 过期或没带上，重新从 DevTools 复制 Authorization 的值。';
  return '';
}

async function getMine() {
  const r = await request('GET', '/mods/mine');
  if (r.status !== 200) {
    fail('读取 MOD 列表失败：HTTP ' + r.status + (apiError(r) ? '：' + apiError(r) : '') + statusHint(r.status), 1);
  }
  if (!Array.isArray(r.json)) {
    fail('读取 MOD 列表失败：/fox/api/mods/mine 没有返回裸数组（平台接口可能改版）。', 1);
  }
  return r.json;
}

function modIdOf(m) {
  return String((m && (m._id || m.id)) || '');
}

function findMod(mods, id) {
  const want = String(id);
  return mods.find((m) => modIdOf(m) === want) || null;
}

function loadPack(file) {
  if (!file) fail('缺少 --pack <包文件>。', 2);
  const abs = path.resolve(process.cwd(), file);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    fail('读不到包文件：' + abs + '\n' + (e && e.message ? e.message : String(e)), 2);
  }
  let pack;
  try {
    pack = JSON.parse(raw);
  } catch (e) {
    fail('包文件不是合法 JSON：' + abs + '\n' + (e && e.message ? e.message : String(e)), 2);
  }
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    fail('包文件顶层必须是对象：{ name?, description?, entries: [...] }。', 2);
  }
  if (!Array.isArray(pack.entries)) fail('包文件缺少 entries 数组。', 2);
  if (pack.entries.length === 0) {
    fail('entries 是空数组。整包空条目会把线上条目全清掉，脚本拒绝发送；确实要清空请到网页里手动操作。', 2);
  }
  if (pack.name !== undefined && (typeof pack.name !== 'string' || pack.name.trim() === '')) {
    fail('name 必须是非空字符串。', 2);
  }
  if (pack.description !== undefined && typeof pack.description !== 'string') {
    fail('description 必须是字符串。', 2);
  }
  return pack;
}

function commonFields(entry) {
  return {
    worldBookPosition: entry.position === undefined ? 7 : entry.position,
    worldBookInsertionOrder: entry.order === undefined ? 100 : entry.order,
    worldBookConstant: entry.constant === undefined ? false : entry.constant,
  };
}

function rawFieldNames(type) {
  return {
    worldBook: ['worldBookComment', 'worldBookContent', 'worldBookKeys'],
    systemPrompt: ['systemPromptContent'],
    historyInstructions: ['historyContent'],
    regex: ['regexPattern', 'regexReplacement'],
  }[type] || [];
}

function normalizeEntry(entry, index) {
  const where = 'entries[' + index + ']';
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(where + ' 必须是对象。', 2);
  }
  const type = entry.type;
  if (typeof type !== 'string' || type.trim() === '') fail(where + ' 缺少 type。', 2);
  if (!FRIENDLY_TYPES.includes(type) && !RAW_ONLY_TYPES.includes(type)) {
    fail(where + ' 的 type 不认识：' + type + '\n可用：' + TYPE_ORDER.join(' / '), 2);
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
    fail(where + '.enabled 必须是布尔值。', 2);
  }

  const platformKeys = rawFieldNames(type);
  const hasPlatformField = platformKeys.some((k) => Object.prototype.hasOwnProperty.call(entry, k));
  const wantsRaw = entry.raw === true;
  if (RAW_ONLY_TYPES.includes(type) && (entry.content !== undefined || entry.pattern !== undefined)) {
    fail(where + ' 的 ' + type + ' 接口字段名未实测，不能用 content/pattern 简写；' +
      '请写平台原样字段并加 "raw": true。', 2);
  }
  if (hasPlatformField && (entry.content !== undefined || entry.pattern !== undefined)) {
    fail(where + ' 同时有 content 和平台原样字段，请二选一：要么用简写，要么整条原样透传。', 2);
  }
  if (wantsRaw || hasPlatformField) {
    const copy = Object.assign({}, entry);
    delete copy.raw;
    copy.type = type;
    if (copy.enabled === undefined) copy.enabled = true;
    const payloadKeys = Object.keys(copy).filter((k) => !['type', 'enabled'].includes(k));
    const validRaw = RAW_ONLY_TYPES.includes(type) ? payloadKeys.length > 0 : hasPlatformField;
    if (!validRaw) {
      fail(where + ' 是 raw 条目，但没有平台原样字段（' +
        (RAW_ONLY_TYPES.includes(type) ? '至少给一个平台字段' : platformKeys.join(' / ')) + '）。', 2);
    }
    return copy;
  }

  if (RAW_ONLY_TYPES.includes(type)) {
    fail(where + ' 的 ' + type + ' 接口字段名未实测，不能用 content 简写。\n' +
      '请把平台里的原样字段写进这一条，并加 "raw": true；例如 { "type": "' + type + '", "raw": true, ...平台字段 }。', 2);
  }

  if (type !== 'regex' && typeof entry.content !== 'string') fail(where + ' 缺少字符串 content。', 2);
  if (type === 'regex' && (typeof entry.pattern !== 'string' || entry.pattern === '')) {
    fail(where + ' 是 regex，缺少非空字符串 pattern。', 2);
  }
  if (entry.name !== undefined && typeof entry.name !== 'string') fail(where + '.name 必须是字符串。', 2);

  const base = Object.assign({ type, enabled: entry.enabled === undefined ? true : entry.enabled }, commonFields(entry));
  if (type === 'worldBook') {
    base.worldBookComment = entry.name || '';
    base.worldBookContent = entry.content;
    base.worldBookKeys = Array.isArray(entry.keys) ? entry.keys : [];
  } else if (type === 'systemPrompt') {
    base.systemPromptContent = entry.content;
  } else if (type === 'historyInstructions') {
    base.historyContent = entry.content;
  } else if (type === 'regex') {
    if (typeof entry.pattern !== 'string' || entry.pattern === '') {
      fail(where + ' 是 regex，缺少非空字符串 pattern。', 2);
    }
    if (entry.replacement !== undefined && typeof entry.replacement !== 'string') {
      fail(where + '.replacement 必须是字符串。', 2);
    }
    base.regexPattern = entry.pattern;
    base.regexReplacement = entry.replacement || '';
  }
  return base;
}

function normalizePack(pack) {
  return pack.entries.map((e, i) => normalizeEntry(e, i));
}

function typeCounts(entries) {
  const counts = new Map();
  for (const e of entries) {
    const t = e && e.type ? e.type : '(无 type)';
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const ordered = [];
  for (const t of TYPE_ORDER) if (counts.has(t)) ordered.push([t, counts.get(t)]);
  for (const [t, n] of counts) if (!TYPE_ORDER.includes(t)) ordered.push([t, n]);
  return ordered;
}

function formatCounts(entries) {
  const parts = typeCounts(entries).map(([t, n]) => t + ' ' + n);
  return parts.length ? parts.join(' / ') : '(空)';
}

function project(entry) {
  const type = entry.type;
  const out = {
    type,
    enabled: entry.enabled !== false,
    name: type === 'worldBook' ? (entry.worldBookComment || '') : '',
    content:
      type === 'worldBook' ? (entry.worldBookContent || '') :
      type === 'systemPrompt' ? (entry.systemPromptContent || '') :
      type === 'historyInstructions' ? (entry.historyContent || '') :
      (entry.regexPattern || ''),
    position: entry.worldBookPosition === undefined ? 7 : entry.worldBookPosition,
    order: entry.worldBookInsertionOrder === undefined ? 100 : entry.worldBookInsertionOrder,
    constant: entry.worldBookConstant === true,
  };
  if (type === 'regex') out.replacement = entry.regexReplacement || '';
  if (type === 'worldBook') out.keys = Array.isArray(entry.worldBookKeys) ? entry.worldBookKeys.slice() : [];
  return out;
}

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 8);
}

function compareEntries(expected, actual) {
  const problems = [];
  const max = Math.max(expected.length, actual.length);
  let same = 0;
  for (let i = 0; i < max; i++) {
    const e = expected[i];
    const a = actual[i];
    if (!e) { problems.push('第 ' + (i + 1) + ' 条：包内没有，线上多出一条 ' + (a && a.type)); continue; }
    if (!a) { problems.push('第 ' + (i + 1) + ' 条：线上没有，回读少一条 ' + e.type); continue; }
    const pe = project(e);
    const pa = project(a);
    const diffs = [];
    if (pe.type !== pa.type) diffs.push('类型 期望 ' + pe.type + '，实际 ' + pa.type);
    if (pe.enabled !== pa.enabled) diffs.push('开关 期望 ' + pe.enabled + '，实际 ' + pa.enabled);
    if (pe.name !== pa.name) diffs.push('名字 期望「' + pe.name + '」，实际「' + pa.name + '」');
    if (pe.content !== pa.content) {
      diffs.push('正文不一致：期望 ' + pe.content.length + ' 字（sha256 ' + shortHash(pe.content) +
        '），实际 ' + pa.content.length + ' 字（sha256 ' + shortHash(pa.content) + '）');
    }
    if (pe.replacement !== pa.replacement) diffs.push('regex 替换串不一致');
    if (JSON.stringify(pe.keys) !== JSON.stringify(pa.keys)) diffs.push('关键词列表不一致');
    if (pe.position !== pa.position) diffs.push('position 期望 ' + pe.position + '，实际 ' + pa.position);
    if (pe.order !== pa.order) diffs.push('order 期望 ' + pe.order + '，实际 ' + pa.order);
    if (pe.constant !== pa.constant) diffs.push('constant 期望 ' + pe.constant + '，实际 ' + pa.constant);
    if (!FRIENDLY_TYPES.includes(e.type)) {
      const skip = ['type', 'enabled', 'raw', 'name', 'content', 'pattern', 'replacement', 'keys', 'position', 'order', 'constant'];
      for (const k of Object.keys(e)) {
        if (skip.includes(k)) continue;
        if (JSON.stringify(e[k]) !== JSON.stringify(a[k])) diffs.push(k + ' 不一致');
      }
    }
    if (diffs.length) problems.push('第 ' + (i + 1) + ' 条：' + diffs.join('；'));
    else same++;
  }
  return { problems, same };
}

function changeLine(next, current, label) {
  if (next === undefined) return label + '：不变';
  if (next === current) return label + '：不变';
  const shown = String(next).length > 60 ? String(next).slice(0, 60) + '…' : String(next);
  return label + '：将改为「' + shown + '」（' + String(next).length + ' 字）';
}

function printTarget(mod) {
  console.log('目标 MOD：' + (mod.name || '(未命名)'));
  console.log('ID：' + modIdOf(mod));
  console.log('买家数：' + (mod.purchaseCount === undefined ? 0 : mod.purchaseCount));
  console.log('线上条目：' + (Array.isArray(mod.entries) ? mod.entries.length : 0));
}

async function runList() {
  const mods = await getMine();
  console.log('=== MOD 列表 ===');
  console.log('共 ' + mods.length + ' 个（GET /fox/api/mods/mine）');
  console.log('');
  for (const m of mods) {
    const n = Array.isArray(m.entries) ? m.entries.length : 0;
    console.log([
      modIdOf(m),
      '条目 ' + String(n).padStart(3),
      '买家 ' + String(m.purchaseCount === undefined ? 0 : m.purchaseCount).padStart(3),
      m.name || '(未命名)',
    ].join('  '));
  }
}

async function runDryRun(opt) {
  if (!opt.mod) fail('缺少 --mod <MOD id>。先用 --list 看 id。', 2);
  const pack = loadPack(opt.pack);
  const entries = normalizePack(pack);
  const mods = await getMine();
  const mod = findMod(mods, opt.mod);
  if (!mod) fail('账号下找不到 MOD：' + opt.mod + '\n先用 --list 看 id。', 1);
  const online = Array.isArray(mod.entries) ? mod.entries : [];

  console.log('=== MOD 条目批量上传 · 预演 ===');
  printTarget(mod);
  console.log('包内条目：' + entries.length);
  console.log('类型分布：' + formatCounts(entries));
  console.log(changeLine(pack.name, mod.name, '名称'));
  console.log(changeLine(pack.description, mod.description, '简介'));
  console.log('请求体：entries ' + entries.length + ' 条' +
    (pack.name !== undefined && pack.name !== mod.name ? ' ＋ name' : '') +
    (pack.description !== undefined && pack.description !== mod.description ? ' ＋ description' : '') +
    '（字段级合并，没列的字段不动）');

  const cmp = compareEntries(entries, online);
  if (cmp.problems.length === 0) {
    console.log('内容比对：' + cmp.same + '/' + entries.length + ' 条与线上一致（本次是幂等更新）');
  } else {
    console.log('内容比对：' + cmp.problems.length + ' 条与线上不同，apply 后以包内为准');
    for (const p of cmp.problems.slice(0, 5)) console.log('  · ' + p);
    if (cmp.problems.length > 5) console.log('  · …还有 ' + (cmp.problems.length - 5) + ' 条');
  }
  console.log('');
  console.log('只发送了只读请求 GET /fox/api/mods/mine（用于对比）；没有发任何写请求。');
}

async function runApply(opt) {
  if (!opt.mod) fail('缺少 --mod <MOD id>。先用 --list 看 id。', 2);
  const pack = loadPack(opt.pack);
  const entries = normalizePack(pack);
  const mods = await getMine();
  const mod = findMod(mods, opt.mod);
  if (!mod) fail('账号下找不到 MOD：' + opt.mod + '\n先用 --list 看 id。', 1);

  console.log('=== MOD 条目批量上传 · 写入 ===');
  printTarget(mod);
  console.log('包内条目：' + entries.length);
  console.log('类型分布：' + formatCounts(entries));
  const buyers = mod.purchaseCount === undefined ? 0 : mod.purchaseCount;
  if (buyers > 0) console.log('这是已上架件，确认要改吗？');
  if (buyers > 0 && !opt.allowPublished) {
    fail('拒绝执行：这是已上架件（买家 ' + buyers + '）。确认要改请再加 --allow-published。', 2);
  }
  if (!opt.yes) {
    fail('拒绝执行：--apply 必须再加 --yes 才会真的写入。', 2);
  }

  const body = { entries };
  if (pack.name !== undefined && pack.name !== mod.name) body.name = pack.name;
  if (pack.description !== undefined && pack.description !== mod.description) body.description = pack.description;

  console.log('');
  console.log('POST /fox/api/mods/' + modIdOf(mod) + '/update');
  const r = await request('POST', '/mods/' + encodeURIComponent(modIdOf(mod)) + '/update', body);
  const ok = r.status >= 200 && r.status < 300 && !(r.json && r.json.success === false);
  if (!ok) {
    fail('更新失败：HTTP ' + r.status + (apiError(r) ? '：' + apiError(r) : '') + statusHint(r.status), 1);
  }
  console.log('HTTP ' + r.status + (r.json && r.json.success === true ? '，success=true' : ''));

  console.log('');
  console.log('回读 GET /fox/api/mods/mine 校验…');
  const after = await getMine();
  const fresh = findMod(after, modIdOf(mod));
  if (!fresh) fail('回读失败：更新后列表里找不到该 MOD。', 1);
  const actual = Array.isArray(fresh.entries) ? fresh.entries : [];
  const wantName = pack.name !== undefined ? pack.name : mod.name;
  const wantDesc = pack.description !== undefined ? pack.description : mod.description;

  let bad = 0;
  const check = (okFlag, line) => {
    console.log((okFlag ? '  ✓ ' : '  ✗ ') + line);
    if (!okFlag) bad++;
  };
  check(actual.length === entries.length, '条目数：期望 ' + entries.length + '，实际 ' + actual.length);
  check(formatCounts(actual) === formatCounts(entries), '类型分布：期望 ' + formatCounts(entries) + '，实际 ' + formatCounts(actual));
  check(fresh.name === wantName, '名称：期望「' + wantName + '」，实际「' + fresh.name + '」');
  check((fresh.description || '') === (wantDesc || ''), '简介：' + ((fresh.description || '') === (wantDesc || '') ? '一致' : '不一致'));

  const cmp = compareEntries(entries, actual);
  if (cmp.problems.length === 0) {
    console.log('  ✓ 逐条比对：' + cmp.same + '/' + entries.length + ' 条一致');
  } else {
    bad += cmp.problems.length;
    console.log('  ✗ 逐条比对：' + cmp.problems.length + ' 条不一致');
    for (const p of cmp.problems.slice(0, 8)) console.log('    · ' + p);
    if (cmp.problems.length > 8) console.log('    · …还有 ' + (cmp.problems.length - 8) + ' 条');
  }

  console.log('');
  if (bad > 0) fail('回读校验不一致（' + bad + ' 项），退出码 2。', 2);
  console.log('✓ 回读校验全部通过，上传完成。');
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || process.argv.length <= 2) {
    console.log(USAGE);
    console.log('');
    console.log('包格式（JSON）：');
    console.log('{');
    console.log('  "name": "可选，改了才发",');
    console.log('  "description": "可选，改了才发",');
    console.log('  "entries": [');
    console.log('    { "type": "worldBook", "name": "条目名", "enabled": true, "content": "正文", "keys": ["关键词"] },');
    console.log('    { "type": "systemPrompt", "name": "显示用名字", "enabled": true, "content": "正文" },');
    console.log('    { "type": "historyInstructions", "enabled": true, "content": "正文" },');
    console.log('    { "type": "regex", "enabled": true, "pattern": "\\\\n{2,}", "replacement": "\\\\n" }');
    console.log('  ]');
    console.log('}');
    console.log('');
    console.log('worldBook 还可选 position（默认 7）、order（默认 100）、constant（默认 false）。');
    console.log('作者助手／自动总结／自定义 CSS 三类字段名未实测，必须带 "raw": true 并写平台原样字段。');
    return;
  }
  if (opt.list) return runList();
  if (opt.apply) return runApply(opt);
  return runDryRun(opt);
}

main().catch((e) => {
  if (e instanceof UserError) {
    console.error('✗ ' + e.message);
    process.exitCode = e.code || 1;
  } else {
    console.error('✗ 未预期错误：' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  }
});
