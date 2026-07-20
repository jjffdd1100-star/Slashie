// ─── sticky.js ───────────────────────────────────────────────────────────────
// /sticky — 항상 딱 1개만 존재하는 포스트잇 메모 패널.
//
// 다른 모든 설정(하이라이트 색, /move 끄기 등)은 기기별 localStorage(ws-edit-settings)에
// 저장되지만, 이 메모는 "잃어버리면 안 되는 데이터"라는 성격이 강해서 SillyTavern의
// extensionSettings(=settings.json, 서버에 저장되어 기기 간에도 유지됨)에 따로 저장함.
// 텍스트, 위치/크기, 스크롤 위치, 색상/불투명도, 열림 상태까지 전부 이쪽에 포함.

import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { raiseToTop } from './state.js';
import { makeDraggable } from './panel-ui.js';

const STORAGE_KEY = 'slashieSticky';
export const WS_DEFAULT_STICKY_RGB = '#FEF2B5', WS_DEFAULT_STICKY_ALPHA = 85; // 0~100, 기본 노란색 포스트잇

// 모바일 가로화면보다 작게 — 큰 화면(태블릿/PC)용 별도 기본 크기는 지금은 안 나누고
// 통일해서 씀 (필요하면 나중에 window.innerWidth 기준 분기 추가 가능)
const DEFAULT_W = 260, DEFAULT_H = 300;
const MIN_W = 160, MIN_H = 140;
const EDGE_MARGIN = 14;

function defaultData() {
    return {
        text: '', open: false,
        rgb: WS_DEFAULT_STICKY_RGB, alpha: WS_DEFAULT_STICKY_ALPHA,
        left: null, top: null, width: DEFAULT_W, height: DEFAULT_H, scrollTop: 0,
    };
}

function loadData() {
    try {
        const ctx = SillyTavern.getContext();
        const raw = ctx.extensionSettings?.[STORAGE_KEY];
        const d = defaultData();
        if (!raw) return d;
        return {
            text: typeof raw.text === 'string' ? raw.text : d.text,
            open: !!raw.open,
            rgb: typeof raw.rgb === 'string' ? raw.rgb : d.rgb,
            alpha: typeof raw.alpha === 'number' ? raw.alpha : d.alpha,
            left: typeof raw.left === 'number' ? raw.left : d.left,
            top: typeof raw.top === 'number' ? raw.top : d.top,
            width: typeof raw.width === 'number' ? raw.width : d.width,
            height: typeof raw.height === 'number' ? raw.height : d.height,
            scrollTop: typeof raw.scrollTop === 'number' ? raw.scrollTop : d.scrollTop,
        };
    } catch { return defaultData(); }
}

// 객체 참조 자체를 export — wsSettings와 동일한 패턴(다른 곳은 프로퍼티만 수정)
export const stickyData = loadData();

export function persistSticky(immediate = false) {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings) return;
        ctx.extensionSettings[STORAGE_KEY] = { ...stickyData };
        ctx.saveSettingsDebounced?.();
        // "저장" 버튼 등 즉시 확정이 필요한 경우 — lodash debounce가 제공하는 flush()가
        // 있으면 그 자리에서 바로 실행시켜 디바운스 대기 없이 즉시 settings.json에 반영
        if (immediate) ctx.saveSettingsDebounced?.flush?.();
    } catch {}
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
    persistSticky();
    _panel.remove();
    _panel = null; _textarea = null;
}

function deleteStickyData() {
    if (!window.confirm('메모를 삭제할까요?')) return;
    stickyData.text = '';
    stickyData.scrollTop = 0;
    if (_textarea) _textarea.value = '';
    persistSticky(true);
}

export function openStickyPanel() {
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
        persistSticky(true);
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
    textarea.addEventListener('input', () => { stickyData.text = textarea.value; persistSticky(); });
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
        persistSticky();
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
        persistSticky();
    });

    stickyData.open = true;
    persistSticky();
}

export function toggleStickyPanel() {
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
