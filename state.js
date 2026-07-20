// ─── state.js ───────────────────────────────────────────────────────────────
// 채팅 데이터 접근, 설정 저장/로드, 클립보드, 스크롤 등 여러 모듈이 공유하는 상태/헬퍼.

// 원래 리터럴 '*'였으나 마크다운 렌더러가 이걸 이탤릭 시작 마커로 오인해서
// (특히 본문에 짝이 안 맞는 * 가 있을 때) 태그 뒤에 엉뚱한 * 하나가 새는 버그가 있었음.
// HTML 엔티티로 바꾸면 화면엔 똑같이 * 로 보이면서 마크다운 파서가 아예 건드리지 않음.
export const SUMMARY = '꒰⍤꒱ ༘&#42; Collapsed';

// ── chat helpers ────────────────────────────────────────────────────────────
export const getChat = () => SillyTavern.getContext().chat;

export async function editMessage(idx, newMes) {
    const ctx = SillyTavern.getContext(), chat = getChat();
    chat[idx].mes = newMes;
    const sid = chat[idx].swipe_id ?? 0;
    if (chat[idx].swipes && sid < chat[idx].swipes.length) chat[idx].swipes[sid] = newMes;
    const el = document.querySelector(`#chat [mesid="${idx}"] .mes_text`);
    if (el && ctx.messageFormatting)
        el.innerHTML = ctx.messageFormatting(newMes, chat[idx].name, chat[idx].is_system, chat[idx].is_user, idx);
    ctx.saveChatDebounced?.();
}

// 번역 확장이 msg.mes(원문)는 그대로 두고 msg.extra.display_text에 번역문을 저장해서 화면에
// 그 번역문을 대신 그려주는 방식일 때 — /find, /change가 이 필드를 직접 읽고 쓰기 위한 헬퍼.
// msg.extra 자체는 ST 코어가 제공하는 범용 저장공간이라 어떤 확장이든 아무 값이나 넣어둘 수 있어서
// 그것만으로는 판별 근거가 안 됨 — 실제 번역문이 있는지는 항상 msg.extra.display_text 필드로
// 구체적으로 확인함(cat-translator, magic-translation 등 여러 번역 확장이 공통으로 이
// 필드명을 씀). DOM에 번역문 전용 클래스가 따로 없어도(=mes_text 그대로 재사용) 데이터 필드 자체가
// 분리되어 있으므로 이쪽으로 검색/치환하면 원문을 안 건드리고 번역문만 바뀜.
export async function editTranslatedText(idx, newText) {
    const ctx = SillyTavern.getContext(), chat = getChat();
    const msg = chat[idx];
    if (!msg.extra) msg.extra = {};
    msg.extra.display_text = newText;
    // 확장이 스와이프별로 번역을 따로 캐시해두는 구조라, 있으면 그쪽도 같이 맞춰줌(없어도 무해)
    if (msg.swipe_id !== undefined && msg.extra.swipe_translations?.[msg.swipe_id]) {
        msg.extra.swipe_translations[msg.swipe_id].display_text = newText;
    }
    if (typeof ctx.updateMessageBlock === 'function') {
        ctx.updateMessageBlock(idx, msg);
    } else {
        // 폴백 — 그 API가 없는 구버전에서도 최소한 화면 텍스트는 갱신되게
        const el = document.querySelector(`#chat [mesid="${idx}"] .mes_text`);
        if (el && ctx.messageFormatting) el.innerHTML = ctx.messageFormatting(newText, msg.name, msg.is_system, msg.is_user, idx);
    }
    ctx.saveChatDebounced?.();
}

// 에딧모드의 "번역문 우선" 토글에 따라, 이 메시지에서 검색/복사/요약 등에 쓸 "본문 텍스트"를
// 하나로 통일해서 결정하는 공용 헬퍼 — /find, /change, /clip, /word, 드래그 필(📎/🔎/🪄) 등
// 텍스트를 읽어야 하는 모든 곳이 이 함수 하나만 거치면 됨(중복 방지). 켜져 있으면 번역문이
// 우선이고, 없으면 항상 원문으로 자동 폴백. 꺼져 있으면 그냥 항상 원문.
export function getSearchableText(msg) {
    if (!wsSettings.translationSearchEnabled) return msg.mes;
    return msg.extra?.display_text ?? msg.mes;
}

// ── scroll helpers ──────────────────────────────────────────────────────────
export function loadAndScrollTo(idx) {
    const el = document.querySelector(`[mesid="${idx}"]`);
    if (el) { el.scrollIntoView({ block: 'start' }); return; }
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    let settled = false;
    const finish = (found) => {
        if (settled) return; settled = true;
        obs.disconnect(); clearTimeout(giveUp);
        if (found) setTimeout(() => found.scrollIntoView({ block: 'start' }), 400);
        else chatEl.scrollTo({ top: 0 });
    };
    const obs = new MutationObserver(() => {
        const f = document.querySelector(`[mesid="${idx}"]`);
        if (f) { finish(f); return; }
        document.getElementById('show_more_messages')?.click() ?? finish(null);
    });
    obs.observe(chatEl, { childList: true, subtree: true });
    const giveUp = setTimeout(() => finish(null), 8000);
    const lb = document.getElementById('show_more_messages');
    if (lb) lb.click(); else finish(null);
}

// ── clipboard ────────────────────────────────────────────────────────────────
export async function copyText(text) {
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(text); ok = true; } catch {} }
    if (!ok) {
        try {
            const ta = Object.assign(document.createElement('textarea'), { value: text });
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta); ta.focus(); ta.select();
            ok = document.execCommand('copy'); document.body.removeChild(ta);
        } catch {}
    }
    if (ok) toastr.info('Copied!', '', { timeOut:2000 });
    else     toastr.error('Clipboard 접근이 거부되었습니다.', '', { timeOut:3000 });
}

// getText 생략 시 기본은 원문(msg.mes) — /clip, 드래그 필 📎 등에서 "번역문 우선" 토글에 맞춰
// getSearchableText를 넘기면 전체 채팅 복사도 번역문 우선으로 동작함.
export async function copyFullChat(stripText, getText = null) {
    const chat = getChat(), ctx = SillyTavern.getContext(), lines = [];
    for (const msg of chat) {
        if (!msg) continue;
        const raw = getText ? getText(msg) : msg.mes;
        lines.push(`${msg.name||(msg.is_user?ctx.name1:ctx.name2)}: ${stripText(raw)}`);
    }
    if (!lines.length) return;
    await copyText(lines.join('\n\n\n'));
}

// ── 편집모드 설정 (localStorage에 저장, 기기별) ──────────────────────────────
import { hexAlphaToRgba } from './utils.js';

const WS_SETTINGS_KEY = 'ws-edit-settings';
export const WS_DEFAULT_HL_RGB = '#b1e0b3', WS_DEFAULT_HL_ALPHA = 90; // 0~100
// 포커스 하이라이트로 스크롤될 때 화면 상단에서 몇 %쯤 되는 위치에 멈출지(기존엔 12%로 고정돼있었음)
export const WS_DEFAULT_HL_POSITION_PERCENT = 12;

// 팝업 텍스트박스(사용자 정의 CSS/캐릭터 설명/첫 메시지) 찾기+바꾸기 버튼 — 3개 독립 on/off.
// (대체 첫 메시지는 팝업이 별도 레이어라 패널을 못 띄워서 지원 포기함)
function defaultTextboxSearch() {
    return { customCSS: false, description: false, firstMessage: false };
}

function loadWsSettings() {
    // moveDisabled 기본값 true — 처음 설치 시 /move·/undo 가 함께 꺼져있는 상태로 시작
    const fallback = {
        moveDisabled: true, pillWandDisabled: false, pillEraserDisabled: false,
        hlEnabled: false, hlRgb: WS_DEFAULT_HL_RGB, hlAlpha: WS_DEFAULT_HL_ALPHA,
        hlPositionEnabled: false, hlPositionPercent: WS_DEFAULT_HL_POSITION_PERCENT,
        enhancedDelete: false,
        ignoreReasoningBlocks: false,
        translationSearchEnabled: false,
        uiSearchEnabled: false,
        textboxSearch: defaultTextboxSearch(),
    };
    try {
        const raw = localStorage.getItem(WS_SETTINGS_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return {
            moveDisabled: typeof parsed.moveDisabled === 'boolean' ? parsed.moveDisabled : true,
            // 예전 pillDisabled(단일 토글) 설정을 갖고 있던 사용자를 위해, 있으면 두 새 토글의
            // 초기값으로 그대로 이어받음(마이그레이션) — 없으면 그냥 기본값(둘 다 꺼짐=둘 다 켜진 상태) 사용
            pillWandDisabled: typeof parsed.pillWandDisabled === 'boolean' ? parsed.pillWandDisabled : !!parsed.pillDisabled,
            pillEraserDisabled: typeof parsed.pillEraserDisabled === 'boolean' ? parsed.pillEraserDisabled : !!parsed.pillDisabled,
            hlEnabled: !!parsed.hlEnabled,
            hlRgb: typeof parsed.hlRgb === 'string' ? parsed.hlRgb : WS_DEFAULT_HL_RGB,
            hlAlpha: typeof parsed.hlAlpha === 'number' ? parsed.hlAlpha : WS_DEFAULT_HL_ALPHA,
            hlPositionEnabled: !!parsed.hlPositionEnabled,
            hlPositionPercent: (typeof parsed.hlPositionPercent === 'number' && parsed.hlPositionPercent >= 0 && parsed.hlPositionPercent <= 100)
                ? parsed.hlPositionPercent : WS_DEFAULT_HL_POSITION_PERCENT,
            enhancedDelete: !!parsed.enhancedDelete,
            ignoreReasoningBlocks: !!parsed.ignoreReasoningBlocks,
            translationSearchEnabled: !!parsed.translationSearchEnabled,
            uiSearchEnabled: !!parsed.uiSearchEnabled,
            textboxSearch: {
                customCSS: !!parsed.textboxSearch?.customCSS,
                description: !!parsed.textboxSearch?.description,
                firstMessage: !!parsed.textboxSearch?.firstMessage,
            },
        };
    } catch { return fallback; }
}

// 객체 참조 자체를 export — 다른 모듈은 프로퍼티만 수정(재할당 금지)
export const wsSettings = loadWsSettings();

export function saveWsSettings() {
    try { localStorage.setItem(WS_SETTINGS_KEY, JSON.stringify(wsSettings)); } catch {}
}

export const WS_DEFAULT_HL_COLOR = hexAlphaToRgba(WS_DEFAULT_HL_RGB, WS_DEFAULT_HL_ALPHA);

export function applyWsHlColor() {
    const color = wsSettings.hlEnabled ? hexAlphaToRgba(wsSettings.hlRgb, wsSettings.hlAlpha) : WS_DEFAULT_HL_COLOR;
    document.documentElement.style.setProperty('--ws-hl-color', color);
}

// 삭제모드 연한 빨강 색상도 "향상된 메시지 삭제" 토글에 같이 묶음 — 꺼져 있으면 ST 기본 진한 빨강 그대로
export function applyWsDeleteColor() {
    document.body.classList.toggle('ws-soft-delete-color', wsSettings.enhancedDelete);
}

// ── 패널 간 z-index 쟁탈 ──────────────────────────────────────────────────────
// 두 계층으로 나눔:
//  1) 일반 계층(raiseToTop) — /edit, /sticky, find/change, 드래그 필 수정창 등 "떠있는
//     일반 패널" 전부가 같이 씀. 어느 쪽에도 영구적인 우위를 주지 않고 "마지막으로 탭한
//     패널"이 그 계층 안에서 맨 위로 오게 함.
//     기준값(3000)은 SillyTavern 자체 상단바/드로어보다는 낮게 잡은 값 — 정확한 실측값이
//     아니라 안전하게 낮춘 추정치라, 실제로 겹치는 UI가 있으면 이 숫자만 조절하면 됨.
//  2) 텍스트박스 검색 계층(raiseToTopHigh) — 팝업으로 뜨는 커스텀 CSS/캐릭터 설명 편집창
//     "위에" 겹쳐서 그 안의 텍스트를 찾아야 하는 특수한 경우라, 일반 계층과 같이 낮추면
//     안 됨(그 팝업들 자체가 이미 매우 높은 z-index라서). 기존처럼 최상단 유지.
//
// 카운터를 무한정 올리기만 하던 예전 방식은, 세션을 오래 쓰면서 클릭/드래그가 누적될수록
// 계속 커지다가 결국 ST 자체 팝업의 z-index까지 넘어서 버리는 문제가 있었음(한 번 넘어서면
// 그 뒤로 계속 위에 뜸). 대신 "지금 열려있는 패널들의 순서(MRU)"만 기억해뒀다가, 그 순서대로
// base, base+1, base+2 ... 처럼 작은 범위 안에서만 z-index를 다시 매겨서 절대 커지지 않게 함.
function makeRaiser(base) {
    const order = [];
    return function raise(panel) {
        const i = order.indexOf(panel);
        if (i !== -1) order.splice(i, 1);
        order.push(panel);
        // 이미 닫혀서 DOM에서 떨어져나간 패널은 목록에서 같이 정리(안 그러면 계속 쌓임)
        for (let idx = order.length - 1; idx >= 0; idx--) {
            if (!order[idx].isConnected) order.splice(idx, 1);
        }
        order.forEach((p, idx) => p.style.setProperty('z-index', String(base + idx), 'important'));
    };
}

export const raiseToTop = makeRaiser(3000);
export const raiseToTopHigh = makeRaiser(10000000);

// ── /move 스냅샷 ───────────────────────────────────────────────────────────
// 숫자 3개(blockStart, blockEnd, target)뿐이라 가볍고, 다른 기능과도 무관해서
// window에 둘 필요 없이 그냥 모듈 변수로 둠.
let _moveSnapshot = null;
export function getMoveSnapshot() { return _moveSnapshot; }
export function setMoveSnapshot(v) { _moveSnapshot = v; }

export function initMoveSnapshotClearing() {
    const _ctx0 = SillyTavern.getContext();
    const _evtR = _ctx0.event_types?.MESSAGE_RECEIVED ?? 'message_received';
    const _evtS = _ctx0.event_types?.MESSAGE_SENT     ?? 'message_sent';
    const _evtC = _ctx0.event_types?.CHAT_CHANGED      ?? 'chat_id_changed';
    // 리스너 함수 참조 자체는 window에 유지(다른 init 함수들과 동일한 이유) — 재실행 시
    // 이전에 등록해둔 리스너를 정확히 찾아서 지우고 새로 등록하기 위한 용도일 뿐,
    // 스냅샷 데이터 자체와는 무관함.
    if (window._wsClearSnapshot) {
        _ctx0.eventSource?.removeListener?.(_evtR, window._wsClearSnapshot);
        _ctx0.eventSource?.removeListener?.(_evtS, window._wsClearSnapshot);
        _ctx0.eventSource?.removeListener?.(_evtC, window._wsClearSnapshot);
    }
    window._wsClearSnapshot = () => { _moveSnapshot = null; };
    _ctx0.eventSource?.on?.(_evtR, window._wsClearSnapshot);
    _ctx0.eventSource?.on?.(_evtS, window._wsClearSnapshot);
    _ctx0.eventSource?.on?.(_evtC, window._wsClearSnapshot);
}
