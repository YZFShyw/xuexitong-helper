'use strict';

/* launcher-scripts.test.js —— 启动链路（脚本层）的回归测试
 *
 * 为什么单独有这么一个文件：
 *   2026-10-11 那份第三方错误报告点了 5 个缺陷，全落在**启动链路的脚本层**
 *   （控制台.ps1 / _内部\开始.cmd / _内部\驱动器循环.cmd / runtime-processes.js），
 *   而当时已有的那 15 个测试文件一个都没覆盖 —— 它们全在 Node 业务逻辑层。
 *   这里把那些缺陷固化成"谁改回去谁红"的断言，另外锁住几条编码/一致性约定。
 *
 * 这一版盯的 9 条约定（编号 = 缺陷报告里的条目）：
 *   ①  控制台.ps1 调 _内部\开始.cmd 那一处不许有裸 -Wait
 *       （裸 -Wait 在等子窗口退出，子窗口在等用户按键，用户正盯着控制台 → 三方死等）
 *   ②  _内部\开始.cmd 里"显示助手窗口.ps1"的调用必须排在 "--launch-edge" 之后
 *       （冷启动时浏览器进程还不存在，先调它必然空跑 NO_EDGE_PROCESS）
 *   ③  _内部\开始.cmd 的 :done 段落里不许有裸 pause（同上，会跟调用方互锁）
 *   ④  _内部\驱动器循环.cmd 开头要有"自我隐藏"调用，且 _内部\外套窗口.ps1 要存在
 *       （外套是独立控制台窗口，不主动最小化 + 不关 QuickEdit 就会挂在桌面上）
 *   ⑤  runtime-processes.js 的 launchOwnedEdge 里启动 msedge 不许带 windowsHide: true
 *       （Windows 上它给 msedge.exe 打 SW_HIDE，浏览器主窗口出生即隐藏）
 *   ⑥  _内部\*.ps1：无 BOM 的 UTF-8 必须纯 ASCII（PowerShell 5.1 按 ANSI 读，中文会烂）
 *   ⑦  _内部\*.cmd：存储编码必须与它声明的 chcp 代码页自洽（936↔GBK / 65001↔UTF-8）
 *   ⑧  _内部\开始.cmd 与 _内部\停止.cmd 的 set "SANDBOX=..." 取值必须完全一致
 *   ⑨  _内部\驱动器循环.cmd 必须有 --status-exit 判活，不许退回 findstr 配 alive
 *   ⑪  _内部\*.cmd（开始/停止/驱动器循环）：goto/call 引用的标签必须在同一个文件里有行首定义
 *       （不在缺陷报告里；是加 :ShowAssistantWindow 子过程那轮"call 加在前面、label 差点
 *        忘了加"踩出来的，专门挡住"改了标签名忘改引用"这类静态错误）
 *
 * 这一版的两条硬规矩：
 *   · **绝不按行号断言** —— 只用正则、子串包含、相对次序（行序）、标签段落、字节级检查。
 *     代码挪位置、注释增删都不该让测试红。
 *   · **注释不算代码** —— 这个工程习惯在注释里写"以前是 xxx"（"原来的裸 -Wait"、
 *     "旧写法 findstr ... alive"、"显示助手窗口.ps1 会空跑"）。直接全文搜会把这些
 *     历史说明当成代码，所以所有锚点搜索都在**剥掉注释之后**的文本上做。
 *
 * 只读文件：不写任何文件、不起进程、不联网、不读用户设置/课程/题库/日志。
 *
 * 跑法：node --test tests\launcher-scripts.test.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

/* ============================================================ 路径 */

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INNER_DIR = path.join(PROJECT_ROOT, '_内部');

const P = {
  consolePs1: path.join(PROJECT_ROOT, '控制台.ps1'),
  runtimeJs: path.join(PROJECT_ROOT, 'runtime-processes.js'),
  startCmd: path.join(INNER_DIR, '开始.cmd'),
  stopCmd: path.join(INNER_DIR, '停止.cmd'),
  loopCmd: path.join(INNER_DIR, '驱动器循环.cmd'),
  coatPs1: path.join(INNER_DIR, '外套窗口.ps1'),
  webConsoleJs: path.join(PROJECT_ROOT, '网页控制台.js'),
};

function rel(p) {
  const r = path.relative(PROJECT_ROOT, p);
  return r && !r.startsWith('..') ? r : p;
}

/* ============================================================ 读取 */

function readBytes(p) {
  try {
    return fs.readFileSync(p);
  } catch (err) {
    assert.fail('读不到文件：' + rel(p)
      + '\n  原因：' + ((err && err.message) || err)
      + '\n  这个文件是启动链路的一环，被删掉/改名就等于链路断了。');
  }
}

/** .ps1 / .js 的文本视图（顺带剥掉 UTF-8 BOM，免得第一行的锚点被 U+FEFF 顶掉）。 */
function utf8Text(buf) {
  const body = (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
    ? buf.subarray(3) : buf;
  return body.toString('utf8');
}

let GBK_DECODER = null;
let GBK_TRIED = false;

/** GBK（代码页 936）解码器。Node 官方发行版带全文 ICU，取得到；取不到就返回 null。 */
function gbkDecoder() {
  if (!GBK_TRIED) {
    GBK_TRIED = true;
    try { GBK_DECODER = new TextDecoder('gbk'); } catch (e) { GBK_DECODER = null; }
  }
  return GBK_DECODER;
}

/** .cmd 的文本视图。这些文件是 GBK 存的，用 readFileSync(p, 'utf8') 读会乱码。 */
function cmdText(buf) {
  const dec = gbkDecoder();
  assert.ok(dec, 'Node 里没有 GBK 解码器（TextDecoder("gbk") 不可用），'
    + '没法读 .cmd 里的中文锚点。\n  换一个带完整 ICU 的 Node（官方安装包默认就有）再跑。'
    + '\n  受影响：①②③④⑥⑦⑧⑨ 里所有要搜中文的用例。');
  return dec.decode(buf);
}

/* ============================================================ 字节级检查 */

function hasUtf8Bom(buf) {
  return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
}

function highByteCount(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7F) n++;
  return n;
}

function firstHighByte(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7F) return i;
  return -1;
}

/** 严格按 UTF-8 解一遍：能过 = 这段字节确实是合法 UTF-8。 */
function strictUtf8Ok(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch (e) { return false; }
}

/** 打印某个偏移附近的原始字节（问题字节用 [xx] 标出来）。 */
function hexAround(buf, at, back, forward) {
  if (at < 0 || at >= buf.length) return '(偏移越界)';
  const from = Math.max(0, at - (back == null ? 4 : back));
  const to = Math.min(buf.length, at + (forward == null ? 10 : forward));
  const out = [];
  for (let i = from; i < to; i++) {
    const h = buf[i].toString(16).padStart(2, '0');
    out.push(i === at ? '[' + h + ']' : h);
  }
  return '偏移 ' + at + ' 起：' + out.join(' ');
}

/**
 * 按 GBK(CP936) 的字节结构扫一遍，返回第一个"解不出来"的偏移（-1 = 整段都合法）。
 * 结构：0x00-0x7F 单字节；0x80 是欧元符号，单字节；0x81-0xFE 起双字节，
 *       尾字节必须落在 0x40-0xFE 且不能是 0x7F；0xFF 永远非法。
 * 等价于"按 GBK 解码再编码回去跟原字节完全一致"。
 */
function gbkFirstBadOffset(buf) {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b <= 0x7F || b === 0x80) continue;
    if (b === 0xFF) return i;
    const tail = (i + 1 < buf.length) ? buf[i + 1] : -1;
    if (tail < 0x40 || tail === 0x7F || tail === 0xFF) return i;
    i++;
  }
  return -1;
}

/** 再用真正的 GBK 解码器对一遍：出现 U+FFFD = 有解不出来的字节。null = 没解码器。 */
function gbkReplacementCount(buf) {
  const dec = gbkDecoder();
  if (!dec) return null;
  let n = 0;
  const s = dec.decode(buf);
  for (let i = 0; i < s.length; i++) if (s[i] === '\uFFFD') n++;
  return n;
}

/* ============================================================ 文本级检查 */

function splitLines(text) {
  return String(text).split(/\r\n|\n|\r/);
}

function isCmdCommentLine(raw) {
  const t = String(raw).replace(/^[ \t]+/, '');
  return /^rem(?=[ \t]|$)/i.test(t) || /^::/.test(t);
}

/** 全部行，带行号。 */
function allLines(text) {
  return splitLines(text).map((raw, i) => ({ n: i + 1, raw }));
}

/**
 * 把 cmd 注释行整行抹成空串（行号不变）。
 * 锚点搜索必须用这个视图：这个工程习惯在注释里写"旧写法是 findstr ... alive"、
 * "以前先调 显示助手窗口.ps1"，直接全文搜会把这些历史说明当成代码。
 */
function stripCmdComments(text) {
  return splitLines(text).map(l => (isCmdCommentLine(l) ? '' : l)).join('\n');
}

/** 抹掉 PowerShell 的行注释（# 之后）与块注释（<# #>），行号不变。 */
function stripPsComments(text) {
  const blanked = String(text).replace(/<#[\s\S]*?#>/g, m => m.replace(/[^\r\n]/g, ' '));
  return splitLines(blanked).map(stripPsLineComment).join('\n');
}

function stripPsLineComment(line) {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < line.length) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") {
        if (line[i + 1] === "'") { out += "''"; i += 2; continue; }   // '' 是转义的单引号
        inSingle = false;
      }
      out += ch; i++; continue;
    }
    if (inDouble) {
      if (ch === '`') { out += line.slice(i, i + 2); i += 2; continue; }  // `x 是转义
      if (ch === '"') {
        if (line[i + 1] === '"') { out += '""'; i += 2; continue; }
        inDouble = false;
      }
      out += ch; i++; continue;
    }
    if (ch === '#') break;                       // 行注释开始，后面全丢
    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    if (ch === '"') { inDouble = true; out += ch; i++; continue; }
    out += ch; i++;
  }
  return out;
}

/** 第一个非注释行里含 marker 的行号（找不到返回 -1）。 */
function firstCodeLine(lines, marker) {
  for (const l of lines) {
    if (isCmdCommentLine(l.raw)) continue;
    if (String(l.raw).includes(marker)) return l.n;
  }
  return -1;
}

/** 所有非注释行里含 marker 的（带行号）。 */
function codeLineHits(lines, marker) {
  return lines.filter(l => !isCmdCommentLine(l.raw) && String(l.raw).includes(marker));
}

/** 按 cmd 标签切一段（:label 到下一个 :label / 文件尾）。找不到返回 null。 */
function labelBlock(text, label) {
  const lines = splitLines(text);
  const head = new RegExp('^[ \\t]*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[ \\t]|$)', 'i');
  let start = -1;
  for (let i = 0; i < lines.length; i++) { if (head.test(lines[i])) { start = i; break; } }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[ \t]*:[A-Za-z_]/.test(lines[i])) { end = i; break; }   // :: 注释不会被这个撞上
  }
  const body = [];
  for (let i = start; i < end; i++) body.push({ n: i + 1, raw: lines[i] });
  return { startLine: start + 1, endLine: end, lines: body };
}

/** set "VAR=值" / set VAR=值 的取值（带行号）。 */
function extractSetValues(text, varName) {
  const out = [];
  const quoted = new RegExp('^[ \\t]*set[ \\t]+"' + varName + '=([^"]*)"', 'i');
  const bare = new RegExp('^[ \\t]*set[ \\t]+' + varName + '=([^\\r\\n]*)', 'i');
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const m = quoted.exec(lines[i]) || bare.exec(lines[i]);
    if (m) out.push({ n: i + 1, value: m[1].trim(), raw: lines[i].trim() });
  }
  return out;
}

/** 列出 _内部 目录里某个后缀的文件名（排序稳定，不依赖 locale）。 */
function listInner(ext) {
  let names = [];
  try { names = fs.readdirSync(INNER_DIR); } catch (e) { return []; }
  return names
    .filter(n => n.toLowerCase().endsWith(ext))
    .sort((a, b) => {
      const x = a.toLowerCase(); const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
}

/** 给出"原始字节长什么样"的可读快照，失败信息里用。 */
function describeBytes(buf) {
  const hi = highByteCount(buf);
  const first = firstHighByte(buf);
  return '长度 ' + buf.length + ' 字节；非 ASCII 字节 ' + hi + ' 个'
    + (first >= 0 ? '；第一个在 ' + hexAround(buf, first) : '')
    + '；UTF-8 BOM：' + (hasUtf8Bom(buf) ? '有' : '无');
}

/* ============================================================ 前置：环境自检 */

test('⑩前提：这个 Node 能用 GBK 解码 .cmd（不行的话下面搜中文锚点的用例会一起红）', () => {
  const dec = gbkDecoder();
  assert.ok(dec, 'TextDecoder("gbk") 不可用 —— 装的可能是 small-icu 版的 Node。'
    + '\n  换官方安装包的 Node（含完整 ICU）再跑。');
  // 0xC4 0xE3 0xBA 0xC3 就是 GBK 的"你好"
  assert.equal(dec.decode(Buffer.from([0xC4, 0xE3, 0xBA, 0xC3])), '你好',
    'GBK 解码器解出来的不是"你好" —— 这个解码器结果不可信。');
});

/* ============================================================ ① 控制台.ps1 的等待 */

test('①控制台.ps1：调用 _内部\\开始.cmd 的那处 Start-Process 不得出现裸 -Wait', () => {
  const file = rel(P.consolePs1);
  const raw = utf8Text(readBytes(P.consolePs1));
  const text = stripPsComments(raw);          // 注释里那句"原来是 ... -Wait"不算
  const lines = allLines(text);

  const callLines = lines.filter(l => l.raw.includes('开始.cmd') && /Start-Process/i.test(l.raw));
  assert.ok(callLines.length > 0,
    file + ' 里找不到"调用 开始.cmd 的 Start-Process"。\n'
    + '  控制台菜单第 1 项的调用点要么被删了，要么换成了别的写法（比如 & 直接调用）——\n'
    + '  这个用例靠它定位，先确认这一段还在。\n'
    + '  当前含"开始.cmd"的非注释行：\n'
    + (lines.filter(l => l.raw.includes('开始.cmd')).map(l => '    ' + l.n + ': ' + l.raw.trim()).join('\n') || '    （一个都没有）'));

  // 同一个"小段"：含 开始.cmd 的行，前后各 2 行，一并查。
  const window = new Set();
  for (const l of callLines) {
    for (let n = l.n - 2; n <= l.n + 2; n++) window.add(n);
  }
  const offenders = lines
    .filter(l => window.has(l.n) && /(?:^|[\s(=])-Wait\b/i.test(l.raw));

  assert.equal(offenders.length, 0,
    file + ' 调用 开始.cmd 的那一段里还有裸 -Wait —— 约定①被破坏。\n'
    + '  为什么会出人命：-Wait 在等子窗口退出，而那个子窗口结尾在等用户按键；\n'
    + '  用户正盯着控制台等它回菜单 —— 两个进程一起挂住（实测挂过半小时）。\n'
    + '  修法：-PassThru 起进程 + 自己轮询 $proc.HasExited + 上限兜底。\n'
    + '  违规原文：\n'
    + offenders.map(l => '    ' + file + ':' + l.n + '  ' + l.raw.trim()).join('\n'));
});

/* ============================================================ ② 开始.cmd 的调用次序 */

test('②_内部\\开始.cmd：显示助手窗口.ps1 的调用必须排在 --launch-edge 之后', () => {
  const file = rel(P.startCmd);
  const text = cmdText(readBytes(P.startCmd));
  const lines = allLines(text);

  const lineLaunch = firstCodeLine(lines, '--launch-edge');
  const lineShow = firstCodeLine(lines, '显示助手窗口.ps1');

  assert.ok(lineLaunch > 0,
    file + ' 里找不到非注释的 --launch-edge 调用 ——\n'
    + '  浏览器是"记下所有权"起出来的，这一行没了后面所有约定都无从谈起。');
  assert.ok(lineShow > 0,
    file + ' 里找不到非注释的 显示助手窗口.ps1 调用 —— 露窗口那一步丢了。');

  const dump = '    第 ' + lineLaunch + ' 行是 --launch-edge：' + lines[lineLaunch - 1].raw.trim()
    + '\n    第 ' + lineShow + ' 行是 显示助手窗口.ps1：' + lines[lineShow - 1].raw.trim();

  assert.ok(lineShow > lineLaunch,
    file + ' 里的次序反了 —— 约定②被破坏：显示助手窗口.ps1（第 ' + lineShow + ' 行）'
    + '排到了 --launch-edge（第 ' + lineLaunch + ' 行）**前面**。\n'
    + '  后果：冷启动时调试端口还没起、浏览器进程还不存在，露窗口脚本第一步就返回\n'
    + '  NO_EDGE_PROCESS，白跑一场；而它现在已经会如实打印结论，用户看到的就是\n'
    + '  "助手窗口没能显示"。热启动（端口已在）反而看不出问题，所以这个 bug 只在\n'
    + '  冷启动复现。\n'
    + dump);
});

/* ============================================================ ③ :done 段不得有裸 pause */

test('③_内部\\开始.cmd：:done 段落里不得有裸 pause', () => {
  const file = rel(P.startCmd);
  const text = cmdText(readBytes(P.startCmd));
  const block = labelBlock(text, ':done');

  assert.ok(block,
    file + ' 里找不到 :done 标签 —— 成功路径的收尾标签不见了，'
    + '\n  这个用例靠它划范围，先把标签找回来。');

  const offenders = block.lines.filter(l => !isCmdCommentLine(l.raw)
    && /^[ \t]*@?pause(?=[ \t>|&(]|$)/i.test(l.raw));

  assert.equal(offenders.length, 0,
    file + ' 的 :done 段落（第 ' + block.startLine + '–' + (block.endLine - 1) + ' 行）里还有裸 pause —— 约定③被破坏。\n'
    + '  后果：调用方（控制台.ps1 菜单第 1 项）在等这个窗口退出，这个窗口在等用户按键，\n'
    + '  而用户正盯着控制台 —— 谁也不动。\n'
    + '  修法：换成有上限、且允许按键跳过的等待，例如 `timeout /t 60 >nul`，'
    + '或者干脆 exit /b 0。\n'
    + '  失败路径（:startfail / :noport）的裸 pause 是这个用例**范围之外**的（那是必须让人看见的错误），'
    + '只要它不在 :done 段里就不算违规。\n'
    + '  违规原文：\n'
    + offenders.map(l => '    ' + file + ':' + l.n + '  ' + l.raw.trim()).join('\n'));
});

/* ============================================================ ④ 外套窗口的自我隐藏 */

test('④_内部\\外套窗口.ps1：这个文件必须存在（驱动器循环.cmd 靠它自我隐藏）', () => {
  assert.ok(fs.existsSync(P.coatPs1) && fs.statSync(P.coatPs1).isFile(),
    '文件不存在：' + rel(P.coatPs1) + '\n'
    + '  它是"外套窗口"的自我隐藏脚本：主动最小化自身控制台窗口 + 关掉该窗口的 QuickEdit。\n'
    + '  少了它，_内部\\驱动器循环.cmd 那个自愈外套就会以普通窗口挂在桌面上；\n'
    + '  更要命的是 QuickEdit 一开，用户在里面点一下鼠标，那个窗口就卡在"选择"模式，\n'
    + '  看着像死了（其实还在正常跑）。');
});

test('④_内部\\驱动器循环.cmd：必须有"自我隐藏"调用（外套窗口.ps1，或 ShowWindow + 0x40）', () => {
  const file = rel(P.loopCmd);
  const text = cmdText(readBytes(P.loopCmd));

  const hitsCoat = codeLineHits(allLines(text), '外套窗口.ps1');
  const hasCoatCall = hitsCoat.length > 0;
  const hasShowWindow = /ShowWindow/i.test(text);
  const hasQuickEditBit = /0x40/i.test(text);
  const hasFallback = hasShowWindow && hasQuickEditBit;

  assert.ok(hasCoatCall || hasFallback,
    file + ' 里没有"自我隐藏"调用 —— 约定④被破坏。\n'
    + '  要满足其中一条：\n'
    + '    1) 调用 _内部\\外套窗口.ps1（推荐）；或\n'
    + '    2) 自己出现 ShowWindow 相关调用，并且出现 0x40（ENABLE_QUICK_EDIT_MODE 那一位）。\n'
    + '  实测证据（这个工程踩过的）：外套是独立控制台窗口，QuickEdit = 1 时用户单击一下\n'
    + '  就会进入"选择"模式 —— 输出冻结、键盘被吃掉，看着像死窗口；\n'
    + '  点右键复制还会把整段输出连同键盘焦点一起吞掉。\n'
    + '  当前状态：调用 外套窗口.ps1 = ' + hasCoatCall
    + '；ShowWindow = ' + hasShowWindow + '；0x40 = ' + hasQuickEditBit + '。');
});

/* ============================================================ ⑤ launchOwnedEdge 的 spawn */

test('⑤runtime-processes.js：launchOwnedEdge 里启动 msedge 的 spawn 不得带 windowsHide: true', () => {
  const file = rel(P.runtimeJs);
  const text = utf8Text(readBytes(P.runtimeJs));

  const a = text.indexOf('function launchOwnedEdge');
  assert.ok(a >= 0, file + ' 里找不到 function launchOwnedEdge —— 这个函数被改名了？');

  const b = text.indexOf('const sleepMs', a);
  assert.ok(b > a,
    '在 function launchOwnedEdge（偏移 ' + a + '）之后找不到 const sleepMs ——\n'
    + '  这个用例靠这两个锚点把范围圈在 launchOwnedEdge 函数体内。\n'
    + '  如果 sleepMs 被改名/挪走了，请同步改这个用例的锚点。');

  const seg = text.slice(a, b);
  const calls = [];
  const re = /\bspawn\s*\(/g;                 // \b 让它不会撞上 spawnSync(
  let m;
  while ((m = re.exec(seg))) {
    const open = seg.indexOf('(', m.index);
    const src = sliceBalanced(seg, open);
    if (src) calls.push(src);
  }
  assert.ok(calls.length > 0,
    'function launchOwnedEdge 到 const sleepMs 之间一个 spawn(...) 都没有 ——\n'
    + '  圈出来的不是启动浏览器的那段代码，锚点需要更新。');

  const bad = calls.filter(src => /windowsHide\s*:\s*true/i.test(stripJsComments(src)));

  assert.equal(bad.length, 0,
    file + ' 的 launchOwnedEdge 里，启动 msedge 的 spawn 又带上了 windowsHide: true —— 约定⑤被破坏。\n'
    + '  为什么会出人命（已实测确认，不是推测）：Windows 上 windowsHide 会给子进程的\n'
    + '  STARTUPINFO 打上 SW_HIDE，而 Edge 是 detached 起的、父进程随后就撒手；\n'
    + '  结果浏览器主窗口**出生即隐藏** —— 进程在跑、页面正常、驱动器照跑，\n'
    + '  但用户屏幕上什么都看不到，只能自己开任务管理器去把它显示出来。\n'
    + '  注意：文件里别处（比如给 taskkill 这种控制台程序收尾）带 windowsHide: true 是**合法**的，\n'
    + '  所以这条断言只圈在 launchOwnedEdge 函数体内，不要在外面加全局检查。\n'
    + '  违规原文：\n'
    + bad.map(s => '    ' + s.replace(/\s+/g, ' ').trim().slice(0, 300)).join('\n'));
});

/** 从 text[openIdx]（'(' 或 '{'）取出配对到结尾的那一段。取不到返回 null。 */
function sliceBalanced(text, openIdx) {
  const open = text[openIdx];
  if (open !== '(' && open !== '{') return null;
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (ch === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}

/** 去掉 JS 的 // 与 /* *\/ 注释（字符串内容保留）。 */
function stripJsComments(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      out += ch; i++;
      while (i < code.length) {
        if (code[i] === '\\') { out += code[i] + (code[i + 1] || ''); i += 2; continue; }
        out += code[i];
        if (code[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i + 2); i = e < 0 ? code.length : e + 2; continue; }
    if (ch === '/' && code[i + 1] === '/') { const e = code.indexOf('\n', i); i = e < 0 ? code.length : e; continue; }
    out += ch; i++;
  }
  return out;
}

/* ============================================================ ⑥ _内部\*.ps1 的编码 */

const PS1_FILES = listInner('.ps1');
const CMD_FILES = listInner('.cmd');

test('⑥前提：_内部 目录里能列到 *.ps1（0 个的话说明目录被搬走了）', () => {
  assert.ok(PS1_FILES.length > 0,
    '在 ' + rel(INNER_DIR) + ' 里一个 *.ps1 都没发现。\n'
    + '  至少该有 显示助手窗口.ps1 和 外套窗口.ps1。');
});

for (const name of PS1_FILES) {
  const p = path.join(INNER_DIR, name);
  test('⑥编码·' + name + '：无 BOM 的 UTF-8 必须纯 ASCII（5.1 会按 ANSI 咬坏中文）', () => {
    const buf = readBytes(p);
    if (hasUtf8Bom(buf)) return;                 // 带 BOM：5.1 认它，允许非 ASCII
    if (highByteCount(buf) === 0) return;        // 纯 ASCII：无 BOM 也绝对安全
    if (!strictUtf8Ok(buf)) return;              // 不是 UTF-8（比如 GBK）：5.1 按 ANSI 读正好对

    const at = firstHighByte(buf);
    assert.fail(rel(p) + ' 是无 BOM 的 UTF-8，但里面有非 ASCII 字节 —— 约定⑥被破坏。\n'
      + '  为什么会出人命：Windows PowerShell 5.1 读**没有 BOM** 的文件时按 ANSI（代码页 936）解，\n'
      + '  这些 UTF-8 的字节会被两两咬成乱码汉字；中文提示变乱码是轻的，落在语法位置上就是解析错误\n'
      + '  （这个工程已经实测踩过一次）。而这个文件正是被 powershell -File 直接调起来的。\n'
      + '  两条修法，挑一条：① 用"UTF-8 with BOM"另存（最省事）；② 把非 ASCII 字符改成纯 ASCII 说明。\n'
      + '  实际字节：' + describeBytes(buf) + '\n'
      + '  第一个非 ASCII 字节附近：' + hexAround(buf, at));
  });
}

/* ============================================================ ⑦ _内部\*.cmd 的编码 */

/* 【2026-10-11 契约修订】原来这里写的是"_内部\*.cmd 一律 GBK、一律不得是 UTF-8"。
   那句话**字面过严**：现场有 设置.cmd / 解乱码.cmd 两个文件是 "chcp 65001 + UTF-8"
   的自洽组合，本来就能正常跑 —— 实测按 GBK 读它们会得到 "绛旈鍔╂墜" 这种典型乱码，
   正说明它们确实是 UTF-8；而它们的代码页也声明成 65001，编码与代码页是一致的。
   契约的本意从来不是"必须用哪一种编码"，而是"别让编码和代码页对不上"：
     · GBK 文件 + chcp 936        → 对
     · UTF-8 文件 + chcp 65001    → 对
     · 纯 ASCII                   → 两种都对，没有歧义
     · GBK 文件被另存成 UTF-8、却还留着 936 → **出事的就是这一种**，
       cmd.exe 按 936 去读 UTF-8 字节，文件里所有中文提示全烂。
   所以判据改成"存储编码必须与它自己声明的代码页自洽"。 */
function declaredCodepage(text) {
  const m = /^\s*chcp\s+(\d+)/im.exec(text);
  return m ? m[1] : null;              // '936' / '65001' / null（没写 chcp，走系统默认 936）
}

test('⑦前提：_内部 目录里能列到 *.cmd（0 个的话说明目录被搬走了）', () => {
  assert.ok(CMD_FILES.length > 0,
    '在 ' + rel(INNER_DIR) + ' 里一个 *.cmd 都没发现。\n'
    + '  至少该有 开始.cmd / 停止.cmd / 驱动器循环.cmd。');
});

for (const name of CMD_FILES) {
  const p = path.join(INNER_DIR, name);
  const text = () => cmdText(readBytes(p));

  /* 【契约修订 2026-10-11】原来这两条的判据是"必须 GBK、不得是 UTF-8"，字面过严。
     现场 设置.cmd / 解乱码.cmd 是 "chcp 65001 + UTF-8" 的自洽组合，本来就能跑。
     真正会出事的是"编码和代码页对不上"——比如 GBK 文件被另存成 UTF-8 却还留着 936。
     所以这里改成：按**文件自己声明的代码页**去要求编码。 */
  test('⑦编码·' + name + '：存储编码必须与它声明的代码页自洽', () => {
    const buf = readBytes(p);
    const high = highByteCount(buf);
    if (high === 0) return;            // 纯 ASCII：两种代码页都对，没有歧义

    const cp = declaredCodepage(text());
    const isUtf8 = strictUtf8Ok(buf);
    const gbkBad = gbkFirstBadOffset(buf);

    if (cp === '65001') {
      assert.ok(isUtf8,
        rel(p) + ' 声明了 chcp 65001（UTF-8 代码页），但它并不是合法的 UTF-8。\n'
        + '  后果：cmd.exe 会按 UTF-8 解释这些字节，文件里的中文提示会显示成乱码。\n'
        + '  修法：把它存成 UTF-8；或者去掉 chcp 65001 并存成 GBK —— 编码和代码页必须配套。\n'
        + '  实际字节：' + describeBytes(buf));
      return;
    }

    assert.ok(gbkBad < 0,
      rel(p) + ' 没有声明 chcp 65001（cmd.exe 会按系统默认的 936 读它），但它在 GBK 下解不出（偏移 ' + gbkBad + '）。\n'
      + '  最常见的原因：这个 GBK 文件被编辑器另存成了 UTF-8 ——\n'
      + '  于是 cmd.exe 按 936 去读 UTF-8 字节，文件里所有中文提示全烂。\n'
      + '  修法：① 另存为 ANSI/GBK（推荐，和其它 .cmd 保持一致）；\n'
      + '        ② 或者你确实想用 UTF-8，那就在文件开头写上 chcp 65001，让两者配套。\n'
      + '  实际字节：' + describeBytes(buf) + '\n'
      + '  问题字节附近：' + hexAround(buf, gbkBad));
  });

  test('⑦编码·' + name + '：按声明的代码页解码，不许出现替换字符', () => {
    const buf = readBytes(p);
    if (highByteCount(buf) === 0) return;

    const cp = declaredCodepage(text());
    if (cp === '65001') {
      assert.ok(strictUtf8Ok(buf),
        rel(p) + ' 在 UTF-8 严格解码下失败 —— 里面有多字节序列被截断了。\n'
        + '  这会把它后面那一整行的解析都带歪。\n'
        + '  实际字节：' + describeBytes(buf));
      return;
    }

    const repl = gbkReplacementCount(buf);
    if (repl !== null) {
      assert.equal(repl, 0,
        rel(p) + ' 用真正的 GBK 解码器解出了 ' + repl + ' 个替换字符（U+FFFD）—— 契约⑦被破坏。\n'
        + '  字节结构扫描没抓到的边角（保留码位等），解码器抓到了。\n'
        + '  实际字节：' + describeBytes(buf));
    }
  });}

/* ============================================================ ⑧ SANDBOX 取值一致 */

test('⑧_内部\\开始.cmd 与 _内部\\停止.cmd：set "SANDBOX=..." 的取值必须完全一致', () => {
  const a = extractSetValues(cmdText(readBytes(P.startCmd)), 'SANDBOX');
  const b = extractSetValues(cmdText(readBytes(P.stopCmd)), 'SANDBOX');

  assert.ok(a.length > 0, rel(P.startCmd) + ' 里找不到 set "SANDBOX=..." —— 关浏览器的所有权凭证就靠它。');
  assert.ok(b.length > 0, rel(P.stopCmd) + ' 里找不到 set "SANDBOX=..." —— 关浏览器的所有权凭证就靠它。');

  const va = [...new Set(a.map(x => x.value))];
  const vb = [...new Set(b.map(x => x.value))];

  assert.deepEqual(va, vb,
    '两个文件的 SANDBOX 取值不一致 —— 约定⑧被破坏。\n'
    + '  后果：浏览器是按 开始.cmd 的 SANDBOX 那个 profile 起的，凭证也记的是它；\n'
    + '  关的时候 停止.cmd 拿着自己那个值去比对 → 对不上 → 直接拒绝执行\n'
    + '  （"没能确认那就是助手启动的浏览器 —— 所以一个进程都没关"），用户会以为关不掉。\n'
    + '  ' + rel(P.startCmd) + '：' + JSON.stringify(va)
    + '\n  ' + rel(P.stopCmd) + '：' + JSON.stringify(vb) + '\n'
    + '  原文：\n'
    + a.map(x => '    ' + rel(P.startCmd) + ':' + x.n + '  ' + x.raw).join('\n') + '\n'
    + b.map(x => '    ' + rel(P.stopCmd) + ':' + x.n + '  ' + x.raw).join('\n'));
});

/* ============================================================ ⑨ 判活写法 */

test('⑨_内部\\驱动器循环.cmd：必须有 --status-exit 判活（看退出码，不看 JSON 字符串）', () => {
  const file = rel(P.loopCmd);
  const text = cmdText(readBytes(P.loopCmd));
  const hits = codeLineHits(allLines(text), '--status-exit');

  assert.ok(hits.length > 0,
    file + ' 里找不到非注释的 --status-exit —— 约定⑨被破坏。\n'
    + '  它是 runtime-processes.js 给 cmd 用的机器可读判活：退出码 0 = 有一个\n'
    + '  **身份验证通过**（PID + 创建时间 + node 映像 + driver.js 完整路径全对上）的驱动器在跑。\n'
    + '  回到字符串匹配就会同时踩两个坑：JSON 转义在 cmd 里不可移植，而且只判 alive\n'
    + '  会漏掉 verified=false（PID 被复用）那种最危险的误判 —— 两个驱动器同抢一个页面。');
});

test('⑨_内部\\驱动器循环.cmd：可执行代码里不得有 findstr 配 alive 的旧写法', () => {
  const file = rel(P.loopCmd);
  const text = cmdText(readBytes(P.loopCmd));
  const lines = allLines(text);
  const offenders = codeLineHits(lines, 'findstr').filter(l => /alive/i.test(l.raw));

  assert.equal(offenders.length, 0,
    file + ' 的可执行代码里还有 findstr 配 alive 的旧写法 —— 约定⑨被破坏。\n'
    + '  旧写法长这样：echo !DRV! | findstr /c:"\\"alive\\":true"\n'
    + '  它有两个问题：① 引号 + 反斜杠的写法在真实 cmd.exe 里不可移植（实测连"alive 明明是\n'
    + '  true"的合成输出都匹配不上）；② 它只判 alive，会漏掉 verified=false（PID 复用）——\n'
    + '  那正是最危险的误判。\n'
    + '  修法：调用 runtime-processes.js --status-exit，只认退出码。\n'
    + '  （注释里提一句"旧写法是 findstr ..."是允许的，那是历史说明；这里查的是可执行行。）\n'
    + '  违规原文：\n'
    + offenders.map(l => '    ' + file + ':' + l.n + '  ' + l.raw.trim()).join('\n'));
});

/* ============================================================ ⑪ goto/call 的标签配对 */

/* 新脚本最容易犯的错：改了标签名，只改了一边。
   本轮给 开始.cmd 加 :ShowAssistantWindow 子过程时就差点漏掉 label 定义
   （call 加在前面、label 要加在文件末尾），是静态检查抓出来的。
   这个用例把三个 .cmd 里所有 `goto :X` / `call :X` 的引用目标，跟**同一个文件**里的
   行首标签定义对一遍：引用得到、定义找不到 = 悬空 = 红。

   两个坑（本轮亲自踩过，别重复）：
     · 找定义**必须用行首锚点** `^:X`。用 IndexOf(':done') 会先命中 `goto :done` 里那个
       `:done`，算出来的位置是错的（当时算出个负的切片长度）。
     · 标签名一律小写后比较 —— cmd 的标签不区分大小写，:Done 和 :done 是同一个。 */

const LABEL_FILE_LIST = [P.startCmd, P.stopCmd, P.loopCmd];
/* 行首标签定义：前面最多有空白/制表符，后面到行尾（\r 已被 splitLines 切掉）。 */
const CMD_LABEL_DEF_RE = /^[ \t]*:([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/;
/* 引用：goto :X / call :X。冒号必须紧跟 goto/call，所以 call "node.exe" 这种不会撞上。 */
const CMD_LABEL_REF_RE = /\b(?:goto|call)[ \t]+:([A-Za-z_][A-Za-z0-9_]*)/gi;
/* cmd 内建目标：goto :eof 表示"结束当前子过程"，文件里本来就不该有 :eof 这个标签。 */
const CMD_BUILTIN_LABELS = new Set(['eof']);

test('⑪_内部\\*.cmd：goto/call 引用的标签必须在同一个文件里有行首定义', (t) => {
  const dangling = [];
  const unused = [];

  for (const p of LABEL_FILE_LIST) {
    const file = rel(p);
    /* 剥掉 rem / :: 注释行再扫 —— 注释里写的 "原来是 goto :old" 是历史说明，不算代码。
       stripCmdComments 保留行数（注释行变空行），所以行号照样准。 */
    const lines = splitLines(stripCmdComments(cmdText(readBytes(p))));

    const defs = new Map();                 // 小写标签名 -> 行首定义所在行号
    for (let i = 0; i < lines.length; i++) {
      const m = CMD_LABEL_DEF_RE.exec(lines[i]);
      if (m && !defs.has(m[1].toLowerCase())) defs.set(m[1].toLowerCase(), i + 1);
    }

    const refs = new Map();                 // 小写标签名 -> [引用所在行号...]
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(CMD_LABEL_REF_RE)) {
        const name = m[1].toLowerCase();
        if (CMD_BUILTIN_LABELS.has(name)) continue;
        if (!refs.has(name)) refs.set(name, []);
        refs.get(name).push(i + 1);
      }
    }

    for (const [name, at] of refs) {
      if (!defs.has(name)) dangling.push({ file, name, at });
    }
    for (const [name, lineNo] of defs) {
      if (!refs.has(name)) unused.push({ file, name, lineNo });
    }
  }

  /* 定义了但没人引用的标签不是错：很多是"顺序执行正好落下来"进入的分支。
     所以只当信息输出（t.diagnostic），不参与判定。 */
  if (unused.length) {
    t.diagnostic('（信息，不算错）定义了但没有任何 goto/call 指向它的标签 —— '
      + '通常是靠"顺序执行落下来"进入的分支，正常：\n'
      + unused.map(u => '      ' + u.file + ' 第 ' + u.lineNo + ' 行  :' + u.name).join('\n'));
  }

  assert.equal(dangling.length, 0,
    '有 goto/call 指向的标签，在同一个文件里找不到行首定义 —— 约定⑪被破坏。\n'
    + '  最常见的成因：改了标签名只改了一边（引用改了、定义忘了改，或者反过来）。\n'
    + '  后果：cmd.exe 走到那一句会直接报「找不到批处理标签」并中止，整条启动链路就断在那里。\n'
    + '  悬空引用：\n'
    + dangling.map(d => '    ' + d.file + ' ：:' + d.name
      + '  被引用于第 ' + d.at.join('、') + ' 行，但本文件里没有行首的 ":' + d.name + '"').join('\n') + '\n'
    + '  修法：要么把标签定义补上（必须是行首、单独一行，前面最多有空白），'
    + '要么把引用改成正确的标签名。\n'
    + '  注意：cmd 标签不区分大小写（:Done 与 :done 是同一个），比较时统一按小写；'
    + 'goto :eof 是内建目标，不算悬空。');
});

/* ============================================================ ⑫ 页面内嵌 JS 里的 \n */

/* 为什么要守这一条（2026-10-11 实撞）：
   网页控制台把整个页面放在一个模板字符串里 —— const PAGE = `<!doctype html> ... `;
   模板字符串会在**服务端**就把 \n 解释成真换行。所以写在前端 JS 字符串里的单反斜杠 \n，
   到了生成的 HTML 里就变成一个**真的换行**，把那句 JS 从中间截断：

       alert('这个页面的会话已经过期了。
             ^^^^  SyntaxError: Invalid or unexpected token

   而 <script> 里**只要有一处语法错就整块不执行**：页面标题照常渲染（HTML 本身是好的），
   但 api / TOKEN / 定时刷新 / 所有 onclick 全部失效 ——
   用户看到的现象是"点任何按钮都完全没反应"。
   这个缺陷在 2026-10-11 的发包版本里就已经存在，整页脚本从未执行过。

   注意：服务端 JS 用 node --check 是**查不出**这个的（它只查外层代码），
   必须在生成的 HTML 上抽出 <script> 再查；这里直接守源码更省事 ——
   模板字符串范围内的单反斜杠 \n 一律不许有，必须写 \\n。 */
test('⑫网页控制台.js：页面模板里的 \\n 必须写成 \\\\n（单反斜杠会让整块 script 不执行）', () => {
  const src = utf8Text(readBytes(P.webConsoleJs));
  const i1 = src.indexOf('const PAGE = `');
  assert.ok(i1 >= 0, rel(P.webConsoleJs) + ' 里找不到 "const PAGE = `" —— 页面定义被改名或去掉了？');
  const i2 = src.indexOf('`;', i1);
  assert.ok(i2 > i1, rel(P.webConsoleJs) + ' 里找不到模板字符串的结尾 "`;"');
  const seg = src.slice(i1, i2);

  const bad = [];
  for (const m of seg.matchAll(/(?<!\\)\\n/g)) {
    const upto = seg.slice(0, m.index);
    const lineNo = upto.split('\n').length;
    const text = upto.split('\n').pop().trim();
    bad.push('  模板内第 ' + lineNo + ' 行附近：…' + text.slice(-60) + '\\n');
  }

  assert.equal(bad.length, 0,
    rel(P.webConsoleJs) + ' 里有 ' + bad.length + ' 处单反斜杠 \\n —— 约定⑫被破坏。\n'
    + '  为什么危险：整个页面是一块模板字符串，单反斜杠 \\n 会在服务端就被解释成真换行，\n'
    + '  把前端 JS 的字符串从中间截断；而 script 块里有一处语法错就整块不执行，\n'
    + '  表现是"页面标题正常、但点任何按钮都没反应"。\n'
    + '  修法：模板字符串里的 \\n 一律写成 \\\\n（两个反斜杠）。\n'
    + '  命中位置：\n' + bad.join('\n'));
});
test('⑭网页控制台.js：单实例保护（今天两个控制台打架 ⇒ 页面点了没反应）', () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, '网页控制台.js'), 'utf8');
  /* 探针：走 /api/hello；判定用的 app 名必须和应答里的字面量一模一样 */
  assert.match(src, /function probeOwnConsole\(port, cb\)/, '要有探测函数');
  assert.match(src, /path: '\/api\/hello'/, '探测走 /api/hello');
  assert.match(src, /j\.app === '学习通助手控制台'/, '探针按 app 名认自己人');
  assert.match(src, /app: '学习通助手控制台'/, '应答里的 app 名要和探针里的一致（改一处必须改两处）');
  /* 应答必须**跳过 token 检查**：新进程就是靠它认人的，带 token 就永远认不出来（今天就这么错过了） */
  const hello = src.split("u.pathname === '/api/hello'")[1] || '';
  assert.ok(hello.indexOf('checkHost') >= 0, '/api/hello 也要过 Host 检查（只本机）');
  assert.ok(hello.slice(0, 900).indexOf('readJsonBody') < 0, '/api/hello 不该去读 body');
  /* 启动流程：先探测 → 命中就打印并退出，不再占端口。
     锚点用"命中后那段提示语"（比注释稳：注释改错字就会让用例假红 —— 今天真踩了）。 */
  const boot = src.split('已经有一个网页控制台在跑了')[1] || '';
  assert.ok(boot.length > 100, '要能找到"命中已有控制台"那一段');
  assert.ok(boot.indexOf('process.exit(0)') >= 0, '命中已有控制台时要正常退出（退出码 0）');
  assert.match(src, /已经有一个网页控制台在跑了/, '要有人话提示');
  assert.match(src, /不再开第二个/, '要说清"不再开第二个"');
  /* 【必须跨端口查】2026-10-12 又栽一次：--open 默认 8898、手动跑 8899，各看各的端口 ⇒ 又并存两个，
     法师打开的是旧那个 ⇒ "导出的题库码那个框没出来"。所以要在**一片端口**上找自己人。 */
  assert.match(src, /const OWN_PROBE_PORTS = \[WANT_PORT\]\.concat\(\[8898, 8899, 8900, 8901, 8902, 8903\]/, '要在多个端口上找自己人');
  assert.match(src, /for \(const p of OWN_PROBE_PORTS\)/, '启动时要遍历这些端口');
  assert.match(src, /它在 ' \+ p \+ ' 端口，不是本程序想用的/, '端口不一致时要说清楚（别让人以为是同一个）');
});

test('⑬网页控制台.js：整块页面脚本必须能被 JS 解析（2026-10-12：这块语法错 ⇒ 所有按钮点着没反应）', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(PROJECT_ROOT, '网页控制台.js'), 'utf8');
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '要能找到页面里的 script 块');
  const code = m[1].replace(/__CONSOLE_TOKEN__/g, 'x'.repeat(64));
  /* 【要还原成"浏览器真正收到的那段文本"】页面是用模板字符串拼的：
     文件里写 `\\` ⇒ 浏览器收到一个 `\`。所以解析之前先做这一步替换 ——
     不然文件里那个 "少转义一层" 的写法在本检查里看着是合法的（今天就是这么溜过去的）。 */
  const served = code.replace(/\\\\/g, '\\');
  let err = null;
  try { new vm.Script(served); } catch (e) { err = e; }
  /* 先自检这个检查器本身：故意造一段"浏览器会看到 \' "的文本，必须被判为语法错 */
  let checkerWorks = false;
  try { new vm.Script("var x = 'a\\' + 1;"); } catch (e) { checkerWorks = true; }
  assert.ok(checkerWorks, '检查器自检：浏览器遇到 \' 结尾的字符串必须报语法错');
  /* 单反斜杠（比如 split('\\') 写法在模板里少了一层）会让整块脚本 SyntaxError，
     浏览器里一点提示都没有 —— 表现就是"点谁都没反应"。这条用例专门盯这个。 */
  assert.equal(err, null, '页面脚本必须有合法语法：' + (err && err.message));
  /* 再加一道：模板里不该出现"看起来只是想打一个反斜杠"的写法（\\' / split('\\') 这种） */
  const suspicious = served.split('\n').filter((l) => /\\\\['"]/.test(l) || /split\('\\\\'\)/.test(l));
  assert.equal(suspicious.length, 0, '这些行里像是少转义了一层：\n' + suspicious.slice(0, 3).join('\n'));
});

test('产品文件里的反引号必须成对（裸反引号会把模板字符串截断 —— 2026-10-12 栽了三次）', () => {
  const files = ['答题助手.js', 'driver.js', '网页控制台.js', '题库.js', '字体识别.js', '图片指纹.js', '课程名.js', '填作业.js'];
  for (const f of files) {
    const p = path.join(__dirname, '..', f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    const n = s.split('`').length - 1;
    assert.equal(n % 2, 0, f + ' 里的反引号是奇数个（' + n + '）—— 多半是注释里写了裸反引号，模板字符串被截断了');
  }
});