#!/usr/bin/env node
/* driver-risk-guard.test.js —— "风控提防"三块纯逻辑的离线真值表
 *
 * 直接从 driver.js 源码里抠出 [ const CONTENT_BLIND_ALARM_MS … 风控提防 END ] 这一段
 * （跟 pick-course-page.test.js 抠传输层、收口闸门-离线验算.js 抠闸门是同一招），
 * 在 vm 里跑；**绝不 require driver.js** —— require 会真的把驱动器跑起来。✗
 * 本文件：不连浏览器、不读用户设置/课程/题库、不写任何文件。
 *
 * 覆盖（全部来自 10-14 两起风控事故（18:52 / 23:48）的证据链）：
 *   ① frameTreeSuspiciousUrls —— 从 CDP 帧树里找 antispider / processVerify 帧
 *   ② contentBlindStep       —— 内容框"可读→读不到"看门狗状态机
 *   ③ cardPullPlayingSkip / cardPullAdvanced —— 拉卡前"正在播就别拉" + 拉完"成没成"
 *   ④ 静态接线检查 —— 防"函数加了但没接线"（driver-save-gate.test.js 的同款手法）
 *
 * 用法：node tests\driver-risk-guard.test.js
 * 退出码：node --test 自己管（全过 0 / 有失败 1）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DRIVER = path.join(__dirname, '..', 'driver.js');
const SRC = fs.readFileSync(DRIVER, 'utf8');

const START = 'const CONTENT_BLIND_ALARM_MS';
const END = '/* ---- 风控提防 END';
const i = SRC.indexOf(START);
const j = i < 0 ? -1 : SRC.indexOf(END, i);
const CODE = (i >= 0 && j > i) ? SRC.slice(i, j) : '';

let api = null;
if (CODE) {
  api = vm.runInNewContext(
    CODE + '\n({ frameTreeSuspiciousUrls: frameTreeSuspiciousUrls, contentBlindStep: contentBlindStep,' +
    ' cardPullPlayingSkip: cardPullPlayingSkip, cardPullAdvanced: cardPullAdvanced,' +
    ' cardPullKey: cardPullKey,' +
    ' CONTENT_BLIND_ALARM_MS: CONTENT_BLIND_ALARM_MS, CARD_PULL_MAX_TRIES: CARD_PULL_MAX_TRIES });',
    {}
  );
}

/* ===========================================================================
 * 抠取自检
 * ========================================================================*/

test('抠源码：风控提防纯函数区必须还在（起点/终点标记都在）', () => {
  assert.ok(i >= 0, '起点标记找不到：const CONTENT_BLIND_ALARM_MS —— driver.js 被大改过？');
  assert.ok(j > i, '终点标记找不到：/* ---- 风控提防 END');
  assert.ok(api, 'vm 里加载失败（抠出来的代码跑不起来）');
});

/* ===========================================================================
 * ① 帧树判定（CDP 层找验证页 frame）
 * ========================================================================*/

test('① 帧树：antispider / processVerify（含深嵌套）命中；干净树不误伤；坏输入不抛错', () => {
  const F = api.frameTreeSuspiciousUrls;

  const clean = {
    frame: { id: 'X', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1' },
    childFrames: [
      { frame: { id: 'A', url: 'about:blank' } },
      { frame: { id: 'B', url: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1' },
        childFrames: [
          { frame: { id: 'C', url: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html?v=1' } },
          { frame: { id: 'D', url: 'https://pan-yz.chaoxing.com/screen/v2/file_x' } },
        ] },
    ],
  };
  assert.deepEqual(Array.from(F(clean)), []);

  /* ★ 事故真身（23:48 第二起）：验证页藏在**深层**，JS 层读它 contentDocument=null */
  const bad = {
    frame: { id: 'X', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1' },
    childFrames: [
      { frame: { id: 'A', url: 'about:blank' } },
      { frame: { id: 'B', url: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards' },
        childFrames: [
          { frame: { id: 'C', url: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html' } },
          { frame: { id: 'D', url: 'https://antispiderShowVerify.ac/challenge?x=1' },
            childFrames: [ { frame: { id: 'E', url: 'about:blank' } } ] },
        ] },
    ],
  };
  const hits = F(bad);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].indexOf('antispider') >= 0);

  assert.equal(F({ frame: { url: 'https://x.example/processVerify?t=1' } }).length, 1);

  /* 坏输入：不抛错、返回空 */
  for (const junk of [null, undefined, 0, 'x', {}, { frame: {} }, { frame: { url: null } }, { childFrames: 'x' }, { childFrames: [null, 7] }]) {
    assert.deepEqual(Array.from(F(junk)), []);
  }
});

/* ===========================================================================
 * ② 内容框看门狗状态机
 * ========================================================================*/

test('② 看门狗：持续读不到到点只报一次；恢复清零、再犯重新计时；可读/空壳/没就绪不算', () => {
  const N = api.CONTENT_BLIND_ALARM_MS;
  assert.ok(N > 0, 'CONTENT_BLIND_ALARM_MS 必须是正数');
  const st = { since: 0, alarmed: false };
  const ok = (extra) => Object.assign({ hasFrame: true, ready: 'complete', iframeRd: 'ok', d1Tasks: 5 }, extra);
  const blind = () => ({ hasFrame: true, ready: 'complete', iframeRd: 'unreadable', d1Tasks: 0 });

  let r = api.contentBlindStep(st, ok(), 1000);
  assert.equal(r.kind, 'ok');

  r = api.contentBlindStep(st, blind(), 2000);
  assert.equal(r.kind, 'counting');                 /* 开始计时 */

  r = api.contentBlindStep(st, blind(), 2000 + N - 1);
  assert.equal(r.kind, 'counting');                 /* 差 1ms 不报 */

  r = api.contentBlindStep(st, blind(), 2000 + N);
  assert.equal(r.kind, 'alarm');                    /* 到点报，且只报一次 */
  assert.equal(r.ms, N);

  r = api.contentBlindStep(st, blind(), 2000 + N + 5000);
  assert.equal(r.kind, 'alarmed');                  /* 不重复报 */

  r = api.contentBlindStep(st, ok(), 2000 + N + 6000);
  assert.equal(r.kind, 'recovered');                /* 恢复：给出刚才持续了多久 */
  assert.equal(r.ms, N + 6000);

  r = api.contentBlindStep(st, blind(), 90000);
  assert.equal(r.kind, 'counting');                 /* 再犯：重新计时 */
  r = api.contentBlindStep(st, ok(), 91000);
  assert.equal(r.kind, 'recovered');
  assert.equal(r.ms, 1000);

  /* 边界：不满足盲判据的都不算（读得到 / 空壳 / 没框架 / 没就绪 / s0 为空） */
  assert.equal(api.contentBlindStep({ since: 0, alarmed: false }, ok({ iframeRd: 'empty', d1Tasks: 0 }), 100).kind, 'ok');
  assert.equal(api.contentBlindStep({ since: 0, alarmed: false }, ok({ hasFrame: false, iframeRd: 'noframe', d1Tasks: -1 }), 100).kind, 'ok');
  assert.equal(api.contentBlindStep({ since: 0, alarmed: false }, ok({ ready: 'loading', iframeRd: 'unreadable', d1Tasks: -1 }), 100).kind, 'ok');
  assert.equal(api.contentBlindStep({ since: 0, alarmed: false }, null, 100).kind, 'ok');

  /* 兜底：iframeRd 字段缺失（老页面/降级）但 chain 整个下钻失败 ⇒ 仍算盲 */
  assert.equal(api.contentBlindStep({ since: 0, alarmed: false }, { hasFrame: true, ready: 'complete', d1Tasks: -1 }, 100).kind, 'counting');
});

/* ===========================================================================
 * ③ 拉卡判定（正在播就别拉 + 成没成）
 * ========================================================================*/

test('③a 拉卡判定：在播且涨 ⇒ 不拉（18:52 事故的正面修法）；没在播/0s/没涨 ⇒ 放行去拉', () => {
  const S = api.cardPullPlayingSkip;

  assert.equal(S(null, -1).skip, false);                          /* 探不到 ⇒ 放行（不拦） */
  assert.equal(S({ playing: 0, cur: 0 }, -1).skip, false);        /* 没在播 */
  assert.equal(S({ playing: 1, cur: 0 }, -1).skip, false);        /* "在播"但 0s ⇒ 不算 */
  assert.equal(S({ playing: 1, cur: 723.6 }, 721.8).skip, true);  /* ★ 事故里那个 723.6s 在涨 */
  assert.equal(S({ playing: 1, cur: 100 }, 100).skip, false);     /* 在播但没涨 ⇒ 去拉它重整 */
  assert.equal(S({ playing: 1, cur: 100 }, -1).skip, true);       /* 第一次看到 ⇒ 视为在涨（同收口口径） */

  assert.equal(S({ playing: 1, cur: 100 }, 98).lastCur, 100);     /* lastCur 无条件更新 */
  assert.equal(S({ playing: 0, cur: 0 }, 98).lastCur, -1);
  assert.equal(S({ playing: 1, cur: 100 }, 100).lastCur, 100);
});

test('③b 成没成：前进 >0.3s 才算"拉起来了"；事故里 0s→0s / 复探读不到 ⇒ 没拉动', () => {
  const A = api.cardPullAdvanced;

  assert.equal(A(0, 0), false);        /* ★ 事故：拉完还是 0s */
  assert.equal(A(0, 0.2), false);      /* 只挪 0.2s：不算 */
  assert.equal(A(0, 0.31), true);
  assert.equal(A(0, 2.5), true);       /* 正常拉起来了 */
  assert.equal(A(60, 62), true);       /* 已在播的卡复探在走 */
  assert.equal(A(-1, 1.0), true);      /* 拉之前读不到、拉完 1s：算 */
  assert.equal(A(0, -1), false);       /* 复探读不到：不算（不许假装 ✗） */
  assert.equal(A(5, 5), false);
  assert.equal(A(0, NaN), false);

  /* 阈值由 CARD_PULL_MAX_TRIES 管：连拉 3 次没动才记待办（这里只核对常量为 3） */
  assert.equal(api.CARD_PULL_MAX_TRIES, 3);
});

test('③c 分桶签名：章+卡序+卡名 三要素成键（学 nuaa"签里带页号，多卡片天然分桶"）', () => {
  const K = api.cardPullKey;

  /* 同三元组 ⇒ 同键（同一张卡才算同一个桶） */
  assert.equal(K('5.4 相关资料', 2, '第3讲-宋友文01.mp4'), K('5.4 相关资料', 2, '第3讲-宋友文01.mp4'));

  /* 三要素任一不同 ⇒ 不同键（换章/换卡序/换卡名都不混桶） */
  assert.notEqual(K('5.4 相关资料', 2, 'a.mp4'), K('2.1 某章', 2, 'a.mp4'));
  assert.notEqual(K('章A', 2, 'a.mp4'), K('章A', 3, 'a.mp4'));
  assert.notEqual(K('章A', 2, 'a.mp4'), K('章A', 2, 'b.mp4'));

  /* 空值不炸（读不到章节名/卡名时也要能记账） */
  assert.equal(K(null, null, null), '||');
  assert.equal(typeof K(undefined, undefined, undefined), 'string');
});

/* ===========================================================================
 * ④ 静态接线检查（防"只加了函数没接线"）
 * ========================================================================*/

test('④ 接线：driver.js 里三处都真的接上了（帧树 / 看门狗 / 拉卡闸门）', () => {
  assert.ok(SRC.includes("c.send('Page.getFrameTree', {})"), '帧树巡检必须走 CDP 的 Page.getFrameTree');
  assert.ok(SRC.includes('return await scanFrameTreeForVerify();'), '页面探针没命中时必须落到帧树巡检');
  const ftOccur = SRC.split('scanFrameTreeForVerify').length - 1;
  assert.ok(ftOccur >= 2, 'scanFrameTreeForVerify 应至少有定义+调用两处，实际 ' + ftOccur);

  assert.ok(SRC.includes('if (contentReadableWatch(s)) break;'), '主循环必须挂内容框看门狗（读不到到点就停）');
  assert.ok(SRC.includes('const contentBlindSt = { since: 0, alarmed: false };'), '看门狗状态必须初始化');
  assert.ok(SRC.includes('o.iframeRd = (function(){'), 'PROBE 必须直接读 #iframe 文档（防 chain 改道骗过看门狗）');

  /* 顺序断言：拉卡函数里，"正在播就别拉"的判定必须排在真拉之前 */
  const fnAt = SRC.indexOf('async function openFirstPendingVideoCard()');
  assert.ok(fnAt > 0, 'openFirstPendingVideoCard 必须还在');
  const body = SRC.slice(fnAt, fnAt + 3000);
  const guardAt = body.indexOf('cardPullPlayingSkip(vp, lastCardPullCur)');
  const pullAt = body.indexOf('await ev(PLAY_PENDING_VIDEO)');
  assert.ok(guardAt >= 0, '拉卡前必须过"正在播"判定');
  assert.ok(pullAt > guardAt, '判定必须在真拉之前（判定 @' + guardAt + '，真拉 @' + pullAt + '）');

  /* 记账接线：连拉失败要能落进待办（recordTodo 真的在拉卡函数里） */
  assert.ok(body.includes('recordTodo('), '连拉 3 次没动必须记待办（不能只打日志）');
  assert.ok(body.includes('cardPullAdvanced('), '拉完必须用 cardPullAdvanced 记成没成');
  assert.ok(body.includes('cardPullKey(lastChapter, r.idx, r.name)'), '拉卡记账必须用分桶签名（章|卡序|卡名）');
});

/* ===========================================================================
 * ⑤ 探针内联代码可编译（node --check 查不到模板字符串**内部**的语法错）
 * ========================================================================*/

test('⑤ 探针可编译：PROBE / BLOCKED_CHECK / PLAY_PENDING_VIDEO / VIDEO_PROGRESS 内联代码语法完好', () => {
  const CHAIN = '(void 0);';   /* PROBE 里 ${CHAIN} 的桩 */

  const grab = (name) => {
    const at = SRC.indexOf('const ' + name + ' = `');
    assert.ok(at >= 0, name + ' 模板必须还在');
    const from = at + ('const ' + name + ' = ').length;   /* 指到第一个反引号 */
    let end = -1;
    for (let k = from + 1; k < SRC.length; k++) {
      if (SRC[k] === '\\') { k++; continue; }             /* 跳过转义对 */
      if (SRC[k] === '`') { end = k; break; }
    }
    assert.ok(end > from, name + ' 的收尾反引号找不到');
    return SRC.slice(from, end + 1);
  };

  for (const name of ['PROBE', 'BLOCKED_CHECK', 'PLAY_PENDING_VIDEO', 'VIDEO_PROGRESS']) {
    const lit = grab(name);
    let code = '';
    assert.doesNotThrow(() => { code = eval(lit); }, name + ' 模板展开失败');
    assert.ok(typeof code === 'string' && code.length > 30, name + ' 展开后内容太短，疑似抠错');
    assert.doesNotThrow(() => { new Function(code); },
      name + ' 的内联代码有语法错（node --check 查不到它，只有运行时才炸 —— 就是这道检查要拦的）');
  }
});
