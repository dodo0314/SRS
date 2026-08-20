// 작문 코치 — 영어 카드에서 학습자가 만든 문장을 판정받는다.
//
// 제공자는 둘이다: Claude(Sonnet, 유료 크레딧)와 Gemini(Flash, 무료 티어).
// 설정에 넣은 키 쪽을 쓰고, 둘 다 있으면 Claude를 쓴다.
// API 키는 GitHub 토큰과 같은 방식으로 이 기기의 브라우저에만 저장된다.
// 판정 결과와 문장은 IndexedDB에 쌓였다가 동기화 때 저장소의 월별 파일로 올라간다.

export const COACH_MODEL = 'claude-sonnet-5';
export const GEMINI_MODEL = 'gemini-3.6-flash';
const API_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// 구조화 출력 스키마. 응답이 이 형태의 JSON임을 API가 보장한다.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'comment', 'better'],
  properties: {
    verdict: { type: 'string', enum: ['natural', 'minor', 'wrong'] },
    comment: { type: 'string' },
    better: { type: 'string' },
  },
};

// Gemini 구조화 출력 스키마. OpenAPI 형식이라 타입 이름이 대문자다.
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  required: ['verdict', 'comment', 'better'],
  properties: {
    verdict: { type: 'STRING', enum: ['natural', 'minor', 'wrong'] },
    comment: { type: 'STRING' },
    better: { type: 'STRING' },
  },
};

export const VERDICT_LABEL = {
  natural: '✅ 자연스럽다',
  minor: '⚠️ 다듬을 점',
  wrong: '❌ 틀렸다',
};

export function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildPrompt(card, sentence) {
  const expression = card.title || card.frontText || '';
  const meaning = stripHtml(card.back);
  return [
    '당신은 한국인 학습자의 영어 작문을 교정하는 코치다.',
    '',
    `학습 항목: ${expression}`,
    meaning ? `항목 설명(카드 뒷면): ${meaning}` : null,
    `학습자가 이 항목을 써서 만든 문장: ${sentence}`,
    '',
    '판정 기준:',
    '- natural: 문법이 맞고, 학습 항목을 올바른 뜻으로 썼으며, 원어민에게 자연스럽다',
    '- minor: 뜻은 통하지만 관사·시제·어순·연어 등 다듬을 점이 있다',
    '- wrong: 문법이 틀렸거나, 학습 항목을 안 썼거나 잘못된 뜻으로 썼다',
    '',
    'comment는 한국어 한두 문장으로 쓴다. 덕담 없이 구체적으로 지적한다.',
    'better에는 같은 뜻을 자연스럽게 다듬은 문장을 쓴다. natural이면 원문을 그대로 둔다.',
  ].filter((l) => l !== null).join('\n');
}

/** 응답 본문에서 판정 JSON을 꺼낸다. 형태가 어긋나면 사람이 읽을 오류를 던진다. */
export function readVerdict(body) {
  if (body && body.stop_reason === 'refusal') {
    throw new Error('판정이 거부됐다. 문장을 바꿔 다시 시도할 것.');
  }
  const text = ((body && body.content) || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('판정 응답을 읽을 수 없다. 잠시 후 다시 시도할 것.');
  }
  if (!VERDICT_LABEL[json.verdict]) {
    throw new Error('판정 응답이 예상한 형태가 아니다.');
  }
  return { verdict: json.verdict, comment: String(json.comment || ''), better: String(json.better || '') };
}

function messageFor(status, body) {
  const apiMsg = body && body.error && body.error.message;
  if (status === 401) return 'API 키가 유효하지 않다. 설정에서 다시 넣을 것.';
  if (status === 429) return '요청 한도 초과. 잠시 후 다시 시도할 것.';
  if (status === 529) return 'API가 혼잡하다. 잠시 후 다시 시도할 것.';
  if (status >= 500) return `API 오류 ${status}. 잠시 후 다시 시도할 것.`;
  return apiMsg ? `판정 실패: ${apiMsg}` : `판정 실패 (${status})`;
}

/**
 * 문장 하나를 판정받는다. provider에 따라 Claude 또는 Gemini를 호출한다.
 * @returns {Promise<{verdict: string, comment: string, better: string}>}
 */
export async function judgeSentence({ provider = 'anthropic', apiKey, card, sentence, fetchFn = fetch }) {
  if (provider === 'gemini') return judgeGemini({ apiKey, card, sentence, fetchFn });
  return judgeAnthropic({ apiKey, card, sentence, fetchFn });
}

async function judgeAnthropic({ apiKey, card, sentence, fetchFn, model = COACH_MODEL }) {
  const res = await fetchFn(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // 브라우저에서 직접 호출한다. 키는 이 기기에만 있고 앱은 정적 파일이라 서버가 없다.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      // 짧은 교정 판정이라 effort는 낮춘다. 형식은 스키마로 강제한다.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
      messages: [{ role: 'user', content: buildPrompt(card, sentence) }],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(messageFor(res.status, body));
  return readVerdict(body);
}

/** Gemini 응답에서 판정 JSON을 꺼낸다. */
export function readGeminiVerdict(body) {
  const blocked = body && body.promptFeedback && body.promptFeedback.blockReason;
  const cand = body && body.candidates && body.candidates[0];
  if (blocked || !cand || cand.finishReason === 'SAFETY') {
    throw new Error('판정이 거부됐다. 문장을 바꿔 다시 시도할 것.');
  }
  const text = ((cand.content && cand.content.parts) || [])
    .map((p) => p.text || '')
    .join('');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('판정 응답을 읽을 수 없다. 잠시 후 다시 시도할 것.');
  }
  if (!VERDICT_LABEL[json.verdict]) {
    throw new Error('판정 응답이 예상한 형태가 아니다.');
  }
  return { verdict: json.verdict, comment: String(json.comment || ''), better: String(json.better || '') };
}

function geminiMessageFor(status, body) {
  const apiMsg = body && body.error && body.error.message;
  if (status === 400 && /API key/i.test(apiMsg || '')) return 'Gemini API 키가 유효하지 않다. 설정에서 다시 넣을 것.';
  if (status === 403) return 'Gemini API 키가 유효하지 않거나 권한이 없다.';
  if (status === 429) return 'Gemini 무료 한도 초과. 잠시 후 다시 시도할 것.';
  if (status >= 500) return `Gemini 오류 ${status}. 잠시 후 다시 시도할 것.`;
  return apiMsg ? `판정 실패: ${apiMsg}` : `판정 실패 (${status})`;
}

async function judgeGemini({ apiKey, card, sentence, fetchFn, noThinkingConfig = false }) {
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: GEMINI_SCHEMA,
  };
  // 짧은 판정에 사고 토큰은 낭비다. 무료 한도도 아낀다.
  if (!noThinkingConfig) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const res = await fetchFn(GEMINI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(card, sentence) }] }],
      generationConfig,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // 모델 세대가 바뀌면 thinkingConfig를 거부할 수 있다. 그 경우만 빼고 한 번 재시도.
    const msg = (body && body.error && body.error.message) || '';
    if (res.status === 400 && !noThinkingConfig && /thinking/i.test(msg)) {
      return judgeGemini({ apiKey, card, sentence, fetchFn, noThinkingConfig: true });
    }
    throw new Error(geminiMessageFor(res.status, body));
  }
  return readGeminiVerdict(body);
}

/* ---------- 저장소에 올릴 월별 기록 파일 ---------- */

export function formatEntry(e) {
  const icon = { natural: '✅', minor: '⚠️', wrong: '❌' }[e.verdict] || '❓';
  const lines = [`- **${e.expression}** — ${e.sentence}`, `  - ${icon} ${e.comment}`];
  if (e.better && e.better.trim() && e.better.trim() !== e.sentence.trim()) {
    lines.push(`  - 다듬기: ${e.better}`);
  }
  return lines.join('\n');
}

/**
 * 기존 파일 뒤에 새 문장들을 날짜 절 아래로 이어 붙인다.
 * entries는 시각순이어야 하고, 각 entry에 day(YYYY-MM-DD)가 있어야 한다.
 */
export function appendSentences(existing, entries, month) {
  let out = String(existing || '').replace(/\s+$/, '');
  if (!out) out = `# 작문 기록 ${month}`;
  const headings = [...out.matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gm)];
  let lastDay = headings.length ? headings[headings.length - 1][1] : null;
  for (const e of entries) {
    if (e.day !== lastDay) {
      out += `\n\n## ${e.day}`;
      lastDay = e.day;
    }
    out += `\n\n${formatEntry(e)}`;
  }
  return `${out}\n`;
}
