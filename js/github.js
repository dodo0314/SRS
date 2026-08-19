// GitHub REST API 클라이언트
//
// 비공개 저장소에서 카드 파일을 읽고, 복습 기록 파일 하나를 쓴다.
// 토큰은 이 기기의 브라우저에만 저장된다. 앱 코드에는 들어 있지 않다.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function messageFor(status, body) {
  if (status === 401) return '토큰이 유효하지 않다. 설정에서 다시 발급해 넣을 것.';
  if (status === 403) {
    if (/rate limit/i.test(body)) return 'GitHub 요청 한도 초과. 잠시 후 다시 시도할 것.';
    return '토큰에 이 저장소 권한이 없다. Contents 읽기/쓰기 권한을 확인할 것.';
  }
  if (status === 404) return '경로를 찾을 수 없다. 저장소 이름, 브랜치, 폴더 경로를 확인할 것.';
  if (status === 409) return '다른 기기가 먼저 저장했다. 다시 시도한다.';
  if (status === 422) return '요청이 거부됐다. 파일 SHA가 어긋났을 수 있다.';
  return `GitHub 오류 ${status}`;
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export class GitHubRepo {
  constructor({ owner, repo, branch = 'main', token }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
  }

  get base() {
    return `${API}/repos/${this.owner}/${this.repo}`;
  }

  async request(path, options = {}) {
    const res = await fetch(path.startsWith('http') ? path : `${this.base}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new GitHubError(messageFor(res.status, text), res.status);
    return text ? JSON.parse(text) : null;
  }

  /** 토큰과 저장소 접근을 확인한다. 설정 화면의 "연결 확인" 버튼. */
  async verify() {
    const repo = await this.request('');
    return { fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch };
  }

  /** 폴더 하나를 재귀적으로 훑어 .md 파일 목록을 만든다. */
  async listMarkdown(dir) {
    const out = [];
    const walk = async (path) => {
      let entries;
      try {
        entries = await this.request(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`);
      } catch (e) {
        if (e.status === 404) return; // 폴더가 아직 없는 경우
        throw e;
      }
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (entry.type === 'dir') await walk(entry.path);
        else if (entry.type === 'file' && /\.md$/i.test(entry.name)) {
          out.push({ path: entry.path, sha: entry.sha, size: entry.size });
        }
      }
    };
    await walk(dir);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  /** blob API로 내용을 읽는다. contents API의 1MB 제한을 피한다. */
  async readBlob(sha) {
    const blob = await this.request(`/git/blobs/${sha}`);
    return fromBase64(blob.content);
  }

  async readFile(path) {
    const res = await this.request(
      `/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`
    );
    return { text: res.content ? fromBase64(res.content) : '', sha: res.sha };
  }

  /** 없으면 null. 있으면 { text, sha }. */
  async readFileIfExists(path) {
    try {
      return await this.readFile(path);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async writeFile(path, text, { sha, message }) {
    const body = {
      message: message || `srs: update ${path}`,
      content: toBase64(text),
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const res = await this.request(`/contents/${encodeURI(path)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return { sha: res.content.sha, commit: res.commit.sha };
  }

  /** 저장소 안의 파일을 웹에서 열 수 있는 주소. 근거 링크에 쓴다. */
  blobUrl(path) {
    const [file, hash] = String(path).split('#');
    const url = `https://github.com/${this.owner}/${this.repo}/blob/${this.branch}/${file
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    return hash ? `${url}#${encodeURIComponent(hash)}` : url;
  }
}

export const _internal = { toBase64, fromBase64 };
