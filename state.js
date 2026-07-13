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
    if (ok) toastr.success('Copied!', '', { timeOut:2000 });
    else     toastr.error('Clipboard 접근이 거부되었습니다.', '', { timeOut:3000 });
}

export async function copyFullChat(stripText) {
    const chat = getChat(), ctx = SillyTavern.getContext(), lines = [];
    for (const msg of chat) { if (!msg) continue; lines.push(`${msg.name||(msg.is_user?ctx.name1:ctx.name2)}: ${stripText(msg.mes)}`); }
    if (!lines.length) return;
    await copyText(lines.join('\n\n\n'));
}

// ── 편집모드 설정 (localStorage에 저장, 기기별) ──────────────────────────────
import { hexAlphaToRgba } from './utils.js';

const WS_SETTINGS_KEY = 'ws-edit-settings';
export const WS_DEFAULT_HL_RGB = '#b1e0b3', WS_DEFAULT_HL_ALPHA = 90; // 0~100
// 포커스 하이라이트로 스크롤될 때 화면 상단에서 몇 %쯤 되는 위치에 멈출지(기존엔 12%로 고정돼있었음)
export const WS_DEFAULT_HL_POSITION_PERCENT = 12;

function loadWsSettings() {
    // moveDisabled 기본값 true — 처음 설치 시 /move·/undo 가 함께 꺼져있는 상태로 시작
    const fallback = {
        moveDisabled: true, pillDisabled: false, hlEnabled: false, hlRgb: WS_DEFAULT_HL_RGB, hlAlpha: WS_DEFAULT_HL_ALPHA,
        hlPositionEnabled: false, hlPositionPercent: WS_DEFAULT_HL_POSITION_PERCENT,
        enhancedDelete: false,
    };
    try {
        const raw = localStorage.getItem(WS_SETTINGS_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return {
            moveDisabled: typeof parsed.moveDisabled === 'boolean' ? parsed.moveDisabled : true,
            pillDisabled: !!parsed.pillDisabled,
            hlEnabled: !!parsed.hlEnabled,
            hlRgb: typeof parsed.hlRgb === 'string' ? parsed.hlRgb : WS_DEFAULT_HL_RGB,
            hlAlpha: typeof parsed.hlAlpha === 'number' ? parsed.hlAlpha : WS_DEFAULT_HL_ALPHA,
            hlPositionEnabled: !!parsed.hlPositionEnabled,
            hlPositionPercent: (typeof parsed.hlPositionPercent === 'number' && parsed.hlPositionPercent >= 0 && parsed.hlPositionPercent <= 100)
                ? parsed.hlPositionPercent : WS_DEFAULT_HL_POSITION_PERCENT,
            enhancedDelete: !!parsed.enhancedDelete,
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
