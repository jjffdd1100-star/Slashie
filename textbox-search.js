// ─── textbox-search.js ──────────────────────────────────────────────────────
// 팝업 텍스트박스(사용자 정의 CSS / 캐릭터 설명 / 첫 번째 메시지) 전용 찾기(+바꾸기).
// (대체 첫 메시지는 팝업이 별도 레이어라 패널이 그 뒤에 가려지는 문제를 해결 못해 포기함)
//
// textarea는 실제 DOM 안에 <mark> 태그를 못 넣으므로(순수 텍스트 입력창), textarea 위에 완전히
// 겹치는 투명 텍스트 오버레이(div)를 하나 깔고 그 안의 매치 부분에만 빨간 밑줄을 그리는 방식
// (표준 textarea 하이라이팅 기법)을 씀. 오버레이 자체는 pointer-events:none이라 클릭/타이핑은
// 항상 실제 textarea가 그대로 받지만, <mark> 하나하나는 pointer-events:auto로 열어둬서
// 밑줄 그어진 단어를 직접 클릭하면 그 매치로 패널이 점프하게 함(채팅 본문 검색과 동일한 동작).
// textarea.value 자체는 절대 건드리지 않음(치환 시에만 씀).
//
// 패널이 ST 드로어(설정/캐릭터 시트 오버레이) 밖(body 직속)에 붙는 문제로 "바깥 클릭 시 드로어
// 닫힘" 버그가 있었음 — 이건 panel-ui.js의 createPanel에서 공통으로 막아둠(stopPropagation).

import { wsSettings } from './state.js';
import { createPanel, getPanelBody, closePanel, centerOf, keepCenter, btn, inputBox, searchOptions } from './panel-ui.js';
import { escapeHTML, applyFiller, applyWholeWord, maskTags, ESC_SPECIAL } from './utils.js';

const GROUPS = [
    // customCSS — anchor 좌표 방식이 계속 불안정해서, 계산이 아예 필요 없는 단순한 방식으로
    // 되돌림: textarea 바로 위에 그 버튼만 있는 한 행을 추가.
    // 실수로 테마가 깨지면 복구가 어려우니 이 그룹은 바꾸기 없이 찾기 전용(readOnly)으로만 동작.
    { key: 'customCSS',    selector: '#customCSS',              cssVariant: 'css',  placement: 'row', readOnly: true },
    // description/firstMessage는 이미 있는 버튼(외부 미디어 / 대체. 첫 메시지) 바로 왼쪽에
    // 절대위치로 얹음(그 요소의 레이아웃은 전혀 안 건드림). 위치는 감시 루프가 돌 때마다
    // 매번 다시 계산해서, 다른 패널을 여닫아 레이아웃이 잠깐 흔들려도 다음 틱에 스스로 교정됨.
    { key: 'description',  selector: '#description_textarea',   cssVariant: 'char', placement: 'anchor',
        anchorSelector: '#character_open_media_overrides' },
    { key: 'firstMessage', selector: '#firstmessage_textarea',  cssVariant: 'char', placement: 'anchor',
        anchorSelector: '.open_alternate_greetings' },
];

function getGroupElements(group) {
    return document.querySelector(group.selector) ? [document.querySelector(group.selector)] : [];
}

// selector에 맞는 후보들을 문서 전체에서 모은 뒤, el보다 "화면상 바로 위에 있으면서 가장 가까운"
// 것을 좌표로 찾음. 너무 멀리 떨어진 걸 집었다면(다른 화면의 엉뚱한 버튼일 가능성) 못 찾은
// 걸로 처리 — 화면 구석에 뜬금없이 버튼이 붙는 것보단 안 뜨는 게 안전함.
function findNearestByPosition(el, selector, maxDist = 200) {
    const candidates = Array.from(document.querySelectorAll(selector)).filter(c => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    });
    if (!candidates.length) return null;
    const elRect = el.getBoundingClientRect();
    const above = candidates.filter(c => c.getBoundingClientRect().bottom <= elRect.top + 4);
    const pool = above.length ? above : candidates;
    pool.sort((a, b) => {
        const da = Math.abs(elRect.top - a.getBoundingClientRect().bottom);
        const db = Math.abs(elRect.top - b.getBoundingClientRect().bottom);
        return da - db;
    });
    const best = pool[0];
    const dist = Math.abs(elRect.top - best.getBoundingClientRect().bottom);
    return dist <= maxDist ? best : null;
}

// ─── 오버레이(빨간 밑줄) ────────────────────────────────────────────────
const OVERLAY_STYLE_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxSizing', 'textAlign', 'textIndent', 'tabSize',
];

// textarea에 세로 스크롤바가 생기면(글이 길어지면) 실제 글자가 들어가는 폭이 그만큼 줄어드는데,
// 오버레이는 스크롤바가 없어서 그 사실을 몰라 줄바꿈 지점이 어긋나는 문제가 있었음(짧은 글은
// 멀쩡하다가 스크롤 생기는 시점부터 밑줄이 위아래로 밀리는 증상). 지금 스크롤바가 있는지
// 감지해서 그만큼 오버레이 폭도 좁혀서 항상 textarea와 같은 지점에서 줄바꿈되게 맞춤.
function syncOverlayGeometry(ta, overlay) {
    const cs = getComputedStyle(ta);
    OVERLAY_STYLE_PROPS.forEach(p => { overlay.style[p] = cs[p]; });
    const hasScrollbar = ta.scrollHeight > ta.clientHeight + 1;
    const borderX = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    const scrollbarW = Math.max(0, ta.offsetWidth - ta.clientWidth - borderX);
    overlay.style.width = `${ta.offsetWidth - (hasScrollbar ? scrollbarW : 0)}px`;
    overlay.style.height = `${ta.offsetHeight}px`;
    overlay.style.top = `${ta.offsetTop}px`;
    overlay.style.left = `${ta.offsetLeft}px`;
}

// 검색 세션(패널이 열려있는 동안) 동안만 존재 — 패널 닫히면 항상 제거됨
function ensureOverlay(ta) {
    if (ta._wsOverlay) return ta._wsOverlay;
    const parent = ta.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const overlay = document.createElement('div');
    overlay.className = 'ws-textbox-overlay';
    overlay.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;'
        + 'white-space:pre-wrap;word-wrap:break-word;word-break:break-word;'
        + 'color:transparent;background:transparent;z-index:2;';
    parent.insertBefore(overlay, ta.nextSibling);
    syncOverlayGeometry(ta, overlay);
    const onResize = () => syncOverlayGeometry(ta, overlay);
    window.addEventListener('resize', onResize);
    // 'scroll' 이벤트 기반 동기화는 (특히 모바일 관성 스크롤 중) 한 프레임 정도 밀려서
    // 오버레이가 눈에 띄게 지연되어 따로 노는 것처럼 보이는 문제가 있었음 →
    // requestAnimationFrame으로 매 프레임 직접 맞춰서 그 지연을 없앰.
    let raf = requestAnimationFrame(function loop() {
        overlay.scrollTop = ta.scrollTop; overlay.scrollLeft = ta.scrollLeft;
        raf = requestAnimationFrame(loop);
    });
    overlay.scrollTop = ta.scrollTop; overlay.scrollLeft = ta.scrollLeft;
    // 오버레이 자체는 pointer-events:none(타이핑/커서 이동 방해 안 하려고)이지만, 그 안의
    // <mark>들은 CSS에서 pointer-events:auto로 개별적으로 열어둠 — 그래서 밑줄 그어진 단어를
    // 직접 클릭하면 여기로 이벤트가 위임되어 들어옴(부모가 none이어도 자식이 auto면 그 자식
    // 자체는 클릭을 받고, 이벤트는 정상적으로 버블링됨).
    const onMarkClick = e => {
        const mark = e.target.closest('mark[data-idx]');
        if (!mark) return;
        e.stopPropagation();
        overlay._wsOnMarkClick?.(parseInt(mark.dataset.idx, 10));
    };
    overlay.addEventListener('click', onMarkClick);
    ta._wsOverlay = overlay;
    ta._wsOverlayCleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', onResize);
        overlay.removeEventListener('click', onMarkClick);
        overlay.remove();
        ta._wsOverlay = null; ta._wsOverlayCleanup = null;
    };
    return overlay;
}

function removeOverlay(ta) { ta._wsOverlayCleanup?.(); }
function clearOverlays(elements) { elements.forEach(removeOverlay); }

function renderOverlayContent(ta, matchesForEl, currentGlobalIdx) {
    const overlay = ensureOverlay(ta);
    syncOverlayGeometry(ta, overlay);
    const text = ta.value;
    if (!matchesForEl.length) { overlay.innerHTML = escapeHTML(text); return; }
    let html = '', pos = 0;
    for (const m of matchesForEl) {
        html += escapeHTML(text.slice(pos, m.start));
        html += `<mark data-idx="${m.globalIdx}" class="${m.globalIdx === currentGlobalIdx ? 'ws-tb-cur' : ''}">${escapeHTML(text.slice(m.start, m.end))}</mark>`;
        pos = m.end;
    }
    html += escapeHTML(text.slice(pos));
    overlay.innerHTML = html;
}

// ─── 매치 탐색 ────────────────────────────────────────────────────────────
function buildTextboxMatches(elements, escaped, flags, ignoreSpace, wholeWord, ignoreTags) {
    const re_esc = applyWholeWord(applyFiller(escaped, ignoreSpace), wholeWord);
    let re_flags = flags.includes('g') ? flags : flags + 'g';
    if (wholeWord && !re_flags.includes('u')) re_flags += 'u';
    if (!re_flags.includes('d')) re_flags += 'd';
    const all = [];
    elements.forEach((el, elIdx) => {
        const searchText = ignoreTags ? maskTags(el.value) : el.value;
        const re = new RegExp(re_esc, re_flags);
        let m;
        while ((m = re.exec(searchText)) !== null) {
            if (m.index === re.lastIndex) { re.lastIndex++; continue; }
            const [s, e] = m.indices[0];
            all.push({ elIdx, start: s, end: e });
        }
    });
    all.forEach((m, i) => { m.globalIdx = i; });
    return all;
}

// 검색어가 최대한 중앙에 오는 한 줄 스니펫. 앞쪽은 잘려도 "…" 없이 바로 시작하고,
// 뒤쪽만 실제로 더 남아있을 때 "…" 표시. 검색어 자체는 굵게 표시.
function buildSnippet(text, start, end, leftPad = 25, rightPad = 40) {
    const left = text.slice(Math.max(0, start - leftPad), start);
    const right = text.slice(end, end + rightPad);
    const rightEllipsis = end + rightPad < text.length ? '…' : '';
    return `${escapeHTML(left)}<b>${escapeHTML(text.slice(start, end))}</b>${escapeHTML(right)}${rightEllipsis}`;
}

// 목록에서 현재 선택된 항목이 스크롤 맨 위가 아니라 정중앙에 오게 맞춤(리스트가 길 때
// 매번 맨 위로 튀는 게 아니라, 검토 중이던 위치 근처를 계속 보여주기 위함).
function centerActiveInScroll(scrollEl) {
    requestAnimationFrame(() => {
        const activeEl = scrollEl?.querySelector('.ws-result-item.active');
        if (!scrollEl || !activeEl) return;
        scrollEl.scrollTop = Math.max(0, activeEl.offsetTop - scrollEl.clientHeight / 2 + activeEl.clientHeight / 2);
    });
}

// ─── 패널 상태 관리(토글용) ─────────────────────────────────────────────────
const PANEL_ID = 'ws-tbchange-panel';
let _tbCloseFn = null;

function closeTextboxPanel() { _tbCloseFn?.(); _tbCloseFn = null; }

function toggleTextboxPanel(group, el) {
    if (document.getElementById(PANEL_ID)) { closeTextboxPanel(); return; }
    openTextboxKeywordPanel(group, el);
}

function openTextboxKeywordPanel(group, anchorEl) {
    const panel = createPanel(PANEL_ID, centerOf(anchorEl), () => { closePanel(PANEL_ID); _tbCloseFn = null; });
    _tbCloseFn = () => { closePanel(PANEL_ID); _tbCloseFn = null; };
    const body = getPanelBody(panel);
    const input = inputBox('찾을 단어를 입력하세요'); body.appendChild(input);
    const opts = searchOptions(); body.appendChild(opts.el);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:flex-end;';
    const doSearch = () => {
        const kw = input.value.trim(); if (!kw) return;
        const center = centerOf(panel);
        runTextboxChange(group, kw, opts.getCaseSensitive(), opts.getIgnoreSpace(), opts.getWholeWord(), opts.getIgnoreTags(), center);
    };
    row.appendChild(btn('찾기', doSearch, 'ws-btn-accent'));
    body.appendChild(row); setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
}

function runTextboxChange(group, keyword, caseSensitive, ignoreSpace, wholeWord, ignoreTags, posCenter) {
    closePanel(PANEL_ID); // 입력 패널이 열려있었다면 정리
    const readOnly = !!group.readOnly;
    const elements = getGroupElements(group);
    if (!elements.length) { toastr.info('텍스트박스를 찾을 수 없습니다.', '', { timeOut:3000 }); return; }
    const escaped = ESC_SPECIAL(keyword);
    const flags = caseSensitive ? 'g' : 'gi';
    let allMatches = buildTextboxMatches(elements, escaped, flags, ignoreSpace, wholeWord, ignoreTags);
    if (!allMatches.length) { toastr.info('검색 결과가 없습니다.', '', { timeOut:3000 }); return; }

    // 바꾸기가 없는(readOnly) 그룹은 번거로운 메뉴 페이지 자체를 건너뛰고 바로 하나씩 검토로 진입
    let current = 0, mode = readOnly ? 'one' : 'menu', listReturnMode = mode, lastReplace = '';

    function redrawOverlays() {
        const byEl = new Map();
        allMatches.forEach(m => { if (!byEl.has(m.elIdx)) byEl.set(m.elIdx, []); byEl.get(m.elIdx).push(m); });
        elements.forEach((el, i) => {
            renderOverlayContent(el, byEl.get(i) || [], allMatches[current]?.globalIdx);
            // 밑줄 단어 직접 클릭 → 그 매치로 패널 이동(하나씩 검토 화면으로 전환).
            // 이미 화면에 보이는 지점을 클릭한 것이므로 스크롤은 움직이지 않음(◀/▶와는 다르게 취급)
            if (el._wsOverlay) el._wsOverlay._wsOnMarkClick = idx => {
                mode = 'one'; current = idx; redrawOverlays(); render();
            };
        });
    }

    // 사용자가 텍스트박스를 직접 타이핑해서 고치는 동안 매번 다시 그리면 스크롤과 겹쳐 어지러움 —
    // 대신 타이핑 중엔 오버레이를 반투명하게 낮춰두고, 입력이 1초간 멈추면 그때 한 번만 다시 계산.
    const typingTimers = new Map();
    const typingCleanups = [];
    elements.forEach((el, idx) => {
        const onInput = () => {
            if (el._wsOverlay) el._wsOverlay.style.opacity = '0.35';
            clearTimeout(typingTimers.get(idx));
            typingTimers.set(idx, setTimeout(() => {
                rebuildMatches();
                elements.forEach(e => { if (e._wsOverlay) e._wsOverlay.style.opacity = '1'; });
                if (!allMatches.length) { toastr.info('더 이상 일치하는 항목이 없습니다.', '', { timeOut:2000 }); cleanupAndClose(); return; }
                if (current >= allMatches.length) current = allMatches.length - 1;
                redrawOverlays();
                render();
            }, 1000));
        };
        el.addEventListener('input', onInput);
        typingCleanups.push(() => { el.removeEventListener('input', onInput); clearTimeout(typingTimers.get(idx)); });
    });

    function cleanupAndClose() {
        typingCleanups.forEach(fn => fn());
        clearOverlays(elements);
        closePanel(PANEL_ID);
        _tbCloseFn = null;
    }
    _tbCloseFn = cleanupAndClose;

    const panel = createPanel(PANEL_ID, posCenter, cleanupAndClose), cb = getPanelBody(panel);
    function setFixed() { Object.assign(cb.style, { display:'block', flex:'none', height:'', maxHeight:'', overflowY:'visible', padding:'4px 16px 16px' }); }

    // 현재 매치가 있는 textarea 자체를 화면에 보이게 + textarea 내부 스크롤도 매치 위치로 이동
    function focusCurrentMatch() {
        const m = allMatches[current]; if (!m) return;
        const el = elements[m.elIdx];
        el.scrollIntoView({ block: 'center' });
        requestAnimationFrame(() => {
            const overlay = el._wsOverlay;
            const markEl = overlay?.querySelector('mark.ws-tb-cur');
            if (markEl) {
                const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
                const target = Math.max(0, Math.min(markEl.offsetTop - el.clientHeight / 2, maxScroll));
                el.scrollTop = target; overlay.scrollTop = target;
            }
        });
    }

    function navigate(newIdx) { current = newIdx; redrawOverlays(); render(); focusCurrentMatch(); }

    function rebuildMatches() {
        allMatches = buildTextboxMatches(elements, escaped, flags, ignoreSpace, wholeWord, ignoreTags);
    }

    function doReplaceOne(m, rep) {
        const el = elements[m.elIdx];
        el.value = el.value.slice(0, m.start) + rep + el.value.slice(m.end);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function doReplaceAll(rep) {
        const byEl = new Map();
        allMatches.forEach(m => { if (!byEl.has(m.elIdx)) byEl.set(m.elIdx, []); byEl.get(m.elIdx).push(m); });
        byEl.forEach((ms, elIdx) => {
            const el = elements[elIdx];
            let val = el.value;
            for (let i = ms.length - 1; i >= 0; i--) val = val.slice(0, ms[i].start) + rep + val.slice(ms[i].end);
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    function render() {
        const prevCenter = panel._wsPositioned ? centerOf(panel) : null;
        if (mode === 'list') {
            Object.assign(cb.style, { display:'flex', flexDirection:'column', padding:'4px 16px 0', overflow:'hidden', flex:'none', height:'auto', maxHeight:'320px' });
            cb.innerHTML = '';
            const scroll = document.createElement('div'); scroll.className = 'ws-thin-scroll'; scroll.style.cssText = 'flex:1;overflow-y:auto;min-height:0;';
            allMatches.forEach((m, i) => {
                const el = elements[m.elIdx];
                const item = document.createElement('div');
                item.className = 'ws-result-item' + (i === current ? ' active' : '');
                item.style.cssText = 'display:flex;gap:8px;white-space:nowrap;overflow:hidden;';
                const num = document.createElement('span'); num.style.cssText = 'color:var(--ws-text2);flex-shrink:0;'; num.textContent = `${i + 1}`;
                const snip = document.createElement('span'); snip.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
                snip.innerHTML = buildSnippet(el.value, m.start, m.end);
                item.appendChild(num); item.appendChild(snip);
                item.addEventListener('click', () => { mode = 'one'; navigate(i); });
                scroll.appendChild(item);
            });
            cb.appendChild(scroll);
            centerActiveInScroll(scroll);
            const backRow = document.createElement('div'); backRow.style.cssText = 'display:flex;justify-content:flex-end;flex-shrink:0;padding:10px 0 12px;margin-top:4px;';
            backRow.appendChild(btn('돌아가기', () => { mode = listReturnMode; render(); }));
            cb.appendChild(backRow);

        } else if (mode === 'menu') {
            setFixed(); cb.innerHTML = '';
            const title = document.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:14px;';
            title.innerHTML = `"${escapeHTML(keyword)}" <span style="color:var(--ws-text2);font-size:12px">${allMatches.length}개 발견</span>`;
            cb.appendChild(title);
            const repInput = document.createElement('input'); repInput.placeholder = '바꿀 단어'; repInput.value = lastReplace; repInput.className = 'ws-input'; repInput.style.marginBottom = '14px';
            repInput.autocomplete = 'off'; repInput.autocorrect = 'off'; repInput.autocapitalize = 'off'; repInput.spellcheck = false;
            repInput.addEventListener('input', () => { lastReplace = repInput.value; });
            cb.appendChild(repInput);
            const row2 = document.createElement('div'); row2.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
            const left = document.createElement('div'); left.style.cssText = 'display:flex;gap:6px;';
            left.appendChild(btn('하나씩 검토', () => { mode = 'one'; navigate(current); }));
            left.appendChild(btn('목록', () => { listReturnMode = 'menu'; mode = 'list'; render(); }));
            row2.appendChild(left);
            row2.appendChild(btn('모두 바꾸기', () => {
                lastReplace = repInput.value;
                const count = allMatches.length;
                doReplaceAll(repInput.value);
                toastr.success(`${count}개를 수정했습니다.`, '', { timeOut:3000 });
                cleanupAndClose();
            }, 'ws-btn-accent'));
            cb.appendChild(row2);

        } else { // one
            setFixed(); cb.innerHTML = '';
            const m = allMatches[current]; if (!m) { cleanupAndClose(); return; }
            const header = document.createElement('div'); header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;';
            const titleEl = document.createElement('span'); titleEl.style.cssText = 'font-weight:600;';
            titleEl.textContent = readOnly ? `"${keyword}"` : `"${keyword}" 검토`;
            const posEl = document.createElement('span'); posEl.style.cssText = 'color:var(--ws-text2);font-size:12px;margin-left:auto;';
            posEl.textContent = `${current + 1}/${allMatches.length}`;
            header.appendChild(titleEl); header.appendChild(posEl); cb.appendChild(header);
            if (!readOnly) {
                const repInput = document.createElement('input'); repInput.placeholder = '바꿀 단어'; repInput.value = lastReplace; repInput.className = 'ws-input'; repInput.style.marginBottom = '20px';
                repInput.autocomplete = 'off'; repInput.autocorrect = 'off'; repInput.autocapitalize = 'off'; repInput.spellcheck = false;
                repInput.addEventListener('input', () => { lastReplace = repInput.value; }); cb.appendChild(repInput);
            }
            const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
            const left = document.createElement('div'); left.style.cssText = 'display:flex;gap:6px;';
            left.appendChild(btn('◀ 이전', () => { if (current === 0) { toastr.info('처음입니다.', '', { timeOut:2000 }); return; } navigate(current - 1); }));
            left.appendChild(btn('다음 ▶', () => { if (current < allMatches.length - 1) navigate(current + 1); else toastr.info('마지막입니다.', '', { timeOut:2000 }); }));
            const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:6px;';
            right.appendChild(btn('목록', () => { listReturnMode = 'one'; mode = 'list'; render(); }));
            if (!readOnly) {
                right.appendChild(btn('바꾸기', () => {
                    const repInput = cb.querySelector('input.ws-input');
                    lastReplace = repInput.value;
                    doReplaceOne(m, repInput.value);
                    rebuildMatches();
                    if (!allMatches.length) { toastr.success('수정이 완료되었습니다.', '', { timeOut:3000 }); cleanupAndClose(); return; }
                    if (current >= allMatches.length) current = allMatches.length - 1;
                    redrawOverlays(); render(); focusCurrentMatch();
                }, 'ws-btn-accent'));
            }
            row.appendChild(left); row.appendChild(right); cb.appendChild(row);
        }
        keepCenter(panel, prevCenter);
    }
    redrawOverlays();
    render();
    focusCurrentMatch();
}

// ─── 버튼 생성/주입 ──────────────────────────────────────────────────────
// cssVariant('css'|'char')로 클래스를 나눠서, 커스텀 CSS에서 두 종류를 따로따로 크기 조절할
// 수 있게 함 — 기기/테마마다 옆 버튼 크기가 달라서 실측으로 맞추면 오히려 기기별로 들쭉날쭉했음.
function makeSearchBtn(group, el) {
    const b = document.createElement('button');
    b.className = `ws-stitch-btn ws-tb-search-btn ws-tb-search-btn-${group.cssVariant}`;
    b.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
    b.addEventListener('click', () => toggleTextboxPanel(group, el));
    return b;
}

// customCSS 전용 — 계산 없이 textarea 바로 위에 그 버튼만 있는 한 행을 추가.
function ensureRowButton(group, el) {
    if (el._wsSearchBtnWrap && el._wsSearchBtnWrap.isConnected) return;
    const wrap = document.createElement('div');
    wrap.className = 'ws-tb-btn-row';
    // 좌표 계산(anchor) 방식이 이 그룹에서만 계속 불안정해서, 순수 CSS만으로 위로 끌어올리는
    // 방식으로 시도함.
    // 위치가 안 맞으면 이 두 숫자만 직접 고치면 됨
    //   liftPx  — 클수록 버튼이 더 위로 올라감(제목 행 쪽으로)
    //   rightPx — 클수록 버튼이 더 왼쪽으로 밀림(확대 아이콘과 안 겹치게)
    const liftPx = 27, rightPx = 22;
    wrap.style.cssText = `display:flex;justify-content:flex-end;padding-right:${rightPx}px;`
        + `margin-top:-${liftPx}px;margin-bottom:4px;`;
    wrap.appendChild(makeSearchBtn(group, el));
    el.parentElement.insertBefore(wrap, el);
    el._wsSearchBtnWrap = wrap;
}

// 버튼마다 각각 resize 리스너를 등록하면(과거 방식) 버튼이 늘어날수록 리스너도 늘어나고,
// cleanup이 실패해 버튼이 DOM에서 사라진 뒤에도 리스너만 계속 남는 누수 가능성이 있었음.
// → 전역 리스너 하나만 두고 Map으로 reposition 함수들을 관리 — 실행할 때마다 버튼이 여전히
// DOM에 붙어있는지 확인해서, 끊긴 게 있으면 그 자리에서 자동으로 정리함(self-healing이라
// 개별 cleanup 호출이 누락돼도 다음 resize 때 스스로 회수됨).
const _anchorRepositions = new Map();
let _resizeListenerInstalled = false;
function ensureGlobalResizeListener() {
    if (_resizeListenerInstalled) return;
    _resizeListenerInstalled = true;
    window.addEventListener('resize', () => {
        _anchorRepositions.forEach((reposition, b) => {
            if (!b.isConnected) { _anchorRepositions.delete(b); return; }
            reposition();
        });
    });
}

// description / firstMessage 전용 — anchor 요소(외부미디어/대체.첫메시지 버튼)의 레이아웃은 절대 건드리지 않고, 그 화면 좌표만 실측해서 바로 왼쪽에 절대위치로
// 얹음. reposition 함수를 버튼에 저장해두고, refreshTextboxButtons가 돌 때마다 항상 다시
// 불러서(생성 시 1회 + 리사이즈 때만 하던 것에서 변경) 다른 패널을 여닫아 레이아웃이 잠깐
// 흔들려도 다음 틱에 스스로 교정되게 함.
function ensureAnchorButton(group, el) {
    if (el._wsSearchBtnWrap && el._wsSearchBtnWrap.isConnected) { el._wsSearchBtnWrap._wsReposition?.(); return; }
    const anchor = findNearestByPosition(el, group.anchorSelector, group.maxDist ?? 200);
    if (!anchor) return;
    const parent = anchor.offsetParent || anchor.parentElement || document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const b = makeSearchBtn(group, el);
    parent.appendChild(b);
    b.style.position = 'absolute';
    b.style.margin = '0';
    b.style.zIndex = '3';
    const reposition = () => {
        const pRect = parent.getBoundingClientRect();
        const aRect = anchor.getBoundingClientRect();
        const newTop = aRect.top - pRect.top;
        const newLeft = aRect.left - pRect.left - b.offsetWidth - 6;
        // 감시 루프가 아주 자주 도는데, 미세한(1px 미만) 흔들림까지 그대로 반영하면 버튼이
        // 위아래로 떠는 것처럼 보임 — 실제로 의미 있게 어긋났을 때만 좌표를 갱신함.
        const curTop = parseFloat(b.style.top) || 0;
        const curLeft = parseFloat(b.style.left) || 0;
        if (Math.abs(newTop - curTop) > 1) b.style.top = `${newTop}px`;
        if (Math.abs(newLeft - curLeft) > 1) b.style.left = `${newLeft}px`;
    };
    b._wsReposition = reposition;
    ensureGlobalResizeListener();
    _anchorRepositions.set(b, reposition);
    requestAnimationFrame(reposition);
    b._wsFloatCleanup = () => _anchorRepositions.delete(b);
    el._wsSearchBtnWrap = b;
}

function ensureButtonFor(group, el) {
    if (group.placement === 'row') ensureRowButton(group, el);
    else if (group.placement === 'anchor') ensureAnchorButton(group, el);
}
function removeButtonFor(el) {
    el._wsSearchBtnWrap?._wsFloatCleanup?.();
    el._wsSearchBtnWrap?.remove();
    el._wsSearchBtnWrap = null;
}

export function refreshTextboxButtons() {
    GROUPS.forEach(group => {
        const enabled = wsSettings.uiSearchEnabled && wsSettings.textboxSearch[group.key];
        getGroupElements(group).forEach(el => { enabled ? ensureButtonFor(group, el) : removeButtonFor(el); });
    });
}

export function initTextboxSearch() {
    if (window._wsTextboxSearch) window._wsTextboxSearch();
    refreshTextboxButtons();
    const observer = new MutationObserver(() => refreshTextboxButtons());
    observer.observe(document.body, { childList: true, subtree: true });
    window._wsTextboxSearch = () => { observer.disconnect(); window._wsTextboxSearch = null; };
}
