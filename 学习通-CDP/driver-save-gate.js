/* 学习通助手 · 「最后一页没被确认保存」的翻页闸门
 *
 * 为什么要有它（实测账）：
 *   答题助手把答案填进页面之后会点「暂时保存」，但**点下去不等于存上了** ——
 *   平台可能只回一句"保存中"、或者压根没有成功提示（未确认），
 *   也可能只找得到提交类按钮被安全闸门挡下（rejected），或者保存请求直接失败（failed）。
 *   这几种情况下草稿**可能已经在页面里了**（saveDraftResult 是填完之后调的），
 *   此时再点「下一节」、切回「章节测验」栏、或者等外套 15 秒后重新拉起一个驱动器
 *   （页面被重新加载），草稿就没了 —— 而日志里看着像"一切正常"。
 *
 * 所以这里把"能不能继续自动往下走"这件事收成一个**纯函数**：
 *   回答三个问题就够了 —— 这一题走完保存这步了吗？保存被平台证实了吗？
 *   当前还停在会丢草稿的状态里吗？
 *
 * 三种结论（decision.action）：
 *   'continue' —— 没有可疑状态，按原有流程继续（翻页/切栏/收尾都不受影响）。
 *   'stop-manual' —— 保存没被确认：**一个字都不许动页面**，写停止标记，退出主驱动。
 *   'stop-quiz'   —— 用户在设置里开了「测验停」：退出主驱动，等他手动继续。
 *
 * 注意：这里只做结论，不碰页面、不读配置、不写文件。
 * 「保留当前题页」是调用方的责任 —— 它必须**什么都不做**（不切栏、不翻页、不重载）。
 */

'use strict';

const GATE_VERSION = 1;

/* 外套（_内部\驱动器循环.cmd）认的那个文件名。它只认这个路径，
   所以这里写死一份常量给调用方用，别再各写一处。 */
const STOP_FLAG_FILE = '停止标记.txt';
const STOP_FLAG_DIR = '_内部';

/** 保存状态名 → 给人看的中文（和 quiz-state.js 的 SAVE_STATUS_NAME 同口径） */
const STATUS_NAME = {
  saved: '已确认保存',
  saving: '保存中（还没看到成功提示）',
  unconfirmed: '未确认保存（没看到平台的保存成功提示）',
  rejected: '已拒绝（页面上只找到提交类按钮，一个都没点）',
  failed: '保存失败',
};

/** 状态字段可能是 quiz-state 的常量、也可能缺失 —— 一律按字符串比对，未知状态不会被说成成功 */
function statusName(status) {
  const s = String(status == null ? '' : status);
  if (!s) return '未知状态';
  return STATUS_NAME[s] || ('未知状态（' + s + '）');
}

/**
 * 把 helper.pendingSave() / helper.lastSaveResult() 的返回值收成一个稳定形状。
 * 这些字段里没一个是"凭据"，只是状态字，所以照原样留在返回值里给日志用。
 */
function normalizeSaveState(save) {
  const hasObj = !!(save && typeof save === 'object');
  const s = hasObj ? save : {};
  const status = String(s.status || '');
  /* "这一章到底走到过保存没有"：有状态字、或调用方明确给了 confirmed/blocksContinue
     才算有结论。空对象 / null 一律当"没有保存这回事"，不能凭空按"未确认"把章节卡死。 */
  const known = hasObj && !!(status || s.confirmed !== undefined || s.blocksContinue !== undefined);
  const confirmed = (s.confirmed === true) || status === 'saved';
  /* 有保存结论但 blocksContinue 缺字段（老 helper）→ 按"是不是还没确认"保守推断：
     宁可多拦一次，也不能因为字段没了就自动翻页。 */
  const blocksContinue = !known ? false : ((s.blocksContinue === undefined || s.blocksContinue === null)
    ? !confirmed
    : (s.blocksContinue === true));
  return {
    known: known,
    status: status,
    statusName: statusName(status),
    confirmed: confirmed,
    needConfirm: (s.needConfirm === true) || (!confirmed && status !== ''),
    blocksContinue: blocksContinue,
    origin: String(s.origin || ''),
    message: String(s.message || s.msg || ''),
  };
}

/**
 * 还能不能自动往下走。
 *
 * opts:
 *   save        —— helper.pendingSave() 的返回值（保存这步的结论）
 *   chapter     —— 当前章节名（只进提示文字，不做判断）
 *   stopAtQuiz  —— 用户设置里的「测验停」
 *   saveAttempted —— 这一章的 handle 里**真的走到过保存那一步**吗
 *                    （false 表示压根没填过，rejected/failed 那条"保守拦下"的前提不成立）
 *
 * 返回 { action, reason, chapter, save: {...}, stop: {...}|null }
 *   action: 'continue' | 'stop-manual' | 'stop-quiz'
 */
function decideAfterSave(opts) {
  const o = opts || {};
  const chapter = String(o.chapter || '');
  const sv = normalizeSaveState(o.save);

  if (sv.known && sv.blocksContinue && !sv.confirmed) {
    const why = sv.status ? sv.statusName : '保存状态不明';
    return {
      action: 'stop-manual',
      chapter: chapter,
      save: sv,
      reason: '这一章点过保存，但平台**没有证实存上了**（' + why + '）。' +
              '草稿可能就在当前页面里 —— 所以**停在当前题页不动**：不翻下一节、不切栏目、也不让外套自动重拉。' +
              '请你在浏览器里自己看一眼草稿在不在、要不要再点一次「暂时保存」；处理完再回控制台点 1 继续。',
      stop: makeStopFlag({
        chapter: chapter,
        status: sv.status,
        origin: sv.origin,
        message: sv.message || sv.statusName,
        reason: '待人工确认保存',
      }),
    };
  }

  if (o.stopAtQuiz === true) {
    return {
      action: 'stop-quiz',
      chapter: chapter,
      save: sv,
      reason: '按设置「测验停」，驱动器退出。做完自己提交，再回控制台点 1 继续往下跑。',
      stop: null,
    };
  }

  return { action: 'continue', chapter: chapter, save: sv, reason: '', stop: null };
}

/** 交给 开始.cmd / 用户看的停止标记内容（纯数据，写文件由调用方做） */
function makeStopFlag(info) {
  const i = info || {};
  return {
    v: GATE_VERSION,
    at: new Date().toISOString(),
    chapter: String(i.chapter || ''),
    status: String(i.status || ''),
    origin: String(i.origin || ''),
    message: String(i.message || ''),
    reason: String(i.reason || '待人工确认保存'),
  };
}

/**
 * 停止标记的文本形式。
 * 会覆盖写 _内部\停止标记.txt —— 那个文件是"外套别自动重拉"的唯一开关，
 * 所以第一行必须自己就说清楚为什么停，用户打开就能看懂，不用去翻日志。
 */
function formatStopFlag(flag) {
  const f = flag || {};
  const at = f.at || new Date().toISOString();
  const ch = f.chapter || '(读不到章节名)';
  const msg = f.message ? ('（' + f.message + '）') : '';
  return [
    '需要人工确认：这一章点过保存，但平台没有证实存上了 —— 驱动器已停在当前题页，没有翻页。',
    '原因：' + (f.reason || '待人工确认保存') + msg,
    '所属章节：' + ch,
    '保存状态：' + statusName(f.status) + (f.origin ? ('　来源：' + f.origin) : ''),
    '时间：' + at,
    '',
    '怎么办：',
    '  1) 回到浏览器那个课程页，看一眼这一章题目里的答案/草稿还在不在；',
    '  2) 在就自己点一次「暂时保存」（**不要点提交**），或手动记下答案；',
    '  3) 处理完回控制台点 1 继续（那会清掉这个标记、开一个新批次）。',
    '',
    '注意：只要这个文件还在，外套（驱动器循环.cmd）就不会自动重新拉起驱动器；',
    '      在这个标记期间页面上一个字都不会被点，草稿不会被翻页丢掉。',
  ].join('\r\n');
}

module.exports = {
  GATE_VERSION,
  STOP_FLAG_FILE,
  STOP_FLAG_DIR,
  STATUS_NAME,
  statusName,
  normalizeSaveState,
  decideAfterSave,
  makeStopFlag,
  formatStopFlag,
};
