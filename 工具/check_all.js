/* ===========================================================================
 * check_all.js —— 依次跑四个检查器，汇总成一行总账
 * ---------------------------------------------------------------------------
 * 用法：node 工具/check_all.js <卡包目录|某个.json> [--json]
 * 退出码：任一检查器报「必须修」＝1，否则 0；用法错＝2。
 *
 * 依次跑（都在 工具/ 目录里，用 __dirname 定位，不写死绝对路径）：
 *   check_style.js     文风：破折号／AI 腔／负向指令／跨条目引用
 *   check_setting.js   设定：术语表（旧名／现用名计数）
 *   check_entries.js   条目：角色条模板／数字口径／重复句／关键词／结构读数
 *   check_worldbook.js 世界书：字段完整性／类型范围／位置双轨／命名／uid
 * 输出与四个检查器同一套：`  ✓ 通过项`／`  ! 提示项`／`  ✗ 必须修项`，
 * 每个检查器末行自带「=== 结论：N 必须修 / M 提示 ===」，最后再打一行总账。
 *
 * 实现：四个检查器都带 --json，本脚本捕获它们的 JSON（比解析人读文本可靠），
 * 再按同一套格式打印出来，所以输出和单独跑一模一样。
 * 只读不写。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = 'check_all.js';
const USAGE = '用法：node 工具/check_all.js <卡包目录|某个.json> [--输出端=酒馆|叙梦|双端] [--json]';
const MARK = { pass: '✓', hint: '!', fail: '✗' };
const CHECKS = ['check_style.js', 'check_setting.js', 'check_entries.js', 'check_worldbook.js'];

function parseArgv(argv) {
  const opt = { json: false, help: false, target: null, output: null };
  for (const a of argv) {
    if (a === '--json') opt.json = true;
    else if (a === '--help' || a === '-h') opt.help = true;
    else if (a.startsWith('--输出端=')) opt.output = a.slice(a.indexOf('=') + 1);
    else if (!a.startsWith('--') && !opt.target) opt.target = a;
  }
  return opt;
}

function run(target, opt) {
  const targetAbs = path.resolve(String(target));
  const results = [];
  const notes = [];

  const say = (s) => { notes.push(s); if (!opt.json) console.log(s); };
  say('=== ' + TOOL + ' ===');
  say('卡包：' + targetAbs);
  say('依次跑 ' + CHECKS.length + ' 个检查器：' + CHECKS.join(' → '));

  for (const name of CHECKS) {
    const file = path.join(__dirname, name);
    if (!opt.json) console.log('');
    if (!fs.existsSync(file)) {
      const text = name + ' 不在本目录（' + __dirname + '）：四个检查器要和本脚本放在一起';
      results.push({ tool: name, mustFix: 1, hints: 0, exit: 1, error: text, items: [], notes: [], conclusion: '=== 结论：1 必须修 / 0 提示 ===' });
      continue;
    }
    const args = [file, target, '--json'];
    if (opt.output) args.push('--输出端=' + opt.output);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { parsed = null; }
    if (!parsed) {
      const text = name + ' 跑不起来（退出码 ' + r.status + '）：' + String(r.stderr || '').trim().split('\n').slice(0, 3).join(' / ');
      results.push({ tool: name, mustFix: 1, hints: 0, exit: 1, error: text, items: [], notes: [], conclusion: '=== 结论：1 必须修 / 0 提示 ===' });
      continue;
    }
    // 契约核对：退出码必须与「有没有必须修」一致
    const want = parsed.mustFix > 0 ? 1 : 0;
    if (r.status !== want) {
      parsed.hints++;
      parsed.items.push({ level: 'hint', text: '退出码异常：实际 ' + r.status + '，按契约应为 ' + want + '（有必须修＝1、否则 0）' });
    }
    results.push(parsed);
  }

  // 按四个检查器自己的格式打印
  for (const r of results) {
    for (const n of r.notes || []) say(n);
    for (const i of r.items || []) say('  ' + MARK[i.level] + ' ' + i.text);
    say(r.conclusion);
    if (!opt.json) console.log('');
  }

  const mustFix = results.reduce((a, r) => a + (r.mustFix || 0), 0);
  const hints = results.reduce((a, r) => a + (r.hints || 0), 0);
  const line = '总账：' + results.map((r) => r.tool.replace(/^check_|\.js$/g, '') + ' ' + r.mustFix + '/' + r.hints).join(' · ') +
    ' —— 合计 ' + mustFix + ' 必须修 / ' + hints + ' 提示';
  say('  ' + MARK[mustFix ? 'fail' : 'pass'] + ' ' + line);
  const conclusion = '=== 结论：' + mustFix + ' 必须修 / ' + hints + ' 提示 ===';
  say(conclusion);

  return {
    tool: TOOL, target: targetAbs, mustFix, hints,
    exit: mustFix ? 1 : 0, conclusion, notes,
    items: results.map((r) => ({ tool: r.tool, mustFix: r.mustFix, hints: r.hints, exit: r.mustFix ? 1 : 0, conclusion: r.conclusion, error: r.error || null })),
  };
}

const opt = parseArgv(process.argv.slice(2));
if (opt.help) { console.log(USAGE); process.exit(0); }
if (!opt.target) { console.error(USAGE); process.exit(2); }
if (opt.output !== null && !['酒馆', '叙梦', '双端', 'st', 'xm', 'both'].includes(String(opt.output).trim())) {
  console.error('输出端只认 酒馆 / 叙梦 / 双端（收到：' + opt.output + '）\n' + USAGE);
  process.exit(2);
}
const out = run(opt.target, opt);
if (opt.json) console.log(JSON.stringify(out, null, 2));
process.exit(out.exit);
