#!/usr/bin/env node
/* 收口闸门-离线验算.js —— mediaHoldNeeded / holdForPendingMedia 的纯离线真值表
 *
 * 直接从 driver.js 源码里抠出 [ function onlyQuizLike … 收口闸门 END ] 这一段
 * （跟 pick-course-page.test.js 抠传输层用的是同一招），在 vm 里跑；
 * **绝不 require driver.js** —— require 会真的把驱动器跑起来，还会连浏览器。✗
 * 本脚本：不连浏览器、不读用户设置/课程/题库、不写任何用户文件。
 *
 * 用法：node tests\收口闸门-离线验算.js
 * 退出码：0 = 全部用例通过；1 = 有用例失败；2 = 抠不到源码（driver.js 被大改过）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DRIVER = path.join(__dirname, '..', 'driver.js');
const SRC = fs.readFileSync(DRIVER, 'utf8');
const START = 'function onlyQuizLike(s) {';
const END = '/* ---- 收口闸门 END';
const i = SRC.indexOf(START);
const j = i < 0 ? -1 : SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  console.error('✗ 抠不到源码区间（起点/终点标记没了）—— driver.js 被大改过？');
  process.exit(2);
}
const CODE = SRC.slice(i, j);

/* 每次加载都有独立的 holdRounds / holdCapLogged（新 vm 上下文）*/
function load(opts) {
  opts = opts || {};
  const logs = [];
  const todos = [];
  const waits = [];
  const todoSet = new Set(opts.todoSet || []);
  const sandbox = {
    process: { argv: opts.argv || [] },
    path: { join: (...a) => a.join('/') },
    __dirname: 'C:/x',
    fs: { existsSync: (p) => !!(opts.offFile && /收口关闭\.txt/.test(String(p))) },
    log: (m) => logs.push(String(m)),
    /* 【sleep 桩】holdForPendingMedia 现在是 async、轮次要隔 5 秒 ⇒
       沙箱里必须有 sleep；这里做成"立即返回"并把等待时长记下来（waits ✓），
       这样真值表既能瞬间跑完，又能断言"第 2 轮确实等了 ≈5 秒" ✓ */
    sleep: (ms) => { waits.push(Number(ms) || 0); return Promise.resolve(); },
    todoChapters: todoSet,
    recordTodo: (ch, how) => todos.push([ch, how]),
  };
  /* 【假时钟】（2026-10-15 晚加）：容错窗口用例要控制"过了多少毫秒"；
     只在用例显式给了 clock 时注入，其他用例保持运行时真 Date（行为与以前一致）✓ */
  if (opts.clock) sandbox.Date = opts.clock;
  const api = vm.runInNewContext(
    CODE + '\n({ mediaHoldNeeded: mediaHoldNeeded, holdForPendingMedia: holdForPendingMedia,' +
           ' holdGateDisabled: holdGateDisabled, holdRounds: holdRounds });',
    sandbox
  );
  return { api, logs, todos, todoSet, waits };
}

const stats = (o) => Object.assign({ total: 3, pending: 0, done: 3, pendingNames: [] }, o);
const sit = (o) => Object.assign({ chapter: '章A', taskStats: stats({}), catalogUnfinish: 0 }, o);

let pass = 0, fail = 0;
function check(name, want, got, extra) {
  const ok = want === got;
  if (ok) pass++; else fail++;
  console.log((ok ? '[OK] ' : '[X] ') + name + '  ⇒ ' + String(got) +
    (ok ? '' : '  （应为 ' + String(want) + '）' + (extra ? '   ' + extra : '')));
}
function has(name, needle, hay) {
  check(name, true, String(hay).includes(needle), '实际日志: ' + JSON.stringify(String(hay).slice(0, 120)));
}

((async () => {

/* ---------------- 一、mediaHoldNeeded 真值表 ---------------- */
console.log('== 一、mediaHoldNeeded（这一章要不要拦）==');
{
  const { api } = load();
  const M = api.mediaHoldNeeded;

  check('全是测验/作业 ⇒ 放行(false)', false, M(sit({ taskStats: stats({ pending: 2, done: 1, pendingNames: ['测验/作业', '测验/作业'] }) })));
  check('含文档 ⇒ 拦(true)', true, M(sit({ taskStats: stats({ pending: 1, done: 2, pendingNames: ['文档'] }) })));
  check('含视频 ⇒ 拦(true)', true, M(sit({ taskStats: stats({ pending: 1, done: 2, pendingNames: ['视频'] }) })));
  check('测验+视频混合 ⇒ 拦(true)', true, M(sit({ taskStats: stats({ pending: 2, done: 1, pendingNames: ['测验/作业', '视频'] }) })));
  check('名字读不出来 + pending>0 ⇒ 拦(true，保守)', true, M(sit({ taskStats: stats({ pending: 2, done: 1, pendingNames: [] }) })));
  check('名字读不出来 + pending=0 但目录未完成数=1 ⇒ 拦(true，保守)', true, M(sit({ catalogUnfinish: 1 })));
  check('全完成（pending=0、目录=0、名单空）⇒ 放行(false)', false, M(sit({})));
  check('全是作业/考试/讨论（不含"测验"字）⇒ 放行(false)', false, M(sit({ taskStats: stats({ pending: 3, pendingNames: ['作业', '考试', '讨论'] }) })));
  check('含音频（非测验/作业）⇒ 拦(true)', true, M(sit({ taskStats: stats({ pending: 1, pendingNames: ['音频'] }) })));
  check('含未知类型 ⇒ 拦(true)', true, M(sit({ taskStats: stats({ pending: 1, pendingNames: ['未知'] }) })));
  check('名字里有空串（读不出来那一项）⇒ 拦(true)', true, M(sit({ taskStats: stats({ pending: 2, pendingNames: ['测验/作业', ''] }) })));
  check('s=null ⇒ 放行(false，别崩)', false, M(null));
  check('catalogUnfinish=null（页面读不到）且名单空、pending=0 ⇒ 放行(false)', false, M(sit({ catalogUnfinish: null })));

  /* 【第二道尺子】平台标注的视频数 vs 页面视频卡完成数（2026-10-13 追加）*/
  const stepOf = (o) => Object.assign({ title: '', tabs: [], videoCount: 0, isQuiz: false }, o);
  check('平台标注 2 个视频、只完成 1 个（其余条件全满足）⇒ 拦(true)', true,
    M(sit({ step: stepOf({ videoCount: 2, videoCards: 2, videoDone: 1 }) })));
  check('平台标注 2 个视频、完成 2 个（其余条件全满足）⇒ 放行(false)', false,
    M(sit({ step: stepOf({ videoCount: 2, videoCards: 2, videoDone: 2 }) })));
  check('平台标注 2 个视频、页面上一个卡都没数出来 ⇒ 拦(true，保守)', true,
    M(sit({ step: stepOf({ videoCount: 2, videoCards: 0, videoDone: 0 }) })));
  check('平台标注 1 个视频（这条尺子不启用）⇒ 放行(false)', false,
    M(sit({ step: stepOf({ videoCount: 1, videoCards: 1, videoDone: 0 }) })));
  check('全测验 + 平台标注 2 个视频只完成 1 个 ⇒ 仍要拦(true，对账优先于"全测验放行")', true,
    M(sit({ step: stepOf({ videoCount: 2, videoCards: 2, videoDone: 1 }),
            taskStats: stats({ pending: 2, done: 1, pendingNames: ['测验/作业', '测验/作业'] }) })));
}

/* ---------------- 二、holdForPendingMedia 闸门行为 ---------------- */
console.log('');
console.log('== 二、holdForPendingMedia（拦页 + 计数 + 到上限记待办）==');
{
  const { api, logs, todos } = load();
  const s = sit({ taskStats: stats({ pending: 1, done: 2, pendingNames: ['视频'] }) });
  const rounds = [];
  for (let k = 0; k < 5; k++) rounds.push(await api.holdForPendingMedia(s, '真值表用'));
  check('同一章：前 3 轮全部拦下(true)', '[true,true,true]', JSON.stringify(rounds.slice(0, 3)));
  check('同一章：第 4 次放行(false)（到上限）', false, rounds[3]);
  has('第 1 轮日志含"第 1/3 轮"', '（第 1/3 轮，出口：真值表用）', logs[0]);
  has('第 1 轮日志含"先不翻页，回去把它点开 ✓"', '还有视频/文档类任务点没完成 ⇒ 先不翻页，回去把它点开 ✓', logs[0]);
  has('到上限日志含"到上限，先翻页，记待办"', '到上限，先翻页，记待办', logs.join('\n'));
  check('到上限时真的写了 1 条待办', 1, todos.length);
  check('到上限后再调用：不再重复记待办', 1, (await api.holdForPendingMedia(s, '真值表用'), todos.length));
  check('待办章节名正确', '章A', todos[0] && todos[0][0]);
  check('待办理由说清是收口闸门', true, /收口闸门/.test(String(todos[0] && todos[0][1])));

  /* 换章 = 计数独立（侧面对应"换章清零"）*/
  const s2 = sit({ chapter: '章B', taskStats: stats({ pending: 1, pendingNames: ['文档'] }) });
  await api.holdForPendingMedia(s2, '真值表用');
  has('章B 的第 1 轮日志是"第 1/3 轮"', '（第 1/3 轮，出口：真值表用）', logs[logs.length - 1]);
  check('章B 计数与章A 互不影响（章B=1、章A=3）', '1/3', api.holdRounds['章B'] + '/' + api.holdRounds['章A']);
}
{
  /* 【第二道尺子】拦截日志必须能看出对账过程（数字来自页面数据）*/
  const { api, logs } = load();
  const s3 = sit({ step: { videoCount: 2, videoCards: 2, videoDone: 1 } });
  await api.holdForPendingMedia(s3, '真值表用');
  has('拦截日志带对账过程："本节标注 2 个视频，已完成 1 个 ⇒ 先不翻页 ✓"',
      '本节标注 2 个视频，已完成 1 个 ⇒ 先不翻页 ✓', logs.join('\n'));
  has('对账行以"　↳ 对账："开头', '　↳ 对账：本节标注', logs.join('\n'));
}
{
  /* 全是测验/作业 ⇒ 一次都不许拦（否则死锁）*/
  const { api, logs, todos } = load();
  const s = sit({ taskStats: stats({ pending: 3, done: 0, pendingNames: ['测验/作业'] }) });
  let anyHeld = false;
  for (let k = 0; k < 10; k++) anyHeld = await api.holdForPendingMedia(s, '真值表用') || anyHeld;
  check('全是测验：连调 10 次全部放行(false)', false, anyHeld);
  check('全是测验：不拦、不打拦截日志', 0, logs.length);
  check('全是测验：不记待办', 0, todos.length);
}
{
  /* --no-hold：整道闸失效 */
  const { api, logs, todos } = load({ argv: ['--run', '--next', '--no-hold'] });
  const s = sit({ taskStats: stats({ pending: 1, pendingNames: ['视频'] }) });
  check('--no-hold：holdGateDisabled=true', true, api.holdGateDisabled());
  const r = [await api.holdForPendingMedia(s, '真值表用'), await api.holdForPendingMedia(s, '真值表用')];
  check('--no-hold：怎么调都放行', '[false,false]', JSON.stringify(r));
  check('--no-hold：不计数', 0, api.holdRounds['章A'] || 0);
  check('--no-hold：不打日志 / 不记待办', '0/0', logs.length + '/' + todos.length);
}
{
  /* 文件开关：_内部\收口关闭.txt 存在 ⇒ 同样失效 */
  const { api, logs, todos } = load({ offFile: true });
  const s = sit({ taskStats: stats({ pending: 1, pendingNames: ['视频'] }) });
  check('收口关闭.txt：holdGateDisabled=true', true, api.holdGateDisabled());
  check('收口关闭.txt：怎么调都放行', false, await api.holdForPendingMedia(s, '真值表用'));
  check('收口关闭.txt：不计数 / 不打日志 / 不记待办', '0/0/0', (api.holdRounds['章A'] || 0) + '/' + logs.length + '/' + todos.length);
  const off = load({ offFile: false });
  check('收口关闭.txt 不存在时闸门恢复（同一份源码）', true, await off.api.holdForPendingMedia(sit({ taskStats: stats({ pending: 1, pendingNames: ['视频'] }) }), '真值表用'));
}

console.log('');
console.log('== 三、接线：5 个内容型出口有闸门 / 强制推进出口没有（2026-10-13 更正）==');
{
  const gates = [
    ['伪心跳报满', "await advance('伪心跳已把进度报到片尾。')"],
    ['文档读完', "await advance('文档读完了。')"],
    ['文档滚不动', "await advance('文档滚不动了。')"],
    ['没有可播内容', "await advance('本节没有可播的内容。')"],
    ['本节已完成', "await advance('本节已完成。')"],
  ];
  for (const [name, mark] of gates) {
    const at = SRC.indexOf(mark);
    const before = at < 0 ? '' : SRC.slice(Math.max(0, at - 260), at);
    check('出口"' + name + '"：advance 之前有 holdForPendingMedia 闸门', true,
      at > 0 && /if \(NEXT && (await )?holdForPendingMedia\(s, /.test(before));
  }
  const zpAt = SRC.indexOf("await advance('长时间零推进。')");
  const zpBefore = zpAt < 0 ? 'X' : SRC.slice(Math.max(0, zpAt - 400), zpAt);
  check('强制推进出口：闸门区内无 holdForPendingMedia（保持原样，最后的保险）', false,
    /holdForPendingMedia/.test(zpBefore));
}

console.log('');
console.log('== 四、"在播"判定的容错窗口（2026-10-15 晚修：单次采样毛刺不算停）==');
{
  const clock = { t: 1000000 };
  const { api, logs } = load({ clock: { now: () => clock.t } });
  const s = sit({ taskStats: stats({ pending: 1, pendingNames: ['视频'] }) });
  const rounds = () => api.holdRounds['章A'] || 0;

  /* 首次看到在播：拦下、不记轮 */
  const r1 = await api.holdForPendingMedia(s, '真值表用', { playing: 1, cur: 100, dur: 700 });
  check('在播(首次)：拦下(true)、不消耗轮次', true, r1 === true && rounds() === 0);

  /* ★ 采样毛刺：读数持平 —— 旧版当场误判"没在动"并消费 1 轮；新版窗口内容忍 */
  clock.t += 2000;
  const r2 = await api.holdForPendingMedia(s, '真值表用', { playing: 1, cur: 100, dur: 700 });
  check('在播(毛刺:读数持平)：仍拦下、轮次不动（旧版会误消费 ✗）', true, r2 === true && rounds() === 0);
  has('毛刺有日志可查（说"没涨"就有证据）', '采样毛刺：视频读数没涨（100s→100s）', logs.join('\n'));

  /* 毛刺后恢复前进：继续拦 */
  clock.t += 2000;
  const r3 = await api.holdForPendingMedia(s, '真值表用', { playing: 1, cur: 108, dur: 700 });
  check('在播(毛刺后恢复前进)：继续拦下、轮次不动', true, r3 === true && rounds() === 0);

  /* 真卡住：超窗（>20 秒没涨）⇒ 落回轮次计数 */
  clock.t += 25000;
  const r4 = await api.holdForPendingMedia(s, '真值表用', { playing: 1, cur: 108, dur: 700 });
  check('卡住超窗(>20s 没涨)：落回轮次计数（第 1/3 轮）', true, r4 === true && rounds() === 1);

  /* 恢复前进 ⇒ 回到"不消耗轮次"，且预算回血清零（2026-10-15 晚三修：轮数只量"连续卡顿"） */
  clock.t += 1000;
  const r5 = await api.holdForPendingMedia(s, '真值表用', { playing: 1, cur: 200, dur: 700 });
  check('恢复前进：又回到"不消耗轮次"且预算清零', true, r5 === true && rounds() === 0);

  /* 明显回退（换卡/平台回拉）⇒ 当新基线，不误消费（同样回血） */
  clock.t += 1000;
  const r6 = await api.holdForPendingMedia(s, '真值表用', { playing: 1, cur: 100, dur: 700 });
  check('读数明显回退(200→100)：当新基线，不落回轮次', true, r6 === true && rounds() === 0);

  /* 没有在播的视频 ⇒ 照旧落回轮次计数（从第 1 轮重新起算） */
  clock.t += 1000;
  const r7 = await api.holdForPendingMedia(s, '真值表用', { playing: 0, cur: 100, dur: 700 });
  check('没有在播(playing=0)：照旧落回轮次计数（第 1/3 轮）', true, r7 === true && rounds() === 1);
}

console.log('');
console.log('== 五、"预算回血"（2026-10-15 晚三修 · 8.4 案例：轮数只量"连续卡顿"）==');
{
  const clock = { t: 1000000 };
  const { api, logs } = load({ clock: { now: () => clock.t } });
  const s = sit({ taskStats: stats({ pending: 1, pendingNames: ['视频'] }) });
  const R = () => api.holdRounds['章A'] || 0;

  /* 先攒两轮（没有在播视频 —— 相当于换卡/起播的毛刺期） */
  await api.holdForPendingMedia(s, '真值表用');
  clock.t += 6000;
  await api.holdForPendingMedia(s, '真值表用');
  check('毛刺期攒了 2 轮', 2, R());

  /* 视频开始播（且在涨）⇒ 拦下 + 预算清零 */
  clock.t += 6000;
  const rA = await api.holdForPendingMedia(s, '真值表用', { playing: 1, cur: 100, dur: 700 });
  check('在播 ⇒ 拦下', true, rA === true);
  check('在播 ⇒ 预算回血到 0（8.4 案例：每张卡播完都不该被前面毛刺吃掉预算）', 0, R());

  /* 再卡：从第 1 轮重新起算（不是直接吃满上限） */
  clock.t += 6000;
  await api.holdForPendingMedia(s, '真值表用');
  check('回血后再卡：从第 1/3 轮重新起算', 1, R());

  /* 回血后连卡 3 轮，照样到上限（防死锁不被削弱） */
  clock.t += 6000; await api.holdForPendingMedia(s, '真值表用');
  clock.t += 6000; await api.holdForPendingMedia(s, '真值表用');
  clock.t += 6000;
  const rCap = await api.holdForPendingMedia(s, '真值表用');
  check('回血后连卡 3 轮：照样到上限放行（防死锁还在）', true, rCap === false && R() === 3);
  has('上限日志还在', '本章已拦满', logs.join('\n'));
}

console.log('');
console.log('结果：通过 ' + pass + ' 项 · 失败 ' + fail + ' 项（共 ' + (pass + fail) + ' 项）');
process.exit(fail === 0 ? 0 : 1);

}))();
