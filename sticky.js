// ─── sticky.js ───────────────────────────────────────────────────────────────
// /sticky — 항상 딱 1개만 존재하는 포스트잇 메모 패널.
//
// 저장 위치를 둘로 나눔:
//  - 텍스트(메모 내용)만 SillyTavern의 extensionSettings(=settings.json, 서버 저장이라
//    기기 간에도 유지됨)에 둠 — "잃어버리면 안 되는 데이터"라 이쪽.
//  - 위치/크기/스크롤/색상/열림 여부는 다른 설정들과 동일하게 기기별 localStorage
//    (wsSettings.sticky, state.js)에 둠 — 기기마다 화면 비율이 달라 위치·크기를 따로
//    두고 싶을 수 있어서, 이런 "화면에 종속적인 값"까지 동기화되면 오히려 불편함.

import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { raiseToTop, wsSettings, saveWsSettings } from './state.js';
import { makeDraggable } from './panel-ui.js';

const STORAGE_KEY = 'slashieSticky'; // extensionSettings 쪽 — text 필드 하나만 씀

// 모바일 가로화면보다 작게 — 큰 화면(태블릿/PC)용 별도 기본 크기는 지금은 안 나누고
// 통일해서 씀 (필요하면 나중에 window.innerWidth 기준 분기 추가 가능)
const DEFAULT_W = 260, DEFAULT_H = 300;
const MIN_W = 160, MIN_H = 140;
const EDGE_MARGIN = 14;

function loadStickyText() {
    try {
        const raw = SillyTavern.getContext().extensionSettings?.[STORAGE_KEY];
        return typeof raw?.text === 'string' ? raw.text : '';
    } catch { return ''; }
}

// stickyData는 두 저장소를 합친 하나의 메모리 상 뷰 — text는 extensionSettings에서,
// 나머지는 wsSettings.sticky(localStorage)에서 채워짐. 어느 필드를 바꿨는지에 따라
// persistStickyText() 또는 persistStickyUI() 중 맞는 쪽을 호출해서 그 저장소에만 반영함.
export const stickyData = { text: loadStickyText(), ...wsSettings.sticky };

function persistStickyText(immediate = false) {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings) return;
        ctx.extensionSettings[STORAGE_KEY] = { text: stickyData.text };
        ctx.saveSettingsDebounced?.();
        // "저장" 버튼 등 즉시 확정이 필요한 경우 — lodash debounce가 제공하는 flush()가
        // 있으면 그 자리에서 바로 실행시켜 디바운스 대기 없이 즉시 settings.json에 반영
        if (immediate) ctx.saveSettingsDebounced?.flush?.();
    } catch {}
}

export function persistStickyUI() {
    Object.assign(wsSettings.sticky, {
        rgb: stickyData.rgb, alpha: stickyData.alpha,
        left: stickyData.left, top: stickyData.top,
        width: stickyData.width, height: stickyData.height,
        scrollTop: stickyData.scrollTop, open: stickyData.open,
    });
    saveWsSettings();
}

export function applyStickyColor() {
    // 배경에만 알파를 태우던 이전 방식(rgba) 대신, 색은 불투명(solid)으로 두고
    // 패널 전체에 opacity를 걸어서 배경/글씨/아이콘/테두리가 한 덩어리로 같이 옅어지게 함.
    document.documentElement.style.setProperty('--ws-sticky-color', stickyData.rgb);
    document.documentElement.style.setProperty('--ws-sticky-opacity', String(stickyData.alpha / 100));
}

function clampGeometry(left, top, width, height) {
    const w = Math.min(Math.max(width, MIN_W), window.innerWidth - EDGE_MARGIN * 2);
    const h = Math.min(Math.max(height, MIN_H), window.innerHeight - EDGE_MARGIN * 2);
    let l = Math.max(EDGE_MARGIN, Math.min(left, window.innerWidth - w - EDGE_MARGIN));
    let t = Math.max(EDGE_MARGIN, Math.min(top, window.innerHeight - h - EDGE_MARGIN));
    return { left: l, top: t, width: w, height: h };
}

let _panel = null, _textarea = null;

function buildIconBtn(faClass, title) {
    const b = document.createElement('button'); b.className = 'ws-sticky-icon-btn'; b.title = title;
    b.innerHTML = `<i class="${faClass}"></i>`;
    b.addEventListener('pointerdown', e => e.stopPropagation()); // 드래그 시작 안 되게
    return b;
}

function closeStickyPanel(saveScroll = true) {
    if (!_panel) return;
    if (saveScroll && _textarea) stickyData.scrollTop = _textarea.scrollTop;
    stickyData.open = false;
    persistStickyUI();
    _panel.remove();
    _panel = null; _textarea = null;
}

function deleteStickyData() {
    if (!window.confirm('메모를 삭제할까요?')) return;
    stickyData.text = '';
    stickyData.scrollTop = 0;
    if (_textarea) _textarea.value = '';
    persistStickyText(true);
    persistStickyUI();
}

function openStickyPanel() {
    if (_panel) { raiseToTop(_panel); return; }
    applyStickyColor();

    const panel = document.createElement('div'); panel.id = 'ws-sticky-panel';
    const hasPos = stickyData.left !== null && stickyData.top !== null;
    const initW = stickyData.width || DEFAULT_W, initH = stickyData.height || DEFAULT_H;
    // 최초 기본 생성 위치 — 화면 우상단 모서리. 이후엔 마지막으로 드래그해둔 위치를 그대로 씀.
    const initLeft = hasPos ? stickyData.left : (window.innerWidth - initW - EDGE_MARGIN);
    const initTop  = hasPos ? stickyData.top  : EDGE_MARGIN;
    const g = clampGeometry(initLeft, initTop, initW, initH);
    panel.style.left = `${g.left}px`; panel.style.top = `${g.top}px`;
    panel.style.width = `${g.width}px`; panel.style.height = `${g.height}px`;

    // 패널 내부 클릭이 document로 새서 ST 드로어를 닫히게 하는 문제 방지(다른 패널들과 동일)
    ['pointerdown', 'mousedown', 'click', 'touchstart'].forEach(evt => {
        panel.addEventListener(evt, e => e.stopPropagation());
    });
    panel.addEventListener('pointerdown', () => raiseToTop(panel));

    const dragbar = document.createElement('div'); dragbar.className = 'ws-sticky-dragbar';
    const saveBtn = buildIconBtn('fa-solid fa-floppy-disk', '저장');
    const trashBtn = buildIconBtn('fa-fw fa-solid fa-trash', '메모 삭제');
    const closeBtn = buildIconBtn('fa-solid fa-xmark', '닫기');
    saveBtn.addEventListener('click', () => {
        stickyData.text = _textarea.value;
        persistStickyText(true);
        toastr.info('저장했습니다.', '', { timeOut:1500 });
    });
    trashBtn.addEventListener('click', () => deleteStickyData());
    closeBtn.addEventListener('click', () => closeStickyPanel());
    dragbar.appendChild(saveBtn); dragbar.appendChild(trashBtn); dragbar.appendChild(closeBtn);
    panel.appendChild(dragbar);
    makeDraggable(panel, dragbar); // 상단 얇은 영역만 잡고 드래그 — 본문 전체 드래그는 지원 안 함(입력 방해 방지)

    const textarea = document.createElement('textarea');
    textarea.value = stickyData.text;
    textarea.placeholder = '메모를 입력하세요';
    textarea.autocomplete = 'off'; textarea.autocorrect = 'off'; textarea.autocapitalize = 'off'; textarea.spellcheck = false;
    // 사실상 무제한처럼 느껴지도록 브라우저가 허용하는 한도 안에서 가능한 한 넉넉하게 설정
    textarea.maxLength = 1000000;
    textarea.addEventListener('input', () => { stickyData.text = textarea.value; persistStickyText(); });
    panel.appendChild(textarea);
    requestAnimationFrame(() => { textarea.scrollTop = stickyData.scrollTop || 0; });

    // 우하단 크기 조절 핸들
    const handle = document.createElement('div'); handle.className = 'ws-sticky-resize-handle';
    handle.innerHTML = `<svg viewBox="0 0 16 16"><path d="M14 2 L2 14 M14 7 L7 14 M14 12 L12 14" stroke="#3f3f3f" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`;
    let resizeDrag = null;
    handle.addEventListener('pointerdown', e => {
        e.stopPropagation();
        resizeDrag = { sx: e.clientX, sy: e.clientY, sw: panel.offsetWidth, sh: panel.offsetHeight };
        handle.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
        if (!resizeDrag) return;
        const rect = panel.getBoundingClientRect();
        const maxW = window.innerWidth - rect.left - EDGE_MARGIN;
        const maxH = window.innerHeight - rect.top - EDGE_MARGIN;
        const w = Math.min(Math.max(resizeDrag.sw + (e.clientX - resizeDrag.sx), MIN_W), maxW);
        const h = Math.min(Math.max(resizeDrag.sh + (e.clientY - resizeDrag.sy), MIN_H), maxH);
        panel.style.width = `${w}px`; panel.style.height = `${h}px`;
    });
    const endResize = () => {
        if (!resizeDrag) return;
        resizeDrag = null;
        stickyData.width = panel.offsetWidth; stickyData.height = panel.offsetHeight;
        persistStickyUI();
    };
    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
    panel.appendChild(handle);

    document.body.appendChild(panel);
    raiseToTop(panel);
    _panel = panel; _textarea = textarea;

    // 드래그로 위치가 바뀌면 저장 — makeDraggable은 panel.style.left/top을 pointerup까지
    // 계속 갱신하므로, pointerup 시점에 최종 좌표를 읽어서 저장(화면 밖으로 안 나가게 클램프도 같이)
    dragbar.addEventListener('pointerup', () => {
        const rect = panel.getBoundingClientRect();
        const g2 = clampGeometry(rect.left, rect.top, rect.width, rect.height);
        panel.style.left = `${g2.left}px`; panel.style.top = `${g2.top}px`;
        stickyData.left = g2.left; stickyData.top = g2.top;
        persistStickyUI();
    });

    stickyData.open = true;
    persistStickyUI();
}

function toggleStickyPanel() {
    if (_panel) closeStickyPanel();
    else openStickyPanel();
}

function registerStickyCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sticky', helpString: 'Toggle the sticky note panel.',
        callback: () => { toggleStickyPanel(); return ''; },
    }));
}

export async function initSticky() {
    applyStickyColor();
    registerStickyCommand();
    // 지난 세션에 열려있었으면 그대로 이어서 열어줌
    if (stickyData.open) openStickyPanel();
}
