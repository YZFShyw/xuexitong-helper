/* quiz-state.test.js —— 离线验证 quiz-state.js 里那些"判断"
 *
 * 这些测试**不连浏览器、不连网络、不读任何真实配置或题库**，
 * 只喂事实、看结论。全部用虚构数据。
 *
 * 跑法：
 *   C:\Users\TestUser\DeepSeekHarness\node\node.exe --test tests\quiz-state.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const QS = require(path.join(__dirname, '..', 'quiz-state.js'));

/* ============================================================================
 * 一、保存结果的状态机
 * ==========================================================================*/

test('只有"已确认保存"才算成功；保存中/未确认绝不能算', () => {
  assert.equal(QS.isSaveConfirmed(QS.SAVE.SAVED), true);
  for (const s of [QS.SAVE.SAVING, QS.SAVE.UNCONFIRMED, QS.SAVE.REJECTED, QS.SAVE.FAILED, '', undefined, null]) {
    assert.equal(QS.isSaveConfirmed(s), false, String(s) + ' 不能算保存成功');
  }
  assert.equal(QS.needsSaveConfirmation(QS.SAVE.SAVED), false);
  assert.equal(QS.needsSaveConfirmation(QS.SAVE.SAVING), true);
  assert.equal(QS.needsSaveConfirmation(QS.SAVE.UNCONFIRMED), true);
  assert.equal(QS.needsSaveConfirmation(QS.SAVE.REJECTED), false);
  assert.equal(QS.needsSaveConfirmation(QS.SAVE.FAILED), false);
});

test('除"已确认保存"以外，一律不允许自动接着做"会丢草稿"的动作', () => {
  assert.equal(QS.blocksAutoContinue(QS.SAVE.UNCONFIRMED), true);
  assert.equal(QS.blocksAutoContinue(QS.SAVE.SAVING), true);
  assert.equal(QS.blocksAutoContinue(QS.SAVE.SAVED), false);
  /* 【这一条以前写反了】原来认为"拒绝/失败时本来就没写过页面，继续不会更糟"。
     但 saveDraftResult 是在**答案已经填进页面之后**才调的：按钮被闸门拒绝、
     或者保存请求失败，都只说明"没存成"，页面上那份答案还在 —— 翻页就丢了。 */
  assert.equal(QS.blocksAutoContinue(QS.SAVE.REJECTED), true, '已拒绝：答案可能已经填在页面上，不许自动离开');
  assert.equal(QS.blocksAutoContinue(QS.SAVE.FAILED), true, '失败：同上，填进去的答案还在页面上');
  /* 未知状态（空串 / 以后新增却忘了登记的状态）同样保守拦住，绝不误当成功放行 */
  assert.equal(QS.blocksAutoContinue(''), true, '状态不明时保守拦住');
  assert.equal(QS.blocksAutoContinue('brand_new_status'), true, '没登记过的新状态也一律拦住');
});

test('结构化结果字段齐、msg 是给人看的一句话，且未确认时明确要人核对', () => {
  const ok = QS.makeSaveResult(QS.SAVE.SAVED, '已点「暂时保存」，页面出现「保存成功」', { reason: 'toast_saved' });
  assert.equal(ok.status, 'saved');
  assert.equal(ok.ok, true);
  assert.equal(ok.confirmed, true);
  assert.equal(ok.needConfirm, false);
  assert.match(ok.msg, /暂存草稿/);

  const bad = QS.makeSaveResult(QS.SAVE.UNCONFIRMED, '已点「暂时保存」，但没看到平台的保存成功提示', { reason: 'no_proof' });
  assert.equal(bad.status, 'unconfirmed');
  assert.equal(bad.ok, false);
  assert.equal(bad.needConfirm, true);
  assert.equal(bad.blocksContinue, true);
  assert.match(bad.msg, /自己看一眼|核对/, '未确认时必须提示人回页面核对');
  assert.doesNotMatch(bad.msg, /已保存(?!成功提示)/);
});

/* ============================================================================
 * 二、"这个按钮能不能点"
 * ==========================================================================*/

test('提交类按钮一律拒绝（文字 / class / onclick 三种都要挡住）', () => {
  assert.equal(QS.classifySaveButton({ text: '提交' }).action, 'reject');
  assert.equal(QS.classifySaveButton({ text: '交卷' }).action, 'reject');
  assert.equal(QS.classifySaveButton({ text: '暂时保存', className: 'btnSubmit workBtnIndex' }).action, 'reject');
  assert.equal(QS.classifySaveButton({ text: '', onclick: 'btnBlueSubmit();' }).action, 'reject');
  assert.equal(QS.classifySaveButton({ text: '', onclick: 'submitValidate()' }).action, 'reject');
  assert.equal(QS.classifySaveButton({ text: '', onclick: 'submitWork()' }).action, 'reject');
});

test('平台的"暂时保存"按钮照样认得出来（noSubmit 里含 submit，不能被误杀）', () => {
  /* 页面上真实的样子：<a class="btnSave workBtnIndex" onclick="noSubmit();">暂时保存</a> */
  const r = QS.classifySaveButton({ text: '暂时保存', className: 'btnSave workBtnIndex', onclick: 'noSubmit();' });
  assert.equal(r.action, 'accept', '正常的暂时保存按钮必须还能用，不能因为名字里有 submit 就删掉这个能力');
  assert.equal(QS.classifySaveButton({ text: '保存', onclick: 'saveWork();' }).action, 'accept');
  assert.equal(QS.classifySaveButton({ text: '暂存', className: 'btnSave' }).action, 'accept');
});

test('既不像保存也不像提交的，不碰', () => {
  assert.equal(QS.classifySaveButton({ text: '下一节', onclick: 'next()' }).action, 'skip');
});

/* ============================================================================
 * 三、兜底直调页面函数之前的只读复核
 * ==========================================================================*/

test('兜底直调：名字不在白名单 → 证不实，不给成功证据', () => {
  const r = QS.inspectDirectSaveSource({ name: 'btnBlueSubmit', source: 'function btnBlueSubmit(){}' });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.why, /白名单/);
});

test('兜底直调：白名单名字但源码里有提交行为 → 拒绝', () => {
  const r = QS.inspectDirectSaveSource({
    name: 'saveWork',
    source: 'function saveWork(){ document.forms[0].submit(); }'
  });
  assert.equal(r.verdict, 'submit-risk');
  assert.match(r.why, /提交行为/);

  const r2 = QS.inspectDirectSaveSource({ name: 'noSubmit', source: 'function noSubmit(){ submitValidate(); }' });
  assert.equal(r2.verdict, 'submit-risk');
});

test('兜底直调：白名单名字 + 源码读不到 → 不给成功证据', () => {
  const r = QS.inspectDirectSaveSource({ name: 'noSubmit', source: null });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.why, /源码读不到/);
});

test('兜底直调：白名单名字且源码干净 → 允许（保留既有的 noSubmit/saveWork 兼容能力）', () => {
  const r = QS.inspectDirectSaveSource({
    name: 'noSubmit',
    source: 'function noSubmit(){ $.post("/work/save", {data: ans}); }'
  });
  assert.equal(r.verdict, 'ok', '没有提交行为的已知保存函数要能继续用');
  const r2 = QS.inspectDirectSaveSource({ name: 'saveWork', source: 'function saveWork(){ saveDraftAjax(); }' });
  assert.equal(r2.verdict, 'ok');
});

/* ============================================================================
 * 四、保存成功/失败提示的判定
 * ==========================================================================*/

test('新增的"保存成功"才作证；页面上一次遗留的那句不算', () => {
  const before = '……作答区…… 保存成功';
  const base = QS.toastBaseline(before);
  assert.ok(base.includes('保存成功'), '基线里应该记下那句老提示');

  /* 点完保存，页面文字没变化 —— 还是那句老提示 → 不算证据 */
  const r1 = QS.classifyToastNow(before, base);
  assert.equal(r1.kind, 'none');
  assert.equal(r1.stale, '保存成功', '要能指出这是老提示，便于查日志');

  /* 点完之后真的多了一句 → 才算 */
  const r2 = QS.classifyToastNow(before, []);
  assert.equal(r2.kind, 'saved');
  assert.match(r2.hit, /保存成功/);
});

test('失败提示优先于成功提示，并且也只在"新出现"时算数', () => {
  const base = ['保存成功'];
  const r = QS.classifyToastNow('保存成功 保存失败', base);
  assert.equal(r.kind, 'failed');
  assert.match(r.hit, /保存失败/);
  /* 老的成功提示 + 这次什么都没出现 → 什么都没判出来（不能算成功） */
  assert.equal(QS.classifyToastNow('保存成功', base).kind, 'none');
});

test('按钮文字只能说明"正在保存"，永远不能当成保存成功', () => {
  assert.equal(QS.classifyButtonText('暂时保存'), 'idle');
  assert.equal(QS.classifyButtonText('保存中…'), 'saving');
  assert.equal(QS.classifyButtonText('正在暂存...'), 'saving');
  assert.equal(QS.classifyButtonText(''), 'gone');
  assert.equal(QS.classifyButtonText('别的字'), 'other');
  /* 这条是重点：没有哪个按钮文字能推出"已保存" */
  for (const t of ['暂时保存', '保存中…', '正在暂存', '保存成功', '已保存']) {
    assert.notEqual(QS.classifyButtonText(t), 'saved');
  }
});

/* ============================================================================
 * 五、题目指纹
 * ==========================================================================*/

const fp = QS.makeFingerprinter();

test('指纹：题干前 80 字相同、选项数相同的两道题，指纹必须不同', () => {
  const head = '下列说法正确的是_____';
  assert.equal([...head].length < 80, true);
  const a = { type: '单选', stem: head, options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }] };
  const b = { type: '单选', stem: head, options: [{ letter: 'A', text: '丙' }, { letter: 'B', text: '丁' }] };
  assert.notEqual(fp.fpOf(a), fp.fpOf(b), '选项内容不同就必须是不同的题');
});

test('指纹：前 80 字之后的正文不同，指纹也必须不同', () => {
  const long = '关于这个问题，下面的说法中哪一个是正确的（请仔细阅读）';
  const a = { type: '单选', stem: long + '甲的表述', options: [{ letter: 'A', text: 'x' }] };
  const b = { type: '单选', stem: long + '乙的表述', options: [{ letter: 'A', text: 'x' }] };
  assert.notEqual(fp.fpOf(a), fp.fpOf(b), '不能只取前 80 字');
});

test('指纹：题型不同算不同的题（同一题干在单选/多选下答案不一样）', () => {
  const q = { stem: '下面哪些是对的', options: [{ letter: 'A', text: '甲' }] };
  assert.notEqual(fp.fpOf(Object.assign({ type: '单选' }, q)), fp.fpOf(Object.assign({ type: '多选' }, q)));
});

test('指纹：空白与全角半角差异不影响同一道题的判定', () => {
  const a = { type: '单选', stem: '下列  说法 正确的是', options: [{ letter: 'a', text: '甲 乙' }] };
  const b = { type: '单选', stem: '下列说法正确的是', options: [{ letter: 'A', text: '甲乙' }] };
  assert.equal(fp.fpOf(a), fp.fpOf(b), '同一道题的排版差异不该变成两道题');
});

test('指纹：先解码再算 —— 替身字换代后同一道题指纹不变', () => {
  /* 模拟字体反爬：页面上存的是替身字，解码表能把它们换回真字 */
  const fakeMap = { '庘': '从', '庝': '法' };
  const decode = (s) => String(s).replace(/[庘庝]/g, (c) => fakeMap[c] || c);
  const f2 = QS.makeFingerprinter({ decode });
  const obfQ = { type: '单选', stem: '庘庝律上人人平等', options: [{ letter: 'A', text: '庘庝是对的' }] };
  const realQ = { type: '单选', stem: '从法律上人人平等', options: [{ letter: 'A', text: '从法是对的' }] };
  assert.equal(f2.fpOf(obfQ), f2.fpOf(realQ), '解码前后必须是同一个指纹');
});

test('指纹摘要带题型和选项数，出问题时能拿去核对', () => {
  const d = fp.digestOf({ type: '判断', stem: '这句话对吗', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }] });
  assert.match(d, /判断/);
  assert.match(d, /选项2个/);
});

/* ============================================================================
 * 六、模型答案缓存
 * ==========================================================================*/

const CFG_A = { model: 'model-a', visionModel: 'vision-a' };
const CFG_B = { model: 'model-b', visionModel: 'vision-a' };

test('缓存命中要求：指纹 + 题型 + 模型配置 三条都一致', () => {
  let c = QS.emptyAnswerCache();
  c = QS.cachePut(c, 'FP1', '单选', 'B', '理由', CFG_A);
  assert.ok(QS.cacheGet(c, 'FP1', '单选', CFG_A), '三条一致就该命中');
  assert.equal(QS.cacheGet(c, 'FP1', '多选', CFG_A), null, '题型不一致不能命中');
  assert.equal(QS.cacheGet(c, 'FP2', '单选', CFG_A), null, '指纹不一致不能命中');
  assert.equal(QS.cacheGet(c, 'FP1', '单选', CFG_B), null, '用户换了模型，老答案必须失效');
});

test('缓存文件坏了/版本不对 → 当成空缓存，绝不"当成命中"', () => {
  assert.deepEqual(QS.parseAnswerCache('').entries, {});
  assert.deepEqual(QS.parseAnswerCache('{这不是 JSON').entries, {});
  assert.deepEqual(QS.parseAnswerCache(JSON.stringify({ version: 1, entries: { X: { fp: 'X', answer: 'A' } } })).entries,
    {}, '版本号变了要作废');
  /* 键和指纹对不上的一律丢掉 */
  const bad = JSON.stringify({ version: QS.ANSWER_CACHE_VERSION, entries: { X: { fp: 'Y', answer: 'A', type: '单选', model: 'm' } } });
  assert.deepEqual(QS.parseAnswerCache(bad).entries, {});
});

test('缓存序列化后能读回来，且**只**有答案相关内容（没有凭据字段）', () => {
  let c = QS.emptyAnswerCache();
  /* 故意往配置里塞一个 key，确认它不会被写进缓存 */
  const cfgWithKey = { model: 'm', visionModel: 'v', apiKey: 'sk-should-never-be-cached' };
  c = QS.cachePut(c, 'FP9', '判断', '对', '理由', cfgWithKey);
  const text = QS.serializeAnswerCache(c);
  assert.doesNotMatch(text, /sk-should-never-be-cached/, '缓存文件里绝不能出现 key');
  assert.doesNotMatch(text, /apiKey/i);
  const back = QS.parseAnswerCache(text);
  assert.ok(QS.cacheGet(back, 'FP9', '判断', cfgWithKey));
  assert.equal(QS.cacheGet(back, 'FP9', '判断', cfgWithKey).answer, '对');
});

test('缓存的模型签名只跟模型名有关，跟 key 无关', () => {
  assert.equal(QS.modelSignature({ model: 'm', visionModel: 'v', apiKey: 'k1' }),
    QS.modelSignature({ model: 'm', visionModel: 'v', apiKey: 'k2' }));
  assert.notEqual(QS.modelSignature({ model: 'm', visionModel: 'v' }),
    QS.modelSignature({ model: 'm', visionModel: 'v2' }));
});

/* ============================================================================
 * 七、用量汇总
 * ==========================================================================*/

test('用量按步累加，缺 usage 的那些只记"这次没有"，不猜数字', () => {
  const u = QS.emptyUsage();
  QS.addUsage(u, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  QS.addUsage(u, null);
  QS.addUsage(u, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  assert.equal(u.calls, 3);
  assert.equal(u.withUsage, 2);
  assert.equal(u.prompt, 101);
  assert.equal(u.completion, 22);
  assert.equal(u.total, 123);
  const line = QS.formatUsage(u);
  assert.match(line, /本章模型用量/);
  assert.match(line, /101/);
  assert.match(line, /1 次接口没给 usage/);
  /* 只报实测 token 数，不许出现任何"费用/价格"字样 */
  assert.doesNotMatch(line, /费用|价格|元|美元|\$/);
  assert.match(QS.formatUsage(QS.emptyUsage()), /没有调用模型/);
});
