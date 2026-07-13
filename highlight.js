// ─── highlight.js ───────────────────────────────────────────────────────────
// 검색/치환 결과를 채팅 DOM 위에 <mark>로 표시하는 로직.

import { applyFiller, applyWholeWord } from './utils.js';
import { loadAndScrollTo, wsSettings, WS_DEFAULT_HL_POSITION_PERCENT } from './state.js';

let _wsHL = null;

export function clearDOMHighlights() {
    _wsHL?.observer?.disconnect();
    if (_wsHL?.markClickHandler && _wsHL?.chatEl) _wsHL.chatEl.removeEventListener('click', _wsHL.markClickHandler);
    document.querySelectorAll('#chat .mes_text mark[data-ws-g]').forEach(mark => {
        const p = mark.parentNode; if (!p) return;
        while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
        p.removeChild(mark); p.normalize();
    });
    document.getElementById('ws-hl-overlay')?.remove();
    document.getElementById('chat')?.classList.remove('ws-hl-active');
    _wsHL = null;
}

// surroundContents가 실패하는 경우(선택 영역이 여러 요소에 걸쳐있는 등) 대비 —
// 1차: 그대로 감싸기 시도. 2차: 내용을 뽑아서 mark 안에 넣은 뒤 다시 삽입. 둘 다 실패하면 조용히 포기
export function safeHighlight(range, mark) {
    try { range.surroundContents(mark); return true; } catch {}
    try {
        const content = range.extractContents();
        mark.appendChild(content);
        range.insertNode(mark);
        return true;
    } catch { return false; }
}

function _markMesEl(mesEl, re_pattern, re_flags, msgMatches, currentIdx) {
    if (mesEl.querySelector('mark[data-ws-g]')) return;
    const walker = document.createTreeWalker(mesEl, NodeFilter.SHOW_TEXT, {
        acceptNode: n => ['SCRIPT','STYLE'].includes(n.parentElement?.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const bounds = []; let node, pos = 0;
    while ((node = walker.nextNode())) { bounds.push({ node, start:pos, end:pos+node.textContent.length }); pos += node.textContent.length; }
    if (!bounds.length) return;
    const full = bounds.map(b => b.node.textContent).join('');
    const re = new RegExp(re_pattern, re_flags); const found = []; let m;
    while ((m = re.exec(full)) !== null) {
        if (m.index === re.lastIndex) { re.lastIndex++; continue; }
        found.push({ start: m.index, end: m.index + m[0].length });
    }
    if (!found.length) return;
    const gMap = new Map(msgMatches.map(mm => [mm.matchIdx, mm.globalIdx]));
    for (let fi = found.length - 1; fi >= 0; fi--) {
        const { start, end } = found[fi];
        const sb = bounds.find(b => b.start <= start && b.end > start);
        const eb = bounds.find(b => b.start < end   && b.end >= end);
        if (!sb || sb !== eb) continue;
        const ls = start - sb.start, le = end - sb.start;
        const mark = document.createElement('mark');
        mark.dataset.wsG = String(gMap.get(fi) ?? -1);
        if ((gMap.get(fi) ?? -1) === currentIdx) mark.classList.add('ws-hl-cur');
        const range = document.createRange(); range.setStart(sb.node, ls); range.setEnd(sb.node, le);
        if (!safeHighlight(range, mark)) continue;
        sb.end = sb.start + ls;
    }
}

export function applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, currentIdx, wholeWord = false, onMarkClick = null) {
    clearDOMHighlights();
    const re_pattern = applyWholeWord(applyFiller(escaped, ignoreSpace), wholeWord);
    let re_flags = (flags.includes('i') ? 'i' : '') + 'g';
    if (wholeWord) re_flags += 'u';
    const byMsg = new Map();
    allMatches.forEach((mm, gIdx) => {
        if (!byMsg.has(mm.msgIdx)) byMsg.set(mm.msgIdx, []);
        byMsg.get(mm.msgIdx).push({ ...mm, globalIdx: gIdx });
    });
    const tryMark = msgIdx => {
        const el = document.querySelector(`#chat [mesid="${msgIdx}"] .mes_text`);
        if (el) _markMesEl(el, re_pattern, re_flags, byMsg.get(msgIdx), _wsHL?.currentIdx ?? currentIdx);
    };
    byMsg.forEach((_, msgIdx) => {
        tryMark(msgIdx);
    });

    if (!document.getElementById('ws-hl-overlay')) {
        const overlay = document.createElement('div'); overlay.id = 'ws-hl-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.1);z-index:999990;pointer-events:none;';
        document.body.appendChild(overlay);
    }
    document.getElementById('chat')?.classList.add('ws-hl-active');

    const chatEl = document.getElementById('chat');
    const observer = chatEl ? new MutationObserver(() => {
        byMsg.forEach((_, idx) => {
            tryMark(idx);
        });
    }) : null;
    if (observer) observer.observe(chatEl, { childList: true, subtree: true });

    // 마크 클릭 → 해당 검색결과로 점프. 이벤트 위임 방식이라 이후 새로 생기는 마크에도
    // 별도 처리 없이 자동으로 적용됨(마크 자체가 아니라 #chat에 리스너 하나만 둠).
    let markClickHandler = null;
    if (onMarkClick && chatEl) {
        markClickHandler = e => {
            const mark = e.target.closest('mark[data-ws-g]');
            if (!mark) return;
            const g = parseInt(mark.dataset.wsG, 10);
            if (isNaN(g) || g < 0) return;
            e.stopPropagation();
            onMarkClick(g);
        };
        chatEl.addEventListener('click', markClickHandler);
    }

    _wsHL = { observer, byMsg, currentIdx, markClickHandler, chatEl };
}

export function updateCurrentMark(currentIdx) {
    if (_wsHL) _wsHL.currentIdx = currentIdx;
    document.querySelectorAll('#chat .mes_text mark[data-ws-g]').forEach(mark => {
        mark.classList.toggle('ws-hl-cur', parseInt(mark.dataset.wsG) === currentIdx);
    });
}

export function scrollToMark(currentIdx, msgIdx, follow = false) {
    if (follow) {
        const mark = document.querySelector(`#chat .mes_text mark[data-ws-g="${currentIdx}"]`);
        if (mark) {
            const chatEl = document.getElementById('chat');
            const markTop = mark.getBoundingClientRect().top;
            const chatTop = chatEl.getBoundingClientRect().top;
            const percent = wsSettings.hlPositionEnabled ? wsSettings.hlPositionPercent : WS_DEFAULT_HL_POSITION_PERCENT;
            chatEl.scrollTop += (markTop - chatTop) - (chatEl.clientHeight * (percent / 100));
        }
        else loadAndScrollTo(msgIdx);
    } else { loadAndScrollTo(msgIdx); }
}
