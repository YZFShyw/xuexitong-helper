/* 学习通 CDP 驱动器 —— 让视频真的播、播完翻节、顺带滚文档。
 *
 * 全部结论都是实测出来的，不是猜的：
 *
 *   1. 视频在第三层 iframe 里：顶层 -> #iframe -> iframe.ans-attach-online -> <video>
 *      三层全部同源，顶层可以直接 contentDocument 穿透到底。
 *
 *   2. 起播靠「可信点击」播放键（CDP Input.dispatchMouseEvent）。
 *      自己 dispatchEvent 造的 isTrusted=false，播放器不认。
 *      坐标要换算到顶层视口，而且必须先 scrollIntoView —— 按钮可能在视口外面，
 *      打在视口外的坐标等于什么都没点。
 *
 *   3. 【最关键】绝对不要碰 video.playbackRate。
 *      平台有一个 1Hz 检测：发现 playbackRate !== 1 就立刻 pause() 并把倍速按回 1，
 *      然后每秒再 pause() 一次反复确认。所有「一播就停」都是这个原因。
 *      倍速保持 1 的时候，视频可以稳定播到底（实测 73 秒匀速走 73 秒）。
 *
 *   4. 翻节：先 scrollIntoView，再用 document.elementFromPoint 做命中测试，通过了才点，
 *      然后等章节真的换掉才继续。连续失败就停，不做无意义的连点。
 *
 *   5. 跳过弹窗：作者（nuaa学习助理）的 find_confirmation_bypass_button 用的是
 *      .popDiv.wid440.popMove .nextChapter / .popDiv a.nextChapter / a.nextChapter 这一串，
 *      门禁条件是正文含「还有任务点未完成」。这里沿用他的选择器顺序。
 *      注意页面上有多个 .popDiv，那个高特异性选择器是必要的。
 *
 *   6. 跳过的章节会写进 待办-未完成任务点.txt。跳过只是导航，
 *      不提交任何东西、不伪造任何完成标记 —— 欠着的任务点照样欠着。
 *
 * 用法：
 *   node driver.js                       只观察，不点任何东西
 *   node driver.js --run                 驱动：播起来、掉了就续播
 *   node driver.js --run --next          播完自动点「下一节」
 *   node driver.js --run --next --force  再加上：遇到「还有任务点未完成」弹窗自动跳过
 *   node driver.js --seconds=120         跑满 N 秒后自动停（默认不限）
 *   node driver.js --run --next --force --speed=60
 *                                        伪心跳 60 倍速：不碰 playbackRate，
 *                                        替播放器把进度报上去（见 伪心跳.js）
 * 环境变量：CDP_PORT(9222)   MUTE=0(不静音)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const quizMod = require('./答题助手.js');
const hbMod = require('./伪心跳.js');

const PORT = Number(process.env.CDP_PORT || 9222);
const RUN = process.argv.includes('--run');
const NEXT = process.argv.includes('--next');
const FORCE = process.argv.includes('--force');
const secArg = process.argv.find((a) => a.startsWith('--seconds='));
const MAX_SECONDS = secArg ? Number(secArg.split('=')[1]) : 0;
const KEEP_MUTED = process.env.MUTE !== '0';

/* ---- 伪心跳 60 倍速（--speed=N，默认 0 = 关）----
   为什么单独做一套开关，而不是直接改 playbackRate：
     平台的 1Hz 看门狗一发现 playbackRate !== 1 就 pause + 按回 1（见 原理说明.txt），
     而且它的判据是「观看时长必须等于真实流逝的时间」。
     所以这里不碰播放器，改为**替播放器上报进度**。整套逻辑在 伪心跳.js 里。 */
const hbSpeedArg = process.argv.find((a) => a.startsWith('--speed='));
const HB_SPEED = (() => {
  const v = hbSpeedArg ? Number(hbSpeedArg.split('=')[1]) : 0;
  return isFinite(v) && v > 1 ? v : 0;
})();
const hbTickArg = process.argv.find((a) => a.startsWith('--speed-tick='));
const HB_TICK_MS = (() => {
  const v = hbTickArg ? Number(hbTickArg.split('=')[1]) : 2000;
  /* 不要往小里调：成熟开源项目的原话是「上报进度极其容易卡验证码，限制 2s 一次」 */
  return isFinite(v) && v >= 500 ? Math.floor(v) : 2000;
})();
const HB_JUMP = !(process.argv.includes('--speed-no-jump') || process.env.SPEED_JUMP === '0');
/* 最多发几条（含首发）。默认值从模块里取，免得两边各写一份数字对不上。
   想保守一点就 --speed-max=3；想多试几次就 --speed-max=15。 */
const hbMaxArg = process.argv.find((a) => a.startsWith('--speed-max='));
const HB_MAX_TRIES_ARG = (() => {
  const v = hbMaxArg ? Number(hbMaxArg.split('=')[1]) : hbMod.HB_MAX_TRIES;
  return isFinite(v) && v >= 1 ? Math.floor(v) : hbMod.HB_MAX_TRIES;
})();

const TODO_FILE = path.join(__dirname, '待办-未完成任务点.txt');
/* 【保存没被确认时的"翻页闸门"】纯判断在 driver-save-gate.js 里（可离线测），
   这里只负责把结论变成动作：保留当前题页 + 写停止标记 + 退出主驱动。
   为什么必须有它：答题助手点过「暂时保存」≠ 平台存上了，
   这时候翻页 / 切栏目 / 让外套重拉一个新驱动器都会把草稿弄丢，
   而日志里看着像"这一章做完了"。 */
const saveGateMod = (() => {
  try { return require('./driver-save-gate.js'); }
  catch (e) {
    log('（driver-save-gate.js 加载失败：' + ((e && e.message) || e) + ' —— 本轮不能靠它拦翻页）');
    return null;
  }
})();
/* 外套（_内部\驱动器循环.cmd）只认这个文件；它一旦存在就不会 15 秒后自动重拉。 */
const STOP_FLAG_FILE = path.join(__dirname, '_内部', saveGateMod ? saveGateMod.STOP_FLAG_FILE : '停止标记.txt');
/* 【记住"上次跑的是哪门课"】
   为什么要存盘：同时开着两门课的学习页时（换课常见），
   按"列表里第一个 studentstudy"挑会挑回旧课 —— 换课等于没换（2026/9/27 实测）。
   启动时先读上一次记下的 courseId，用来在多个候选里挑对的。
   写失败不影响运行（沙箱里就写不了），所以全程 try 包着。 */
const COURSE_FILE = path.join(__dirname, '_上次的课程.txt');
function readLastCourseId() {
  try { return String(fs.readFileSync(COURSE_FILE, 'utf8')).trim().replace(/[^0-9]/g, ''); }
  catch (e) { return ''; }
}
function writeLastCourseId(id) {
  try { fs.writeFileSync(COURSE_FILE, String(id), 'utf8'); } catch (e) {}
}
let lastCourseId = readLastCourseId();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8);
const hhmmss = (s) => {
  if (!isFinite(s) || s <= 0) return '--:--';
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};
const log = (...a) => console.log('[' + ts() + '] ' + a.join(' '));

/* ---------------- 只在运行期间阻止睡眠 ----------------
   用 Windows 的 SetThreadExecutionState，交给 保持唤醒.ps1 去持这个请求：
     * 只申请 ES_SYSTEM_REQUIRED（不睡眠）
     * 故意不申请 ES_DISPLAY_REQUIRED（屏幕照样可以正常息屏）
     * 请求挂在那个助手进程上，助手一退出就自动解除
   所以：本程序跑着的时候不会睡；一停就恢复你的电源设置原状，不留任何改动。
   想关掉这个行为：启动前设 NO_KEEPALIVE=1 */
let keepProc = null;
function startKeepAwake() {
  if (process.env.NO_KEEPALIVE === '1') { log('（NO_KEEPALIVE=1，不申请阻止睡眠）'); return; }
  const helper = path.join(__dirname, '保持唤醒.ps1');
  if (!fs.existsSync(helper)) { log('（找不到 保持唤醒.ps1，运行期间可能被系统睡眠）'); return; }
  try {
    keepProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
       '-File', helper, '-ParentPid', String(process.pid)],
      { stdio: 'ignore', windowsHide: true });
    /* 关键：unref()。不加的话这个子进程会一直占着 node 的事件循环，
       而它自己又在等父进程（我们）死掉才退出 —— 互相等，进程永远退不出来。
       表现就是：日志已经打完「驱动器结束。」，但进程挂着不消失。 */
    if (keepProc && typeof keepProc.unref === 'function') keepProc.unref();
    log('已申请「运行期间不睡眠」—— 屏幕仍可正常息屏，不动你的电源设置');
  } catch (e) {
    log('（申请阻止睡眠失败：' + e.message + '）');
  }
}
function stopKeepAwake() {
  if (keepProc) { try { keepProc.kill(); } catch (e) { /* 已经没了 */ } keepProc = null; }
}

/* 【单实例：原子锁 + 身份验证（2026-10-11 重做）】
 *
 * 旧版只做两件事：读 运行中.pid、process.kill(pid, 0)。两个真事故：
 *   ① 驱动器被强杀/崩溃时 pid 文件残留（clean() 在 exit 钩子里才删，强杀不走）。
 *      Windows 把那个 PID 回收给别的程序之后，下一次启动被"已经有一个在跑了"挡住；
 *      更糟的是点「停止」会 taskkill /f 一个**完全无关**的进程。
 *   ② "读文件 + 查活"两步之间有竞态，两个启动入口同时点会双双通过。
 *
 * 现在：
 *   · 锁文件 = 驱动器锁.json（原子写：临时文件 + rename），里面记 PID、
 *     进程创建时间、node 映像路径、driver.js 完整路径；
 *   · 判活 = PID + 创建时间 + 映像名 + 命令行里"正好等于"driver.js 完整路径，
 *     四样全对上才算"它在跑"。只凭 PID 活着**不算**（PID 复用是这个功能的头号杀手）；
 *   · 锁的主人验证不过 = 陈旧锁，删掉再抢；删不掉就**明确失败**（宁可让你看见，
 *     也绝不"悄悄两个实例一起跑"）；
 *   · 退出只清自己的锁（内容不是自己的一个字节都不动），并只删自己写的 运行中.pid；
 *   · 运行中.pid 继续写，纯粹是为了兼容显示（控制台/停止.cmd 还在读它）。
 *     注意：**不再**用它来拒绝启动 —— 旧文件里的 PID 完全可能属于别的进程。
 */
const PID_FILE = path.join(__dirname, '运行中.pid');
const LOCK_FILE = '驱动器锁.json';
let lockHeld = false;
let ownPidFile = false;
const lockToken = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + process.pid;
const lockMod = (() => {
  try { return require('./runtime-processes.js'); }
  catch (e) {
    log('✗ 加载 runtime-processes.js 失败：' + ((e && e.message) || e));
    log('  没有它就无法确认"这个 PID 到底是不是驱动器"，也就不能保证不会误杀/双开。');
    process.exit(3);
    return null;
  }
})();
/* ---------- 本轮检查点（跨"外套重启"的去重账） ----------
   外套（_内部\驱动器循环.cmd）每约 15 秒就会把 driver.js 重新拉起来，
   而"这一章填过题没有"这类账以前只存在内存里 —— 新进程一进来就是白纸，
   于是同一章被再开一次测验、再截一次图、再问一次模型（重复计费）。
   现在存一份小的检查点。**批次标识**由新启动生成（开始.cmd/控制台点 1），
   外套内部重启沿用环境变量里的同一个 —— 这样"同一次运行"账目连续，
   而下一次全新启动不会背上前一次的旧账。状态里不存任何凭据。 */
const CHK_FILE = '驱动器检查点.json';
const checkpointMod = (() => {
  try { return require('./driver-checkpoint.js'); }
  catch (e) {
    log('（driver-checkpoint.js 加载失败，本轮不做跨重启去重：' + ((e && e.message) || e) + '）');
    return null;
  }
})();
/* 批次标识的来源优先级：
 *   ① 环境变量 DSH_BATCH（开始.cmd / 控制台 生成，外套重启时原样传下来）
 *   ② 命令行 --batch=xxx（外套也可以直接写在命令行里）
 *   ③ 都没有（比如手动 node driver.js）→ 自己生成一个新的，视为"新启动"。 */
const batchArg = process.argv.find((a) => a.startsWith('--batch='));
const CHECKPOINT_BATCH = (checkpointMod && (
  checkpointMod.batchFromEnv(process.env) ||
  (batchArg && checkpointMod.isBatchId(batchArg.split('=')[1]) ? batchArg.split('=')[1] : '')
)) || (checkpointMod ? checkpointMod.newBatchId() : '');
let CHK = null;
let chkWriteErrNoted = '';
if (checkpointMod) {
  try {
    CHK = checkpointMod.openCheckpoint(__dirname, CHECKPOINT_BATCH, { log: (m) => log(String(m)) });
    if (CHK.errors.length) {
      chkWriteErrNoted = CHK.errors[CHK.errors.length - 1];
      log('⚠ 检查点写不进去：' + chkWriteErrNoted);
      log('  意思是：外套把驱动器重启一次之后，"这一章本轮填过题"这类账会丢，'
        + '同一章可能被重复填一次（多花 API 钱）。运行本身可以继续。');
    }
    const pruned = checkpointMod.pruneCheckpoints(__dirname, { currentBatch: CHECKPOINT_BATCH, keepBatches: 8 });
    if (pruned.removed.length) log('（清掉 ' + pruned.removed.length + ' 份过老的检查点）');
    log('（本轮批次：' + CHECKPOINT_BATCH + ' —— 外套内部重启会沿用这个标识，账目不会断）');
  } catch (e) {
    chkWriteErrNoted = (e && e.message) || String(e);
    log('⚠ 打开检查点失败（' + chkWriteErrNoted + '）：本轮不做跨重启去重，但会继续跑。');
  }
}
const driverScriptPath = path.join(__dirname, 'driver.js');
try {
  const self = lockMod.currentProcessStart();
  if (!self.ok) {
    log('✗ 读不到本进程的创建时间（' + self.reason + '），没法建立"防 PID 复用"的单实例锁。');
    log('  为了不出现两个驱动器同时动一个页面，本次**不启动**。');
    process.exit(3);
  }
  const acq = lockMod.acquireDriverLock(__dirname, {
    pid: process.pid,
    start: self.start,
    exe: self.exe,
    driverScript: driverScriptPath,
    batch: CHECKPOINT_BATCH,
    token: lockToken,
  });
  if (!acq.ok) {
    log('⚠ 没能取得驱动器锁，本次**不启动**：' + acq.reason);
    if (acq.holder) log('  在跑的那个是 PID ' + acq.holder.pid + '（创建于 ' + (acq.holder.start || '?') + '）。');
    log('  怎么办：等它跑完；或者双击 _内部\\停止.cmd 停掉它，再重新启动。');
    log('  同时跑两个会互相把对方正在做的章节翻走："章节来回跳"、白跑一趟还多花 API 钱。');
    process.exit(2);
  }
  if (acq.tookOver) log('（接管了一个陈旧锁：原来那条记录验证下来不是活着的驱动器，已作废）');
  lockHeld = true;
  /* 兼容显示：运行中.pid 写自己的 PID。写失败不影响单实例保护（锁才是权威），
     但要说清楚，免得以后有人对着一个空 pid 文件查半天。 */
  const wrote = lockMod.writeLegacyPidFile(__dirname, process.pid);
  if (wrote.ok) ownPidFile = true;
  else log('（运行中.pid 写不进去：' + wrote.reason + ' —— 不影响单实例保护，只是控制台那边会显示"没在跑"）');
} catch (e) {
  log('✗ 建立单实例锁时出错：' + ((e && e.stack) || e));
  log('  不敢在没有锁的情况下继续跑（那就是两个实例同时动一个页面）。本次不启动。');
  process.exit(3);
}

const clean = () => {
  stopKeepAwake();
  /* 检查点再落一次盘：进程被杀（exit 钩子也走这里）时，这一轮的去重账不能白丢。
     写不进去只记一句话，绝不在这里抛异常（抛了会把退出流程本身搞乱）。 */
  try {
    if (CHK) {
      const r = CHK.flush();
      if (!r.ok) log('（退出时检查点写入失败：' + (r.reason || '未知') + '）');
    }
  } catch (e) {}
  try { if (lockHeld) lockMod.releaseDriverLock(__dirname, { pid: process.pid, token: lockToken }); } catch (e) {}
  try { if (ownPidFile) lockMod.removeLegacyPidFileIfOwn(__dirname, process.pid); } catch (e) {}
  lockHeld = false;
  ownPidFile = false;
};
process.on('exit', clean);
process.on('SIGINT', () => { log('收到 Ctrl+C，退出。'); clean(); process.exit(0); });
process.on('SIGTERM', () => { log('收到 SIGTERM（有人/有程序要停我），退出。'); clean(); process.exit(0); });

/* ---------------- 退出原因留痕 ----------------
   为什么加这些：实测（2026/9/26 15:57:30）视频刚播完那一刻，驱动器**无声消失** ——
   日志里既没有正常的「驱动器结束。」（说明没走正常收尾），
   也没有异常路径的「失败:」（说明不是被最外层 catch 抓住的）。
   进程没了、日志一个字节不写，事后完全查不出死因，这才是最难受的。
   下面三处把"非正常退出"都变成日志里能看见的一行：
     * uncaughtException       —— 同步抛出的漏网异常（含子回调里抛的）
     * unhandledRejection      —— 没有被 catch 的 Promise（最常见的无声死法）
     * process.on('exit')      —— 任何退出都会走这里，带上退出码；
                                  同时装一个"正常收尾"标记，用来区分"正常结束"和"半路没了"
   注意：这些只**记录**，不改变原来的行为 —— 不吞异常、不阻止退出。 */
let normalFinish = false;          /* 正常收尾时置 true */
let caughtExit = false;            /* 被最外层 catch 抓住、正在报错退出时置 true */
process.on('uncaughtException', (e) => {
  try { log('✗ 未捕获异常，要退出了：' + ((e && e.stack) || e)); } catch (x) {}
  caughtExit = true;
  try { clean(); } catch (x) {}
  process.exit(1);
});
process.on('unhandledRejection', (r) => {
  try { log('✗ 未处理的 Promise 拒绝，要退出了：' + ((r && r.stack) || r)); } catch (x) {}
  caughtExit = true;
  try { clean(); } catch (x) {}
  process.exit(1);
});
process.on('exit', (code) => {
  /* 正常收尾、或者已经报过错了，就别再补一句 —— 否则会把"连不上端口"这种
     有明确原因的退出，误报成"被外部强杀"（实测踩过：自己跑一次诊断就写了一句假结论）。 */
  if (normalFinish || caughtExit) return;
  try {
    log('✗ 驱动器半路退出（退出码 ' + code + '）—— 上面没有「驱动器结束。」就是非正常退出；' +
        '若也没看到异常行，说明是被外部强杀的（任务管理器 / 停止脚本 / 系统）。');
  } catch (x) {}
});

/* ---------------- 待办记录 ---------------- */
/* 启动时先把已经记过的章节读出来，避免重启后重复追加 */
function loadTodoChapters() {
  const set = new Set();
  try {
    if (!fs.existsSync(TODO_FILE)) return set;
    for (const line of fs.readFileSync(TODO_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/跳过：(.*?)\s{2,}原因：/);
      if (m) set.add(m[1].trim());
    }
  } catch (e) { /* 读不到就当空的，不影响运行 */ }
  return set;
}
const todoChapters = loadTodoChapters();

function recordTodo(chapter, how) {
  try {
    if (!fs.existsSync(TODO_FILE)) {
      fs.writeFileSync(TODO_FILE,
        '\uFEFF未完成的章节记录\n' +
        '驱动器跳过一章时自动追加一行。跳过只是导航离开，没有替你提交或伪造任何东西，\n' +
        '这些章节的任务点（视频 / 测验 / 文档）照样欠着，平台也照样记着。\n' + '='.repeat(64) + '\r\n', 'utf8');
    }
    fs.appendFileSync(TODO_FILE,
      '[' + new Date().toLocaleString('zh-CN') + ']  跳过：' + (chapter || '(章节名读不到)') +
      '   原因：这一章还有任务点没做，按 --force 点了「' + how + '」\r\n', 'utf8');
  } catch (e) { log('（待办记录写入失败：' + e.message + '）'); }
}

/* ---------------- CDP ---------------- */
/* 每个请求的超时。为什么要它（实测踩过两次）：
 *   页面在驱动器脚下被整个换掉（切课、点回目录页）时，CDP 连接**不会报错**，
 *   它只是**永远不回包**。以前 send() 是 new Promise((res) => ...)：没有 reject、没有时限，
 *   于是 await 就悬在那里，日志一个字节都不再写 —— 表现就是"驱动器不动了"，
 *   而且进程还活着、PID 还在，看起来像卡死（2026/9/26 15:24 那次卡了 4 分钟以上就是这个）。
 *   同类病之前修过一次：答题助手的 fetch 没有超时，卡了 6 分钟。教训一样 —— 凡是"等外面"的调用都要有时限。 */
const CDP_TIMEOUT_MS = 20000;
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  let closed = false;
  let closedWhy = '';
  const pending = new Map();
  let opening = true;
  let resolveOpen, rejectOpen, openTimer;
  const ready = new Promise((res, rej) => {
    resolveOpen = res;
    rejectOpen = rej;
  });
  const finishOpen = (error) => {
    if (!opening) return;
    opening = false;
    clearTimeout(openTimer);
    ws.removeEventListener('open', onOpen);
    if (error) rejectOpen(error); else resolveOpen();
  };
  const onOpen = () => finishOpen();
  // 先记录原因、放掉所有等待，再关闭 socket，避免 close 事件覆盖真实错误。
  const markClosed = (why) => {
    if (closed) return;
    closed = true; closedWhy = why || '连接已关闭';
    finishOpen(new Error(closedWhy));
    for (const fn of pending.values()) fn({ error: { message: closedWhy } });
    pending.clear();
  };
  const fail = (why) => {
    markClosed(why);
    try { ws.close(); } catch (e) {}
  };
  ws.addEventListener('open', onOpen);
  ws.addEventListener('error', () => fail('WebSocket 连接出错（请检查 Edge 调试端口）'));
  ws.addEventListener('close', () => markClosed('WebSocket 被关闭（页面换掉 / 浏览器关了标签 / 端口掉了）'));
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (!m || typeof m !== 'object' || !pending.has(m.id)) return;
    const complete = pending.get(m.id);
    pending.delete(m.id);
    complete(m);
  });
  // 建连本身也可能没有任何事件，不能只给建连后的 send() 设置超时。
  openTimer = setTimeout(() => fail('WebSocket 建立连接超时 ' + Math.round(CDP_TIMEOUT_MS / 1000) + ' 秒'), CDP_TIMEOUT_MS);
  await ready;
  if (closed) throw new Error(closedWhy);

  const send = (method, params) => new Promise((res) => {
    if (!closed && ws.readyState !== 1) fail('WebSocket 已不在可发送状态');
    if (closed) { res({ error: { message: closedWhy } }); return; }
    const id = ++seq;
    const ms = (method === 'Page.captureScreenshot') ? 60000 : CDP_TIMEOUT_MS;
    const timer = setTimeout(() => {
      fail('CDP ' + method + ' 超时 ' + Math.round(ms / 1000) + ' 秒没回包（标签页可能被关掉或换页了）');
    }, ms);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    try { ws.send(JSON.stringify({ id, method, params: params || {} })); }
    catch (e) { fail('发送失败：' + e.message); }
  });
  return { ws, send, isClosed: () => closed, closedWhy: () => closedWhy };
}

async function pickCoursePage() {
  let list;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDP_TIMEOUT_MS);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: controller.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    list = await r.json();
    if (!Array.isArray(list)) throw new Error('页面列表格式错误：预期为数组');
  } catch (e) {
    const reason = controller.signal.aborted
      ? '读取页面列表超时 ' + Math.round(CDP_TIMEOUT_MS / 1000) + ' 秒'
      : (e && e.message ? e.message : String(e));
    throw new Error(
      '无法读取 Edge 调试端口 ' + PORT + ' 的页面列表：' + reason + '。\n' +
      '  请打开 控制台.cmd，按 6 检查环境，再按 1 开始 / 继续。\n' +
      '  普通方式打开或重启的 Edge 可能没有调试端口。'
    );
  } finally {
    clearTimeout(timer);
  }
  const pages = list.filter((t) => t && t.type === 'page' && typeof t.url === 'string' && !t.url.startsWith('devtools://') && t.url !== 'http://data/');
  /* 【挑标签页：宁可自己新建一个学习页，也别去读一个"不是学习页"的标签】
     实测（2026/9/26 16:51）：平台自己会开一个检测页 detect.chaoxing.com/api/monitor_temp，
     它的 URL 里也有 "chaoxing" —— 老写法 `|| pages.find(x => x.url.includes('chaoxing'))`
     正好挑中它，驱动器于是对着一个没有 #iframe 的页面读到超时，
     连试 3 次后放弃退出（日志："连着 3 次读不到页面：调试端口断了"，并报"驱动器结束"）。
     结果看起来像"驱动器又断了"，其实只是选错了标签。
     所以：只认 studentstudy；没有就自己开一个（页面里的章节链接能带出正确 URL）。 */
  /* 【同时开着两门课的学习页时，必须认得"我刚才在跑哪一门"】
     实测（2026/9/27 00:10 换课）：用户从军事理论切到"安全教育"，
     浏览器里同时留着旧的军事理论学习页标签。原来这里是
         pages.find(x => x.url.includes('studentstudy'))
     —— 拿到的是**列表里第一个**，于是挑回了旧课，换课等于没换。
     现在：优先挑"和上次跑过的 courseId 相同"的那个；挑不到再按老规则。
     另外把候选列出来写进日志 —— 挑错标签是最难查的一类问题，先把证据留下。 */
  const allStudy = pages.filter((x) => x.url.includes('studentstudy'));
  let p = null;
  if (lastCourseId) {
    try {
      p = allStudy.find((x) => new RegExp('(courseId|courseid)=' + lastCourseId + '(?![0-9])').test(x.url)) || null;
    } catch (e) { p = null; }
    if (p) {
      log('（有 ' + allStudy.length + ' 个学习页标签，按"上次跑的课程 ' + lastCourseId + '"挑中了它）');
    } else if (allStudy.length > 1) {
      log('⚠ 有 ' + allStudy.length + ' 个「学生学习页面」标签，但都不是上次那门课（' + lastCourseId + '）：');
      allStudy.forEach((x) => log('    ' + String(x.url).slice(0, 96)));
      log('  按第一个来。想换课：先把旧课那个标签关掉，再回控制台点 1。');
    }
  }
  if (!p) p = allStudy[0] || null;
  if (!p) {
    const firstCourse = pages.find((x) => x.url.includes('courseid=') || x.url.includes('mycourse'));
    if (firstCourse) {
      log('⚠ 没找到「学生学习页面」标签（现有：' + pages.map((x) => String(x.url).slice(0, 46)).join(' | ') + '）');
      log('  不拿别的 chaoxing 标签凑数（平台自己的检测页也叫 chaoxing，读它只会白等）。改用课程页自己开一个。');
    }
  }
  /* 仍旧完全没有可用页面时，退回"任一 chaoxing 页"——但明确说明这是退路 */
  if (!p) {
    p = pages.find((x) => /mooc\d?-ans\.chaoxing\.com\/mooc2?-ans\/mycourse/.test(x.url))
     || pages.find((x) => x.url.includes('chaoxing') && !/detect\.chaoxing\.com/.test(x.url));
  }
  if (!p) throw new Error('端口是通的，但没找到学习通课程页标签。请先在助手打开的 Edge 中登录并打开课程页，再回控制台按 1。');
  return { page: p, pages };
}

/* ---------------- 页面内探针 ---------------- */

/* 穿透链：从顶层一层层往下找 video / audio（全部同源）。
 *
 * 为什么不写死层数 —— 这是踩过的坑：
 *   军事理论：顶层 -> #iframe -> iframe.ans-attach-online -> video   （三层）
 *   高等数学：顶层 -> #iframe 里直接就是 video                        （两层）
 * 老版本写死了"视频一定在第二层 iframe 里"，于是高数的每一章
 *   都被判成「本节没有可播的内容」，一路空转跳过 —— 74 秒穿掉 28 章、
 *   一个视频都没播，日志里全是"没有可播的内容"。
 *
 * 【这一版的第二个坑：岔路要走对】
 *   frame 树实测（chapterId=1227808599，函数微分的定义及几何意义）：
 *     顶层 studentstudy
 *       └─ iframe#iframe              → knowledge/cards        ← 卡片页，这一层躺着 2 个卡片
 *            ├─ iframe.ans-attach-online.insertdoc-online-pdf   → ananas/modules/pdf    （不是播放器）
 *            └─ iframe.ans-attach-online.ans-insertvideo-online → ananas/modules/video  （★ 播放器在这）
 *                 └─ div.video-js > video.vjs-tech   ← 真正的 <video>
 *   老写法按 doc.querySelector('iframe.ans-attach-online') 取**第一个**匹配的 iframe。
 *   可这两个卡片是**兄弟**，class 前缀一模一样，PDF 卡片在 DOM 里排在前面，
 *   于是链子一头扎进 PDF 那一支，再往下只剩 panView（跨域空文档），
 *   遍历收工、手里没有视频 —— 日志就刷成「本节没有可播的内容」，然后一直翻页。
 *   （pdf 那一支里连 .vjs-big-play-button 都没有，点了也没用。）
 *   所以下降顺序必须**按"哪一支可能是播放器"排**：视频卡 > 音频卡 > 文档卡 > 随便一个。
 *
 * 返回的 ox/oy 是"视频所在文档"相对顶层视口的累计偏移，用来算点击坐标；
 * 而 d2 就是那个文档 —— 点播放键、量视频画面都在它里面，这几个必须指向同一个文档。
 * 这一点很要紧：视频卡在 cards 里位于 y=969，若 d2 记成 cards、ox/oy 只累到 cards 那一层，
 * 算出来的点击坐标会整整差一个视频卡的高度，点到页面外面去。 */
const CHAIN = `
  /* 页面里常躺着没用的 <audio> 残渣（UEditor 编辑器留下的，0x0、没有 src、
     duration 是 NaN）。不筛掉的话驱动器会盯着它死磕。
     但也不能筛太狠 —— 真播放器的 <video> 在视频还没加载时同样是 0x0、没有 src。
     区别在哪：真播放器外面套着播放器容器（video-js / vjs* / player*）。
     所以判据是：**在播放器容器里的，一律认**；散落在别处的，要有尺寸或有源才算。 */
  function isRealMedia(el){
    if (!el) return false;
    try {
      /* 【video.js 的标准 id（2026-10-08 对照改进）】
         video.js 建出来的 <video>，id 就是 video_html5_api —— 直接认这个
         比 [class*=player] 那种宽匹配精确得多（宽匹配会把 UEditor 之类
         的容器也算进来）。对照脚本正是用它定位播放器的。 */
      if (el.id && String(el.id).indexOf('video_html5') >= 0) return true;
      if (el.closest && el.closest('.video-js, [class*=vjs], [class*=player], [class*=Player]')) return true;
      if (el.currentSrc) return true;
      if (el.getAttribute('src')) return true;
      if (el.querySelector && el.querySelector('source[src]')) return true;
      var r = el.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) return true;
      if (el.readyState > 0) return true;
    } catch (e) {}
    return false;
  }
  /* 往下一层该怎么走：按"哪一支可能是播放器"的优先级挑 iframe。
   * 顺序错了就会扎进 PDF 卡片那一支（见上面那段注释）。 */
  var DESCEND_ORDER = [
    'iframe.ans-insertvideo-online',   /* ★ 视频卡：播放器就在这一支下面 */
    'iframe[id*=video]',
    'iframe[src*=modules/video]',
    'iframe[src*=insertvideo]',
    'iframe.ans-insertaudio-online',   /* 音频卡 */
    'iframe[src*=modules/audio]',
    'iframe.ans-insertdoc-online',     /* 文档/PDF 卡：没有播放器，但比乱抓一个强 */
    'iframe.ans-attach-online',
    'iframe[id=iframe]'                /* 顶层那一个 */
  ];
  /* 【同一优先级可能有多个 iframe（2026-10-08 多视频）】
     一页挂**两个视频卡**的时候，它们的 class 一模一样、都是
     iframe.ans-insertvideo-online。以前这里用 querySelector 只取第一个，
     于是第二个视频卡永远进不去 —— 它的 <video> 连 DOM 都没进过，
     日志上只看得到"这一章还有任务点没做完"，查不出是谁没做。
     现在：先在同优先级的候选里挑"内容里还有没播完的视频"的那一个，
     挑不到才退回第一个（原行为，免得老课程受影响）。 */
  /* 【同一个优先级里挑哪个 iframe（2026-10-08 对照改进）】
     以前是"里面只要有一个没播完的就要它"。可一页两个视频卡时，
     第一个卡里的播放器往往还没加载元数据（preload=none + readyState=0），
     而真正在用的，是另一个卡里已经加载好的那个。
     所以分两轮挑，打分而不是"有就要"：
       2 = 有未播完、且已加载元数据的   ← 当前在用的那个，最优先
       1 = 有未播完、但还没加载元数据的 ← 得靠 TRY_PLAY 里的 load() 拉起来
       0 = 没有真媒体 / 全都播完了
     没有 2 才退 1，都没有才退回第一个（原行为）。 */
  function mediaScore(f){
    var best = 0;
    try {
      var cd = f.contentDocument || (f.contentWindow && f.contentWindow.document);
      if (!cd) return 0;
      var vv = cd.querySelectorAll('video, audio');
      for (var k = 0; k < vv.length; k++){
        var el = vv[k];
        if (!isRealMedia(el)) continue;
        var fin = false;
        try { fin = el.ended || (el.duration > 0 && el.currentTime >= el.duration - 1.5); } catch (e2) {}
        if (fin) continue;
        if (el.readyState > 0 || el.duration > 0) return 2;
        if (best < 1) best = 1;
      }
    } catch (e) {}
    return best;
  }
  function findNextFrame(doc){
    for (var i = 0; i < DESCEND_ORDER.length; i++) {
      var list = null;
      try { list = doc.querySelectorAll(DESCEND_ORDER[i]); } catch (e) { list = null; }
      if (!list || !list.length) continue;
      var lazyHit = null;
      for (var m = 0; m < list.length; m++){
        var sc = mediaScore(list[m]);
        if (sc === 2) return { f: list[m], sel: DESCEND_ORDER[i] + '(未播完·已加载)' };
        if (sc === 1 && !lazyHit) lazyHit = list[m];
      }
      if (lazyHit) return { f: lazyHit, sel: DESCEND_ORDER[i] + '(未播完·待加载)' };
      return { f: list[0], sel: DESCEND_ORDER[i] };
    }
    /* 都没命中就退而求其次：随便挑一个能读到文档的 iframe
       （有些课把播放器塞在没命名、没 class 的 iframe 里） */
    var all = doc.querySelectorAll('iframe, frame');
    for (var j = 0; j < all.length; j++) {
      var g = null; try { g = all[j].contentDocument; } catch (e) { g = null; }
      if (g) return { f: all[j], sel: 'iframe(兜底)' };
    }
    return null;
  }
  function chain(){
    var ox = 0, oy = 0;
    /* 【记下"见过的第一个真媒体"，用来兜底（2026-10-08 多视频）】
       走到最后如果一个"未播完的"都没找到，就把它还回去 ——
       这样 done = v.ended 依然成立，该翻页时照翻，不会因为
       "全都播完了所以 v=null" 而被误判成"这一章没有视频"。 */
    var firstAny = null, firstAnyDoc = null, firstAnyOx = 0, firstAnyOy = 0;
    var firstAnyChain = null;   /* 连路径一起记：兜底时 frameChain 也得跟着退 */
    /* 【未播完、但还没加载元数据的那个（2026-10-08 对照改进）】
       页面会为每个任务点预先建好 <video>，只有当前那个加载了元数据。
       这种"lazy"的也要连坐标和路径一起记 —— 全树找不到"已加载的"时要用它。 */
    var lazyUnfinished = null, lazyDoc = null, lazyOx = 0, lazyOy = 0, lazyChain = null;
    /* d1 = 卡片页(知识卡片那一层)，d2 = 视频真正所在的那个文档。
       没有视频时 d2 停在最里面那一层。f2 = 进到 d2 的那个 iframe。 */
    var doc = document, f1 = null, d1 = null, f2 = null, f2sel = '', d2 = null, v = null;
    var frameChain = [];   /* 从顶层往下每一跳的 iframe，topRect 靠它现算偏移 */
    var lastDoc = document;
    for (var depth = 0; depth < 6; depth++) {
      if (!doc) break;
      if (depth === 1) d1 = doc;
      /* 【每进一层先看这一层有没有真播放器（2026-10-08 多视频改）】
         原来这里是"找到就停止下钻"；现在多一条：**没播完的才停**。
         一层里的视频全播完了，就继续往下一层找 —— 一页挂两个视频卡时，
         第二个卡的播放器在下一条同级分支里，旧的写法永远够不着。 */
      var cands = doc.querySelectorAll('video, audio');
      for (var k = 0; k < cands.length; k++) {
        var el0 = cands[k];
        if (!isRealMedia(el0)) continue;
        if (!firstAny) {
          firstAny = el0; firstAnyDoc = doc; firstAnyOx = ox; firstAnyOy = oy;
          firstAnyChain = frameChain.slice();
        }
        var fin0 = false;
        try { fin0 = el0.ended || (el0.duration > 0 && el0.currentTime >= el0.duration - 1.5); } catch (e2) {}
        if (fin0) continue;
        /* 【未播完的里面，优先挑"已经加载了元数据"的（2026-10-08 对照改进）】
           对照脚本那句注释点破了实情：页面会为**每个**任务点预先建好 <video>，
           但只有当前那个真正加载了元数据，其余是 preload=none + readyState=0。
           所以"文档序第一个未播完的"未必是正在用的那个 —— 先认已加载的；
           本层都没加载才退回第一个（那种得靠 TRY_PLAY 里的 load() 拉起来）。 */
        if (el0.readyState > 0 || el0.duration > 0) { v = el0; d2 = doc; break; }
        if (!lazyUnfinished) {
          lazyUnfinished = el0; lazyDoc = doc;
          lazyOx = ox; lazyOy = oy; lazyChain = frameChain.slice();
        }
      }
      /* 【lazy 那个不能就地定下来（2026-10-08 实测踩到）】
         一页两个视频卡 = 两个**不同的 iframe**。第一个卡里那个还没加载元数据时
         如果就地定下它，就再也不会去第二个卡里找"已经加载好的"那个了 ——
         而那恰恰是要修的场景（测试就是这么挂的）。
         所以 lazy 只记着，继续往下钻；全树扫完仍没有"已加载的"，
         才回过头用它（见函数末尾兜底一）。 */
      if (v) break;
      lastDoc = doc;
      var nx = findNextFrame(doc);
      if (!nx) break;
      var f = nx.f;
      if (depth === 0) f1 = f;
      var rr = f.getBoundingClientRect();
      var cd = null;
      try { cd = f.contentDocument; } catch (e) { cd = null; }
      if (!cd) {
        /* 这一支读不进去（跨域空文档），换别的支路再试一次再放弃 */
        var alt = doc.querySelectorAll('iframe, frame');
        for (var m = 0; m < alt.length; m++) {
          if (alt[m] === f) continue;
          var cd2 = null; try { cd2 = alt[m].contentDocument; } catch (e) { cd2 = null; }
          if (!cd2) continue;
          var rr2 = alt[m].getBoundingClientRect();
          f = alt[m]; cd = cd2; rr = rr2; nx.sel = 'iframe(改道)';
          break;
        }
      }
      if (!cd) { doc = null; break; }
      ox += rr.left; oy += rr.top;
      frameChain.push(f);                       /* 记下这条路的每一跳，量坐标时重算偏移 */
      f2 = f; f2sel = nx.sel; doc = cd;
    }
    /* 【兜底一：未播完、只是还没拉数据的（2026-10-08 对照改进）】
       全树都没找到"已加载且未播完"的，但有"未播完、还没加载元数据"的 ——
       用它，让 TRY_PLAY 里的 load() 把它拉起来。
       它排在 firstAny 前面：firstAny 可能是个已经播完的。 */
    if (!v && lazyUnfinished) {
      v = lazyUnfinished; d2 = lazyDoc; ox = lazyOx; oy = lazyOy;
      if (lazyChain) frameChain = lazyChain;
    }
    /* 【兜底二（2026-10-08 多视频）】一树的视频都播完了 —— 把见过的第一个还回去。
       坐标必须跟着退回它所在的那一层，否则点击会打偏。 */
    if (!v && firstAny) {
      v = firstAny; d2 = firstAnyDoc; ox = firstAnyOx; oy = firstAnyOy;
      /* 【frameChain 必须一起退回来（2026-10-08 复查发现）】
         它是"从顶层到 d2 的每一跳"，topRect() 靠它现算偏移 ——
         只退 ox/oy 不退它，两边就对不上，量出来的坐标会落在错的层上。 */
      if (firstAnyChain) frameChain = firstAnyChain;
    }
    /* d2 就是"视频所在文档"；没找到视频时让它指向能钻到的最深一层，
       好让上层的报错信息说得出话。ox/oy 与它严格对应。 */
    if (!d2) d2 = doc || lastDoc;
    return { f1:f1, d1:d1, f2:f2, f2sel:f2sel, d2:d2, v:v, ox:ox, oy:oy,
             depthReached:depth, frameChain:frameChain };
  }
  function topRect(el, R){
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return { x:null, y:null, w:Math.round(r.width), h:Math.round(r.height) };
    /* 【坐标一定要现算，不能用 chain() 里缓存的那份】
     * R.ox/R.oy 是"往下钻的那一刻"量的 iframe 位置。可我们量坐标之前会先把播放器
     * scrollIntoView —— 父层一滚，卡片的 rect 就变了，那份缓存立刻过期（实测：滚动前
     * 缓存 oy=152+969，滚动后卡片实际只剩 152，于是把播放键算到 y=1184，掉到视口外）。
     * 所以这里按 frame 链**重新累加一次**：卡片滚到哪，就算到哪。 */
    var ox = 0, oy = 0, fc = R.frameChain || [];
    for (var i = 0; i < fc.length; i++) {
      var q = fc[i].getBoundingClientRect();
      ox += q.left; oy += q.top;
    }
    return { x: Math.round(ox + r.left + r.width/2),
             y: Math.round(oy + r.top  + r.height/2),
             w: Math.round(r.width), h: Math.round(r.height) };
  }
  /* 元素在**顶层真视口**里的坐标与露出比例。
   * 必须换算到顶层，不能只看元素自己那一层窗口：
   *   卡片页(cards)自己高 1756，而真视口只有 959 高。播放器在 cards 里 y=1068 时，
   *   拿 cards 的 innerHeight 去判，它"完全可见"；可放到屏幕上早就掉到视口下面 225px 了。
   *   （实测就是这么骗过我的：visRatio 报 1，转换到顶层却是 1184。）
   * 做法：顶层坐标 = 元素 rect + 沿途每个 iframe 的 rect（都换成顶层坐标再相加）。 */
  function topXY(el){
    var x = 0, y = 0, cur = el, guard = 0;
    while (cur && cur.getBoundingClientRect && guard++ < 12) {
      var r = cur.getBoundingClientRect();
      x += r.left; y += r.top;
      var p = null;
      try { p = cur.ownerDocument.defaultView.frameElement; } catch (e) { p = null; }
      cur = p;
    }
    return { x: x, y: y, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
  }
  function winOf(el){
    var d = (el && el.ownerDocument) || document;
    try { return d.defaultView || window; } catch (e) { return window; }
  }
  function visRatio(el){
    if (!el) return 0;
    var r0 = el.getBoundingClientRect();
    var t = topXY(el);
    var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    var ix = Math.max(0, Math.min(t.x + r0.width, vw) - Math.max(t.x, 0));
    var iy = Math.max(0, Math.min(t.y + r0.height, vh) - Math.max(t.y, 0));
    var a = r0.width * r0.height;
    return a > 0 ? (ix * iy) / a : 0;
  }
  function framesOf(el){
    var out = [], cur = el, guard = 0;
    while (cur && cur.ownerDocument && guard++ < 12) {
      var w = winOf(cur);
      if (out.indexOf(w) < 0) out.push(w);
      var p = null;
      try { p = cur.ownerDocument.defaultView.frameElement; } catch (e) { p = null; }
      cur = p;
    }
    return out;
  }
  /* 把播放器滚进视口 —— 这一步是必需的，不是保险。
   * 视频卡片在 cards 文档里位于 y=969，而视口只有 959 高：
   * 直接拿算出来的顶层坐标去 Input.dispatchMouseEvent，点的是屏幕外面，
   * 等于什么都没点，日志就刷「找不到可点的播放键」。
   * 翻节那条路一直有 scrollIntoView，播放这条路以前漏了，现在补上。
   * 返回播放键在视口里露出的比例，低于 need 就别点。 */
  function scrollIntoViewDeep(el, need){
    if (!el) return 0;
    /* 1) 每一层各自 scrollIntoView（浏览器会连父层一起滚） */
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    /* 2) 兜底：从里往外，按 iframe 在父层里的位置补滚动量 */
    var wins = framesOf(el);
    for (var i = 0; i < wins.length - 1; i++) {
      try {
        var f = wins[i].frameElement, r = f ? f.getBoundingClientRect() : null;
        if (!r) continue;
        var vh = wins[i + 1].innerHeight || 0, dy = 0;
        if (r.bottom > vh - 20) dy = r.bottom - vh + 20;
        else if (r.top < 20) dy = r.top - 20;
        if (dy) wins[i + 1].scrollBy(0, dy);
      } catch (e) {}
    }
    var best = visRatio(el), tries = 0;
    while (best < need && tries++ < 8) {
      for (var j = 0; j < wins.length; j++) {
        try {
          var d = wins[j].document;
          var de = d ? (d.documentElement || d.body) : null;
          if (de && de.scrollHeight > (wins[j].innerHeight || 0) + 10) {
            wins[j].scrollBy(0, 0.45 * (wins[j].innerHeight || 400));
          }
        } catch (e) {}
      }
      var nr = visRatio(el);
      if (nr <= best + 0.01) break;
      best = nr;
    }
    return best;
  }
`;

const PROBE = `(function(){
  /* chain() 是从**顶层 document** 出发往下钻的，算出来的 ox/oy 是"相对顶层视口"的坐标。
     要是这段被塞进某个内层 iframe 里执行，它会把那一层的坐标当成顶层坐标报回来 ——
     数字看着挺正常，其实是错的（实测：在视频卡那一层跑，播放键会报成 422,237）。
     所以先声明清楚：不是顶层就别返回假数据。 */
  if (window.top !== window) {
    return { notTop: true, url: location.href, ready: document.readyState,
             why: 'PROBE 只对顶层文档有意义（chain 的坐标以顶层视口为准）' };
  }
  ${CHAIN}
  var o = { url: location.href.slice(0, 90), viewport: [window.innerWidth, window.innerHeight] };
  var R = chain();
  o.ready = document.readyState;
  o.hasFrame = !!document.getElementById('iframe');
  o.d1Tasks = R.d1 ? R.d1.querySelectorAll('.ans-attach-ct').length : -1;

  /* 【学习步骤标签 —— 只读探测（2026-10-09，从对照脚本学来的）】
     学习通在课件区顶上有一排「学习步骤」页签，当前那一步的标题挂在 .prev_title：
     文字就是「视频」「2视频」「章节测验」「章节检测」「文档」这类。
     其中 "2视频" 是**平台自己标出的多视频**——比我们数 iframe 更直接，
     正好给刚修的那条多视频逻辑做交叉印证。
     对照脚本用它判断"当前停在测验步"（/测验|检测|测试|考试/），
     还靠 .prev_white 找回"视频"页签。
     这里**只读不点**：切步/翻页仍旧走坐标点击 + 门禁那一套，不改原有行为。 */
  o.step = (function(){
    var out = { title: '', tabs: [], videoCount: 0, isQuiz: false };
    try {
      var pt = document.getElementsByClassName('prev_title')[0];
      out.title = pt ? String(pt.title || pt.textContent || '').replace(/\\s+/g, '').trim() : '';
    } catch (e) {}
    try {
      var tabs = document.querySelectorAll('.prev_white, .prev_ul > li, #prev_tab li');
      for (var i = 0; i < tabs.length; i++){
        var t = String(tabs[i].textContent || '').replace(/\\s+/g, '').trim();
        if (t && out.tabs.indexOf(t) < 0) out.tabs.push(t);
      }
    } catch (e) {}
    /* "2视频" 抓数字，"视频" 当 1；其余页签（文档/测验）不计 */
    for (var j = 0; j < out.tabs.length; j++){
      var m = /(\\d+)\\s*视频/.exec(out.tabs[j]);
      if (m) out.videoCount += Number(m[1]) || 1;
      else if (out.tabs[j] === '视频') out.videoCount += 1;
    }
    out.isQuiz = /测验|检测|测试|考试/.test(out.title);
    return out;
  })();

  /* 走的是哪条分支 —— 上次"一头扎进 PDF 卡片"就是这里看不出来，只能猜。
     现在直接把选中的 iframe 选择器、下钻层数、以及各路 iframe 的身份证带回去。 */
  o.branch = { sel: R.f2sel || '', depth: R.depthReached, url: R.d2 && R.d2.location ? String(R.d2.location.href).slice(0, 70) : '' };
  /* 真正在显示哪一章、卡片页是哪一栏 —— 顶层那个章节名会"提前"变，
     拿它判断"翻页成没成"会被骗（实测：名字变了、URL 和 cards 都还是老章节，
     于是驱动器以为翻过去了，弹窗又冒出来，来回空转）。所以把 cards 的真实身份也报回来。 */
  o.cardsKid = '';
  o.cardsNum = '';
  o.topKid = (function () {
    var m = String(location.href).match(/[?&]chapterId=([^&]+)/);
    return m ? m[1] : '';
  })();
  try {
    var _f = document.getElementById('iframe');
    var _src = String((_f && _f.getAttribute('src')) || '');
    var _m1 = _src.match(/[?&]knowledgeid=([^&]+)/);
    var _m2 = _src.match(/[?&]num=(\d+)/);
    o.cardsKid = _m1 ? _m1[1] : '';
    o.cardsNum = _m2 ? _m2[1] : '';
  } catch (e) {}
  o.frames = [];
  if (R.d1) {
    var _fs = R.d1.querySelectorAll('iframe');
    for (var _i = 0; _i < _fs.length && _i < 8; _i++) {
      var _f = _fs[_i], _r = _f.getBoundingClientRect(), _cd = null;
      try { _cd = _f.contentDocument; } catch (e) {}
      o.frames.push(String(_f.className || _f.id || '(无名)').slice(0, 34) + ' ' +
        Math.round(_r.width) + 'x' + Math.round(_r.height) +
        (_cd ? (' 视频' + _cd.querySelectorAll('video').length + '/播放器键' + _cd.querySelectorAll('.vjs-big-play-button').length) : ' 读不到'));
    }
  }

  var act = document.querySelector('.posCatalog_active .posCatalog_name') || document.querySelector('li.currents .posCatalog_name');
  o.chapter = act ? (act.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : '';

  /* 【这一章还欠几个任务点 —— 从章节列表读】
     为什么非要它：卡片页里的 .ans-attach-ct 是**异步加载**的，问它可能读到 0；
     而章节列表里每个节点旁边都挂着一个隐藏的 jobUnfinishCount，页面一渲染就有，什么时候都读得到。
     这是"这一章还有没有活没干"最可靠的一个信号，给主循环当兜底判据用。 */
  o.catalogUnfinish = null;
  try {
    /* 【先认平台自己的完成标记，再谈未完成数（2026-10-07 实测）】
       jobUnfinishCount 藏在目录节点的某一层，这里往上爬最多 4 层去找。
       实测常常爬到**父章节**头上：当前章 1.1.1 明明标着"已完成"，爬上去读到的
       却是父章 1.1（映射）那个"1" —— 映射底下还有没提交的测验，于是 catalogUnfinish
       恒 > 0，主循环那道闸门每次都判"还有活没干"，白等 30 秒。"翻页要好久"有一半来自这里。
       平台既然在当前节点写了 .icon_Completed，这一章的未完成数就是 0，不用再往上爬。 */
    var actNode = document.querySelector('.posCatalog_active');
    if (actNode && actNode.querySelector('.icon_Completed')) {
      o.catalogUnfinish = 0;
    } else {
      var node = act;
      for (var hop = 0; hop < 4 && node && o.catalogUnfinish === null; hop++) {
        var cnt = node.querySelector ? node.querySelector('input.jobUnfinishCount') : null;
        if (cnt) o.catalogUnfinish = Number(String(cnt.value || '0').trim()) || 0;
        node = node.parentElement;
      }
    }
  } catch (e) { o.catalogUnfinish = null; }

  /* 这一章的测验/作业是不是已经做过了？
   * 照原始脚本 isQuizDone() 的三重判定来（题目页"是否已完成"）：
   *   1) 正文里出现"得分/成绩/已提交/我的答案/正确答案/已批阅"这类痕迹
   *   2) 所有作答控件都 disabled（提交后就是锁死的）
   *   3) 出现 .answer-right / .score / .dui / .cuo 这类判分标记
   * 为什么非要它：视频已完成、题目没做的章节，驱动器现在会主动去把测验打开；
   * 但要是不先问一句"这题做过没"，就会把**已经填过/已保存**的测验反复重填。 */
  o.quizDone = false;
  if (R.d1) {
    try {
      var qtxt = String(R.d1.body ? R.d1.body.innerText : '');
      var byText = /得分：|成绩：|已提交|已完成|我的答案|正确答案|查看作答|已批阅|本题得\\s*\\d+\\//.test(qtxt);
      var ins = R.d1.querySelectorAll("input[type='radio'], input[type='checkbox'], textarea");
      var allDis = ins.length > 0;
      for (var qi = 0; qi < ins.length && allDis; qi++) if (!ins[qi].disabled) allDis = false;
      var marks = R.d1.querySelectorAll(".answer-right, .score, .scoreNum, .dui, .cuo, [class*='score']").length > 0;
      o.quizDone = byText || allDis || marks;
      o.quizDoneBy = byText ? '正文有已答痕迹' : allDis ? '作答控件全部 disabled' : marks ? '有判分标记' : '';
    } catch (e) {}
  }

  /* 平台是否已把这一章的任务点标记完成（下面按任务点逐个算）
   * 【任务点完成度：必须逐个判，不能一句"页面上有完成类名"就下结论】
   * 学习通一章可以有多个任务点（视频 / 文档 / 测验 / 作业），每个各自带完成标记。
   * 老写法是 querySelectorAll('.ans-job-finished').length > 0 —— 意思是
   * "这一章**任意一个**任务点完成了就算整章完成"，于是"视频做完了、题目没做"的章节
   * 会被整章判成已完成直接翻页，题目那个任务点连碰都没碰。
   * 原始脚本（nuaa 那套）的做法是：任务点列表里**逐个**看，只有全部带完成类名
   * 才算全绿，而且明确写了"一个任务容器都没找到 ≠ 任务点全做完"。
   * 这里照那个做法来：数出未完成的、并单独回答"装着视频/文档的那个任务点完成了没"。 */
  o.taskStats = { total: 0, pending: 0, done: 0, videoCardDone: null, pendingNames: [] };
  o.platformDone = false;
  /* 【任务点要跨层找 —— 照旧版油猴脚本的 $$ / allDocs 做法】
     学习通把任务点容器 .ans-attach-ct 放在工作区那层 iframe 里，顶层 document 数出来是 0
     （实测：顶层 0 个、iframe 里 2 个）。原来这里只查 R.d1 单层，于是 taskStats.total=0，
     整章被当成"没有任务点"，已完成章节还照播不误。
     旧版能跑，就是因为它的查询是**跨同源 iframe 递归**的，而且还带一步"去重到最外层"
     （v2.6.2 的修法：div[class*='attach'] 跟裸 iframe 会让同一个任务点命中好几层，
     虚报成 8 个实际只有 3 个）。这里照抄那套：先跨层收，再去重到最外层。 */
  var pts = [];
  (function () {
    function allDocsOf(root, depth) {
      var out = [root];
      if (!depth) return out;
      var frames;
      try { frames = root.querySelectorAll('iframe'); } catch (e) { return out; }
      for (var fi = 0; fi < frames.length; fi++) {
        try {
          var cd = frames[fi].contentDocument || (frames[fi].contentWindow && frames[fi].contentWindow.document);
          if (cd) {
            var sub = allDocsOf(cd, depth - 1);
            for (var si = 0; si < sub.length; si++) out.push(sub[si]);
          }
        } catch (e) { /* 跨域，跳过 */ }
        if (out.length > 12) break;
      }
      return out;
    }
    var docsX = allDocsOf(document, 3);
    /* 收窄：原来带 div[class*="attach"]，会把 UEditor 编辑器之类的容器也算成任务点
       （实测点开任务点那一步因此点到了 DIV.edui-button-body）。三个主类够用。 */
    var SELX = '.ans-attach-ct, .ans-attach-online, .ans-cc';
    for (var di = 0; di < docsX.length; di++) {
      try {
        var g = docsX[di].querySelectorAll(SELX);
        for (var gi = 0; gi < g.length; gi++) {
          if (g[gi].tagName === 'IFRAME') continue;
          if (pts.indexOf(g[gi]) < 0) pts.push(g[gi]);
        }
      } catch (e) {}
    }
    try { pts = pts.filter(function (el) { return !pts.some(function (o) { return o !== el && o.contains(el); }); }); } catch (e) {}
    o.d1Tasks_x = pts.length;   /* 跨层收到的任务点数，日志里能对上 */
  })();

  if (R.d1) {
    var FIN = /ans-job-finished|jobFinish|job-finished|icon_Completed/;
    var videoCard = null;
    if (R.v) {
      try { videoCard = R.v.closest('.ans-attach-ct'); } catch (e) { videoCard = null; }
    }
    for (var pi = 0; pi < pts.length; pi++) {
      var pt = pts[pi];
      var icon = pt.querySelector('.ans-job-icon');
      var done = FIN.test(String(pt.className || '')) ||
                 (!!icon && (FIN.test(String(icon.className || '')) || /完成/.test(String(icon.getAttribute('aria-label') || '')) && !/未完成/.test(String(icon.getAttribute('aria-label') || ''))));
      o.taskStats.total++;
      if (done) o.taskStats.done++; else o.taskStats.pending++;
      if (pt === videoCard) o.taskStats.videoCardDone = done;
      if (!done && o.taskStats.pendingNames.length < 4) {
        var fr = pt.querySelector('iframe');
        var src = String((fr && fr.getAttribute('src')) || '');
        /* 这里故意用字符串包含判断，不用正则 ——
           这段是模板字符串里的代码，正则里的 \/ 要先被模板吃一层，
           写成 /modules\/video/ 实际发到页面里会变成 /modules/video/（非法正则）。
           这种坑我踩过两次了，能用 indexOf 就不用正则。 */
        var kind = src.indexOf('modules/video') >= 0 ? '视频'
                 : src.indexOf('modules/work') >= 0 ? '测验/作业'
                 : src.indexOf('modules/pdf') >= 0 || src.indexOf('insertdoc') >= 0 ? '文档'
                 : src.indexOf('modules/audio') >= 0 ? '音频'
                 : (src ? src.split('modules/').pop().split('/')[0] : '未知');
        o.taskStats.pendingNames.push(kind);
      }
    }
    /* 兼容字段：整章是否全绿（只有全绿才叫"这一章做完了"） */
    o.platformDone = (o.taskStats.total === 0) ? false : (o.taskStats.pending === 0);
  }

  /* 【目录侧的完成标记 —— 高数这类课全靠它（2026-10-07 实测）】
     任务点容器 .ans-attach-ct 挂在工作区那个 iframe 里，顶层 document 数出来是 0
     （实测：顶层 attachCT=0，iframe 里=2）。于是 taskStats.total=0 → platformDone 恒为 false，
     主循环那句 done = v.ended || v.cur >= v.dur-1.5 || s.platformDone 永远不成立 ——
     已经标着「已完成」的章节被从头重播一遍（实测：1.1.1 目录上明明写着"已完成"，
     18:24 的视频还在播）。旧版没这毛病，是因为它的完成判据挂在容器自己的 class 上，
     别人的原版还多一句「容器中未发现视频 or 文档，强制标记已读」。

     目录里每个章节条目自己带标记，顶层就能读到，最稳：
       <div class="posCatalog_select posCatalog_active" id="cur1227808527">
         <span class="icon_Completed prevTips"><span>已完成<i></i></span></span>
     顶层一共 124 个 .icon_Completed，只认"当前选中的那一条"。

     注意别改成读 jobUnfinishCount：那是**父章节**的汇总数（1.1 底下还有没提交的测验），
     读它会一直得到 1，反倒把已完成判成未完成。 */
  o.catalogDone = false;
  o.catalogMark = '';
  try {
    var actEl = document.querySelector('.posCatalog_active');
    if (actEl) {
      o.catalogDone = !!actEl.querySelector('.icon_Completed');
      o.catalogMark = String(actEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    }
  } catch (e) {}
  if (!o.platformDone && o.catalogDone) o.platformDone = true;

  o.iconCompleted = document.querySelectorAll('.icon_Completed').length;
  o.autoLog = (window.__autoResumeLog || []).slice(-40);
  o.autoOk = (window.__autoResumeLog || []).filter(function(x){ return x === 'ok'; }).length;
  o.autoQuiz = (window.__autoResumeLog || []).filter(function(x){ return x === 'quiz'; }).length;

  /* 「还有任务点未完成」弹窗（作者的门禁条件也是这句话）
     【关键：必须验"弹窗真的显示着"，光有文字不算】
     实测踩坑：这个 .popDiv 一直躺在 DOM 里（文字也在），但它是 0x0、压根没显示。
     老写法只看文字，于是驱动器以为弹窗拦路，去点里面那个 0x0 的「下一节」——
     那一下只会触发 changeDisplayContent（把卡片切到测验栏），根本不会翻章；
     章节于是原地不动，日志刷成"点了「下一节」但章节 20 秒没换"，空转几十次。
     原始脚本的 findPopupButton() 第一行就是可见性闸门（isVisible(el)），这里照做。 */
  o.blockPopup = null;
  o.popupVisible = false;
  o.popupBtns = [];
  var popupEl = document.querySelector('.popDiv.wid440.popMove') || document.querySelector('.popDiv');
  if (popupEl && popupEl.getClientRects && popupEl.getClientRects().length) {
    var ptxt = String(popupEl.innerText || '').replace(/\\s+/g, ' ').trim();
    if (/还有任务点未完成|未完成的任务点|当前章节还有|是否去完成/.test(ptxt)) {
      o.popupVisible = true;
      o.blockPopup = ptxt.slice(0, 90);
      var pas = popupEl.querySelectorAll('a, button');
      for (var pk = 0; pk < pas.length; pk++) {
        var pr = pas[pk].getBoundingClientRect();
        o.popupBtns.push(String(pas[pk].innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 8) +
          ((pr.width > 2 && pr.height > 2) ? '(可见)' : '(0x0)'));
      }
    }
  }

  if (!R.v) { o.video = null; return o; }

  var v = R.v;
  var host = v.closest('.video-js') || v.closest('[class*=vjs]') || v.closest('[class*=player]');
  var bigPlay = R.d2.querySelector('.vjs-big-play-button');
  var playCtrl = R.d2.querySelector('.vjs-play-control');

  /* 先把播放器滚回视口，再量坐标 —— 顺序反了量出来的就是屏幕外的点。
     顺手记下哪些坐标是真的落在视口里的（sees*），上层据此决定点不点。 */
  o.videoInView = scrollIntoViewDeep(playCtrl || bigPlay || v, 0.5);
  if (!o.videoInView) o.videoInView = scrollIntoViewDeep(v, 0.2);
  var bp = topRect(bigPlay, R);
  var pc = topRect(playCtrl, R);
  var ar = topRect(v, R);
  function sees(t){
    if (!t || t.x === null) return false;
    return t.x > 1 && t.y > 1 && t.x < window.innerWidth - 1 && t.y < window.innerHeight - 1;
  }
  o.video = {
    paused: v.paused, ended: v.ended,
    cur: Math.round(v.currentTime * 10) / 10,
    dur: Math.round((v.duration || 0) * 10) / 10,
    rs: v.readyState, rate: v.playbackRate, muted: v.muted,
    hasStarted: /vjs-has-started/.test(String((host || {}).className || '')),
    bigPlay: bp, seesBigPlay: sees(bp),
    playCtrl: pc, seesPlayCtrl: sees(pc),
    area: ar, seesArea: sees(ar),
    player: topRect(host, R),
    where: (R.f2sel || '(?)') + ' 第' + R.depthReached + '层',
    controls: R.d2.querySelectorAll('.vjs-big-play-button, .vjs-play-control').length,
    inVideoJs: !!v.closest('.video-js'),
    branch: o.branch
  };
  return o;
})()`;

/* 页面内自动续播钩子。
   为什么要有它：驱动器每秒才轮询一次，靠轮询去续播至少留 1.3 秒空档。
   装进页面里监听 pause 事件，一暂停就立刻恢复，延迟降到毫秒级。
   幂等：每轮都调一次，新章节的播放器是新元素，会被重新挂上。
   底线：检测到可见的答题控件（弹题）就不续播 —— 不替你把题跳过去。 */
const INSTALL_AUTORESUME = `(function(){
  ${CHAIN}
  var R = chain();
  if (!R.v || !R.d2) return { ok:false };
  var v = R.v;

  function hasVisibleQuiz(){
    try {
      var q = R.d2.querySelectorAll('input[type=radio], input[type=checkbox], textarea, .TiMu, .questionLi');
      for (var i = 0; i < q.length; i++) { if (q[i].getClientRects().length) return true; }
    } catch (e) {}
    return false;
  }

  if (!v.__autoResume) {
    v.__autoResume = true;
    v.addEventListener('pause', function(){
      try {
        if (v.ended) return;
        window.__autoResumeLog = window.__autoResumeLog || [];
        if (hasVisibleQuiz()) { window.__autoResumeLog.push('quiz'); return; }
        var p = v.play();
        if (p && p.catch) p.catch(function(){});
        window.__autoResumeLog.push('ok');
      } catch (e) {}
    });
  }
  return { ok:true, hooked:!!v.__autoResume, quiz:hasVisibleQuiz(), count:(window.__autoResumeLog||[]).length };
})()`;

/* 让它播：倍速按回 1，再调 play()。返回后由调用方确认是否真的起来了 */
const TRY_PLAY = `(function(){
  ${CHAIN}
  var R = chain();
  if (!R.v) return { ok:false, why:'no video' };
  var v = R.v;
  try { if (${KEEP_MUTED ? 'true' : 'false'}) v.muted = true; } catch(e){}
  /* 保护：别的东西可能把倍速改过。平台只接受 1x，先按回去 */
  try { if (v.playbackRate !== 1) v.playbackRate = 1; } catch(e){}
  /* 【为什么不能像对照脚本那样无条件 load()（2026-10-08 判断）】
     他是油猴脚本，调用点固定在"下一个任务点容器"里那个还没播的播放器，
     所以无条件 load() 对他安全。我们不一样：这里的 v 是 chain 选出来的，
     它完全可能是"正在播、只是还没播完"的那一个 —— 对正在播的调 load()
     会把 currentTime 打回 0，进度直接归零。
     所以必须卡死三个前提：没数据(readyState 0)、没播过(currentTime<=1)、有源。
     只卡 readyState 不够：缓冲卡住的视频 readyState 也会掉下来。 */
  var didLoad = false;
  try {
    if (v.readyState === 0 && !v.ended && v.currentTime <= 1 &&
        (v.src || v.currentSrc || v.querySelector('source[src]'))) {
      v.load();
      didLoad = true;
    }
  } catch(e){}
  /* 【play() 被拒就静音重试（2026-10-08 从对照脚本学来的）】
     他那招：play() 失败时打开 muted 再试一次 —— 浏览器和平台对静音播放的
     自动播放策略宽松得多。这一条跟"只发可信事件"不冲突：
     muted 只是播放器属性，不是伪造出来的事件。 */
  try {
    var p = v.play();
    if (p && p.catch) p.catch(function(){
      try {
        v.muted = true;
        var p2 = v.play();
        if (p2 && p2.catch) p2.catch(function(){});
      } catch (e2) {}
    });
  } catch(e){ return { ok:false, why:e.name, didLoad:didLoad }; }
  return { ok:true, muted:v.muted, rate:v.playbackRate, didLoad:didLoad };
})()`;

/* 「下一节」按钮：滚进视口、量准坐标、命中测试，通过了才返回坐标 */
const SCROLL_NEXT = `(function(){
  var cands = [];
  function push(el) { if (el && cands.indexOf(el) < 0) cands.push(el); }
  function norm(s) { return String(s == null ? "" : s).replace(/\\s+/g, "").trim(); }

  /* 【第一梯队：id / class 直取（最准，先试）】 */
  push(document.getElementById('prevNextFocusNext'));
  push(document.getElementById('nextChapter'));
  /* 【新版学习页（mooc-ans）的上一节/下一节】2026-10-12 实测（高数 266357289）：
     那一页上真正可见可点的是「DIV#right1.orientationright」（101×41，onclick=PCount.next(...)），
     而「a.jb_btn」/「a.bluebtn02.prebutton」那两个候选是 **0×0 的隐藏元素** ——
     驱动器按尺寸拒绝了它们（设计是对的），于是卡在"找不到「下一节」"空转。
     这里把新版那两个补进第一梯队；尺寸/命中测试照旧管着，点不到就不会点。
     （★ 这段是模板字符串，注释里**不许出现反引号** —— 今天栽第四次了。） */
  push(document.getElementById('right1'));
  push(document.getElementById('left1'));
  var sels2 = ['#right1', '.orientationright', '#left1', '.orientationleft',
               "[onclick*='PCount.next']", "[onclick*='PCount.previous']"];
  for (var si2 = 0; si2 < sels2.length; si2++) {
    var g2 = document.querySelectorAll(sels2[si2]);
    for (var gi2 = 0; gi2 < g2.length; gi2++) push(g2[gi2]);
  }
  var sels = ['.prev_next', '.prev_next .next', '[class*="nextChapter"]',
              '.next-chapter', '.btn-next', "[title='下一节']", "[title='下一章']"];
  for (var si = 0; si < sels.length; si++) {
    var g = document.querySelectorAll(sels[si]);
    for (var gi = 0; gi < g.length; gi++) push(g[gi]);
  }

  /* 【第二梯队：按文字找 —— 补自 nuaa 那份 pyc 里的候选表】
     他 pyc 里的原表是：
       ['下一页','下一章','下一节','下一题','下一步',
        '.next-chapter', "[title='下一节']", ".jb_btn:has-text('下一节')",
        "span:has-text('下一节')", '.next', "[class*='next']", '.btn-next',
        '#nextChapter', '.prev_next .next']
     其中 :has-text() 是 Playwright 专属语法，浏览器里根本不存在 ——
     所以这里自己按 innerText 过滤一遍（旧版油猴脚本也是这么说的：
     "作者把 CSS 选择器和 Playwright 的 :has-text() 混在一起用，本脚本用 textPick() 自己实现")。
     故意**没有**照抄 [class*='next']：那个太宽，视频播放器里一堆 next 类名会被扫进来。
     候选多不怕 —— 后面每个都要过尺寸 / 视口 / elementFromPoint 三关，扫不中的自然被淘汰。 */
  var WORDS = ['下一节', '下一章', '下一页', '下一题', '下一步', '继续下一节'];
  var pool = document.querySelectorAll('a, button, span, div.btn, li, .jb_btn');
  for (var pi = 0; pi < pool.length && cands.length < 40; pi++) {
    var el = pool[pi];
    var t = norm(el.innerText || el.textContent || '');
    if (t.length > 0 && t.length <= 8) {
      for (var wi = 0; wi < WORDS.length; wi++) {
        if (t === WORDS[wi]) { push(el); break; }
      }
    }
  }
  if (!cands.length) return { none: true, why: '页面上没有「下一节」按钮' };

  /* 【方向闸门：把"上一节"这类反向按钮剔掉（2026-10-07 实测抓到的隐患）】
     实测这一页的两个按钮：
       <DIV class="jb_btn jb_btn_92 fs14 prev_next next fr">下一节</DIV>   @(797,883)
       <DIV class="btnBlue btn_92 fs14 prev_next marginRigh">上一节</DIV>  @(684,883)
     那个 .prev_next 是**两者共用**的类名，所以两个都会进候选表。眼下 DOM 顺序
     恰好让"下一节"排在前头，看不出问题；可一旦某页只剩"上一节"，驱动器就会往回点。
     历史日志里那个症状正好对得上：
       "从 01:04:46 开始章节名开始往回跳（1.9 → 1.5 → 1.6 → 1.7 → 1.8 → 1.9）"。
     往前走是这套流程唯一的合法方向，反方向的按钮一律不要。 */
  var BACKWARDS = /上一节|上一章|上一页|上一题|上一步|preChapter|previous/i;
  cands = cands.filter(function (el) {
    var t = norm(el.innerText || el.textContent || '');
    var c = String(el.className || '') + ' ' + String(el.getAttribute('onclick') || '');
    return !BACKWARDS.test(t) && !/previous/i.test(c);
  });
  if (!cands.length) return { none: true, why: '只找到"上一节"这类反向按钮，没有前进按钮' };

  var tried = [];
  for (var k = 0; k < cands.length; k++) {
    var nb = cands[k];
    try { nb.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    var r = nb.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) { tried.push('候选' + k + ' 尺寸为 0'); continue; }
    var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) {
      tried.push('候选' + k + ' 滚进视口后仍在视口外 (' + cx + ',' + cy + ')，视口 ' + window.innerWidth + 'x' + window.innerHeight);
      continue;
    }
    var hit = document.elementFromPoint(cx, cy);
    if (!(hit && (hit === nb || nb.contains(hit) || hit.contains(nb)))) {
      tried.push('候选' + k + ' 坐标上命中的是 <' + (hit ? hit.tagName : 'null') + '>');
      continue;
    }
    return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height),
             at: [Math.round(r.left), Math.round(r.top)], vp: [window.innerWidth, window.innerHeight],
             cls: String(nb.className || '').slice(0, 60), txt: String(nb.innerText || '').trim().slice(0, 10),
             disabled: /disabled|disable/i.test(String(nb.className || '')) };
  }
  return { none: true, why: tried.join('  |  '), count: cands.length };
})()`;

/* 弹窗里的「强行跳过」按钮 —— 沿用作者 find_confirmation_bypass_button 的选择器顺序。
   注意 .popDiv 在页面上有多个，那个 .wid440.popMove 的高特异性选择器是必要的。 */
/* ------------------------------------------------------------------
 * 点掉「当前章节还有任务点未完成」弹窗 —— 在页面里点，不算坐标。
 *
 * 弹窗原样（掏出来的）：
 *   <div class="popDiv wid440 popMove">
 *     <A class="popClose fr" onclick="closeDeleteWindow()"><IMG></A>
 *     <P class="popWord2 ...">当前章节还有任务点未完成，是否去完成？</P>
 *     <A class="jb_btn ... preChapter" onclick="closeDeleteWindow();PCount.previous(...)">上一节</A>
 *     <A class="jb_btn ... nextChapter" onclick="closeDeleteWindow();PCount.next(...)">下一节</A>
 *     <A class="btnBlue ... popMoveDele" onclick="scroll2Job()">去学习</A>
 *
 * 为什么改成"在页面里点"：
 *   老办法是"算坐标 + Input.dispatchMouseEvent"，路数没错，
 *   但它前面卡了一道可见性检查 —— 这个弹窗带 popMove 进场动画，
 *   元素被判成不可见就 continue 了，而且那条分支连原因都不记，
 *   报出来是"没有任何元素匹配选择器"，完全看不出真相。
 *   而按钮的 onclick 是明写在标签上的，在页面里派发指针事件就能触发，
 *   不需要坐标，也就绕开了可见性和命中测试这一整套麻烦。
 *
 * 优先级：先找能往前走的 nextChapter；找不到再点关闭。
 * ------------------------------------------------------------------ */
const POPUP_CLICK = `(function () {
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, '').trim(); }
  var pd = document.querySelector('.popDiv.wid440.popMove') || document.querySelector('.popDiv');
  if (!pd) return { ok: false, why: '页面上没有 .popDiv' };

  var plan = [
    ['.nextChapter', '下一节'],
    ['.popClose', '关闭'],
    ['.preChapter', '上一节']
  ];
  var el = null, label = '', sel = '';
  for (var i = 0; i < plan.length && !el; i++) {
    var c = pd.querySelector(plan[i][0]);
    if (!c) continue;
    /* 这里**不做尺寸检查**：元素是拿 onclick 在页面里点的，跟布局没关系。
       上一版就是被"尺寸为 0"挡住了 —— 弹窗进场动画还没铺开时，
       .nextChapter 的 rect 是 0x0，于是被跳过，只剩下 .popClose 可点，
       结果变成"关了又弹、弹了又关"的原地打转。 */
    el = c; label = plan[i][1]; sel = plan[i][0];
  }
  if (!el) {
    var any = pd.querySelectorAll('a'), seen = [];
    for (var k = 0; k < any.length; k++) seen.push(norm(any[k].innerText).slice(0, 10) + '[' + String(any[k].className) + ']');
    return { ok: false, why: '弹窗里没有 .nextChapter / .popClose，里面这些 a：' + seen.join(' ') };
  }

  var oc = String(el.getAttribute('onclick') || '');
  if (/提交|交卷/.test(norm(el.innerText)) || /btnSubmit|btnBlueSubmit/i.test(String(el.className || '') + ' ' + oc)) {
    return { ok: false, why: '这个按钮沾提交，拒绝点击：' + (norm(el.innerText) || oc) };
  }

  var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  var r2 = el.getBoundingClientRect();
  var cx = r2.left + r2.width / 2, cy = r2.top + r2.height / 2;
  function mk(t2) { try { return new win.MouseEvent(t2, { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy, button: 0 }); } catch (e) { return null; } }
  var evs = [mk('mouseover'), mk('mousedown'), mk('mouseup'), mk('click')];
  for (var j = 0; j < evs.length; j++) if (evs[j]) el.dispatchEvent(evs[j]);
  return { ok: true, label: label, sel: sel, onclick: oc.slice(0, 60),
           gone: !document.querySelector('.popDiv.wid440.popMove') };
})()`;
const CONFIRM_POPUP = `(function(){
  function vis(el){ return !!(el && el.getClientRects && el.getClientRects().length); }
  function T(el){ return String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim(); }

  if (!/还有任务点未完成/.test(document.body ? document.body.innerText : '')) {
    return { found:false, why:'页面上没有「还有任务点未完成」文案' };
  }

  var sels = [
    '.popDiv.wid440.popMove .nextChapter',
    '.popDiv a.nextChapter',
    'a.nextChapter',
    '.popDiv a',
    '[class*="pop"] a',
    '.popDiv button',
    '[class*="pop"] button',
    /* 有些弹窗根本没有"下一节"，只有一个关闭按钮 —— 而且那是个图片，
       不是 a/button，所以上面所有选择器一个都命不中。加上这些。 */
    '[title*="关闭"]', '[alt*="关闭"]',
    '.popDiv img', '[class*="pop"] img',
    '[class*="close"]', 'img[src*="close"]', 'img[src*="Close"]'
  ];
  /* 顺序有讲究：先找"下一节"这类能往前走的，找不到才退而求其次点关闭。
     所以"关闭"放在白名单最后。 */
  var want = ['下一节', '继续下一节', '强行下一节', '确定', '强行跳转', '关闭', 'Close'];
  var tried = [];

  for (var s = 0; s < sels.length; s++) {
    var list;
    try { list = document.querySelectorAll(sels[s]); } catch (e) { tried.push(sels[s] + ' 选择器无效'); continue; }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!vis(el)) continue;
      var t = T(el);
      var okText = false;
      for (var w = 0; w < want.length; w++) if (t.indexOf(want[w]) >= 0) { okText = true; break; }
      if (!okText) continue;

      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) { tried.push(sels[s] + ' 尺寸为 0'); continue; }
      var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) {
        tried.push(sels[s] + ' 在视口外 (' + cx + ',' + cy + ')'); continue;
      }
      var hit = document.elementFromPoint(cx, cy);
      if (!(hit && (hit === el || el.contains(hit) || hit.contains(el)))) {
        tried.push(sels[s] + ' 未命中（命中到 <' + (hit ? hit.tagName : 'null') + '>）'); continue;
      }
      return { found:true, sel:sels[s], txt:t.slice(0, 12), x:cx, y:cy,
               w:Math.round(r.width), h:Math.round(r.height), cls:String(el.className || '').slice(0, 60) };
    }
  }
  /* 一个都没命中时，把"附近有什么"也带回去 —— 光说"没命中"没法查。 */
  var near = [];
  var all = document.querySelectorAll('a, button, img, div, span, input, li');
  for (var z = 0; z < all.length && near.length < 12; z++) {
    var e2 = all[z];
    var tt = String((e2.innerText || e2.textContent || '') + ' ' + (e2.getAttribute('title') || '') + ' ' + (e2.getAttribute('alt') || '')).replace(/\s+/g, ' ').trim();
    if (!tt || tt.length > 40) continue;
    if (!/关闭|下一节|确定|跳过|继续|任务点/.test(tt)) continue;
    if (!vis(e2)) continue;
    near.push('<' + e2.tagName + ' ' + String(e2.className || '').slice(0, 30) + '> 「' + tt.slice(0, 24) + '」');
  }
  return { found:false, why:'所有选择器都没命中可点的按钮：' + (tried.join(' | ') || '(没有任何元素匹配选择器)'),
           near: near };
})()`;

/* ------------------------------------------------------------------
 * 打开 / 关闭当前章节的「章节测验」标签页。
 *
 * 为什么需要它：
 *   驱动器的老行为是：平台弹「还有任务点未完成」→ 直接点「下一节」跳过。
 *   但"未完成的任务点"往往**就是这一章的测验** —— 于是测验从来没被打开过，
 *   答题助手一次都触发不了，自动填充自然也永远不执行。
 *   （实测：整整一轮 20 多个章节，测验记录文件一个字都没加。）
 *
 * 依据：这一页顶部有 #dct1（章节）/ #dct2（章节测验）两个标签。
 *   点 #dct2 会调用 changeDisplayContent(...)，把 #iframe.src 换成带 &num=1 的
 *   地址，测验就在那个 iframe 里（再往下还嵌着两层）。
 *   这两个标签可能在顶层文档，也可能在 knowledge/cards 那个 iframe 里，所以两处都找。
 *
 * 【踩过的坑：光靠合成 MouseEvent 点不动它】
 *   标签是 <li class="c1" onclick="changeDisplayContent(1,2,...)" id="dct1">，
 *   处理函数直接写在 onclick 属性上。合成 MouseEvent 打上去不一定触发它 ——
 *   实测：点完 #iframe.src 里的 num 还是 1，于是卡片页一直停在"章节测验"那一栏，
 *   里面根本没有视频卡，驱动器就一路判定"本节没有可播的内容"，然后反复去开测验，
 *   在原地上打转（这次的"不动了"就是这么来的）。
 *   现在改成三招挨个试，并且**用 iframe.src 里的 num 验证到底换没换**：
 *     A. el.click()        —— 原生点击，对 onclick 属性最有效（实测有效）
 *     B. 合成指针事件       —— 原来那套，留着兜底
 *     C. 直接求值 onclick  —— 前两招都不灵才用，最接近手工执行
 *   已经在该标签上（num 对得上、class 带 active）就直接返回，不白点一下。
 * ------------------------------------------------------------------ */
function tabSwitch(which) {
  return `(function () {
  var WANT = ${JSON.stringify(which)};
  var WANT_NUM = (WANT === 'dct2') ? '1' : '0';
  function numOf() {
    try {
      var f = document.getElementById('iframe');
      var m = String((f && f.getAttribute('src')) || '').match(/[?&]num=(\\d+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  function allDocs() {
    var out = [document];
    function walk(d, depth) {
      if (depth > 3) return;
      var fs = d.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) {
        var cd = null;
        try { cd = fs[i].contentDocument; } catch (e) {}
        if (cd && cd.body && out.indexOf(cd) < 0) { out.push(cd); walk(cd, depth + 1); }
      }
    }
    walk(document, 0);
    return out;
  }
  var num0 = numOf();
  /* 先把这个标签自己的信息摸清楚（哪怕最后决定不点）——
     以前"直接 return already"那条路不带 text/where，日志里就出现
     「#dct2「undefined」」这种没法看的东西。 */
  var docs = allDocs();
  var targetEl = null, targetWhere = '', targetText = '';
  for (var dd = 0; dd < docs.length && !targetEl; dd++) {
    var cand = null;
    try { cand = docs[dd].querySelector('#' + WANT); } catch (e) { cand = null; }
    if (cand) {
      targetEl = cand;
      targetWhere = (dd === 0) ? '顶层' : '第 ' + dd + ' 层文档';
      targetText = String(cand.innerText || cand.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    }
  }
  var clsNow = targetEl ? String(targetEl.className || '') : '';
  /* "已经在目标栏"要同时满足两件事才作数：
   *   a) 地址里的 num 对得上
   *   b) 这个标签自己带 active（真正显示出来的那一栏）
   * 只看 num 会误判：换栏的一瞬间 num 先变、内容还没换过来，
   * 这时截图截到的是**上一栏**的画面（实测：答题助手截到的是视频播放器那一屏，
   * 然后照着这一屏"答题"，答了个寂寞）。 */
  var isActive = /(^|\s)active(\s|$)/.test(clsNow);
  if (num0 && num0 === WANT_NUM && (isActive || !targetEl)) {
    return { ok: true, already: true, where: targetWhere || '已在目标栏', text: targetText,
             num: num0, active: isActive, why: '已经是 num=' + WANT_NUM + (isActive ? '（且已高亮）' : '') };
  }
  for (var d = 0; d < docs.length; d++) {
    var el = docs[d].querySelector('#' + WANT);
    if (!el) continue;
    var where = (d === 0) ? '顶层' : '第 ' + d + ' 层文档';
    var t = String(el.innerText || el.textContent || '').trim().slice(0, 16);
    var cls0 = String(el.className || '');
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var oc = String(el.getAttribute('onclick') || '');
    var tries = [];

    /* A. 原生点击 */
    try { el.click(); } catch (e) { tries.push('el.click() 抛错 ' + e.message); }
    if (numOf() === WANT_NUM) {
      return { ok: true, how: 'el.click()', where: where, text: t, clsBefore: cls0,
               num: numOf(), numBefore: num0 };
    }
    tries.push('el.click() 没换栏');

    /* B. 合成指针事件 */
    function mk(t2) {
      try { return new win.MouseEvent(t2, { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy, button: 0 }); }
      catch (e) { return null; }
    }
    var evs = [mk('mouseover'), mk('mousedown'), mk('mouseup'), mk('click')];
    for (var k = 0; k < evs.length; k++) if (evs[k]) el.dispatchEvent(evs[k]);
    if (numOf() === WANT_NUM) {
      return { ok: true, how: '合成指针事件', where: where, text: t, clsBefore: cls0,
               num: numOf(), numBefore: num0 };
    }
    tries.push('合成指针事件没换栏');

    /* C. 直接求值 onclick 属性 —— 最接近手工执行那一句 */
    if (oc) {
      try { win.eval(oc); } catch (e) { tries.push('求值 onclick 抛错 ' + e.message); }
      if (numOf() === WANT_NUM) {
        return { ok: true, how: '直接求值 onclick', where: where, text: t, clsBefore: cls0,
                 onclick: oc.slice(0, 60), num: numOf(), numBefore: num0 };
      }
      tries.push('求值 onclick 没换栏');
    }
    return { ok: false, where: where, text: t, num: numOf(), numBefore: num0,
             why: '三招都没把卡片页切到 num=' + WANT_NUM + '：' + tries.join('；') };
  }
  return { ok: false, why: '两个文档里都没有 #' + WANT + '（num 现在是 ' + num0 + '）' };
})()`;
}
const OPEN_QUIZ_TAB = tabSwitch('dct2');    /* 切到「章节测验」 */
const BACK_CHAPTER  = tabSwitch('dct1');    /* 切回「章节」 */


/* ------------------------------------------------------------------
 * 自愈：卡片页现在停在"章节测验"那一栏（&num=1）吗？是就切回"章节"（&num=0）。
 *
 * 为什么非要它：num=1 的时候，cards 里**根本没有视频卡**，只有测验/作业卡。
 * 于是驱动器看到的是"这一章没有视频" → 按流程去开测验 → 测验做完/做完又回到 num=1 →
 * 下一轮还是"没有视频"。整章就在原地打转，视频一个都播不了。
 * 严格说这是"自己把标签留在测验栏"留下的尾巴，兜一下比事后排查省事得多。
 * ------------------------------------------------------------------ */
const TAB_SELFHEAL = `(async function () {
  function numOf() {
    try {
      var f = document.getElementById('iframe');
      var m = String((f && f.getAttribute('src')) || '').match(/[?&]num=(\\d+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  var before = numOf();
  /* 换栏的那一瞬间 iframe 会重新加载，src 会短暂读不到（num=''）。
     这时候**不能**当"不在测验栏"就放手 —— 等 600ms 再读一次，仍然读不到才作罢。
     （实测：正是这个空档让自愈漏掉一拍，然后驱动器又去开了一次测验。） */
  if (before !== '1') {
    if (before === '') {
      try { await new Promise(function (r) { setTimeout(r, 600); }); } catch (e) {}
      before = numOf();
    }
    if (before !== '1') return { need: false, num: before };
  }
  /* 这一栏确实有测验要交代 —— 有题就别自己切走，交给答题助手 */
  var cards = null;
  try { cards = document.getElementById('iframe').contentDocument; } catch (e) {}
  var quizLike = false;
  if (cards) {
    try {
      quizLike = cards.querySelectorAll('input[type=radio], input[type=checkbox], textarea, .TiMu, .questionLi').length > 0;
    } catch (e) {}
  }
  if (quizLike) return { need: false, num: before, why: '测验栏里有题，留给答题助手' };

  var d1 = null;
  var docs = [document];
  try { if (cards) docs.push(cards); } catch (e) {}
  for (var i = 0; i < docs.length && !d1; i++) {
    try { d1 = docs[i].getElementById('dct1'); } catch (e) {}
  }
  if (!d1) return { need: true, num: before, ok: false, why: '停在测验栏，但找不到 #dct1 切回去' };

  var how = '';
  try { d1.click(); } catch (e) {}
  how = 'el.click()';
  if (numOf() !== '0') {
    var win = (d1.ownerDocument && d1.ownerDocument.defaultView) || window;
    var oc = String(d1.getAttribute('onclick') || '');
    if (oc) { try { win.eval(oc); how = '求值 onclick'; } catch (e) {} }
  }
  var after = numOf();
  return { need: true, ok: (after === '0'), how: how, numBefore: before, numAfter: after };
})()`;

/* ------------------------------------------------------------------
 * 点开一个未完成的任务点，让它的内容真正加载出来。
 *
 * 照旧版油猴脚本的 activateTaskPoint（v2.6.1）搬来的，它那份注释的原话：
 *   学习通的任务点**不点开，内容（尤其是 <video>）根本不会出现在 DOM 里**。
 *   之前的版本只会"等"，于是永远等不到视频，最后被误判成文档跳过去。
 *   这就是"不能自动播放视频"的真正原因。
 * 日志证据也是从 nuaa 那份 pyc 里挖到的：[卡片] 已切换至卡片 N。
 *
 * 和旧版唯一的区别：旧版用合成事件 realClick（isTrusted=false），
 * 我们这边点击一律走可信通道 —— 所以这里只**算坐标**（先滚动，再逐层累加 iframe 偏移），
 * 真正点下去由驱动用 CDP 的 Input.dispatchMouseEvent 发。
 * 另外绝不点 iframe：它是内容的载体，点它什么都不会发生（旧版为此专门写过一行）。
 * ------------------------------------------------------------------ */
const ACTIVATE_TASK = `(function(){
  var FIN = /ans-job-finished|jobFinish|job-finished|icon_Completed/;
  function done(el){
    try {
      if (FIN.test(String(el.className || ''))) return true;
      var ic = el.querySelector('.ans-job-icon');
      if (ic && (FIN.test(String(ic.className || '')) || /完成/.test(String(ic.getAttribute('aria-label') || '')))) return true;
    } catch (e) {}
    return false;
  }
  function allDocsOf(root, depth){
    var out = [root];
    if (!depth) return out;
    var frames; try { frames = root.querySelectorAll('iframe'); } catch (e) { return out; }
    for (var i = 0; i < frames.length; i++){
      try {
        var cd = frames[i].contentDocument || (frames[i].contentWindow && frames[i].contentWindow.document);
        if (cd) { var sub = allDocsOf(cd, depth - 1); for (var k = 0; k < sub.length; k++) out.push(sub[k]); }
      } catch (e) {}
      if (out.length > 12) break;
    }
    return out;
  }
  function topCoord(el){
    if (!el) return null;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var win = null;
    try { win = el.ownerDocument.defaultView; } catch (e) { win = null; }
    while (win && win !== window) {
      var fe = null;
      try { fe = win.frameElement; } catch (e) { fe = null; }
      if (!fe) break;
      var fr = fe.getBoundingClientRect();
      x += fr.left; y += fr.top;
      win = win.parent;
    }
    return { x: Math.round(x), y: Math.round(y),
             inView: (x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight) };
  }
  var docs = allDocsOf(document, 3);
  /* 【容器选择器收窄了（2026-10-07 实测）】
     原来带 div[class*="attach"]，太宽 —— 实测把一个 UEditor 富文本编辑器的容器也收了进来，
     于是点开任务点那一步点到了 DIV.edui-button-body（编辑器的加粗/斜体那种按钮），
     日志里是：👆 点开任务点（DIV.edui-button-body）：   未完成 2/3 个。
     .ans-attach-ct / .ans-attach-online / .ans-cc 这三个才是任务点容器，
     去掉宽匹配后仍能跨层收全（实测同一页仍是 3 个）。 */
  var SEL = '.ans-attach-ct, .ans-attach-online, .ans-cc';
  var boxes = [];
  for (var di = 0; di < docs.length; di++){
    try {
      var g = docs[di].querySelectorAll(SEL);
      for (var gi = 0; gi < g.length; gi++){
        if (g[gi].tagName === 'IFRAME') continue;
        if (boxes.indexOf(g[gi]) < 0) boxes.push(g[gi]);
      }
    } catch (e) {}
  }
  try { boxes = boxes.filter(function (el) { return !boxes.some(function (o) { return o !== el && o.contains(el); }); }); } catch (e) {}
  /* 【跳过"内容已经播完"的卡片（2026-10-08 多视频）】
     平台给卡片打完成标记有延迟（实测十几秒）。这期间它仍然是 pending，
     可它里面的视频早就 ended 了 —— 再点开它毫无作用，
     只会把"去点开下一个任务点"这件事空转掉，第二个视频卡还是进不来。
     所以这里把"有真媒体、且全都播完了"的卡片也算作处理过了。 */
  function realMedia(el){
    try {
      /* 【判据必须和 driver 侧的 isRealMedia 一致（2026-10-08 最终复查）】
         两边不一致的话，同一个 <video> 会一边算真媒体、一边不算。
         这里漏判的后果是 mediaAllDone 永远返回 false，卡片一直算 pending。 */
      if (el.id && String(el.id).indexOf('video_html5') >= 0) return true;
      if (el.closest && el.closest('.video-js, [class*=vjs], [class*=player], [class*=Player]')) return true;
      if (el.currentSrc || el.getAttribute('src')) return true;
      if (el.readyState > 0 || el.duration > 0) return true;
      var r = el.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) return true;
    } catch (e) {}
    return false;
  }
  function mediaAllDone(box){
    var saw = false, unfinished = false;
    (function walk(d, dep){
      if (!d || dep > 3 || unfinished) return;
      var vv = null; try { vv = d.querySelectorAll('video, audio'); } catch (e) { vv = null; }
      if (vv) for (var i = 0; i < vv.length; i++){
        var el = vv[i];
        if (!realMedia(el)) continue;
        saw = true;
        var fin = false;
        try { fin = el.ended || (el.duration > 0 && el.currentTime >= el.duration - 1.5); } catch (e2) {}
        if (!fin) { unfinished = true; return; }
      }
      var fs = null; try { fs = d.querySelectorAll('iframe'); } catch (e) { fs = null; }
      if (fs) for (var j = 0; j < fs.length; j++){
        var cd = null; try { cd = fs[j].contentDocument; } catch (e) { cd = null; }
        if (cd) walk(cd, dep + 1);
      }
    /* 【必须从 box 开始扫，不能从 document 开始（2026-10-08 复查发现）】
       box 是"这一个任务点卡片"。从 document 起遍历的话，同一页别的卡片里的
       视频也会被算进来 —— 只要那一个没播完，unfinished 就是 true，
       于是**每个卡片都永远不算"全播完"**，pending[0] 死卡在第一个卡片上
       反复点，正好把这次多视频修复的效果整个抵消掉。 */
    })(box, 0);
    return saw && !unfinished;
  }
  var pending = boxes.filter(function (b) { return !done(b) && !mediaAllDone(b); });
  if (!pending.length) return { ok: false, why: '没有未完成的任务点', total: boxes.length };
  var box = pending[0];
  var el = null;
  try {
    el = box.querySelector('.ans-attach-online') || box.querySelector('.ans-insertdoc') || null;
    /* 【只认"明确的卡片入口"，找不到就点容器本身】
       旧版油猴脚本这里的候选链最后两个是 box.querySelector('a') 和
       box.querySelector('[onclick]')。照搬过来之后实测点到了
       DIV.edui-button-body（UEditor 编辑器的工具按钮）—— 那是个误会，
       编辑器容器也会命中宽泛的选择器。这里把宽匹配去掉，并把编辑器类名排除掉。 */
    if (!el) {
      var a = box.querySelector('a[onclick], .jobTitle, h3.attachTitle');
      if (a && !/edui|ueditor|w-e-/i.test(String(a.className || ''))) el = a;
    }
  } catch (e) { el = null; }
  if (el && el.tagName === 'IFRAME') el = null;
  if (!el) el = box;
  var pos = topCoord(el);
  if (!pos) return { ok: false, why: '算不出坐标' };
  return { ok: true, x: pos.x, y: pos.y, inView: pos.inView, total: boxes.length, pending: pending.length,
           label: String(box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
           tag: el.tagName + '.' + String(el.className || '').trim().split(/\\s+/)[0] };
})()`;

/* 文档阅读：用作者的三处容器和 400px 步长，但「读到没读到」的判断自己写严。
   他原码里有两处 ended 写死 true（什么都不滚的时候直接返回 100%），
   那正是「3 秒判定已读然后翻页」的根源 —— 这里不沿用。 */
const DOC_STEP = `(function(){
  ${CHAIN}
  var R = chain();
  function fmt(label, cur, max, clientH){
    var pct = max > 0 ? Math.min(100, (cur + clientH) / max * 100) : 0;
    return { type: label, cur: Math.round(cur), max: Math.round(max), clientH: Math.round(clientH),
             pct: pct.toFixed(1), ended: (cur + clientH) >= (max - 30) };
  }
  function byWin(win, label){
    try {
      var doc = win.document, de = doc.documentElement, bd = doc.body;
      var max = Math.max(de ? de.scrollHeight : 0, bd ? bd.scrollHeight : 0);
      var clientH = win.innerHeight || (de ? de.clientHeight : 0) || 0;
      var cur = win.pageYOffset || (de ? de.scrollTop : 0) || 0;
      if (max > clientH + 20) { win.scrollTo(0, cur + 400);
        var nc = win.pageYOffset || (de ? de.scrollTop : 0) || 0;
        return fmt(label, nc, max, clientH); }
    } catch (e) {}
    return null;
  }
  function byEl(el, label){
    if (!el) return null;
    if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 50) {
      el.scrollTop = el.scrollTop + 400;
      return fmt(label, el.scrollTop, el.scrollHeight, el.clientHeight);
    }
    return null;
  }
  var scope = R.d1 || document;

  var pan = scope.querySelector('#panView') || document.querySelector('#panView');
  if (pan && pan.contentWindow) { var r1 = byWin(pan.contentWindow, '#panView'); if (r1) return r1; }
  var r2 = byEl(scope.querySelector('#container'), '#container'); if (r2) return r2;
  var r3 = byEl(scope.querySelector('#scrollBox'), '#scrollBox'); if (r3) return r3;

  /* 【递归下钻找"可滚的文档层"】—— 这一条是用户点出来的
     我原来只查 scope(=cards) 和顶层的 #panView/#container/#scrollBox，就报了"没得滚"。
     实测那一章的 PDF 阅读器在 cards > if0(卡片) > if1(#panView) 两层 iframe 底下，
     而且它的**文档层本身**是可滚的：clientHeight=546、scrollHeight=13419，
     window.scrollTo(0,500) 真能滚下去（可滚 12873px）。
     也就是说"文档类任务"能做，只是我们没找到那个容器。
     现在：从顶层逐层往下（最多 5 层），谁可滚就滚谁，取可滚距离最大的那一个。
     排除掉含 <video> 的层（那是播放器，滚它没意义）。 */
  function findScrollWin(doc, win, depth){
    if (!doc || depth > 5) return null;
    var best = null;
    try {
      var de = doc.documentElement || doc.body;
      if (de) {
        var max = Math.max(de.scrollHeight || 0, (doc.body ? doc.body.scrollHeight : 0));
        var clientH = win.innerHeight || de.clientHeight || 0;
        var hasVideo = false;
        try { hasVideo = !!doc.querySelector('video'); } catch (e) {}
        if (max > clientH + 60 && clientH > 150 && !hasVideo) best = { win: win, max: max, clientH: clientH };
      }
    } catch (e) {}
    var fs = null; try { fs = doc.querySelectorAll('iframe'); } catch (e) { fs = null; }
    if (fs) {
      for (var i = 0; i < fs.length; i++) {
        var cd = null, cw = null;
        try { cd = fs[i].contentDocument; cw = fs[i].contentWindow; } catch (e) { cd = null; }
        if (!cd || !cd.body || !cw) continue;
        var inner = findScrollWin(cd, cw, depth + 1);
        if (inner && (!best || inner.max > best.max)) best = inner;
      }
    }
    return best;
  }
  var sw = findScrollWin(document, window, 0);
  if (sw) {
    var cur0 = sw.win.pageYOffset || 0;
    try { sw.win.scrollTo(0, cur0 + 400); } catch (e) {}
    var cur1 = sw.win.pageYOffset || 0;
    if (cur1 > cur0) {
      var where = '深层文档层（可滚 ' + Math.round(sw.max) + 'px）';
      return fmt(where, cur1, sw.max, sw.clientH);
    }
  }

  /* 兜底：找一个真正可滚动的深容器，排除掉装着播放器的那些 */
  var all = scope.querySelectorAll('div, section, main, article');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (e.clientHeight < 250 || e.clientWidth < 300) continue;
    if (e.scrollHeight <= e.clientHeight + 200) continue;
    if (e.querySelector('video')) continue;
    if (e.querySelector('.ans-attach-online')) continue;
    var r4 = byEl(e, '兜底:' + String(e.id || e.className || 'div').slice(0, 26));
    if (r4) return r4;
  }
  return { type: 'none' };
})()`;

/* ---------------- 主流程 ---------------- */
(async () => {
  /* 【启动横幅放最前面】
     为什么不放到下面那些检查之后再打：连不上调试端口时 pickCoursePage 会直接抛错退出，
     那样你连"我到底开没开 60 倍速"都看不到 —— 而"开了没生效"十有八九就是这个原因
     （浏览器不是用 开始.cmd 起的，端口压根没开）。所以这几行必须在任何会抛错的步骤之前。 */
  console.log('=== 学习通 CDP 驱动器 ===');
  console.log('端口 ' + PORT +
              '   模式 ' + (RUN ? (NEXT ? (FORCE ? '驱动+翻节+跳过弹窗' : '驱动+翻节') : '驱动') : '只观察') +
              '   静音 ' + (KEEP_MUTED ? '是' : '否') + (MAX_SECONDS ? ('   限时 ' + MAX_SECONDS + 's') : '   不限时'));
  if (HB_SPEED > 1) {
    console.log('伪心跳: ' + HB_SPEED + 'x 开   每 ' + Math.round(HB_TICK_MS / 1000) + ' 秒一条   最多 ' +
                HB_MAX_TRIES_ARG + ' 条' + (HB_JUMP ? '   报满后推播放位置' : '') +
                '   —— 不碰播放倍速，替播放器上报进度');
  } else {
    console.log('伪心跳: 关（控制台主菜单按 8 可以开；或命令行加 --speed=60）');
  }
  console.log('');

  const { page, pages } = await pickCoursePage();
  console.log('页面: ' + String(page.title).slice(0, 30));
  console.log('      ' + String(page.url).slice(0, 110));
  if (pages.length > 1) console.log('（另有 ' + (pages.length - 1) + ' 个标签页）');
  console.log('');

  startKeepAwake();

  /* 答题助手（默认关闭）。配置在 答题设置.json，双击 控制台.cmd → 4 → 4 改 */
  let quizCfg = quizMod.loadConfig();

  /* ---------------- 本次运行的"没做的题"记录界面 ----------------
     为什么要它：实测出过"这一章 5 道题只填了 4 道"，日志里只有一行"已按顺序填进页面：第1…第4题"，
     既不说是哪一道没做，也不说为什么，更没有一个地方能一眼看全"这一趟到底欠了几道"。
     现在三个出口，题目计数一律走**单独的文件**，不跟播放日志混在一起：
       1) 本次运行-题目计数.txt —— 每章一行小结 + 收尾总账（你看题目情况只看这个文件）
       2) 本次运行-没做的题.txt —— 每一道欠账的明细（章节/题型/题干/选项/原因）
       3) 控制台只留"这一章有几道题"一行，方便你边跑边看
     注意：不提交、不伪造任何东西，没做的照样是没做，只是记清楚。 */
  const MISS_FILE = path.join(__dirname, '本次运行-没做的题.txt');
  const QUIZLOG_FILE = path.join(__dirname, '本次运行-题目计数.txt');
  const missedList = [];
  const chapterTally = [];   /* 每章一行：{at, chapter, found, filled, missed} */
  const quizStats = { chapters: 0, found: 0, filled: 0, missed: 0 };
  let missFileReady = false;
  let quizLogReady = false;
  function stamp() { return new Date().toLocaleString('zh-CN'); }
  function missFileHeader() {
    return '\uFEFF本次运行「没做的题」记录\n' +
      '生成时间：' + stamp() + '\n' +
      '说明：这是驱动器**没做成**的题。填进去的答案都是「暂时保存」的草稿，从未提交；\n' +
      '      没填上的题这里都记着，回头你自己补。文件每次启动驱动器时重写。\n' +
      '='.repeat(72) + '\r\n';
  }
  function quizLogHeader() {
    const MODE = ['不做题', '记下题·不问AI', '记下题·问AI'];
    return '\uFEFF本次运行「题目计数」\n' +
      '启动时间：' + stamp() + '\n' +
      '答题助手：' + (MODE[quizCfg.mode] || '不做题') +
      (quizCfg.mode >= 2 ? ('   模型 ' + quizCfg.model) : '') + '\n' +
      '说明：填进去的都是「暂时保存」的草稿，**从未提交**。没做成的明细在同目录的\n' +
      '      本次运行-没做的题.txt。这个文件每次启动驱动器时重写。\n' +
      '='.repeat(72) + '\r\n' +
      '时间'.padEnd(22) + '章节'.padEnd(30) + '题目  填上  欠\r\n' +
      '-'.repeat(72) + '\r\n';
  }
  /* 题目计数：写进单独文件（外加控制台一行），**不写进播放日志** */
  function quizLog(line, alsoConsole) {
    if (alsoConsole !== false) console.log('[' + ts() + '] ' + line);
    if (!quizLogReady) return;
    try { fs.appendFileSync(QUIZLOG_FILE, line + '\r\n', 'utf8'); } catch (e) {}
  }
  function startMissFile() {
    try {
      fs.writeFileSync(MISS_FILE, missFileHeader(), 'utf8');
      missFileReady = true;
    } catch (e) { log('（"没做的题"记录写不了：' + e.message + '）'); }
  }
  function startQuizLog() {
    try {
      fs.writeFileSync(QUIZLOG_FILE, quizLogHeader(), 'utf8');
      quizLogReady = true;
    } catch (e) { log('（"题目计数"记录写不了：' + e.message + '）'); }
  }
  /* 每章一行 */
  function tallyChapter(chapter, found, missed) {
    const filled = Math.max(0, found - missed);
    chapterTally.push({ at: stamp(), chapter: chapter || '(读不到)', found: found, filled: filled, missed: missed });
    quizLog(String(stamp()).padEnd(22) + String(chapter || '(读不到)').slice(0, 28).padEnd(30) +
            String(found).padStart(4) + String(filled).padStart(6) + String(missed).padStart(5));
    return filled;
  }
  /* 收尾总账 —— 只落文件，不刷屏 */
  function writeQuizTotal() {
    if (!quizLogReady) return;
    const filled = Math.max(0, quizStats.found - quizStats.missed);
    const out = [];
    out.push('-'.repeat(72));
    out.push('总账（' + stamp() + ' 结束）');
    out.push('  遇到题目 : ' + quizStats.found + ' 道' + (quizStats.chapters ? ('（' + quizStats.chapters + ' 次测验）') : ''));
    out.push('  填上了   : ' + filled + ' 道（都是「暂时保存」的草稿，没有提交）');
    out.push('  没做成   : ' + quizStats.missed + ' 道');
    if (missedList.length) {
      const byChapter = new Map();
      for (const r of missedList) {
        const k = r.chapter || '(章节读不到)';
        if (!byChapter.has(k)) byChapter.set(k, []);
        byChapter.get(k).push(r);
      }
      out.push('');
      out.push('没做成的题按章列出：');
      for (const [ch, arr] of byChapter) {
        out.push('  《' + ch + '》  ' + arr.length + ' 道');
        for (const r of arr) {
          out.push('     · [' + (r.type || '?') + '] ' + String(r.stem || '').replace(/\s+/g, ' ').slice(0, 70));
          out.push('       原因：' + (r.why || '未知'));
        }
      }
      out.push('');
      out.push('  （明细也写进了：本次运行-没做的题.txt）');
    } else if (quizStats.found > 0) {
      out.push('  （这一趟遇到的题全部填上了）');
    } else {
      out.push('  （这一趟没碰到题）');
    }
    out.push('='.repeat(72));
    try { fs.appendFileSync(QUIZLOG_FILE, out.join('\r\n') + '\r\n', 'utf8'); } catch (e) {}
  }
  function recordMiss(rec) {
    missedList.push(rec);
    quizStats.missed++;
    if (!missFileReady) return;
    try {
      fs.appendFileSync(MISS_FILE,
        '[' + stamp() + ']  ' + (rec.chapter || '(章节读不到)') + '\r\n' +
        '    题型：' + (rec.type || '(未知)') + '\r\n' +
        '    题干：' + String(rec.stem || '').replace(/\s+/g, ' ').slice(0, 180) + '\r\n' +
        (rec.options && rec.options.length ? ('    选项：' + rec.options.join('  ') + '\r\n') : '') +
        '    原因：' + (rec.why || '未知') + '\r\n\r\n', 'utf8');
    } catch (e) { /* 写不进去也不能打断驱动 */ }
  }
  /* 配置里每条路都要带上这两个字段：换章会重读配置，所以每次都补 */
  function attachQuizBookkeeping(cfg2) {
    cfg2.stats = quizStats;
    cfg2.onUnanswered = recordMiss;
    return cfg2;
  }
  attachQuizBookkeeping(quizCfg);
  startMissFile();
  startQuizLog();

  /* shot / ev 都要到下面几十行之后才定义。这里用箭头函数包一层做"惰性引用" ——
     定义这个对象的时候它们还在暂时性死区里，但只要不在这一刻调用就没事。 */
  const quizDeps = {
    shot: (o) => shot(o),
    ev: (e) => ev(e),
    /* 【选项点击改走可信通道（2026-10-07 实测）】
       学习通只认 isTrusted=true 的真鼠标事件。答题助手原来在页面里
       dispatchEvent 手造 MouseEvent（isTrusted=false），10 道题全部报"点了没选中"、
       一道都填不上。这里把 clickTop 交给它 —— 坐标由页面侧算好（含逐层 iframe 偏移），
       真正点下去由 CDP 发；点完答题助手会自己复查 selected，不会假装成功。 */
    /* 【带看门狗】
       clickTop 里面的 c.send 是没有超时保护的（历史实测：连接一断，
       send 的 promise 就永远不 resolve，整条流程僵在那里、日志一个字节不写）。
       答题助手会 await 这里，所以必须掐上限 —— 和 ev 那个 15 秒看门狗同理。 */
    clickAt: async (x, y) => {
      try {
        await Promise.race([
          clickTop(x, y),
          new Promise((res) => setTimeout(res, 8000)),
        ]);
        return true;
      } catch (e) { return false; }
    },
    /* 【把"重新打开章节测验栏"给答题助手】
       为什么需要：实测（2026/9/26 16:36，军事理论 2.1 国防法规与体系）——
       切到「章节测验」栏之后，装着题目的那张 work 卡 iframe
       **会先被卸载、过一会儿才挂回来**。答题助手"读题 → 截图 → 问模型"要花好几秒，
       等轮到填答案时，正好落在 iframe 不在的那个窗口里：
       fillAct 数出"页面上共 0 题"，3 道答案全丢（层诊断实测 work 卡 iframe=0）。
       干等没用 —— 等的是一个不会自己回来的东西。得重新点一次标签把它叫回来。 */
    reopenQuiz: async () => {
      try {
        const r = await ev(OPEN_QUIZ_TAB);
        return (r && r.ok) ? 'ok' : ('没切过去：' + ((r && r.why) || '未知'));
      } catch (e) { return '切栏出错：' + (e && e.message ? e.message : e); }
    }
  };
  let quizHelper = quizMod.makeHelper(quizCfg, quizDeps);
  const MODE_NAME = ['不做题', '记下题·不问AI', '记下题·问AI'];
  console.log('答题助手: ' + (MODE_NAME[quizCfg.mode] || '不做题') +
    (quizCfg.mode === 0 ? '（测验一概不碰，只放视频和翻节）' : '') +
    (quizCfg.mode >= 2 ? ('   模型 ' + quizCfg.model + (quizCfg.apiKey ? '   密钥已配置' : '   ⚠ 密钥没配，问不了')) : '') +
    (quizCfg.mode > 0 && quizCfg.stopAtQuiz ? '   遇到测验会停下等你' : '') +
    (quizCfg.mode > 0 ? '   记录写到 章节测验记录.txt' : ''));
  console.log('');

  /* ---------------- 连接（可以重新绑） ----------------
     为什么要能重绑：实测冻死过一次 —— 页面在驱动器脚下被整个换掉
     （用户切到另一门课），顶层 #iframe 消失、#dct1 找不到，驱动器落进
     "等页面就绪"那个分支里死循环，日志一个字节都不再写。
     那时候 CDP 还连在**旧标签页**上，光重试 Runtime.evaluate 是没用的，
     必须重新挑一次标签页再连。 */
  let c = await connect(page.webSocketDebuggerUrl);
  let curTargetId = page.id;
  /* ev = 在页面里求值。**必须带看门狗**：
     实测（2026/9/26 17:14:34）连接一断，send() 的 promise 就永远不 resolve，
     主循环 await 在那里再也不动 —— 进程活着、CPU 不动、日志不写，僵 6 分钟。
     所以这里自己掐一个时限：到点就返回 undefined（上层本来就有"读不到页面就重绑"的处理），
     绝不让整条流程被一个不回来的请求吊死。 */
  const EV_TIMEOUT_MS = 15000;
  const evalOnce = (expr) => Promise.race([
    /* 【awaitPromise 必不可少（2026-10-07 实测）】
       页面里有一批探针是 (async function(){ ... })() —— tabSwitch、TAB_SELFHEAL 都是。
       不传 awaitPromise 时 CDP 不等这个 Promise，回给我们的只是个空壳对象，
       于是一路都是 r.ok === undefined：日志里那句「没切过去：未知」、
       以及自愈一次都没生效，根源都在这里（三招全试过却看不到 why）。
       加了它对同步表达式没有任何影响 —— 非 Promise 值原样返回。 */
    c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      .then((r) => {
        if (r && r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
        return r && r.result && r.result.result && r.result.result.value;
      })
      .catch(() => undefined),
    new Promise((res) => setTimeout(() => res(undefined), EV_TIMEOUT_MS)),
  ]);
  let ev = evalOnce;

  /* ---------------- 伪心跳 60 倍速 ----------------
     只在 --speed=N（N>1）时真正工作；不传就是原样，一行都不参与。
     它自己负责挂钩子、抓真实上报样本、反推 dtoken、按 N 倍速补报；
     driver 这边每轮推它一下就够了 —— 细节见 伪心跳.js 顶部那段说明。 */
  const hb = hbMod.makeHeartbeat({ speed: HB_SPEED, tickMs: HB_TICK_MS, jump: HB_JUMP, maxTries: HB_MAX_TRIES_ARG, log });
  let hbStopped = false;      /* 平台明确拒绝后停下，本节改回老实播放 */
  let hbReportAt = 0;         /* 进度行的节流，免得刷屏 */
  let hbErrAt = 0;            /* 出错日志的节流（出错不能每轮刷一条） */
  let hbDoneAt = 0;           /* 伪心跳报满的时刻，用来兜底防空转 */

  /* 截图。答题助手走"截图读题"那条路时用它。
     返回裸 base64（不带 data: 前缀）；失败返回空串，由上层去报告，
     这样一次截图失败不会把整条驱动流程打断。
     用 JPEG 是因为图片要 base64 塞进请求体，PNG 会大好几倍。 */
  const shot = async (opts) => {
    try {
      const r = await c.send('Page.captureScreenshot',
        Object.assign({ format: 'jpeg', quality: 82 }, opts || {}));
      /* 注意返回结构：这个连接拿到的就是 {data: '...'} 这一层，
         没有更外层的 result —— 今天我在测试脚本里写成 r.result.result.data，
         白白以为"截图拍不到"，绕了一大圈。 */
      return (r && r.result && r.result.data) || '';
    } catch (e) {
      return '';
    }
  };

  /* 【把浏览器窗口拉回屏幕内、恢复正常大小】
     实测（2026/9/26 17:23）：用户把 Edge 窗口拖到了屏幕下沿
     （bounds top=833 height=1051），可视区被压成 781x156 一条缝。
     后果非常隐蔽：截图返回空、题目元素算出负坐标、
     答题助手报告"图片内容为空白"，我看到的是"模型认不出题"，
     一路查到坐标、查到 clip、查到视口才找到真正原因。
     所以启动时先看一眼：窗口太小或者位置跑到屏幕外，就用 CDP 把它设回来。
     （只动大小和位置，不动用户的其它设置；跑完也不改回去 —— 留着反而方便用户看。） */
  async function ensureWindowUsable() {
    try {
      const w = await c.send('Browser.getWindowForTarget', { targetId: curTargetId });
      if (!w || !w.bounds) return;
      const b = w.bounds;
      const tiny = (b.width < 900 || b.height < 600);
      const offscreen = (b.top < 0 || b.left < 0 || b.top > 800 || b.left > 1200);
      if (!tiny && !offscreen) return;
      log('⚠ 浏览器窗口不太对（位置 ' + b.left + ',' + b.top + '  大小 ' + b.width + 'x' + b.height +
          '）—— 截图会拍成空白条、点坐标也会偏。自动把它拉回屏幕内。');
      await c.send('Browser.setWindowBounds', {
        windowId: w.windowId,
        bounds: { left: 40, top: 40, width: 1500, height: 1000, windowState: 'normal' }
      });
      log('  已设为 40,40  1500x1000。');
    } catch (e) {
      log('（检查窗口失败，不影响继续：' + (e && e.message ? e.message : e) + '）');
    }
  }
  /* 【临时撑大视口给截图用】
     实测（2026/9/26 17:23）：用户的浏览器窗口被拖到屏幕下沿（top=833 height=1051），
     页面可视区被压成 781x**156** 一条缝 —— 截图拍到的是空白条，
     答题助手于是报告"图片内容为空白"，整章白丢；而且题目元素算出的坐标是负数。
     截图期间把视口设成正常大小就解决了。**拍完必须还原**：
     驱动器的点击坐标是按真实视口算的，不还原就会点错地方。 */
  shot.setViewport = async (w, h) => {
    try {
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: w || 1280, height: h || 900, deviceScaleFactor: 1, mobile: false
      });
      return true;
    } catch (e) { return false; }
  };
  shot.clearViewport = async () => {
    try { await c.send('Emulation.clearDeviceMetricsOverride', {}); return true; }
    catch (e) { return false; }
  };

  async function armConnection() {
    /* 注意：这里必须调 evalOnce 那份（它带看门狗），不能另写一个裸的 ——
       以前两处各写了一份，加了看门狗之后只有一处生效，重连后就又变回"能吊死"的版本。 */
    ev = (expr) => evalOnce(expr);
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  }
  await armConnection();
  await ensureWindowUsable();   /* 窗口被压扁的话先修好，否则后面截图全是空白条 */

  /* 连接还活着吗？主循环每轮问一次，断了就重绑 ——
     实测（2026/9/26 17:14:34）连接悄悄断掉后，驱动器会一直僵着不写日志，
     光靠"等页面就绪超时"那条路要等 45 秒才反应过来，而且它只判"页面读不到"、
     不判"连接没了"。这里直接看连接本身。 */
  async function ensureConnection() {
    if (!c.isClosed || !c.isClosed()) return true;
    log('⚠ CDP 连接已经断了（' + c.closedWhy() + '）—— 重新挑标签页、重连。');
    const note = await rebindTarget('连接断了');
    log('  ↳ ' + note);
    return false;   /* 让调用方这一轮先跳过，下一轮用新连接重新探 */
  }

  /* 重新挑一次标签页并连上去。返回一行给人看的说明。 */
  async function rebindTarget(why) {
    let fresh = null;
    try { fresh = await pickCoursePage(); } catch (e) { return '重新找标签页失败：' + e.message; }
    if (!fresh || !fresh.page) return '重新找标签页失败：没找到学习通课程页';
    const sameTarget = (fresh.page.id === curTargetId);
    try { c.ws.close(); } catch (e) {}
    c = await connect(fresh.page.webSocketDebuggerUrl);
    curTargetId = fresh.page.id;
    await armConnection();
    return (sameTarget ? '重新连上同一个标签页' : '换到了另一个标签页') +
           '（' + String(fresh.page.url).slice(0, 80) + '）  原因：' + why;
  }

  async function clickTop(x, y) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 });
    await sleep(180);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(90);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /* 试着打开当前章节的「章节测验」并交给答题助手。每章只试一次。
     返回 'stop' 表示按设置要退出。
     原来这段只写在 handlePopup 的"跳过分支"里 —— 结果是：只有弹窗拦路时才会去找测验。
     高数这类没有视频的课永远不触发弹窗，测验就一次都没被打开过。现在两条路都会调它。
     【v2 补充】"视频已完成"那条路以前**根本不调它**，于是"视频做完了、题没做"的章节
     连测验都不会被打开就翻页了 —— 这就是"把题一起跳了"。现在 done 分支也会先调它。 */
  /* 【已经填过的题，这一轮不再填第二遍】
     实测（2026/9/26 16:00:46，《极限存在准则》）：视频刚播完，
     主循环那条路刚把 2 道题填好、记账完毕，紧接着 done 分支的 tryQuiz 又把这 2 道题
     重填了一遍 —— 又一次截图 + 又一次问模型（白花一次 API 费用），而且**驱动器正好死在这一处**
     （16:00:46 打完「直接做」之后进程消失、日志一个字节不再写，两个不同进程都死在同一位置）。
     平台不认「暂时保存」，所以 quizDone 一直是 false，光靠它拦不住重复填。
     这里用"这一轮已经处理过哪些题"自己记一笔：处理成功就记下这一章，
     第二次进来直接跳过。
     【跨外套重启这件事（2026-10-11 补）】外套每约 15 秒就会把新进程拉起来，
     所以这张账现在会落到本轮的检查点文件里；但**从磁盘恢复回来的记录不直接信** ——
     见下面 verifyRestoredFilled()：只有"课程 + 章节 + 题数都对得上，且页面现在
     确实显示平台已完成"时才复用，否则当作没记过、重新探一次。草稿永远不算完成。 */
  const quizFilledKeys = new Set();
  let quizFilledNoted = '';   /* 已经就"本轮填过了"讲过一句的章节，避免每轮刷屏 */
  /* 从检查点恢复、但**还没经过页面复核**的章节（第一次碰到时必须先探一次页面） */
  const filledFromDisk = new Set();
  let courseIdCache = null;
  async function currentCourseId() {
    if (courseIdCache) return courseIdCache;
    try {
      const cid = await ev(`(function(){ var m = String(location.href).match(/[?&]courseId=(\\d+)/i); return m ? m[1] : ''; })()`);
      if (cid) courseIdCache = String(cid);
    } catch (e) { /* 读不到就按空处理，检查点那边会判"身份不足" */ }
    return courseIdCache || (lastCourseId || '');
  }

  /** 落一次检查点：只记"这一章本轮处理过什么"，不记任何凭据。
   *  身份（课程号 + 章节名 + 题数）一起记 —— 复核时全靠它对上对不上。 */
  function chkSave(chapter, extra) {
    if (!CHK || !chapter) return;
    try {
      const course = courseIdCache || lastCourseId || '';
      const ex = extra || {};
      const rec = {
        courseId: String(course || ''),
        chapter: String(chapter),
        quizFound: Number.isFinite(Number(ex.quizFound)) ? Number(ex.quizFound) : 0,
        verifiedResult: ex.verifiedResult === true,
        quizFilled: quizFilledKeys.has(chapter),
        quizStamped: quizStampedChapters.has(chapter),
        taskTried: Number(taskTriedCount[chapter] || 0),
      };
      const id = checkpointMod.chapterIdentity({
        courseId: rec.courseId,
        chapter: rec.chapter,
        quizFound: rec.quizFound,
      });
      rec.identity = id.ok ? id.id : '';
      rec.identityOk = !!id.ok;
      rec.identityWhy = id.ok ? '' : id.reason;
      CHK.set(chapter, rec);
      const r = CHK.flush();
      if (!r.ok) chkWriteFailed(r.reason);
    } catch (e) { chkWriteFailed((e && e.message) || String(e)); }
  }
  function chkWriteFailed(reason) {
    if (chkWriteErrNoted === String(reason)) return;
    chkWriteErrNoted = String(reason);
    log('⚠ 检查点写不进去：' + chkWriteErrNoted);
    log('  后果：外套重启后这一轮的去重账会丢，同一章可能被重复填一次（多花 API 钱）。运行继续。');
  }

  /**
   * 复核"从检查点恢复的本章已填记录"。
   * 返回 'reuse' / 'discard' / 'uncertain'，并会按结果改已经恢复的账。
   * 底线：草稿不是完成；题面身份不足时宁可重新探，也不永久跳过。
   */
  async function verifyRestoredFilled(chapter) {
    if (!chapter || !filledFromDisk.has(chapter)) return 'reuse';
    filledFromDisk.delete(chapter);          /* 只复核一次 */
    const st = await ev(PROBE);              /* 现在的页面真实状态 */
    if (!st || st.__err) {
      /* 探不到就别猜：这一章按"没记过"处理，下一轮重新探一次。 */
      quizFilledKeys.delete(chapter);
      if (CHK) { try { CHK.del(chapter); CHK.flush(); } catch (e) {} }
      log('  ↳ 上一轮记过「' + chapter + '」已填，但这次读不到页面状态 —— 当没记过，重新探一次。');
      return 'uncertain';
    }
    const rec = CHK ? CHK.get(chapter) : null;
    const recCourse = String((rec && rec.courseId) || '');
    const liveCourse = await currentCourseId();
    if (recCourse && liveCourse && recCourse !== liveCourse) {
      quizFilledKeys.delete(chapter);
      if (CHK) { try { CHK.del(chapter); CHK.flush(); } catch (e) {} }
      log('  ↳ 上一轮那次是**另一门课**（课程号 ' + recCourse + '）记下的「' + chapter +
          '」—— 课程号对不上，作废这条记录，这一章重新处理。');
      return 'discard';
    }
    const qFound = await liveQuizCount();
    /* 【带图的题也一样：记录里没有图片指纹就重读一遍】只在页面真有图时才去翻记录（成本可控）。 */
    let imgNeed = false;
    try {
      const imgN = await liveQuizImgCount();
      if (imgN > 0 && !recordBlockHasImgIds(chapter)) {
        imgNeed = true;
        log('  ↳ 这一章有 ' + imgN + ' 道带图的题，而记录里没有图片指纹 —— 重读一遍补上（只读、不问 AI、不填答案）');
      }
    } catch (e) { /* 读不到就按老规矩 */ }
    const d = checkpointMod
      ? checkpointMod.decideReuse(rec, { chapter, quizFound: qFound, platformDone: !!st.quizDone, imgNeed: imgNeed })
      : { decision: 'uncertain', reason: '没有检查点模块' };
    if (d.decision === 'reuse') {
      log('  ↳ 复核通过：' + d.reason + '（「' + chapter + '」不再重复填答）');
      /* 兜底：万一刚才被别处清掉了（比如检查点文件在复核期间被清了），
         也要保证这张账还在 —— 否则下面那条分支会以为"没记过"，反复回头复核。 */
      quizFilledKeys.add(chapter);
      return 'reuse';
    }
    /* 不能复用：把恢复来的账撤掉，让这一章重新走一遍正常流程 */
    quizFilledKeys.delete(chapter);
    if (CHK) { try { CHK.del(chapter); } catch (e) {} }
    log('  ↳ 复核没过：' + d.reason);
    if (d.decision === 'discard' && (st.chapter || '') === chapter) {
      quizStampedChapters.delete(chapter);
      quizTriedFor = '';
    }
    if (CHK) { try { CHK.flush(); } catch (e) {} }
    return d.decision;
  }

  /**
   * 现场读"这一章有几道题**带图**"。只读，不点任何东西。
   * 为什么单开一个：图片指纹是 2026-10-12 才加的字段，老记录里没有它 ——
   * 只有当页面上确实有带图的题时，才值得翻记录、重读一遍把指纹补上（否则白白多跑一遍）。
   */
  async function liveQuizImgCount() {
    try {
      const n = await ev(`(function () {
        var seen = [], total = 0;
        function walk(d, depth) {
          if (!d || depth > 4 || seen.indexOf(d) >= 0) return;
          seen.push(d);
          var q = null; try { q = d.querySelectorAll('.TiMu'); } catch (e) { q = null; }
          if (q) for (var i = 0; i < q.length; i++) {
            var hit = false;
            try {
              var g = q[i].querySelectorAll('.Zy_TItle img, .mark_name img, li img');
              for (var k = 0; k < g.length; k++) {
                var s = String(g[k].getAttribute('src') || '');
                if (s && s.indexOf('data:') !== 0) { hit = true; break; }
              }
            } catch (e) {}
            if (hit) total++;
          }
          var fs = null;
          try { fs = d.querySelectorAll('iframe'); } catch (e) { return; }
          for (var j = 0; j < fs.length; j++) {
            var cd = null;
            try { cd = fs[j].contentDocument; } catch (e) {}
            if (cd && cd.body) walk(cd, depth + 1);
          }
        }
        walk(document, 0);
        return total;
      })()`);
      const v = Number(n);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) { return 0; }
  }

  /**
   * 记录文件里"这一章最后一块"有没有 `→ 图片指纹：` 行。
   * 读不出来一律返回 true（当作"有"）—— 宁可少补一次，也别因为读文件失败把每一章都重读。
   */
  function recordBlockHasImgIds(chapter) {
    try {
      const f = (quizMod && quizMod.OUT_FILE) || path.join(__dirname, '章节测验记录.txt');
      if (!fs.existsSync(f) || !chapter) return true;
      const raw = fs.readFileSync(f, 'utf8');
      const head = '] ' + chapter + '\r\n';
      const i = raw.lastIndexOf(head);
      if (i < 0) return true;                       /* 记录里没有这一章 → 交给别的判据 */
      const seg = raw.slice(i + head.length);
      const j = seg.indexOf('\r\n[');
      const block = j >= 0 ? seg.slice(0, j) : seg;
      return block.indexOf('→ 图片指纹：') >= 0;
    } catch (e) { return true; }
  }

  /**
   * 读不到（题目还没渲染 / 页面停在"章节"栏 / iframe 跨域）返回 0。
   * 0 在复用判定里表示"没有题面证据" → 判定为 uncertain（不跳过、重新探），
   * 而不是"题数一致"。宁可多探一次，也不在没有题面证据时把一整章放过去。
   */
  async function liveQuizCount() {
    try {
      const n = await ev(`(function () {
        var seen = [], total = 0;
        function walk(d, depth) {
          if (!d || depth > 4 || seen.indexOf(d) >= 0) return;
          seen.push(d);
          try { total += d.querySelectorAll('.TiMu').length; } catch (e) {}
          var fs = null;
          try { fs = d.querySelectorAll('iframe'); } catch (e) { return; }
          for (var i = 0; i < fs.length; i++) {
            var cd = null;
            try { cd = fs[i].contentDocument; } catch (e) {}
            if (cd && cd.body) walk(cd, depth + 1);
          }
        }
        walk(document, 0);
        return total;
      })()`);
      const v = Number(n);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) { return 0; }
  }

  async function tryQuiz(chapter, tail) {
    /* 模式 0 就是"一概不碰测验"；
       另外：本章这次运行里已经认过一次了就不再认（跨驱动器重进也一样），
       否则会变成"打开测验 → 切回章节 → 又打开"，原地打转。 */
    if (quizHelper.mode <= 0) return 'skipped';
    if (quizStampedChapters.has(chapter)) {
      /* 从检查点恢复来的"这一章认过了"必须先过页面复核，过了才真的跳过 */
      if (filledFromDisk.has(chapter) || stampedFromDisk.has(chapter)) {
        const dec = await verifyRestoredFilled(chapter);
        stampedFromDisk.delete(chapter);
        if (dec === 'reuse') return 'skipped';
      } else {
        return 'skipped';
      }
    }
    if (quizTriedFor === chapter) return 'skipped';
    /* 这一章这一轮已经把题填进去了：别再填第二遍（重填会再花一次 API，
       而且实测重复填的那一处正好是驱动器消失的位置）。当成 'handled' 返回，
       让上层照常往下走（滚文档、翻页）。 */
    if (quizFilledKeys.has(chapter)) {
      const dec = await verifyRestoredFilled(chapter);
      if (dec !== 'reuse') {
        /* 复核没过：这一章要当真重新处理一次，别走下面那条"已填过"的短路 */
        return await tryQuiz(chapter, tail);
      }
      /* 只在第一次进来时说一句；之后每轮都打会把日志刷成一片
         （实测 16:07 那次每 2 秒一行，把真正的进度全淹了）。 */
      if (quizFilledNoted !== chapter) {
        quizFilledNoted = chapter;
        log('  ↳ 这一章的题本轮已经填过了（' + chapter + '），不重复填。');
      }
      /* 【必须在这里也更新 quizTriedFor（2026-10-07 实测的关键 bug）】
         原来这条分支直接 return 'handled'，不碰 quizTriedFor ——
         于是上层那句 `if (quizRes === 'handled') { …; continue; }` 每轮都执行，
         章节没变、done 仍为真、tryQuiz 又返回 'handled'，**转成一个出不去的圈**，
         全靠 90 秒零推进兜底把它踢出去。这就是"翻页要等好久"的真身。

         而答题成功的章节（实测「函数极限」10 填上 10 欠 0）走的是下面 1888 那行，
         quizTriedFor 被置上了，所以下一轮 1875 直接 'skipped'、利落翻页 ——
         这正是他观察到的"函数极限就能快速翻页，其他的就慢"。

         补上这一句后：第一次照样 'handled'（上层滚一下文档、回头探一次），
         第二轮 1875 命中 'skipped'，立刻往下走 —— 90 秒变一两秒。 */
      quizTriedFor = chapter;
      return 'handled';
    }
    quizTriedFor = chapter;
    quizStampedChapters.add(chapter);
    quizBusy = true;   /* 从这一刻起主循环只等不动，直到下面 finally 放开 */
    try {
      return await runQuiz(chapter, tail);
    } finally {
      quizBusy = false;
    }
  }

  /* 真正去开测验、答题的那一段。跟 tryQuiz 分开只是为了把"忙"标记包干净 */
  async function runQuiz(chapter, tail) {
    /* 【进主流程之前也过一遍闸门】上一章留下的"保存没被确认"必须先拦住。
       正常路径上 handle 之后当场就停了、走不到这里；这条是兜底 ——
       万一那一轮停在了别处，这一轮也绝不能先去探题再翻页：页面一个字都不许动。
       （saveAttempted 传 true：这里存在可疑状态，本身就是"已经走到过保存"的结果。） */
    if (gateCheck('重开测验之前', true) === 'stop-manual') return 'stop';
    /* 先问一句：这一章的测验是不是已经做过了（做题痕迹 / 控件全 disabled / 判分标记）。
       做过的就别再打开重填一遍。 */
    const st = await ev(PROBE);
    if (st && st.quizDone) {
      log('  ↳ 这一章的测验已经做过了（' + (st.quizDoneBy || '有已答痕迹') + '），不重填。' + tail);
      return 'done';
    }
    const op = await ev(OPEN_QUIZ_TAB);
    if (!op || !op.ok) {
      /* 【没有 #dct2 标签 ≠ 这一章没有题】
         这是"函数的求导法则 直接被跳过"的真正原因：
         高数的题**就在卡片页里**（一张 work 卡，跟视频/文档并排），压根没有「章节测验」标签；
         而这里以前是"找不到标签就 return"，探针一次都没跑过 ——
         界面跟军事理论的测验其实一模一样（同一套 /mooc-ans/api/work -> frame_content），
         差的只是**入口**：那边要点标签才出现，这边一进页面就在。
         所以改成：没有标签也照样在这里**探题 + 答题**，整段自己做，不去碰下面那套依赖标签的流程。 */
      log('  ↳ 这一章没有「章节测验」标签（' + ((op && op.why) || '') + '），先直接在页面里找题看看…');
      let qrNoTab = null;
      /* 多探几轮：work 卡的题目是异步加载的，实测有时候要十几秒才渲染出来。
         只试 3 次太短（上一次就是这么错过这一章的题的）。 */
      for (let a0 = 1; a0 <= 6; a0++) {
        try { qrNoTab = await quizHelper.probe(ev); } catch (e) { qrNoTab = null; }
        if (qrNoTab && qrNoTab.found) break;
        if (a0 < 6) log('  ↳ 还没看到题（第 ' + a0 + '/6 次），等 3 秒再看…');
        await sleep(3000);
      }
      if (!qrNoTab || !qrNoTab.found) {
        log('  ↳ 页面里也没找到题（探针扫了 ' + ((qrNoTab && qrNoTab.docCount) || '?') + ' 个文档层）。' + tail);
        return 'none';
      }
      log('  ↳ 没有标签，但页面里就有 ' + qrNoTab.found + ' 道题（work 卡），直接做。');
      quizSeen = (chapter || '') + '|' + qrNoTab.found;
      quizStats.chapters++;
      quizStats.found += qrNoTab.found;
      const missBefore0 = quizStats.missed;
      let lines0 = null;
      try {
        lines0 = await quizHelper.handle(chapter, qrNoTab, log);
        for (const l0 of lines0) log(l0);
      } catch (e) {
        log('  ↳ 答题助手出错：' + (e && e.message ? e.message : e));
      }
      let res0 = 'handled';
      let didFill0 = false, didNot0 = false;
      for (const l0 of (lines0 || [])) {
        const s0 = String(l0);
        if (s0.indexOf('已按顺序填进页面') >= 0) didFill0 = true;
        else if (s0.indexOf('没填上') >= 0 || s0.indexOf('没能从') >= 0 || s0.indexOf('所以没填') >= 0) didNot0 = true;
      }
      if (lines0 && !didFill0 && didNot0) res0 = 'opened';
      /* 【保存没被确认 → 停在当前题页，不翻页、不切栏、不让外套重拉】
         位置故意放在 tallyChapter / quizFilledKeys **之前之外**：
         保存没确认就不能把这一章记成"本轮填过了"（那等于默默把草稿当完成）。
         这条路本来就不切栏，所以"保留当前题页"是**什么都不做**。 */
      if (gateCheck('没有测验标签那条路', !!lines0) === 'stop-manual') return 'stop';
      /* 跟"有标签"那条路一样：计数按**本次运行累计**的欠账算，
         否则同一章跑两遍（第一遍截图没拍全、第二遍全填上）会出现账目自相矛盾。 */
      const missNow0 = quizStats.missed - missBefore0;
      const cumMiss0 = quizStats.missed;
      /* 【口径：这一行只讲这一章】以前传的是 found + (累计欠 - 本轮欠)，
         把**全局累计欠账**并进了每章的数字里 —— 结果 3.5 欠了一次之后，
         后面每章都显示"欠 2"（实测 23:18 那张表全是 5 3 2）。
         现在只传本章题数与本章欠账；累计数在下面的日志里另外说。 */
      tallyChapter(chapter, qrNoTab.found, missNow0);
      if (res0 === 'handled') { quizFilledKeys.add(chapter); chkSave(chapter, { quizFound: qrNoTab.found }); }   /* 填过了，别再填第二遍 */
      if (missNow0) console.log('[' + ts() + '] 本章《' + (chapter || '?') + '》' + qrNoTab.found + ' 道题，本轮欠 ' + missNow0 + ' 道（明细见 本次运行-没做的题.txt）');
      else if (cumMiss0 > 0) log('  ↳ 本轮全填上了（这一章本次运行累计欠 ' + cumMiss0 + ' 道，明细见 本次运行-没做的题.txt）。');
      if (quizCfg.stopAtQuiz) {
        log('按设置「测验停」，驱动器退出。');
        return 'stop';
      }
      return res0;
    }
    log('  ↳ 试着打开这一章的「章节测验」（' + op.where + ' 的 #dct2「' + op.text + '」）…');
    /* 切栏之后 cards 是整块重载的，题目要等它渲染出来。
       只等一次 3.2 秒不够（实测出现过"这个标签页里没找到题目"，
       可 40 秒后同样的题又在那儿了）—— 所以多探几轮再下结论。 */
    let qr = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await sleep(attempt === 1 ? 3200 : 5000);
      try { qr = await quizHelper.probe(ev); } catch (e) { qr = null; }
      if (qr && qr.found) break;
      if (attempt < 4) log('  ↳ 题目还没渲染出来（第 ' + attempt + ' 次没读到），再等一会…');
    }
    let result = 'none';
    let didFill = false, didNot = false;
    if (qr && qr.found) {
      log('  ↳ 找到了 ' + qr.found + ' 道题，交给答题助手。');
      quizSeen = (chapter || '') + '|' + qr.found;
      quizStats.chapters++;
      quizStats.found += qr.found;   /* 总账的"遇到题目"按探针数算，最准 */
      /* 记下这一章开始前的欠账数，好算出"本章欠了几道" */
      const missBefore = quizStats.missed;
      let lines = null;
      try {
        lines = await quizHelper.handle(chapter, qr, log);
        for (const l of lines) log(l);
      } catch (e) {
        log('  ↳ 答题助手出错：' + (e && e.message ? e.message : e));
      }
      result = 'handled';
      /* 【"交代过了"要按"真的填进去了"算，不能按"我试过了"算】
         答题助手会如实报"没能从模型那段答案里认出第几题选什么，所以没填" ——
         这种时候如果还当成 handled，驱动器会以为题做完了直接翻页，
         结果就是"题被跳过"，而且日志里明明写着没填。
         所以这里逐行看它的结论：只有真的填进去了才叫 handled；
         只开了页面但没填上，叫 'opened'（这一章还得惦记着）。 */
      for (const l of (lines || [])) {
        const s2 = String(l);
        if (s2.indexOf('已按顺序填进页面') >= 0) { didFill = true; }
        else if (s2.indexOf('没填上') >= 0 || s2.indexOf('没能从') >= 0 || s2.indexOf('所以没填') >= 0) { didNot = true; }
      }
      if (lines && !didFill && didNot) result = 'opened';
      /* 【保存没被确认 → 停在当前题页】
         必须在下面 tallyChapter / quizFilledKeys / BACK_CHAPTER **之前**判：
           · quizFilledKeys 一加，这一章就被当"本轮填过"，下一轮直接 skipped 翻页；
           · BACK_CHAPTER 会把测验栏切回去，草稿所在的题页当场没了。
         两件事都会把"没确认的草稿"变成"看起来做完了"。 */
      if (gateCheck('有测验标签那条路', !!lines) === 'stop-manual') return 'stop';
      /* 本章小结：写进"本次运行-题目计数.txt"（控制台只留一行），不混进播放日志。
         注意这里要用**本次运行累计**的欠账数（quizStats.missed），不能用"本轮新增"：
         同一章可能跑两遍（第一遍截图没拍全记了欠账，第二遍解答成功全填上），
         只按最后一轮算会出现"计数文件说欠 0、没做的题清单里却有 4 条"这种前后矛盾。 */
      const missThis = quizStats.missed - missBefore;
      const cumMiss = quizStats.missed;
      tallyChapter(chapter, qr.found, missThis);   /* 只报本章，别把累计并进来 */
      if (result === 'handled') { quizFilledKeys.add(chapter); chkSave(chapter, { quizFound: qr.found, verifiedResult: false }); }   /* 填过了，别再填第二遍 */
      if (missThis) {
        console.log('[' + ts() + '] 本章《' + (chapter || '?') + '》' + qr.found + ' 道题，本轮欠 ' + missThis +
                    ' 道（本次运行累计欠 ' + cumMiss + ' 道，明细见 本次运行-没做的题.txt）');
      } else if (cumMiss > 0) {
        log('  ↳ 本轮全填上了（这一章累计欠 ' + cumMiss + ' 道，明细见 本次运行-没做的题.txt）。');
      }
      if (quizCfg.stopAtQuiz) {
        log('按设置「测验停」，驱动器退出。做完自己提交，再回控制台点 1 继续往下跑。');
        return 'stop';
      }
    } else {
      log('  ↳ 这个标签页里没找到题目（任务点可能是文档或讨论）。' + tail);
    }
    /* 收尾：一定要切回"章节"栏，否则 cards 停在 num=1（那一栏没有视频卡），
       驱动器下一轮会判成"这一章没有视频"，然后原地打转。 */
    const back = await ev(BACK_CHAPTER);
    if (back && !back.ok) log('  ⚠ 测验栏没收干净：' + (back.why || '切不回章节栏'));
    await sleep(1500);
    return result;
  }

  /* 弹窗处理。返回 'none' / 'clicked' / 'stop' */
  let todoNotedFor = '';
  let quizTriedFor = '';   /* 每章只尝试打开一次测验，避免打转 */
  /* 答题进行中标记：tryQuiz 会 await 好几秒（切栏、截图、问模型、填答案），
     这段时间主循环不能同时动页面 —— 否则主循环会一边判定"这一章没内容"一边点「下一节」，
     等答题助手回头填答案时，题目控件已经被翻走了（实测：报"页面上共 0 题"，白填）。
     所以答测验期间，主循环只等，不点、不翻。 */
  let quizBusy = false;
  /* 【每章只认一次，认过就不再认 —— 跨"重回本章"也算】
     为什么需要这张总账：学习通是单页应用，翻节只换 iframe，**顶层文档不重载**，
     于是页面里的变量（比如 quizTriedFor）会跨章节、跨来回一直留着。
     后果：watchdog 刚拉起的那个驱动器认过一次这一章，紧接着换一个驱动器进来，
     就再也不认了 —— 表现就是"这一章的题一直没被碰过"。
     有了这张表，同一章在本次运行里只认一次，认完就记账，不管中间重进几次。
     没填上的仍然会记进待办，不会因为"认过了"就被当成做完了。 */
  const quizStampedChapters = new Set();
  /* 从检查点恢复、但还没经过页面复核的"认过了"章节 —— 第一次碰到时要先探一次页面 */
  const stampedFromDisk = new Set();

  /* ---------- 恢复上一轮（外套重启前）的检查点 ----------
     只有**同一个逻辑运行**（时间上够近、批次标识不同即上一次重启）才恢复。
     恢复的东西分两类，规矩不一样：
       · taskTriedCount（这一章点开过几次任务点）：纯防重复点击，恢复它不会跳过任何任务点，
         安全，直接恢复。
       · quizFilledKeys / quizStampedChapters（这一章本轮填过题）：一旦恢复就等于"跳过这一章"，
         所以**不能直接信** —— 全部塞进 filledFromDisk，第一次碰到这一章时
         由 verifyRestoredFilled() 拿页面现场复核（章节名 + 题数 + 平台是不是真的标记完成，
         还比课程号）。对不上就撤掉记录、重新走一遍。
     状态里只记这些去重账，不存任何凭据。 */
  function restoreCheckpoint() {
    if (!CHK || !checkpointMod) return;
    let from = null;
    try { from = checkpointMod.findRestorableBatch(__dirname, { currentBatch: CHECKPOINT_BATCH, maxAgeMs: 6 * 3600 * 1000 }); }
    catch (e) { return; }
    if (!from) return;
    const rec = checkpointMod && checkpointMod.readCheckpoint(from.file);
    if (!rec || !rec.chapters) return;
    let restoredFill = 0, restoredTask = 0;
    for (const ch of Object.keys(rec.chapters)) {
      const e = rec.chapters[ch] || {};
      /* 任务点点击次数：纯防重复点击，恢复它不会跳过任何任务点 —— 直接沿用 */
      if (e.taskTried) {
        if (taskTriedCount[ch] === undefined) taskTriedCount[ch] = Number(e.taskTried) || 0;
        restoredTask += 1;
      }
      /* "这一章本轮填过题"：一恢复就等于"跳过这一章"，所以只登记、不采信 ——
         第一次碰到这一章时必须过 verifyRestoredFilled() 的页面复核。 */
      if (e.quizFilled) { quizFilledKeys.add(ch); filledFromDisk.add(ch); restoredFill += 1; }
    }
    if (restoredFill) {
      log('（上一轮（批次 ' + from.batch + '，约 ' + Math.round(from.ageMs / 60000) + ' 分钟前）记下 ' +
          restoredFill + ' 章"本轮填过题"——**不当成已完成**，碰到那一章时会先拿页面现场复核一遍）');
    }
    if (restoredTask) log('（沿用上一轮的"点开过任务点"计数，避免重复点开）');
  }

  /* 关弹窗的死循环护栏：同一章连点 3 次关闭还没往前走，就断定关不掉，停下。
     否则会变成"点关闭 → 又弹 → 又点关闭"这样空转。 */
  let closeSpinFor = '';
  let closeSpin = 0;
  let popupStuckFor = '';   /* 同一章"点了没反应"的计数（按章重置） */
  let popupStuckN = 0;

  /* 【说记了就必须真的记】
     旧版有一段只打"这一章记进待办"的日志、却因为落在不可达代码里而从没调用 recordTodo ——
     日志说已记、文件里没有，是最坏的一种谎。这个函数把"打日志 + 落盘"绑在一起，
     并且按章去重（同一章不重复写行）。返回 true 表示这次真的写进去了。 */
  function noteTodoOnce(chapter, why) {
    const ch = chapter || '(读不到章节名)';
    if (todoChapters.has(ch)) {
      log('  （待办里已经有《' + ch + '》了，不重复写；原因：' + why + '）');
      return false;
    }
    todoChapters.add(ch);
    recordTodo(ch, why);
    log('  ↳ 已把《' + ch + '》记进 待办-未完成任务点.txt（原因：' + why + '）');
    return true;
  }
  /* 【这几个计数器必须声明在 restoreCheckpoint() 调用之前（2026-10-11 修）】
     restoreCheckpoint 是函数声明、会被提升，所以它写在下面没问题；
     但它要读写的 taskTriedCount / handledSpin / quizStampedChapters 是 **const/let**，
     声明在使用点之后就是暂时性死区（TDZ）——调用时直接抛
     "Cannot access 'taskTriedCount' before initialization"。
     实测（2026-10-11 15:53）：每次外套重启走到恢复这一步都必炸，
     于是"检查点恢复失败，本轮按全新开始" —— 已做过的章被整章重做，
     既费时间又更容易撞平台的重复提交检测。声明挪到调用点之前即可。 */
  const taskTriedCount = Object.create(null);
  const taskCapLogged = Object.create(null);
  const handledSpin = Object.create(null);
  /* quizStampedChapters 原本就声明在上面（2548 行附近），这里不再重复声明 */

  /* 恢复上一轮（外套重启前）的检查点。调用点放在这里：restoreCheckpoint 是函数声明
     （会被提升），而它要写的几个计数器现在已经在上面就绪了。 */
  try { restoreCheckpoint(); }
  catch (e) { log('（检查点恢复失败，本轮按全新开始：' + ((e && e.message) || e) + '）'); }
  /* ============================================================================
     保存闸门：三个 quizHelper.handle 入口 + 主循环开头都必须过这道闸门
     
     背景（真事故级）：handle 内部帮我们点了「暂时保存」，但**平台没证实存上了**。
     这时草稿很可能已经填在页面里，而下面这些动作都会把它弄丢：
       · 点「下一节」、切回「章节测验」栏   —— 页面被换掉
       · 主循环继续往下跑                  —— 下一步就是翻页
       · driver 退出、外套 15 秒后重拉      —— 页面被重新加载
     所以：一旦 blocksContinue，就**保留当前题页**（一个字都不动）、
     写 _内部\停止标记.txt 让外套别自动重拉、然后退出主驱动等人来处理。
     
     注意：这里还要用 saveAttempted 区分两种情况 ——
     这一章压根没走到保存那一步（没填过题）时，rejected/failed 那条
     "保守拦下"的前提不成立，不能因为一个空状态就把章节卡死。
     ========================================================================== */
  let gateStopLine = '';
  /* 停止标记的内容写什么，全部由纯函数决定（driver-save-gate.js 里有离线测试） */
  function writeSaveGateFlag(chapter, res) {
    const flag = (res && res.stop) || (saveGateMod && saveGateMod.makeStopFlag({ chapter: chapter, reason: '待人工确认保存' }))
      || { reason: '待人工确认保存', chapter: chapter, at: new Date().toISOString() };
    const text = saveGateMod ? saveGateMod.formatStopFlag(flag) : '需要人工确认保存：驱动器已停在当前题页。\r\n';
    try {
      fs.mkdirSync(path.dirname(STOP_FLAG_FILE), { recursive: true });
      fs.writeFileSync(STOP_FLAG_FILE, text, 'utf8');
      return { ok: true, file: STOP_FLAG_FILE };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /* 过闸门。返回 'continue' / 'stop-manual' / 'stop-quiz' */
  function gateCheck(where, saveAttempted) {
    if (!saveGateMod) return 'continue';   /* 模块没加载上：退回原来的行为，至少要说清楚 */
    const d = saveGateMod.decideAfterSave({
      save: quizHelper && typeof quizHelper.pendingSave === 'function' ? quizHelper.pendingSave() : null,
      chapter: lastChapter,
      stopAtQuiz: !!(quizCfg && quizCfg.stopAtQuiz),
      saveAttempted: saveAttempted !== false,
    });
    if (d.action === 'continue') return 'continue';
    if (d.action === 'stop-manual') {
      const w = writeSaveGateFlag(lastChapter, d);
      if (gateStopLine !== '') return 'stop-manual';
      gateStopLine = 'stop-manual';
      log('⚠ ' + d.reason);
      log('  ↳ 保留当前题页不动（' + where + '）：没有翻下一节、没有切栏目，也请外套不要自动重拉。');
      if (w.ok) log('  ↳ 已写 _内部\\停止标记.txt（外套看到它就不会 15 秒后自动重拉）。');
      else log('  ⚠ 停止标记没写成（' + w.error + '）—— 驱动器自己会退出，但外套可能 15 秒后重拉，请手动停止。');
      log('  ↳ 报告 本次运行-题目计数.txt / 本次运行-没做的题.txt 里已按"没做成"记了这一章，不会算成平台已完成。');
      return 'stop-manual';
    }
    /* stop-quiz：语义与原来完全一致（打印放在调用点，保持原来的措辞） */
    return 'stop-quiz';
  }

  async function handlePopup(chapter) {
    /* 弹窗是异步渲染出来的：PROBE 先看到文字，但按钮可能还没画上去。
       所以这里等一等、多试几次，别一上来就判死刑。 */
    /* 【点之前先把 chapterId 记下来】必须在这一刻读：
       下面验证用的 ev(PROBE) 是点击之后跑的，那会儿读到的已经是"点完"的值。 */
    const kidOf = async () => ev(`(function(){ var m = String(location.href).match(/[?&]chapterId=([^&]+)/); return m ? m[1] : ''; })()`);
    const beforeKid = await kidOf();
    /* 先用"在页面里点"的版本（绕开可见性/坐标那一整套），
       它失败再退回老的坐标版兜底。 */
    let done = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      done = await ev(POPUP_CLICK);
      if (done && done.ok) break;
      if (attempt < 3) await sleep(1200);
    }
    if (done && done.ok) {
      /* 护栏：点"关闭"只是在原地打转；同一章连关 3 次还没换章，就停下。
         点"下一节"是往前走，清零。 */
      if (done.label !== '下一节') {
        if (closeSpinFor !== chapter) { closeSpinFor = chapter; closeSpin = 0; }
        closeSpin++;
        if (closeSpin >= 3) {
          log('⚠ 同一章点了 ' + closeSpin + ' 次「' + done.label + '」还是没往前走 —— ' +
              '说明这个弹窗只能关、不能跳过。停下：要么你手动处理这一章，要么把「测验停」打开。');
          /* 停下之前**真的**记一笔待办：这一章的任务点没做完，用户得自己回头处理 */
          noteTodoOnce(chapter, '弹窗反复点「' + done.label + '」仍不往前走（' + closeSpin + ' 次）');
          return 'stop';
        }
      } else {
        closeSpinFor = ''; closeSpin = 0;
      }
      /* 【点了，但往前走成了吗？】
         判"有没有往前走"看两样，缺一不可：
           a) 弹窗消失了吗（blockPopup 变 null）
           b) 顶层地址里的 chapterId 变了吗
         注意**不能只看顶层那个章节名**：它会提前变（实测出现过"名字变了、
         地址和 cards 都还是老章节"），照名字判就会以为翻成功了，然后弹窗再冒一次。

         没走成怎么办 —— 这里对齐原始脚本的口径（它第 1670-1680 行）：
           `if (S.visited[sig] > 6) { forceNav[sig]++; if (forceNav[sig] >= 3) 才暂停 }`
         也就是**先反复强制往前走，攒够 3 轮还不走才停**，而不是点一两次就刹车。
         为什么必须这样：平台把任务点记成"完成"**有延迟**（实测 17.2：暂存之后
         pending 要过几秒才变 done），这段窗口里翻页会被 checkJob() 拦下。
         我在窗口里就刹停过一次 —— 其实再等一轮它自己就通了。 */
      const after = await ev(PROBE);
      const stillPopup = !!(after && after.blockPopup);
      const afterKid = (after && after.topKid) || '';
      const moved = !!(beforeKid && afterKid && beforeKid !== afterKid);
      if (stillPopup && !moved) {
        if (popupStuckFor !== chapter) { popupStuckFor = chapter; popupStuckN = 0; }
        popupStuckN++;
        if (popupStuckN >= 3) {
          log('⚠ 同一章已经连续 ' + popupStuckN + ' 轮点了「' + done.label + '」还是没往前走' +
              '（chapterId 还是 ' + (afterKid || beforeKid) + '）。');
          log('  这一章的翻页按钮可能无效，或者页面结构变了 —— 照原始脚本的口径，到这一步就停下让你看一眼。');
          log('  卡住的这一章：' + (chapter || '(读不到章节名)'));
          /* 同样是"停下之前先把待办真的写下来" */
          noteTodoOnce(chapter, '点了「' + done.label + '」' + popupStuckN + ' 轮仍未换章（翻页无效？）');
          return 'stop';
        }
        log('  ↳ 点了「' + done.label + '」但还没往前走（第 ' + popupStuckN + '/3 轮），再试一次…');
      } else {
        popupStuckFor = ''; popupStuckN = 0;
      }
      log('⚠ 弹窗：' + (done.label === '下一节' ? '点「下一节」往前走（这一章会被跳过并记到待办）' : ('点「' + done.label + '」关掉')) +
          '  ' + done.sel + '  onclick=' + done.onclick + (done.gone ? '（弹窗已消失）' : ''));
      await sleep(1500);
      return 'clicked';
    }
    /* 【页面内点击"成功"了但弹窗纹丝没动】—— 实测就是这样：
       弹窗上面盖着一层全屏遮罩（maskDiv jobFinishTip，1470x959 z-index 999），
       在页面里派发的事件它照样接得住，点了等于没点；
       而且弹窗里有些时刻压根没有「下一节」按钮（只剩 上一节 / 去学习）。

       这里**故意不做"强行往前走"的兜底**。查过了：这页的翻页函数是
         PCount.next(count, chapterId, courseId, clazzid, knowledgestr, checkType)
       只有当 `cur >= count` 时才真的去 POST /mycourse/changeCapter 换章；
       乱传参数的结果是**不换章、只把卡片切到测验栏**（实测就是这样，白折腾）。
       而且到了这个地步，平台已经把顶层的「下一节」按钮收成 0x0 ——
       它在明说"这一章的任务点没做完，不给你走"。
       硬绕过去就等于伪造进度，不干；老老实实把状态说清楚，**并真的记进待办**。

       【2026-10-11 清理：这一段后面原本还挂着 60 多行】
       旧版在这个 return 之后还有一整套"坐标兜底重试 → !FORCE 分支 → popupMiss 退避 →
       tryQuiz 前置 → recordTodo → clickTop"的代码，但上面那句 `return 'none';`
       是无条件的，**那些行一行都执行不到**（连带 popupMiss / popupMissAt 两个死变量）。
       最容易害人的是：读代码的人会以为「--force 仍然被尊重」「待办确实写了」，
       其实两条都不成立 —— 所以整段删掉，只留下面这一条真实路径。
       CONFIRM_POPUP 探针仍留在文件里（它只是"读页面"的探针，留着方便以后要用时接上），
       但当前**没有任何路径会用它**，不要以为它还在兜底。 */
    log('⚠ 弹窗：点了「' + ((done && done.label) || '?') + '」但弹窗没消失（页面内点击被遮罩接住了）。' +
        '这一章平台不肯放行（顶层「下一节」已被收成 0x0）。' +
        '按 --force 也不硬绕 —— 这一章记进待办，请看下面怎么处理。');
    /* 【"说记了"就必须真的记】旧版只打了上面那句日志，待办文件里一个字节都没写 ——
       日志声称已记、实际没记，是最坏的一种谎。所以这里真的落盘：
       这一章还有没做完的任务点，平台不让走，正好是要用户回头自己处理的那种。 */
    noteTodoOnce(chapter, '平台弹窗「还有任务点未完成」且页面内点击被遮罩接住（不硬绕）');
    if (NEXT) {
      advanceDead = true;   /* 别再反复撞同一面墙 */
      return 'stop';
    }
    return 'none';
  }

  /* 翻节：滚进视口 + 命中测试 + 等章节真的换掉 */
  let advanceFails = 0;
  let advanceDead = false;
  const advancedFrom = new Set();   /* 已经翻过去过的章节，用来识别打转 */
  let loopCount = 0;
  async function advance(reason) {
    const before = await ev(PROBE);
    const beforeChapter = (before && before.chapter) || '';
    let nb = await ev(SCROLL_NEXT);
    if (!nb || nb.none) {
      advanceFails++;
      if (advanceFails <= 2 || advanceFails % 10 === 0) {
        log('找不到「下一节」按钮（第 ' + advanceFails + ' 次）：' + (nb && nb.why ? nb.why : '拿不到按钮信息'));
      }
      if (advanceFails >= 3) {
        if (advanceFails % 5 === 0) log('  连着 ' + advanceFails + ' 次找不到「下一节」，不退出了，隔一会再找。');
        await sleep(8000);
        if (advanceFails >= 40) {
          log('连续 40 次找不到「下一节」—— 要么这一章真到头了，要么页面出问题了，停下。');
          advanceDead = true;
        }
      }
      return false;
    }
    if (nb.disabled) { log('「下一节」按钮是禁用状态（' + (nb.cls || '') + '），停下。'); advanceDead = true; return false; }

    log(reason + ' 点「下一节」@(' + nb.x + ',' + nb.y + ')  ' + nb.w + 'x' + nb.h + '  视口 ' + nb.vp.join('x') + '  命中检查通过');
    await clickTop(nb.x, nb.y);

    let popupClicks = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      /* 【答题期间绝不能再点「下一节」】
         实测踩坑：无穷小与无穷大 那一章，答题助手正在截图+抄录（要 60 秒上下），
         这个 advance 循环同时点了「下一节」，把章节翻走了 ——
         等答题助手回头填答案时，题目 DOM 已经不在了，报"页面上共 0 题"，白填。
         主循环有这个闸门（quizBusy），advance 这条循环以前漏了，现在补上：
         答题期间只等，不点、不翻；等它做完再继续。 */
      if (quizBusy) { i--; await sleep(1500); continue; }
      const now = await ev(PROBE);
      if (now && now.chapter && now.chapter !== beforeChapter) {
        log('已进入：' + now.chapter);
        markProgress('翻页成功 → ' + now.chapter);
        advanceFails = 0;
        if (advancedFrom.has(now.chapter)) {
          loopCount++;
          log('  ⚠ 这个章节之前已经翻过去过了（第 ' + loopCount + ' 次回到走过的章节）。');
          if (loopCount >= 3) {
            log('章节在来回打转，再走也没意义，停下。');
            advanceDead = true;
          }
        }
        advancedFrom.add(beforeChapter);
        /* 落一次检查点：外套重启之后"这一章已经翻过去过"也要认得出来，
           否则新进程会把同一章再翻一遍（打转护栏失效）。 */
        try { chkSave(now.chapter, { quizFound: 0 }); } catch (e) {}
        return true;
      }
      if (now && now.blockPopup) {
        popupClicks++;
        if (popupClicks === 3 || popupClicks === 8 || popupClicks === 15) {
          log('  这个弹窗第 ' + popupClicks + ' 次冒出来了（不退出了，接着点）。');
        }
        const r = await handlePopup(now.chapter || beforeChapter);
        if (r === 'stop') { advanceDead = true; return false; }
      }
      /* 实测：第一次点「下一节」往往不出弹窗，得点第二次才出。别干等 20 秒 */
      if ((i === 4 || i === 9) && popupClicks === 0) {
        const again = await ev(SCROLL_NEXT);
        if (again && !again.none && !again.disabled) {
          log('  还没动静，再点一次「下一节」…');
          await clickTop(again.x, again.y);
        }
      }
    }
    advanceFails++;
    if (advanceFails <= 2 || advanceFails % 5 === 0) log('点了「下一节」但章节 20 秒没换（第 ' + advanceFails + ' 次，不退出了）。');
    if (advanceFails >= 40) { log('连续 40 次翻节失败（约 13 分钟），停下。'); advanceDead = true; }
    return false;
  }

  const t0 = Date.now();
  /* 刚启动这段时间是宽限期：页面刚打开时三层 iframe 和按钮都还没渲染出来，
     这时候判断「没有视频 / 没有下一节」是错的，不能据此下结论。 */
  const START_AT = Date.now();
  const warmingUp = () => (Date.now() - START_AT) < 30000;
  let readyWaitLogged = false;
  let warmLogged = false;
  let evFails = 0;
  let autoSeen = -1;
  let autoQuizSeen = -1;
  let quizSeen = '';
  let lastReport = 0;
  let lastChapter = '';
  let lastCur = -1;
  let stuck = 0;
  let announcedStart = false;
  let announcedDone = false;
  let docLastPct = '';
  let docStuck = 0;
  let tabHealLoggedAt = 0;   /* 切不回"章节"栏时的报错去重时间戳 */
  let readyWaitSince = 0;    /* "等页面就绪"从什么时候开始等的（死线用） */
  let rebinds = 0;           /* 重连次数（防止无限重连） */
  let pendingWaitLogged = false; /* "有任务点但卡片没加载完，先等"的提示只打一次 */
  let pendingWaitSince = 0;      /* 这个等待从什么时候开始的（40 秒封顶） */
  /* 【这几个计数器已在上面（restoreCheckpoint 调用点之前）声明，别在这里重复声明】
     原因见那段注释：它们是 const/let，声明晚于使用点就是 TDZ 错误。 */
  /* 【每章点开过几次任务点（2026-10-08 多视频）】
     旧版油猴脚本 v2.6.1 那套 activateTaskPoint 的思路要保留 ——
     学习通的任务点不点开，<video>/文档根本不会进 DOM，光等只能等到超时。
     但原来这里是个 taskTriedFor、记章 ID，**一章只点开一次**，那就漏了
     一章挂两个视频卡的情形：点开第一个、播完、平台标记它完成，
     第二个卡片再也没人点过，它的 <video> 压根不进 DOM，
     "还有任务点没做完"恒为真，等够超时就翻页走人 —— 第二个视频被留在身后。
     现在换成计数器，上限按这一章的任务点总数给（至少 2、至多 8）。 */
  /* 每章"回头再探"的次数。为什么要它：2026/9/26 22:42 实测驱动器卡了 5 分钟以上、
     日志一字不写 —— 根因是某个分支里的 `continue` 不改变任何状态，条件永远成立，
     于是 1.5 秒空转一次、无穷无尽。加这个上限是最小改动；
     下面还有个"长期零推进"的总兜底，防止我以后再犯同类错。 */
  /* 【零推进兜底】只要连续 N 轮循环都没有发生"推进"（换章 / 视频前进 / 滚文档 / 点下一节），
     就说明有分支在空转 —— 直接报出来，并且强制尝试翻页，别让它无声地转下去。
     这一类 bug 的共同症状就是"进程活着、CPU 不动、日志不写"，最难查。 */
  let lastProgressAt = Date.now();
  let lastProgressWhat = '';
  const markProgress = (what) => { lastProgressAt = Date.now(); lastProgressWhat = what; };

  while (true) {
    if (MAX_SECONDS && (Date.now() - t0) / 1000 > MAX_SECONDS) { log('到达限时，退出。'); break; }

    /* 每轮先看连接还在不在。断了就重绑，别等 ev 超时三连。
       （实测 17:14:34 那次：连接断了 → 主循环僵住、日志不写、CPU 不动，谁也不管。） */
    await ensureConnection();

    const s = await ev(PROBE);
    if (!s || s.__err) {
      evFails++;
      /* 读不到不等于端口没了：先试着重绑一次，能救回来就继续 ——
         以前这里三连不成直接 break 退出，看起来就是"驱动器自己断了"。 */
      if (evFails === 1) {
        const note = await rebindTarget('页面读不到');
        log('  ↳ ' + note);
        await sleep(1500);
        continue;
      }
      if (evFails >= 3) {
        log('⚠ 连着 3 次读不到页面（已试过重连）：调试端口断了。');
        log('  Edge 被关掉或重启过，端口就跟着没了（端口只在启动那一刻开一次）。');
        log('  处理：重新双击 开始.cmd。若是同一次会话里端口还在，它会直接接着跑。');
        break;
      }
      log('读不到页面（第 ' + evFails + ' 次），再试…');
      await sleep(2000);
      continue;
    }
    evFails = 0;

    /* 【零推进兜底】连续 90 秒没有任何"真进展"，就说明有分支在空转 ——
       这一类 bug 的症状都一样：进程活着、CPU 不动、日志不写，事后极难查
       （2026/9/26 22:42 那次卡了 5 分钟以上，根因就是某个 continue 不推进状态）。
       这里主动喊出来，并强制走翻页，别让它无声地转。 */
    {
      const idleMs = Date.now() - lastProgressAt;
      if (idleMs > 90000) {
        log('⚠ 已经 ' + Math.round(idleMs / 1000) + ' 秒没有任何进展（最后一步：' +
            (lastProgressWhat || '刚开始') + '）—— 像是卡在某个等待里了。');
        log('  强制往下走一次：该翻页就翻页。');
        lastProgressAt = Date.now();
        lastProgressWhat = '强制推进';
        if (NEXT) { await advance('长时间零推进。'); if (advanceDead) break; }
        else await sleep(2000);
        continue;
      }
    }

    /* 页面还没搭好就先等，别急着下结论 */
    if (!s.hasFrame || s.ready !== 'complete') {
      if (!readyWaitLogged) {
        readyWaitLogged = true;
        readyWaitSince = Date.now();
        log('页面还在加载（readyState=' + s.ready + '，框架=' + (s.hasFrame ? '有' : '还没有') + '），等它就绪…');
      }
      /* 【这里以前没有出口，实测冻死过一次】
         12:35:17 崩在"框架=还没有"上，然后日志一个字节都不再写，CPU 也不再动 ——
         因为这一支只有 `continue`，把整个 while 里所有"等太久了怎么办"的判断全绕过去了。
         现在给它一个 45 秒的死线：到点就重新挑标签页、重连一次再试。
         典型成因就是"页面在脚下被换掉"（切课程 / 换标签 / 页面重载），
         那种情况下 CDP 还连在旧标签上，光重试求值是没用的。 */
      if (Date.now() - readyWaitSince > 45000) {
        log('⚠ 等了 ' + Math.round((Date.now() - readyWaitSince) / 1000) + ' 秒页面还没就绪' +
            '（readyState=' + s.ready + '，框架=' + (s.hasFrame ? '有' : '还没有') + '）。' +
            '多半是页面被换掉了 —— 重新挑一次标签页、重连再试。');
        const note = await rebindTarget('页面等不到就绪');
        log('  ↳ ' + note);
        readyWaitLogged = false;
        readyWaitSince = Date.now();
        rebinds++;
        if (rebinds >= 4) {
          log('⚠ 已经重连 ' + rebinds + ' 次还是等不到就绪。停下，你看一眼浏览器里那个页面是什么状态；' +
              '要接着跑就重新双击 开始.cmd。');
          /* 【2026-10-11 补】用户看不到页面时，只叫他"看一眼"是不够的 —— 他不知道该看什么。
             实测现场（错误报告的附带观察）：连着 8 轮都是"页面等不到就绪
             （readyState=complete，框架还没有）"。readyState 已经 complete 却读不到框架，
             基本就说明"那根本不是学习页"；而用户分不清这是没登录、登录态过期，
             还是停在别的标签页上 —— 因为窗口当时是隐藏的，他根本没法看。
             现在把三种常见情况和对应动作写清楚，并把最容易困惑的那一点说明白：
             助手用的 Edge 是**独立 profile**（--user-data-dir 指向 LOCALAPPDATA 下自己的
             目录），登录状态跟你平时那个 Edge 是分开的 —— 平时那个登录着不代表这个也登录了。 */
          log('   对着那个窗口看一眼，三种常见情况：');
          log('     ① 停在登录页 → 在那个窗口里登录一次（它的登录态是独立的，平时那个 Edge 的登录不算数）。');
          log('     ② 停在别的标签页上 → 把课程页那个标签点出来。');
          log('     ③ 登录态过期了 → 在那个窗口里重新登录，再重新双击 开始.cmd。');
          log('   判断依据是那个窗口的地址栏 —— 驱动器操作的正是那一个页面。');
          break;
        }
        await sleep(2000);
        continue;
      }
      await sleep(1500);
      continue;
    }
    if (readyWaitLogged) { readyWaitLogged = false; log('页面就绪了。'); }

    /* 答题助手正在答题（切栏、截图、问模型、填答案）—— 这段时间主循环只等，
       绝不点「下一节」也不翻页：一翻，题目控件就没了（实测"页面上共 0 题"就是这么来的）。 */
    if (quizBusy) { await sleep(1000); continue; }

    /* 卡片页要是停在"章节测验"那一栏（num=1），里面压根没有视频卡 —— 先切回"章节"。
       这一步不做的话，整章会在"没有视频 → 去开测验 → 又回到 num=1"里原地打转。
       只在 num=1 时才有动作，平时是一次很轻的读取。 */
    const heal = await ev(TAB_SELFHEAL);
    if (heal && heal.need) {
      if (heal.ok) {
        log('↩ 卡片页刚才停在「章节测验」栏（num=1，那一栏里没有视频卡），已切回「章节」栏。' +
            (heal.how ? '（' + heal.how + '）' : ''));
        if (typeof quizTriedFor !== 'undefined') quizTriedFor = '';   /* 换了栏，测验可以重新认一次 */
        await sleep(1200);
        continue;
      }
      if (Date.now() - tabHealLoggedAt > 20000) {
        tabHealLoggedAt = Date.now();
        log('⚠ 卡片页停在「章节测验」栏切不回去：' + (heal.why || '未知') +
            '   这一章的视频可能因此看不到。');
      }
    }

    if (s.chapter && s.chapter !== lastChapter) {
      log('──────── 章节：' + s.chapter + (lastChapter ? ('   （上一节：' + lastChapter + '）') : ''));
      lastChapter = s.chapter;
      markProgress('换章：' + s.chapter);
      /* 顺手把"现在跑的是哪门课"记下来 —— 下次启动要是同时开着两门课的学习页，
         就靠这个数字挑对标签（否则会挑回旧课，换课等于没换）。 */
      try {
        const cid = await ev(`(function(){ var m = String(location.href).match(/[?&]courseId=(\\d+)/i); return m ? m[1] : ''; })()`);
        if (cid && cid !== lastCourseId) { lastCourseId = cid; writeLastCourseId(cid); }
      } catch (e) {}
      announcedStart = false; announcedDone = false;
      stuck = 0; lastCur = -1; docLastPct = ''; docStuck = 0;
      /* 换章了，'还有任务点没做完'的等待要重新计时 —— 
         以前这个计时器跨章保留，上一章把 40 秒用光后，
         这一章一进来就直接判'等够了'、立刻翻页（实测：函数的求导法则 就这么又跳过去了）。 */
      pendingWaitSince = 0; pendingWaitLogged = false;
      /* 换章时重读一次答题助手的配置，这样跑着的时候改设置也能生效。
         重读之后必须把"记账"字段补回去 —— 否则新对象上没有 onUnanswered，
         换过章之后的题就不会记进"没做的题"清单了。 */
      quizCfg = attachQuizBookkeeping(quizMod.loadConfig());
      quizHelper = quizMod.makeHelper(quizCfg, quizDeps);
      quizSeen = '';
    } else if (!s.chapter && lastChapter === '') {
      lastChapter = '　';
    }

    /* 答题助手（默认开）。认出测验就把题干抠出来，mode>=2 时再问 AI。
       注意：绝不点提交；填进去的都是「暂时保存」的草稿。
       【先查"这一章本轮填过没有"再决定要不要探】
       probe 会递归扫所有文档层找 .TiMu，开销不小。而这章的题一旦填过，
       quizSeen 就再也不会被置位（去重条件里带了 !quizFilledKeys.has(...)），
       于是这个条件每轮都成立 —— 日志刷成每 2 秒一遍「已填过了」，白跑重活。
       实测（2026/9/26 16:07）就是这么刷的。所以把判断提到 probe 之前。 */
    if (quizHelper.mode > 0 && !quizFilledKeys.has(s.chapter || lastChapter)) {
      const q = await quizHelper.probe(ev);
      if (q) {
        const key = (s.chapter || '') + '|' + q.found;
        if (quizSeen !== key && !quizFilledKeys.has(s.chapter || lastChapter)) {
          quizSeen = key;
          /* 【这条路以前不记账，是个真 bug】
             实测（2026/9/26 15:45:48，《极限存在准则》）：题是在**这里**被填掉的 ——
             探针认出来就当场做了，可这里既不 quizStats.found++、也不 tallyChapter，
             更不往"没做的题"里写。等到视频播完 tryQuiz 再跑时，
             quizStampedChapters 里已经有这一章了，直接 skipped ——
             于是这一章的账**彻底没人记**，用户在"本次运行-题目计数.txt"里看到的是空白。
             现在按跟 tryQuiz 那条路一样的口径补上账。 */
          const missBefore = quizStats.missed;
          let lines = null;
          /* 【保存结论必须先过闸门，再谈记账】
             实测（2026/10/11，driver-save-gate.test.js 的接线用例当场抓出来）：
             原来闸门只放在 finally **之后** —— 而"记账"这几行全在 finally 里，
             于是保存没被确认时，quizFilledKeys.add / chkSave / tallyChapter
             已经先跑完了，最后那个 break 拦下的只是"后面不再动页面"。
             后果和注释里怕的正好一样：这一章被记成"本轮填过"，
             下一轮直接 skipped 翻页，用户根本没机会人工确认那份草稿。
             现在把闸门提到记账之前：先把结论断下来，确定要继续才记账。 */
          const gate = gateCheck('主循环里认出题那条路', true);
          try {
            lines = await quizHelper.handle(s.chapter || lastChapter, q, log);
            for (const l of lines) log(l);
          } catch (e) {
            log('  ↳ 答题助手出错：' + (e && e.message ? e.message : e));
          } finally {
            /* 放在 finally 里：handle 中途抛错时，noteMiss 可能已经记过欠账了，
               不能因为抛错就把这一章的账整个丢掉（那又变回"账目空白"）。
               但闸门拦下时**一个字都不记** —— 那正是它要拦的东西。 */
            if (gate === 'continue') {
              quizStats.chapters++;
              quizStats.found += q.found;
              if (lines) {
                quizFilledKeys.add(s.chapter || lastChapter);   /* 填过了，别再填第二遍 */
                chkSave(s.chapter || lastChapter, { quizFound: q.found });
              }
              const missNow = quizStats.missed - missBefore;
              const cumMiss = quizStats.missed;
              tallyChapter(s.chapter || lastChapter, q.found, missNow);   /* 只报本章 */
              if (missNow) {
                console.log('[' + ts() + '] 本章《' + (s.chapter || '?') + '》' + q.found + ' 道题，本轮欠 ' + missNow +
                            ' 道（本次运行累计欠 ' + cumMiss + ' 道，明细见 本次运行-没做的题.txt）');
              }
            }
          }
          /* 【保存没被确认 → 停在当前题页，立刻退出主驱动】
             记账已经在上面按闸门结论做完了；这里只负责退出主循环。 */
          if (gate === 'stop-manual') break;
          if (quizCfg.stopAtQuiz) {
            log('按设置「测验停」，驱动器退出。做完测验再双击 开始.cmd 继续。');
            break;
          }
        }
      }
    }

    /* 页面内自动续播钩子：每轮装一次（幂等）。新章节的播放器是新元素，会被重新挂上 */
    await ev(INSTALL_AUTORESUME);
    if (typeof s.autoOk === 'number' && s.autoOk !== autoSeen) {
      const delta = autoSeen < 0 ? 0 : s.autoOk - autoSeen;
      if (delta > 0) log('⚡ 页面内钩子自动续播 +' + delta + ' 次（暂停到恢复是毫秒级，不再等轮询）');
      autoSeen = s.autoOk;
    }
    if (typeof s.autoQuiz === 'number' && s.autoQuiz !== autoQuizSeen) {
      if (autoQuizSeen >= 0 && s.autoQuiz > autoQuizSeen) {
        log('⚠ 检测到弹题，页面内钩子拒绝自动续播（不替你把题跳过去）');
      }
      autoQuizSeen = s.autoQuiz;
    }

    /* 弹窗（不是翻节过程中弹出来的） */
    if (s.blockPopup) {
      const r = await handlePopup(s.chapter || lastChapter);
      if (r === 'stop') break;
      await sleep(1500);
      continue;
    }

    const v = s.video;

    /* ---- 伪心跳 60 倍速（--speed=N）----
       这里只推它一下，**不直接翻页**：进度报满后它会把播放位置推到片尾，
       下一轮 PROBE 就让下面那条「视频播完」分支成立，
       测验 → 文档 → 翻页的既有顺序原封不动地走完。
       （若在这里直接 advance，这一章的测验和文档任务会被一起跳过去。）
       另外注意：它需要播放器至少起播过一次 —— 真实上报是唯一能拿到
       URL 模板与 dtoken 的来源，凭空造不出来。 */
    if (v && hb.enabled && !hbStopped) {
      let r = null;
      try { r = await hb.tick(ev, s, v); }
      catch (e) {
        /* 出错绝不静默吞掉：伪心跳一旦自己挂了，这一节看起来就像"什么都没发生"，
           而日志里一个字节都没有 —— 那是最难查的一类故障。 */
        if (Date.now() - hbErrAt > 30000) {
          hbErrAt = Date.now();
          log('（伪心跳这一轮出错，已跳过：' + (e && e.message ? e.message : e) + '）');
        }
      }
      if (r && r.line && Date.now() - hbReportAt > 1500) { hbReportAt = Date.now(); log(r.line); }
      if (r && r.fatal) {
        hbStopped = true;
        log('  ↳ 伪心跳停了：这一节回到老实播放（想再试一次就重跑驱动器）。');
      }
      if (r && r.done) {
        markProgress('伪心跳报满 ' + Math.round(v.dur || 0) + 's');
        if (!hbDoneAt) {
          hbDoneAt = Date.now();
          /* 报是报满了，但平台一条明确回话都没有 —— 认没认谁也不知道。
             照旧按本节完成往下走，但**记账**：这一章的可能还欠着，
             回头自己核对一遍（不记账就等于悄悄伪造了完成标记）。 */
          if (r.uncertain) {
            const chk2 = s.chapter || lastChapter;
            if (!todoChapters.has(chk2)) {
              todoChapters.add(chk2);
              recordTodo(chk2, '伪心跳报满了，但平台没有明确回话（认没认要自己核对）');
            }
          }
        }
        /* 兜底：报满之后主循环本该靠"播放位置到片尾"自然走进完成分支。
           万一推位置没生效（duration 还没读到、播放器被换掉……），
           这里给 15 秒死线，到点直接按本节完成处理 —— 不然就是无声空转。 */
        if (Date.now() - hbDoneAt > 15000) {
          log('伪心跳报满后 15 秒仍未进入「播放完成」分支，直接按本节完成处理。');
          if (NEXT) { await advance('伪心跳已把进度报到片尾。'); if (advanceDead) break; }
          else await sleep(2000);
          continue;
        }
      } else {
        hbDoneAt = 0;
      }
    }

    /* ---- 没有视频：可能是文档阅读任务 ---- */
    if (!v) {
      const doc = await ev(DOC_STEP);
      if (doc && doc.type !== 'none') {
        if (doc.ended) {
          if (!announcedDone) { announcedDone = true; log('✅ 文档阅读到底了：' + doc.pct + '%   （' + doc.type + '）'); }
          if (NEXT) { await advance('文档读完了。'); if (advanceDead) break; }
          else await sleep(2000);
          continue;
        }
        if (doc.pct === docLastPct) { docStuck++; } else { docStuck = 0; docLastPct = doc.pct; markProgress('滚文档 ' + doc.pct + '%'); }
        if (docStuck >= 6) {
          log('⚠ 文档滚不动了（卡在 ' + doc.pct + '%，' + doc.type + '），不再干滚，先看这一章还有什么。');
          if (NEXT) { await advance('文档滚不动了。'); if (advanceDead) break; }
          else await sleep(3000);
          continue;
        }
        if (Date.now() - lastReport > 3000) {
          lastReport = Date.now();
          log('📄 文档阅读 ' + doc.pct + '%   ' + doc.cur + '/' + doc.max + '   （' + doc.type + '）');
        }
        await sleep(900);
        continue;
      }

      /* 既没视频也没文档 */
      if (warmingUp()) {
        /* 注意用独立的标志位：以前跟 readyWaitLogged 共用一个，
           两条消息会互相把对方的标志清掉，日志里刷成一串「刚起来/就绪了」来回跳。 */
        if (!warmLogged) {
          warmLogged = true;
          log('这一页没有视频也没有文档容器（测验页就是这样）。宽限期 30 秒内先不翻节，' +
              '让答题助手有机会把题目抠出来。');
        }
        await sleep(2000);
        continue;
      }
      /* 【别急着判"没内容" —— 这是"整个任务点被跳过"的根源】
         实测（用户报的"函数的求导法则 一进去就直接下一张"）：
         这一章**只有题目**（卡片页里只有一张 work 卡，没有视频卡、也没有文档卡），
         而这一段以前的行为是"探不到视频/文档 → 翻页"，
         里面唯一的动作 tryQuiz 在没有 #dct2 标签时立刻返回 ——
         题目**一次都没被碰过**就翻页了，用户看到的就是"直接跳过"。

         现在加一条硬闸门：**只要还有任务点没做完，就不许在这个分支翻页**。
         先给卡片加载留时间（任务点可能还在异步加载/渲染），
         时间用完仍然只有任务点、没有可播内容，就走"打开标签/答题助手"那条路去做它，
         做完再看任务点有没有清零；实在没辙才记待办并翻页。
         这样"只有题目"的章不会被白白跳过 —— 它会被当成一道要做的题来处理。 */
      const pendingTasks = (s.taskStats && s.taskStats.pending) ? s.taskStats.pending : 0;
      /* 兜底判据：章节列表里那个未完成数（jobUnfinishCount）。
         卡片页是异步加载的，有些时刻 .ans-attach-ct 还没渲染出来 → pending 读成 0，
         闸门就会漏过去（实测"函数的求导法则"就这么又跳过一次）。
         章节列表那个数字一直在线，所以两个信号取大的那个，谁大信谁。 */
      const catalogLeft = (typeof s.catalogUnfinish === 'number') ? s.catalogUnfinish : 0;
      const leftWork = Math.max(pendingTasks, catalogLeft);
      /* 本章这次的题已经交给答题助手做过一遍了（quizStampedChapters 里记着）——
         那就不再重复等待：草稿已存，任务点在平台上仍是"未完成"，
         再等下去只是空耗（实测填完后又白等了 40 秒）。 */
      const quizAlreadyHandled = quizStampedChapters.has(s.chapter || lastChapter);
      if (leftWork > 0 && !quizAlreadyHandled) {
        /* 【先主动把任务点点开一次 —— 旧版能跑、这版卡住的关键差别就在这】
           旧版 activateTaskPoint 的注释（照 nuaa 那份 pyc 里挖出来的日志）：
             学习通的任务点**不点开，内容（尤其是 <video>）根本不会出现在 DOM 里**。
             之前的版本只会"等"，于是永远等不到视频，最后被误判成文档跳过去。
           原来这里正是"只会等"：干等 40 秒 → 交给答题助手 → 翻页走人，
           而那张卡片压根没被激活过，里面的视频/文档自然一直不出现。
           现在每章先点开一次（坐标走可信通道），给它 1.8 秒加载，再重新 PROBE。 */
        const chNow = s.chapter || lastChapter;
        /* 【同一章允许点开多次（2026-10-08 多视频）】
           见 taskTriedCount 的注释：一章可能有多个视频卡，只点一次的话
           第二个卡片的内容永远不会进 DOM。上限按任务点总数给。 */
        const triedN = taskTriedCount[chNow] || 0;
        const triedCap = Math.min(8, Math.max(2, (s.taskStats && s.taskStats.total) || 2));
        if (triedN < triedCap) {
          taskTriedCount[chNow] = triedN + 1;
          chkSave(chNow, { quizFound: 0 });
          const act = await ev(ACTIVATE_TASK);
          if (act && act.ok && typeof act.x === 'number') {
            log('👆 点开任务点（' + act.tag + '）：' + act.label +
                '   未完成 ' + act.pending + '/' + act.total + ' 个' + (act.inView ? '' : '（在视口外，仍按坐标点一次）') +
                (triedN > 0 ? ('   本章第 ' + (triedN + 1) + ' 次点开') : ''));
            try { await clickTop(act.x, act.y); } catch (e) {}
            await sleep(1800);
            continue;   /* 让内容加载出来，下一轮 PROBE 重新判 */
          } else {
            log('· 这一章没能点开任务点：' + ((act && act.why) || '未返回结果'));
          }
        } else if (!taskCapLogged[chNow]) {
          taskCapLogged[chNow] = true;
          log('  · 这一章已经点开过 ' + triedN + ' 次任务点，不再重复点。');
        }
        /* 这一章还有没做完的任务点：先别翻页 */
        if (!pendingWaitSince) pendingWaitSince = Date.now();
        const waitedP = Date.now() - pendingWaitSince;
        if (waitedP < 40000) {
          if (!pendingWaitLogged) {
            pendingWaitLogged = true;
            const names = (s.taskStats && s.taskStats.pendingNames && s.taskStats.pendingNames.length)
              ? s.taskStats.pendingNames.join('、') : (catalogLeft + ' 个（从章节列表读到的）');
            log('这一章还有 ' + leftWork + ' 个任务点没做完（' + names +
                '），但没探到可播的视频/文档 —— 先不翻页，等卡片加载 + 交给答题助手处理。');
          }
          await sleep(2500);
          continue;
        }
        /* 等够了：交给答题助手去做这些任务点（它认得卡片页里的 work 卡） */
        if (pendingWaitLogged) {
          pendingWaitLogged = false;
          log('这一章只有任务点、没有可播内容，直接交给答题助手处理（' + leftWork + ' 个）。');
        }
        const qr2 = await tryQuiz(s.chapter || lastChapter, '（这一章只有任务点，没有可播内容。）');
        if (qr2 === 'stop') break;
        pendingWaitSince = 0;
        /* 【这一章的标识 —— 必须在 if 之前定义（2026-10-11 修）】
           10-07 那次把这个定义加在了 `if (qr2 === 'handled' || qr2 === 'done')` 的**里面**，
           于是 3316/3318 两处（todoChapters.has / add / recordTodo）仍然读的是作用域外的名字：
             · qr2 是 handled/done 时，if 内定义生效，看着一切正常；
             · qr2 是 skipped/none（题本轮已填过、或压根没题可读）时，if 被跳过 ——
               那个 const 从没执行过，执行到下面立刻抛 "chKey is not defined"，
               整个驱动器当场退出。实测（2026-10-11 15:53）日志只留一行"失败: chKey is not defined"，
               外套随后 15 秒重拉一次，看起来就像"莫名卡死/反复重启"。
           block 级 const 只在 block 里活着 —— 谁在 block 外用，就得在 block 外声明。 */
        const chKey = s.chapter || lastChapter;
        if (qr2 === 'handled' || qr2 === 'done') {
          /* 【这里以前是个死循环 —— 2026/9/26 22:42 实测卡了 5 分钟以上，日志一字不写】
             这句 `continue` 不改变任何状态：下一轮条件一模一样，于是每 1.5 秒空转一次，
             永远出不去（CPU 几乎不动 —— 时间都花在 sleep 上，看起来就像"卡死"）。
             成因是当天下午新加的 quizFilledKeys：已填过的章，
             tryQuiz 从"返回 skipped（然后往下走、翻页）"变成了"返回 handled（然后 continue）"，
             行为变了，这个循环就再也转不完。
             而且这一章的任务点在平台上永远不清零（只暂存、不提交），
             所以"回头再探一次看任务点清没清"这个期待本身也不成立。
             修法：同一章最多这样回头探 3 次，之后必须往下走（该翻页就翻页）。 */
          /* 【chKey 的作用域】（2026-10-11 二次修）
             它必须定义在下面这个 if **之前**（见上方注释）：下面 3326/3328 两处
             （todoChapters.has/add、recordTodo）在 if 外面用它，跳进 if 的只有
             handled/done 这条分支。这里不再重复声明。 */
          handledSpin[chKey] = (handledSpin[chKey] || 0) + 1;
          if (handledSpin[chKey] <= 3) {
            await sleep(1500);
            continue;
          }
          log('  ↳ 这一章已反复确认过 ' + handledSpin[chKey] + ' 次，不再回头探，往下走。');
        }
        /* 答题助手也没辙（没题可读/已做过）—— 记待办再翻页，绝不假装做完了 */
        if (!todoChapters.has(chKey)) {
          todoChapters.add(chKey);
          recordTodo(chKey, '这一章只有任务点、没有可播内容，答题助手没能处理');
        }
      }
      pendingWaitSince = 0;
      if (Date.now() - lastReport > 5000) {
        lastReport = Date.now();
        log('这一章没有可播的内容。' + (s.platformDone ? '平台已标记完成。' : ''));
      }
      if (NEXT) { await advance('本节没有可播的内容。'); if (advanceDead) break; }
      else await sleep(2000);
      continue;
    }

    /* ---- 视频播完了（或平台已把这一章标记完成）---- */
    const done = v.ended || (v.dur > 0 && v.cur >= v.dur - 1.5) || s.platformDone;
    if (done) {
      /* 【这里原来写了"等 40 秒让平台记账"，实测后撤掉了（2026-10-07）】
         理由是：滚文档那个循环每轮都会重新 PROBE，平台一旦把 .icon_Completed 写上，
         scrollDocThenContinue 开头的 `if (s.platformDone) return false` 自己就会收手 ——
         根本不需要专门干等。留着它只会给"确实没做完"的章节白加 40 秒。
         真正需要的是两件已经在做的事：
           ① markProgress('顺带滚文档 …')  —— 让零推进兜底看得见进展，不再 90 秒踢人；
           ② 开头那句 platformDone 短路   —— 免得对已完成的章白滚一整篇长文档。 */
      if (!announcedDone) {
        announcedDone = true;
        log('✅ 视频播完：' + hhmmss(v.cur) + ' / ' + hhmmss(v.dur) + (s.platformDone ? '（平台已把这一章标记完成）' : '') +
            (s.taskStats && s.taskStats.total ? ('   任务点 ' + s.taskStats.done + '/' + s.taskStats.total +
              (s.taskStats.pendingNames.length ? ('   还没做的：' + s.taskStats.pendingNames.join('、')) : '')) : '') +
            /* 平台自己的「学习步骤」标注：写 "2视频" 就是本节有两个视频 */
            (s.step && s.step.videoCount > 1 ? ('   本节标注 ' + s.step.videoCount + ' 个视频') : ''));
      }
      /* 【顺序很重要：先把这一章的测验交代掉，再做文档、再翻页】
         以前是"先滚文档 → 直接 advance 走人"，测验连打开都没打开过，题就被一起跳了。
         现在换成：测验（没做才做）→ 文档 → 翻页。
         而且测验这一整段走完之前，绝不碰「下一节」—— 一翻，题目控件就没了，
         答题助手回头填的时候只会得到"页面上共 0 题"。 */
      /* 滚这一章的文档任务。抽成一个小函数，是因为它有**两个**调用点：
         测验"填进去了"那条路以前是直接 continue 走人的 ——
         实测（2026/9/26，章节《极限存在准则》）这一章是"文档 + 视频 + 测验"三合一，
         测验一填上就 continue，下面那段滚文档永远轮不到，
         日志里 `📄 文档阅读` / `深层文档层` / `到底了` **一次都没出现**，
         可它照样打了「本节已完成」翻页 —— 文档任务点就这么被漏在身后了。
         现在两条路都会走到这里。 */
      const scrollDocThenContinue = async () => {
        /* 【整章已完成就别再滚文档了（2026-10-07 实测）】
           日志现场：`✅ 视频播完：--:-- / --:--（平台已把这一章标记完成）   任务点 0/2   还没做的：文档、视频`
           —— 前半句读的是目录标记（平台说这一章完成了），后半句是 iframe 里那份任务点统计，
           它读不到完成标记，在已完成章节里照样列成"还没做的：文档、视频"。
           原来这里不检查 platformDone，于是已完成章节的 19500px 文档照样从头滚一遍，
           每章白花约两分钟，窗口看着就像"卡住不动"。
           视频那条分支（done = v.ended || v.cur>=v.dur-1.5 || s.platformDone）早就短路了，
           文档这条漏了。目录标记说完成了就是完成了，直接往下走。 */
        if (s.platformDone) return false;
        const doc = await ev(DOC_STEP);
        if (doc && doc.type !== 'none' && !doc.ended) {
          /* 【滚动本身就是进展，必须上报（2026-10-07 实测）】
             漏了这一句，"零推进兜底"会把滚长文档当成卡死：
             实测 15:56:16 视频播完 → 开始滚一个 11659px 的文档（每步 400px，要 29 步）
             → 15:57:46 刚好 91 秒，兜底触发，强行翻页 —— 剩下的文档任务点被丢在身后。
             主循环里那条文档分支早就调了 markProgress，这一处漏了。 */
          markProgress('顺带滚文档 ' + doc.pct + '%');
          if (Date.now() - lastReport > 3000) {
            lastReport = Date.now();
            log('📄 视频完了，顺带滚这一章的文档 ' + doc.pct + '%   （' + doc.type + '）');
          }
          await sleep(900);
          return true;   /* 还有得滚：回去接着滚，别往下走 */
        }
        return false;
      };
      const quizRes = await tryQuiz(s.chapter || lastChapter, '');
      if (quizRes === 'stop') break;
      if (quizRes === 'handled') {
        await sleep(1200);
        await scrollDocThenContinue();   /* 有得滚就先滚（它自己会打进度），没得滚也不影响 */
        continue;   /* 回头重新探一次：测验做完后这一章的任务点状态可能变了 */
      }
      if (quizRes === 'opened') {
        /* 打开了、也交给答题助手了，但**没填上**（截图里没题、模型没抄出来…）。
           这种时候不能装作做完了 —— 但也不能死磕：这一章的任务点本来就还欠着，
           照旧往前走并记账，下次回来还能补。 */
        const key2 = 'quiz:' + (s.chapter || lastChapter);
        if (todoNotedFor !== key2) {
          todoNotedFor = key2;
          if (!todoChapters.has(s.chapter || lastChapter)) {
            todoChapters.add(s.chapter || lastChapter);
            recordTodo(s.chapter || lastChapter, '测验打开过但没填上（等你自己补）');
          }
        }
      }
      /* 【同一道闸门：还有活没干就别翻页】
         实测：函数的求导法则 是从**这条分支**跳过去的 ——
         视频已标记完成 + 视频探不到 + 章节列表里"未完成=1"，
         而 tryQuiz 只认 #dct2 标签、这一章没有那个标签，于是它返回 skipped，
         紧接着就 advance 走人，那张 work 卡（题目）一次都没被碰。
         现在这里加一道：还剩活没干、且答题助手这一轮没做成 → 先等一会再来一轮，
         等到上限还不行才翻页（并照旧记待办）。 */
      const leftWork2 = Math.max((s.taskStats && s.taskStats.pending) || 0,
                                (typeof s.catalogUnfinish === 'number') ? s.catalogUnfinish : 0);
      /* 【题本轮已经填过草稿的章，不要再等（2026-10-07 实测）】
         草稿是"不提交"的（这是设计底线），所以平台那一章的任务点永远不会变成已完成 ——
         "还剩 N 个任务点"这个条件对填过草稿的章恒为真，每轮白等 30 秒。
         这正是"函数极限能快速翻页、别的章要等好久"的分水岭：
         函数极限答题成功过，quizStampedChapters 里有它，第一道闸门就挡住了；
         而只填过草稿的章不在 quizStampedChapters 里，就掉进了这 30 秒。
         填过就算这一章该做的做完了，直接往下走。 */
      if (leftWork2 > 0 && !quizStampedChapters.has(s.chapter || lastChapter) &&
          !quizFilledKeys.has(s.chapter || lastChapter) &&
          quizRes !== 'handled' && quizRes !== 'done') {
        /* 【别光等 —— 先把下一个任务点打开（2026-10-08 多视频）】
           实测的坑：视频卡1播完 → done 成立 → 走到这里 → 纯等 30 秒 → 翻页。
           而这一章还有视频卡2，它从没被点开过，<video> 没进 DOM，
           chain 自然找不到 —— 于是"还剩 1 个任务点"空等一场，
           第二个视频被留在身后。这里先按坐标点开一个未完成的卡片
           （ACTIVATE_TASK 自己会跳过已完成、以及内容已播完的卡片），
           给它 1.8 秒加载，再回头重探。 */
        const chDone = s.chapter || lastChapter;
        const triedD = taskTriedCount[chDone] || 0;
        const capD = Math.min(8, Math.max(2, (s.taskStats && s.taskStats.total) || 2));
        if (triedD < capD) {
          taskTriedCount[chDone] = triedD + 1;
          chkSave(chDone, { quizFound: 0 });
          const actD = await ev(ACTIVATE_TASK);
          if (actD && actD.ok && typeof actD.x === 'number') {
            log('↻ 视频完了但这一章还有 ' + leftWork2 + ' 个任务点：点开下一个（' +
                actD.tag + '：' + actD.label + '）' +
                (s.step && s.step.videoCount > 1 ? ('   本节标注 ' + s.step.videoCount + ' 个视频') : ''));
            try { await clickTop(actD.x, actD.y); } catch (e) {}
            markProgress('点开下一个任务点');
            await sleep(1800);
            continue;   /* 回头重探：新卡片的内容这会儿才进 DOM */
          }
        }
        if (!pendingWaitSince) pendingWaitSince = Date.now();
        const waitedP2 = Date.now() - pendingWaitSince;
        if (waitedP2 < 30000) {
          if (!pendingWaitLogged) {
            pendingWaitLogged = true;
            log('这一章还剩 ' + leftWork2 + ' 个任务点没做完（测验标签也没找到），先不翻页，再试一轮。');
          }
          await sleep(2500);
          continue;
        }
        log('这一章剩 ' + leftWork2 + ' 个任务点、试了 ' + Math.round(waitedP2 / 1000) +
            ' 秒还是做不了，照旧翻页并记进待办。');
        pendingWaitLogged = false;
      }
      pendingWaitSince = 0;
      /* 同一章可能还有文档任务，接着把文档滚完（跟"测验填完了"那条路共用同一段） */
      if (await scrollDocThenContinue()) continue;
      if (NEXT) { await advance('本节已完成。'); if (advanceDead) break; continue; }
      await sleep(2000);
      continue;
    }

    /* ---- 暂停了，续播 ---- */
    if (v.paused) {
      if (!RUN) {
        if (Date.now() - lastReport > 3000) {
          lastReport = Date.now();
          log('（只观察）视频是暂停的。播放键=' + (v.bigPlay ? v.bigPlay.w + 'x' + v.bigPlay.h : 'null') +
              '  hasStarted=' + v.hasStarted + '  倍速=' + v.rate);
        }
        await sleep(2000);
        continue;
      }
      const playRes = await ev(TRY_PLAY);
      await sleep(600);   /* 有页面内钩子兜着，不用等太久 */
      const chk = await ev(PROBE);
      const c2 = chk && chk.video;
      if (c2 && !c2.paused && !c2.__err) {
        log('▶ 续播成功（倍速 ' + c2.rate + (playRes && playRes.didLoad ? '，本次靠 load() 把数据拉起来' : '') + '）');
        stuck = 0; lastCur = -1;
        continue;
      }
      /* 候选点击目标，按优先级排：大播放键 > 控件栏播放键 > 画面 > 播放器容器。
         只认"落在视口里"的坐标 —— PROBE 已经先把播放器滚回来了，这里再验一次，
         免得又把点击打在视口外（那等于什么都没点）。 */
      const inView = (o) => !!(o && o.x !== null && o.w > 4 &&
                               o.x > 1 && o.y > 1 && o.x < s.viewport[0] - 1 && o.y < s.viewport[1] - 1);
      const cands = [];
      if (c2) {
        if (c2.seesBigPlay && c2.bigPlay && c2.bigPlay.w > 4) cands.push(['大播放键', c2.bigPlay]);
        if (c2.seesPlayCtrl && c2.playCtrl && c2.playCtrl.w > 4) cands.push(['控件栏播放键', c2.playCtrl]);
        if (inView(c2.area) && c2.area.w > 20) cands.push(['画面', c2.area]);
        if (inView(c2.player) && c2.player.w > 20) cands.push(['播放器容器', c2.player]);
      }
      let clicked = false;
      for (const [what, t] of cands) {
        log('▶ 点「' + what + '」@(' + t.x + ',' + t.y + ')  ' + t.w + 'x' + t.h);
        await clickTop(t.x, t.y);
        await sleep(1200);
        const g = await ev(PROBE);
        const cv = g && g.video;
        if (cv && !cv.paused) {
          log('▶ 点「' + what + '」就播起来了（倍速 ' + cv.rate + '）');
          clicked = true; stuck = 0; lastCur = -1;
          break;
        }
        clicked = true;   /* 点是点下去了，只是没立刻起来，继续试下一个候选 */
      }
      if (!clicked) {
        /* 一个能点的都没找到 —— 把"为什么"说清楚，别只丢一句看不懂的话。
           v.paused=true 却连画面都没尺寸，通常是播放器还没渲染出来（loading），下一轮会好。 */
        log('找不到可点的播放键。  走的支路 ' + (v.where || '?') +
            '   播放器就绪度 inView=' + (c2 ? c2.videoInView : '?') +
            '   bigPlay=' + (c2 && c2.bigPlay ? c2.bigPlay.w + 'x' + c2.bigPlay.h + '@' + c2.bigPlay.x + ',' + c2.bigPlay.y + (c2.seesBigPlay ? '(视口内)' : '(视口外)') : 'null') +
            '   画面=' + (c2 && c2.area ? c2.area.w + 'x' + c2.area.h + '@' + c2.area.x + ',' + c2.area.y : 'null') +
            '   视口 ' + s.viewport.join('x'));
      }
      await sleep(1200);
      continue;
    }

    /* ---- 正在播 ---- */
    if (!announcedStart) {
      announcedStart = true;
      log('▶ 开始播放：' + (s.chapter || '') + '   总长 ' + hhmmss(v.dur) + '   倍速 ' + v.rate + '   静音 ' + v.muted);
    }
    if (Date.now() - lastReport > 4000) {
      lastReport = Date.now();
      const pct = v.dur > 0 ? (v.cur / v.dur * 100).toFixed(1) : '?';
      log('  ' + hhmmss(v.cur) + ' / ' + hhmmss(v.dur) + '   ' + pct + '%   倍速 ' + v.rate + '   rs=' + v.rs);
    }

    if (Math.abs(v.cur - lastCur) < 0.05) {
      stuck++;
      if (stuck >= 8) {
        log('⚠ 播放位置 8 秒没动（cur=' + v.cur + ' rs=' + v.rs + '），重新点一次播放键。');
        stuck = 0;
        const g = await ev(PROBE);
        const cv = g && g.video;
        if (cv && cv.seesBigPlay && cv.bigPlay && cv.bigPlay.w > 4) {
          log('⚠ 重新点一次播放键 @(' + cv.bigPlay.x + ',' + cv.bigPlay.y + ')');
          await clickTop(cv.bigPlay.x, cv.bigPlay.y);
        } else if (cv && cv.seesArea && cv.area && cv.area.w > 20) {
          log('⚠ 播放键不在视口里，改点画面 @(' + cv.area.x + ',' + cv.area.y + ')');
          await clickTop(cv.area.x, cv.area.y);
        }
      }
    } else { stuck = 0; }
    lastCur = v.cur;
    /* 视频在往前走 = 真进展（正在放视频的那十几分钟，日志每 4 秒一行，不算卡住） */
    if (v.cur > 0) markProgress('视频播放中 ' + Math.floor(v.cur) + 's');

    await sleep(1000);
  }

  /* ---------------- 收尾：题目总账写进单独文件 ----------------
     播放日志里只留一行"去哪儿看"，不把题目计数刷进来。 */
  writeQuizTotal();
  const filled = Math.max(0, quizStats.found - quizStats.missed);
  if (quizStats.found > 0 || missedList.length) {
    log('题目小结：遇到 ' + quizStats.found + ' 道，填上 ' + filled + ' 道，没做成 ' + quizStats.missed +
        ' 道　→　明细见 本次运行-题目计数.txt / 本次运行-没做的题.txt');
  } else if (quizHelper && quizHelper.mode > 0) {
    log('题目小结：这一趟没碰到题。');
  }
  if (hb.enabled) log(hb.summary());
  /* 收尾时把检查点落一次盘。注意：这一轮的账**不删** —— 用户"看见停了再点一次开始"
     会开一个新批次，那时自然用不上旧批次；但如果是外套重启，账还得在。
     过老的批次由启动时的 pruneCheckpoints 清掉，不会越堆越多。 */
  if (CHK) {
    try {
      const r = CHK.flush();
      if (!r.ok) log('（检查点最后一次写入失败：' + (r.reason || '未知') + '）');
    } catch (e) {}
  }
  log('驱动器结束。');
  normalFinish = true;   /* 告诉 exit 钩子：这是正常收尾，别报"半路退出" */
  stopKeepAwake();
  c.ws.close();
})().catch((e) => {
  caughtExit = true;   /* 已经报过错了，别让 exit 钩子再补一句"半路退出" */
  console.error('失败: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
