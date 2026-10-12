'use strict';

/* pickCoursePage 的挑标签逻辑 —— 补 Codex 那份传输层测试没覆盖的部分。
 *
 * 它那份 cdp-connection.test.js 把 connect() 的失败路径锁得很好，
 * 但 pickCoursePage 只测了"网络层"（超时/HTTP错/格式错/无效项过滤），
 * **一条挑标签的业务规则都没测**。而 driver.js 的注释里明明白白写着
 * 两次真实事故，正是靠下面这些规则兜住的：
 *
 *   ① detect.chaoxing.com/api/monitor_temp 也是 chaoxing，曾被误选，
 *      驱动器对着一个没有 #iframe 的页面读到超时，日志却报"驱动器断了"。
 *   ② 同时开两门课的学习页时，按列表第一个挑会挑回旧课，"换课等于没换"。
 *
 * 纯逻辑 + 假 fetch，不连浏览器、不读用户配置。
 *     node tests/pick-course-page.test.js
 */

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = readFileSync(join(__dirname, '..', 'driver.js'), 'utf8');
const start = source.indexOf('const CDP_TIMEOUT_MS =');
const end = source.indexOf('/* ---------------- 页面内探针', start);
assert.ok(start >= 0 && end > start, 'Transport source markers must exist');

function pageFor(url) {
  return { type: 'page', url, webSocketDebuggerUrl: 'ws://mock.invalid' };
}

function fixture(pages, lastCourseId = '') {
  const logs = [];
  const api = vm.runInNewContext(source.slice(start, end) + '\n({pickCoursePage})', {
    WebSocket: class {},
    AbortController,
    fetch: async () => ({ ok: true, json: async () => pages }),
    PORT: 9222,
    lastCourseId,
    log: (m) => logs.push(String(m)),
    setTimeout,
    clearTimeout,
  });
  return { api, logs };
}

test('只认 studentstudy：平台自己的检测页也是 chaoxing，绝不能被选中', async () => {
  const detect = pageFor('https://detect.chaoxing.com/api/monitor_temp?x=1');
  const study = pageFor('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=111&clazzid=2');
  const f = fixture([detect, study]);
  const { page, pages } = await f.api.pickCoursePage();
  assert.equal(page, study);
  assert.equal(pages.length, 2);
});

test('只有检测页、没有学习页时：直接报错，绝不拿检测页凑数', async () => {
  const detect = pageFor('https://detect.chaoxing.com/api/monitor_temp');
  const f = fixture([detect]);
  await assert.rejects(f.api.pickCoursePage(), /没找到学习通课程页/);
  /* 这里连课程页都没有，走的是最后那道 throw，不打"不拿它凑数"那句；
     那句只在"有课程页、可以自己开一个"时才打 —— 见下一个测试。 */
  assert.equal(f.logs.length, 0, '没页可用时不该假装有话说，直接报错就行');
});

test('有课程页但没有学习页时：说明为什么不拿检测页凑数', async () => {
  const detect = pageFor('https://detect.chaoxing.com/api/monitor_temp');
  const course = pageFor('https://mooc1.chaoxing.com/mycourse/index');
  const f = fixture([detect, course]);
  const { page } = await f.api.pickCoursePage();
  assert.equal(page, course, '要拿课程页自己开一个，而不是去读检测页');
  assert.ok(
    f.logs.some((l) => l.includes('不拿别的 chaoxing 标签凑数')),
    '必须留下理由 —— 否则下次还是会对着检测页查到超时，然后以为"驱动器又断了"'
  );
});

test('同时开两门课：按上次跑的 courseId 挑，而不是列表第一个', async () => {
  const oldCourse = pageFor('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=111');
  const newCourse = pageFor('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=222');
  const f = fixture([oldCourse, newCourse], '222');
  const { page } = await f.api.pickCoursePage();
  assert.equal(page, newCourse, '必须挑上次跑的那门；挑列表第一个等于换课没换');
});

test('courseId 匹配带数字边界：123 不能被 1234 骗走', async () => {
  const big = pageFor('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1234');
  const exact = pageFor('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=123');
  const f = fixture([big, exact], '123');
  const { page } = await f.api.pickCoursePage();
  assert.equal(page, exact, '正则里的 (?![0-9]) 就是防这个的，不能被删掉');
});

test('上次那门课不在列表里时：警告 + 把候选列出来 + 按第一个来', async () => {
  const a = pageFor('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=111');
  const b = pageFor('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=222');
  const f = fixture([a, b], '999');
  const { page } = await f.api.pickCoursePage();
  assert.equal(page, a, '挑不到就按第一个来（保持原行为）');
  assert.ok(f.logs.some((l) => l.includes('都不是上次那门课')), '必须警告');
  /* 每条候选 URL 是单独一行打出来的，所以分两次查 ——
     别写成"同一条日志里同时包含两个 id"，那样永远匹配不到。 */
  assert.ok(f.logs.some((l) => l.includes('courseId=111')), '要把候选 URL 列出来');
  assert.ok(f.logs.some((l) => l.includes('courseId=222')), '每个候选都要列，不能只列第一个');
});

test('lastCourseId 含正则元字符时静默退回，不能把整个挑选炸掉', async () => {
  const p = pageFor('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=111');
  const f = fixture([p], '1(2*');
  const { page } = await f.api.pickCoursePage();
  assert.equal(page, p, '非法 courseId 应该退回原规则，而不是抛异常');
});

test('devtools:// 与 http://data/ 不算页面', async () => {
  const junk1 = pageFor('devtools://devtools/bundled/inspector.html');
  const junk2 = pageFor('http://data/');
  const study = pageFor('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=5');
  const f = fixture([junk1, junk2, study]);
  const { page, pages } = await f.api.pickCoursePage();
  assert.equal(page, study);
  assert.equal(pages.length, 1, '两条垃圾项都要被滤掉');
});

test('退路：没有 studentstudy 但有 mycourse 页时用它，并说明这是退路', async () => {
  const course = pageFor('https://mooc1.chaoxing.com/mycourse/index');
  const f = fixture([course]);
  const { page } = await f.api.pickCoursePage();
  assert.equal(page, course);
  assert.ok(
    f.logs.some((l) => l.includes('改用课程页自己开一个')),
    '走退路要说明，免得以后把退路当正路'
  );
});
