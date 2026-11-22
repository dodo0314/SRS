// 할 일 칸반 — GitHub 이슈를 할 일 카드로 쓴다 (2026-11-22 본인 지시).
//
// 왜 이슈인가: 이슈는 브랜치와 상관없다. Claude 세션이 이슈를 만들고 고치면 머지 없이
// 바로 이 화면에 보인다. 파일로 두면 세션의 claude/ 브랜치를 main에 머지해야 보인다.
//
// 약속(세션이 이슈를 고칠 때도 같은 약속을 따른다 — srs/README.md 「할 일 칸반」):
//   라벨 `칸반`          이 화면에 올라오는 이슈의 표시. 없으면 보이지 않는다
//   라벨 `하는중`        「하는 중」 칸. 열려 있고 이 라벨이 없으면 「할 일」 칸
//   닫힘(completed)      「완료」 칸. 달력에는 닫은 날짜(closed_at)에 표시된다
//   닫힘(not_planned)    지운 것. 어디에도 보이지 않는다
//   라벨 `프로젝트:이름`  프로젝트 묶음. 하나만 쓴다
//   본문 `기한: YYYY-MM-DD` 줄  기한. 없으면 기한 없음. 나머지 본문은 메모
//
// 목록은 이 기기에 캐시한다. 오프라인이면 마지막으로 받은 목록을 보여 준다(고치기는 안 된다).

import * as db from './db.js';

export const LABEL = '칸반';
export const DOING = '하는중';
export const PROJECT_PREFIX = '프로젝트:';
const CACHE_KEY = 'kanbanCache';
const DAY = 86400000;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const DONE_LIST_MAX = 60;

/* ---------- 순수 함수 (테스트 대상) ---------- */

export const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DUE_LINE = /^\s*기한\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s*$/m;
const DUE_LINES = /^\s*기한\s*[:：].*$\n?/gm;

/** 본문에서 기한(YYYY-MM-DD)을 꺼낸다. 없으면 null. */
export function parseDue(body) {
  const m = DUE_LINE.exec(String(body || ''));
  return m ? m[1] : null;
}

/** 본문에서 기한 줄을 뺀 나머지(메모). */
export function memoOf(body) {
  return String(body || '').replace(/\r\n/g, '\n').replace(DUE_LINES, '').trim();
}

/** 기한과 메모로 본문을 만든다. 기한 줄이 맨 위에 온다. */
export function composeBody(due, memo) {
  const m = String(memo || '').trim();
  if (!due) return m;
  return m ? `기한: ${due}\n\n${m}` : `기한: ${due}`;
}

const labelNames = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);

export function projectOf(names) {
  const hit = names.find((n) => n.startsWith(PROJECT_PREFIX));
  return hit ? hit.slice(PROJECT_PREFIX.length).trim() || null : null;
}

/** 칸 이동·프로젝트 변경 뒤의 라벨 전체. 칸반과 관계없는 라벨은 그대로 둔다. */
export function labelsFor(names, { doing, project }) {
  const keep = names.filter((n) => n !== LABEL && n !== DOING && !n.startsWith(PROJECT_PREFIX));
  const out = [LABEL, ...keep];
  if (doing) out.push(DOING);
  if (project) out.push(PROJECT_PREFIX + project);
  return out;
}

/** GitHub 이슈 → 할 일 하나. */
export function toTask(issue) {
  const labels = labelNames(issue.labels);
  let column;
  if (issue.state === 'closed') column = issue.state_reason === 'not_planned' ? 'dropped' : 'done';
  else column = labels.includes(DOING) ? 'doing' : 'todo';
  return {
    number: issue.number,
    title: issue.title || '(제목 없음)',
    due: parseDue(issue.body),
    memo: memoOf(issue.body),
    project: projectOf(labels),
    labels,
    column,
    closedAt: issue.closed_at || null,
    createdAt: issue.created_at || null,
    url: issue.html_url || '',
  };
}

const byDueThenNewest = (a, b) => {
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  return b.number - a.number;
};

/** 칸별로 나누고 정렬한다. project가 있으면 그 프로젝트만. */
export function boardOf(tasks, { project = '' } = {}) {
  const pick = project ? tasks.filter((t) => t.project === project) : tasks;
  const todo = pick.filter((t) => t.column === 'todo').sort(byDueThenNewest);
  const doing = pick.filter((t) => t.column === 'doing').sort(byDueThenNewest);
  const done = pick
    .filter((t) => t.column === 'done')
    .sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')));
  return { todo, doing, done };
}

export function projectsOf(tasks) {
  return [...new Set(tasks.filter((t) => t.column !== 'dropped' && t.project).map((t) => t.project))].sort((a, b) =>
    a.localeCompare(b, 'ko')
  );
}

/** 날짜 칸 → { done: [완료한 일], due: [그날이 기한인 열린 일] }. 완료는 이 기기 시간대의 날짜로 센다. */
export function calendarOf(tasks) {
  const map = new Map();
  const slot = (k) => {
    if (!map.has(k)) map.set(k, { done: [], due: [] });
    return map.get(k);
  };
  for (const t of tasks) {
    if (t.column === 'done' && t.closedAt) slot(dateKey(new Date(t.closedAt))).done.push(t);
    else if ((t.column === 'todo' || t.column === 'doing') && t.due) slot(t.due).due.push(t);
  }
  return map;
}

/** 달 하나의 칸(일요일 시작). 앞뒤 빈칸은 null. */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Array(first.getDay()).fill(null);
  for (let d = 1; d <= days; d += 1) cells.push(dateKey(new Date(year, month, d)));
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** 기한까지 남은 날(오늘이 0, 지났으면 음수). */
export function daysLeft(due, today) {
  const [y, m, d] = due.split('-').map(Number);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((new Date(y, m - 1, d) - t) / DAY);
}

export function summary(tasks, today = new Date()) {
  const open = tasks.filter((t) => t.column === 'todo' || t.column === 'doing');
  const todayK = dateKey(today);
  return {
    todo: tasks.filter((t) => t.column === 'todo').length,
    doing: tasks.filter((t) => t.column === 'doing').length,
    overdue: open.filter((t) => t.due && t.due < todayK).length,
    doneToday: tasks.filter((t) => t.column === 'done' && t.closedAt && dateKey(new Date(t.closedAt)) === todayK).length,
  };
}

/* ---------- 화면 ---------- */

const S = {
  tasks: [],
  fetchedAt: 0,
  error: '',
  loading: false,
  view: 'todo', // todo | doing | done | cal
  project: '',
  cal: null, // { y, m }
  day: null,
  editing: null, // null | 'new' | 이슈 번호
  busy: false,
};
let ctx = null; // { repo: () => GitHubRepo | null, toast }
let root = null;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function kanbanSummary(today = new Date()) {
  const cache = await db.getSetting(CACHE_KEY, null);
  if (!cache) return null;
  return summary(cache.tasks || [], today);
}

async function saveCache() {
  await db.setSetting(CACHE_KEY, { tasks: S.tasks, fetchedAt: S.fetchedAt });
}

function errText(e) {
  if (e && e.status === 403 && !/rate limit/i.test(e.body || '')) {
    return '토큰에 Issues 권한이 없다. GitHub 토큰 설정에서 Issues: Read and write를 더한 뒤 다시 연다.';
  }
  if (e && e.status === 410) return '이 저장소는 이슈 기능이 꺼져 있다. 저장소 Settings → Features → Issues를 켠다.';
  if (e instanceof TypeError) return '인터넷에 연결되지 않았다. 연결되면 ⟳를 누른다.';
  return (e && e.message) || String(e);
}

/** 화면을 연다. 캐시를 먼저 그리고 뒤에서 새로 받는다. */
export async function openKanban(rootEl, context) {
  ctx = context;
  if (root !== rootEl) {
    root = rootEl;
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
  }
  if (!S.fetchedAt) {
    const cache = await db.getSetting(CACHE_KEY, null);
    if (cache) {
      S.tasks = cache.tasks || [];
      S.fetchedAt = cache.fetchedAt || 0;
    }
  }
  S.editing = null;
  render();
  await refreshKanban();
}

export async function refreshKanban() {
  const repo = ctx && ctx.repo();
  if (!repo) {
    S.error = '저장소가 연결되지 않았다. 설정에서 저장소와 토큰을 넣는다.';
    render();
    return;
  }
  if (S.loading) return;
  S.loading = true;
  render();
  try {
    const issues = await repo.listIssues(LABEL);
    S.tasks = issues.map(toTask);
    S.fetchedAt = Date.now();
    S.error = '';
    await saveCache();
  } catch (e) {
    S.error = errText(e);
  } finally {
    S.loading = false;
    render();
  }
}

export function newKanbanTask() {
  S.editing = 'new';
  render();
}

function replaceTask(task) {
  const i = S.tasks.findIndex((t) => t.number === task.number);
  if (i === -1) S.tasks.unshift(task);
  else S.tasks[i] = task;
}

/** 이슈 하나를 고친다. 화면은 먼저 바꾸고, 실패하면 알리고 다시 받는다. */
async function patchTask(task, patch, optimistic) {
  const repo = ctx.repo();
  if (!repo) return;
  replaceTask({ ...task, ...optimistic });
  render();
  try {
    const issue = await repo.updateIssue(task.number, patch);
    replaceTask(toTask(issue));
    await saveCache();
    render();
    return true;
  } catch (e) {
    ctx.toast(`저장 실패: ${errText(e)}`, 5000);
    replaceTask(task);
    render();
    return false;
  }
}

function move(task, to) {
  if (to === 'doing' || to === 'todo') {
    const labels = labelsFor(task.labels, { doing: to === 'doing', project: task.project });
    const patch = task.column === 'done' ? { state: 'open', state_reason: 'reopened', labels } : { labels };
    return patchTask(task, patch, { column: to, labels, closedAt: null });
  }
  if (to === 'done') {
    const labels = labelsFor(task.labels, { doing: false, project: task.project });
    return patchTask(
      task,
      { state: 'closed', state_reason: 'completed', labels },
      { column: 'done', labels, closedAt: new Date().toISOString() }
    );
  }
  return null;
}

/* ---------- 그리기 ---------- */

function dueBadge(task, today) {
  if (!task.due) return '';
  const left = daysLeft(task.due, today);
  const [, m, d] = task.due.split('-').map(Number);
  const md = `${m}/${d}`;
  if (task.column === 'done') return `<span class="kb-due">${md}</span>`;
  if (left < 0) return `<span class="kb-due late">${md} · ${-left}일 지남</span>`;
  if (left === 0) return `<span class="kb-due soon">오늘까지</span>`;
  if (left <= 2) return `<span class="kb-due soon">${md} · D-${left}</span>`;
  return `<span class="kb-due">${md} · D-${left}</span>`;
}

function doneLabel(task) {
  if (!task.closedAt) return '';
  const d = new Date(task.closedAt);
  return `<span class="kb-due">✓ ${d.getMonth() + 1}/${d.getDate()} (${DOW[d.getDay()]})</span>`;
}

function cardHtml(task, today) {
  const acts = {
    todo: [['start', '시작 ▶'], ['done', '완료 ✓']],
    doing: [['todo', '◀ 할 일로'], ['done', '완료 ✓']],
    done: [['reopen', '다시 열기']],
  }[task.column] || [];
  const memo = task.memo ? `<p class="kb-memo">${esc(task.memo.split('\n')[0])}</p>` : '';
  return `<article class="kb-card${task.column === 'done' ? ' is-done' : ''}">
    <button class="kb-main" data-act="edit" data-n="${task.number}">
      <span class="kb-title">${esc(task.title)}</span>
      <span class="kb-meta">${task.column === 'done' ? doneLabel(task) : dueBadge(task, today)}${
        task.project ? `<span class="kb-proj">${esc(task.project)}</span>` : ''
      }</span>
      ${memo}
    </button>
    <div class="kb-acts">${acts
      .map(([a, l]) => `<button class="mini-btn" data-act="${a}" data-n="${task.number}"${S.busy ? ' disabled' : ''}>${l}</button>`)
      .join('')}</div>
  </article>`;
}

function listHtml(list, col, today) {
  if (!list.length) {
    const empty = {
      todo: '할 일이 없다. 위 ＋로 하나 만든다.',
      doing: '하는 중인 일이 없다. 할 일 칸에서 「시작」을 누른다.',
      done: '아직 완료한 일이 없다.',
    }[col];
    return `<p class="status">${empty}</p>`;
  }
  const shown = col === 'done' ? list.slice(0, DONE_LIST_MAX) : list;
  const more =
    col === 'done' && list.length > DONE_LIST_MAX
      ? `<p class="status">최근 ${DONE_LIST_MAX}개만 보인다. 더 지난 일은 달력에서 본다.</p>`
      : '';
  return `<div class="kb-list">${shown.map((t) => cardHtml(t, today)).join('')}</div>${more}`;
}

function calendarHtml(tasks, today) {
  if (!S.cal) S.cal = { y: today.getFullYear(), m: today.getMonth() };
  const { y, m } = S.cal;
  const cal = calendarOf(tasks);
  const todayK = dateKey(today);
  const cells = monthGrid(y, m)
    .map((k) => {
      if (!k) return '<span class="kb-cell empty"></span>';
      const slot = cal.get(k);
      const done = slot ? slot.done.length : 0;
      const due = slot ? slot.due.length : 0;
      const cls = ['kb-cell', k === todayK ? 'today' : '', k === S.day ? 'sel' : ''].filter(Boolean).join(' ');
      return `<button class="${cls}" data-act="day" data-day="${k}">
        <span class="kb-dn">${Number(k.slice(8))}</span>
        <span class="kb-marks">${done ? `<i class="kb-mk done">${done}</i>` : ''}${due ? `<i class="kb-mk due">${due}</i>` : ''}</span>
      </button>`;
    })
    .join('');

  let dayHtml = '<p class="status">날짜를 누르면 그날 끝낸 일과 기한인 일이 보인다.</p>';
  if (S.day) {
    const slot = cal.get(S.day) || { done: [], due: [] };
    const [yy, mm, dd] = S.day.split('-').map(Number);
    const head = `${mm}/${dd} (${DOW[new Date(yy, mm - 1, dd).getDay()]})`;
    const part = (name, list) =>
      list.length ? `<h3 class="kb-sub">${name} ${list.length}</h3><div class="kb-list">${list.map((t) => cardHtml(t, today)).join('')}</div>` : '';
    dayHtml =
      `<h2 class="section-title">${head}</h2>` +
      (part('끝낸 일', slot.done) + part('기한인 일', slot.due) || '<p class="status">이날은 기록이 없다.</p>');
  }

  const monthDone = [...cal.entries()]
    .filter(([k]) => k.startsWith(`${y}-${String(m + 1).padStart(2, '0')}-`))
    .reduce((n, [, s]) => n + s.done.length, 0);

  return `<div class="kb-cal-head">
      <button class="icon-btn" data-act="cal-prev" aria-label="지난달">‹</button>
      <b>${y}년 ${m + 1}월</b>
      <button class="icon-btn" data-act="cal-next" aria-label="다음달">›</button>
    </div>
    <p class="status kb-cal-sum">이달 끝낸 일 ${monthDone}개 · <i class="kb-mk done">n</i> 끝낸 일 <i class="kb-mk due">n</i> 기한</p>
    <div class="kb-cal">${DOW.map((d) => `<span class="kb-wd">${d}</span>`).join('')}${cells}</div>
    ${dayHtml}`;
}

function formHtml(task) {
  const projects = projectsOf(S.tasks);
  const isNew = !task;
  const t = task || { title: '', due: '', memo: '', project: S.project || '' };
  return `<form class="kb-form" data-form="${isNew ? 'new' : task.number}">
    <h2 class="section-title">${isNew ? '새 할 일' : `할 일 #${task.number}`}</h2>
    <div class="field"><label for="kb-f-title">무엇을</label>
      <input id="kb-f-title" name="title" value="${esc(t.title)}" required autocomplete="off"></div>
    <div class="field"><label for="kb-f-due">기한 (비워 두면 기한 없음)</label>
      <input id="kb-f-due" name="due" type="date" value="${esc(t.due || '')}"></div>
    <div class="field"><label for="kb-f-proj">프로젝트 (비워 두면 없음)</label>
      <input id="kb-f-proj" name="project" list="kb-proj-list" value="${esc(t.project || '')}" autocomplete="off" placeholder="예: SRS">
      <datalist id="kb-proj-list">${projects.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></div>
    <div class="field"><label for="kb-f-memo">메모</label>
      <textarea id="kb-f-memo" name="memo" rows="4">${esc(t.memo || '')}</textarea></div>
    <div class="row">
      <button type="button" class="btn" data-act="cancel">취소</button>
      <button type="submit" class="btn primary"${S.busy ? ' disabled' : ''}>${isNew ? '만들기' : '저장'}</button>
    </div>
    ${
      isNew
        ? ''
        : `<div class="row">
      <button type="button" class="btn danger" data-act="drop" data-n="${task.number}">지우기</button>
    </div>
    <p class="hint">지우면 이슈가 「계획 안 함」으로 닫혀 어디에도 안 보인다. <a href="${esc(task.url)}" target="_blank" rel="noopener">GitHub에서 열기</a></p>`
    }
  </form>`;
}

function render() {
  if (!root) return;
  const today = new Date();

  if (S.editing !== null) {
    const task = S.editing === 'new' ? null : S.tasks.find((t) => t.number === S.editing);
    root.innerHTML = formHtml(task);
    return;
  }

  const live = S.tasks.filter((t) => t.column !== 'dropped');
  const projects = projectsOf(S.tasks);
  if (S.project && !projects.includes(S.project)) S.project = '';
  const pick = S.project ? live.filter((t) => t.project === S.project) : live;
  const board = boardOf(pick);

  const statusBits = [];
  if (S.loading) statusBits.push('받는 중…');
  else if (S.fetchedAt) statusBits.push(`${new Date(S.fetchedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}에 받음`);
  const status = S.error
    ? `<p class="status err">${esc(S.error)}</p>`
    : `<p class="status kb-status">${statusBits.join(' ')}</p>`;

  const chips = projects.length
    ? `<div class="kb-chips">${['', ...projects]
        .map(
          (p) =>
            `<button class="kb-chip" data-act="proj" data-proj="${esc(p)}" aria-pressed="${S.project === p}">${p ? esc(p) : '전체'}</button>`
        )
        .join('')}</div>`
    : '';

  const tabs = [
    ['todo', `할 일 ${board.todo.length}`],
    ['doing', `하는 중 ${board.doing.length}`],
    ['done', '완료'],
    ['cal', '달력'],
  ]
    .map(([v, l]) => `<button class="kb-tab" data-act="view" data-view="${v}" aria-pressed="${S.view === v}">${l}</button>`)
    .join('');

  const body = S.view === 'cal' ? calendarHtml(pick, today) : listHtml(board[S.view], S.view, today);
  root.innerHTML = `${status}${chips}<nav class="kb-tabs">${tabs}</nav>${body}`;
}

/* ---------- 입력 ---------- */

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !root.contains(btn)) return;
  const act = btn.dataset.act;
  const task = btn.dataset.n ? S.tasks.find((t) => t.number === Number(btn.dataset.n)) : null;

  if (act === 'view') {
    S.view = btn.dataset.view;
    render();
  } else if (act === 'proj') {
    S.project = btn.dataset.proj;
    render();
  } else if (act === 'edit' && task) {
    S.editing = task.number;
    render();
  } else if (act === 'cancel') {
    S.editing = null;
    render();
  } else if (act === 'start' && task) move(task, 'doing');
  else if (act === 'todo' && task) move(task, 'todo');
  else if (act === 'reopen' && task) move(task, 'todo');
  else if (act === 'done' && task) {
    move(task, 'done').then((ok) => ok && ctx.toast('완료했다'));
  } else if (act === 'drop' && task) {
    if (!confirm(`「${task.title}」을(를) 지울까?`)) return;
    S.editing = null;
    patchTask(task, { state: 'closed', state_reason: 'not_planned' }, { column: 'dropped' });
  } else if (act === 'day') {
    S.day = S.day === btn.dataset.day ? null : btn.dataset.day;
    render();
  } else if (act === 'cal-prev' || act === 'cal-next') {
    const d = new Date(S.cal.y, S.cal.m + (act === 'cal-next' ? 1 : -1), 1);
    S.cal = { y: d.getFullYear(), m: d.getMonth() };
    S.day = null;
    render();
  }
}

async function onSubmit(e) {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  if (S.busy) return;
  const repo = ctx.repo();
  if (!repo) return;
  const f = new FormData(form);
  const title = String(f.get('title') || '').trim();
  if (!title) {
    ctx.toast('무엇을 할지 적는다');
    return;
  }
  const due = String(f.get('due') || '').trim() || null;
  const project = String(f.get('project') || '').trim().replace(/^프로젝트:/, '').trim() || null;
  const body = composeBody(due, String(f.get('memo') || ''));

  S.busy = true;
  form.querySelector('[type="submit"]').disabled = true;
  try {
    if (form.dataset.form === 'new') {
      const issue = await repo.createIssue({ title, body, labels: labelsFor([], { doing: false, project }) });
      replaceTask(toTask(issue));
      S.view = S.view === 'cal' || S.view === 'done' ? 'todo' : S.view;
      ctx.toast('만들었다');
    } else {
      const task = S.tasks.find((t) => t.number === Number(form.dataset.form));
      const labels = labelsFor(task.labels, { doing: task.column === 'doing', project });
      const issue = await repo.updateIssue(task.number, { title, body, labels });
      replaceTask(toTask(issue));
      ctx.toast('저장했다');
    }
    await saveCache();
    S.editing = null;
  } catch (err) {
    ctx.toast(`저장 실패: ${errText(err)}`, 5000);
  } finally {
    S.busy = false;
    render();
  }
}
