// To-Do 탭 — 오늘 날짜와 요일 유형(출근/재택/토/일)에서 "오늘 할 일"을 계산해 그린다.
//
// 계획의 출처: 하루설계 v3 (주4 폰-온리 + 주3 책상) + 2027 합격플랜 P1 진도표.
// 진도의 단위는 "주"다. 주차 진도표(P1_WEEKS)가 재료를 정하고,
// 요일 템플릿이 그 재료를 하루 프로토콜로 푼다.
// 완료 체크는 이 기기에만 저장한다(복습 기록과 달리 동기화하지 않는다).

import * as db from './db.js';

const DAY = 86400000;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/* ---------- 날짜 ---------- */

export const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const at = (y, m, d) => new Date(y, m - 1, d).getTime();

// 국면 경계 (시행일은 50회 공고 후 실측 교체)
const OPIC_DAY = at(2026, 9, 4);     // OPIc 응시 14:20
const OPIC_SCORE = at(2026, 9, 9);   // 성적 발표
const P1_START = at(2026, 8, 31);   // W1 월요일
const P2_START = at(2026, 11, 30);  // 버퍼주 시작
const TOEIC_DAY = at(2026, 12, 13);
const JAEMUL_START = at(2026, 12, 14); // 재물특종 착수(토익 직후)
const P3_START = at(2027, 2, 1);
const P4_START = at(2027, 4, 19);   // 1차 직후 추정
const EXAM2_END = at(2027, 8, 1);

/* ---------- P1 주차 진도표 (W1=8/31~) ----------
   accWfh/accSun: 재택일/일요일 회계 인강 몫
   marLect: 해상 인강(1안) / marRead: 해상 원문
   satB/sunB: 주말 블록 덮어쓰기 */
const P1_WEEKS = [
  { acc: '회계 기초 1~6차시', accWfh: '기초 1~3차시 (1.5배속)', accSun: '기초 4~6차시 (1.5배속)',
    marLect: '해상 인강 1~2차시 (이론)', marRead: '상법 해상편 ① — 가능/4-해상보험/상법-제5편-해상.md 앞 1/4 (~300줄)',
    sunB: '토익 진단 모의 1회 (2h, 시간 재고) → 즉시 채점. 855+면 11월 집중 구간을 절반으로 줄인다' },
  { acc: '회계 기초 7~12차시', accWfh: '기초 7~9차시 (1.5배속)', accSun: '기초 10~12차시 (1.5배속)',
    marLect: '해상 인강 3~4차시 (이론)', marRead: '상법 해상편 ② (다음 300줄)' },
  { acc: '회계 기초 13~17차시', accWfh: '기초 13~15차시 (1.5배속)', accSun: '기초 16~17차시 + 기초 전범위 분개 셀프테스트',
    marLect: '해상 인강 5~6차시 (이론·적하)', marRead: '상법 해상편 ③' },
  { acc: '회계 본강 1~4차시', accWfh: '본강 1~2차시 (정속+재구성)', accSun: '본강 3~4차시',
    marLect: '해상 인강 7~8차시 (적하)', marRead: '상법 해상편 ④ (완료)' },
  { acc: '회계 본강 5~9차시', accWfh: '본강 5~6차시', accSun: '본강 7~9차시',
    marLect: '해상 인강 9~10차시 (적하)', marRead: 'MIA 1906 §1~19 — 가능/4-해상보험/MIA-1906.md' },
  { acc: '회계 본강 10~14차시', accWfh: '본강 10~11차시', accSun: '본강 12~14차시',
    marLect: '해상 인강 11~12차시 (선박)', marRead: 'MIA §20~38 (워런티 구간 — 목차 카드 필수)' },
  { acc: '회계 본강 15~18차시', accWfh: '본강 15~16차시', accSun: '본강 17~18차시',
    marLect: '해상 인강 13~14차시 (선박)', marRead: 'MIA §39~57',
    satB: 'ICC 구조 해부 시작 — ICC(A) 1~2조: 원문 정독 → 담보·면책·조건 구조 분해 → 한→영 요약 → 용어 카드 2~4장 + 조항 목차 points 카드' },
  { acc: '회계 본강 19~23차시', accWfh: '본강 19~20차시', accSun: '본강 21~23차시',
    marLect: '해상 인강 15~16차시 (선박)', marRead: 'MIA §58~76',
    satB: 'ICC(A) 3~4조 해부 (같은 절차)' },
  { acc: '회계 본강 24~28차시', accWfh: '본강 24~25차시', accSun: '본강 26~28차시',
    marLect: '해상 인강 17~18차시 (선박·공동해손)', marRead: 'MIA §77~94 (완료)',
    satB: 'ICC(A) 5~6조 해부' },
  { acc: '회계 본강 29~33차시 (재무회계 완료)', accWfh: '본강 29~30차시', accSun: '본강 31~33차시',
    marLect: '해상 인강 19~20차시 (공동해손)', marRead: 'ICC(A) 통독 — 원문열람/ICC-MIA-선박약관.md 링크',
    satB: 'ICC(A) 7~8조 해부' },
  { acc: '회계 본강 34~36차시 (원가관리 진입)', accWfh: '본강 34~35차시', accSun: '본강 36차시 (토익 모의 후 여력 있으면 +1)',
    marLect: '해상 인강 21차시 (공동해손)', marRead: 'ICC(B) 통독 — A와 다른 조항에만 표시',
    satB: 'ICC(A) 9~10조 해부',
    sunB: '토익 실전 모의 ① (2h 시간 재고) → 오답 어휘·표현만 카드화 1h. 해설 정독 금지' },
  { acc: '회계 본강 37~40차시', accWfh: '본강 37~38차시', accSun: '본강 39~40차시',
    marLect: '해상 인강 22차시 (공동해손)', marRead: 'ICC(C) 통독',
    satB: 'ICC(A) 11~12조 해부',
    sunB: '토익 실전 모의 ② + 오답 카드화 1h' },
  { acc: '회계 본강 41~44차시 (완주)', accWfh: '본강 41~42차시', accSun: '본강 43~44차시',
    marLect: '해상 인강 23차시 (공동해손 완료 — 문제풀이 24~44차시는 P2)', marRead: 'ICC A/B/C 차이 비교표 만들기 (레드라인 사전 작업)',
    satB: 'ICC(A) 13~14조 해부',
    sunB: '토익 실전 모의 ③ + 오답 카드화 1h' },
];

/* ---------- 영어 발화 (4/3/2) ----------
   영어학습 4-1절. 주제는 OPIc Background Survey 12개를 날짜로 돌린다 —
   같은 주제를 반복하면 그 주제만 늘기 때문이다(Bygate 2001). */

const SPEAK_TOPICS = [
  '헬스 — 내 분할 프로그램과 왜 그렇게 짰는지',
  '야구 — 응원하는 팀과 기억에 남는 경기',
  '국내여행 — 10월 제주 계획',
  '걷기·공원 — 언제 어디서 걷는지',
  '영화·공연 — 최근 본 것과 왜 좋았는지',
  '음악 감상 — 언제 무엇을 듣는지',
  '카페 — 자주 가는 곳과 거기서 하는 일',
  '집에서 보내는 휴가 — 쉬는 날의 하루',
  '해변 — 가본 곳과 그때의 날씨·풍경',
  '조깅 — 헬스와 어떻게 다른지',
  'TV 시청 — 요즘 보는 것',
  '쇼핑 — 어디서 무엇을 사는지',
];

export function speakTopic(now) {
  const d = new Date(now);
  const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / DAY);
  return SPEAK_TOPICS[doy % SPEAK_TOPICS.length];
}

// 녹음일은 주 2회(화·금). 나머지 날은 녹음 없이 말하기만 한다.
const isRecordDay = (dow) => dow === 2 || dow === 5;

// 전사·분석은 격주 토요일. P1 시작 기준 짝수 주에 돈다.
const isTranscribeWeek = (now) => Math.floor((now - P1_START) / (7 * DAY)) % 2 === 0;

function fourThreeTwo(now) {
  const rec = isRecordDay(new Date(now).getDay());
  return {
    title: `영어 4/3/2 — ${speakTopic(now).split(' —')[0]}${rec ? ' (녹음)' : ''}`,
    dur: '9분',
    detail:
      `오늘 주제: ${speakTopic(now)}. 왕복 도보에서 소리 내어 — 같은 내용을 4분 → 3분 → 2분으로 줄여 세 번 말한다. ` +
      `내용을 바꾸지 말고 시간만 줄이는 것이 요점이다(내용을 새로 짜면 유창성 훈련이 아니라 작문이 된다). ` +
      (rec ? '오늘은 폰 녹음만 켠다 — 전사·분석은 하지 않는다. 그건 토요일 몫이다.' : '녹음 없음. 끊겨도 멈추지 말고 채워서 간다 — 침묵이 실수보다 비싸다.'),
  };
}

/* ---------- 과업 상세 (공통 프로토콜) ---------- */

const T = {
  srsAm: {
    title: 'SRS 카드 30~40분',
    dur: '30~40분',
    detail: '전체 큐 기준(덱 선택 해제 상태). 복습이 밀려 있으면 신규보다 복습 먼저. 놓친 논점 카드는 Again — 퇴근길 검산 대상이 된다.',
  },
  audio(now) {
    return now <= TOEIC_DAY
      ? {
          title: '남는 시간: 토익 LC 오디오',
          dur: '잔여',
          detail: 'Part 3·4를 스크립트 없이 1회 → 정답 확인 → 같은 지문 재청취. 새 지문 수집보다 같은 지문 반복이 우선.',
        }
      : {
          title: '남는 시간: 오디오 재청취',
          dur: '잔여',
          detail: '이미 본 인강 차시의 오디오 재청취(처음 듣는 강 금지 — 신규 입력은 책상 몫) 또는 The Voice of Insurance: 1회차는 멈추지 않고 대의만, 하차 후 들린 표현·안 들린 소리 5개 메모. 격주로 같은 회차 재청취.',
        };
  },
  lunch: {
    title: '점심 SRS 20분',
    dur: '20분',
    detail: '결정 피로 없이 앱만 연다. 카드만. 다른 것 금지.',
  },
  recon: {
    title: '논점 목차 암송 → 폰 메모 검산',
    dur: '25분',
    detail:
      '검산 대상 2개를 고른다: ① 오늘 아침·어제 취침 전에 본 points(논점) 카드 중 헷갈렸던 것 ② 이번 주 해상 원문 진도의 조문 구조(예: 이번 주가 MIA 워런티 구간이면 "워런티 조항들의 목차"). 절차: 화면 안 보고 목차를 속으로 암송 → 폰 메모장에 1. 2. 3. 번호 목차로 적는다 → SRS에서 해당 카드를 열어(덱 ▶ 버튼) 대조 → 빠뜨린 항목이 있으면 그 카드를 Again 처리 → 메모는 버린다. 기록이 아니라 인출이 목적이다.',
  },
  srsPm: {
    title: 'SRS 잔여 소진 → 오디오',
    dur: '~55분',
    detail: '아침에 남긴 복습 큐를 비운다. 다 비면 오디오(위와 같은 규칙). 종점은 헬스장 — 내리기 전 단백질음료.',
  },
  night: {
    title: '취침 전 인출 25분 (폰)',
    dur: '25분',
    detail:
      '새 것 금지 — 수면 응고화 창. ① 오늘 본·만든 카드 재인출 15분 ② 상법↔영국법 매핑 + 회계 분개·공식 카드 5분 ③ Daily 일지 5분(오늘 한 것 3줄). 22:30 취침 사수.',
  },
  accLectFull(alloc) {
    return {
      title: `회계 인강 — ${alloc}`,
      dur: '차시당 ~45분',
      detail:
        '본강은 정속: 소단원이 끝날 때마다 멈추고 화면 끈 채 1분 소리내어 재구성 — 안 나오면 그 부분만 재시청. 연속 재생 금지. 기초강은 1.5배속 훑기(멈춤-재구성 생략, 안 들리는 곳만 정속) — 진입 완충이 목적이지 정독이 목적이 아니다.',
    };
  },
  handCalc: {
    title: '회계 손계산 80분 (풀 프로토콜)',
    dur: '80분',
    detail:
      '재료: 오늘 들은 차시의 교재 페이지 범위 예제. 초반 4주: 풀이예제 3개를 자기설명 붙여 정독("왜 이 계정인가"를 말로) → 빈칸 예제 2개 → 안 보고 독립 풀이 2개. 5주차부터: 독립 풀이 중심 + 이전 챕터 유형 혼합. 단순계산기 사용(시험 지참 과목). 마지막 5분: 오늘 틀린 유형을 분개·공식 카드로.',
  },
  marine(week) {
    return {
      title: `해상 — ${week.marLect}`,
      dur: '~45분',
      detail: `인강 1차시(정속+멈춤-재구성) 후 원문과 연결: ${week.marRead}. 원문은 읽고 끝내지 말고 소단위마다 책 덮고 구조 재구성 — 다시 읽기는 복습이 아니다.`,
    };
  },
  cards: {
    title: '카드 작성 15분 (그날 배운 것만)',
    dur: '15분',
    detail:
      '작성 < 인출 시간 유지 — 카드 공장 금지. 앞면=질문, 뒷면=답. 조문은 질문화, 논점은 points 카드(목차 인출), 용어는 한↔영 양방향 2장, 회계는 개념·분개 원리만(계산은 카드로 안 된다). 새 영어 용어에는 내 예문 1개.',
  },
  opic(now) {
    const d = Math.ceil((OPIC_DAY - now) / DAY);
    if (now >= OPIC_SCORE + DAY) return null;
    if (now >= OPIC_DAY + DAY) {
      return {
        title: `OPIc 성적 발표 D-${Math.ceil((OPIC_SCORE - now) / DAY)} (9/9 13:00)`,
        dur: '—',
        detail: '발표되면 Underwriter/notes/지원기록.md의 어학란을 갱신하고, IM 이하면 25일 뒤 4단계로 재응시 접수. 재응시 전까지 4/3/2는 상설 밀도(주 5~6회 9분)로 돌아간다.',
      };
    }
    return {
      title: d <= 0 ? '⚡ 오늘 OPIc — 14:20 시청센터A (13:40 도착)' : `⚡ OPIc D-${d} — 9/4(금) 14:20 시청센터A`,
      dur: d <= 0 ? '당일' : '—',
      detail: d <= 0
        ? '13:40 도착 기준. 오리엔테이션 20분 + 본시험 40분. 자가진단은 3단계(첫 응시는 진단이 목적). 서베이는 OPIc-2026-09.md 2절 그대로 입력. 침묵이 문법 실수보다 비싸다 — 막히면 답변 틀 표현으로 시간을 벌고 계속 말한다.'
        : `남은 준비는 시간 박스 안에서만: 서베이 확정 → 유형별 답변 틀 → 8/30(일) 모의 1회 녹음. 매일 4/3/2로 서베이 주제를 돌리는 것이 사실상의 대비다. 덱은 영어/OPIc-주제 ▶ 로 따로 돈다.`,
    };
  },
  errCards: {
    title: '작문 오류 카드화 10분',
    dur: '10분',
    detail:
      'srs/sentences/ 이번 달 파일을 열고 ⚠️·❌ 문장을 고른다 → 교정문을 srs/cards/영어-내오류.md 에 옮기고 **내가 틀린 자리에만** 형광펜(==) → 설명은 반드시 `> 해설:` 로(안 그러면 앞면에 답이 샌다). 주 5~10장. 밀렸으면 지난 주 것은 버리고 이번 주 것만 만든다 — 몰아서 만들면 카드 공장이다.',
  },
  transcribe() {
    return {
      title: '4/3/2 녹음 전사 → 오류 분석 → 카드',
      dur: '25분',
      detail:
        `이번 주 녹음(화·금) 중 하나를 고른다. ① 재생하며 들리는 대로 받아 적는다(폰 받아쓰기 사용 가능 — 폰이 못 알아듣는 소리는 명료성 신호다) ② 관사·동사 형태·절 연결 세 가지만 표시한다(그 외는 지금 보지 않는다) ③ 고친 문장을 영어-내오류 덱으로. 격주다 — 안 하는 주는 학습 C를 그대로 쓴다.`,
    };
  },
  wfhRule: {
    title: '⚠ 재택일 규칙',
    dur: '—',
    detail:
      '대기 호출에 대비해 모든 블록을 40분 단위로 쪼갠다 — 끊겨도 한 단위만 잃는다. 시간 측정 산출(실전 답안·모의)은 절대 오늘 하지 않는다(끊기면 훈련 가치 0 — 그건 토요일 B 몫). 실업무가 터져 소각되면: 일요일 A가 회계 인강을 흡수하고 이번 주 해상 인강은 스킵(원문만).',
  },
};

/* ---------- 요일 템플릿 ---------- */

function commuteDay(now, phase) {
  const sections = [
    { name: '오전 운동 왕복 05:50~06:50', tasks: [{ id: 'c0', ...fourThreeTwo(now) }] },
    { name: '출근길 07:20~08:30 (70분)', tasks: [{ id: 'c1', ...T.srsAm }, { id: 'c2', ...T.audio(now) }] },
    { name: '점심', tasks: [{ id: 'c3', ...T.lunch }] },
    { name: '퇴근길 17:00~18:20 (80분) → 헬스장', tasks: [{ id: 'c4', ...T.recon }, { id: 'c5', ...T.srsPm }] },
    {
      name: '저녁',
      tasks: [
        phase === 'p4'
          ? { id: 'c6', title: '회계 손계산 1h (P4 예외 — 출근일 유일한 책상)', dur: '60분', detail: '결전기에는 회계 매일 1h로 상향(합격플랜 P4). 유형 혼합 독립 풀이.' }
          : { id: 'c6', title: '책상 없음 — 회복', dur: '—', detail: '운동 → 저녁 → 자유. 이 저녁을 비우는 것이 이 시간표의 목적이다. 밀린 학습을 여기로 가져오지 않는다(버퍼 주에서만 회수).' },
      ],
    },
    { name: '취침 전 22:00~22:25', tasks: [{ id: 'c7', ...T.night }] },
  ];
  return sections;
}

function wfhDayP1(now, week) {
  return [
    { name: '규칙', tasks: [{ id: 'w0', ...T.wfhRule }] },
    {
      name: '오전 — 회계 블록',
      tasks: [
        { id: 'w1', ...T.accLectFull(week.accWfh) },
        { id: 'w2', ...T.handCalc },
      ],
    },
    {
      name: '오후 — 해상 블록',
      tasks: [{ id: 'w3', ...T.marine(week) }, { id: 'w4', ...T.cards }],
    },
    { name: '점심·저녁 (통근 창 대체)', tasks: [{ id: 'w5', ...T.lunch }, { id: 'w6', title: 'SRS 나머지 큐', dur: '30분', detail: '통근이 없는 날이라 복습 창이 부족하다 — 점심과 저녁 식후에 나눠 비운다.' }] },
    { name: '취침 전', tasks: [{ id: 'w7', ...T.night }] },
  ];
}

function saturday(now, week, phase) {
  const satB =
    (week && week.satB) ||
    (phase === 'p1'
      ? '산출: 이번 주 원문 범위를 클로즈드북으로 목차 재구성(백지에) → 원문 대조 → 회계 연습문제 2~3문항 실전 풀이(시간 재고)'
      : phase === 'p2'
        ? '격주 교대: 2차 기출 답안 맛보기 1문항(클로즈드북·시간 측정·답안지 양식·즉시 모범논점 대조) ↔ 해상 1안 문제풀이 차시 2~3개'
        : phase === 'p3'
          ? '1차 기출 실전 모의: 한 회차 3과목 클로즈드북 → 즉시 채점 → 오답 전량 카드화'
          : '2차 실전 답안 2문항 (3과목 로테이션, 실제 시간 측정, 직후 채점)');
  return [
    { name: '오전', tasks: [
      { id: 's0', title: '컨디셔닝 09:00~11:00', dur: '2h', detail: '운동계획 참조. 고정 — 학습이 침식하지 않는다.' },
      { id: 's0b', ...fourThreeTwo(now) },
    ] },
    {
      name: '학습 A 11:30~13:00',
      tasks: [{
        id: 's1',
        title: phase === 'p1' ? '회계 문제풀이 (당주 범위, 유형 혼합)' : '문제풀이 (유형 혼합)',
        dur: '1.5h',
        detail: phase === 'p1'
          ? '이번 주 인강 범위의 기본문제 8~10문항. 연습문제 차시가 낀 주는 그 차시 문제로 대체. 같은 유형 몰아 풀기 금지 — 이전 챕터와 섞는다. 클로즈드북, 채점 즉시.'
          : '현 국면 주력 과목의 기출·문제. 유형 혼합 원칙 동일.',
      }],
    },
    { name: '학습 B 14:00~17:00 — 산출 전용', tasks: [{ id: 's2', title: satB.split(':')[0].slice(0, 30), dur: '3h', detail: satB }] },
    {
      name: '학습 C 19:30~21:00',
      tasks: [
        { id: 's3', title: '가벼운 것', dur: '1.5h', detail: '오늘 오답 카드화 → 밀린 인강 차시 배속 소화 → 이번 주 카드 품질 점검(질문이 인출을 강제하는가). 피곤하면 여기부터 버린다.' },
        ...(isTranscribeWeek(now) ? [{ id: 's5', ...T.transcribe() }] : []),
      ],
    },
    { name: '취침 전', tasks: [{ id: 's4', ...T.night }] },
  ];
}

function sunday(now, week, phase) {
  const sunB =
    (week && week.sunB) ||
    (phase === 'p1'
      ? (week ? `해상 인강 1차시 + 원문 잔여 마무리 — ${week.marRead}` : '해상 보충')
      : '취약 보충 (지난주 오답이 가리키는 곳)');
  return [
    {
      name: '학습 A 09:30~12:30',
      tasks: [
        week
          ? { id: 'n1', ...T.accLectFull(week.accSun) }
          : { id: 'n1', title: '주력 과목 3h', dur: '3h', detail: '90분 × 2로 쪼개도 된다.' },
        { id: 'n2', title: '손계산 미니세션 40분', dur: '40분', detail: '어제 학습 A에서 틀린 문제 재풀이 + 독립 풀이 2문항.' },
      ],
    },
    { name: '학습 B 14:00~16:30', tasks: [{ id: 'n3', title: sunB.split('—')[0].slice(0, 34), dur: '2.5h', detail: sunB }] },
    {
      name: '마감',
      tasks: [
        { id: 'n4', title: '지원 파이프라인 30분', dur: '30분', detail: '채용공고 스캔 → Underwriter/notes/지원기록.md 갱신 → 이번 주 지원 1건 진행 여부 결정. 합격 전 지원 병행 원칙 — 중단 없음.' },
        { id: 'n4b', ...T.errCards },
        { id: 'n5', title: '주간 정리 30분', dur: '30분', detail: 'SRS 통계 확인(성숙 카드 비율) → 용어집 이관 → 저장소 커밋 → 다음 주 To-Do 확인. 계획 수정은 지금만 허용된다 — 주중에 계획을 만지작거리지 않는다.' },
      ],
    },
    { name: '저녁', tasks: [{ id: 'n6', title: '완전 휴식 + 걷기', dur: '—', detail: '운동 완전휴식일. 취침 전 인출만 가볍게.' }] },
  ];
}

function prepDay(now) {
  return [
    {
      name: 'P1 개시(8/31) 전 준비 체크리스트',
      tasks: [
        { id: 'q1', title: '회계 인강 결제 (기초 17차시 + 본강 44차시)', dur: '—', detail: '결제 전 확인 1가지: 수강 만료일이 2027-07 하순(2차 시험일)을 넘는가. 넘지 않으면 연장 조건 확인.' },
        { id: 'q2', title: '해상 1안(44차시) — 결제는 9월 중', dur: '—', detail: '지금은 수강기간 조건만 확인. 첫 4주는 상법 해상편 원문으로 시작하므로 급하지 않다.' },
        { id: 'q3', title: '재물특종은 지금 사지 않는다', dur: '—', detail: '착수가 12/15 — 수강기간이 결제일 기산이면 미리 사는 만큼 손해. 11월 말 결제. 그때 2027 개정판이 나와 있으면 그쪽.' },
        { id: 'q4', title: '설정에서 재택 요일 지정', dur: '1분', detail: '아래 설정 → To-Do → 재택(대기) 요일. 이 탭의 하루 구성이 그 요일 기준으로 바뀐다.' },
        { id: 'q0', title: 'OPIc 서베이 확정 + 영어/OPIc-주제 덱 시작', dur: '1h', detail: 'OPIc-2026-09.md 2절의 12개 항목을 그대로 확정해 적어둔다(당일 그대로 입력). 그리고 SRS에서 영어/OPIc-주제 덱을 ▶ 로 돌려 1절 답변 틀 10장부터 — 막혔을 때 시간 버는 표현이 등급을 만든다.' },
        { id: 'q5', title: '토익 진단 모의 1회분 준비', dur: '—', detail: '9/6(일) 학습 B에서 시간 재고 푼다. 기출 모의 1회분이면 충분 — 문제집 사재기 금지.' },
      ],
    },
    { name: '오늘부터 이미 도는 것', tasks: [
      { id: 'q9', ...fourThreeTwo(now.getTime ? now.getTime() : now) },
      { id: 'q6', ...T.srsAm }, { id: 'q7', ...T.recon }, { id: 'q8', ...T.night },
    ] },
  ];
}

/* ---------- 날짜 → 계획 ---------- */

export function planFor(date, wfhDow = 4) {
  const now = date.getTime();
  const dow = date.getDay();
  const label = `${date.getMonth() + 1}/${date.getDate()} (${DOW[dow]})`;

  let phase, phaseLabel, week = null, weekNo = 0;
  if (now < P1_START) {
    phase = 'prep';
    const d = Math.ceil((P1_START - now) / DAY);
    phaseLabel = `준비기 — P1 시작까지 D-${d}`;
  } else if (now < P2_START) {
    phase = 'p1';
    weekNo = Math.floor((now - P1_START) / (7 * DAY));
    week = P1_WEEKS[Math.min(weekNo, P1_WEEKS.length - 1)];
    phaseLabel = `P1 기반기 · W${weekNo + 1}/13`;
  } else if (now < P3_START) {
    phase = 'p2';
    phaseLabel = now <= TOEIC_DAY
      ? `P2 · 토익 결전 구간 (12/13 응시 D-${Math.ceil((TOEIC_DAY - now) / DAY)})`
      : 'P2 확장기 (재물특종 + 회계 2회독 + 1차 진단)';
  } else if (now < P4_START) {
    phase = 'p3';
    phaseLabel = 'P3 1차 집중기 (기출 5개년 × 3회독)';
  } else if (now < EXAM2_END) {
    phase = 'p4';
    phaseLabel = 'P4 2차 결전기 (답안 주 3문항 + 회계 매일 1h)';
  } else {
    phase = 'post';
    phaseLabel = '시험 후 — UW 역확장 국면';
  }

  let dayType, sections;
  if (phase === 'prep') {
    dayType = '준비기';
    sections = prepDay(date);
  } else if (dow === 6) {
    dayType = '토요일 (책상)';
    sections = saturday(now, week, phase);
  } else if (dow === 0) {
    dayType = '일요일 (책상)';
    sections = sunday(now, week, phase);
  } else if (dow === wfhDow) {
    dayType = '재택 대기일 (책상)';
    sections = phase === 'p1' && week
      ? wfhDayP1(now, week)
      : [
          { name: '규칙', tasks: [{ id: 'w0', ...T.wfhRule }] },
          {
            name: '입력 블록',
            tasks: [{
              id: 'w1',
              title: phase === 'p2' ? '재물특종 인강 4~5차시 + 회계 문제 15~20문항' : phase === 'p3' ? '1차 기출 1개년분 진행 + 회계 유지 30분' : '답안 1문항 + 회계 1h + 논점 목차화',
              dur: '5~6h',
              detail: '이 국면의 상세 주차표는 직전 국면 종료 시 갱신된다. 골격은 P1과 동일: 40분 단위, 시간 측정 산출 금지.',
            }],
          },
          { name: '취침 전', tasks: [{ id: 'w7', ...T.night }] },
        ];
  } else {
    dayType = '출근일 (폰 온리)';
    sections = commuteDay(now, phase);
  }

  // OPIc(9/4)은 어느 요일 유형이든 최상단에 뜬다. 성적 발표(9/9) 뒤 사라진다.
  const opic = T.opic(now);
  if (opic) sections = [{ name: '⚡ 관문 — OPIc', tasks: [{ id: 'opic', ...opic }] }, ...sections];

  const weekLine = week
    ? `이번 주: ${week.acc} · ${week.marLect} · 원문 ${week.marRead.split('—')[0].trim()}`
    : null;

  return { label, phase, phaseLabel, dayType, weekLine, sections };
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
      <div class="todo-progress">${doneN}/${total} 완료</div>
    </div>
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
    <p class="status foot">체크는 이 기기에만 저장된다 · 재택 요일은 설정에서 변경</p>`;

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
