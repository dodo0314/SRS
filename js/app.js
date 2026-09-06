// 앱 진입점 — 화면 전환, 복습 진행, 설정, 동기화 연결

import * as db from './db.js';
import { Sync, DEFAULT_CONFIG } from './sync.js';
import { GitHubRepo } from './github.js';
import {
  RATING, STATE, newState, schedule, previewIntervals, formatInterval,
} from './fsrs.js';
import {
  buildQueue, Session, countIntroducedToday, forecast, startOfDay, DEFAULT_LIMITS,
} from './queue.js';
import { renderTodo } from './todo.js';
import { judgeSentence, VERDICT_LABEL, ERROR_LABEL } from './coach.js';
import {
  COURSES, ACTIVE_COURSES, BADGE, splitDeckTops, refreshToday, renderCourseHub, renderCourseRun, bannerHtml, wireBanner,
} from './course.js';

const TOKEN_KEY = 'srs.token';
const ANTHROPIC_KEY = 'srs.anthropicKey';
const GEMINI_KEY = 'srs.geminiKey';
const APP_VERSION = '1.10.0';
const DAY = 86400000;

const $ = (id) => document.getElementById(id);
const el = (sel, root = document) => root.querySelector(sel);
const els = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  config: { ...DEFAULT_CONFIG },
  limits: { ...DEFAULT_LIMITS },
  fsrs: { requestRetention: 0.9, maximumInterval: 36500, enableFuzz: true },
  cards: [],
  states: new Map(),
  logs: [],
  selectedDecks: [],
  session: null,
  current: null,
  revealed: false,
  recalled: new Set(),
  undoStack: [],
  syncing: false,
  sessionOrigin: null, // 코스에서 카드 정거장으로 들어왔으면 코스 id — 끝나면 그 코스로 돌아간다
  courseView: 'en',
};

/* ---------- 공통 ---------- */

function show(view) {
  els('.view').forEach((v) => {
    v.classList.remove('active');
    v.hidden = true;
  });
  const target = $(`view-${view}`);
  target.hidden = false;
  target.classList.add('active');
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(message, ms = 2600) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, ms);
}

const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const getApiKey = () => localStorage.getItem(ANTHROPIC_KEY) || '';
const setApiKey = (k) => localStorage.setItem(ANTHROPIC_KEY, k);
const getGeminiKey = () => localStorage.getItem(GEMINI_KEY) || '';
const setGeminiKey = (k) => localStorage.setItem(GEMINI_KEY, k);

/** 넣어둔 키로 판정 제공자를 정한다. 둘 다 있으면 Claude. */
function coachConfig() {
  const a = getApiKey();
  if (a) return { provider: 'anthropic', apiKey: a };
  const g = getGeminiKey();
  if (g) return { provider: 'gemini', apiKey: g };
  return null;
}

function syncClient() {
  const token = getToken();
  if (!token || !state.config.owner || !state.config.repo) return null;
  return new Sync(state.config, token);
}

const relTime = (ts) => {
  if (!ts) return '없음';
  const diff = Date.now() - ts;
  if (diff < 60000) return '방금';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  if (diff < DAY) return `${Math.floor(diff / 3600000)}시간 전`;
  return `${Math.floor(diff / DAY)}일 전`;
};

/* ---------- 데이터 로드 ---------- */

async function loadSettings() {
  state.config = { ...DEFAULT_CONFIG, ...(await db.getSetting('config', {})) };
  state.limits = { ...DEFAULT_LIMITS, ...(await db.getSetting('limits', {})) };
  state.fsrs = { ...state.fsrs, ...(await db.getSetting('fsrs', {})) };
  state.selectedDecks = await db.getSetting('selectedDecks', []);
  state.todo = { wfhDow: 4, ...(await db.getSetting('todoConfig', {})) };
}

/* ---------- 오늘 표제와 To-Do ---------- */

function todayLabel() {
  const d = new Date();
  const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `오늘 · ${d.getMonth() + 1}/${d.getDate()} (${dow})`;
}

function renderTodoView() {
  $('todo-title').textContent = todayLabel();
  renderTodo($('todo-list'), new Date(), state.todo.wfhDow);
}

/* ---------- 홈 허브와 코스 ---------- */

/** 최상위 덱을 코스별로 가른다 — 코스의 카드 정거장 범위. 규칙은 course.js의 COURSES가 정한다. */
function deckTops() {
  return splitDeckTops([...new Set(state.cards.map((c) => c.deck.split('/')[0]))]);
}

/** course.js에 넘기는 문맥 — 카드 큐는 SRS와 완전히 같은 계산을 쓴다. */
function courseCtx() {
  return {
    wfhDow: state.todo.wfhDow,
    deckTops: deckTops(),
    cardCounts: (decks) => todayCounts(decks).counts,
    startCards: (decks, courseId) => startSession(decks, courseId),
    openRun: (courseId) => showCourseRun(courseId),
  };
}

async function showCourseRun(courseId) {
  state.courseView = courseId;
  $('course-run-title').textContent = COURSES[courseId].name;
  await renderCourseRun($('course-run-root'), courseId, new Date(), courseCtx());
  show('course-run');
}

async function renderCourseView() {
  await renderCourseHub($('course-root'), new Date(), courseCtx());
}

async function renderHub() {
  $('hub-title').textContent = todayLabel();
  const ctx = courseCtx();
  const date = new Date();
  const ov = {};
  for (const id of ACTIVE_COURSES) ov[id] = await refreshToday(id, date, ctx);
  const { counts } = todayCounts([]);

  const bn = $('hub-banner');
  bn.innerHTML = bannerHtml(ov[ACTIVE_COURSES[0]].banner);
  wireBanner(bn);

  // 결심은 한 번 — CTA는 진행 중인 코스를 먼저, 없으면 첫 코스(영어)부터 가리킨다
  const open = ACTIVE_COURSES.filter((id) => ov[id].status !== 'full');
  const target = open.find((id) => ov[id].doneN > 0) || open[0] || null;
  const cta = $('hub-cta');
  if (!target) {
    cta.textContent = '🔥 오늘 완주 — 내일 또 봐!';
    cta.disabled = true;
    cta.onclick = null;
    $('hub-cta-sub').textContent = ACTIVE_COURSES.map((id) => `${COURSES[id].short} 연속달성 ${ov[id].streak}일`).join(' · ');
  } else {
    const o = ov[target];
    cta.textContent = `${COURSES[target].icon} ${COURSES[target].name} ${o.doneN ? '이어하기' : '시작'} — ${o.doneN}/${o.total}`;
    cta.disabled = false;
    $('hub-cta-sub').textContent =
      o.status === 'min' ? '🕯️ 최소달성은 확보 — 남은 건 보너스다.' : '';
    cta.onclick = () => showCourseRun(target);
  }

  const courseSub = ACTIVE_COURSES.map((id) => `${COURSES[id].short} ${ov[id].doneN}/${ov[id].total} ${BADGE[ov[id].status]}`).join(' · ');
  $('hub-tiles').innerHTML = [
    { go: 'srs', ico: '🗂️', name: 'SRS', sub: `복습 ${counts.due} · 신규 ${counts.new} — 카드 자유 이용` },
    { go: 'course', ico: '🧭', name: 'Course', sub: courseSub },
    { go: 'lab', ico: '🧪', name: '실험실', sub: '하루설계' },
  ]
    .map(
      (t) => `<button class="hub-tile" data-hub-go="${t.go}">
        <span class="ht-ico">${t.ico}</span>
        <span class="ht-body"><b>${t.name}</b><span class="ht-sub">${escapeHtml(t.sub)}</span></span>
        <span class="ht-arrow">›</span>
      </button>`
    )
    .join('');
  els('[data-hub-go]', $('hub-tiles')).forEach((btn) =>
    btn.addEventListener('click', () => goTab(btn.dataset.hubGo))
  );

  db.getSetting('lastPush').then((ts) =>
    db.getSetting('lastCardPull').then((pull) => {
      $('hub-sync').textContent = `카드 ${state.cards.length}장 · 마지막 동기화 ${relTime(Math.max(ts || 0, pull || 0))}`;
    })
  );
}

/** 상단 탭과 허브 타일이 공유하는 화면 전환. */
function goTab(t) {
  if (t === 'hub') {
    renderHub();
    show('hub');
  } else if (t === 'course') {
    renderCourseView();
    show('course');
  } else if (t === 'lab') {
    show('lab');
  } else {
    renderHome();
    show('home');
  }
}

async function loadData() {
  const [cards, states, logs] = await Promise.all([
    db.getAll(db.STORES.CARDS),
    db.getAll(db.STORES.STATES),
    db.getAll(db.STORES.LOGS),
  ]);
  state.cards = cards;
  state.states = new Map(states.map((s) => [s.id, s]));
  state.logs = logs;
}

/* ---------- 홈 ---------- */

function decksOf(cards) {
  const map = new Map();
  for (const card of cards) {
    const top = card.deck.split('/')[0];
    for (const name of new Set([top, card.deck])) {
      if (!map.has(name)) map.set(name, { name, due: 0, new: 0, total: 0 });
    }
  }
  return map;
}

function todayCounts(decks = state.selectedDecks) {
  const introduced = countIntroducedToday(state.logs, Date.now());
  return buildQueue(state.cards, state.states, {
    ...state.limits,
    decks,
    introducedToday: introduced,
  });
}

function renderHome() {
  $('home-title').textContent = todayLabel();
  const { counts } = todayCounts();
  $('home-due').textContent = counts.due;
  $('home-new').textContent = counts.new;
  $('home-streak').textContent = streak();

  const held = [];
  if (counts.dueHeld > 0) held.push(`복습 ${counts.dueHeld}장은 상한에 걸려 내일로`);
  if (counts.newHeld > 0) held.push(`신규 ${counts.newHeld}장 대기`);
  $('home-held').textContent = held.join(' · ');

  const sel = state.selectedDecks.length;
  $('btn-start').disabled = counts.due + counts.new === 0;
  $('btn-start').textContent =
    counts.due + counts.new === 0
      ? (sel ? '선택한 덱에 오늘 볼 카드 없음' : '오늘 볼 카드 없음')
      : (sel ? `선택한 덱 ${sel}개 복습 시작` : '복습 시작');
  $('btn-clear-decks').hidden = !sel;
  $('deck-sel-hint').hidden = !sel;
  if (sel) $('deck-sel-hint').textContent = `덱 ${sel}개 선택됨 — 위 숫자와 복습이 선택한 덱 기준이다.`;

  renderDecks();
  renderWarnings();

  db.getSetting('lastPush').then((ts) =>
    db.getSetting('lastCardPull').then((pull) => {
      $('sync-status').textContent = `카드 ${state.cards.length}장 · 마지막 동기화 ${relTime(Math.max(ts || 0, pull || 0))}`;
    })
  );
}

function renderDecks() {
  const box = $('deck-list');
  const map = decksOf(state.cards);
  const cutoffCounts = new Map();
  const now = Date.now();
  for (const card of state.cards) {
    const s = state.states.get(card.id);
    const isNew = !s || !s.lastReview;
    const isDue = s && s.lastReview && s.due <= new Date(now).setHours(23, 59, 59, 999);
    for (const name of new Set([card.deck.split('/')[0], card.deck])) {
      const row = cutoffCounts.get(name) || { due: 0, new: 0, total: 0 };
      row.total += 1;
      if (isNew) row.new += 1;
      else if (isDue) row.due += 1;
      cutoffCounts.set(name, row);
    }
  }

  const names = [...map.keys()].sort((a, b) => a.localeCompare(b, 'ko'));
  if (!names.length) {
    box.innerHTML = '<p class="status">카드가 없다. 저장소의 카드 폴더에 .md 파일을 넣고 동기화한다.</p>';
    return;
  }

  box.innerHTML = names
    .map((name) => {
      const c = cutoffCounts.get(name) || { due: 0, new: 0, total: 0 };
      const on = state.selectedDecks.includes(name);
      const depth = name.split('/').length - 1;
      const label = depth ? name.split('/').slice(1).join('/') : name;
      return `<div class="deck" style="margin-left:${depth * 14}px">
        <button class="deck-select" data-deck="${escapeAttr(name)}" aria-pressed="${on}" aria-label="${escapeAttr(label)} 선택">
          <span class="deck-name">${escapeHtml(label)}</span>
          <span class="deck-counts">
            ${c.due ? `<span class="pill due">${c.due}</span>` : ''}
            ${c.new ? `<span class="pill new">${c.new}</span>` : ''}
            <span class="pill">${c.total}</span>
          </span>
        </button>
        <button class="deck-play" data-deck="${escapeAttr(name)}" aria-label="${escapeAttr(label)}만 바로 복습">▶</button>
      </div>`;
    })
    .join('');

  els('.deck-select', box).forEach((btn) =>
    btn.addEventListener('click', () => {
      const name = btn.dataset.deck;
      const i = state.selectedDecks.indexOf(name);
      if (i >= 0) state.selectedDecks.splice(i, 1);
      else state.selectedDecks.push(name);
      db.setSetting('selectedDecks', state.selectedDecks);
      renderHome();
    })
  );

  els('.deck-play', box).forEach((btn) =>
    btn.addEventListener('click', () => startSession([btn.dataset.deck]))
  );
}

async function renderWarnings() {
  const errors = await db.getSetting('parseErrors', []);
  const missing = state.cards.filter((c) => c.warn && c.warn.length).length;
  const box = $('home-warnings');
  const parts = [];
  if (missing) parts.push(`<li>근거 없는 카드 ${missing}장. 복습 화면에 표시된다.</li>`);
  if (errors.length) parts.push(`<li>카드 파일 오류 ${errors.length}건. 설정에서 확인.</li>`);
  box.hidden = !parts.length;
  box.innerHTML = parts.length ? `점검할 것<ul>${parts.join('')}</ul>` : '';
}

/* ---------- 복습 ---------- */

/** decks를 주면 그 덱만으로 세션을 만든다. 없으면 홈의 선택 상태를 따른다. */
function startSession(decks, origin = null) {
  state.sessionOrigin = origin;
  const scope = Array.isArray(decks) && decks.length ? decks : state.selectedDecks;
  const { items, counts } = todayCounts(scope);
  if (!items.length) {
    toast('오늘 볼 카드가 없다');
    return;
  }
  state.session = new Session(items);
  state.undoStack = [];
  state.sessionStart = Date.now();
  state.sessionCounts = counts;
  show('review');
  nextCard();
}

function nextCard() {
  const item = state.session.peek();
  if (!item) return finishSession();
  state.current = item;
  state.revealed = false;
  state.recalled = new Set();
  renderCard();
}

function renderCard() {
  const { card } = state.current;
  const s = state.session.counts();
  $('review-counts').innerHTML =
    `<span class="c-new">신규 <b>${s.new}</b></span>` +
    `<span class="c-learn">학습 <b>${s.learning}</b></span>` +
    `<span class="c-rev">복습 <b>${s.review}</b></span>`;
  $('btn-undo').disabled = state.undoStack.length === 0;

  const meta = [`<span class="tag">${escapeHtml(card.deck)}</span>`];
  for (const t of card.tags || []) meta.push(`<span class="tag">${escapeHtml(t)}</span>`);
  for (const w of card.warn || []) meta.push(`<span class="tag warn">${escapeHtml(w)}</span>`);
  if (card.type === 'points') meta.push('<span class="tag">논점</span>');
  $('card-meta').innerHTML = meta.join('');

  const front = card.type === 'cloze' && card.title
    ? `<p class="points-note">${escapeHtml(card.title)}</p>${card.front}`
    : card.front;
  $('card-front').innerHTML = front;

  $('card-back').hidden = true;
  $('card-back').innerHTML = '';
  $('card-points').hidden = true;
  $('card-points').innerHTML = '';
  $('card-source').hidden = true;
  $('card-compose').hidden = true;
  $('btn-reveal').hidden = false;
  $('grade-row').hidden = true;
  els('.grade').forEach((b) => b.classList.remove('suggest'));
  el('.card-area').scrollTop = 0;
}

function reveal() {
  if (state.revealed) return;
  state.revealed = true;
  const { card, state: cardState } = state.current;

  if (card.type === 'points') {
    renderPoints(card);
  } else {
    // 빈칸 카드는 앞뒤 문장이 같아 보인다. 정답을 먼저 못박고 문장을 보여준다.
    const answer =
      card.type === 'cloze' && card.answer
        ? `<p class="cloze-answer">${escapeHtml(card.answer)}</p>`
        : '';
    $('card-back').innerHTML =
      answer + card.back + (card.note ? `<div class="card-note">${card.note}</div>` : '');
    $('card-back').hidden = false;
  }

  if (card.source) {
    const box = $('card-source');
    const path = card.sourcePath;
    const href = path
      ? (/^https?:/.test(path) ? path : new GitHubRepo(state.config).blobUrl(path))
      : null;
    box.innerHTML = href
      ? `<span class="label">근거</span><a href="${escapeAttr(href)}" target="_blank" rel="noopener">${escapeHtml(card.source)}</a>`
      : `<span class="label">근거</span><span>${escapeHtml(card.source)}</span>`;
    box.hidden = false;
  }

  const preview = previewIntervals(cardState || newState(), Date.now(), state.fsrs);
  els('.grade').forEach((btn) => {
    const g = Number(btn.dataset.grade);
    el('em', btn).textContent = formatInterval(preview[g]);
  });

  $('btn-reveal').hidden = true;
  $('grade-row').hidden = false;
  if (card.type === 'points') updateSuggestion();
  if (card.compose) showCompose();
}

/* ---------- 작문 코치 ---------- */

// 작문 코치는 2단이다. 1단은 정답을 주지 않고 어디가 틀렸는지만 짚고,
// 학습자가 고쳐 쓴 뒤에야 2단에서 다듬은 문장을 보여준다 — 영어학습 2-1절
// (Lyster & Saito 2010: 스스로 고치게 하는 prompt가 정답을 주는 recast보다 우월).
let compose = { stage: 'hint', firstTry: null, hint: null };

function showCompose() {
  const hasKey = !!coachConfig();
  compose = { stage: 'hint', firstTry: null, hint: null };
  $('compose-input').value = '';
  $('compose-result').hidden = true;
  $('compose-result').innerHTML = '';
  $('compose-hint').hidden = hasKey;
  $('btn-judge').disabled = !hasKey;
  $('btn-judge').textContent = '판정 받기';
  $('card-compose').hidden = false;
}

function saveSentence(card, v, sentence) {
  const at = Date.now();
  const d = new Date(at);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return db.put(db.STORES.SENTENCES, {
    key: `${at}-${card.id}`,
    at,
    day,
    cardId: card.id,
    deck: card.deck,
    expression: card.title || card.frontText,
    sentence,
    firstTry: compose.firstTry,
    hint: compose.hint,
    verdict: v.verdict,
    errorType: v.errorType || 'other',
    comment: v.comment,
    better: v.better,
    pushed: 0,
  });
}

async function judgeCompose() {
  const card = state.current && state.current.card;
  const sentence = $('compose-input').value.trim();
  if (!card || !sentence) return;
  const btn = $('btn-judge');
  const box = $('compose-result');
  btn.disabled = true;
  btn.textContent = '판정 중…';
  try {
    const v = await judgeSentence({
      ...coachConfig(),
      card,
      sentence,
      stage: compose.stage,
      firstTry: compose.firstTry,
      hint: compose.hint,
    });
    const label = escapeHtml(VERDICT_LABEL[v.verdict]);
    const tag = v.errorType && v.errorType !== 'none'
      ? ` <span class="etag">${escapeHtml(ERROR_LABEL[v.errorType] || v.errorType)}</span>`
      : '';

    if (compose.stage === 'hint' && v.verdict !== 'natural') {
      // 1단: 정답을 보여주지 않고 다시 쓰게 한다.
      compose = { stage: 'full', firstTry: sentence, hint: v.hint || v.comment };
      box.innerHTML =
        `<p class="cv ${v.verdict}">${label}${tag}</p>` +
        `<p>${escapeHtml(v.hint || v.comment)}</p>` +
        '<p class="hint">정답을 보기 전에 직접 고쳐 본다 — 위 칸을 고치고 다시 누른다.</p>';
      box.hidden = false;
      $('compose-input').focus();
      btn.textContent = '고쳐서 다시';
      return;
    }

    box.innerHTML =
      `<p class="cv ${v.verdict}">${label}${tag}</p>` +
      `<p>${escapeHtml(v.comment)}</p>` +
      (compose.firstTry ? `<p class="first-try">첫 시도: ${escapeHtml(compose.firstTry)}</p>` : '') +
      (v.better && v.better.trim() !== sentence ? `<p class="better">→ ${escapeHtml(v.better)}</p>` : '');
    box.hidden = false;

    await saveSentence(card, v, sentence);
    compose = { stage: 'hint', firstTry: null, hint: null };
    btn.textContent = '다시 판정';
  } catch (e) {
    box.innerHTML = `<p class="cv wrong">${escapeHtml(e.message)}</p>`;
    box.hidden = false;
    btn.textContent = compose.stage === 'full' && compose.firstTry ? '고쳐서 다시' : '다시 판정';
  } finally {
    btn.disabled = false;
  }
}

function renderPoints(card) {
  const box = $('card-points');
  box.innerHTML =
    (card.note ? `<div class="points-note">${card.note}</div>` : '') +
    '<p class="points-tally" id="points-tally"></p>' +
    card.points
      .map(
        (p, i) =>
          `<button class="point" data-i="${i}" aria-pressed="false"><span class="box">✓</span><span>${escapeHtml(p)}</span></button>`
      )
      .join('');
  box.hidden = false;
  els('.point', box).forEach((btn) =>
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      if (state.recalled.has(i)) state.recalled.delete(i);
      else state.recalled.add(i);
      btn.setAttribute('aria-pressed', String(state.recalled.has(i)));
      updateSuggestion();
    })
  );
  updateSuggestion();
}

function suggestedGrade(ratio) {
  if (ratio >= 1) return RATING.EASY;
  if (ratio >= 0.7) return RATING.GOOD;
  if (ratio >= 0.4) return RATING.HARD;
  return RATING.AGAIN;
}

function updateSuggestion() {
  const card = state.current.card;
  if (card.type !== 'points') return;
  const total = card.points.length;
  const got = state.recalled.size;
  const ratio = total ? got / total : 0;
  const grade = suggestedGrade(ratio);
  const tally = $('points-tally');
  if (tally) {
    tally.textContent = `${got}/${total} 떠올림 — 추천: ${['', 'Again', 'Hard', 'Good', 'Easy'][grade]}`;
  }
  els('.grade').forEach((b) => b.classList.toggle('suggest', Number(b.dataset.grade) === grade));
}

async function answer(grade) {
  if (!state.revealed || !state.current) return;
  const { card, state: prev } = state.current;
  const now = Date.now();
  const before = prev ? { ...prev } : null;
  const { state: next, log } = schedule(prev || newState(), grade, now, state.fsrs);
  next.id = card.id;

  await db.put(db.STORES.STATES, next);
  await db.appendLog(card.id, log);
  state.states.set(card.id, next);
  state.logs.push({ key: db.logKey(card.id, log.at), id: card.id, ...log });
  await db.setSetting('dirty', true);

  state.undoStack.push({ cardId: card.id, before, logKey: db.logKey(card.id, log.at) });
  state.session.advance(next, now);
  nextCard();
}

async function undo() {
  const last = state.undoStack.pop();
  if (!last) return;
  if (last.before) {
    await db.put(db.STORES.STATES, last.before);
    state.states.set(last.cardId, last.before);
  } else {
    await db.del(db.STORES.STATES, last.cardId);
    state.states.delete(last.cardId);
  }
  await db.del(db.STORES.LOGS, last.logKey);
  state.logs = state.logs.filter((l) => l.key !== last.logKey);

  const card = state.cards.find((c) => c.id === last.cardId);
  state.session.queue = state.session.queue.filter((it) => it.card.id !== last.cardId);
  state.session.queue.unshift({ card, state: last.before });
  state.session.answered = Math.max(0, state.session.answered - 1);
  state.session.done.delete(last.cardId);
  toast('한 장 되돌렸다');
  nextCard();
}

async function finishSession() {
  const answered = state.session ? state.session.answered : 0;
  const minutes = Math.max(1, Math.round((Date.now() - state.sessionStart) / 60000));
  $('done-summary').textContent = `${answered}장 · ${minutes}분`;
  state.session = null;
  state.current = null;
  $('btn-done-home').textContent = state.sessionOrigin ? '코스로 돌아가기' : '홈으로';
  show('done');
  if (navigator.onLine) {
    pushQuietly();
  }
}

async function pushQuietly() {
  const client = syncClient();
  if (!client) return;
  try {
    await client.pushState();
    toast('기록을 저장소에 올렸다');
  } catch (e) {
    toast(`저장 보류: ${e.message}`);
  }
}

/* ---------- 통계 ---------- */

function streak() {
  if (!state.logs.length) return 0;
  const days = new Set(state.logs.map((l) => startOfDay(l.at)));
  const today = startOfDay(Date.now());
  let n = 0;
  let cursor = days.has(today) ? today : today - DAY;
  while (days.has(cursor)) {
    n += 1;
    cursor -= DAY;
  }
  return n;
}

function renderStats() {
  const today = startOfDay(Date.now());
  $('st-today').textContent = state.logs.filter((l) => l.at >= today).length;
  $('st-streak').textContent = streak();

  const since = Date.now() - 30 * DAY;
  const mature = state.logs.filter((l) => l.at >= since && l.state === STATE.REVIEW && l.elapsedDays >= 1);
  $('st-retention').textContent = mature.length
    ? `${Math.round((mature.filter((l) => l.grade > RATING.AGAIN).length / mature.length) * 100)}%`
    : '–';

  const f = forecast([...state.states.values()], 30);
  const max = Math.max(1, ...f.buckets);
  $('forecast').innerHTML = f.buckets
    .map(
      (n, i) =>
        `<div class="fbar ${n ? '' : 'empty'} ${i === 0 ? 'today' : ''}" style="height:${Math.max(2, (n / max) * 100)}%" title="${i}일 뒤 ${n}장"></div>`
    )
    .join('');

  const counts = { new: 0, learning: 0, review: 0, mature: 0 };
  for (const card of state.cards) {
    const s = state.states.get(card.id);
    if (!s || !s.lastReview) counts.new += 1;
    else if (s.state === STATE.LEARNING || s.state === STATE.RELEARNING) counts.learning += 1;
    else {
      counts.review += 1;
      if (s.interval >= 21) counts.mature += 1;
    }
  }
  $('st-breakdown').innerHTML = [
    ['전체', state.cards.length],
    ['신규', counts.new],
    ['학습 중', counts.learning],
    ['복습 중', counts.review],
    ['숙성 (21일 이상)', counts.mature],
    ['밀린 카드', f.overdue],
  ]
    .map(([k, v]) => `<div class="brow"><span>${k}</span><b>${v}</b></div>`)
    .join('');

  const hist = new Array(14).fill(0);
  for (const l of state.logs) {
    const offset = Math.floor((startOfDay(Date.now()) - startOfDay(l.at)) / DAY);
    if (offset >= 0 && offset < 14) hist[13 - offset] += 1;
  }
  const hmax = Math.max(1, ...hist);
  $('history').innerHTML = hist
    .map((n, i) => `<div class="fbar ${n ? '' : 'empty'} ${i === 13 ? 'today' : ''}" style="height:${Math.max(2, (n / hmax) * 100)}%" title="${n}장"></div>`)
    .join('');
}

/* ---------- 설정 ---------- */

async function renderSettings() {
  $('se-owner').value = state.config.owner;
  $('se-repo').value = state.config.repo;
  $('se-branch').value = state.config.branch;
  $('se-cards').value = state.config.cardsDir;
  $('se-review').value = state.config.reviewPath;
  $('se-token').value = '';
  $('se-anthropic').value = '';
  $('se-gemini').value = '';
  $('se-new').value = state.limits.newPerDay;
  $('se-max').value = state.limits.maxReviews;
  $('se-retention').value = state.fsrs.requestRetention;
  $('se-retention-val').textContent = `${Math.round(state.fsrs.requestRetention * 100)}%`;
  $('se-maxint').value = state.fsrs.maximumInterval;
  $('se-fuzz').checked = state.fsrs.enableFuzz;
  $('se-wfh').value = String(state.todo.wfhDow);
  $('se-version').textContent = `버전 ${APP_VERSION}`;

  const errors = await db.getSetting('parseErrors', []);
  $('se-errors').innerHTML = errors.length
    ? `${errors.length}건<ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
    : '문제 없음';

  const usage = await db.estimateUsage();
  $('se-usage').textContent = usage
    ? `사용 중 ${(usage.usage / 1048576).toFixed(1)}MB / 허용 ${(usage.quota / 1048576).toFixed(0)}MB`
    : '저장 공간 정보를 읽을 수 없다.';
}

async function saveRepoSettings() {
  state.config = {
    ...state.config,
    owner: $('se-owner').value.trim(),
    repo: $('se-repo').value.trim(),
    branch: $('se-branch').value.trim() || 'main',
    cardsDir: $('se-cards').value.trim().replace(/^\/|\/$/g, ''),
    reviewPath: $('se-review').value.trim().replace(/^\//, ''),
  };
  await db.setSetting('config', state.config);
  const token = $('se-token').value.trim();
  if (token) setToken(token);
  $('se-status').textContent = '저장했다.';
  $('se-status').className = 'status ok';
}

async function saveStudySettings() {
  state.limits = {
    newPerDay: clampInt($('se-new').value, 0, 500, 20),
    maxReviews: clampInt($('se-max').value, 10, 2000, 200),
  };
  state.fsrs = {
    requestRetention: Number($('se-retention').value),
    maximumInterval: clampInt($('se-maxint').value, 1, 36500, 36500),
    enableFuzz: $('se-fuzz').checked,
  };
  await db.setSetting('limits', state.limits);
  await db.setSetting('fsrs', state.fsrs);
  toast('학습 설정을 저장했다');
}

const clampInt = (v, lo, hi, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

async function exportData() {
  const [states, logs] = await Promise.all([db.getAll(db.STORES.STATES), db.getAll(db.STORES.LOGS)]);
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: Date.now(), states, logs }, null, 0)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `srs-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.states)) throw new Error('형식이 맞지 않는다');
    await db.bulkPut(db.STORES.STATES, data.states);
    if (Array.isArray(data.logs)) await db.bulkPut(db.STORES.LOGS, data.logs);
    await db.setSetting('dirty', true);
    await loadData();
    toast(`${data.states.length}장 가져왔다`);
    renderSettings();
  } catch (e) {
    toast(`가져오기 실패: ${e.message}`);
  }
}

/* ---------- 앱 갱신 ---------- */

// "배포 → 껐다 켜기 두 번 → CDN 10분" 을 기다리지 않는 강제 갱신 버튼.
// ① 새 서비스워커가 있으면 받아서 활성화될 때까지 기다리고
// ② 지금 워커에게 셸 파일을 캐시 우회로 다시 받게 한 뒤
// ③ 새로고침한다. 복습 기록·설정(IndexedDB)은 건드리지 않는다.
async function refreshApp() {
  const btn = $('btn-refresh-app');
  const status = $('refresh-status');
  btn.disabled = true;
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        status.textContent = '새 버전 확인 중…';
        await reg.update().catch(() => {});
        const fresh = reg.installing || reg.waiting;
        if (fresh && fresh.state !== 'activated') {
          status.textContent = '새 버전 설치 중…';
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 15000);
            fresh.addEventListener('statechange', () => {
              if (fresh.state === 'activated' || fresh.state === 'redundant') {
                clearTimeout(timer);
                resolve();
              }
            });
          });
        }
        const ctrl = navigator.serviceWorker.controller;
        if (ctrl) {
          status.textContent = '앱 파일 다시 받는 중…';
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 20000);
            const ch = new MessageChannel();
            ch.port1.onmessage = () => {
              clearTimeout(timer);
              resolve();
            };
            ctrl.postMessage({ type: 'refresh-shell' }, [ch.port2]);
          });
        }
      }
    }
    status.textContent = '새로고침…';
    location.reload();
  } catch (e) {
    btn.disabled = false;
    status.textContent = `갱신 실패: ${e.message}`;
    status.className = 'status err';
  }
}

/* ---------- 동기화 ---------- */

async function syncNow({ silent = false } = {}) {
  if (state.syncing) return;
  const client = syncClient();
  if (!client) {
    if (!silent) toast('먼저 설정에서 저장소와 토큰을 넣는다');
    return;
  }
  state.syncing = true;
  $('btn-sync').classList.add('spin');
  $('btn-sync-hub').classList.add('spin');
  try {
    const res = await client.syncAll((msg) => {
      if (!silent) toast(msg, 8000);
    });
    await loadData();
    renderHome();
    if ($('view-hub').classList.contains('active')) renderHub();
    if ($('view-course').classList.contains('active')) renderCourseView();
    if (!silent) {
      const bits = [`카드 ${res.cards.total}장`];
      if (res.cards.fetched) bits.push(`${res.cards.fetched}개 파일 갱신`);
      if (res.pulled.taken) bits.push(`기록 ${res.pulled.taken}장 받음`);
      toast(bits.join(' · '));
    }
  } catch (e) {
    toast(`동기화 실패: ${e.message}`, 5000);
  } finally {
    state.syncing = false;
    $('btn-sync').classList.remove('spin');
    $('btn-sync-hub').classList.remove('spin');
  }
}

/* ---------- 유틸 ---------- */

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const escapeAttr = escapeHtml;

/* ---------- 이벤트 ---------- */

function wire() {
  $('su-connect').addEventListener('click', async () => {
    const owner = $('su-owner').value.trim();
    const repo = $('su-repo').value.trim();
    const branch = $('su-branch').value.trim() || 'main';
    const token = $('su-token').value.trim();
    const status = $('su-status');
    if (!owner || !repo || !token) {
      status.textContent = '사용자명, 저장소, 토큰을 모두 넣는다.';
      status.className = 'status err';
      return;
    }
    status.textContent = '확인 중…';
    status.className = 'status';
    try {
      const probe = new GitHubRepo({ owner, repo, branch, token });
      await probe.verify();
      state.config = { ...state.config, owner, repo, branch };
      await db.setSetting('config', state.config);
      setToken(token);
      status.textContent = '연결됐다. 카드를 받는 중…';
      await syncNow({ silent: true });
      await renderHub();
      show('hub');
      toast(`카드 ${state.cards.length}장 준비됨`);
    } catch (e) {
      status.textContent = e.message;
      status.className = 'status err';
    }
  });

  $('btn-sync').addEventListener('click', () => syncNow());
  $('btn-settings').addEventListener('click', () => {
    renderSettings();
    show('settings');
  });
  $('btn-start').addEventListener('click', () => startSession());
  $('btn-clear-decks').addEventListener('click', () => {
    state.selectedDecks = [];
    db.setSetting('selectedDecks', state.selectedDecks);
    renderHome();
  });
  $('btn-quit').addEventListener('click', finishSession);
  $('btn-undo').addEventListener('click', undo);
  $('btn-reveal').addEventListener('click', reveal);
  $('btn-judge').addEventListener('click', judgeCompose);
  $('btn-done-home').addEventListener('click', async () => {
    await loadData();
    if (state.sessionOrigin) {
      const courseId = state.sessionOrigin;
      state.sessionOrigin = null;
      await showCourseRun(courseId); // 카드 정거장이 자동 완료로 반영된 상태로 돌아간다
    } else {
      renderHome();
      show('home');
    }
  });

  els('.grade').forEach((btn) =>
    btn.addEventListener('click', () => answer(Number(btn.dataset.grade)))
  );

  els('[data-ttab]').forEach((btn) =>
    btn.addEventListener('click', () => goTab(btn.dataset.ttab))
  );

  els('[data-lab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      renderTodoView();
      show('todo');
    })
  );

  $('btn-course-back').addEventListener('click', () => {
    renderCourseView();
    show('course');
  });
  $('btn-sync-hub').addEventListener('click', () => syncNow());

  $('se-wfh').addEventListener('change', async () => {
    state.todo.wfhDow = parseInt($('se-wfh').value, 10);
    await db.setSetting('todoConfig', state.todo);
    toast('재택 요일을 저장했다');
  });

  els('[data-go]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const to = btn.dataset.go;
      if (to === 'stats') renderStats();
      if (to === 'settings') renderSettings();
      if (to === 'home') renderHome();
      if (to === 'hub') renderHub();
      show(to);
    })
  );

  el('.card-area').addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    if (!state.revealed) reveal();
  });

  $('btn-save-repo').addEventListener('click', saveRepoSettings);
  $('btn-save-coach').addEventListener('click', () => {
    const a = $('se-anthropic').value.trim();
    const g = $('se-gemini').value.trim();
    if (a) setApiKey(a);
    if (g) setGeminiKey(g);
    const saved = [a && 'Claude', g && 'Gemini'].filter(Boolean).join(', ');
    $('coach-status').textContent = saved ? `${saved} 키를 저장했다.` : '키가 비어 있어 바꾸지 않았다.';
    $('coach-status').className = 'status ok';
  });
  $('btn-save-study').addEventListener('click', saveStudySettings);
  $('se-retention').addEventListener('input', () => {
    $('se-retention-val').textContent = `${Math.round(Number($('se-retention').value) * 100)}%`;
  });
  $('btn-verify').addEventListener('click', async () => {
    const status = $('se-status');
    const token = $('se-token').value.trim() || getToken();
    try {
      status.textContent = '확인 중…';
      status.className = 'status';
      const probe = new GitHubRepo({
        owner: $('se-owner').value.trim(),
        repo: $('se-repo').value.trim(),
        branch: $('se-branch').value.trim() || 'main',
        token,
      });
      const info = await probe.verify();
      status.textContent = `연결됨: ${info.fullName}${info.private ? ' (비공개)' : ''}`;
      status.className = 'status ok';
    } catch (e) {
      status.textContent = e.message;
      status.className = 'status err';
    }
  });

  $('btn-refresh-app').addEventListener('click', refreshApp);
  $('btn-export').addEventListener('click', exportData);
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
  $('btn-reset-local').addEventListener('click', async () => {
    if (!confirm('이 기기의 카드와 복습 기록을 지운다. 저장소에 올린 기록은 남는다. 계속할까?')) return;
    await Promise.all([
      db.clear(db.STORES.CARDS),
      db.clear(db.STORES.STATES),
      db.clear(db.STORES.LOGS),
      db.clear(db.STORES.FILES),
    ]);
    await loadData();
    toast('지웠다. 동기화하면 다시 받는다.');
    renderSettings();
  });

  document.addEventListener('keydown', (e) => {
    if (!el('#view-review').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!state.revealed) reveal();
      else answer(RATING.GOOD);
    } else if (['1', '2', '3', '4'].includes(e.key) && state.revealed) {
      answer(Number(e.key));
    } else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      undo();
    }
  });

  window.addEventListener('online', () => {
    db.getSetting('dirty', false).then((dirty) => {
      if (dirty) pushQuietly();
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      db.getSetting('dirty', false).then((dirty) => {
        if (dirty && navigator.onLine) pushQuietly();
      });
    }
  });
}

/* ---------- 시작 ---------- */

async function main() {
  await db.open();
  await loadSettings();
  await loadData();
  wire();

  if (!getToken() || !state.config.owner) {
    $('su-branch').value = state.config.branch;
    show('setup');
  } else {
    show('hub');
    await renderHub();
    if (navigator.onLine) syncNow({ silent: true });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main().catch((e) => {
  document.body.innerHTML = `<div class="wrap"><h1 class="brand">시작 실패</h1><p class="status err">${escapeHtml(e.message)}</p></div>`;
});
