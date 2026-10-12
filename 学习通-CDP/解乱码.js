/* 解乱码 —— 把字体反爬的替身字翻译回真字
 *
 * 用法：
 *   node 解乱码.js                    读 章节测验记录.txt，解码后打印并存一份
 *   node 解乱码.js --file 某文件.txt   指定文件
 *   node 解乱码.js --text "庘庝律"     直接解一段文字
 *   node 解乱码.js --check            只看对照表本身
 *
 * 依赖：_字体\对照表.json（由 扫字形.ps1 + 比字形.js 生成）
 *
 * ------------------------------------------------------------------
 * 原理（为什么直接按字符替换就是对的）：
 *
 *   font-cxsecret 这支字体只覆盖 41 个"替身码位"（U+5390~U+5ECD）。
 *   服务器把真字换成替身字：真字"从"写成替身"庘"，
 *   浏览器再用内嵌字体把"庘"画成"从"的字形 —— 屏幕上是对的。
 *
 *   关键在于：**没被替换的字，字体里根本没有对应字形**，
 *   浏览器只能回退到普通字体，于是照原样正常显示。
 *   所以那些字（律、约、区、大……）可以安全地留在原文里不动。
 *
 *   反过来说：替身码位里的这 41 个字，如果原文本里真的写了"厦"
 *   （厦门的大厦），字体就会把它画成"成"—— 平台的页面上会出现错字。
 *   平台显然不会允许这种事，所以**任何出现在混淆文本里的替身码位，必定是被替换过的**。
 *   这就是"见到就替换"这个做法成立的依据。
 *
 * ------------------------------------------------------------------
 * 坑：
 *   1. 对照表.json 是 PowerShell/Node 混合写的，可能带 BOM
 *      直接 JSON.parse 会抛异常，先剥 \uFEFF。
 *
 *   2. 不要用 /[\u5390-\u5ecd]/g 这种"按区间"的正则
 *      区间里的码位比 41 个多得多（比如 厏、厑 根本不在字体里）。
 *      按区间替换会把本来正常的字也改掉。
 *      要从对照表的键构造精确的字符类。
 *
 *   3. 替换必须一次扫描完成
 *      如果边替换边把结果再喂回替换，真字里万一又含替身字就会连环替换。
 *      用 String.replace 的单遍回调天然避免这个问题。
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const TABLE = path.join(__dirname, '_字体', '对照表.json');
const DEFAULT_IN = path.join(DIR, '章节测验记录.txt');
const DEFAULT_OUT = path.join(DIR, '章节测验记录-已解码.txt');

const argText = (() => {
  const i = process.argv.indexOf('--text');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const argFile = (() => {
  const i = process.argv.indexOf('--file');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const CHECK = process.argv.includes('--check');

if (!fs.existsSync(TABLE)) {
  console.error('找不到对照表: ' + TABLE);
  console.error('先生成它：');
  console.error('  1) node 看字体.js --dump');
  console.error('  2) node 解析字体.js --json');
  console.error('  3) powershell -ExecutionPolicy Bypass -File 扫字形.ps1');
  console.error('  4) node 比字形.js');
  process.exit(1);
}

const table = JSON.parse(fs.readFileSync(TABLE, 'utf8').replace(/^\uFEFF/, ''));
const map = table.map || {};

/* 精确字符类：只包含对照表里真实存在的替身码位 */
const esc = (c) => '\\u{' + c.codePointAt(0).toString(16) + '}';
const keys = Object.keys(map);
const RE = new RegExp('[' + keys.map(esc).join('') + ']', 'gu');

if (CHECK) {
  console.log('对照表: ' + Object.keys(map).length + ' 个替身字');
  console.log('字体指纹: ' + table.sha256);
  console.log('判定方法: ' + table.method);
  console.log('生成时间: ' + table.generated);
  console.log('');
  const selfMap = keys.filter((k) => map[k] === k);
  console.log('自映射（替身等于真字）的: ' + (selfMap.length ? selfMap.join(' ') : '没有 —— 说明见一个换一个是安全的'));
  for (const k of keys) console.log('  ' + k + ' -> ' + map[k]);
  process.exit(0);
}

function decode(s) {
  let hits = 0;
  const seen = new Map();   /* 这次实际用到的替身 -> 真字 */
  const out = String(s).replace(RE, (c) => {
    const r = map[c];
    if (!r) return c;       /* 理论上到不了这：字符类就是从表的键构造出来的 */
    hits++;
    seen.set(c, r);
    return r;
  });
  return { out, hits, seen };
}

if (argText !== null) {
  const r = decode(argText);
  console.log('原文: ' + argText);
  console.log('解码: ' + r.out);
  console.log('（替换了 ' + r.hits + ' 处）');
  process.exit(0);
}

const IN = argFile || DEFAULT_IN;
if (!fs.existsSync(IN)) { console.error('找不到输入文件: ' + IN); process.exit(1); }

const src = fs.readFileSync(IN, 'utf8').replace(/^\uFEFF/, '');
const r = decode(src);

console.log('输入: ' + IN);
console.log('替换了 ' + r.hits + ' 处替身字，用到 ' + r.seen.size + ' 种');
console.log('');

/* 只把原本含乱码的行打出来，记录文件里废话太多 */
const before = src.split(/\r?\n/);
const after = r.out.split(/\r?\n/);
let shown = 0;
for (let i = 0; i < before.length; i++) {
  if (!RE.test(before[i])) continue;
  RE.lastIndex = 0;
  shown++;
  console.log('  ' + after[i]);
}
console.log('');
console.log('（共 ' + shown + ' 行原本含乱码，上面是解码结果）');

if (!argFile) {
  fs.writeFileSync(DEFAULT_OUT, r.out, 'utf8');
  console.log('已写出完整解码版: ' + DEFAULT_OUT);
}
