// GitHub 동기화
//
// 카드 원문은 저장소에서 읽기만 하고, 복습 기록은 srs/review.json 한 파일에만 쓴다.
// 두 방향을 한 파일에 섞지 않기 때문에 옵시디언에서 카드를 편집하는 것과
// 폰에서 복습하는 것이 서로를 덮어쓰지 않는다.

import * as db from './db.js';
import { GitHubRepo } from './github.js';
import { parseAll } from './parser.js';
import { appendSentences } from './coach.js';

export const REVIEW_VERSION = 1;

// review.json의 배열 순서. 파일 크기를 줄이려고 키 대신 위치로 저장한다.
const STATE_FIELDS = [
  'stability', 'difficulty', 'due', 'lastReview', 'reps', 'lapses', 'state', 'interval',
];
const LOG_FIELDS = ['id', 'at', 'grade', 'state', 'elapsedDays', 'interval'];

const round = (n, p = 4) => Number(Number(n || 0).toFixed(p));

export function encodeState(s) {
  return [
    round(s.stability), round(s.difficulty), s.due || 0, s.lastReview || 0,
    s.reps || 0, s.lapses || 0, s.state || 0, s.interval || 0,
  ];
}

export function decodeState(id, arr) {
  const out = { id };
  STATE_FIELDS.forEach((f, i) => {
    out[f] = arr[i] || 0;
  });
  return out;
}

export const encodeLog = (l) => LOG_FIELDS.map((f) => (f === 'id' ? l.id : l[f] ?? 0));

export function decodeLog(arr) {
  const out = {};
  LOG_FIELDS.forEach((f, i) => {
    out[f] = arr[i] ?? 0;
  });
  out.key = db.logKey(out.id, out.at);
  return out;
}

/**
 * 같은 카드의 두 상태 중 더 최근 것을 고른다.
 * 기기가 하나뿐이어도 오프라인 편집이 겹치면 쓰인다.
 */
export function mergeStates(local, remote) {
  const byId = new Map();
  for (const s of local) byId.set(s.id, s);
  let taken = 0;
  for (const r of remote) {
    const mine = byId.get(r.id);
    if (!mine) {
      byId.set(r.id, r);
      taken += 1;
      continue;
    }
    const remoteNewer =
      (r.lastReview || 0) > (mine.lastReview || 0) ||
      ((r.lastReview || 0) === (mine.lastReview || 0) && (r.reps || 0) > (mine.reps || 0));
    if (remoteNewer) {
      byId.set(r.id, r);
      taken += 1;
    }
  }
  return { states: [...byId.values()], taken };
}

export function mergeLogs(local, remote, cap = 20000) {
  const byKey = new Map();
  for (const l of [...local, ...remote]) byKey.set(l.key || db.logKey(l.id, l.at), l);
  const all = [...byKey.values()].sort((a, b) => a.at - b.at);
  return all.length > cap ? all.slice(all.length - cap) : all;
}

export function buildReviewJson(states, logs, now = Date.now()) {
  const out = { version: REVIEW_VERSION, updatedAt: now, stateFields: STATE_FIELDS, logFields: LOG_FIELDS, states: {}, logs: [] };
  for (const s of states) {
    if (!s.lastReview) continue; // 아직 한 번도 안 본 카드는 저장하지 않는다
    out.states[s.id] = encodeState(s);
  }
  out.logs = logs.map(encodeLog);
  return out;
}

export function readReviewJson(json) {
  if (!json || typeof json !== 'object') return { states: [], logs: [] };
  const states = Object.entries(json.states || {}).map(([id, arr]) => decodeState(id, arr));
  const logs = (json.logs || []).map(decodeLog);
  return { states, logs, updatedAt: json.updatedAt || 0 };
}

export const DEFAULT_CONFIG = {
  owner: '',
  repo: '',
  branch: 'main',
  cardsDir: 'srs/cards',
  reviewPath: 'srs/review.json',
  sentencesDir: 'srs/sentences',
};

export class Sync {
  constructor(config, token) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.repo = new GitHubRepo({ ...this.config, token });
  }

  /**
   * 카드 파일을 내려받아 파싱한다. sha가 그대로인 파일은 다시 받지 않는다.
   */
  async pullCards(onProgress = () => {}) {
    const remote = await this.repo.listMarkdown(this.config.cardsDir);
    const cached = await db.getAll(db.STORES.FILES);

    // 안전장치: 원격 목록이 비었는데 로컬에 카드가 있으면 지우지 않고 멈춘다.
    // 브랜치·경로 설정 오류, 저장소 훼손(예: vault 백업 사고), 404가 전부 이 경로로 들어온다.
    if (!remote.length && cached.length) {
      throw new Error(
        `카드 폴더(${this.config.cardsDir})가 비어 보인다. 저장소·브랜치·폴더 설정을 확인하라. 로컬 카드 ${cached.length}개 파일은 지우지 않았다.`
      );
    }
    const cachedByPath = new Map(cached.map((f) => [f.path, f]));

    const stale = remote.filter((f) => cachedByPath.get(f.path)?.sha !== f.sha);
    let done = 0;
    for (const file of stale) {
      onProgress(`카드 내려받는 중 ${++done}/${stale.length}`);
      const text = await this.repo.readBlob(file.sha);
      await db.put(db.STORES.FILES, { path: file.path, sha: file.sha, text });
      cachedByPath.set(file.path, { path: file.path, sha: file.sha, text });
    }

    const remotePaths = new Set(remote.map((f) => f.path));
    const removed = cached.filter((f) => !remotePaths.has(f.path)).map((f) => f.path);
    if (removed.length) await db.bulkDelete(db.STORES.FILES, removed);

    const files = remote.map((f) => cachedByPath.get(f.path)).filter(Boolean);
    const { cards, errors } = parseAll(files);

    const previous = await db.getAll(db.STORES.CARDS);
    const nextIds = new Set(cards.map((c) => c.id));
    const goneIds = previous.filter((c) => !nextIds.has(c.id)).map((c) => c.id);
    if (goneIds.length) await db.bulkDelete(db.STORES.CARDS, goneIds);
    await db.bulkPut(db.STORES.CARDS, cards);

    await db.setSetting('lastCardPull', Date.now());
    await db.setSetting('parseErrors', errors);
    return { total: cards.length, fetched: stale.length, removed: goneIds.length, errors };
  }

  /** 원격 복습 기록을 읽어 로컬과 병합한다. */
  async pullState() {
    const file = await this.repo.readFileIfExists(this.config.reviewPath);
    if (!file) {
      await db.setSetting('reviewSha', null);
      return { taken: 0, existed: false };
    }
    let json;
    try {
      json = JSON.parse(file.text);
    } catch {
      throw new Error('review.json을 읽을 수 없다. 파일이 손상됐을 수 있다.');
    }
    const remote = readReviewJson(json);
    const localStates = await db.getAll(db.STORES.STATES);
    const localLogs = await db.getAll(db.STORES.LOGS);

    const { states, taken } = mergeStates(localStates, remote.states);
    const logs = mergeLogs(localLogs, remote.logs);

    await db.bulkPut(db.STORES.STATES, states);
    await db.bulkPut(db.STORES.LOGS, logs);
    await db.setSetting('reviewSha', file.sha);
    return { taken, existed: true, remoteUpdatedAt: remote.updatedAt };
  }

  /**
   * 로컬 기록을 저장소에 쓴다. 먼저 원격을 병합하므로 다른 기기의 기록을 지우지 않는다.
   */
  async pushState({ retry = true } = {}) {
    const file = await this.repo.readFileIfExists(this.config.reviewPath);
    let sha = file ? file.sha : undefined;

    if (file) {
      try {
        const remote = readReviewJson(JSON.parse(file.text));
        const localStates = await db.getAll(db.STORES.STATES);
        const localLogs = await db.getAll(db.STORES.LOGS);
        const { states } = mergeStates(localStates, remote.states);
        const logs = mergeLogs(localLogs, remote.logs);
        await db.bulkPut(db.STORES.STATES, states);
        await db.bulkPut(db.STORES.LOGS, logs);
      } catch {
        // 원격 파일이 깨졌으면 로컬 기록으로 덮어쓴다.
      }
    }

    const states = await db.getAll(db.STORES.STATES);
    const logs = await db.getAll(db.STORES.LOGS);
    const payload = buildReviewJson(states, logs);
    const text = `${JSON.stringify(payload)}\n`;
    const reviewed = Object.keys(payload.states).length;

    try {
      const res = await this.repo.writeFile(this.config.reviewPath, text, {
        sha,
        message: `srs: 복습 기록 ${reviewed}장`,
      });
      await db.setSetting('reviewSha', res.sha);
      await db.setSetting('lastPush', Date.now());
      await db.setSetting('dirty', false);
      return { reviewed, logs: payload.logs.length };
    } catch (e) {
      if (retry && (e.status === 409 || e.status === 422)) {
        return this.pushState({ retry: false });
      }
      throw e;
    }
  }

  /**
   * 아직 안 올라간 작문 기록을 월별 파일에 이어 붙인다.
   * 파일은 사람이 읽는 마크다운이라 병합하지 않고 항상 뒤에만 붙인다.
   */
  async pushSentences({ retry = true } = {}) {
    const all = await db.getAll(db.STORES.SENTENCES);
    const pending = all.filter((e) => !e.pushed).sort((a, b) => a.at - b.at);
    if (!pending.length) return { pushed: 0 };

    const byMonth = new Map();
    for (const e of pending) {
      const month = String(e.day || '').slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(e);
    }

    let pushed = 0;
    for (const [month, entries] of byMonth) {
      const path = `${this.config.sentencesDir}/${month}.md`;
      try {
        const file = await this.repo.readFileIfExists(path);
        const text = appendSentences(file ? file.text : '', entries, month);
        await this.repo.writeFile(path, text, {
          sha: file ? file.sha : undefined,
          message: `srs: 작문 ${entries.length}문장`,
        });
      } catch (e) {
        if (retry && (e.status === 409 || e.status === 422)) {
          return this.pushSentences({ retry: false });
        }
        throw e;
      }
      for (const e of entries) {
        await db.put(db.STORES.SENTENCES, { ...e, pushed: 1 });
      }
      pushed += entries.length;
    }
    return { pushed };
  }

  async syncAll(onProgress = () => {}) {
    onProgress('카드 목록 확인 중');
    const cards = await this.pullCards(onProgress);
    onProgress('복습 기록 받는 중');
    const pulled = await this.pullState();
    onProgress('복습 기록 올리는 중');
    const pushed = await this.pushState();
    const sentences = await this.pushSentences();
    await db.trimLogs();
    return { cards, pulled, pushed, sentences };
  }
}
