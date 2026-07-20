// ─── drag-features.js ───────────────────────────────────────────────────────
// 드래그 선택 시 뜨는 검색/치환/빠른수정 필, QR 버튼 드래그 연동, 향상된 메시지 삭제.

import { ESC_SPECIAL, smartInsertSpacing } from './utils.js';
import { getChat, editMessage, editTranslatedText, getSearchableText, wsSettings, copyText, copyFullChat } from './state.js';
import { stripText, stripReasoningBlocks } from './utils.js';
import { createPanel, getPanelBody, closePanel, inputBox, btn } from './panel-ui.js';
import { safeHighlight } from './highlight.js';
import { runFind, runChange, openFindKeywordPanel, openChangeKeywordPanel } from './find-change.js';

// "향상된 메시지 삭제" 버튼 주입용 관찰자 — 토글이 꺼져있으면 아예 관찰 자체를 안 하도록
// (예전엔 설정과 무관하게 document.body 전체를 세션 내내 감시했음) 모듈 스코프에 둬서
// 에딧모드 토글 change 핸들러에서 refreshEnhancedDeleteObserver()로 바로 켜고 끌 수 있게 함.
let _delBtnObserver = null;
// 버튼을 실제로 넣고 빼는 함수 자체도 참조해둠 — 관찰자를 끄면 그 뒤로 DOM 변화가 있어도
// 콜백이 안 도니까, 토글이 꺼지는 바로 그 순간에 한 번은 직접 호출해서 이미 붙어있던 버튼을
// 확실히 지워줘야 함(안 그러면 관찰자만 멈추고 버튼은 화면에 그대로 남아있는 문제가 생김).
let _ensureDeleteExtraButtonsRef = null;
export function refreshEnhancedDeleteObserver() {
    if (!_delBtnObserver) return;
    if (wsSettings.enhancedDelete) {
        _delBtnObserver.observe(document.body, { childList: true, subtree: true });
        _ensureDeleteExtraButtonsRef?.(); // 켜지는 순간 이미 삭제 다이얼로그가 열려있을 수도 있어서 즉시 한 번 시도
    } else {
        _delBtnObserver.disconnect();
        _ensureDeleteExtraButtonsRef?.(); // 꺼지는 순간 붙어있던 버튼을 확실히 정리
    }
}

// ─── 드래그-빠른수정(연필) — 드래그한 바로 그 위치 하나만 정확히 치환 ────────
// 렌더링된 화면 텍스트로 "몇 번째 등장인지" 세는 방식은 메시지 안에 마크다운 서식
// (*이탤릭*, **볼드** 등)이 섞여있으면 원본 텍스트와 글자 수/순서가 어긋나서 엉뚱한
// 자리를 잘라내는 문제가 있었음 → 대신 선택한 텍스트 앞뒤 문맥(context)을 함께 찾아서
// 원본 텍스트에서 "유일하게" 위치를 특정하는 방식으로 교체 (등장 횟수 세기 자체를 안 함)
function getMatchContext(selRange, contextLen = 60) {
    const startEl = selRange.startContainer.nodeType === 1 ? selRange.startContainer : selRange.startContainer.parentElement;
    const mesEl = startEl?.closest('.mes[mesid]');
    if (!mesEl) return null;
    const msgIdx = parseInt(mesEl.getAttribute('mesid'), 10);
    const mesTextEl = mesEl.querySelector('.mes_text');
    if (!mesTextEl) return null;
    const preRange = document.createRange();
    preRange.selectNodeContents(mesTextEl);
    preRange.setEnd(selRange.startContainer, selRange.startOffset);
    const postRange = document.createRange();
    postRange.selectNodeContents(mesTextEl);
    postRange.setStart(selRange.endContainer, selRange.endOffset);
    return {
        msgIdx,
        beforeCtx: preRange.toString().slice(-contextLen),
        afterCtx: postRange.toString().slice(0, contextLen),
    };
}

// beforeCtx/afterCtx 길이를 점점 줄여가며(마크다운 기호가 문맥 안에 끼어있을 경우 대비)
// "문맥 + (기호 0개 이상) + 타겟 + (기호 0개 이상) + 문맥" 패턴이 원본에서 유일하게 1번만
// 매치되는 지점을 찾음. 'd' 플래그로 캡처 그룹의 정확한 시작/끝 오프셋을 직접 얻음.
// 에딧모드의 "번역문 우선"이 켜져있으면 번역문(msg.extra.display_text)에서 먼저 찾고,
// 없거나 못 찾으면 원문(msg.mes)에서 찾음 — 어느 쪽에서 찾았는지 field로 알려줌.
function locateRawOffset(msgIdx, beforeCtx, target, afterCtx) {
    const msg = getChat()[msgIdx];
    if (!msg) return null;
    const MD_GAP = '[*_~`]{0,10}'; // 무한 반복(*) 대신 최대 10개로 제한 — 백트래킹 폭주(ReDoS) 방지
    const escTarget = ESC_SPECIAL(target);
    const tryField = (raw, field) => {
        if (raw === undefined) return null;
        for (const len of [60, 30, 15, 8, 4, 2, 1, 0]) {
            const b = beforeCtx.slice(Math.max(0, beforeCtx.length - len));
            const a = afterCtx.slice(0, len);
            const pattern = ESC_SPECIAL(b) + MD_GAP + '(' + escTarget + ')' + MD_GAP + ESC_SPECIAL(a);
            let re;
            try { re = new RegExp(pattern, 'gd'); } catch { continue; }
            const matches = [...raw.matchAll(re)];
            if (matches.length === 1 && matches[0].indices?.[1]) {
                const [s, e] = matches[0].indices[1];
                return { start: s, end: e, field };
            }
        }
        return null;
    };
    if (wsSettings.translationSearchEnabled && msg.extra?.display_text) {
        const hit = tryField(msg.extra.display_text, 'display_text');
        if (hit) return hit;
    }
    return tryField(msg.mes, 'mes');
}

async function replaceAtOffset(msgIdx, start, end, rep, field = 'mes') {
    const msg = getChat()[msgIdx];
    if (field === 'display_text') {
        const raw = msg.extra?.display_text ?? '';
        await editTranslatedText(msgIdx, raw.slice(0, start) + rep + raw.slice(end));
    } else {
        const mes = msg.mes;
        await editMessage(msgIdx, mes.slice(0, start) + rep + mes.slice(end));
        await SillyTavern.getContext().saveChat?.();
    }
}

// 연필 패널이 떠있는 동안 드래그했던 그 Range를 그대로(재검색 없이) 하이라이트
// ws-hl-cur CSS는 [data-ws-g] 속성이 있어야 매치되므로 더미 값을 같이 넣어줌
function highlightQuickReplaceRange(domRange) {
    const mark = document.createElement('mark');
    mark.dataset.wsG = '-1'; mark.dataset.wsQr = '1'; mark.classList.add('ws-hl-cur');
    safeHighlight(domRange, mark);
}

function clearQuickReplaceHighlight() {
    document.querySelectorAll('#chat .mes_text mark[data-ws-qr]').forEach(mark => {
        const p = mark.parentNode; if (!p) return;
        while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
        p.removeChild(mark); p.normalize();
    });
}

async function insertAtOffset(msgIdx, pos, text, field = 'mes') {
    const msg = getChat()[msgIdx];
    if (field === 'display_text') {
        const raw = msg.extra?.display_text ?? '';
        await editTranslatedText(msgIdx, smartInsertSpacing(raw, pos, text));
    } else {
        await editMessage(msgIdx, smartInsertSpacing(msg.mes, pos, text));
        await SillyTavern.getContext().saveChat?.();
    }
}

function openQuickReplacePanel(msgIdx, beforeCtx, selText, afterCtx, domRange) {
    const PANEL_ID = 'ws-quickreplace-panel';
    highlightQuickReplaceRange(domRange);
    const panel = createPanel(PANEL_ID, null, () => { closePanel(PANEL_ID); clearQuickReplaceHighlight(); }), body = getPanelBody(panel);
    const input = inputBox('바꿀 단어'); body.appendChild(input);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
    const doReplace = async () => {
        const rep = input.value;
        closePanel(PANEL_ID); clearQuickReplaceHighlight();
        const loc = locateRawOffset(msgIdx, beforeCtx, selText, afterCtx);
        if (!loc) { toastr.error('원문에서 위치를 찾지 못했습니다.', '', { timeOut:3000 }); return; }
        await replaceAtOffset(msgIdx, loc.start, loc.end, rep, loc.field);
    };
    // ◀/▶: 드래그한 텍스트는 그대로 두고, 그 자리 앞(◀) 또는 뒤(▶)에 입력값만 끼워넣음(치환 아님)
    const insertLeft = document.createElement('div'); insertLeft.style.cssText = 'display:flex;gap:6px;';
    const doInsert = async (before) => {
        const val = input.value; if (!val) return;
        closePanel(PANEL_ID); clearQuickReplaceHighlight();
        const loc = locateRawOffset(msgIdx, beforeCtx, selText, afterCtx);
        if (!loc) { toastr.error('원문에서 위치를 찾지 못했습니다.', '', { timeOut:3000 }); return; }
        await insertAtOffset(msgIdx, before ? loc.start : loc.end, val, loc.field);
    };
    function iconBtn(faClass, onClick) {
        const b = document.createElement('button'); b.className = 'ws-btn ws-btn-accent';
        // 텍스트 베이스라인 정렬(top:Npx 같은 픽셀값) 대신 flex 박스 정렬을 씀 —
        // 베이스라인은 폰트마다 미묘하게 달라서 테마 바뀌면 다시 틀어지는데,
        // 박스 중앙정렬은 폰트와 무관하게 항상 정중앙에 옴.
        b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;';
        b.innerHTML = `<i class="${faClass}"></i>`;
        b.addEventListener('click', onClick); return b;
    }
    insertLeft.appendChild(iconBtn('fa-solid fa-caret-left', () => doInsert(true)));
    insertLeft.appendChild(iconBtn('fa-solid fa-caret-right', () => doInsert(false)));
    row.appendChild(insertLeft);
    row.appendChild(btn('확인', doReplace, 'ws-btn-accent'));
    body.appendChild(row); setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doReplace(); });
}

// 드래그 선택 텍스트 — pill이 살아있는 동안 유지, 사라지면 초기화
let _wsActiveDragText = '';

// ─── Drag-to-Search ─────────────────────────────────────────────────────────
const QR_MARKERS = ['📎','🔎','🪄'];
function findTargetQRBtn(el) {
    const b = el?.closest('#qr--bar .qr--button, .qr--buttons .qr--button');
    if (!b) return null; return QR_MARKERS.some(m => (b.textContent??'').includes(m)) ? b : null;
}

function initDragSearch() {
    if (window._wsDragSearch) window._wsDragSearch();
    const PILL = 'ws-drag-pill';
    const removePill = () => { const el=document.getElementById(PILL); if (el?._cleanup) el._cleanup(); el?.remove(); _wsActiveDragText = ''; };
    function makePillIcon(iconClass, onActivate) {
        const el = document.createElement('span');
        el.className = 'ws-drag-pill-icon';
        const icon = document.createElement('i'); icon.className = iconClass;
        el.appendChild(icon);
        const touch = window.matchMedia('(pointer:coarse)').matches;
        el.addEventListener('mousedown', e => e.preventDefault());
        el.addEventListener('click', e => { e.stopPropagation(); onActivate(); });
        if (touch) {
            el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); onActivate(); }, { passive:false });
        }
        return el;
    }
    function showPill(x, y, text, range) {
        removePill();
        const pill = document.createElement('div'); pill.id = PILL; pill.className = 'ws-drag-pill';
        // 위치는 클릭 지점 기준 오프셋(px)만 계산해서 inline으로 적용 — 오프셋 값 자체는
        // --ws-pill-offset-x/y CSS 변수로 열려있어 사용자 CSS에서 조절 가능
        const rootStyle = getComputedStyle(document.documentElement);
        const offX = parseFloat(rootStyle.getPropertyValue('--ws-pill-offset-x')) || 20;
        const offY = parseFloat(rootStyle.getPropertyValue('--ws-pill-offset-y')) || 70;
        pill.style.left = `${x + offX}px`;
        pill.style.top  = `${y + offY}px`;
        // '바꾸기'(마술봉) / '빠른 수정'(지우개) 아이콘은 에딧모드에서 각각 독립적으로 끌 수 있음
        if (!wsSettings.pillWandDisabled) {
            pill.appendChild(makePillIcon('fa-solid fa-wand-magic-sparkles', () => { removePill(); runChange(text, false, false); }));
        }
        let matchCtx = null;
        try { matchCtx = getMatchContext(range); } catch {}
        if (matchCtx && !wsSettings.pillEraserDisabled) {
            const rawSelText = range.toString();
            const clonedRange = range.cloneRange();
            pill.appendChild(makePillIcon('fa-solid fa-eraser', () => { removePill(); openQuickReplacePanel(matchCtx.msgIdx, matchCtx.beforeCtx, rawSelText, matchCtx.afterCtx, clonedRange); }));
        }
        if (!pill.children.length) { removePill(); return; } // 아이콘이 하나도 없으면 필 자체를 띄우지 않음
        document.body.appendChild(pill);
        requestAnimationFrame(() => {
            const r = pill.getBoundingClientRect();
            if (r.right  > window.innerWidth)  pill.style.left = `${window.innerWidth  - r.width  - 8}px`;
            if (r.bottom > window.innerHeight)  pill.style.top  = `${window.innerHeight - r.height - 8}px`;
        });
        const onOut = e => { if (!pill.contains(e.target)) removePill(); };
        document.addEventListener('pointerdown', onOut, { capture:true });
        pill._cleanup = () => document.removeEventListener('pointerdown', onOut, { capture:true });
    }
    let lastSel = '';
    const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th';
    // Range.cloneContents()는 시작/끝이 걸친 조상 태그만 "부분 복제"해서 감싸므로,
    // 선택이 한 문단 안에서 끝나면 그 문단 태그 자체는 복제 결과에 안 나타나고,
    // 두 문단 이상에 걸치면 각 문단 태그가 잘려서 복제되어 나타남 — 이 성질로 판정
    function selectionSpansMultipleParagraphs(range) {
        const frag = range.cloneContents();
        const blocks = frag.querySelectorAll(BLOCK_SELECTOR);
        const withText = Array.from(blocks).filter(el => el.textContent.trim().length > 0);
        return withText.length > 1;
    }
    function onEnd(cx, cy) {
        setTimeout(() => {
            // ST 메시지 편집모드는 textarea를 씀 — textarea 안 텍스트 선택은 Range API가 아니라
            // 브라우저 자체 selectionStart/End로 처리되고, 이때 Range의 startContainer가
            // textarea 자체가 아니라 그 바깥을 가리키는 경우가 있어 closest()로 못 잡을 수 있음.
            // 포커스가 편집 textarea에 가 있는지(document.activeElement)로 먼저 확실하게 걸러냄
            const active = document.activeElement;
            if (active && (active.id === 'curEditTextarea' || active.tagName === 'TEXTAREA')) { removePill(); return; }
            const sel = window.getSelection(), text = sel?.toString();
            if (!text || text.length === 0) { removePill(); lastSel=''; return; }
            if (sel.rangeCount < 1) { removePill(); return; }
            const range = sel.getRangeAt(0);
            if (!document.getElementById('chat')?.contains(range.commonAncestorContainer)) { removePill(); return; }
            const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
            if (startEl?.closest('#curEditTextarea, textarea, [contenteditable="true"], .edit_textarea')) { removePill(); return; }
            if (selectionSpansMultipleParagraphs(range)) { removePill(); lastSel=''; return; }
            if (text === lastSel) return; lastSel=text; _wsActiveDragText = text; showPill(cx, cy, text, range);
        }, 50);
    }
    const onMU  = e => { if (findTargetQRBtn(e.target)) return; if (!window.getSelection()?.toString()) { removePill(); lastSel=''; return; } onEnd(e.clientX, e.clientY); };
    const onTE  = e => { const t=e.changedTouches?.[0]; if (!t) return; if (findTargetQRBtn(e.target)) return; if (!window.getSelection()?.toString()) { removePill(); lastSel=''; return; } onEnd(t.clientX, t.clientY); };
    const onSC  = () => { if (!window.getSelection()?.toString()) { removePill(); lastSel=''; } };
    document.addEventListener('mouseup', onMU); document.addEventListener('touchend', onTE); document.addEventListener('selectionchange', onSC);
    window._wsDragSearch = () => { removePill(); document.removeEventListener('mouseup',onMU); document.removeEventListener('touchend',onTE); document.removeEventListener('selectionchange',onSC); window._wsDragSearch=null; };
}

// ─── QR Drag-inject ─────────────────────────────────────────────────────────
function initQRDragInject() {
    if (window._wsQRDragInject) window._wsQRDragInject();
    const getSelInChat = () => { const sel=window.getSelection(),text=sel?.toString().trim(); if (!text||sel.rangeCount<1) return null; return document.getElementById('chat')?.contains(sel.getRangeAt(0).commonAncestorContainer)?text:null; };
    const onPD = e => {
        const qrBtn = findTargetQRBtn(e.target); if (!qrBtn) return;
        const label = qrBtn.textContent ?? '';
        const selText = getSelInChat() || _wsActiveDragText;

        // 📎 클립: 드래그(또는 pill로 잡힌 텍스트)가 있으면 그걸 복사. 없으면 입력창(#send_textarea)에
        // 타이핑된 텍스트를 복사, 그것도 비어있으면 전체 채팅을 복사 — 🔎/🪄가 드래그 없을 때
        // 기본 동작(패널 열기)을 해주는 것과 같은 맥락으로, 📎도 "기본 동작"을 항상 수행함
        // 클립보드 API는 iOS에서 "충분히 신뢰된 제스처"가 아니면 거부함 — pointerdown 시점에
        // 바로 호출하면 거부되고, preventDefault를 걸어버리면 뒤따라올 click 자체가 안 생겨서
        // click을 기다리는 방식도 못 씀. 그래서 여기서는 preventDefault를 절대 안 걸어서
        // 진짜 click이 정상적으로 발생하게 두고, 그 click 시점에 복사를 실행함
        if (label.includes('📎')) {
            const onClickOnce = async () => {
                if (selText) { copyText(selText); return; }
                const typed = document.getElementById('send_textarea')?.value?.trim();
                if (typed) { copyText(typed); return; }
                await copyFullChat(text => stripText(stripReasoningBlocks(text)), getSearchableText);
            };
            document.addEventListener('click', onClickOnce, { capture:true, once:true });
            setTimeout(() => document.removeEventListener('click', onClickOnce, { capture:true }), 400);
            return;
        }

        // 🔎/🪄: 드래그 텍스트가 있으면 그걸로, 없으면 입력창(#send_textarea)에 타이핑된 텍스트로
        // 검색/바꾸기 실행. 그것도 없으면 키워드 입력 패널을 직접 열어줌
        if (label.includes('🔎') || label.includes('🪄')) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            const keyword = selText || document.getElementById('send_textarea')?.value?.trim();
            if (!keyword) { if (label.includes('🔎')) openFindKeywordPanel(); else openChangeKeywordPanel(); return; }
            if (label.includes('🔎')) runFind(keyword, false, false); else runChange(keyword, false, false);
        }
    };
    document.addEventListener('pointerdown', onPD, { capture:true });
    window._wsQRDragInject = () => { document.removeEventListener('pointerdown',onPD,{capture:true}); window._wsQRDragInject=null; };
}

// ─── 향상된 메시지 삭제 (에딧모드 토글) ──────────────────────────────────────
// ST 기본 삭제 체크박스는 클릭한 메시지 하나(this_del_mes)만 기억하고
// "그 지점부터 끝까지 전부"만 지울 수 있음(chat.length = this_del_mes로 배열을 그냥 자름).
// 진짜 개별 다중선택을 위해 .mes 클릭과 확인(OK) 버튼 둘 다 캡처 단계에서 가로채서 대체함.
//
// 실제 삭제 실행은 우리가 직접 배열/DOM을 patch하지 않고, ST 자체 슬래시커맨드 /cut을
// "하이재킹"해서 대신 실행시킴(executeSlashCommandsWithOptions — Quick Reply 등 ST 내부에서도
// 쓰는 정식 확장 API). 선택된 번호들을 연속 구간으로 묶어 뒤(큰 번호)부터 순서대로 /cut을 호출 —
// /cut은 ST 자체 로직이라 우리 방식보다 번호 재계산/내부 캐시 정리가 더 깔끔하게 됨.
function isDeleteModeActive() {
    const anyCheckbox = document.querySelector('#chat .mes .del_checkbox');
    if (!anyCheckbox) return false;
    return getComputedStyle(anyCheckbox).display !== 'none';
}

// 정렬된 인덱스 배열을 연속 구간들로 묶음. 예: [1,2,3,7,9,10] → [[1,3],[7,7],[9,10]]
function groupIntoRanges(sortedIdxs) {
    const ranges = [];
    let start = sortedIdxs[0], prev = sortedIdxs[0];
    for (let i = 1; i < sortedIdxs.length; i++) {
        const cur = sortedIdxs[i];
        if (cur === prev + 1) { prev = cur; continue; }
        ranges.push([start, prev]);
        start = cur; prev = cur;
    }
    ranges.push([start, prev]);
    return ranges;
}

async function enhancedDeleteSelected() {
    const selectedEls = Array.from(document.querySelectorAll('#chat .mes.selected'));
    const removedIdxs = selectedEls.map(el => parseInt(el.getAttribute('mesid'), 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (!removedIdxs.length) { toastr.info('선택된 메시지가 없습니다.', '', { timeOut:3000 }); return; }

    const ctx = SillyTavern.getContext();
    if (typeof ctx.executeSlashCommandsWithOptions !== 'function') {
        toastr.error('이 기능은 SillyTavern 최신 버전에서 사용할 수 있습니다.', '', { timeOut:4000 });
        return;
    }

    const ranges = groupIntoRanges(removedIdxs);
    // 뒤(큰 번호)부터 잘라야 앞쪽 구간의 번호가 안 밀림 — 순서 중요
    for (let i = ranges.length - 1; i >= 0; i--) {
        const [s, e] = ranges[i];
        const arg = s === e ? `${s}` : `${s}-${e}`;
        await ctx.executeSlashCommandsWithOptions(`/cut ${arg}`, { showOutput: false });
    }
    toastr.success(`${removedIdxs.length}개 메시지를 삭제했습니다.`, '', { timeOut:3000 });
}

function clearAllSelected() {
    document.querySelectorAll('#chat .mes.selected').forEach(el => {
        el.classList.remove('selected');
        const cb = el.querySelector(':scope > .del_checkbox'); if (cb) cb.checked = false;
    });
}

function initEnhancedDelete() {
    if (window._wsEnhancedDelete) window._wsEnhancedDelete();

    // "ST"(일괄선택) 버튼은 지속되는 모드 토글 — 누르면 켜지고, 다시 누를 때까지 계속 켜진 채로 있음.
    // 켜진 동안엔 메시지를 탭할 때마다 그 지점부터 마지막 메시지까지 범위선택(반복 사용 가능).
    let rangeMode = false;
    let batchBtn = null;
    let boundOkBtn = null; // 마지막으로 버튼을 붙였던 okBtn 엘리먼트 자체(참조 비교용)

    function updateBatchBtnState() {
        if (!batchBtn) return;
        batchBtn.classList.toggle('armed', rangeMode);
    }

    function resetRangeMode() { rangeMode = false; updateBatchBtnState(); }

    // ST의 삭제/취소 버튼 왼쪽에 일괄선택("ST")/전체해제("해제") 버튼을 심음.
    // ST 버튼의 class를 그대로 복사하면 위치 스타일(fixed 등)까지 같이 상속돼서 엉뚱한
    // 자리에 붙는 문제가 있었음 — 그래서 class는 안 빌리고 우리 전용 스타일(.ws-stitch-btn)을
    // 쓰되, 높이/글자크기만 ST 버튼 걸 실측해서 맞춤(테마마다 실제 크기가 달라서 값 하나로 못 박기 어려움).
    // ST가 삭제 다이얼로그를 열 때마다 okBtn 엘리먼트 자체를 새로 그릴 수도 있어서(같은 id라도
    // 다른 노드가 되면 우리 버튼의 클릭 핸들러가 옛 노드에만 살아있는 상태가 될 수 있음) —
    // okBtn "참조"가 바뀌었는지 매번 확인해서, 바뀌었으면 우리 버튼도 통째로 다시 붙임.
    function ensureDeleteExtraButtons() {
        if (!wsSettings.enhancedDelete) {
            // 설정이 꺼지면 이미 심어둔 버튼도 정리(안 그러면 계속 남아있는 버그)
            document.getElementById('ws-del-batch-btn')?.remove();
            document.getElementById('ws-del-clear-btn')?.remove();
            boundOkBtn = null;
            return;
        }
        const okBtn = document.getElementById('dialogue_del_mes_ok');
        if (!okBtn || !okBtn.parentElement) return;

        let clearBtn = document.getElementById('ws-del-clear-btn');
        if (okBtn !== boundOkBtn) {
            // 새 다이얼로그(또는 첫 진입) — 옛 버튼이 남아있으면 정리하고 새로 붙임
            document.getElementById('ws-del-batch-btn')?.remove();
            document.getElementById('ws-del-clear-btn')?.remove();
            boundOkBtn = okBtn;

            function makeStitchBtn(id, label) {
                const b = document.createElement('div');
                b.id = id; b.className = 'ws-stitch-btn';
                b.textContent = label;
                return b;
            }

            batchBtn = makeStitchBtn('ws-del-batch-btn', 'ST');
            batchBtn.addEventListener('click', e => {
                e.stopPropagation();
                rangeMode = !rangeMode;
                updateBatchBtnState();
            });

            clearBtn = makeStitchBtn('ws-del-clear-btn', '해제');
            clearBtn.addEventListener('click', e => {
                e.stopPropagation();
                clearAllSelected();
                resetRangeMode(); // "해제" 누르면 일괄선택("ST") 모드도 같이 꺼짐
            });

            // ST 자체 삭제/취소 버튼의 왼쪽에 [ST][해제] 순서로 삽입
            okBtn.insertAdjacentElement('beforebegin', clearBtn);
            clearBtn.insertAdjacentElement('beforebegin', batchBtn); // batchBtn이 clearBtn보다 더 왼쪽
        }

        // 높이/글자크기를 ST 버튼 실측값에 맞춤 — 다이얼로그가 뜨는 애니메이션 도중에
        // 측정하면 값이 안 안정된 상태일 수 있어서, 레이아웃이 가라앉을 시간을 준 뒤(2연속 rAF)
        // 매번 다시 맞춰줌(한 번만 재고 끝내면 타이밍에 따라 어긋난 값이 그대로 굳어버릴 수 있음).
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const okRect = okBtn.getBoundingClientRect();
            const okFontSize = getComputedStyle(okBtn).fontSize;
            // 부모가 flex의 gap 속성으로 버튼 간격을 이미 통일해서 주고 있을 수 있음 —
            // 그런 경우 우리가 또 margin을 얹으면 간격이 이중으로 겹쳐서 들쭉날쭉해짐.
            // gap이 감지되면 우리 margin은 0으로, 없으면(margin 방식 테마) 삭제-취소 사이
            // 실측 간격을 우리 버튼 사이에도 동일하게 적용.
            const parentStyle = getComputedStyle(okBtn.parentElement);
            const flexGap = parseFloat(parentStyle.columnGap || parentStyle.gap || '0') || 0;
            let marginPx = null;
            if (flexGap > 0) {
                marginPx = 0;
            } else {
                const cancelBtn = document.getElementById('dialogue_del_mes_cancel');
                if (cancelBtn) {
                    const measured = cancelBtn.getBoundingClientRect().left - okRect.right;
                    if (measured > 0) marginPx = measured;
                }
            }
            [batchBtn, clearBtn].forEach(b => {
                if (!b) return;
                if (okRect.height) b.style.height = `${okRect.height}px`;
                if (okFontSize) b.style.fontSize = okFontSize;
            });
            if (marginPx !== null && clearBtn) {
                // 좁은 화면(모바일)에서는 버튼 텍스트가 짧아져서(ST/해제) 4개가 한 줄에 들어갈
                // 여지가 생겼고, 실측 사용자 테스트로 확정된 고정 px 값을 씀(marginPx와 무관).
                //   - [ST]-[해제] 사이: Left (오터치 방지 위해 넉넉히)
                //   - [해제]-[삭제] 사이: Right
                // 아이패드/PC 등 넓은 화면 쪽 간격은 여기, else 분기의 marginPx를 조정
                const isNarrow = window.matchMedia('(max-width: 480px)').matches;
                if (isNarrow) {
                    clearBtn.style.marginLeft = '50px';
                    clearBtn.style.marginRight = '25px';
                } else {
                    // 넓은 화면: [ST]-[해제]-[삭제]-[취소] 세 간격이 서로 비슷하게 보이도록
                    // 실측한 [삭제]-[취소] 간격을 그대로 우리 버튼 사이에도 동일 적용
                    clearBtn.style.marginLeft = `${marginPx}px`;
                    clearBtn.style.marginRight = `${marginPx - 20}px`;
                }
            }
        }));
    }

    _delBtnObserver = new MutationObserver(() => ensureDeleteExtraButtons());
    _ensureDeleteExtraButtonsRef = ensureDeleteExtraButtons;
    refreshEnhancedDeleteObserver();

    const onMesClickCapture = e => {
        if (!wsSettings.enhancedDelete || !isDeleteModeActive()) return;
        const mesEl = e.target.closest('#chat .mes'); if (!mesEl) return;
        const checkbox = mesEl.querySelector(':scope > .del_checkbox'); if (!checkbox) return;
        e.stopImmediatePropagation(); e.preventDefault();

        const idx = parseInt(mesEl.getAttribute('mesid'), 10);

        if (rangeMode) {
            // 지속 모드라 여기서 끄지 않음 — 다시 탭해도 계속 범위선택으로 동작
            const allMes = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
            if (!allMes.length) return;
            const lastIdx = Math.max(...allMes.map(el => parseInt(el.getAttribute('mesid'), 10)));
            clearAllSelected();
            allMes.forEach(el => {
                const n = parseInt(el.getAttribute('mesid'), 10);
                if (n >= idx && n <= lastIdx) {
                    el.classList.add('selected');
                    const cb = el.querySelector(':scope > .del_checkbox'); if (cb) cb.checked = true;
                }
            });
            return;
        }

        // 일반 단일 토글
        const nowChecked = !checkbox.checked;
        checkbox.checked = nowChecked;
        mesEl.classList.toggle('selected', nowChecked);
    };

    const onOkClickCapture = e => {
        if (!wsSettings.enhancedDelete || !isDeleteModeActive()) return;
        if (!e.target.closest('#dialogue_del_mes_ok')) return;
        e.stopImmediatePropagation(); e.preventDefault();
        enhancedDeleteSelected().finally(() => {
            resetRangeMode();
            // ST 취소 버튼 로직을 빌려서 삭제모드 UI 정리(배열/저장은 안 건드리는 순수 UI 리셋으로 확인됨)
            document.getElementById('dialogue_del_mes_cancel')?.click();
        });
    };

    // 취소 버튼은 가로채지 않고(그냥 ST 기본 동작 그대로) 일괄선택 모드만 조용히 꺼줌
    const onCancelPassive = e => { if (e.target.closest('#dialogue_del_mes_cancel')) resetRangeMode(); };

    document.addEventListener('click', onMesClickCapture, true);
    document.addEventListener('click', onOkClickCapture, true);
    document.addEventListener('click', onCancelPassive);
    window._wsEnhancedDelete = () => {
        document.removeEventListener('click', onMesClickCapture, true);
        document.removeEventListener('click', onOkClickCapture, true);
        document.removeEventListener('click', onCancelPassive);
        _delBtnObserver?.disconnect();
        _delBtnObserver = null;
        _ensureDeleteExtraButtonsRef = null;
        window._wsEnhancedDelete = null;
    };
}

export function initDragFeatures() {
    initDragSearch();
    initQRDragInject();
    initEnhancedDelete();
}
