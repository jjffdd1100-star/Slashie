// ─── utils.js ───────────────────────────────────────────────────────────────
// 순수 함수 모음: 파싱, 텍스트 가공, 정규식 헬퍼. 상태를 갖지 않음.

export function parseRange(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const str = String(raw).trim();
    const single = str.match(/^(\d+)$/);
    if (single) return [parseInt(single[1], 10)];
    const range = str.match(/^(\d+)-(\d+)$/);
    if (range) {
        const s = parseInt(range[1], 10), e = parseInt(range[2], 10);
        if (s > e) return null;
        return Array.from({ length: e - s + 1 }, (_, i) => s + i);
    }
    return null;
}

// /change '범위 지정' 입력 전용 — 콤마로 나눈 각 조각이 단일 숫자("5") 또는 범위("2-8")면 되고,
// 섞어서 "0,2-8,11" 처럼 써도 됨. 조각 하나라도 형식이 안 맞으면 전체 무효(null)
export function parseChangeRangeInput(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return null;
    const parts = str.split(',').map(p => p.trim());
    if (!parts.length) return null;
    const result = [];
    for (const p of parts) {
        if (/^\d+$/.test(p)) { result.push(parseInt(p, 10)); continue; }
        const m = p.match(/^(\d+)-(\d+)$/);
        if (!m) return null;
        const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
        if (s > e) return null;
        for (let i = s; i <= e; i++) result.push(i);
    }
    return result;
}

// DOMParser 인스턴스를 매번 새로 안 만들고 재사용 — parseFromString은 호출마다 항상 새
// Document를 돌려주므로 인스턴스를 공유해도 호출 간 상태가 섞이지 않아 안전함(싱글스레드).
// /clip 전체 채팅 복사처럼 메시지 수백 개를 순회하며 반복 호출될 때 이득이 커짐.
const _wsDOMParser = new DOMParser();

export function stripText(html) {
    // <!--주석--> 은 별도로 지울 필요 없음 — DOM Comment 노드는 textContent에 애초에 포함 안 됨(스펙)
    const c = html.replace(/<style(\s[^>]*)?>[\s\S]*?<\/style>/gi, '');
    return _wsDOMParser.parseFromString(c, 'text/html').body.textContent || '';
}

export function escapeHTML(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function expandDetails(html) {
    const openRe = /<details\b[^>]*>/gi, closeRe = /<\/details>/gi;
    const tags = []; let m;
    openRe.lastIndex = 0; while ((m = openRe.exec(html))) tags.push({ type:'open',  start:m.index, end:m.index+m[0].length });
    closeRe.lastIndex = 0; while ((m = closeRe.exec(html))) tags.push({ type:'close', start:m.index, end:m.index+m[0].length });
    tags.sort((a,b) => a.start - b.start);
    let depth = 0, outerOpen = null; const pairs = [];
    for (const t of tags) {
        if (t.type === 'open') { if (depth === 0) outerOpen = t; depth++; }
        else { if (depth === 0) continue; depth--; if (depth === 0 && outerOpen) { pairs.push({ open:outerOpen, close:t }); outerOpen = null; } }
    }
    if (!pairs.length) return html.trim();
    let result = html;
    for (let i = pairs.length - 1; i >= 0; i--) {
        const { open, close } = pairs[i];
        const inner = result.slice(open.end, close.start).replace(/^\s*<summary>[\s\S]*?<\/summary>/i, '');
        result = result.slice(0, open.start) + inner.trim() + result.slice(close.end);
    }
    return result.trim();
}

// hex(#rrggbb) + alpha(0~100) → rgba() 문자열 변환
export function hexAlphaToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${(alpha/100).toFixed(2)})`;
}

export const ESC_SPECIAL = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ignoreSpace: 검색어의 띄어쓰기를 무시하고 각 글자 사이에 공백이 있든 없든 매치
export function applyFiller(escaped, ignoreSpace) {
    if (!ignoreSpace) return escaped;
    const stripped = escaped.replace(/ /g, ''); if (!stripped) return escaped;
    const atoms = []; let i = 0;
    while (i < stripped.length) {
        if (stripped[i] === '\\' && i + 1 < stripped.length) { atoms.push(stripped.slice(i, i+2)); i += 2; }
        else { atoms.push(stripped[i]); i++; }
    }
    return atoms.join('\\s*');
}

// 태그 무시 — "<"부터 ">"까지(속성값 포함) 전체를 같은 길이의 더미 문자(\u0000)로 치환해서
// 원본 글자 오프셋은 그대로 유지한 채 검색 대상에서만 제외.
export function maskTags(raw) {
    return raw.replace(/<[^>]*>/g, m => '\u0000'.repeat(m.length));
}

// /clip, /word, 그리고 /find·/change의 "추론 블럭 항상 무시" 옵션이 공유하는 추론 블럭 태그 목록.
const REASONING_WRAPPER_TAGS = ['think', 'thinking', 'CoT', 'starter'];

// 위 태그 목록을 훑으면서 각 블록(태그+내용 전부)을 콜백이 정한 대로 치환 — maskReasoningBlocks와
// stripReasoningBlocks가 "찾는 방식"은 완전히 같고 "찾은 뒤 뭘로 바꿀지"만 다르므로, 정규식
// 생성/순회 로직을 여기 하나로 모아서 중복을 없앰.
function replaceReasoningBlocks(raw, replacer) {
    let text = raw;
    for (const tag of REASONING_WRAPPER_TAGS) {
        const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}\\s*>`, 'gi');
        text = text.replace(re, replacer);
    }
    return text;
}

// 추론 블럭(태그+내용 전부)을 같은 길이의 더미 문자(\u0000)로 치환 — 원본 글자 오프셋은 그대로
// 유지한 채(치환/하이라이트 위치 계산이 안 어긋나게) 검색 대상에서만 제외. /find, /change 전용
// ("추론 블럭 항상 무시" 토글이 켜졌을 때만 사용).
export function maskReasoningBlocks(raw) {
    return replaceReasoningBlocks(raw, m => '\u0000'.repeat(m.length));
}

// 단어 일치 — 앞뒤로 글자/숫자/밑줄(한글 포함, \p{L}\p{N}_)이 아닌 경계에서만 매치되도록 감쌈
// 이 패턴을 쓰려면 정규식에 'u' 플래그가 반드시 있어야 함 (호출부에서 flags 구성 시 함께 추가)
export function applyWholeWord(pattern, wholeWord) {
    if (!wholeWord) return pattern;
    return `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
}

// ignoreReasoning: 에딧모드의 "추론 블럭 항상 무시" 전역 토글 — 켜져 있으면 /find, /change 모두
// 검색어 옵션(태그 무시 등)과 별개로 항상 추론 블럭 내용을 검색 대상에서 제외함.
// getText: 기본은 msg.mes를 검색하지만, /find-trans·/change-trans처럼 다른 필드(번역문 등)를
// 검색해야 할 때 (msg => 텍스트) 형태로 넘겨서 검색 대상 자체를 바꿀 수 있음.
export function buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord = false, ignoreTags = false, allowedIdxs = null, ignoreReasoning = false, getText = null) {
    const re_esc = applyWholeWord(applyFiller(escaped, ignoreSpace), wholeWord), all = [];
    const allowedSet = allowedIdxs ? new Set(allowedIdxs) : null;
    chat.forEach((msg, msgIdx) => {
        if (allowedSet && !allowedSet.has(msgIdx)) return;
        let searchText = getText ? getText(msg) : msg.mes;
        if (searchText === undefined || searchText === null) return;
        if (ignoreTags) searchText = maskTags(searchText);
        if (ignoreReasoning) searchText = maskReasoningBlocks(searchText);
        let re_flags = flags.includes('g') ? flags : flags + 'g';
        if (wholeWord && !re_flags.includes('u')) re_flags += 'u';
        const re = new RegExp(re_esc, re_flags);
        let m, matchIdx = 0;
        while ((m = re.exec(searchText)) !== null) {
            if (m.index === re.lastIndex) { re.lastIndex++; continue; }
            all.push({ msgIdx, matchIdx, charIdx: m.index }); matchIdx++;
        }
    });
    return all;
}

// find/change 패널의 검색 범위 입력창 검증 — /change '모두 바꾸기'와 동일한 문법 사용
// ("5", "2-8", "0,2-8,11" 등 쉼표 혼용 가능). 비어있으면 제한 없음, 형식이 잘못되면 'invalid'.
export function parseRangeInputFlexible(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return { idxs: null };
    const idxs = parseChangeRangeInput(str);
    if (idxs === null) return 'invalid';
    return { idxs };
}

// word/clip 전용 — 메시지 안 "어디에" 있든 알려진 추론 블록 래퍼를 통째로(태그+내용 전부) 제거.
// 에딧모드의 "추론 블럭 항상 무시" 토글과는 무관하게 /clip, /word에서는 항상 적용됨(추론 내용이
// 복사/글자수 계산에 섞이면 안 되니까). stripLeadingTagBlock과 달리 맨 앞뿐 아니라 전체를 훑고,
// 알려진 태그 이름만 대상으로 함(임의의 아무 태그나 지우면 정상 서식용 HTML까지 날아갈 수 있어서
// 화이트리스트 방식으로 감).
export function stripReasoningBlocks(raw) {
    return replaceReasoningBlocks(raw, () => '');
}

// hidden 패널 미리보기용 — 메시지 맨 앞의 <tag>...</tag> 추론 블록 전체(태그 포함)를 제거.
// 정규식 기반이며 while로 반복 적용하므로 <a>..</a><b>..</b> 처럼 블록이 연달아 와도
// 앞에서부터 하나씩 계속 벗겨냄(중첩된 동일 태그 자체는 처리 안 함 — 애초에 추론 블록은 안 겹치는 구조라 가정).
export function stripLeadingTagBlock(raw) {
    let text = raw;
    while (true) {
        const trimmed = text.replace(/^\s+/, '');
        const m = trimmed.match(/^<([a-zA-Z0-9_-]+)(?:\s[^>]*)?>/);
        if (!m) break;
        const tag = m[1];
        const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
        const closeMatch = closeRe.exec(trimmed);
        if (!closeMatch) break;
        text = trimmed.slice(closeMatch.index + closeMatch[0].length);
    }
    return text;
}

// 삽입 지점 앞/뒤 공백 여부를 확인해서, 없을 때만 딱 한 칸 채워줌
export function smartInsertSpacing(fullText, insertPos, insertedText) {
    const before = fullText[insertPos - 1], after = fullText[insertPos];
    const left  = (before !== undefined && !/\s/.test(before)) ? ' ' : '';
    const right = (after  !== undefined && !/\s/.test(after))  ? ' ' : '';
    return fullText.slice(0, insertPos) + left + insertedText + right + fullText.slice(insertPos);
}
