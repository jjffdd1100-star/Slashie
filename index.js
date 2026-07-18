// ─────────────────────────────────────────────────────────────────────────
// 참고 및 출처
// - /goto, /message-button 기능 일부는 SillyTavern-LALib(@LenAnderson) 확장 프로그램의
//   /message-move 로직(DOM 클릭 방식)을 참고했습니다. (※ /move는 현재 배열+DOM 직접 패치
//   방식으로 완전히 새로 구현되어 있어 이 DOM 클릭 방식을 더 이상 사용하지 않습니다)
//   https://github.com/LenAnderson/SillyTavern-LALib
// - /find, /change, 빠른수정(드래그 필) 기능에 쓰인 텍스트 선택 하이라이팅은
//   bookmark(@ring***) 확장 프로그램에서 영감을 받았습니다.
//
// Credits
// - Part of the /goto and /message-button logic (DOM-click based) was adapted from the
//   /message-move command of the SillyTavern-LALib extension (@LenAnderson). (Note: /move
//   has since been fully reimplemented using direct array+DOM patching and no longer uses
//   this DOM-click technique.)
//   https://github.com/LenAnderson/SillyTavern-LALib
// - The text-selection highlighting used in /find, /change, and the quick-replace
//   (drag pill) feature was inspired by the bookmark extension (@ring***).
// ─────────────────────────────────────────────────────────────────────────
import { applyWsHlColor, applyWsDeleteColor, initMoveSnapshotClearing } from './state.js';
import { registerBasicCommands } from './commands-basic.js';
import { registerFindChangeCommands } from './find-change.js';
import { initDragFeatures } from './drag-features.js';
import { initTextboxSearch } from './textbox-search.js';

// ─── Panel CSS ────────────────────────────────────────────────────────────
function injectThemeCSS() {
    if (document.getElementById('ws-theme-vars')) return;
    const s = document.createElement('style'); s.id = 'ws-theme-vars';
    s.textContent = `
        :root {
            --ws-panel:#ffffff; --ws-panel2:#f9f9f9; --ws-panel3:#ffffff;
            --ws-text:#4a4a4a; --ws-text2:#999999; --ws-border:#e8e8e8;
            --ws-radius:12px;
            --ws-hl-color: rgba(177,224,179,0.9);
            --ws-hl-cur-bg: rgba(0,0,0,0.75); --ws-hl-cur-color: #ffffff;
            --ws-pin-color: #e65751;
            --ws-delete-overlay: rgba(255,120,120,0.18);
            /* 드래그 필(검색 결과 위 뜨는 아이콘 묶음) 클릭 지점 대비 오프셋 — 커스텀 CSS로 조절 가능 */
            --ws-pill-offset-x: 20px; --ws-pill-offset-y: 70px;
        }
        .ws-btn { padding:5px 12px; border-radius:8px; border:1px solid var(--ws-border);
            background:#f4f4f4; color:var(--ws-text); cursor:pointer; font-size:13px;
            font-family:inherit; font-weight:500; transition:all 0.15s;
            box-shadow:0 1px 2px rgba(0,0,0,0.02); white-space:nowrap; flex-shrink:0; }
        .ws-btn:hover  { background:#ebebeb; border-color:#dcdcdc; }
        .ws-btn:active { background:#e0e0e0; transform:translateY(1px); box-shadow:none; }
        .ws-btn-accent { background:#ffffff; font-weight:600; border:1px solid #d0d0d0; }
        .ws-btn-accent:hover { background:#f0f0f0; }
        .ws-input { width:100%; box-sizing:border-box; padding:8px 12px; border-radius:8px;
            border:1px solid var(--ws-border); background:#ffffff; color:var(--ws-text);
            font-size:13px; font-family:inherit; outline:none; transition:border-color 0.15s;
            box-shadow:inset 0 1px 2px rgba(0,0,0,0.01); }
        .ws-input:focus { border-color:#bbbbbb; }
        .ws-input::placeholder { color:#cccccc; }
        .ws-range-input { color:#888888; }
        .ws-range-input::placeholder { color:#cccccc; }
        .ws-panel-body::-webkit-scrollbar, .ws-thin-scroll::-webkit-scrollbar { width:5px; }
        .ws-panel-body::-webkit-scrollbar-track, .ws-thin-scroll::-webkit-scrollbar-track { background:transparent; }
        .ws-panel-body::-webkit-scrollbar-thumb, .ws-thin-scroll::-webkit-scrollbar-thumb {
            background-color: rgba(120,120,120,0.35);
            border-radius: 999px;
        }
        .ws-panel-body, .ws-thin-scroll { scrollbar-width: thin; scrollbar-color: rgba(120,120,120,0.35) transparent; }
        /* 리스트 아이템의 호버/선택 박스가 스크롤바와 애매하게 겹치지 않도록 —
           오른쪽에 스크롤바 너비보다 넉넉한 여백을 둬서 완전히 분리시킴 */
        .ws-thin-scroll { padding-right: 10px; }
        .ws-result-item { padding:6px 10px; border-radius:8px; cursor:pointer; margin-bottom:6px;
            border:1px solid transparent; background:#ffffff; color:var(--ws-text);
            transition:all 0.15s; font-size:12px; line-height:1.4; }
        @media (hover: hover) {
            .ws-result-item:hover { background:var(--ws-panel2); border-color:var(--ws-border); }
        }
        .ws-result-item.active { background:#f0f0f0; border-color:#dddddd; font-weight:500; }
        .ws-label { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:12px; color:var(--ws-text); }
        input[type=checkbox].ws-check { width:14px; height:14px; }

        /* ── 검색 하이라이트 CSS ─────────────────────────────────────────── */
        #chat.ws-hl-active {
            position: relative !important;
            z-index: 999991 !important;
            background: transparent !important;
        }
        #chat .mes_text mark[data-ws-g] {
            /* 전체 검색결과 하이라이트 색 — 에딧모드에서 변경 가능 */
            background: var(--ws-hl-color) !important;
            color: inherit !important;
            padding: 1px 1px !important;
            cursor: pointer;
            -webkit-tap-highlight-color: transparent;
        }
        #chat .mes_text mark[data-ws-g].ws-hl-cur {
            /* 포커스된 검색결과 하이라이트 색 — --ws-hl-cur-bg / --ws-hl-cur-color로 커스텀 CSS에서 조절 가능 */
            background: var(--ws-hl-cur-bg) !important;
            color: var(--ws-hl-cur-color) !important;
            font-weight: bold !important;
            padding: 0.5px 1px !important;
        }
        /* ST 기본 메시지 삭제 모드 — 선택된 메시지가 진한 빨강으로 덮여 글씨가 안 보이던 것을
           연한 톤으로 낮춰서 내용을 보면서 삭제 대상을 고를 수 있게 함.
           "향상된 메시지 삭제" 토글과 같이 묶임 — 꺼져있으면 ST 기본 진한 빨강 그대로.
           색은 --ws-delete-overlay로 커스텀 CSS에서 조절 가능 */
        body.ws-soft-delete-color #chat .mes.selected,
        body.ws-soft-delete-color #chat .mes.last_mes.selected {
            background: var(--ws-delete-overlay) !important;
        }
        /* 삭제모드에서 메시지를 빠르게 연속으로 탭할 때(여러 개 고를 때) iOS 사파리가
           "더블탭=확대" 제스처로 오인해서 화면이 확대돼버리는 걸 방지 */
        body.ws-soft-delete-color #chat .mes {
            touch-action: manipulation;
        }

        /* ── 드래그 필(검색/수정 아이콘 묶음) ────────────────────────────────
           일반 클래스 선택자라 사용자 커스텀 CSS로 위치 오프셋(위 --ws-pill-offset-*),
           크기, 색상 모두 자유롭게 덮어쓸 수 있음(!important 안 씀). */
        .ws-drag-pill {
            position: fixed;
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 20px;
            user-select: none;
            color: var(--ws-text);
            font-size: 14px;
            padding: 4px 2px;
            white-space: nowrap;
        }
        .ws-drag-pill-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }
        .ws-drag-pill-icon i {
            font-size: 12px;
        }

        /* ── 삭제모드 "일괄 선택"/"전체 해제" 버튼 — ST 자체 버튼 옆에 끼워넣는 것이라
           우리 패널의 파스텔 톤 대신 ST 현재 테마 색을 그대로 따라감(어떤 테마여도 안 겉돎).
           재봉/단추 느낌으로 얇은 실선 바깥 테두리 + 그보다 더 얇은 점선 안쪽 테두리 이중 구성.
           높이/글자크기는 JS에서 ST 버튼을 실측해 맞춤(테마마다 실제 값이 달라서). */
        .ws-stitch-btn {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0 12px;
            margin-left: 8px;
            box-sizing: border-box;
            /* 글자수가 짧아도(예: "ST") 너비가 확 줄지 않게 최소 너비를 폰트 크기 비례로 고정 */
            min-width: 2.8em;
            background: transparent;
            border: 1px solid var(--SmartThemeBorderColor, var(--ws-border));
            border-radius: 10px;
            color: var(--SmartThemeBodyColor, var(--ws-text));
            font-size: inherit;
            font-family: inherit;
            cursor: pointer;
            vertical-align: middle;
            user-select: none;
        }
        /* 좁은 화면에서는 버튼 텍스트가 짧아졌으니(ST/해제) 안쪽 여백도 같이 줄여서
           4개가 한 줄에 여유 있게 들어가도록 컴팩트하게 */
        @media (max-width: 480px) {
            .ws-stitch-btn {
                padding: 0 8px;
                min-width: 2.4em;
            }
        }
        .ws-stitch-btn::before {
            content: '';
            position: absolute;
            inset: 3px;
            border: 1px dashed var(--SmartThemeBorderColor, var(--ws-border));
            border-radius: 7px;
            pointer-events: none;
            opacity: 0.6;
        }
        .ws-stitch-btn:active { opacity: 0.7; }
        /* ST 자체 버튼(취소 등)이 눌린/선택된 상태를 표시할 때 실제로 쓰는 변수를 그대로 사용 —
           단순 검정 오버레이가 아니라 테마의 톤(색+명암)이 같이 반영되는 변수라 더 정확하게 맞음.
           점선 테두리 색은 안 건드림(그대로 유지). */
        .ws-stitch-btn.armed {
            background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.08));
            filter: brightness(0.96);
        }

        /* ── 팝업 텍스트박스(CSS/캐릭터 설명/첫 메시지) 찾기+바꾸기 ──────────────────────
           textarea는 내부에 <mark>를 못 넣으므로, 위에 겹치는 투명 오버레이(color:transparent)에
           매치 부분만 <mark>로 감싸서 밑줄만 보이게 함(배경/글자는 그대로 투명).
           border-bottom 대신 text-decoration을 써서 글자 베이스라인에 더 밀착되게 함.
           포커스된(현재) 매치는 점선→실선으로만 바꿔서 구분. */
        .ws-textbox-overlay mark {
            background: transparent !important;
            color: transparent !important;
            padding: 0 !important;
            text-decoration-line: underline;
            text-decoration-style: dotted;
            text-decoration-color: var(--ws-pin-color);
            text-decoration-thickness: 2px;
            text-underline-offset: 2.5px;
            text-decoration-skip-ink: none;
            pointer-events: auto;
            cursor: pointer;
        }
        .ws-textbox-overlay mark.ws-tb-cur {
            text-decoration-style: solid;
        }
        /* 텍스트박스 옆에 심는 돋보기 버튼 — 사용자 정의 CSS(-css)와 캐릭터 설명/첫 메시지
           (-char) 두 종류로 클래스를 나눠서 각각 크기를 따로 조절할 수 있게 함.
           기기/테마마다 옆 버튼(외부 미디어 등) 크기가 크게 달라서, 실측 대신 여기 두 값을
           직접 취향껏 조절하는 게 가장 예측 가능함(커스텀 CSS에서 이 규칙을 덮어쓰면 됨). */
        .ws-tb-search-btn-css.ws-stitch-btn {
            min-width: 0;
            padding: 3px 6px;
            margin-left: 0;
        }
        .ws-tb-search-btn-css.ws-stitch-btn i {
            font-size: 9px;
        }
        .ws-tb-search-btn-char.ws-stitch-btn {
            min-width: 0;
            padding: 5px 9px;
            margin-left: 0;
        }
        .ws-tb-search-btn-char.ws-stitch-btn i {
            font-size: 11px;
        }
    `;
    document.head.appendChild(s);
}

(async () => {
    injectThemeCSS();
    applyWsHlColor();
    applyWsDeleteColor();
    initMoveSnapshotClearing();

    registerBasicCommands();
    registerFindChangeCommands();
    initDragFeatures();
    initTextboxSearch();
})();
