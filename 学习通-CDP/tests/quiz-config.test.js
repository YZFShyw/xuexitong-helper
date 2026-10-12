/* quiz-config.test.js —— 离线验证"配置怎么写才安全"
 *
 * 【铁规矩：这个测试只碰临时目录】
 *   全程把 quiz.CFG_FILE 指到 os.tmpdir() 下的一个假文件，
 *   **绝不读写工作区里的 答题设置.json**（那里面有真实 key）。
 *   用的配置内容也全是虚构的（key 一律写成 假key-不准是真key）。
 *
 * 跑法：
 *   C:\Users\TestUser\DeepSeekHarness\node\node.exe --test --test-isolation=none tests\quiz-config.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const quiz = require(path.join(__dirname, '..', '答题助手.js'));

const REAL_CFG = quiz.CFG_FILE;

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-cfg-test-'));
}
function tmpCfgFile(dir) {
  return path.join(dir, 'fake-答题设置.json');
}

/* 每个用例自己建临时目录、自己清，互不影响 */
function withTmp(fn) {
  const dir = mkTmpDir();
  const file = tmpCfgFile(dir);
  quiz.CFG_FILE = file;
  try {
    return fn({ dir, file });
  } finally {
    quiz.CFG_FILE = REAL_CFG;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

test('临时目录要干净：这次测试绝不碰真的 答题设置.json', () => {
  withTmp(({ file }) => {
    assert.notEqual(file, REAL_CFG);
    assert.equal(fs.existsSync(file), false, '临时目录里本来不该有这个文件');
  });
  assert.equal(quiz.CFG_FILE, REAL_CFG, '用完必须把路径还回去');
});

test('正常写：落盘内容正确，并且**原子写**留下的只有目标文件（没有临时垃圾）', () => {
  withTmp(({ dir, file }) => {
    const r = quiz.saveConfig({ mode: 2, apiKey: '假key-不准是真key', model: 'fake-model' });
    assert.equal(r.ok, true);
    assert.equal(r.file, file);
    assert.ok(fs.existsSync(file));
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(j.mode, 2);
    assert.equal(j.model, 'fake-model');

    /* 目录里只该有目标文件（第一次写没有上一份，所以还没有 .bak） */
    const names = fs.readdirSync(dir);
    assert.deepEqual(names, [path.basename(file)], '临时文件必须已经 rename 掉，不能留垃圾：' + names.join(','));
  });
});

test('第二次写会备份上一份（.bak 里是上一次的内容）', () => {
  withTmp(({ dir, file }) => {
    quiz.saveConfig({ mode: 1, model: 'first' });
    const r2 = quiz.saveConfig({ mode: 2, model: 'second' });
    assert.equal(r2.backup, file + '.bak');
    const bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    assert.equal(bak.model, 'first', '.bak 必须是**上一份**，不是刚写的那份');
    const now = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(now.model, 'second');
    /* 还是不能有临时文件残留 */
    const junk = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(junk, [], '不能留下临时文件：' + junk.join(','));
  });
});

test('原文件是坏 JSON 时**拒绝写**，一个字节都不动（API key 不能被抹掉）', () => {
  withTmp(({ file }) => {
    const broken = '{ "mode": 2, "apiKey": "假key-不准是真key", "model": ';
    fs.writeFileSync(file, broken, 'utf8');
    assert.throws(() => quiz.saveConfig({ mode: 0, apiKey: '', model: 'default-ish' }),
      (e) => e && e.code === 'ECFGCORRUPT' && /API key/.test(e.message));
    assert.equal(fs.readFileSync(file, 'utf8'), broken, '坏文件的内容必须原封不动');
  });
});

test('原文件是空文件时同样拒写', () => {
  withTmp(({ file }) => {
    fs.writeFileSync(file, '   \r\n', 'utf8');
    assert.throws(() => quiz.saveConfig({ mode: 1 }), (e) => e && e.code === 'ECFGCORRUPT');
    assert.equal(fs.readFileSync(file, 'utf8'), '   \r\n');
  });
});

test('原文件不是 JSON 对象（数组/字符串）也拒写', () => {
  withTmp(({ file }) => {
    fs.writeFileSync(file, '[1,2,3]', 'utf8');
    assert.throws(() => quiz.saveConfig({ mode: 1 }), (e) => e && e.code === 'ECFGCORRUPT');
    fs.writeFileSync(file, '"hello"', 'utf8');
    assert.throws(() => quiz.saveConfig({ mode: 1 }), (e) => e && e.code === 'ECFGCORRUPT');
  });
});

test('loadConfig 遇到坏文件：返回值照旧是默认配置（driver.js 依赖这条），但原因要能问出来', () => {
  withTmp(({ file }) => {
    fs.writeFileSync(file, '{ 坏掉的', 'utf8');
    const cfg = quiz.loadConfig();                 /* 这一步不许抛 */
    assert.equal(cfg.mode, quiz.DEFAULT_CFG.mode);
    const why = quiz.lastConfigError();
    assert.ok(why, '必须留下"为什么"');
    assert.match(why, /不是合法 JSON/);
    assert.match(why, /没有动原文件|没写/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ 坏掉的', '读一次也不许改文件');
  });
});

test('配置文件不存在时：默认值 + 没有错误提示 + 可以正常创建', () => {
  withTmp(({ file }) => {
    const cfg = quiz.loadConfig();
    assert.equal(cfg.mode, quiz.DEFAULT_CFG.mode);
    assert.equal(quiz.lastConfigError(), '');
    const r = quiz.saveConfig({ mode: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.backup, '', '第一次创建没有"上一份"，不该硬造一个备份');
    assert.ok(fs.existsSync(file));
  });
});

test('读完一份好文件之后，lastConfigError 必须被清掉（不能留上一轮的）', () => {
  withTmp(({ file }) => {
    fs.writeFileSync(file, '{ 坏掉的', 'utf8');
    quiz.loadConfig();
    assert.ok(quiz.lastConfigError());
    fs.writeFileSync(file, JSON.stringify({ mode: 1 }), 'utf8');
    const cfg = quiz.loadConfig();
    assert.equal(cfg.mode, 1);
    assert.equal(quiz.lastConfigError(), '', '读到好文件后不能还留着老错误');
  });
});

test('BOM 不影响读：PowerShell 写出来的带 BOM 的 JSON 照样能读', () => {
  withTmp(({ file }) => {
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ mode: 2, model: 'fake' }), 'utf8');
    const cfg = quiz.loadConfig();
    assert.equal(cfg.mode, 2);
    assert.equal(quiz.lastConfigError(), '');
  });
});

test('写失败时只清自己的临时文件，不碰目录里别的东西', () => {
  withTmp(({ dir, file }) => {
    /* 造一个"看起来像我们的临时文件、但不是这一次建的"文件 */
    const other = path.join(dir, 'fake-答题设置.json.tmp-999-deadbeef');
    fs.writeFileSync(other, '别的进程的临时文件', 'utf8');
    const otherFile = path.join(dir, '别人的文件.txt');
    fs.writeFileSync(otherFile, '别动我', 'utf8');

    /* 让 rename 失败：把目标路径做成一个**非空目录** */
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'x'), 'y', 'utf8');
    assert.throws(() => quiz.saveConfig({ mode: 1 }));

    assert.ok(fs.existsSync(other), '不能删别人的临时文件');
    assert.equal(fs.readFileSync(other, 'utf8'), '别的进程的临时文件');
    assert.ok(fs.existsSync(otherFile), '不能删无关文件');
    const junk = fs.readdirSync(dir).filter((n) => /\.tmp-\d+-[0-9a-f]+$/.test(n) && n !== path.basename(other));
    assert.deepEqual(junk, [], '自己的临时文件必须清掉：' + junk.join(','));
  });
});

test('configBackupInfo 只在真有备份时才给东西', () => {
  withTmp(({ file }) => {
    assert.equal(quiz.configBackupInfo(), null);
    quiz.saveConfig({ mode: 1 });
    assert.equal(quiz.configBackupInfo(), null, '第一次写还没有备份');
    quiz.saveConfig({ mode: 2 });
    const info = quiz.configBackupInfo();
    assert.ok(info);
    assert.equal(info.file, file + '.bak');
    assert.ok(info.size > 0);
  });
});

test('配置文件位置是可覆盖的（否则测试就只能去碰真文件了，那是不允许的）', () => {
  const before = quiz.CFG_FILE;
  withTmp(({ file }) => {
    assert.equal(quiz.CFG_FILE, file);
    quiz.saveConfig({ mode: 1 });
    assert.ok(fs.existsSync(file));
  });
  assert.equal(quiz.CFG_FILE, before);
});
