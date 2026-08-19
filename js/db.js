// IndexedDB 저장소
//
// 카드 본문, 복습 상태, 복습 로그, 설정을 담는다.
// 앱은 항상 이 로컬 저장소를 먼저 읽고 쓴다. GitHub 동기화는 그 뒤에 따라온다.

const DB_NAME = 'srs';
const DB_VERSION = 1;
export const STORES = {
  CARDS: 'cards',
  STATES: 'states',
  LOGS: 'logs',
  KV: 'kv',
  FILES: 'files',
};

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.CARDS)) {
        const s = db.createObjectStore(STORES.CARDS, { keyPath: 'id' });
        s.createIndex('deck', 'deck');
      }
      if (!db.objectStoreNames.contains(STORES.STATES)) {
        const s = db.createObjectStore(STORES.STATES, { keyPath: 'id' });
        s.createIndex('due', 'due');
      }
      if (!db.objectStoreNames.contains(STORES.LOGS)) {
        const s = db.createObjectStore(STORES.LOGS, { keyPath: 'key' });
        s.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains(STORES.KV)) {
        db.createObjectStore(STORES.KV, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.FILES)) {
        // 카드 파일 원문 캐시. sha가 같으면 다시 내려받지 않는다.
        db.createObjectStore(STORES.FILES, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// 요청 결과를 담아 두는 상자. 트랜잭션이 끝난 뒤에 값을 꺼낸다.
// 값이 undefined인 경우와 상자 자체를 구분해야 해서 표식을 둔다.
const BOX = Symbol('box');

const wrap = (req) => {
  const box = { [BOX]: true, value: undefined };
  req.onsuccess = () => {
    box.value = req.result;
  };
  return box;
};

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const result = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(result && result[BOX] ? result.value : result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const getAll = (store) => run(store, 'readonly', (os) => wrap(os.getAll()));
export const get = (store, key) => run(store, 'readonly', (os) => wrap(os.get(key)));
export const put = (store, value) => run(store, 'readwrite', (os) => os.put(value));
export const del = (store, key) => run(store, 'readwrite', (os) => os.delete(key));
export const clear = (store) => run(store, 'readwrite', (os) => os.clear());
export const count = (store) => run(store, 'readonly', (os) => wrap(os.count()));

export function bulkPut(store, values) {
  return run(store, 'readwrite', (os) => {
    for (const v of values) os.put(v);
  });
}

export function bulkDelete(store, keys) {
  return run(store, 'readwrite', (os) => {
    for (const k of keys) os.delete(k);
  });
}

export async function getSetting(key, fallback = null) {
  const row = await get(STORES.KV, key);
  return row === undefined || row === null ? fallback : row.value;
}

export const setSetting = (key, value) => put(STORES.KV, { key, value });

/** 로그 키는 카드ID+시각이라 같은 복습이 두 번 들어가지 않는다. */
export const logKey = (cardId, at) => `${cardId}@${at}`;

export async function appendLog(cardId, log) {
  await put(STORES.LOGS, { key: logKey(cardId, log.at), id: cardId, ...log });
}

/** 오래된 로그를 잘라낸다. 통계와 향후 파라미터 최적화를 위해 넉넉히 남긴다. */
export async function trimLogs(max = 20000) {
  const logs = await getAll(STORES.LOGS);
  if (logs.length <= max) return 0;
  logs.sort((a, b) => a.at - b.at);
  const drop = logs.slice(0, logs.length - max).map((l) => l.key);
  await bulkDelete(STORES.LOGS, drop);
  return drop.length;
}

/** 저장 공간 사용량. 설정 화면에 보여준다. */
export async function estimateUsage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
