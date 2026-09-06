// 코스 — "시작할 결심은 하루에 한 번"을 위한 안내된 경로.
//
// 정거장 순서는 카드 → 지식 → 정리다: 인출(카드)로 시동을 걸고, 새 재료(지식)를
// 넣고, 산출·분석(정리)으로 닫는다. 카드 정거장은 SRS와 같은 큐를 공유한다 —
// 완료는 체크가 아니라 "오늘의 카드가 비었는가"로 계산되므로, SRS 탭에서 미리
// 돌린 카드는 여기서도 이미 완료다.
//
// 달성은 두 단계: 🔥 풀코스(전 정거장), 🕯️ 최소달성(사슬을 지키는 최소한).
// 한 번 오른 달성은 그날 안에는 내려가지 않는다(학습 카드가 다시 due로 떠도).
// 연속달성은 코스별로 따로 센다 — 하나가 무너져도 다른 하나는 남는다.

import * as db from './db.js';
import { planFor, dateKey, fourThreeTwo, TASKS } from './todo.js';

const DAY = 86400000;
const STATE_KEY = 'courseState'; // { en: { days: { '2026-08-24': { done: [], status } } }, uw: … }
const STAGES = ['카드', '지식', '정리'];
const RANK = { none: 0, partial: 1, min: 2, full: 3 };

// 코스 명부. deckPrefix가 그 코스의 카드 정거장 범위(최상위 덱 이름의 접두어)이고,
// null이면 다른 코스가 안 가져간 나머지 전부다. 하루설계(todo.js) 과업의 strand가 코스 id와 같으면
// 그 코스의 정거장이 된다. archived가 있는 코스는 홈·Course 어디에도 뜨지 않는다 — 정의는 남겨 두어
// 되살릴 때 표식 한 줄만 지우면 된다.
export const COURSES = {
  en: {
    id: 'en',
    name: '영어 코스',
    short: '영어',
    icon: '🗣️',
    deckPrefix: '영어',
    cardsTitle: '영어 오늘의 카드',
    minLabel: '영어 오늘의 카드 + 4/3/2 한 세트',
    cardsDetail: 'compose 카드는 내 문장 1개(작문 코치)까지가 한 장이다.',
  },
  stats: {
    id: 'stats',
    name: '통계 코스',
    short: '통계',
    icon: '📈',
    deckPrefix: '통계',
    cardsTitle: '통계 오늘의 카드',
    minLabel: '통계 오늘의 카드 + 아무 정거장 1개 (정거장이 카드뿐인 날은 카드가 곧 완주)',
    cardsDetail:
      '통계/탐지평가 덱 — 토요일 시뮬레이터 세션의 인출 재료다(통계/00-커리큘럼.md 11절). ' +
      '카드는 세션 끝 15분에 그날 막힌 것만 만든다 — 미리 만들지 않는다. 막힌 카드는 Again.',
  },
  uw: {
    id: 'uw',
    name: 'UW 코스',
    short: 'UW',
    icon: '🧾',
    deckPrefix: null,
    cardsTitle: '보험 오늘의 카드',
    minLabel: '보험 오늘의 카드 + 아무 정거장 1개',
    cardsDetail: '놓친 논점 카드는 Again으로 — 암송 검산 대상이 된다.',
    // 2026-09-06 보관 — 재물손사 시험 포기(커리어검토/74 1절 · 하루설계 ⊕). 카드 덱은 srs/archive/cards/에 있다.
    archived: '2026-09-06',
  },
};

/** 홈과 Course 화면에 뜨는 코스 id — 명부 순서대로. */
export const ACTIVE_COURSES = Object.values(COURSES)
  .filter((c) => !c.archived)
  .map((c) => c.id);

/**
 * 최상위 덱 이름들을 코스별로 가른다. 접두어가 있는 코스가 먼저 가져가고,
 * deckPrefix가 null인 코스가 나머지를 받는다. 보관된 코스도 몫은 계산한다(되살릴 때 그대로 쓴다).
 */
export function splitDeckTops(tops) {
  const out = {};
  const claimed = new Set();
  const all = Object.values(COURSES);
  for (const c of all) {
    if (!c.deckPrefix) continue;
    out[c.id] = tops.filter((t) => t === c.deckPrefix || t.startsWith(c.deckPrefix));
    out[c.id].forEach((t) => claimed.add(t));
  }
  for (const c of all) {
    if (c.deckPrefix) continue;
    out[c.id] = tops.filter((t) => !claimed.has(t));
  }
  return out;
}

export const BADGE = {
  full: '🔥 풀코스',
  min: '🕯️ 최소달성',
  partial: '진행 중',
  none: '미시작',
};

/* ---------- 코스 구성 ---------- */

function cardStation(courseId, ctx) {
  const decks = ctx.deckTops[courseId] || [];
  const counts = decks.length ? ctx.cardCounts(decks) : { due: 0, new: 0 };
  const left = decks.length ? counts.due + counts.new : 0;
  return {
    id: `${courseId}-cards`,
    stage: '카드',
    cards: true,
    min: true,
    decks,
    left,
    title: COURSES[courseId].cardsTitle,
    dur: left ? `${left}장` : '',
    detail:
      'SRS 탭과 같은 카드, 같은 기록이다 — 통근길에 미리 돌렸으면 이 정거장은 이미 완료로 떠 있다. ' +
      COURSES[courseId].cardsDetail,
  };
}

const stationFromTask = (t, win) => ({
  id: `t-${t.id}`,
  stage: t.stage || '지식',
  min: !!t.min,
  title: t.title,
  dur: t.dur,
  detail: t.detail,
  win: win || null,
});

/**
 * 오늘의 코스를 만든다. 하루설계(planFor)가 재료를 대고,
 * 영어 코스는 매일 도는 골격(카드→듣기→4/3/2)을 그 위에 고정으로 깐다.
 * 다른 코스는 strand가 자기 id인 하루설계 과업이 정거장이다.
 */
export function buildCourse(courseId, date, ctx) {
  const now = date.getTime();
  const plan = planFor(date, ctx.wfhDow);

  const banner = [];
  const planTasks = [];
  for (const sec of plan.sections) {
    for (const t of sec.tasks) {
      const strand = t.strand || 'uw';
      if (strand === 'info') banner.push({ id: t.id, title: t.title, detail: t.detail });
      else if (strand !== 'srs') planTasks.push({ t, strand, win: sec.name });
    }
  }
  banner.sort((a, b) => bannerUrgency(a) - bannerUrgency(b));

  let stations = [cardStation(courseId, ctx)];

  if (courseId === 'en') {
    // 2026-09-06 — 「좁은 읽기 — 보험 영어 한 조각」 정거장은 뺐다. 재물손사·UW를 접으면서(커리어검토/74 1절)
    // 보험 도메인 읽기가 영어 코스의 재료에서 빠졌기 때문이다. 영어 골격은 카드 → 듣기 → 4/3/2.
    const listen = TASKS.audio(now);
    stations.push({
      id: 'en-listen',
      stage: '지식',
      title: listen.title.replace(/^남는 시간: /, '듣기 — '),
      dur: '10분',
      detail: listen.detail,
    });
    const f = fourThreeTwo(now);
    stations.push({ id: 'en-432', stage: f.stage, min: true, title: f.title, dur: f.dur, detail: f.detail });
    // 하루설계에서 오는 영어 몫(전사·오류 카드화·OPIc 준비 등).
    // 골격이 이미 덮는 종류(key)는 중복으로 넣지 않는다.
    const covered = new Set(['432', 'listen']);
    for (const { t, strand, win } of planTasks) {
      if (strand !== 'en') continue;
      if (t.key && covered.has(t.key)) continue;
      stations.push(stationFromTask(t, win));
    }
  } else {
    for (const { t, strand, win } of planTasks) {
      if (strand !== courseId) continue;
      stations.push(stationFromTask(t, win));
    }
  }

  stations = STAGES.flatMap((st) => stations.filter((s) => s.stage === st));
  return { stations, banner, plan };
}

const bannerUrgency = (b) => (/D-|⚡|오늘/.test(b.title) ? 0 : 1);

/* ---------- 달성 상태 저장 ---------- */

const loadAll = () => db.getSetting(STATE_KEY, {});

async function dayState(courseId, key) {
  const all = await loadAll();
  const c = all[courseId];
  return (c && c.days && c.days[key]) || { done: [], status: 'none' };
}

async function saveDayState(courseId, key, day) {
  const all = await loadAll();
  if (!all[courseId]) all[courseId] = { days: {} };
  all[courseId].days[key] = day;
  const cutoff = Date.now() - 180 * DAY;
  for (const cid of Object.keys(all)) {
    const days = all[cid].days || {};
    for (const k of Object.keys(days)) {
      if (new Date(k).getTime() < cutoff) delete days[k];
    }
  }
  await db.setSetting(STATE_KEY, all);
}

const stationDone = (s, doneSet) => (s.cards ? s.left === 0 : doneSet.has(s.id));

function computeStatus(courseId, stations, doneSet) {
  const isDone = (s) => stationDone(s, doneSet);
  const doneN = stations.filter(isDone).length;
  if (doneN === stations.length) return { doneN, status: 'full' };
  const cards = stations.find((s) => s.cards);
  const cardsOk = !!cards && isDone(cards);
  const min =
    courseId === 'en'
      ? cardsOk && stations.filter((s) => s.min && !s.cards).every(isDone)
      : cardsOk && stations.some((s) => !s.cards && isDone(s));
  return { doneN, status: min ? 'min' : doneN ? 'partial' : 'none' };
}

export async function toggleStation(courseId, date, stationId) {
  const key = dateKey(date);
  const day = await dayState(courseId, key);
  const set = new Set(day.done);
  if (set.has(stationId)) set.delete(stationId);
  else set.add(stationId);
  await saveDayState(courseId, key, { ...day, done: [...set] });
}

async function streakOf(courseId, date) {
  const all = await loadAll();
  const days = (all[courseId] && all[courseId].days) || {};
  const ok = (k) => days[k] && RANK[days[k].status] >= RANK.min;
  const t = new Date(date);
  t.setHours(0, 0, 0, 0);
  let ms = t.getTime();
  let n = 0;
  if (!ok(dateKey(new Date(ms)))) ms -= DAY;
  while (ok(dateKey(new Date(ms)))) {
    n += 1;
    ms -= DAY;
  }
  return n;
}

/** 오늘의 코스 + 달성 상태를 계산하고, 오른 달성은 그날 기록으로 못박는다. */
export async function refreshToday(courseId, date, ctx) {
  const key = dateKey(date);
  const { stations, banner, plan } = buildCourse(courseId, date, ctx);
  const day = await dayState(courseId, key);
  const doneSet = new Set(day.done);
  const { doneN, status } = computeStatus(courseId, stations, doneSet);
  const stored = day.status || 'none';
  const finalStatus = RANK[status] >= RANK[stored] ? status : stored;
  if (finalStatus !== stored) await saveDayState(courseId, key, { ...day, status: finalStatus });
  const streak = await streakOf(courseId, date);
  return { courseId, stations, banner, plan, doneSet, doneN, total: stations.length, status: finalStatus, streak };
}

/* ---------- 렌더 ---------- */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 정보성 배너 — 급한 것(D-day) 하나만 보이고 나머지는 +n 뒤에 접는다. */
export function bannerHtml(items) {
  if (!items || !items.length) return '';
  const item = (b) =>
    `<details class="bn-item"><summary>${esc(b.title)}</summary><p>${esc(b.detail)}</p></details>`;
  const rest = items.slice(1);
  return `<div class="course-banner">
    <div class="bn-row">${item(items[0])}${
      rest.length ? `<button class="bn-more" data-bn-more aria-expanded="false">+${rest.length}</button>` : ''
    }</div>
    ${rest.length ? `<div class="bn-rest" hidden>${rest.map(item).join('')}</div>` : ''}
  </div>`;
}

export function wireBanner(root) {
  const btn = root.querySelector('[data-bn-more]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const rest = root.querySelector('.bn-rest');
    const open = rest.hidden;
    rest.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? '접기' : `+${rest.children.length}`;
  });
}

const streakLine = (n) => (n ? `연속달성 ${n}일` : '연속달성 0일');

/** Course 첫 화면 — 활성 코스(영어 / 통계)의 오늘 상태. */
export async function renderCourseHub(container, date, ctx) {
  const ov = {};
  for (const id of ACTIVE_COURSES) ov[id] = await refreshToday(id, date, ctx);
  const first = ov[ACTIVE_COURSES[0]];

  container.innerHTML =
    bannerHtml(first.banner) +
    `<p class="status" style="margin:0 0 12px">${esc(first.plan.label)} · ${esc(first.plan.dayType)} · ${esc(first.plan.phaseLabel)}</p>` +
    ACTIVE_COURSES
      .map((id) => {
        const o = ov[id];
        const meta = COURSES[id];
        const pct = o.total ? Math.round((o.doneN / o.total) * 100) : 0;
        return `<button class="course-card" data-course="${id}">
          <div class="cc-top"><span class="cc-ico">${meta.icon}</span><b>${esc(meta.name)}</b>
            <span class="cc-badge">${BADGE[o.status]}</span></div>
          <div class="cbar"><i style="width:${pct}%"></i></div>
          <div class="cc-sub"><span>${o.doneN}/${o.total} 정거장</span><span>${streakLine(o.streak)}</span></div>
        </button>`;
      })
      .join('');

  wireBanner(container);
  container.querySelectorAll('[data-course]').forEach((b) =>
    b.addEventListener('click', () => ctx.openRun(b.dataset.course))
  );
}

/** 코스 러너 — 정거장 순서대로 안내한다. */
export async function renderCourseRun(container, courseId, date, ctx) {
  const o = await refreshToday(courseId, date, ctx);
  const meta = COURSES[courseId];
  const isDone = (s) => stationDone(s, o.doneSet);
  const cur = o.stations.find((s) => !isDone(s));
  const pct = o.total ? Math.round((o.doneN / o.total) * 100) : 0;
  const cardsSt = o.stations.find((s) => s.cards);

  const head = `
    ${bannerHtml(o.banner)}
    <div class="run-head">
      <div class="run-day">${esc(o.plan.label)} · ${esc(o.plan.dayType)}${
        courseId === 'uw' && o.plan.weekLine ? `<br>${esc(o.plan.weekLine)}` : ''
      }</div>
      <div class="run-meter"><div class="cbar"><i style="width:${pct}%"></i></div><span>${o.doneN}/${o.total}</span></div>
      <div class="run-badges"><b>${BADGE[o.status]}</b> · ${streakLine(o.streak)}</div>
    </div>`;

  let cta = '';
  if (!cur) {
    cta = `<div class="course-done">
      <div class="cd-big">🔥</div>
      <p class="cd-title">풀코스 완주 — 내일 또 봐!</p>
      <p class="status">${streakLine(o.streak)} · 오늘 결심은 다 썼다. 나머지는 회복이다.</p>
    </div>`;
  } else if (cur.cards) {
    cta = `<button class="btn primary block big" data-run-cards>▶ ${esc(cur.title)} — ${cur.left}장</button>`;
  } else {
    cta = `<button class="btn primary block big" data-run-done="${esc(cur.id)}">✓ ${esc(cur.title)} 끝냈다</button>`;
  }

  const minNote = !cur
    ? ''
    : o.status === 'min'
      ? `<p class="status">🕯️ 최소달성 확보 — 여기서 멈춰도 연속달성은 이어진다. 여력이 있으면 🔥까지.</p>`
      : `<p class="status">🕯️ 최소달성 = ${esc(meta.minLabel)}</p>`;

  const groups = STAGES.map((st) => {
    const list = o.stations.filter((s) => s.stage === st);
    if (!list.length) return '';
    return (
      `<h2 class="section-title">${st}</h2><div class="todo-group">` +
      list
        .map((s) => {
          const done = isDone(s);
          const now = !!cur && cur.id === s.id;
          const check = s.cards
            ? `<button class="todo-check" data-run-cards aria-pressed="${done}" ${done ? 'disabled' : ''}>${done ? '✓' : '▶'}</button>`
            : `<button class="todo-check" data-st="${esc(s.id)}" aria-pressed="${done}">✓</button>`;
          return `<div class="todo-task station ${done ? 'done' : ''} ${now ? 'now' : ''}">
            ${check}
            <details ${now ? 'open' : ''}>
              <summary><span class="todo-title">${esc(s.title)}</span>${
                s.min ? '<span class="pill">🕯️</span>' : ''
              }${s.dur && s.dur !== '—' ? `<span class="pill">${esc(s.dur)}</span>` : ''}</summary>
              <p class="todo-detail">${s.win ? `창: ${esc(s.win)}\n` : ''}${esc(s.detail)}</p>
            </details>
          </div>`;
        })
        .join('') +
      '</div>'
    );
  }).join('');

  container.innerHTML =
    head +
    cta +
    minNote +
    groups +
    '<p class="status foot">카드 정거장은 큐가 비면 자동 완료 · 체크와 연속달성은 이 기기에만 저장된다</p>';

  // 완주 순간에는 🔥 패널이 보이도록 위로 올린다 (체크 중에는 자리를 지킨다)
  if (!cur) {
    const wrap = container.closest('.wrap');
    if (wrap) wrap.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  wireBanner(container);
  const rerender = () => renderCourseRun(container, courseId, date, ctx);
  container.querySelectorAll('[data-run-cards]').forEach((b) =>
    b.addEventListener('click', () => {
      if (cardsSt && cardsSt.left > 0) ctx.startCards(cardsSt.decks, courseId);
    })
  );
  container.querySelectorAll('[data-st]').forEach((b) =>
    b.addEventListener('click', async () => {
      await toggleStation(courseId, date, b.dataset.st);
      rerender();
    })
  );
  const ctaDone = container.querySelector('[data-run-done]');
  if (ctaDone)
    ctaDone.addEventListener('click', async () => {
      await toggleStation(courseId, date, ctaDone.dataset.runDone);
      rerender();
    });
}
