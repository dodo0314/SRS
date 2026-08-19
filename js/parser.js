// 카드 파일 파서
//
// srs/SPEC-cards.md에 정의된 마크다운 형식을 카드 배열로 바꾼다.
// 파서는 저장소의 원본 파일을 절대 수정하지 않는다. ID는 내용에서 유도한다.

const CARD_TYPES = new Set(['basic', 'reverse', 'cloze', 'points']);

/** 문자열 → 53비트 해시. 카드 ID 생성에 쓴다. */
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const hashId = (s) => cyrb53(s).toString(36);

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 굵게/기울임/코드/링크만 지원하는 최소 인라인 렌더러. */
export function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

/** 문단과 목록만 지원하는 최소 블록 렌더러. */
export function renderBlock(text) {
  const lines = String(text).split('\n');
  const out = [];
  let list = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const tag = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
      if (list !== tag) {
        if (list) out.push(`</${list}>`);
        out.push(`<${tag}>`);
        list = tag;
      }
      out.push(`<li>${renderInline(li[1])}</li>`);
      continue;
    }
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
    if (line.trim() === '') continue;
    out.push(`<p>${renderInline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
    meta[kv[1].toLowerCase()] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

const splitList = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

const isTrue = (v) => /^(true|yes|1|on)$/i.test(String(v ?? '').trim());

/** 근거 값이 저장소 안의 파일을 가리키는지 판단한다. */
function sourcePathOf(source) {
  if (!source) return null;
  const link = source.match(/\[[^\]]*\]\(([^)]+)\)/);
  const candidate = (link ? link[1] : source).trim();
  if (/^https?:\/\//.test(candidate)) return candidate;
  if (/\.md(#.*)?$/.test(candidate) || (candidate.includes('/') && !candidate.includes(' '))) {
    return candidate;
  }
  return null;
}

/**
 * 빈칸 표시를 뽑아낸다.
 * {{cN::본문}} 은 번호끼리 묶이고, ==본문== 은 각각 한 장이 된다.
 */
function extractCloze(text) {
  const spans = [];
  let work = text;

  work = work.replace(/\{\{c(\d+)::([\s\S]*?)\}\}/g, (_, n, content) => {
    const token = `⟦${spans.length}⟧`;
    spans.push({ group: `c${n}`, content });
    return token;
  });

  let auto = 0;
  work = work.replace(/==([^=\n]+)==/g, (_, content) => {
    const token = `⟦${spans.length}⟧`;
    auto += 1;
    spans.push({ group: `a${auto}`, content });
    return token;
  });

  const groups = [];
  for (const s of spans) if (!groups.includes(s.group)) groups.push(s.group);
  return { template: work, spans, groups };
}

/** 특정 그룹만 가린 문장을 만든다. reveal이면 그 그룹을 강조해 보여준다. */
function renderCloze(template, spans, group, reveal) {
  return template.replace(/⟦(\d+)⟧/g, (_, idx) => {
    const span = spans[Number(idx)];
    if (span.group !== group) return span.content;
    return reveal ? `<<CLOZE>>${span.content}<</CLOZE>>` : '[ … ]';
  });
}

function clozeToHtml(text) {
  return renderBlock(text)
    .replace(/&lt;&lt;CLOZE&gt;&gt;/g, '<mark>')
    .replace(/&lt;&lt;\/CLOZE&gt;&gt;/g, '</mark>')
    .replace(/\[ … \]/g, '<span class="cloze-gap">[ … ]</span>');
}

/**
 * 카드 파일 하나를 파싱한다.
 * @returns {{deck: string, cards: object[], errors: string[], enabled: boolean}}
 */
export function parseFile(path, text) {
  const { meta, body } = parseFrontmatter(String(text).replace(/\r\n/g, '\n'));
  const fileName = path.split('/').pop().replace(/\.md$/i, '');
  const deck = (meta.deck || fileName).trim();
  const fileTags = splitList(meta.tags);
  const fileType = CARD_TYPES.has(meta.type) ? meta.type : 'basic';
  const requireSource = isTrue(meta['require-source']);
  const enabled = meta.enabled === undefined ? true : isTrue(meta.enabled);

  const errors = [];
  const cards = [];
  if (!enabled) return { deck, cards, errors, enabled };

  const lines = body.split('\n');
  const blocks = [];
  let current = null;
  lines.forEach((line, i) => {
    const h = line.match(/^##\s+(.*\S)\s*$/);
    if (h) {
      if (current) blocks.push(current);
      current = { front: h[1].trim(), lines: [], line: i + 1 };
    } else if (current) {
      current.lines.push(line);
    }
  });
  if (current) blocks.push(current);

  for (const block of blocks) {
    let type = fileType;
    let explicitId = null;
    let source = null;
    const tags = [...fileTags];
    const bodyLines = [];

    for (const line of block.lines) {
      if (/^\s*%%/.test(line)) continue;
      const dir = line.match(/^\s*@(type|tags|id)\s*:\s*(.*)$/i);
      if (dir) {
        const key = dir[1].toLowerCase();
        const value = dir[2].trim();
        if (key === 'type') {
          if (CARD_TYPES.has(value)) type = value;
          else errors.push(`${path}:${block.line} 알 수 없는 유형 "${value}"`);
        } else if (key === 'tags') tags.push(...splitList(value));
        else explicitId = value;
        continue;
      }
      const src = line.match(/^\s*>?\s*근거\s*:\s*(.*\S)\s*$/);
      if (src) {
        source = src[1].trim();
        continue;
      }
      bodyLines.push(line);
    }

    const backText = bodyLines.join('\n').trim();
    const warn = [];
    if (requireSource && !source) warn.push('근거 없음');
    if (tags.includes('미검증')) warn.push('미검증');

    const base = {
      deck,
      tags: [...new Set(tags)],
      file: path,
      line: block.line,
      source,
      sourcePath: sourcePathOf(source),
      warn,
    };
    const idSeed = explicitId ? `@${explicitId}` : `${deck} ${block.front}`;
    const makeId = (variant) =>
      explicitId ? `${explicitId}:${variant}` : `${hashId(idSeed)}:${variant}`;

    if (!backText && type !== 'points') {
      errors.push(`${path}:${block.line} "${block.front}" 뒷면이 비어 있음`);
      continue;
    }

    if (type === 'basic' || type === 'reverse') {
      cards.push({
        ...base,
        id: makeId('f'),
        type: 'basic',
        frontText: block.front,
        front: renderBlock(block.front),
        back: renderBlock(backText),
      });
      if (type === 'reverse') {
        cards.push({
          ...base,
          id: makeId('r'),
          type: 'basic',
          reverse: true,
          frontText: backText,
          front: renderBlock(backText),
          back: renderBlock(block.front),
        });
      }
    } else if (type === 'cloze') {
      const { template, spans, groups } = extractCloze(backText);
      if (!groups.length) {
        errors.push(`${path}:${block.line} "${block.front}" 빈칸 표시가 없어 기본 카드로 처리함`);
        cards.push({
          ...base,
          id: makeId('f'),
          type: 'basic',
          frontText: block.front,
          front: renderBlock(block.front),
          back: renderBlock(backText),
        });
      } else {
        groups.forEach((group, i) => {
          const answers = spans.filter((s) => s.group === group).map((s) => s.content);
          cards.push({
            ...base,
            id: makeId(`c${i + 1}`),
            type: 'cloze',
            frontText: `${block.front} (${i + 1})`,
            title: block.front,
            front: clozeToHtml(renderCloze(template, spans, group, false)),
            back: clozeToHtml(renderCloze(template, spans, group, true)),
            answer: answers.join(', '),
          });
        });
      }
    } else if (type === 'points') {
      const points = [];
      const notes = [];
      for (const line of bodyLines) {
        const li = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*\S)\s*$/);
        if (li) points.push(li[1].trim());
        else if (line.trim()) notes.push(line.trim());
      }
      if (!points.length) {
        errors.push(`${path}:${block.line} "${block.front}" points 유형인데 목록이 없음`);
        continue;
      }
      cards.push({
        ...base,
        id: makeId('p'),
        type: 'points',
        frontText: block.front,
        front: renderBlock(block.front),
        points,
        note: notes.length ? renderBlock(notes.join('\n')) : null,
        back: renderBlock(points.map((p) => `- ${p}`).join('\n')),
      });
    }
  }

  return { deck, cards, errors, enabled };
}

/**
 * 여러 파일을 파싱하고 ID 충돌을 검사한다.
 * @param {{path: string, text: string}[]} files
 */
export function parseAll(files) {
  const cards = [];
  const errors = [];
  const seen = new Map();
  for (const f of files) {
    const res = parseFile(f.path, f.text);
    errors.push(...res.errors);
    for (const card of res.cards) {
      const prev = seen.get(card.id);
      if (prev) {
        errors.push(`ID 충돌: "${card.frontText}" (${card.file}) ↔ ${prev}. @id로 구분할 것`);
        continue;
      }
      seen.set(card.id, card.file);
      cards.push(card);
    }
  }
  return { cards, errors };
}
