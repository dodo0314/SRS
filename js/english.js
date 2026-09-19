import * as db from './db.js';
import { ENGLISH_CONTENT } from './english-content.js';
import { LESSONS, ENGLISH_KEY, FIXED_INSTRUCTIONS, TOTAL_SESSIONS, emptyState, todaySession,
  completeSession, startAtLesson, buildPrompt, goalFor, validateState, mergeStates } from './english-plan.js';
import { ASSESSMENTS, scoreAssessment, RUBRIC } from './english-assessments.js';

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const link = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
const read = async () => validateState(await db.getSetting(ENGLISH_KEY, emptyState()));
const write = state => db.setSetting(ENGLISH_KEY, validateState(state));

export async function englishOverview(date) {
  const state = await read();
  const done = Object.hasOwn(state.days, date);
  // Local calendar arithmetic, including daylight-saving boundaries.
  const day = new Date(`${date}T12:00:00`);
  const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (!done) day.setDate(day.getDate() - 1);
  let streak = 0;
  while (Object.hasOwn(state.days, key(day))) { streak++; day.setDate(day.getDate() - 1); }
  return { doneN: done ? 1 : 0, total: 1, status: done ? 'full' : 'none', streak };
}

function download(state) {
  const data = { format: 'srs-english', exportedAt: Date.now(), learning: state };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url;
  a.download = `srs-english-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function assessmentHtml(state) {
  const form = state.assessments.some(x => x.form === 'A') ? 'B' : 'A';
  const test = ASSESSMENTS[form];
  const seen = state.assessments.some(x => x.form === form);
  return `<details class="en-panel" data-assessment><summary>학습 점검 — 처음 / 4주 뒤 / 8주 뒤</summary>
    <p>처음에는 A, 4주 뒤에는 B를 사용한다. 두 과제의 난이도가 같다고 검증된 것은 아니다. 8주 뒤에는 아래 외부 평가를 사용한다. 같은 문제를 다시 풀면 재응시로 구분한다.</p>
    <p>${link('https://www.efset.org/4-skill/', '외부 평가: EF SET 네 기능 검사')} — 공식 안내에 따라 약 90분을 따로 확보한다. 듣기·읽기·말하기·쓰기 결과를 각각 보관한다. 이 앱의 점수와 합산하지 않는다.</p>
    <p>${link('https://learningenglish.voanews.com/p/5644.html', '기초 보완: VOA Level 1')} · ${link('https://www.open.edu/openlearn/education-development/english-skills-learning/content-section-overview', '다음 읽기·쓰기 과정: OpenLearn')}</p>
    <h3>${esc(test.title)}${seen ? ' — 재응시 (이미 본 문제)' : ''}</h3>
    <p>총 30분: 읽기 8분 → 쓰기 10분 → 말하기·녹음 7분 → 제출 후 점검 5분. 사전·AI·번역기 없이 먼저 답한다. 이 시간 배분은 운영 기준이다.</p>
    <p class="en-source">${esc(test.reading)}</p>
    <form data-test-form data-form="${form}">
      ${test.questions.map((q, i) => `<fieldset><legend>${i + 1}. ${esc(q.text)}</legend>${q.options.map((option, n) =>
        `<label class="en-choice"><input type="radio" name="q${i}" value="${n}" required> ${esc(option)}</label>`).join('')}</fieldset>`).join('')}
      <label>쓰기 — ${esc(test.writing)}<textarea name="writing" rows="6" maxlength="20000" required></textarea></label>
      <label>말하기 — ${esc(test.speaking)}<textarea name="speaking" rows="3" maxlength="20000" required placeholder="녹음 파일명과 도움 없이 말했는지, 막힌 점을 남긴다."></textarea></label>
      <button class="btn" type="button" data-test-draft-save>평가 답안 임시 저장</button>
      <button class="btn primary" type="submit">답안 제출 후 정답 보기</button>
    </form>
    <div data-test-result aria-live="polite"></div>
    <p>${esc(RUBRIC)}</p>
    <p>출처: 이 앱이 만든 연습 과제. 공식 시험이 아니며, 읽기 4문항은 수업 이해 점검일 뿐이다. 말하기·쓰기는 자동 채점하지 않는다.</p>
    <h3>제출 기록</h3>
    ${state.assessments.length ? state.assessments.slice(-10).reverse().map((row, i, rows) => {
      const score = scoreAssessment(row.form, row.answers);
      const earlier = state.assessments.some(x => x.form === row.form && x.at < row.at);
      return `<details><summary>${esc(new Date(row.at).toLocaleDateString())} · ${row.form} · 읽기 ${score.correct}/${score.total}${earlier ? ' · 재응시' : ''}</summary>
        <p>초안·녹음 메모 (개인 기록)</p><pre>${esc(row.writing)}\n\n${esc(row.speaking)}</pre></details>`;
    }).join('') : '<p>아직 제출 기록이 없다. 수업 시작 전 첫 답안을 남긴다.</p>'}
    <p>임시 답안은 이 기기에만 저장된다. 제출한 답안은 영어 기록 내보내기에 포함된다.</p>
  </details>`;
}

export async function renderEnglish(container, date, ctx) {
  let state = await read();
  const session = todaySession(state, date);
  const completed = Object.hasOwn(state.days, date);
  const draft = completed ? state.days[date].note : session ? (state.drafts[String(session.index)] || '') : '';
  const lesson = session?.lesson;
  container.innerHTML = `<div class="en-course">
    <p class="status">무료 원문 + AI 연습 · 하루 30분 운영안 · 과학적으로 확정된 최소 시간은 아니다</p>
    <p data-en-status role="status" aria-live="polite"></p>
    ${session ? `<h2>${session.block}번째 묶음 · ${session.day}/7회 — ${esc(session.activity.name)}</h2>
      <h3>Lesson ${lesson.number}: ${esc(lesson.title)}</h3>
      <p>오늘 목표: ${esc(goalFor(lesson))}.</p>
      ${completed ? '<p class="en-success">오늘 기록을 저장했다. 다음 학습일에 이어서 진행한다.</p>' : ''}
      <ol>${session.activity.blocks.map(([min, task]) => `<li><b>${min}분</b> — ${esc(task)}</li>`).join('')}</ol>
      ${session.review ? `<p>회상할 수업: ${link(session.review.source, session.review.title)}</p>` : ''}
      <div class="en-actions">${link(lesson.source, '원문 영상·공식 Listening Quiz 열기')}
        ${lesson.audio ? link(lesson.audio, '원음 MP3 열기') : '<span>별도 음성 링크 없음 — 원문 영상 사용</span>'}
        ${lesson.lessonPlan ? link(lesson.lessonPlan, '공식 지도안') : ''}</div>
      <p class="status">외부 영상·음성·공식 퀴즈에는 인터넷이 필요하다. 대본과 이 앱의 과제는 저장 후 오프라인에서도 열린다.</p>
      <details class="en-panel"><summary>대본 — 먼저 듣고 나서 열기</summary><pre>${esc(lesson.transcript)}</pre></details>
      <div class="en-actions"><button class="btn" data-en-prompt>오늘 자료 + AI 고정 지침 복사</button>
        <button class="btn" data-en-cards>영어 카드 복습 (회상 5분 안에서)</button></div>
      <details class="en-panel" data-prompt-preview><summary>복사할 내용 확인 / 직접 선택</summary><textarea data-prompt-text rows="8" readonly aria-label="AI 연습 지침">${esc(buildPrompt(session, draft))}</textarea></details>
      <p>현재 쓰는 AI에 붙여 넣고 직접 답한다. 위 버튼은 AI를 호출하거나 답안을 외부로 보내지 않는다. 쓰는 서비스에 따라 비용·한도가 다르다.</p>
      <label>내 답안·막힌 점·공식 퀴즈 첫 결과 (직접 입력)<textarea data-en-note rows="5" maxlength="20000" ${completed ? 'readonly' : ''}>${esc(draft)}</textarea></label>
      <div class="en-actions"><button class="btn" data-en-save ${completed ? 'disabled' : ''}>답안 임시 저장</button>
        <label>난이도 <select data-en-difficulty ${completed ? 'disabled' : ''}>
          <option value="fit">연습하기 적절함</option><option value="hard">대본도 어려움</option><option value="easy">듣기·새 상황 산출 모두 쉬움</option>
        </select></label>
        <button class="btn primary" data-en-complete ${completed ? 'disabled' : ''}>오늘 30분 활동 완료·저장</button></div>
      <p class="status">완료는 실력 인증이 아니다. 빠진 날에는 진도가 넘어가지 않고, 다음 날 같은 활동에서 이어간다. 어려우면 아래 목록에서 기초 보완·시작점을 조정한다.</p>` :
      '<h2>기본 과정의 활동을 마쳤다</h2><p>30개 수업 완료가 특정 영어 등급을 보장하지 않는다. 학습 점검의 외부 평가와 OpenLearn 다음 과정으로 연결한다.</p>'}
    ${assessmentHtml(state)}
    <details class="en-panel"><summary>교육 순서·자료 출처·시작점 조정</summary>
      <p>VOA Level 2 원래 순서 30개 수업 → 2개 수업당 7회 활동, 총 ${TOTAL_SESSIONS}회. 15주는 하루도 빠짐없이 이 속도로 했을 때의 진도 계산이며 숙달 기한이 아니다. 이해와 새로운 상황의 말하기·쓰기를 함께 보고 이동한다. Level 2는 CEFR B2를 뜻하지 않는다.</p>
      <p>1~2강은 적합성 확인이다. 대본도 어려우면 ${link('https://learningenglish.voanews.com/p/5644.html', 'Level 1')}로 보완한다. 이해만 쉽고 말이 막히면 유지한다. 모두 쉬우면 뒤 수업을 표본 확인해 시작점을 바꾼다. 완료 기록은 보존한다.</p>
      <label>다음 시작 수업 <select data-en-lesson>${LESSONS.map(l => `<option value="${l.number}" ${l.id === lesson?.id ? 'selected' : ''}>${l.number}. ${esc(l.title)}</option>`).join('')}</select></label>
      <button class="btn" data-en-jump ${completed ? 'disabled' : ''}>선택한 수업부터 시작</button>
      <ol>${LESSONS.map(l => `<li>${link(l.source, l.title)} — ${esc(goalFor(l))}</li>`).join('')}</ol>
      <p>목표와 7회 활동 배치는 앱의 각색이다. VOA 공식 수업 목표는 각 지도안에서 확인한다.</p>
      <p>대본 출처: ${link(ENGLISH_CONTENT.catalog, 'VOA Learning English')} · 수집 ${esc(ENGLISH_CONTENT.retrieved)} · ${link(ENGLISH_CONTENT.licenseUrl, '재사용 정책')}.</p>
      <p>자체 제작 Conversation 본문만 수집했다. 공백·줄바꿈을 정리했고 제삼자 기사·사진·영상 사본은 포함하지 않았다. 공개 원문과 AI 생성 연습은 구분한다.</p>
      <p>근거: ${link('https://doi.org/10.1111/lang.12479', '제2언어 분산 연습 메타분석')} · ${link('https://doi.org/10.1017/S0272263109990520', '교실 구두 교정 피드백 메타분석')}. 이 연구가 AI 채점의 정확성이나 이 과정 전체의 효과를 검증한 것은 아니다.</p>
    </details>
    <details class="en-panel"><summary>AI 고정 지침 원문</summary><pre>${esc(FIXED_INSTRUCTIONS)}</pre></details>
    <details class="en-panel"><summary>개인 학습 기록 보관·이동</summary>
      <p>답안·진도·평가는 이 기기에만 저장된다. GitHub 복습 동기화와 일반 카드 백업에는 포함되지 않는다. 아래 전용 내보내기로 보관한다. 공개 앱 파일에 개인 기록을 넣지 않는다.</p>
      <button class="btn" data-en-export>영어 기록 내보내기</button>
      <label class="btn">영어 기록 가져오기<input type="file" data-en-import accept="application/json,.json"></label>
      <p>가져오기는 기록을 합친다. 같은 날짜는 나중 저장본, 진도는 더 뒤의 위치를 유지한다. 필요하면 시작점을 다시 조정한다. 형식이 틀린 파일은 저장하지 않는다.</p>
      ${Object.entries(state.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14).map(([key, row]) => `<details><summary>${esc(key)} · ${row.index + 1}회 · ${esc(row.difficulty)}</summary><pre>${esc(row.note)}</pre></details>`).join('')}
    </details>
  </div>`;

  const status = text => { container.querySelector('[data-en-status]').textContent = text; };
  const action = (selector, fn) => container.querySelector(selector)?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await fn(); } catch (error) { status(`처리하지 못했다: ${error.message}`); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  const currentNote = () => container.querySelector('[data-en-note]')?.value || '';
  const saveDraft = async () => {
    state = await read();
    state.drafts[String(session.index)] = currentNote();
    await write(state); status('임시 답안을 이 기기에 저장했다.');
  };
  action('[data-en-save]', saveDraft);
  action('[data-en-prompt]', async () => {
    const prompt = buildPrompt(session, currentNote());
    const area = container.querySelector('[data-prompt-text]'); area.value = prompt;
    try { await navigator.clipboard.writeText(prompt); status('원문·오늘 활동·고정 지침을 복사했다. 사용하는 AI에 붙여 넣는다.'); }
    catch { container.querySelector('[data-prompt-preview]').open = true; area.focus(); area.select(); status('자동 복사를 사용할 수 없다. 열린 지침을 직접 복사한다.'); }
  });
  action('[data-en-cards]', async () => {
    if (!completed) await saveDraft();
    const decks = ctx.deckTops.en || [];
    const counts = decks.length ? ctx.cardCounts(decks) : { due: 0, new: 0 };
    if (counts.due + counts.new) ctx.startCards(decks, 'en');
    else status('오늘 남은 영어 카드가 없다. 원문을 가리고 회상한다.');
  });
  action('[data-en-complete]', async () => {
    const latest = await read();
    if (todaySession(latest, date)?.index !== session.index) throw new Error('다른 화면에서 진도가 바뀌었다. 다시 연다.');
    await write(completeSession(latest, date, currentNote(), container.querySelector('[data-en-difficulty]').value));
    await renderEnglish(container, date, ctx);
    const wrap = container.closest('.wrap');
    if (wrap) wrap.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  action('[data-en-jump]', async () => {
    if (!confirm('현재 임시 답안을 저장하고 선택한 수업으로 이동한다. 이전 완료 기록은 남는다. 진행할까?')) return;
    if (session) await saveDraft();
    await write(startAtLesson(await read(), Number(container.querySelector('[data-en-lesson]').value), date));
    await renderEnglish(container, date, ctx);
  });
  action('[data-en-export]', async () => { if (session && !completed) await saveDraft(); download(await read()); });
  container.querySelector('[data-en-import]').addEventListener('change', async event => {
    try {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) throw new Error('파일은 5 MB 이하여야 한다.');
      const data = JSON.parse(await file.text());
      if (data.format !== 'srs-english') throw new Error('영어 전용 백업 파일이 아니다.');
      const incoming = validateState(data.learning);
      if (session && !completed) await saveDraft();
      await write(mergeStates(await read(), incoming));
      await renderEnglish(container, date, ctx);
    } catch (error) { status(`가져오기 실패: ${error.message}`); }
  });

  const form = container.querySelector('[data-test-form]');
  const formId = form.dataset.form;
  const draftKey = `englishAssessmentDraft:${formId}`;
  const testDraft = await db.getSetting(draftKey, null);
  if (testDraft) {
    form.elements.writing.value = typeof testDraft.writing === 'string' ? testDraft.writing : '';
    form.elements.speaking.value = typeof testDraft.speaking === 'string' ? testDraft.speaking : '';
    for (let i = 0; i < 4; i++) if ([0, 1, 2].includes(testDraft.answers?.[i])) form.elements[`q${i}`].value = String(testDraft.answers[i]);
  }
  const answers = () => [0, 1, 2, 3].map(i => form.elements[`q${i}`].value === '' ? null : Number(form.elements[`q${i}`].value));
  action('[data-test-draft-save]', async () => {
    await db.setSetting(draftKey, { answers: answers(), writing: form.elements.writing.value, speaking: form.elements.speaking.value });
    status('평가 답안을 임시 저장했다. 아직 채점하지 않았다.');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true;
    try {
      const response = { form: formId, at: Date.now(), answers: answers(), writing: form.elements.writing.value, speaking: form.elements.speaking.value };
      const score = scoreAssessment(formId, response.answers);
      if (!response.writing.trim() || !response.speaking.trim()) throw new Error('쓰기 답안과 말하기 기록을 남긴다.');
      const latest = await read(); latest.assessments.push(response); await write(latest);
      await db.setSetting(draftKey, null);
      container.querySelector('[data-test-result]').innerHTML = `<p>저장 완료 · 읽기 ${score.correct}/${score.total}. 말하기·쓰기는 자동 채점하지 않았다.</p>` +
        ASSESSMENTS[formId].questions.map((q, i) => `<p>${i + 1}. ${esc(q.options[q.answer])}<br>근거: ${esc(q.evidence)}</p>`).join('');
      // Freeze this submission; rerendering or re-entering opens the next form.
      form.querySelectorAll('input,textarea,button').forEach(el => { el.disabled = true; });
      status('평가 답안을 저장했다. 다시 열면 기록에서 확인할 수 있다.');
    } catch (error) { button.disabled = false; status(`제출 실패: ${error.message}`); }
  });
}
