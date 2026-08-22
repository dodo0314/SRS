// 해부 탭 — L0-A 약관 구조 해부 (95-단계별-진입경로.md)
//
// 수집한 국문 약관(보통약관)을 골라 담보/면책/조건·의무/정의/절차로 직접 분류하고,
// 참조 관계를 메모하고, "보험금이 안 나오는 경로"를 목록으로 만든다.
// 워크시트는 판정을 대신하지 않는다 — 분류는 비어 있는 상태로 시작한다.
// 진행 상태는 약관별로 이 기기에만 저장한다(To-Do 체크와 같은 방침).

import * as db from './db.js';
import { SOURCES } from './dissect-data.js';

const ACTIVE_KEY = 'dissect.active';
const stateKey = (id) => `dissect.${id}`;

export const TAGS = [
  { id: 'cover', ko: '담보', key: '1' },
  { id: 'excl', ko: '면책', key: '2' },
  { id: 'duty', ko: '조건·의무', key: '3' },
  { id: 'defn', ko: '정의', key: '4' },
  { id: 'proc', ko: '절차', key: '5' },
];

const GUIDES = [
  '<b>1단계 · 색 분류 (30분)</b> — 조문마다 담보 / 면책 / 조건·의무 / 정의 중 하나. 넷에 안 들어가는 절차 조항은 <b>절차</b>로. 판정이 안 서면 <b>?</b> — 버리지 말 것, 분쟁은 그 경계에서 난다.',
  '<b>2단계 · 참조 지도 (30분)</b> — 어느 조가 어느 조를 끌어다 쓰는지 각 조문의 메모에 적는다. 손으로 다 찾은 뒤에만 결과 탭의 참조 링크로 대조한다.',
  '<b>3단계 · 안 나오는 경로 (30분)</b> — 보험금이 지급되지 않는 경로를 결과 탭에 전부 적는다. 면책 해당 · 조건 위반 · 정의에서 빠짐 · 고지의무 위반 · 시효 · 한도… <b>5개 이상이면 완료.</b>',
];
const PHASE_SEC = [1800, 1800, 1800];

/* ---------- 상태 (약관별) ---------- */

const blankState = () => ({
  tags: {}, flags: {}, notes: {},
  paths: ['', '', ''],
  phase: 0, left: [...PHASE_SEC], sub: 'clauses', xref: false,
});

let cur = SOURCES[0];       // 지금 보는 약관
let S = blankState();       // 그 약관의 진행 상태
const cache = new Map();    // sourceId → 상태 (탭 왕복 시 재로드 방지)
let saveTimer = null;
let clockTimer = null;

async function loadState(id) {
  if (cache.has(id)) { S = cache.get(id); return; }
  const saved = await db.getSetting(stateKey(id), {});
  const s = blankState();
  for (const k of Object.keys(s)) if (saved[k] !== undefined) s[k] = saved[k];
  if (!Array.isArray(s.left) || s.left.length !== 3) s.left = [...PHASE_SEC];
  cache.set(id, s);
  S = s;
}

function save() {
  clearTimeout(saveTimer);
  const id = cur.id;
  const snap = { ...S };
  saveTimer = setTimeout(() => db.setSetting(stateKey(id), snap).catch(() => {}), 300);
}

/* ---------- 마크다운 내보내기 ---------- */

export function exportMarkdown(source = cur, state = S) {
  const L = [`# L0-A 약관 해부 — ${source.name} (${source.detail.split(' · ')[0]})`, ''];
  const by = {};
  TAGS.forEach((t) => { by[t.id] = []; });
  source.clauses.forEach((c) => { const t = state.tags[c.no]; if (t) by[t].push(`제${c.no}조 ${c.title}`); });
  L.push('## 1단계 — 분류', '');
  TAGS.forEach((t) => L.push(`**${t.ko}** (${by[t.id].length}): ${by[t.id].join(' · ') || '—'}`));
  const un = source.clauses.filter((c) => !state.tags[c.no]);
  if (un.length) L.push('', `미분류 (${un.length}): ${un.map((c) => `제${c.no}조`).join(' ')}`);
  L.push('', '## 2단계 — 참조·발견 메모', '');
  const notes = source.clauses.filter((c) => (state.notes[c.no] || '').trim());
  L.push(...(notes.length
    ? notes.map((c) => `- **제${c.no}조(${c.title})** ${state.notes[c.no].trim().replace(/\n/g, ' ')}`)
    : ['_(없음)_']));
  L.push('', '## 3단계 — 보험금이 안 나오는 경로', '');
  const ps = state.paths.filter((v) => v.trim());
  L.push(ps.length ? ps.map((v, i) => `${i + 1}. ${v.trim()}`).join('\n') : '_(없음)_');
  L.push('', `완료 기준 5개 — ${ps.length >= 5 ? `충족 (${ps.length}개)` : `미충족 (${ps.length}개)`}`);
  const fl = source.clauses.filter((c) => state.flags[c.no]);
  L.push('', '## 판정 보류', '',
    fl.length ? fl.map((c) => `- 제${c.no}조(${c.title})`).join('\n') : '_(없음)_');
  return L.join('\n');
}

/* ---------- 렌더 ---------- */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 본문 속 "제N조"를 (참조 링크 토글이 켜졌을 때만) 이동 링크로
const xref = (s, maxNo) => s.replace(/제(\d{1,2})조/g, (m, n) =>
  +n >= 1 && +n <= maxNo ? `<a class="dx-ref" href="#" data-jump="${n}">${m}</a>` : m);

const fmt = (sec) => {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let root = null;
let toastFn = () => {};
const $$ = (sel) => (root ? [...root.querySelectorAll(sel)] : []);
const $1 = (sel) => (root ? root.querySelector(sel) : null);

function clauseHtml(c, maxNo) {
  const body = c.paras
    .map((p) => `<p class="lv${p.l}">${xref(esc(p.t), maxNo)}</p>`)
    .join('');
  const tags = TAGS.map((t) =>
    `<button class="dx-tag" data-tag="${t.id}" data-no="${c.no}" aria-pressed="false">${t.ko}</button>`
  ).join('');
  return `
  <article class="dx-clause" id="dxc-${c.no}" data-no="${c.no}" tabindex="0">
    <div class="dx-head">
      <span class="dx-num">제${c.no}조</span>
      <h3>${esc(c.title)}</h3>
      <button class="dx-flag" data-flag="${c.no}" aria-pressed="false" title="판정 보류">?</button>
    </div>
    <div class="dx-body">${body}</div>
    <div class="dx-tags">${tags}
      <button class="dx-note-btn" data-note="${c.no}">메모</button></div>
    <textarea class="dx-note" data-notefor="${c.no}" placeholder="참조 관계 · 발견한 것"></textarea>
  </article>`;
}

function paintClause(no) {
  const el2 = $1(`#dxc-${no}`);
  if (!el2) return;
  const tag = S.tags[no] || '';
  if (tag) el2.setAttribute('data-tag', tag);
  else el2.removeAttribute('data-tag');
  el2.classList.toggle('flagged', !!S.flags[no]);
  el2.querySelector('.dx-flag').setAttribute('aria-pressed', S.flags[no] ? 'true' : 'false');
  el2.querySelectorAll('.dx-tag').forEach((b) =>
    b.setAttribute('aria-pressed', b.dataset.tag === tag ? 'true' : 'false'));
  const note = el2.querySelector('.dx-note');
  if (S.notes[no] && note.value !== S.notes[no]) note.value = S.notes[no];
  if (S.notes[no]) note.classList.add('open');
}

function paintSummary() {
  const counts = {};
  let total = 0;
  TAGS.forEach((t) => { counts[t.id] = 0; });
  cur.clauses.forEach((c) => { const t = S.tags[c.no]; if (t) { counts[t] += 1; total += 1; } });
  const prog = $1('#dx-progress');
  if (prog) prog.textContent = `${total} / ${cur.clauses.length} 분류`;
  const meter = $1('#dx-meter');
  if (meter) {
    meter.innerHTML = TAGS.map((t) =>
      `<i class="m-${t.id}" style="width:${(counts[t.id] / cur.clauses.length) * 100}%"></i>`).join('');
  }
  const tally = $1('#dx-tally');
  if (tally) {
    tally.innerHTML = TAGS.map((t) =>
      `<div class="dx-trow"><i class="dx-dot m-${t.id}"></i><span>${t.ko}</span><b>${counts[t.id]}</b></div>`
    ).join('');
  }
  const fl = cur.clauses.filter((c) => S.flags[c.no]);
  const qbox = $1('#dx-qlist');
  if (qbox) {
    qbox.innerHTML = fl.length
      ? fl.map((c) => `<button class="dx-q" data-jump="${c.no}">제${c.no}조 ${esc(c.title)}</button>`).join('')
      : '<p class="status">? 를 눌러 둔 조문이 여기 모인다. 분쟁은 그 경계에서 난다.</p>';
  }
  const n = S.paths.filter((v) => v.trim()).length;
  const crit = $1('#dx-crit');
  if (crit) {
    crit.textContent = `완료 기준 5개 — ${n} / 5`;
    crit.classList.toggle('ok', n >= 5);
  }
}

function paintPhase() {
  $$('.dx-ph').forEach((b) => b.classList.toggle('active', +b.dataset.ph === S.phase));
  const g = $1('#dx-guide');
  if (g) g.innerHTML = GUIDES[S.phase];
  const c = $1('#dx-clock');
  if (c) c.textContent = fmt(S.left[S.phase]);
  const r = $1('#dx-run');
  if (r) r.textContent = clockTimer ? '멈춤' : '시작';
}

function paintSub() {
  $$('.dx-sub').forEach((b) => b.classList.toggle('active', b.dataset.sub === S.sub));
  const cl = $1('#dx-clauses');
  const re = $1('#dx-results');
  if (cl) cl.hidden = S.sub !== 'clauses';
  if (re) re.hidden = S.sub !== 'results';
  if (root) root.closest('.wrap')?.classList.toggle('dx-xrefs', !!S.xref);
}

function paintPaths() {
  const box = $1('#dx-paths');
  if (!box) return;
  box.innerHTML = S.paths.map((v, i) => `
    <div class="dx-path"><span>${i + 1}</span>
      <input value="${esc(v)}" data-path="${i}"
        placeholder="${i === 0 ? '예: 면책사유 해당' : '경로'}"></div>`).join('');
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
  paintPhase();
  save();
}

function jumpTo(no) {
  S.sub = 'clauses';
  paintSub();
  const el2 = $1(`#dxc-${no}`);
  if (el2) {
    el2.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el2.focus({ preventScroll: true });
  }
}

export async function renderDissect(container, { toast } = {}) {
  const activeId = await db.getSetting(ACTIVE_KEY, SOURCES[0].id);
  cur = SOURCES.find((s) => s.id === activeId) || SOURCES[0];
  await loadState(cur.id);
  root = container;
  if (toast) toastFn = toast;

  const maxNo = cur.clauses[cur.clauses.length - 1].no;
  const groups = [];
  let gwan = null;
  cur.clauses.forEach((c) => {
    if (c.gwan !== gwan) { gwan = c.gwan; if (gwan) groups.push(`<h2 class="dx-gwan">${esc(gwan)}</h2>`); }
    groups.push(clauseHtml(c, maxNo));
  });

  container.innerHTML = `
    <div class="todo-banner">
      <select class="dx-source" id="dx-source" aria-label="약관 선택">
        ${SOURCES.map((s) =>
          `<option value="${s.id}" ${s.id === cur.id ? 'selected' : ''}>${esc(s.name)} · ${s.clauses.length}개 조문</option>`).join('')}
      </select>
      <div class="todo-week">${esc(cur.detail)}</div>
      <div class="dx-meterline"><div class="dx-meter" id="dx-meter"></div>
        <span class="todo-progress" id="dx-progress"></span></div>
    </div>

    <div class="dx-phases">
      ${GUIDES.map((_, i) => `<button class="dx-ph" data-ph="${i}">${i + 1}단계</button>`).join('')}
      <span class="dx-clockbox"><b id="dx-clock" class="mono"></b>
        <button class="mini-btn" id="dx-run">시작</button>
        <button class="mini-btn" id="dx-reset">↺</button></span>
    </div>
    <p class="dx-guide" id="dx-guide"></p>

    <nav class="dx-subs">
      <button class="dx-sub" data-sub="clauses">조문</button>
      <button class="dx-sub" data-sub="results">결과</button>
    </nav>

    <div id="dx-clauses">${groups.join('')}</div>

    <div id="dx-results" hidden>
      <h2 class="section-title">분류 현황</h2>
      <div class="dx-card" id="dx-tally"></div>

      <h2 class="section-title">보험금이 안 나오는 경로</h2>
      <div class="dx-card">
        <div id="dx-paths"></div>
        <button class="mini-btn" id="dx-addpath">경로 추가</button>
        <p class="status" id="dx-crit"></p>
      </div>

      <h2 class="section-title">판정 보류 (?)</h2>
      <div class="dx-card" id="dx-qlist"></div>

      <h2 class="section-title">도구</h2>
      <div class="dx-card">
        <label class="check"><input type="checkbox" id="dx-xref"> 조문 참조 링크 표시 <span class="dx-hint">— 지도를 손으로 다 그린 뒤에만</span></label>
        <button class="btn primary block" id="dx-export">결과 복사 (마크다운)</button>
        <p class="status">복사한 마크다운을 vault의 판단일지에 붙여넣는다. 진행 상태는 약관별로 이 기기에만 저장된다.</p>
      </div>
    </div>`;

  /* 이벤트 — 컨테이너 위임 */
  container.onclick = (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) { e.preventDefault(); jumpTo(+jump.dataset.jump); return; }

    const tag = e.target.closest('.dx-tag');
    if (tag) {
      const no = tag.dataset.no;
      S.tags[no] = S.tags[no] === tag.dataset.tag ? '' : tag.dataset.tag;
      paintClause(no); paintSummary(); save(); return;
    }
    const flag = e.target.closest('.dx-flag');
    if (flag) {
      const no = flag.dataset.flag;
      S.flags[no] = !S.flags[no];
      paintClause(no); paintSummary(); save(); return;
    }
    const noteBtn = e.target.closest('.dx-note-btn');
    if (noteBtn) {
      const t = container.querySelector(`[data-notefor="${noteBtn.dataset.note}"]`);
      t.classList.toggle('open');
      if (t.classList.contains('open')) t.focus();
      return;
    }
    const ph = e.target.closest('.dx-ph');
    if (ph) { S.phase = +ph.dataset.ph; stopClock(); paintPhase(); save(); return; }
    const sub = e.target.closest('.dx-sub');
    if (sub) { S.sub = sub.dataset.sub; paintSub(); save(); return; }

    if (e.target.id === 'dx-run') {
      if (clockTimer) { stopClock(); return; }
      clockTimer = setInterval(() => {
        S.left[S.phase] -= 1;
        const c = $1('#dx-clock');
        if (c) c.textContent = fmt(S.left[S.phase]);
        if (S.left[S.phase] % 5 === 0) save();
        if (S.left[S.phase] <= 0) { stopClock(); toastFn('시간 끝 — 다음 단계로'); }
      }, 1000);
      paintPhase();
      return;
    }
    if (e.target.id === 'dx-reset') {
      stopClock(); S.left[S.phase] = PHASE_SEC[S.phase]; paintPhase(); save(); return;
    }
    if (e.target.id === 'dx-addpath') {
      S.paths.push(''); paintPaths(); save();
      const ins = $$('#dx-paths input'); ins[ins.length - 1]?.focus();
      return;
    }
    if (e.target.id === 'dx-export') {
      const md = exportMarkdown();
      const done = () => toastFn('복사했다 — vault에 붙여넣는다');
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(md).then(done).catch(() => {
          window.prompt('복사가 막혔다. 아래 내용을 직접 복사:', md);
        });
      } else window.prompt('아래 내용을 직접 복사:', md);
    }
  };

  container.oninput = (e) => {
    if (e.target.matches('.dx-note')) {
      S.notes[e.target.dataset.notefor] = e.target.value; save(); return;
    }
    if (e.target.matches('[data-path]')) {
      S.paths[+e.target.dataset.path] = e.target.value;
      const n = S.paths.filter((v) => v.trim()).length;
      const crit = $1('#dx-crit');
      if (crit) {
        crit.textContent = `완료 기준 5개 — ${n} / 5`;
        crit.classList.toggle('ok', n >= 5);
      }
      save();
    }
  };
  container.onchange = async (e) => {
    if (e.target.id === 'dx-xref') { S.xref = e.target.checked; paintSub(); save(); return; }
    if (e.target.id === 'dx-source') {
      stopClock();
      await db.setSetting(ACTIVE_KEY, e.target.value);
      renderDissect(container, { toast: toastFn });
    }
  };

  // 키보드(데스크톱): 조문 포커스 상태에서 1~5 태그, 0 해제, / 보류
  container.onkeydown = (e) => {
    const card = e.target.closest?.('.dx-clause');
    if (!card || e.target.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey) return;
    const no = card.dataset.no;
    const i = '12345'.indexOf(e.key);
    if (i > -1) S.tags[no] = TAGS[i].id;
    else if (e.key === '0') S.tags[no] = '';
    else if (e.key === '/' || e.key === '?') S.flags[no] = !S.flags[no];
    else return;
    e.preventDefault();
    paintClause(no); paintSummary(); save();
  };

  const x = $1('#dx-xref');
  if (x) x.checked = !!S.xref;
  cur.clauses.forEach((c) => paintClause(c.no));
  paintSummary(); paintPaths(); paintPhase(); paintSub();
}
