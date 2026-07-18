// ─── find-change.js ─────────────────────────────────────────────────────────
// /find, /change 슬래시 커맨드와 그 검색/치환 패널.

import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '/scripts/slash-commands/SlashCommandArgument.js';

import { escapeHTML, buildAllMatches, applyWholeWord, applyFiller, maskTags, maskReasoningBlocks, parseChangeRangeInput, parseRangeInputFlexible } from './utils.js';
import { getChat, editMessage, editTranslatedText, wsSettings } from './state.js';
import { createPanel, getPanelBody, closePanel, centerOf, keepCenter, btn, inputBox, searchOptions, renderList, makeFollowChk } from './panel-ui.js';
import { applyDOMHighlights, clearDOMHighlights, updateCurrentMark, scrollToMark } from './highlight.js';

// find/change 패널 상호배타 처리 — 같은 종류가 이미 열려있으면 토글로 닫힘.
// 다른 종류가 열려있을 때: 아직 검색 전(입력 단계)이면 그냥 닫고 새 패널을 열도록 허용,
// 이미 검색 결과가 떠있는 상태면 닫기만 하고 새 패널은 열지 않음(패널 두 개가 겹쳐서
// 화면 밖으로 밀려나는 버그 방지).
function forceClosePanel(type) {
    const id = `ws-${type}-panel`;
    if (!document.getElementById(id)) return;
    clearDOMHighlights();
    if (type === 'change') SillyTavern.getContext().saveChat?.();
    closePanel(id);
}
function resolvePanelOpenAttempt(myType) {
    if (document.getElementById(`ws-${myType}-panel`)) { forceClosePanel(myType); return false; }
    const otherType = myType === 'find' ? 'change' : 'find';
    const otherPanel = document.getElementById(`ws-${otherType}-panel`);
    if (otherPanel) {
        const hasResults = otherPanel.dataset.wsState === 'results';
        forceClosePanel(otherType);
        if (hasResults) return false;
    }
    return true;
}

// 목록에서 현재 선택된 항목이 스크롤 맨 위가 아니라 정중앙에 오게 맞춤(리스트가 길 때
// 매번 맨 위로 튀는 게 아니라, 검토 중이던 위치 근처를 계속 보여주기 위함).
function centerActiveInList(fb) {
    requestAnimationFrame(() => {
        const scrollEl = fb.querySelector('.ws-thin-scroll');
        const activeEl = scrollEl?.querySelector('.ws-result-item.active');
        if (scrollEl && activeEl) scrollEl.scrollTop = Math.max(0, activeEl.offsetTop - scrollEl.clientHeight / 2 + activeEl.clientHeight / 2);
    });
}

// find/change 키워드 입력 패널에서 공용으로 쓰는 검색 범위 제한 입력창.
// /change '모두 바꾸기'와 동일 문법("12-45", "3,5,20-30" 등) — 플레이스홀더로 용도를 안내.
function rangeLimitRow() {
    const input = document.createElement('input'); input.type = 'text';
    input.className = 'ws-range-input';
    input.placeholder = '검색 범위';
    input.autocomplete = 'off'; input.autocorrect = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
    input.style.cssText = 'width:66px;padding:4px 8px;font-size:12px;border:1px solid var(--ws-border);border-radius:6px;background:#fff;outline:none;';
    return { el: input, getRange: () => parseRangeInputFlexible(input.value) };
}

// ─── /find ────────────────────────────────────────────────────────────────
export function openFindKeywordPanel(useTranslation = wsSettings.translationSearchEnabled) {
    if (!resolvePanelOpenAttempt('find')) return;
    const PANEL_ID = 'ws-find-panel';
    const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
    panel.dataset.wsState = 'input';
    const input = inputBox('찾을 단어를 입력하세요'); body.appendChild(input);
    const opts = searchOptions(); body.appendChild(opts.el);
    const rangeUI = rangeLimitRow();
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;align-items:center;';
    row.appendChild(rangeUI.el);
    const doFind = () => {
        const kw = input.value.trim(); if (!kw) return;
        const range = rangeUI.getRange();
        if (range === 'invalid') { toastr.error('범위를 올바르게 지정해 주세요.', '', { timeOut:3000 }); return; }
        const center = centerOf(panel); closePanel(PANEL_ID);
        runFind(kw, opts.getCaseSensitive(), opts.getIgnoreSpace(), opts.getWholeWord(), opts.getIgnoreTags(), center, range.idxs, useTranslation);
    };
    row.appendChild(btn('찾기', doFind, 'ws-btn-accent'));
    body.appendChild(row); setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doFind(); });
}

export function runFind(keyword, caseSensitive, ignoreSpace, wholeWord = false, ignoreTags = false, posCenter = null, allowedIdxs = null, useTranslation = wsSettings.translationSearchEnabled) {
    if (!resolvePanelOpenAttempt('find')) return;
    const PANEL_ID = 'ws-find-panel', chat = getChat();
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = caseSensitive ? 'g' : 'gi';
    // 번역 검색은 메시지 종류(유저/캐릭터) 구분 없이 항상 msg.extra.display_text(번역문)를
    // 먼저 보고, 없으면 원문(msg.mes)으로 자동 폴백함 — 결과적으로 채팅 전체가 번호 빠짐 없이
    // 검색 범위에 들어옴.
    // 번역 확장이 이미 추론 내용을 걸러서 번역문을 만드는 경우가 많아 여기선 그 전역 옵션을 안 씀.
    const getText = useTranslation ? (msg => msg.extra?.display_text ?? msg.mes) : null;
    const ignoreReasoningEffective = useTranslation ? false : wsSettings.ignoreReasoningBlocks;
    const allMatches = buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord, ignoreTags, allowedIdxs, ignoreReasoningEffective, getText);
    if (!allMatches.length) { toastr.info('검색 결과가 없습니다.', '', { timeOut:3000 }); return; }

    const matchCountPerMsg = {};
    allMatches.forEach(({ msgIdx }) => { matchCountPerMsg[msgIdx] = (matchCountPerMsg[msgIdx] || 0) + 1; });
    const uniqueIdxs = [...new Set(allMatches.map(m => m.msgIdx))];
    let current = 0, showingList = false, followScroll = true;

    applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, 0, wholeWord, jumpToMatch);
    const panel = createPanel(PANEL_ID, posCenter, () => { clearDOMHighlights(); closePanel(PANEL_ID); }), fb = getPanelBody(panel);
    panel.dataset.wsState = 'results';
    const FIND_H = '105px';

    function setFixed() {
        Object.assign(fb.style, { display:'block', flex:'none', height:FIND_H, maxHeight:'', overflowY:'auto', padding:'4px 16px 12px' });
    }

    function navigate(newIdx, forceScroll = false) {
        current = newIdx; updateCurrentMark(current); render();
        const m = allMatches[current];
        if (followScroll) scrollToMark(current, m.msgIdx, true);
        else if (forceScroll) scrollToMark(current, m.msgIdx, false);
    }

    // 채팅 안 초록색 마크를 직접 탭했을 때 — 이미 화면에 보이는 지점을 클릭한 것이므로
    // 목록뷰였으면 결과뷰로 바꾸되, 스크롤은 움직이지 않음(이전/다음 버튼과는 다르게 취급)
    function jumpToMatch(idx) {
        showingList = false;
        current = idx; updateCurrentMark(current); render();
    }

    function render() {
        const prevCenter = panel._wsPositioned ? centerOf(panel) : null;
        if (showingList) {
            const items = uniqueIdxs.map(msgIdx => {
                const isCur = allMatches[current].msgIdx === msgIdx;
                const item = document.createElement('div');
                item.className = 'ws-result-item' + (isCur ? ' active' : '');
                const cnt = matchCountPerMsg[msgIdx];
                item.innerHTML = `<span style="color:var(--ws-text2);margin-right:8px;font-size:11px">#${msgIdx}</span>${cnt>1?`<span style="color:var(--ws-text2);font-size:12px">(${cnt}회)</span>`:''}`;
                item.addEventListener('click', () => { navigate(allMatches.findIndex(m => m.msgIdx === msgIdx), true); showingList = false; render(); });
                return item;
            });
            renderList(fb, items, () => { showingList = false; render(); });
            centerActiveInList(fb);
        } else {
            setFixed(); fb.innerHTML = '';
            const m = allMatches[current];
            const header = document.createElement('div'); header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:20px;';
            const titleEl = document.createElement('span'); titleEl.style.cssText = 'font-weight:600;white-space:nowrap;flex-shrink:0;';
            titleEl.innerHTML = `"${escapeHTML(keyword)}" <span style="color:var(--ws-text2);font-size:12px">${allMatches.length}개 발견</span>`;
            const posEl = document.createElement('span'); posEl.style.cssText = 'color:var(--ws-text2);font-size:12px;white-space:nowrap;margin-left:auto;flex-shrink:0;';
            posEl.textContent = `#${m.msgIdx} (${current+1}/${allMatches.length})`;
            header.appendChild(titleEl); header.appendChild(makeFollowChk(() => followScroll, v => { followScroll = v; })); header.appendChild(posEl);
            fb.appendChild(header);
            const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;align-items:center;';
            const navL = document.createElement('div'); navL.style.cssText = 'display:flex;gap:6px;';
            navL.appendChild(btn('◀ 이전', () => { if (current === 0) { toastr.info('처음입니다.', '', { timeOut:2000 }); return; } navigate(current - 1); }));
            navL.appendChild(btn('다음 ▶', () => { if (current < allMatches.length - 1) navigate(current + 1); else toastr.info('마지막입니다.', '', { timeOut:2000 }); }));
            const navR = document.createElement('div'); navR.style.cssText = 'display:flex;gap:6px;';
            navR.appendChild(btn('목록', () => { showingList = true; render(); }));
            row.appendChild(navL); row.appendChild(navR); fb.appendChild(row);
        }
        keepCenter(panel, prevCenter);
    }
    render(); scrollToMark(0, allMatches[0].msgIdx, followScroll);
}

// ─── /change ──────────────────────────────────────────────────────────────
export function openChangeKeywordPanel(useTranslation = wsSettings.translationSearchEnabled) {
    if (!resolvePanelOpenAttempt('change')) return;
    const PANEL_ID = 'ws-change-panel';
    const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
    panel.dataset.wsState = 'input';
    const input = inputBox('찾을 단어를 입력하세요'); body.appendChild(input);
    const opts = searchOptions(); body.appendChild(opts.el);
    const rangeUI = rangeLimitRow();
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;align-items:center;';
    row.appendChild(rangeUI.el);
    const doChange = () => {
        const kw = input.value.trim(); if (!kw) return;
        const range = rangeUI.getRange();
        if (range === 'invalid') { toastr.error('범위를 올바르게 지정해 주세요.', '', { timeOut:3000 }); return; }
        const center = centerOf(panel); closePanel(PANEL_ID);
        runChange(kw, opts.getCaseSensitive(), opts.getIgnoreSpace(), opts.getWholeWord(), opts.getIgnoreTags(), center, range.idxs, useTranslation);
    };
    row.appendChild(btn('찾기', doChange, 'ws-btn-accent'));
    body.appendChild(row); setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doChange(); });
}

export function runChange(keyword, caseSensitive, ignoreSpace, wholeWord = false, ignoreTags = false, posCenter = null, allowedIdxs = null, useTranslation = wsSettings.translationSearchEnabled) {
    if (!resolvePanelOpenAttempt('change')) return;
    const PANEL_ID = 'ws-change-panel', chat = getChat();
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re_esc = applyWholeWord(applyFiller(escaped, ignoreSpace), wholeWord);
    const flags = caseSensitive ? 'g' : 'gi';
    // 번역 검색은 메시지 종류 구분 없이 항상 번역문 우선, 없으면 원문 폴백.
    const getText = useTranslation ? (msg => msg.extra?.display_text ?? msg.mes) : null;
    const ignoreReasoningEffective = useTranslation ? false : wsSettings.ignoreReasoningBlocks;
    let allMatches = buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord, ignoreTags, allowedIdxs, ignoreReasoningEffective, getText);
    if (!allMatches.length) { toastr.info('검색 결과가 없습니다.', '', { timeOut:3000 }); return; }

    let uniqueIdxs = [...new Set(allMatches.map(m => m.msgIdx))];
    let matchCountPerMsg = {};
    allMatches.forEach(({ msgIdx }) => { matchCountPerMsg[msgIdx] = (matchCountPerMsg[msgIdx] || 0) + 1; });
    let current = 0, mode = 'menu', listReturnMode = 'one', lastReplace = '', lastRangeInput = '', followScroll = true;

    applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, 0, wholeWord, jumpToMatch);
    const panel = createPanel(PANEL_ID, posCenter, () => { clearDOMHighlights(); SillyTavern.getContext().saveChat?.(); closePanel(PANEL_ID); }), cb = getPanelBody(panel);
    panel.dataset.wsState = 'results';
    function setFixed() {
        Object.assign(cb.style, { display:'block', flex:'none', height:'', maxHeight:'', overflowY:'visible', padding:'4px 16px 16px' });
    }
    function navigate(newIdx, forceScroll = false) {
        current = newIdx; updateCurrentMark(current); render();
        const m = allMatches[current];
        if (followScroll) scrollToMark(current, m.msgIdx, true);
        else if (forceScroll) scrollToMark(current, m.msgIdx, false);
    }
    // 채팅 안 초록색 마크를 직접 탭했을 때 — 이미 화면에 보이는 지점을 클릭한 것이므로
    // 메뉴/목록뷰였으면 검토뷰로 바꾸되, 스크롤은 움직이지 않음(이전/다음 버튼과는 다르게 취급)
    function jumpToMatch(idx) {
        mode = 'one';
        current = idx; updateCurrentMark(current); render();
    }
    function buildReFlags() {
        let f = flags.includes('g') ? flags : flags + 'g';
        if (wholeWord && !f.includes('u')) f += 'u';
        if (!f.includes('d')) f += 'd';
        return f;
    }
    // ignoreTags일 때 검색은 마스킹된 텍스트로 하되(태그 안 텍스트 제외),
    // 실제 치환은 오프셋이 동일한 원본 raw 텍스트를 그대로 잘라붙여서 적용 — 검색/치환 불일치 방지
    const getRaw = msgIdx => {
        if (!useTranslation) return chat[msgIdx].mes;
        return chat[msgIdx].extra?.display_text ?? chat[msgIdx].mes;
    };
    const setRaw = (msgIdx, val) => {
        if (!useTranslation) return editMessage(msgIdx, val);
        // 번역문이 실제로 있었던 경우에만 번역문 필드에 씀 — 애초에 번역문이 없어서 원문으로
        // 폴백해 매치를 찾았던 경우엔 그 원문 자체에 반영해야 함
        return chat[msgIdx].extra?.display_text !== undefined ? editTranslatedText(msgIdx, val) : editMessage(msgIdx, val);
    };
    async function doReplaceOne(msgIdx, matchIdx, rep) {
        const raw = getRaw(msgIdx);
        let searchText = raw;
        if (ignoreTags) searchText = maskTags(searchText);
        if (ignoreReasoningEffective) searchText = maskReasoningBlocks(searchText);
        const re = new RegExp(re_esc, buildReFlags());
        const matches = [...searchText.matchAll(re)];
        const m = matches[matchIdx];
        if (!m?.indices) return;
        const [s, e] = m.indices[0];
        await setRaw(msgIdx, raw.slice(0, s) + rep + raw.slice(e));
    }
    async function doReplaceAll(msgIdx, rep) {
        const raw = getRaw(msgIdx);
        let searchText = raw;
        if (ignoreTags) searchText = maskTags(searchText);
        if (ignoreReasoningEffective) searchText = maskReasoningBlocks(searchText);
        const re = new RegExp(re_esc, buildReFlags());
        const matches = [...searchText.matchAll(re)];
        if (!matches.length) return;
        let result = raw;
        for (let i = matches.length - 1; i >= 0; i--) {
            if (!matches[i].indices) continue;
            const [s, e] = matches[i].indices[0];
            result = result.slice(0, s) + rep + result.slice(e);
        }
        await setRaw(msgIdx, result);
    }

    function render() {
        const prevCenter = panel._wsPositioned ? centerOf(panel) : null;
        if (mode === 'list') {
            const items = uniqueIdxs.map(msgIdx => {
                const isCur = allMatches[current]?.msgIdx === msgIdx;
                const item = document.createElement('div');
                item.className = 'ws-result-item' + (isCur ? ' active' : '');
                const cnt = matchCountPerMsg[msgIdx];
                item.innerHTML = `<span style="color:var(--ws-text2);margin-right:8px;font-size:11px">#${msgIdx}</span>${cnt>1?`<span style="color:var(--ws-text2);font-size:12px">(${cnt}회)</span>`:''}`;
                item.addEventListener('click', () => { navigate(allMatches.findIndex(m => m.msgIdx === msgIdx), true); mode = 'one'; render(); });
                return item;
            });
            renderList(cb, items, () => { mode = listReturnMode; render(); });
            centerActiveInList(cb);

        } else if (mode === 'menu') {
            setFixed(); cb.innerHTML = '';
            const title = document.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
            title.innerHTML = `"${escapeHTML(keyword)}" <span style="color:var(--ws-text2);font-size:12px">${allMatches.length}개 발견</span>`;
            if (caseSensitive) { const b=document.createElement('span'); b.style.cssText='font-size:11px;color:var(--ws-text2);font-weight:400;'; b.textContent='대소문자 구분'; title.appendChild(b); }
            if (ignoreSpace)   { const b=document.createElement('span'); b.style.cssText='font-size:11px;color:var(--ws-text2);font-weight:400;'; b.textContent='띄어쓰기 무시'; title.appendChild(b); }
            // 범위 지정 — "3-10"(범위) 또는 "1,3,5"(콤마 목록) 형식으로 특정 메시지 번호만 골라 "모두 바꾸기" 적용
            const rangeWrap = document.createElement('span');
            rangeWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0;';
            const rangeInput = document.createElement('input'); rangeInput.type = 'text';
            rangeInput.className = 'ws-range-input';
            rangeInput.placeholder = '범위 지정';
            rangeInput.value = lastRangeInput;
            rangeInput.autocomplete = 'off'; rangeInput.autocorrect = 'off'; rangeInput.autocapitalize = 'off'; rangeInput.spellcheck = false;
            rangeInput.style.cssText = 'width:56px;padding:2px 6px;font-size:11px;font-weight:400;border:1px solid var(--ws-border);border-radius:6px;background:#fff;outline:none;';
            rangeInput.addEventListener('input', () => { lastRangeInput = rangeInput.value; });
            rangeWrap.appendChild(rangeInput);
            title.appendChild(rangeWrap);
            cb.appendChild(title);
            const allRow = document.createElement('div'); allRow.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;';
            const repInput = document.createElement('input'); repInput.placeholder='바꿀 단어'; repInput.value=lastReplace; repInput.className='ws-input'; repInput.style.cssText='flex:1;';
            repInput.autocomplete = 'off'; repInput.autocorrect = 'off'; repInput.autocapitalize = 'off'; repInput.spellcheck = false;
            repInput.addEventListener('input', () => { lastReplace = repInput.value; });
            allRow.appendChild(repInput);
            cb.appendChild(allRow);
            const row2 = document.createElement('div'); row2.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
            const menuLeft = document.createElement('div'); menuLeft.style.cssText = 'display:flex;gap:6px;';
            menuLeft.appendChild(btn('하나씩 검토', () => { mode='one'; render(); scrollToMark(current, allMatches[current].msgIdx, followScroll); }));
            menuLeft.appendChild(btn('목록', () => { listReturnMode = 'menu'; mode = 'list'; render(); }));
            row2.appendChild(menuLeft);
            row2.appendChild(btn('모두 바꾸기', async () => {
                lastReplace = repInput.value;
                let targetIdxs = uniqueIdxs;
                const rangeStr = rangeInput.value.trim();
                if (rangeStr) {
                    const parsed = parseChangeRangeInput(rangeStr);
                    if (!parsed) { toastr.error('범위를 올바르게 지정해 주세요.', '', { timeOut:4000 }); return; }
                    const parsedSet = new Set(parsed);
                    targetIdxs = uniqueIdxs.filter(idx => parsedSet.has(idx));
                    if (!targetIdxs.length) { toastr.info('입력한 범위에 수정할 메시지가 없습니다.', '', { timeOut:3000 }); return; }
                }
                for (const msgIdx of targetIdxs) await doReplaceAll(msgIdx, repInput.value);
                await SillyTavern.getContext().saveChat?.();
                toastr.success(`${targetIdxs.length}개 메시지를 수정했습니다.`, '', { timeOut:3000 });
                clearDOMHighlights(); closePanel(PANEL_ID);
            }, 'ws-btn-accent'));
            cb.appendChild(row2);

        } else { // one
            setFixed(); cb.innerHTML = '';
            const m = allMatches[current]; if (!m) { clearDOMHighlights(); closePanel(PANEL_ID); return; }
            const header = document.createElement('div'); header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;';
            const titleEl = document.createElement('span'); titleEl.style.cssText = 'font-weight:600;white-space:nowrap;flex-shrink:0;';
            titleEl.innerHTML = `"${escapeHTML(keyword)}" 검토`;
            const posEl = document.createElement('span'); posEl.style.cssText = 'color:var(--ws-text2);font-size:12px;white-space:nowrap;margin-left:auto;flex-shrink:0;';
            posEl.textContent = `#${m.msgIdx} (${current+1}/${allMatches.length})`;
            header.appendChild(titleEl); header.appendChild(makeFollowChk(() => followScroll, v => { followScroll = v; })); header.appendChild(posEl);
            cb.appendChild(header);
            const repInput = document.createElement('input'); repInput.placeholder='바꿀 단어'; repInput.value=lastReplace; repInput.className='ws-input'; repInput.style.marginBottom='20px';
            repInput.autocomplete = 'off'; repInput.autocorrect = 'off'; repInput.autocapitalize = 'off'; repInput.spellcheck = false;
            repInput.addEventListener('input', () => { lastReplace = repInput.value; }); cb.appendChild(repInput);
            const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:space-between;';
            const left = document.createElement('div'); left.style.cssText = 'display:flex;gap:6px;';
            left.appendChild(btn('◀ 이전', () => { if (current===0) { toastr.info('처음입니다.', '', { timeOut:2000 }); return; } navigate(current-1); }));
            left.appendChild(btn('다음 ▶', () => { if (current<allMatches.length-1) navigate(current+1); else toastr.info('마지막입니다.', '', { timeOut:2000 }); }));
            const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:6px;';
            right.appendChild(btn('목록', () => { listReturnMode = 'one'; mode='list'; render(); }));
            right.appendChild(btn('바꾸기', async () => {
                lastReplace = repInput.value;
                await doReplaceOne(m.msgIdx, m.matchIdx, repInput.value);
                await SillyTavern.getContext().saveChat?.(); // 계속 검토 중이라 다음 클릭까지 시간이 걸릴 수 있어 매번 확실히 저장
                allMatches = buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord, ignoreTags, allowedIdxs, ignoreReasoningEffective, getText);
                uniqueIdxs = [...new Set(allMatches.map(am => am.msgIdx))];
                matchCountPerMsg = {}; allMatches.forEach(({ msgIdx }) => { matchCountPerMsg[msgIdx] = (matchCountPerMsg[msgIdx]||0)+1; });
                if (!allMatches.length) { toastr.success('단어 수정이 완료되었습니다.', '', { timeOut:3000 }); clearDOMHighlights(); closePanel(PANEL_ID); return; }
                if (current >= allMatches.length) current = allMatches.length - 1;
                applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, current, wholeWord, jumpToMatch);
                render(); scrollToMark(current, allMatches[current].msgIdx, followScroll);
            }, 'ws-btn-accent'));
            row.appendChild(left); row.appendChild(right); cb.appendChild(row);
        }
        keepCenter(panel, prevCenter);
    }
    render(); scrollToMark(0, allMatches[0].msgIdx, followScroll);
}

export function registerFindChangeCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'find', helpString: 'Search messages. Usage: /find or /find #&@*',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Search keyword (omit to type in popup)', typeList:[ARGUMENT_TYPE.STRING], isRequired:false })],
        callback: (_a, value) => {
            const sel = window.getSelection(), selText = sel?.toString().trim();
            const selInChat = selText && sel.rangeCount > 0 && document.getElementById('chat')?.contains(sel.getRangeAt(0).commonAncestorContainer);
            const keyword = selInChat ? selText : String(value || '').trim();
            if (!keyword) { openFindKeywordPanel(); return ''; }
            runFind(keyword, false, false); return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'change', helpString: 'Find and replace in messages. Usage: /change or /change #&@*',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Search keyword (omit to type in popup)', typeList:[ARGUMENT_TYPE.STRING], isRequired:false })],
        callback: (_a, value) => {
            const sel = window.getSelection(), selText = sel?.toString().trim();
            const selInChat = selText && sel.rangeCount > 0 && document.getElementById('chat')?.contains(sel.getRangeAt(0).commonAncestorContainer);
            const keyword = selInChat ? selText : String(value || '').trim();
            if (!keyword) { openChangeKeywordPanel(); return ''; }
            runChange(keyword, false, false); return '';
        },
    }));
}
