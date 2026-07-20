// ─── commands-basic.js ──────────────────────────────────────────────────────
// /collapse /expand /up /down /goto /message-button /message-bottom /message-mb
// /move /undo /clip /word /hidden /edit /fempov

import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '/scripts/slash-commands/SlashCommandArgument.js';

import { parseRange, stripText, expandDetails, stripLeadingTagBlock, stripReasoningBlocks } from './utils.js';
import {
    SUMMARY, getChat, editMessage,
    loadAndScrollTo, copyText, copyFullChat, getSearchableText,
    wsSettings, saveWsSettings, applyWsHlColor, applyWsDeleteColor, WS_DEFAULT_HL_POSITION_PERCENT,
    getMoveSnapshot, setMoveSnapshot, raiseToTop,
} from './state.js';
import { createPanel, getPanelBody, makeDraggable, closePanel } from './panel-ui.js';
import { refreshTextboxButtons } from './textbox-search.js';
import { stickyData, applyStickyColor, persistSticky } from './sticky.js';

// ─── 이동 엔진 (reload 없이 배열+DOM 직접 패치) ──────────────────────────────
// 삭제 기능과 같은 철학: chat 배열은 splice로, 화면은 DOM 노드를 직접 옮기고
// 영향받은 구간의 mesid만 재계산. reloadCurrentChat()은 절대 안 씀 — saveChat만.
//
// 단일 메시지 이동(예전엔 ST의 위/아래 화살표 버튼을 반복 클릭하는 방식이었음)도
// 이제 똑같은 엔진을 씀 — 더 안정적이고, 클릭 반복 없이 한 번에 끝나서 훨씬 빠름.
//
// undo는 이제 채팅 전체를 복제해두지 않음 — "블록을 [fromStart,fromEnd]에서 to로
// 옮기는" 연산은 그 자체로 자기 자신의 역연산으로 되돌릴 수 있어서(옮겨진 블록을
// 원래 시작 위치로 다시 옮기면 원상복구), 딱 숫자 3개(현재 블록 시작/끝, 원래 위치)만
// 기억하면 충분함. 무거운 구조적 복제가 사라졌으니 크고 오래된 채팅에서도 가벼움.
async function ensureRangeLoaded(minIdx, maxIdx) {
    const allPresent = () => {
        for (let i = minIdx; i <= maxIdx; i++) if (!document.querySelector(`#chat [mesid="${i}"]`)) return false;
        return true;
    };
    if (allPresent()) return true;
    return new Promise(resolve => {
        const chatEl = document.getElementById('chat');
        const lb = document.getElementById('show_more_messages');
        if (!chatEl || !lb) { resolve(allPresent()); return; }
        const obs = new MutationObserver(() => {
            if (allPresent()) { obs.disconnect(); resolve(true); return; }
            const btn = document.getElementById('show_more_messages');
            if (btn) btn.click(); else { obs.disconnect(); resolve(allPresent()); }
        });
        obs.observe(chatEl, { childList: true, subtree: true });
        const giveUp = setTimeout(() => { obs.disconnect(); resolve(allPresent()); }, 8000);
        lb.click();
    });
}

// fromStart~fromEnd(연속 구간)를 to 위치로 옮김. 성공 시 undo에 필요한
// { blockStart, blockEnd, target } 를 반환(실패하면 null).
async function performBlockMove(fromStart, fromEnd, to) {
    const chat = getChat();
    const len = fromEnd - fromStart + 1;
    const clampedTo = Math.max(0, Math.min(to, chat.length));
    const lo = Math.min(fromStart, clampedTo);
    const hi = Math.max(fromEnd, clampedTo >= chat.length ? chat.length - 1 : clampedTo);

    const loaded = await ensureRangeLoaded(lo, hi);
    if (!loaded) { toastr.error('메시지를 전부 로드하지 못했습니다. 한 번 더 시도해 주세요.', '', { timeOut:5000 }); return null; }

    // 1) 배열 이동
    const idxs = Array.from({ length: len }, (_, i) => fromStart + i);
    const set = new Set(idxs);
    const msgs = idxs.map(i => chat[i]);
    const rem = chat.filter((_, i) => !set.has(i));
    const before = idxs.filter(i => i < clampedTo).length;
    const adj = Math.max(0, Math.min(clampedTo - before, rem.length));

    // 2) DOM 이동 — 원본 mesid가 아직 안 바뀐 상태에서 앵커(삽입 기준점)를 먼저 확정.
    // 여기서 블록 노드를 못 찾으면 배열만 바뀌고 화면은 그대로인 불일치 상태가 되므로
    // 절대 진행하지 않고 통째로 중단함(ensureRangeLoaded를 통과했다면 이론상 항상 존재해야 함).
    const chatEl = document.getElementById('chat');
    const blockNodes = idxs.map(i => chatEl?.querySelector(`[mesid="${i}"]`));
    if (!chatEl || !blockNodes.every(Boolean)) {
        toastr.error('메시지 이동이 중단되었습니다. 다시 시도해 주세요.', '', { timeOut:4000 });
        return null;
    }
    {
        let anchorNode = null;
        if (adj < fromStart) {
            anchorNode = chatEl.querySelector(`[mesid="${adj}"]`);
        } else if (adj < rem.length) {
            const anchorOrigIdx = fromEnd + 1 + (adj - fromStart);
            anchorNode = chatEl.querySelector(`[mesid="${anchorOrigIdx}"]`);
        } // else adj === rem.length → 맨 끝에 append (anchorNode 없음)

        const frag = document.createDocumentFragment();
        blockNodes.forEach(n => frag.appendChild(n)); // DOM에서 자동으로 떨어져나감(순서 유지)
        if (anchorNode) chatEl.insertBefore(frag, anchorNode);
        else chatEl.appendChild(frag);

        // 3) 영향받은 구간[lo,hi]의 mesid만 새 DOM 순서에 맞춰 재계산
        const zoneNodes = Array.from(chatEl.querySelectorAll('.mes[mesid]')).filter(el => {
            const n = parseInt(el.getAttribute('mesid'), 10);
            return n >= lo && n <= hi;
        });
        zoneNodes.forEach((el, i) => el.setAttribute('mesid', String(lo + i)));
    }

    // 4) 배열 확정 + 즉시 저장(디바운스 아님 — reload 없이 바로 확정)
    chat.length = 0; chat.push(...rem.slice(0, adj), ...msgs, ...rem.slice(adj));
    await SillyTavern.getContext().saveChat?.();

    return { blockStart: adj, blockEnd: adj + len - 1, target: fromStart };
}

export function registerBasicCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'collapse', helpString: 'Wrap message(s) in a &lt;details&gt; tag. Usage: /collapse 2 or /collapse 2-5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Message index or range', typeList:[ARGUMENT_TYPE.STRING], isRequired:true })],
        callback: async (_a, value) => {
            const idxs = parseRange(value); if (!idxs) return '';
            for (const idx of idxs) {
                const msg = getChat()[idx];
                if (!msg || msg.mes.includes(`<summary>${SUMMARY}</summary>`)) continue;
                await editMessage(idx, `<details>\n<summary>${SUMMARY}</summary>\n\n${msg.mes}\n\n</details>`);
            }
            await SillyTavern.getContext().saveChat?.(); // 디바운스 저장이 안 끝난 채 채팅방을 나가도 안전하게
            document.querySelector(`[mesid="${idxs[idxs.length-1]}"]`)?.scrollIntoView({ block:'start' }); return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'expand', helpString: 'Unwrap message(s) from a &lt;details&gt; tag. Usage: /expand 2 or /expand 2-5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Message index or range', typeList:[ARGUMENT_TYPE.STRING], isRequired:true })],
        callback: async (_a, value) => {
            const idxs = parseRange(value); if (!idxs) return '';
            for (const idx of idxs) {
                const msg = getChat()[idx];
                if (!msg || !/<details\b[^>]*>/i.test(msg.mes)) continue;
                await editMessage(idx, expandDetails(msg.mes));
            }
            await SillyTavern.getContext().saveChat?.(); // 디바운스 저장이 안 끝난 채 채팅방을 나가도 안전하게
            document.querySelector(`[mesid="${idxs[idxs.length-1]}"]`)?.scrollIntoView({ block:'start' }); return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'up', helpString: 'Scroll to the top of the chat.',
        callback: () => { document.getElementById('chat')?.scrollTo({ top:0 }); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'down', helpString: 'Scroll to the bottom of the chat.',
        callback: () => { const c = document.getElementById('chat'); if (c) c.scrollTo({ top:c.scrollHeight }); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'message-button', helpString: 'Scroll to the top of the topmost visible message and open its menu.',
        callback: () => {
            const chatEl = document.getElementById('chat'); if (!chatEl) return '';
            const chatRect = chatEl.getBoundingClientRect();
            for (const mes of chatEl.querySelectorAll('.mes[mesid]')) {
                if (mes.getBoundingClientRect().bottom > chatRect.top) {
                    mes.scrollIntoView({ block:'start' });
                    setTimeout(() => {
                        mes.querySelector('div.mes_button.extraMesButtonsHint.fa-solid.fa-ellipsis.interactable')?.click();
                    }, 0);
                    break;
                }
            }
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'message-bottom', helpString: 'Scroll so the bottom of the bottommost visible message aligns with the bottom of the chat area.',
        callback: () => {
            const chatEl = document.getElementById('chat'); if (!chatEl) return '';
            const chatRect = chatEl.getBoundingClientRect();
            const all = chatEl.querySelectorAll('.mes[mesid]');
            for (let i = all.length - 1; i >= 0; i--) {
                const mes = all[i];
                if (mes.getBoundingClientRect().top < chatRect.bottom) {
                    mes.scrollIntoView({ block:'end' });
                    break;
                }
            }
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'message-mb', helpString: 'Scroll to the STMemoryBooks memory boundary marker.',
        callback: () => {
            document.querySelector('div.stmb_memory_boundary_divider')?.scrollIntoView({ block:'start' });
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'goto', helpString: 'Scroll to a message by index. Usage: /goto 5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Message index', typeList:[ARGUMENT_TYPE.NUMBER], isRequired:true })],
        callback: (_a, value) => {
            const idx = parseInt(value, 10); if (isNaN(idx)) return '';
            const chat = getChat();
            if (idx < 0 || idx >= chat.length) { toastr.warning(`0~${chat.length-1} 사이의 숫자를 입력해 주세요.`); return ''; }
            loadAndScrollTo(idx); return '';
        },
    }));

    // ─── /move ────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'move', helpString: 'Move a message or range to a target index. Usage: /move 2 10 or /move 2-5 10',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Source index or range, then target index', typeList:[ARGUMENT_TYPE.STRING], isRequired:true })],
        callback: async (_a, value) => {
            if (wsSettings.moveDisabled) { toastr.warning('편집 모드에서 /move 를 먼저 활성화해 주세요.', '', { timeOut:4000 }); return ''; }
            const parts = String(value).trim().split(/\s+/);
            if (parts.length !== 2) return '';
            const idxs = parseRange(parts[0]), to = parseInt(parts[1], 10);
            if (!idxs || isNaN(to)) return '';
            const fromStart = idxs[0], fromEnd = idxs[idxs.length - 1];
            if (to >= fromStart && to <= fromEnd) { toastr.error('올바르지 않은 요청입니다.', '', { timeOut:3000 }); return ''; }
            const result = await performBlockMove(fromStart, fromEnd, to);
            if (!result) return '';
            setMoveSnapshot(result);
            loadAndScrollTo(result.blockStart);
            return '';
        },
    }));

    // ─── /undo ────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'undo', helpString: 'Undo the last /move.',
        callback: async () => {
            if (wsSettings.moveDisabled) { toastr.warning('편집 모드에서 /move 를 먼저 활성화해 주세요.', '', { timeOut:4000 }); return ''; }
            const snap = getMoveSnapshot();
            if (!snap) { toastr.warning('되돌릴 작업이 없습니다.'); return ''; }
            setMoveSnapshot(null); // 되돌리기는 한 번만 — 되돌린 것 자체를 또 되돌리진 않음
            // 블록이 원래보다 "뒤로"(target < blockStart) 이동했던 경우엔 되돌릴 때
            // 삽입 기준점이 블록 길이만큼 밀려야 정확히 원위치로 복구됨(수학적으로 검증됨).
            // 앞으로 이동했던 경우엔 target 그대로가 맞음.
            const len = snap.blockEnd - snap.blockStart + 1;
            const undoTarget = snap.blockStart >= snap.target ? snap.target : snap.target + len;
            const result = await performBlockMove(snap.blockStart, snap.blockEnd, undoTarget);
            if (!result) return '';
            loadAndScrollTo(result.blockStart);
            return '';
        },
    }));

    // ─── /clip ────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'clip', helpString: 'Copy messages to clipboard. Usage: /clip 2, /clip 2-5, /clip string, or simply /clip',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Message index, range, or literal text. Omit for full chat.', typeList:[ARGUMENT_TYPE.STRING], isRequired:false })],
        callback: async (_a, value) => {
            const trimmed = String(value ?? '').trim();
            if (trimmed && !parseRange(trimmed)) { await copyText(stripReasoningBlocks(trimmed)); return ''; }
            // 에딧모드 "번역문 우선"이 켜져있으면 번역문(있으면)을, 없으면 항상 원문을 읽음
            if (!trimmed) { await copyFullChat(text => stripText(stripReasoningBlocks(text)), getSearchableText); return ''; }
            const chat = getChat(), idxs = parseRange(trimmed);
            if (!idxs) return '';
            const ctx = SillyTavern.getContext(), lines = [];
            for (const idx of idxs) { const msg = chat[idx]; if (!msg) continue; lines.push(`${msg.name||(msg.is_user?ctx.name1:ctx.name2)}: ${stripText(stripReasoningBlocks(getSearchableText(msg)))}`); }
            if (!lines.length) return '';
            await copyText(lines.join('\n\n\n')); return '';
        },
    }));

    // ─── /word ────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'word', helpString: 'Count characters. Usage: /word 2, /word 2-5, /word string, or simply /word',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Message index or range. Omit for full chat.', typeList:[ARGUMENT_TYPE.STRING], isRequired:false })],
        callback: (_a, value) => {
            const trimmed = String(value ?? '').trim();
            let cleaned;
            if (trimmed && !parseRange(trimmed)) { cleaned = stripText(stripReasoningBlocks(trimmed)); }
            else {
                const chat = getChat(), idxs = trimmed ? parseRange(trimmed) : chat.map((_,i) => i);
                if (!idxs) return '';
                cleaned = stripText(stripReasoningBlocks(idxs.map(i => chat[i] ? getSearchableText(chat[i]) : '').join('\n')));
            }
            toastr.info(`공백 포함: ${cleaned.length.toLocaleString()}<br>공백 제외: ${cleaned.replace(/\s/g,'').length.toLocaleString()}<br>단어: ${cleaned.trim().split(/\s+/).filter(w=>w.length>0).length.toLocaleString()}`, '', { timeOut:12000, escapeHtml:false });
            return '';
        },
    }));

    // ─── /hidden 스크롤 고정(핀) 저장 ─────────────────────────────────────
    // 하나의 방식만 씀: "지금 스크롤된 위치(비율)를 그대로 고정" — 번호 클릭이든 핀
    // 아이콘이든 완전히 같은 토글 함수를 씀. 채팅별로 localStorage에 저장.
    function getHiddenPinKey() {
        try {
            const ctx = SillyTavern.getContext();
            return 'ws-hidden-pin-' + (ctx.chatId ?? ctx.characterId ?? 'default');
        } catch { return 'ws-hidden-pin-default'; }
    }
    function loadHiddenPinRatio() {
        try { const raw = localStorage.getItem(getHiddenPinKey()); return raw !== null ? parseFloat(raw) : null; } catch { return null; }
    }
    function saveHiddenPinRatio(ratio) {
        try {
            if (ratio === null) localStorage.removeItem(getHiddenPinKey());
            else localStorage.setItem(getHiddenPinKey(), String(ratio));
        } catch {}
    }

    // ─── /hidden ──────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hidden', helpString: 'List all hidden (is_system) messages. Calling again while open closes it.',
        callback: () => {
            const PANEL_ID = 'ws-hidden-panel';
            if (document.getElementById(PANEL_ID)) { closePanel(PANEL_ID); return ''; } // 다시 부르면 토글로 닫힘
            const chat = getChat();
            const hiddenIdxs = chat.map((msg, idx) => msg.is_system ? idx : null).filter(idx => idx !== null);
            if (!hiddenIdxs.length) { toastr.info('숨겨진 메시지가 없습니다.', '', { timeOut:5000 }); return ''; }
            let pinnedRatio = loadHiddenPinRatio();
            let lastPinSourceIdx = null; // 세션 한정 — 마지막으로 "어느 번호"로 고정했는지(아이콘으로 고정했으면 null)
            const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
            const titleRow = document.createElement('div'); titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:10px;';
            const title = document.createElement('div'); title.style.cssText = 'font-weight:600;';
            title.textContent = `숨김 메시지 ${hiddenIdxs.length}개`;
            // 핀 아이콘 — 탭하면 지금 스크롤 위치를 고정/해제. 각 행의 #번호를 눌러도 같은 방식으로 동작하며,
            // 이미 고정된 상태에서 다른 번호를 누르면 그 위치로 덮어쓰기, 같은 번호를 다시 누르면 해제.
            const pinIcon = document.createElement('i'); pinIcon.className = 'fa-solid fa-map-pin';
            pinIcon.title = '탭: 현재 스크롤 위치 고정/해제';
            pinIcon.style.cssText = 'font-size:13px;flex-shrink:0;cursor:pointer;';
            const updatePinIcon = () => {
                pinIcon.style.opacity = pinnedRatio !== null ? '1' : '0.3';
                pinIcon.style.color = pinnedRatio !== null ? 'var(--ws-pin-color)' : 'var(--ws-text2)';
            };
            updatePinIcon();
            function setPin(sourceIdx) {
                const maxScroll = list.scrollHeight - list.clientHeight;
                pinnedRatio = maxScroll > 0 ? list.scrollTop / maxScroll : 0;
                lastPinSourceIdx = sourceIdx;
                saveHiddenPinRatio(pinnedRatio);
                updatePinIcon();
            }
            function clearPin() {
                pinnedRatio = null; lastPinSourceIdx = null;
                saveHiddenPinRatio(null);
                updatePinIcon();
            }
            pinIcon.addEventListener('click', () => { pinnedRatio !== null ? clearPin() : setPin(null); });
            titleRow.appendChild(title); titleRow.appendChild(pinIcon);
            body.appendChild(titleRow);
            const list = document.createElement('div'); list.className = 'ws-thin-scroll'; list.style.cssText = 'max-height:400px;overflow-y:auto;margin-bottom:14px;';
            hiddenIdxs.forEach(idx => {
                const plain = stripText(stripLeadingTagBlock(chat[idx].mes));
                const item = document.createElement('div'); item.className = 'ws-result-item';
                item.style.cssText = 'display:flex;align-items:center;gap:6px;';
                const num = document.createElement('span'); num.style.cssText = 'color:var(--ws-text2);flex-shrink:0;min-width:3em;font-size:11px;cursor:pointer;'; num.textContent = `#${idx}`;
                num.title = '클릭: 현재 스크롤 위치 고정/해제(다른 번호를 누르면 덮어쓰기)';
                num.addEventListener('click', e => {
                    e.stopPropagation();
                    (pinnedRatio !== null && lastPinSourceIdx === idx) ? clearPin() : setPin(idx);
                });
                const txt = document.createElement('span'); txt.style.cssText = 'color:var(--ws-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                txt.textContent = plain.slice(0,46) + (plain.length>46?'…':'');
                let isHidden = !!chat[idx].is_system;
                const ghost = document.createElement('i'); ghost.className = 'fa-solid fa-ghost'; ghost.title = '숨김 토글';
                ghost.style.cssText = 'flex-shrink:0;font-size:13px;padding:4px 7px;border-radius:6px;cursor:pointer;background:transparent;';
                const upd = () => { ghost.style.opacity = isHidden?'0.85':'0.22'; ghost.style.color = isHidden?'var(--ws-text)':'var(--ws-text2)'; };
                upd();
                ghost.addEventListener('pointerenter', () => { ghost.style.background='rgba(255,255,255,0.25)'; });
                ghost.addEventListener('pointerleave', () => { ghost.style.background='transparent'; });
                ghost.addEventListener('click', async e => {
                    e.stopPropagation();
                    const ctx = SillyTavern.getContext();
                    if (typeof ctx.executeSlashCommandsWithOptions !== 'function') {
                        toastr.error('이 기능은 SillyTavern 최신 버전에서 사용할 수 있습니다.', '', { timeOut:4000 });
                        return;
                    }
                    isHidden = !isHidden; upd();
                    // /hide, /unhide는 ST 자체 로직이라 저장이 디바운스에 걸려 씹히는 문제 자체가 없음
                    await ctx.executeSlashCommandsWithOptions(`/${isHidden ? 'hide' : 'unhide'} ${idx}`, { showOutput: false });
                });
                item.appendChild(num); item.appendChild(txt); item.appendChild(ghost);
                item.addEventListener('click', () => loadAndScrollTo(idx));
                list.appendChild(item);
            });
            body.appendChild(list);

            // 고정된 위치가 있으면 그 비율만큼 리스트를 스크롤한 상태로 패널을 염
            requestAnimationFrame(() => {
                if (pinnedRatio === null) return;
                const maxScroll = list.scrollHeight - list.clientHeight;
                list.scrollTop = maxScroll * pinnedRatio;
            });
            return '';
        },
    }));

    registerFempovCommand();
    registerEditModeCommand();
}

// ─── /edit ──────────────────────────────────────────────────────────────────
// 왼쪽 사이드, find 첫 패널(createPanel 기본 위치)과 같은 y값에 고정으로 뜨는 패널
function closeEditModePanel() { document.getElementById('ws-editmode-panel')?.remove(); }

function openEditModePanel() {
    closeEditModePanel();
    const panel = document.createElement('div'); panel.id = 'ws-editmode-panel';
    panel.style.cssText = `position:fixed;left:14px;top:0;
        background:var(--ws-panel);color:var(--ws-text);
        border:1px solid var(--ws-border);border-radius:var(--ws-radius);
        box-shadow:0 4px 16px rgba(0,0,0,0.06),0 8px 32px rgba(0,0,0,0.04);
        display:flex;flex-direction:column;max-height:82vh;
        font-size:13px;font-family:inherit;width:160px;opacity:0;overflow:hidden;`;

    // 패널 안에서 발생한 클릭이 document까지 올라가서 "바깥 클릭 시 드로어 닫힘" 리스너를
    // 건드리지 않게 막음(검색 패널에 적용한 것과 동일한 방식) — 에딧모드에서 설정 확인하며
    // 여러 항목을 계속 바꾸는 동안 뒤의 설정 드로어가 자꾸 닫혀버리는 문제 방지.
    ['pointerdown', 'mousedown', 'click', 'touchstart'].forEach(evt => {
        panel.addEventListener(evt, e => e.stopPropagation());
    });
    panel.addEventListener('pointerdown', () => raiseToTop(panel));

    // 헤더 — 잡고 움직일 수 있는 드래그 핸들 + 우상단 작은 닫기(X) 버튼
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;padding:8px 8px 0 0;cursor:grab;touch-action:none;';
    const closeBtn = document.createElement('button'); closeBtn.textContent = '✕';
    closeBtn.style.cssText = `background:transparent;border:none;color:var(--ws-text2);
        font-size:13px;font-family:inherit;cursor:pointer;width:22px;height:22px;
        display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;`;
    closeBtn.addEventListener('pointerenter', () => { closeBtn.style.background = 'rgba(0,0,0,0.05)'; });
    closeBtn.addEventListener('pointerleave', () => { closeBtn.style.background = 'transparent'; });
    closeBtn.addEventListener('pointerdown', e => e.stopPropagation()); // 드래그 시작 안 되게
    closeBtn.addEventListener('click', () => closeEditModePanel());
    header.appendChild(closeBtn);
    panel.appendChild(header);
    makeDraggable(panel, header);

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:4px 18px 16px;flex:1;min-height:0;overflow-y:auto;';
    panel.appendChild(body);

    function makeRow(labelText) {
        const lbl = document.createElement('label'); lbl.className = 'ws-label';
        const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check';
        lbl.appendChild(chk); lbl.appendChild(document.createTextNode(labelText));
        body.appendChild(lbl); return chk;
    }

    const delChk = makeRow("향상된 '메시지 삭제'");
    delChk.checked = wsSettings.enhancedDelete;
    delChk.addEventListener('change', () => { wsSettings.enhancedDelete = delChk.checked; applyWsDeleteColor(); saveWsSettings(); });

    // /move 와 /undo 는 한 몸으로 묶어서 같이 끄고 켬 — /move 없이는 되돌릴 것도 없으므로
    const moveChk = makeRow('/move 끄기');
    moveChk.checked = wsSettings.moveDisabled;
    moveChk.addEventListener('change', () => { wsSettings.moveDisabled = moveChk.checked; saveWsSettings(); });

    // "···구분선···"처럼 점선이 글씨 세로 중앙을 지나가는 섹션 라벨 — 여러 섹션에서 재사용
    function makeSectionDivider(label) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0 0;';
        const mkLine = () => { const s = document.createElement('span'); s.style.cssText = 'flex:1;border-top:1px dotted var(--ws-border);opacity:0.55;'; return s; };
        const lbl = document.createElement('span');
        lbl.style.cssText = 'font-size:10px;color:var(--ws-text2);opacity:0.6;letter-spacing:0.02em;white-space:nowrap;';
        lbl.textContent = label;
        row.appendChild(mkLine()); row.appendChild(lbl); row.appendChild(mkLine());
        body.appendChild(row);
        return row;
    }

    // ─── 채팅 검색 — /find, /change에 항상 적용되는 전역 옵션들 ──────────────────
    makeSectionDivider('채팅 검색');
    const reasoningChk = makeRow('추론 블럭 항상 무시');
    reasoningChk.checked = wsSettings.ignoreReasoningBlocks;
    reasoningChk.addEventListener('change', () => { wsSettings.ignoreReasoningBlocks = reasoningChk.checked; saveWsSettings(); });

    const translationChk = makeRow('번역문 우선');
    translationChk.checked = wsSettings.translationSearchEnabled;
    translationChk.addEventListener('change', () => { wsSettings.translationSearchEnabled = translationChk.checked; saveWsSettings(); });
    // 켜져 있으면 /find, /change, 드래그 필의 🔎/🪄, 빠른 수정(연필)까지 전부 원문 대신
    // msg.extra.display_text(번역문)를 우선 검색·치환함(없으면 원문으로 자동 폴백).

    // ─── UI 검색 — 마스터 토글을 꺼두면 아래 3개는 회색으로 비활성화(체크만 남고 기능은 안 켜짐) ──
    makeSectionDivider('UI 검색');
    const uiSearchChk = makeRow('UI 검색 버튼 추가');
    uiSearchChk.checked = wsSettings.uiSearchEnabled;

    function makeIndentedRow(labelText) {
        const lbl = document.createElement('label'); lbl.className = 'ws-label';
        lbl.style.marginLeft = '14px';
        const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check';
        lbl.appendChild(chk); lbl.appendChild(document.createTextNode(labelText));
        body.appendChild(lbl);
        return { lbl, chk };
    }

    const subRows = [];
    function makeTextboxRow(labelText, key) {
        const { lbl, chk } = makeIndentedRow(labelText);
        chk.checked = wsSettings.textboxSearch[key];
        chk.addEventListener('change', () => {
            wsSettings.textboxSearch[key] = chk.checked;
            saveWsSettings();
            refreshTextboxButtons();
        });
        subRows.push({ lbl, chk });
    }
    makeTextboxRow('사용자 정의 CSS', 'customCSS');
    makeTextboxRow('캐릭터 설명', 'description');
    makeTextboxRow('첫 번째 메시지', 'firstMessage');
    // 대체 첫 메시지는 별도 팝업 레이어라 패널이 그 뒤에 가려서 포기 — 체크박스도 제거함

    function updateSubRowsEnabled() {
        const on = uiSearchChk.checked;
        subRows.forEach(({ lbl, chk }) => {
            chk.disabled = !on;
            lbl.style.opacity = on ? '1' : '0.4';
            lbl.style.cursor = on ? 'pointer' : 'not-allowed';
        });
    }
    updateSubRowsEnabled();
    uiSearchChk.addEventListener('change', () => {
        wsSettings.uiSearchEnabled = uiSearchChk.checked;
        saveWsSettings();
        updateSubRowsEnabled();
        refreshTextboxButtons();
    });

    // ─── 드래그 필 — '바꾸기'(마술봉)와 '빠른 수정'(지우개) 아이콘을 각각 독립적으로 끌 수 있음 ──
    makeSectionDivider('드래그 필');
    const pillWandChk = makeRow('바꾸기 끄기');
    pillWandChk.checked = wsSettings.pillWandDisabled;
    pillWandChk.addEventListener('change', () => { wsSettings.pillWandDisabled = pillWandChk.checked; saveWsSettings(); });

    const pillEraserChk = makeRow('빠른 수정 끄기');
    pillEraserChk.checked = wsSettings.pillEraserDisabled;
    pillEraserChk.addEventListener('change', () => { wsSettings.pillEraserDisabled = pillEraserChk.checked; saveWsSettings(); });
    // '번역 모드로 전환'은 스펙 확인 후 추가 예정

    // ─── 하이라이트 ─────────────────────────────────────────────────────────
    makeSectionDivider('하이라이트');

    // 라벨 속 "하이라이트" 글자만 실제 하이라이트 색으로 칠해서, 이 체크박스가 어떤
    // 하이라이트를 가리키는지(포커스=검정 / 일반=초록) 한눈에 구분되게 함
    const FOCUS_HL_STYLE = 'background:var(--ws-hl-cur-bg);color:var(--ws-hl-cur-color);padding:0 2px;border-radius:2px;';
    const NORMAL_HL_STYLE = 'background:var(--ws-hl-color);color:inherit;padding:0 2px;border-radius:2px;';

    // 하이라이트 위치 — 포커스(검정) 하이라이트가 스크롤될 때 화면 상단에서 몇 % 지점에
    // 멈출지 지정. 체크박스+라벨과 입력칸이 한 줄에 나란히(줄바꿈 없이) 오도록 구성.
    const posRow = document.createElement('div');
    posRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const posLbl = document.createElement('label'); posLbl.className = 'ws-label';
    const posChk = document.createElement('input'); posChk.type = 'checkbox'; posChk.className = 'ws-check';
    const posHlWord = document.createElement('span'); posHlWord.textContent = '하이라이트'; posHlWord.style.cssText = FOCUS_HL_STYLE;
    posLbl.appendChild(posChk); posLbl.appendChild(posHlWord);
    const posInput = document.createElement('input'); posInput.type = 'text';
    posInput.className = 'ws-range-input';
    posInput.autocomplete = 'off'; posInput.autocorrect = 'off'; posInput.autocapitalize = 'off'; posInput.spellcheck = false;
    posInput.style.cssText = 'width:28px;padding:3px 6px;font-size:11px;border:1px solid var(--ws-border);border-radius:6px;background:#fff;outline:none;flex-shrink:0;text-align:right;';
    // 기본값이 정수일 때만 플레이스홀더로 보여줌(소수점 있는 값이면 굳이 노출 안 함)
    if (Number.isInteger(WS_DEFAULT_HL_POSITION_PERCENT)) posInput.placeholder = String(WS_DEFAULT_HL_POSITION_PERCENT);
    posInput.value = wsSettings.hlPositionEnabled ? String(wsSettings.hlPositionPercent) : '';
    posChk.checked = wsSettings.hlPositionEnabled;
    posChk.addEventListener('change', () => {
        wsSettings.hlPositionEnabled = posChk.checked;
        posInput.value = wsSettings.hlPositionEnabled ? String(wsSettings.hlPositionPercent) : '';
        saveWsSettings();
    });
    posInput.addEventListener('input', () => {
        const raw = posInput.value.trim();
        // 형식이 이상하거나(숫자가 아니거나) 0~100 범위를 벗어나면 그냥 조용히 무시 —
        // 에러 토스트 없이 마지막으로 저장된 값(또는 기본값)으로 자연스럽게 폴백됨
        if (!/^\d+(\.\d+)?$/.test(raw)) return;
        const n = Number(raw);
        if (n < 0 || n > 100) return;
        wsSettings.hlPositionPercent = n;
        saveWsSettings();
    });
    posRow.appendChild(posLbl); posRow.appendChild(posInput);
    body.appendChild(posRow);

    // 하이라이트 변경 — 체크 안 하면 기본 초록, 체크하면 아래 RGBA 값 적용
    const hlLbl = document.createElement('label'); hlLbl.className = 'ws-label';
    const hlChk = document.createElement('input'); hlChk.type = 'checkbox'; hlChk.className = 'ws-check';
    const hlWord = document.createElement('span'); hlWord.textContent = '하이라이트'; hlWord.style.cssText = NORMAL_HL_STYLE;
    hlLbl.appendChild(hlChk); hlLbl.appendChild(hlWord); hlLbl.appendChild(document.createTextNode(' 변경'));
    body.appendChild(hlLbl);
    hlChk.checked = wsSettings.hlEnabled;
    hlChk.addEventListener('change', () => { wsSettings.hlEnabled = hlChk.checked; applyWsHlColor(); saveWsSettings(); });

    // RGBA 선택 — 체크박스 시작 위치에 맞춰 들여쓰기 없이 정렬 (패널 폭도 얇게)
    const rgbaRow = document.createElement('div');
    rgbaRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const colorInput = document.createElement('input'); colorInput.type = 'color';
    colorInput.value = wsSettings.hlRgb;
    colorInput.style.cssText = 'width:26px;height:20px;padding:0;border:1px solid var(--ws-border);border-radius:4px;cursor:pointer;flex-shrink:0;';
    const alphaInput = document.createElement('input'); alphaInput.type = 'range'; alphaInput.min = '0'; alphaInput.max = '100';
    alphaInput.value = String(wsSettings.hlAlpha);
    alphaInput.style.cssText = 'flex:1;';
    const onColorChange = () => {
        wsSettings.hlRgb = colorInput.value; wsSettings.hlAlpha = parseInt(alphaInput.value, 10);
        applyWsHlColor(); saveWsSettings();
    };
    colorInput.addEventListener('input', onColorChange);
    alphaInput.addEventListener('input', onColorChange);
    rgbaRow.appendChild(colorInput); rgbaRow.appendChild(alphaInput);
    body.appendChild(rgbaRow);

    // ─── 스티키 노트 ────────────────────────────────────────────────────────
    makeSectionDivider('스티키 노트');
    const stickyRow = document.createElement('div');
    stickyRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const stickyColorInput = document.createElement('input'); stickyColorInput.type = 'color';
    stickyColorInput.value = stickyData.rgb;
    stickyColorInput.style.cssText = 'width:26px;height:20px;padding:0;border:1px solid var(--ws-border);border-radius:4px;cursor:pointer;flex-shrink:0;';
    const stickyAlphaInput = document.createElement('input'); stickyAlphaInput.type = 'range'; stickyAlphaInput.min = '0'; stickyAlphaInput.max = '100';
    stickyAlphaInput.value = String(stickyData.alpha);
    stickyAlphaInput.style.cssText = 'flex:1;';
    const onStickyColorChange = () => {
        stickyData.rgb = stickyColorInput.value; stickyData.alpha = parseInt(stickyAlphaInput.value, 10);
        applyStickyColor();
    };
    // 색상은 조작 중엔 applyStickyColor()로 화면만 즉시 갱신하고, 손을 뗀(change) 시점에만
    // settings.json에 확정 저장 — 슬라이더를 움직이는 동안 매 프레임 저장을 걸지 않기 위함
    stickyColorInput.addEventListener('input', onStickyColorChange);
    stickyAlphaInput.addEventListener('input', onStickyColorChange);
    stickyColorInput.addEventListener('change', () => persistSticky());
    stickyAlphaInput.addEventListener('change', () => persistSticky());
    stickyRow.appendChild(stickyColorInput); stickyRow.appendChild(stickyAlphaInput);
    body.appendChild(stickyRow);

    document.body.appendChild(panel);
    raiseToTop(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const ph = panel.offsetHeight;
        // find 첫 패널(createPanel 기본 위치)과 정확히 같은 y값
        const top = Math.max(10, Math.min((window.innerHeight - ph) / 2 - 25, window.innerHeight - ph - 10));
        panel.style.top = `${Math.round(top)}px`;
        panel.style.opacity = '1';
    }));
}

function registerEditModeCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'edit', helpString: 'Toggle the edit panel (disable /move, disable drag pill, change highlight color, sticky note color).',
        callback: () => {
            if (document.getElementById('ws-editmode-panel')) closeEditModePanel();
            else openEditModePanel();
            return '';
        },
    }));
}

// ─── /fempov ─────────────────────────────────────────────────────────────
// AnyPOV(they/their/them 등 중립 대명사) 그리팅을 FemPOV로 자연스럽게 변환.
// generateRaw()로 채팅 기록/캐릭터 카드/프리셋 없이 이 지시문+원문만 딱 모델에 보냄(토큰 절약,
// 맥락 오염 없음).
//
// /fempov      → 캐릭터 설명 + 첫 번째 메시지를 한 번에 보내서 변환하고, 결과를 각각 원래
//                textarea에 바로 덮어씀(미리보기 없음 — 두 필드 다 있는 만큼 입력창 하나로
//                검토하기 번거로워서 곧바로 반영하는 쪽을 택함).
// /fempov 1, 2, 3, ... → 대체 인사말(화면에 보이는 번호 그대로, 1부터 시작) 하나만 변환해서
//                #send_textarea(입력창)에 넣고 사용자가 검토 후 직접 붙여넣게 함 — 대체
//                인사말은 원래 위치가 별도 팝업이라 "바로 덮어쓰기"가 애매해서 기존 방식 유지.
//
// {{user}}, {{char}} 처리: generateRaw()는 내부적으로 프롬프트를 실제 API에 보내기 직전에
// 매크로를 치환해버려서(우리가 손 쓸 수 없는 타이밍), 원문을 그대로 보내면 이미 사용자
// 페르소나 이름/캐릭터 이름으로 바뀐 채 전송됨
// → 보내기 전에 둘 다 눈에 띄는 placeholder로 바꿔치기했다가, 결과를 받은 뒤 다시 원래
// 매크로 문법으로 되돌리는 방식으로 우회 — 실제 이름을 알아내서 대신 채워넣는 방식보다
// 훨씬 간단하고, 결과물에도 매크로 문법이 그대로 남아 캐릭터가 바뀌어도 안전함.
const FEMPOV_USER_PLACEHOLDER = '@@USERNAME@@';
const FEMPOV_CHAR_PLACEHOLDER = '@@CHARNAME@@';
const protectMacros = text => text
    .replace(/\{\{user\}\}/gi, FEMPOV_USER_PLACEHOLDER)
    .replace(/\{\{char\}\}/gi, FEMPOV_CHAR_PLACEHOLDER);
const restoreMacros = text => text
    .split(FEMPOV_USER_PLACEHOLDER).join('{{user}}')
    .split(FEMPOV_CHAR_PLACEHOLDER).join('{{char}}');

const FEMPOV_MACRO_NOTE = `Note: the placeholders ${FEMPOV_USER_PLACEHOLDER} and ${FEMPOV_CHAR_PLACEHOLDER} represent the user's name and the character's name respectively — treat each grammatically as a person's name, and copy them through unchanged wherever they appear.`;

const FEMPOV_RULES = `Rules:
- This conversion is for a female user. The text may contain gender-neutral pronouns (they/their/them) referring to the character, and separately may also contain gender-neutral pronouns referring to the user — convert BOTH to she/her/hers wherever ambiguous, for whichever entity each pronoun instance actually refers to. Read context carefully so you never mix up which pronoun belongs to the character versus the user.
- Beyond pronouns, make only the minimal edits needed where the surrounding context or wording specifically depends on gender (e.g. gendered nouns, idioms). Do not rewrite or rephrase anything else.
- If the text describes the character's sexual orientation as bisexual/pansexual (often written that way just to accommodate a player of any gender), and nothing else in the text strongly implies genuine attraction to multiple genders once converted to FemPOV, change that description to heterosexual instead. Leave it as-is if there's clear, independent evidence of actual bi/pansexuality.
- Preserve all original formatting exactly, including line breaks, markdown, punctuation, and any {{double-curly-brace}} placeholders.`;

// 대체 인사말(단일 텍스트) 전용 시스템 프롬프트
const FEMPOV_SYSTEM_PROMPT_SINGLE = `You will be given a character greeting message written from an AnyPOV (gender-neutral) perspective, using pronouns like "they/their/them" for the character. Rewrite it as FemPOV (female perspective).

${FEMPOV_MACRO_NOTE}

${FEMPOV_RULES}
- Output ONLY the converted text. No preamble, no explanation, no quotation marks around the output.`;

// 캐릭터 설명 + 첫 번째 메시지, 또는 대체 인사말 여러 개를 한 번에 보낼 때 공용으로 쓰는
// "마커로 구분된 다중 섹션" 시스템 프롬프트. 응답을 다시 필드별로 정확히 나눠 담아야 하므로,
// 입력에 쓴 것과 완전히 동일한 마커 줄을 출력에도 그대로 재현하게 시켜서 그 마커를 기준으로 파싱함.
function buildFempovCombinedSystemPrompt(kindDescription, markers) {
    const markerList = markers.map(m => `"${m}"`).join(', ');
    return `You will be given ${kindDescription}, written from an AnyPOV (gender-neutral) perspective using pronouns like "they/their/them" for the character. Convert each to FemPOV (female perspective).

${FEMPOV_MACRO_NOTE}

${FEMPOV_RULES}
- The input is divided into sections, each starting with a line that is exactly one of these markers: ${markerList}. Only sections present in the input should appear in your output.
- Reproduce the exact same marker line(s) in your output, each immediately followed by that section's converted text and nothing else. Do not add any other text, headers, or explanation.`;
}

const FEMPOV_SECTION_DESC = '===FEMPOV_DESCRIPTION===';
const FEMPOV_SECTION_MSG  = '===FEMPOV_FIRST_MESSAGE===';
const FEMPOV_SECTION_GREETING = n => `===FEMPOV_GREETING_${n}===`;

// 텍스트를 "마커\n내용" 형태로 이어붙임 — generateRaw에 보낼 하나의 prompt를 구성.
function buildFempovSections(sections) {
    return sections.map(s => `${s.marker}\n${protectMacros(s.text)}`).join('\n\n');
}

// 위 마커들을 기준으로 응답을 다시 섹션별로 나눔. 마커를 하나도 못 찾으면 null(파싱 실패로 간주).
function parseFempovSections(raw, markers) {
    const found = markers
        .map(m => ({ m, idx: raw.indexOf(m) }))
        .filter(x => x.idx !== -1)
        .sort((a, b) => a.idx - b.idx);
    if (!found.length) return null;
    const result = {};
    for (let i = 0; i < found.length; i++) {
        const start = found[i].idx + found[i].m.length;
        const end = i + 1 < found.length ? found[i + 1].idx : raw.length;
        result[found[i].m] = raw.slice(start, end).trim();
    }
    return result;
}

// 대체 인사말은 DOM이 아니라 캐릭터 데이터(alternate_greetings 배열)에서 직접 읽음 — 대체
// 인사말 편집 팝업은 다른 곳(채팅 입력창 등)을 클릭하면 "바깥 클릭"으로 감지되어 자동으로
// 닫히면서 그 안의 textarea들이 DOM에서 통째로 사라지는데, 명령어 실행 시점엔 이미 팝업이
// 닫혀있는 경우가 많아 DOM 방식으로는 항상 값을 놓쳤음. 캐릭터 데이터는 팝업 상태와 무관하게
// 항상 존재하므로 이 문제를 원천적으로 피함 — 단, 마지막으로 "저장된" 값만 읽어오고, 팝업에서
// 아직 저장 안 한 실시간 수정 내용은 반영되지 않음.

function registerFempovCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fempov', helpString: 'Convert Character Description + First Message to FemPOV using AI and apply the result directly. Usage: /fempov (description + first message, applied in place), /fempov 2 (alternate greeting #2), or /fempov 1-3 (alternate greetings #1 through #3) — greetings are placed in the chat input for review.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Alternate greeting number or range, e.g. 2 or 1-3 (omit to convert description + first message)', typeList:[ARGUMENT_TYPE.STRING], isRequired:false })],
        callback: async (_a, value) => {
            const trimmed = String(value ?? '').trim();
            const ctx = SillyTavern.getContext();
            if (typeof ctx.generateRaw !== 'function') {
                toastr.error('이 기능은 SillyTavern 최신 버전에서 사용할 수 있습니다.', '', { timeOut:4000 });
                return '';
            }

            // ─── 대체 인사말(하나 또는 범위): 기존처럼 입력창 미리보기 ─────────────
            if (trimmed) {
                const idxs = parseRange(trimmed);
                if (!idxs) { toastr.warning('번호를 다시 확인해 주세요.', '', { timeOut:3000 }); return ''; }

                const char = ctx.characters?.[ctx.characterId];
                const greetings = char?.data?.alternate_greetings ?? char?.alternate_greetings ?? [];
                const items = idxs
                    .map(n => ({ n, text: greetings[n - 1] }))
                    .filter(({ text }) => text !== undefined && text !== null && String(text).trim());
                if (!items.length) { toastr.warning('번호를 다시 확인해 주세요.', '', { timeOut:3000 }); return ''; }

                // 번호 하나뿐이면 기존처럼 단일 텍스트를 그대로(헤더 없이) 입력창에 넣음.
                if (items.length === 1) {
                    const original = items[0].text;
                    let result;
                    try {
                        result = await ctx.generateRaw({ systemPrompt: FEMPOV_SYSTEM_PROMPT_SINGLE, prompt: protectMacros(original) });
                    } catch (err) {
                        console.error('[WS] /fempov generateRaw failed:', err);
                        result = null;
                    }
                    if (!result || !result.trim()) { toastr.error('응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.', '', { timeOut:4000 }); return ''; }

                    const sendTa = document.querySelector('#send_textarea');
                    if (!sendTa) return '';
                    sendTa.value = restoreMacros(result.trim());
                    sendTa.dispatchEvent(new Event('input', { bubbles: true }));
                    sendTa.focus();
                    return '';
                }

                // 여러 번호("1-3" 등): 한 번에 같이 보내고, 결과를 "--- Alt Greeting #N ---"
                // 구분선과 함께 순서대로 입력창에 넣어서 사용자가 각각 복사해 붙여넣게 함.
                const sections = items.map(({ n, text }) => ({ marker: FEMPOV_SECTION_GREETING(n), text }));
                const systemPrompt = buildFempovCombinedSystemPrompt('one or more character greeting messages, each in its own section', sections.map(s => s.marker));

                let result;
                try {
                    result = await ctx.generateRaw({ systemPrompt, prompt: buildFempovSections(sections) });
                } catch (err) {
                    console.error('[WS] /fempov generateRaw failed:', err);
                    result = null;
                }
                if (!result || !result.trim()) { toastr.error('응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.', '', { timeOut:4000 }); return ''; }

                const parsed = parseFempovSections(result, sections.map(s => s.marker));
                const sendTa = document.querySelector('#send_textarea');
                if (!parsed) {
                    if (sendTa) {
                        sendTa.value = restoreMacros(result.trim());
                        sendTa.dispatchEvent(new Event('input', { bubbles: true }));
                        sendTa.focus();
                    }
                    toastr.warning('결과를 입력창으로 전송합니다.', '', { timeOut:4000 });
                    return '';
                }

                const displayParts = items
                    .map(({ n }) => {
                        const converted = parsed[FEMPOV_SECTION_GREETING(n)];
                        return converted === undefined ? null : `--- Alt Greeting #${n} ---\n${restoreMacros(converted)}`;
                    })
                    .filter(Boolean);
                if (!displayParts.length || !sendTa) { toastr.error('응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.', '', { timeOut:4000 }); return ''; }
                sendTa.value = displayParts.join('\n\n');
                sendTa.dispatchEvent(new Event('input', { bubbles: true }));
                sendTa.focus();
                return '';
            }

            // ─── 캐릭터 설명 + 첫 번째 메시지: 한 번에 보내고 원위치에 바로 반영 ──────
            const descTa = document.querySelector('#description_textarea');
            const msgTa = document.querySelector('#firstmessage_textarea');
            const descText = descTa?.value ?? '';
            const msgText = msgTa?.value ?? '';
            if (!descText.trim() && !msgText.trim()) { toastr.warning('내용이 없습니다.', '', { timeOut:3000 }); return ''; }

            const sections = [];
            if (descText.trim()) sections.push({ marker: FEMPOV_SECTION_DESC, text: descText });
            if (msgText.trim())  sections.push({ marker: FEMPOV_SECTION_MSG,  text: msgText  });
            const systemPrompt = buildFempovCombinedSystemPrompt("a character's description and/or first message", sections.map(s => s.marker));

            let result;
            try {
                result = await ctx.generateRaw({ systemPrompt, prompt: buildFempovSections(sections) });
            } catch (err) {
                console.error('[WS] /fempov generateRaw failed:', err);
                result = null;
            }
            if (!result || !result.trim()) { toastr.error('응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.', '', { timeOut:4000 }); return ''; }

            const parsed = parseFempovSections(result, sections.map(s => s.marker));
            if (!parsed) {
                // 마커를 못 찾으면(모델이 형식을 안 지킨 경우) 잘못된 내용으로 원본을 덮어쓰지
                // 않도록, 대신 입력창에 그대로 넣어 사용자가 직접 판단하게 함.
                const sendTa = document.querySelector('#send_textarea');
                if (sendTa) {
                    sendTa.value = restoreMacros(result.trim());
                    sendTa.dispatchEvent(new Event('input', { bubbles: true }));
                    sendTa.focus();
                }
                toastr.warning('결과를 입력창으로 전송합니다.', '', { timeOut:4000 });
                return '';
            }

            let updatedCount = 0;
            if (parsed[FEMPOV_SECTION_DESC] !== undefined && descTa) {
                descTa.value = restoreMacros(parsed[FEMPOV_SECTION_DESC]);
                descTa.dispatchEvent(new Event('input', { bubbles: true }));
                updatedCount++;
            }
            if (parsed[FEMPOV_SECTION_MSG] !== undefined && msgTa) {
                msgTa.value = restoreMacros(parsed[FEMPOV_SECTION_MSG]);
                msgTa.dispatchEvent(new Event('input', { bubbles: true }));
                updatedCount++;
            }
            if (!updatedCount) { toastr.error('응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.', '', { timeOut:4000 }); return ''; }
            toastr.success(`${updatedCount}개 항목이 변경되었습니다.`, '', { timeOut:3000 });
            return '';
        },
    }));
}
