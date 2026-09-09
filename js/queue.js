// 복습 큐
//
// 오늘 볼 카드를 고르고 세션 안에서의 순서를 관리한다.
// 저장소 접근은 하지 않는다. 순수 함수와 세션 객체만 둔다.

import { STATE, startOfDay } from './fsrs.js';

const DAY = 86400000;

// 하루 경계의 정의는 fsrs.js에 하나만 둔다. 스케줄러가 경과 일수를 세는 경계와
// 큐가 "오늘"을 자르는 경계가 어긋나면, 하루를 넘긴 복습이 단기 공식을 타는
// 종류의 어긋남이 다시 생긴다.
export { startOfDay };

/** 오늘 자정 직전(로컬 시각). startOfDay와 같은 날의 끝이다. */
export function endOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * 지금 이 카드를 꺼낼 때인가.
 *
 * 복습 카드(하루 이상 간격)는 종전대로 "오늘 안에 예정돼 있으면" 꺼낸다 —
 * 아침에 열어도 그날 몫이 다 나와야 한다.
 * 학습·재학습 단계의 하루 미만 카드는 **예정 시각이 지나야** 꺼낸다. 하루 끝까지
 * 당겨 버리면 13시간 뒤로 잡힌 카드가 세션을 다시 열자마자 나오고, 그 자리에서
 * Good 두 번이면 학습 단계를 건너뛰고 하루 간격으로 졸업한다.
 */
export function isDueNow(state, now = Date.now()) {
  if (!state || !state.lastReview) return false;
  const learning = state.state === STATE.LEARNING || state.state === STATE.RELEARNING;
  const subDay = learning && !state.interval;
  return state.due <= (subDay ? now : endOfDay(now));
}

/** 덱 선택은 계층 접두사로 동작한다. "재물"을 고르면 "재물/보험업법"도 포함된다. */
export function deckMatches(deck, selected) {
  if (!selected || !selected.length) return true;
  return selected.some((s) => deck === s || deck.startsWith(`${s}/`));
}

/** 오늘 처음 꺼낸 카드 수. 신규 한도 계산에 쓴다. */
export function countIntroducedToday(logs, now = Date.now()) {
  const from = startOfDay(now);
  const seen = new Set();
  for (const l of logs) {
    if (l.at >= from && l.state === STATE.NEW) seen.add(l.id);
  }
  return seen.size;
}

export const DEFAULT_LIMITS = { newPerDay: 20, maxReviews: 200 };

/**
 * 오늘의 큐를 만든다.
 *
 * @param {object[]} cards  카드 본문
 * @param {Map|object} states  카드ID → 복습 상태
 * @param {object} opts { now, decks, tags, newPerDay, maxReviews, introducedToday }
 */
export function buildQueue(cards, states, opts = {}) {
  const now = opts.now ?? Date.now();
  const limits = { ...DEFAULT_LIMITS, ...opts };
  const stateOf = states instanceof Map ? (id) => states.get(id) : (id) => states[id];

  const due = [];
  const fresh = [];
  let dueTotal = 0;
  let newTotal = 0;

  for (const card of cards) {
    if (!deckMatches(card.deck, opts.decks)) continue;
    if (opts.tags && opts.tags.length && !opts.tags.some((t) => card.tags.includes(t))) continue;

    const state = stateOf(card.id);
    if (!state || !state.lastReview) {
      newTotal += 1;
      fresh.push({ card, state: null });
      continue;
    }
    if (isDueNow(state, now)) {
      dueTotal += 1;
      due.push({ card, state });
    }
  }

  due.sort((a, b) => a.state.due - b.state.due);
  fresh.sort((a, b) => (a.card.file === b.card.file ? a.card.line - b.card.line : a.card.file.localeCompare(b.card.file)));

  const newAllowance = Math.max(0, limits.newPerDay - (opts.introducedToday || 0));
  const takenNew = fresh.slice(0, newAllowance);
  const takenDue = due.slice(0, limits.maxReviews);

  return {
    items: interleave(takenDue, takenNew),
    counts: {
      due: takenDue.length,
      new: takenNew.length,
      dueTotal,
      newTotal,
      dueHeld: dueTotal - takenDue.length,
      newHeld: newTotal - takenNew.length,
    },
  };
}

/** 신규 카드를 복습 사이에 고르게 섞는다. 뒤로 몰리면 세션 끝이 힘들어진다. */
function interleave(due, fresh) {
  if (!fresh.length) return due;
  if (!due.length) return fresh;
  const out = [];
  const gap = Math.max(1, Math.floor(due.length / fresh.length));
  let n = 0;
  due.forEach((item, i) => {
    out.push(item);
    if (n < fresh.length && (i + 1) % gap === 0) out.push(fresh[n++]);
  });
  while (n < fresh.length) out.push(fresh[n++]);
  return out;
}

/**
 * 한 번의 복습 세션. 틀린 카드를 세션 안에서 다시 돌리는 책임을 진다.
 */
export class Session {
  constructor(items = []) {
    this.queue = [...items];
    this.done = new Set();
    this.answered = 0;
    this.again = 0;
  }

  get remaining() {
    return this.queue.length;
  }

  peek() {
    return this.queue[0] || null;
  }

  /**
   * 현재 카드를 처리했다고 표시한다.
   * requeueAt이 오늘 안이면 세션 뒤쪽에 다시 넣는다.
   */
  advance(newState, now = Date.now()) {
    const item = this.queue.shift();
    if (!item) return null;
    this.answered += 1;
    const soon = newState && newState.due <= now + 20 * 60000;
    if (soon) {
      this.again += newState.interval === 0 ? 1 : 0;
      const pos = Math.min(this.queue.length, 3);
      this.queue.splice(pos, 0, { card: item.card, state: newState });
    } else {
      this.done.add(item.card.id);
    }
    return item;
  }

  /** 지금 남은 카드의 종류별 수. 화면 상단 카운터. */
  counts(now = Date.now()) {
    let fresh = 0;
    let learning = 0;
    let review = 0;
    for (const item of this.queue) {
      if (!item.state || !item.state.lastReview) fresh += 1;
      else if (item.state.state === STATE.LEARNING || item.state.state === STATE.RELEARNING) learning += 1;
      else review += 1;
    }
    return { new: fresh, learning, review, total: this.queue.length };
  }
}

/** 앞으로 며칠 동안 몇 장이 예정돼 있는지. 통계 화면에 쓴다. */
export function forecast(states, days = 30, now = Date.now()) {
  const start = startOfDay(now);
  const buckets = new Array(days).fill(0);
  let overdue = 0;
  for (const s of states) {
    if (!s.lastReview) continue;
    const offset = Math.floor((s.due - start) / DAY);
    if (offset < 0) overdue += 1;
    else if (offset < days) buckets[offset] += 1;
  }
  return { buckets, overdue };
}
