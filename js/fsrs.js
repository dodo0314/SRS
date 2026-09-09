// FSRS 스케줄러
//
// Free Spaced Repetition Scheduler의 장기/단기 기억 모델을 구현한다.
// 파라미터와 수식은 FSRS-5 기준이며, 실패 후 안정성은 직전 안정성을 넘지
// 못하도록 보수적으로 제한했다.
//
// 상태 한 장은 { stability, difficulty, due, lastReview, reps, lapses, state }.
// stability는 "이 카드를 90% 확률로 기억할 수 있는 일수"에 해당한다.

export const RATING = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };
export const STATE = { NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 };

export const DEFAULT_WEIGHTS = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

const DECAY = -0.5;
const FACTOR = 19 / 81; // 0.9 ** (1 / DECAY) - 1
const DAY = 86400000;
const MIN_STABILITY = 0.01;
const MAX_STABILITY = 36500;

export const DEFAULT_OPTIONS = {
  weights: DEFAULT_WEIGHTS,
  requestRetention: 0.9,
  maximumInterval: 36500,
  enableFuzz: true,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 하루의 시작(로컬 자정).
 *
 * 이 앱의 하루 경계는 여기 한 곳에서만 정한다 — queue.js의 큐 마감·신규 한도·예보가
 * 이 함수를 그대로 가져다 쓴다. 경계를 자정이 아닌 시각("하루는 04시에 시작")으로
 * 옮기고 싶으면 이 함수만 고치면 스케줄러와 큐가 함께 따라온다.
 */
export function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 두 시각 사이에 놓인 날짜 경계의 수.
 *
 * 어제 22:00에 본 카드를 오늘 08:00에 보면 0.42가 아니라 **1일**이다.
 * FSRS/Anki가 경과 일수를 세는 방식이고, 실시간 소수로 재면 하루를 넘긴 복습이
 * 「같은 날 재복습」으로 잘못 분류돼 회상 확률이 통째로 버려진다.
 * 서머타임 등으로 하루가 23·25시간이 되는 경우가 있어 round로 맞춘다.
 */
export function dayDiff(from, to) {
  if (!from) return 0;
  return Math.max(0, Math.round((startOfDay(to) - startOfDay(from)) / DAY));
}

/** 새 카드의 초기 상태. */
export function newState() {
  return {
    stability: 0,
    difficulty: 0,
    due: 0,
    lastReview: 0,
    reps: 0,
    lapses: 0,
    state: STATE.NEW,
    interval: 0,
  };
}

/**
 * 경과 일수 t가 지난 시점의 회상 확률.
 * t=0이면 1, t가 stability와 같으면 0.9.
 */
export function retrievability(stability, elapsedDays) {
  if (!stability || stability <= 0) return 0;
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

/** 목표 유지율 r을 만족하는 복습 간격(일). */
function intervalFromStability(stability, requestRetention) {
  return (stability / FACTOR) * (Math.pow(requestRetention, 1 / DECAY) - 1);
}

function initialStability(w, grade) {
  return clamp(w[grade - 1], MIN_STABILITY, MAX_STABILITY);
}

function initialDifficulty(w, grade) {
  return clamp(w[4] - Math.exp(w[5] * (grade - 1)) + 1, 1, 10);
}

function nextDifficulty(w, difficulty, grade) {
  const delta = -w[6] * (grade - 3);
  // 난이도가 양끝에 가까울수록 변화폭을 줄인다(선형 감쇠).
  const damped = difficulty + delta * ((10 - difficulty) / 9);
  // 쉬움(4) 기준값 쪽으로 평균 회귀시켜 난이도가 한쪽으로 쏠리는 것을 막는다.
  const reverted = w[7] * initialDifficulty(w, 4) + (1 - w[7]) * damped;
  return clamp(reverted, 1, 10);
}

function stabilityAfterRecall(w, difficulty, stability, r, grade) {
  const hardPenalty = grade === RATING.HARD ? w[15] : 1;
  const easyBonus = grade === RATING.EASY ? w[16] : 1;
  const growth =
    Math.exp(w[8]) *
    (11 - difficulty) *
    Math.pow(stability, -w[9]) *
    (Math.exp((1 - r) * w[10]) - 1) *
    hardPenalty *
    easyBonus;
  return clamp(stability * (1 + growth), MIN_STABILITY, MAX_STABILITY);
}

function stabilityAfterLapse(w, difficulty, stability, r) {
  const s =
    w[11] *
    Math.pow(difficulty, -w[12]) *
    (Math.pow(stability + 1, w[13]) - 1) *
    Math.exp((1 - r) * w[14]);
  // 잊은 뒤의 안정성이 잊기 전보다 높아질 수는 없다.
  return clamp(Math.min(s, stability), MIN_STABILITY, MAX_STABILITY);
}

/** 같은 날 다시 볼 때의 안정성 갱신. */
function stabilityShortTerm(w, stability, grade) {
  const s = stability * Math.exp(w[17] * (grade - 3 + w[18]));
  return clamp(s, MIN_STABILITY, MAX_STABILITY);
}

/**
 * 간격이 같은 날짜에 몰리지 않도록 약간 흩뜨린다.
 * Anki와 같은 방식으로 구간별 폭을 다르게 준다.
 */
function applyFuzz(interval, rand) {
  if (interval < 2.5) return interval;
  let ratio;
  if (interval < 7) ratio = 0.15;
  else if (interval < 20) ratio = 0.1;
  else ratio = 0.05;
  const delta = Math.max(1, interval * ratio);
  const min = Math.max(2, Math.round(interval - delta));
  const max = Math.round(interval + delta);
  return min + Math.floor(rand() * (max - min + 1));
}

/**
 * 한 번의 평가를 반영해 새 상태를 만든다.
 *
 * @param {object} state   현재 상태 (newState() 형태)
 * @param {number} grade   RATING 값 1~4
 * @param {number} now     현재 시각 (ms)
 * @param {object} options DEFAULT_OPTIONS 참조
 * @returns {{state: object, log: object}}
 */
export function schedule(state, grade, now = Date.now(), options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const w = opt.weights;
  const rand = opt.random || Math.random;

  const prev = state || newState();
  const isNew = prev.state === STATE.NEW || !prev.lastReview;
  // 경과 일수는 날짜 경계로 센다(dayDiff). 회상 확률도 이 정수 일수로 계산한다 —
  // FSRS의 가중치는 "예정된 경과 일수"(정수)로 학습된 값이라, 실시간 소수를 넣으면
  // 파라미터가 가정한 입력과 어긋난다.
  const elapsedDays = isNew ? 0 : dayDiff(prev.lastReview, now);
  const r = isNew ? 0 : retrievability(prev.stability, elapsedDays);

  let difficulty;
  let stability;

  if (isNew) {
    difficulty = initialDifficulty(w, grade);
    stability = initialStability(w, grade);
  } else {
    difficulty = nextDifficulty(w, prev.difficulty, grade);
    if (elapsedDays === 0) {
      // 같은 날짜에 다시 본 경우. 장기 모델을 적용하면 간격이 과대평가된다.
      // 날짜가 하루라도 바뀌었으면(어젯밤 → 오늘 아침 포함) 아래 장기 공식으로 간다.
      stability = stabilityShortTerm(w, prev.stability, grade);
    } else if (grade === RATING.AGAIN) {
      stability = stabilityAfterLapse(w, difficulty, prev.stability, r);
    } else {
      stability = stabilityAfterRecall(w, difficulty, prev.stability, r, grade);
    }
  }

  let rawInterval = intervalFromStability(stability, opt.requestRetention);
  let nextState;
  let due;
  let interval;

  if (grade === RATING.AGAIN) {
    // 틀린 카드는 날짜와 무관하게 이번 세션에서 한 번 더 본다.
    nextState = prev.state === STATE.NEW ? STATE.LEARNING : STATE.RELEARNING;
    interval = 0;
    due = now + 10 * 60000;
  } else if (rawInterval < 1) {
    // 아직 하루를 못 버티는 카드. 세션 안에서 다시 돌린다.
    nextState = prev.state === STATE.NEW ? STATE.LEARNING : prev.state;
    interval = 0;
    due = now + Math.max(5, Math.round(rawInterval * 24 * 60)) * 60000;
  } else {
    if (opt.enableFuzz) rawInterval = applyFuzz(rawInterval, rand);
    interval = clamp(Math.round(rawInterval), 1, opt.maximumInterval);
    nextState = STATE.REVIEW;
    due = now + interval * DAY;
  }

  const next = {
    stability,
    difficulty,
    due,
    lastReview: now,
    reps: (prev.reps || 0) + 1,
    lapses: (prev.lapses || 0) + (grade === RATING.AGAIN && prev.state === STATE.REVIEW ? 1 : 0),
    state: nextState,
    interval,
  };

  const log = {
    grade,
    at: now,
    elapsedDays: Number(elapsedDays.toFixed(4)),
    retrievability: Number(r.toFixed(4)),
    stability: Number(stability.toFixed(4)),
    difficulty: Number(difficulty.toFixed(4)),
    interval,
    state: prev.state,
  };

  return { state: next, log };
}

/**
 * 평가하지 않고 각 버튼의 예상 간격만 계산한다. 버튼 라벨에 쓴다.
 *
 * state.interval은 하루 미만이면 0이라 버튼이 전부 "10분"으로 보인다 —
 * 실제로는 13시간 뒤일 수 있다. 그래서 schedule()이 실제로 잡는 due에서
 * 거꾸로 계산한다(수식을 여기서 다시 쓰지 않는다). 단위는 일이고 하루 미만은
 * 소수로 나온다. 퍼지는 끄므로 하루 이상은 정수가 된다.
 */
export function previewIntervals(state, now = Date.now(), options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options, enableFuzz: false };
  const out = {};
  for (const g of [RATING.AGAIN, RATING.HARD, RATING.GOOD, RATING.EASY]) {
    out[g] = (schedule(state, g, now, opt).state.due - now) / DAY;
  }
  return out;
}

/** 간격(일)을 사람이 읽는 표기로. 하루 미만은 분·시간으로 적는다. */
export function formatInterval(days) {
  if (!days || days <= 0) return '10분';
  if (days < 1) {
    const minutes = Math.max(1, Math.round(days * 24 * 60));
    if (minutes < 60) return `${minutes}분`;
    const hours = minutes / 60;
    return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}시간`;
  }
  const d = Math.round(days);
  if (d < 30) return `${d}일`;
  if (d < 365) return `${(d / 30).toFixed(d < 90 ? 1 : 0)}개월`;
  return `${(d / 365).toFixed(1)}년`;
}
