// 하루설계 — 오늘 날짜와 요일 유형(출근/재택/토/일)에서 "오늘 할 일"을 계산해 그린다.
//
// 2026-10-27 본인 지시로 하루설계.md를 출퇴근만 남기고 비웠다. 다시 짤 때까지 이 파일도
// 출퇴근 사실만 보여 준다. 지우기 전 시간표(하루설계 v3 + 2027 합격플랜 P1 진도표)는
// `git show a06f59b:srs/app/js/todo.js`로 본다.
// 완료 체크는 이 기기에만 저장한다(복습 기록과 달리 동기화하지 않는다).
//
// 이 파일은 코스(course.js)의 데이터 원천이기도 하다. 과업마다:
//   strand: 'uw'(기본) | 'en' 영어 코스 몫 | 'stats' 통계 코스 몫 | 'srs' 카드 창(코스의 카드 정거장이 대체) | 'info' 배너
//           | 'commute' 출퇴근 — 어느 코스에도 붙지 않는다
//   stage:  '지식'(기본) | '정리'  — 코스의 정거장 순서는 카드 → 지식 → 정리
//   key:    같은 종류의 정거장을 코스가 중복 없이 합칠 때 쓰는 표식

import * as db from './db.js';

const DAY = 86400000;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/* ---------- 날짜 ---------- */

export const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* ---------- 출퇴근 (하루설계.md와 같은 값) ---------- */

const COMMUTE = [
  {
    id: 'c-out', strand: 'commute', title: '출근 — 06:55~07:00 출발', dur: '60~80분',
    detail: '편도 60~80분. 일찍 나갈수록 60분에 가깝다. 도착 후 근무 시작 전 30~35분은 보통 쉰다. 통근 중 독해·영상은 불가하다.',
  },
  { id: 'c-work', strand: 'commute', title: '근무 08:30~17:00', dur: '—', detail: '근무 시간.' },
  {
    id: 'c-back', strand: 'commute', title: '퇴근 — 17:00 출발', dur: '60~80분',
    detail: '퇴근길 종점과 이후 일정은 하루설계를 다시 짤 때 정한다.',
  },
];

/* ---------- 날짜 → 계획 ---------- */

export function planFor(date, wfhDow = 4) {
  const dow = date.getDay();
  const label = `${date.getMonth() + 1}/${date.getDate()} (${DOW[dow]})`;
  const phase = 'reset';
  const phaseLabel = '하루설계 다시 짜는 중 (2026-10-27) — 지금은 출퇴근만';

  let dayType, sections;
  if (dow === 6) {
    dayType = '토요일';
    sections = [];
  } else if (dow === 0) {
    dayType = '일요일';
    sections = [];
  } else if (dow === wfhDow) {
    dayType = '재택일';
    sections = [];
  } else {
    dayType = '출근일';
    sections = [{ name: '직장 출퇴근', tasks: COMMUTE }];
  }

  return { label, phase, phaseLabel, dayType, weekLine: null, sections };
}

/* ---------- 렌더 ---------- */

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DONE_KEY = 'todoDone';

async function loadDone(key) {
  const all = await db.getSetting(DONE_KEY, {});
  return new Set(all[key] || []);
}

async function saveDone(key, set) {
  const all = await db.getSetting(DONE_KEY, {});
  all[key] = [...set];
  // 30일 지난 기록은 버린다
  const cutoff = Date.now() - 30 * DAY;
  for (const k of Object.keys(all)) {
    if (new Date(k).getTime() < cutoff) delete all[k];
  }
  await db.setSetting(DONE_KEY, all);
}

export async function renderTodo(container, date, wfhDow) {
  const plan = planFor(date, wfhDow);
  const key = dateKey(date);
  const done = await loadDone(key);

  const total = plan.sections.reduce((n, s) => n + s.tasks.length, 0);
  const doneN = plan.sections.reduce((n, s) => n + s.tasks.filter((t) => done.has(t.id)).length, 0);

  container.innerHTML = `
    <div class="todo-banner">
      <div class="todo-phase">${escapeHtml(plan.phaseLabel)}</div>
      <div class="todo-daytype">${escapeHtml(plan.label)} · <b>${escapeHtml(plan.dayType)}</b></div>
      ${plan.weekLine ? `<div class="todo-week">${escapeHtml(plan.weekLine)}</div>` : ''}
      ${total ? `<div class="todo-progress">${doneN}/${total} 완료</div>` : ''}
    </div>
    ${total ? '' : '<p class="status">오늘은 정해 둔 일정이 없다. 하루설계를 다시 짜는 중이다.</p>'}
    ${plan.sections
      .map(
        (sec) => `
      <h2 class="section-title">${escapeHtml(sec.name)}</h2>
      <div class="todo-group">
        ${sec.tasks
          .map(
            (t) => `
          <div class="todo-task ${done.has(t.id) ? 'done' : ''}" data-task="${t.id}">
            <button class="todo-check" data-check="${t.id}" aria-pressed="${done.has(t.id)}">✓</button>
            <details>
              <summary><span class="todo-title">${escapeHtml(t.title)}</span>${t.dur && t.dur !== '—' ? `<span class="pill">${escapeHtml(t.dur)}</span>` : ''}</summary>
              <p class="todo-detail">${escapeHtml(t.detail)}</p>
            </details>
          </div>`
          )
          .join('')}
      </div>`
      )
      .join('')}
    <p class="status foot">시간표 원본(참고용) — 여기 체크는 코스와 별개다 · 영어의 현재 자료·연습 순서는 Course → 영어 코스에서 연다 · 재택 요일은 설정에서 변경</p>`;

  container.querySelectorAll('[data-check]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = btn.dataset.check;
      if (done.has(id)) done.delete(id);
      else done.add(id);
      await saveDone(key, done);
      renderTodo(container, date, wfhDow);
    })
  );
}
