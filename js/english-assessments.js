// App-authored transfer checks. Not standardised, CEFR-calibrated or equivalent forms.
export const ASSESSMENTS = {
  A: {
    title: '처음 점검 A — 일정 변경',
    reading: 'Our customer workshop was planned for Tuesday morning. The trainer is available, but the training room will be closed for repairs. We have moved the workshop to Thursday at 2 p.m. in Room 4. Please send Mira the names of your team members by Wednesday noon. If anyone cannot attend, do not cancel their registration: a recording will be available on Friday. Participants should bring a laptop. We will provide printed instructions, so there is no need to print the slides. The session will finish at 3:30 p.m. Questions about the change should go to Mira, not to the trainer.',
    questions: [
      { text: 'Why was the workshop moved?', options: ['The trainer was unavailable.', 'The room needed repairs.', 'No customers registered.'], answer: 1, evidence: 'the training room will be closed for repairs' },
      { text: 'When must the names arrive?', options: ['Wednesday noon', 'Thursday at 2 p.m.', 'Friday morning'], answer: 0, evidence: 'by Wednesday noon' },
      { text: 'What should someone who cannot attend receive?', options: ['A cancellation', 'A different laptop', 'Access to a recording'], answer: 2, evidence: 'a recording will be available on Friday' },
      { text: 'What must participants bring?', options: ['Printed slides', 'A laptop', 'Repair tools'], answer: 1, evidence: 'Participants should bring a laptop' },
    ],
    writing: '당신 팀은 목요일에 참석할 수 없다. Mira에게 80~120단어의 영어 메일을 쓴다. 불참 사유, 녹화본 요청, 후속 질문 하나를 포함한다. 문장을 대신 써 달라고 하지 않는다.',
    speaking: '다른 팀원에게 일정 변경을 60~90초 동안 설명한다. 변경 이유, 해야 할 일, 참석할 수 없을 때의 대안을 포함한다. 휴대폰으로 녹음하고 파일명과 막힌 점만 기록한다.',
  },
  B: {
    title: '나중 점검 B — 서비스 도입',
    reading: 'We tested two booking services last month. Service North was cheaper, but it did not let customers change a booking themselves. Service South costs more and includes that feature. We have chosen South for a six-week trial, not a permanent contract. During the trial, Hana will collect customer comments every Friday. Staff should record the time they spend correcting bookings. We will compare that time with last month before deciding whether to continue. The trial starts on Monday. Training takes place on Friday at 10 a.m. Staff who miss the training must watch the video before using the new service. Please keep the old booking records; we still need them for the comparison.',
    questions: [
      { text: 'What advantage does South offer?', options: ['A lower price', 'No need for training', 'Customers can change bookings'], answer: 2, evidence: 'Service South costs more and includes that feature' },
      { text: 'What has the team agreed to?', options: ['A six-week trial', 'A permanent contract', 'Deleting old records'], answer: 0, evidence: 'a six-week trial, not a permanent contract' },
      { text: 'What should staff measure?', options: ['Training room size', 'Time spent correcting bookings', 'Number of videos watched'], answer: 1, evidence: 'record the time they spend correcting bookings' },
      { text: 'What must staff who miss training do?', options: ['Wait six weeks', 'Use North instead', 'Watch the video before using South'], answer: 2, evidence: 'watch the video before using the new service' },
    ],
    writing: 'Hana에게 80~120단어의 영어 메일을 쓴다. 도입의 장점 하나, 걱정되는 점 하나, 시험 운영에서 확인할 질문 하나를 포함한다.',
    speaking: '동료에게 새 서비스를 선택한 이유와 계속 사용할지 결정하는 방법을 60~90초 동안 설명한다. 휴대폰으로 녹음하고 파일명과 막힌 점만 기록한다.',
  },
};

export function scoreAssessment(form, answers) {
  const test = ASSESSMENTS[form];
  if (!test || !Array.isArray(answers) || answers.length !== test.questions.length ||
      answers.some(x => !Number.isInteger(x) || x < 0 || x > 2)) throw new Error('읽기 네 문항에 모두 답한다.');
  return { correct: test.questions.filter((q, i) => q.answer === answers[i]).length, total: test.questions.length };
}

export const RUBRIC = '말하기·쓰기 자가 점검: ① 요구한 내용을 모두 전달했는가 ② 이유와 순서가 이해되는가 ③ 도움 없이 끝냈는가. 원본 답안과 녹음을 보관한다. AI 피드백은 참고이며 표준 점수가 아니다. 실제 음성을 듣지 못한 AI는 발음을 평가할 수 없다.';
