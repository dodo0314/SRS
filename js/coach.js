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

// 오류 유형. 집계해서 카드 표적을 정하는 데 쓴다 — 영어학습 2-1절.
export const ERROR_TYPES = ['article', 'agreement', 'clause', 'preposition', 'collocation', 'word-choice', 'spelling', 'none', 'other'];

export const ERROR_LABEL = {
  article: '관사', agreement: '동사 형태·수일치', clause: '절 연결', preposition: '전치사',
  collocation: '연어·병렬', 'word-choice': '어휘 선택', spelling: '철자', none: '—', other: '기타',
};

// 구조화 출력 스키마. 응답이 이 형태의 JSON임을 API가 보장한다.
// 2단계로 나뉜다: 1단(hint)은 정답을 주지 않고 어디가 틀렸는지만 짚는다.
// Lyster & Saito(2010) 메타분석 — 정답을 되돌려주는 recast보다 스스로 고치게 하는 prompt가 우월하다.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'errorType', 'comment', 'better'],
  properties: {
    verdict: { type: 'string', enum: ['natural', 'minor', 'wrong'] },
    errorType: { type: 'string', enum: ERROR_TYPES },
    comment: { type: 'string' },
    better: { type: 'string' },
  },
};

const HINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'errorType', 'hint'],
  properties: {
    verdict: { type: 'string', enum: ['natural', 'minor', 'wrong'] },
    errorType: { type: 'string', enum: ERROR_TYPES },
    hint: { type: 'string' },
  },
};

// Gemini 구조화 출력 스키마. OpenAPI 형식이라 타입 이름이 대문자다.
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  required: ['verdict', 'errorType', 'comment', 'better'],
  properties: {
    verdict: { type: 'STRING', enum: ['natural', 'minor', 'wrong'] },
    errorType: { type: 'STRING', enum: ERROR_TYPES },
    comment: { type: 'STRING' },
    better: { type: 'STRING' },
  },
};

const GEMINI_HINT_SCHEMA = {
  type: 'OBJECT',
  required: ['verdict', 'errorType', 'hint'],
  properties: {
    verdict: { type: 'STRING', enum: ['natural', 'minor', 'wrong'] },
    errorType: { type: 'STRING', enum: ERROR_TYPES },
    hint: { type: 'STRING' },
  },
};

const schemaFor = (stage, gemini) =>
  stage === 'hint' ? (gemini ? GEMINI_HINT_SCHEMA : HINT_SCHEMA) : (gemini ? GEMINI_SCHEMA : VERDICT_SCHEMA);

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

export function buildPrompt(card, sentence, { stage = 'full', firstTry = null, hint = null } = {}) {
  const expression = card.title || card.frontText || '';
  const meaning = stripHtml(card.back);
  const head = [
    '당신은 한국인 학습자의 영어 작문을 교정하는 코치다.',
    '',
    `학습 항목: ${expression}`,
    meaning ? `항목 설명(카드 뒷면): ${meaning}` : null,
    firstTry ? `학습자의 첫 시도: ${firstTry}` : null,
    hint ? `그때 준 힌트: ${hint}` : null,
    `${firstTry ? '고쳐 쓴 문장' : '학습자가 이 항목을 써서 만든 문장'}: ${sentence}`,
    '',
    '판정 기준:',
    '- natural: 문법이 맞고, 학습 항목을 올바른 뜻으로 썼으며, 원어민에게 자연스럽다',
    '- minor: 뜻은 통하지만 관사·시제·어순·연어 등 다듬을 점이 있다',
    '- wrong: 문법이 틀렸거나, 학습 항목을 안 썼거나 잘못된 뜻으로 썼다',
    '',
    'errorType은 가장 두드러진 오류 하나를 고른다:',
    'article(관사 a/an/the) · agreement(동사 형태·수일치) · clause(절 연결·문장 조각·comma splice) ·',
    'preposition(전치사) · collocation(연어·병렬) · word-choice(어휘 선택) · spelling(철자) · other.',
    'natural이면 none.',
    '',
  ];

  const tail = stage === 'hint'
    ? [
        '**이 단계에서는 정답 문장을 절대 알려주지 않는다.**',
        'hint에는 한국어 한두 문장으로 "어디가" 잘못됐는지만 짚는다 — 학습자가 스스로 고칠 수 있을 만큼만.',
        '예: "두 번째 절의 명사 앞에 빠진 것이 있다", "동사 형태가 주어와 맞지 않는다".',
        '고쳐 쓴 영어 표현이나 정답 단어를 hint에 넣지 않는다. 위치와 종류만 말한다.',
        'natural이면 hint에 무엇이 좋았는지 한 문장으로 적는다.',
      ]
    : [
        'comment는 한국어 한두 문장으로 쓴다. 덕담 없이 구체적으로 지적하되, 학습 항목을 제대로 썼는지부터 짚는다.',
        'better에는 같은 뜻을 자연스럽게 다듬은 문장을 쓴다. natural이면 원문을 그대로 둔다.',
        '다듬은 문장에서도 학습 항목은 반드시 유지한다. 이 카드의 목적이 그 항목을 연습하는 것이므로, 항목 자체가 오용이 아닌 한 더 자연스러운 다른 표현으로 갈아치우지 않는다. 항목이 문법 패턴이면 그 패턴을 유지한다.',
      ];

  return [...head, ...tail].filter((l) => l !== null).join('\n');
}

/** 두 단계(hint/full)의 응답을 한 모양으로 맞춘다. hint 단계에는 better가 없다. */
function normalizeVerdict(json) {
  const type = ERROR_TYPES.includes(json.errorType) ? json.errorType : (json.verdict === 'natural' ? 'none' : 'other');
  return {
    verdict: json.verdict,
    errorType: type,
    comment: String(json.comment || json.hint || ''),
    hint: String(json.hint || ''),
    better: String(json.better || ''),
  };
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
  return normalizeVerdict(json);
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
export async function judgeSentence({ provider = 'anthropic', apiKey, card, sentence, fetchFn = fetch, stage = 'full', firstTry = null, hint = null }) {
  const opts = { apiKey, card, sentence, fetchFn, stage, firstTry, hint };
  if (provider === 'gemini') return judgeGemini(opts);
  return judgeAnthropic(opts);
}

async function judgeAnthropic({ apiKey, card, sentence, fetchFn, stage = 'full', firstTry = null, hint = null, model = COACH_MODEL }) {
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
      output_config: { effort: 'low', format: { type: 'json_schema', schema: schemaFor(stage, false) } },
      messages: [{ role: 'user', content: buildPrompt(card, sentence, { stage, firstTry, hint }) }],
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
  return normalizeVerdict(json);
}

function geminiMessageFor(status, body) {
  const apiMsg = body && body.error && body.error.message;
  if (status === 400 && /API key/i.test(apiMsg || '')) return 'Gemini API 키가 유효하지 않다. 설정에서 다시 넣을 것.';
  if (status === 403) return 'Gemini API 키가 유효하지 않거나 권한이 없다.';
  if (status === 429) return 'Gemini 무료 한도 초과. 잠시 후 다시 시도할 것.';
  if (status >= 500) return `Gemini 오류 ${status}. 잠시 후 다시 시도할 것.`;
  return apiMsg ? `판정 실패: ${apiMsg}` : `판정 실패 (${status})`;
}

async function judgeGemini({ apiKey, card, sentence, fetchFn, stage = 'full', firstTry = null, hint = null, noThinkingConfig = false }) {
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: schemaFor(stage, true),
  };
  // 짧은 판정에 깊은 사고는 낭비다. 3.x부터는 thinkingLevel 문자열을 쓴다.
  if (!noThinkingConfig) generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };

  const res = await fetchFn(GEMINI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(card, sentence, { stage, firstTry, hint }) }] }],
      generationConfig,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // 모델 세대가 바뀌면 thinkingConfig 형식이 거부될 수 있는데, 오류 문구가
    // 구체적이지 않은 경우가 많다. 400이면 설정을 빼고 한 번 재시도한다.
    if (res.status === 400 && !noThinkingConfig) {
      return judgeGemini({ apiKey, card, sentence, fetchFn, stage, firstTry, hint, noThinkingConfig: true });
    }
    throw new Error(geminiMessageFor(res.status, body));
  }
  return readGeminiVerdict(body);
}

/* ---------- 저장소에 올릴 월별 기록 파일 ---------- */

export function formatEntry(e) {
  const icon = { natural: '✅', minor: '⚠️', wrong: '❌' }[e.verdict] || '❓';
  const tag = e.errorType && e.errorType !== 'none' ? ` \`${ERROR_LABEL[e.errorType] || e.errorType}\`` : '';
  const lines = [`- **${e.expression}**${tag} — ${e.sentence}`];
  // 첫 시도가 따로 있으면 힌트를 받고 스스로 고친 것이다 — 그 흐름이 기록의 핵심이다.
  if (e.firstTry && e.firstTry.trim() && e.firstTry.trim() !== String(e.sentence || '').trim()) {
    lines.push(`  - 첫 시도: ${e.firstTry}`);
    if (e.hint && e.hint.trim()) lines.push(`  - 힌트: ${e.hint}`);
  }
  lines.push(`  - ${icon} ${e.comment}`);
  if (e.better && e.better.trim() && e.better.trim() !== String(e.sentence || '').trim()) {
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
