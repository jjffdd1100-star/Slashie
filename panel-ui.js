// ─── panel-ui.js ────────────────────────────────────────────────────────────
// 드래그 가능한 패널, 버튼, 입력창 등 여러 기능이 공유하는 UI 빌더.

export function makeDraggable(panel, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', e => {
        const r = panel.getBoundingClientRect();
        drag = { sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
        panel.style.left = `${r.left}px`; panel.style.top = `${r.top}px`;
        handle.style.cursor = 'grabbing'; handle.setPointerCapture(e.pointerId); e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
        if (!drag) return;
        panel.style.left = `${drag.ol + e.clientX - drag.sx}px`;
        panel.style.top  = `${drag.ot + e.clientY - drag.sy}px`;
    });
    handle.addEventListener('pointerup',     () => { drag = null; handle.style.cursor = 'grab'; });
    handle.addEventListener('pointercancel', () => { drag = null; handle.style.cursor = 'grab'; });
}

export function createPanel(id, posCenter = null, onCloseX = null) {
    document.getElementById(id)?.remove();
    const panel = document.createElement('div'); panel.id = id;
    panel.style.cssText = `position:fixed;top:0;left:0;width:min(400px,92vw);max-height:88vh;
        display:flex;flex-direction:column;background:var(--ws-panel);color:var(--ws-text);
        border:1px solid var(--ws-border);border-radius:var(--ws-radius);overflow:hidden;
        z-index:9999999!important;box-shadow:0 4px 16px rgba(0,0,0,0.06),0 8px 32px rgba(0,0,0,0.04);
        font-size:13px;font-family:inherit;user-select:none;opacity:0;`;
    const handle = document.createElement('div');
    handle.style.cssText = `padding:8px 8px 8px 14px;background:var(--ws-panel3);cursor:grab;
        display:flex;align-items:center;justify-content:flex-end;touch-action:none;`;
    panel.appendChild(handle);
    // 우상단 작은 닫기(X) 버튼 — /edit-mode와 동일한 크기/스타일
    const closeXBtn = document.createElement('button'); closeXBtn.textContent = '✕';
    closeXBtn.style.cssText = `background:transparent;border:none;color:var(--ws-text2);
        font-size:13px;font-family:inherit;cursor:pointer;width:22px;height:22px;
        display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;flex-shrink:0;`;
    closeXBtn.addEventListener('pointerenter', () => { closeXBtn.style.background = 'rgba(0,0,0,0.05)'; });
    closeXBtn.addEventListener('pointerleave', () => { closeXBtn.style.background = 'transparent'; });
    closeXBtn.addEventListener('pointerdown', e => e.stopPropagation()); // 드래그 시작 안 되게
    closeXBtn.addEventListener('click', e => { e.stopPropagation(); (onCloseX || (() => closePanel(id)))(); });
    handle.appendChild(closeXBtn);
    const body = document.createElement('div');
    body.className = 'ws-panel-body'; body.style.cssText = 'padding:4px 16px 16px;overflow-y:auto;flex:1;';
    panel.appendChild(body);
    document.body.appendChild(panel);

    // ST의 드로어/오버레이(설정창, 캐릭터 시트 등)는 "바깥 클릭 시 닫기"를 document 레벨
    // 리스너로 구현해둔 것으로 보임 — 우리 패널은 그 드로어 DOM 밖(body 직속)에 붙기 때문에
    // 패널 안을 클릭/터치해도 "바깥 클릭"으로 오인되어 드로어 전체가 닫혀버리는 문제가 있었음.
    // 패널 내부에서 발생한 이벤트는 여기서 막아서 document까지 아예 올라가지 않게 함.
    ['pointerdown', 'mousedown', 'click', 'touchstart'].forEach(evt => {
        panel.addEventListener(evt, e => e.stopPropagation());
    });

    requestAnimationFrame(() => requestAnimationFrame(() => {
        const pw = panel.offsetWidth, ph = panel.offsetHeight;
        let left, top;
        if (posCenter) {
            left = posCenter.cx - pw / 2;
            top  = posCenter.cy - ph / 2;
        } else {
            left = (window.innerWidth - pw) / 2;
            top  = (window.innerHeight - ph) / 2 - 25;
        }
        left = Math.max(0, Math.min(left, window.innerWidth - pw));
        top  = Math.max(10, Math.min(top, window.innerHeight - ph - 10));
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top  = `${Math.round(top)}px`;
        panel.style.opacity = '1';
        panel._wsPositioned = true;
    }));
    makeDraggable(panel, handle);
    return panel;
}

export const centerOf = el => { const r = el.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };

export function keepCenter(panel, prevCenter) {
    if (!prevCenter) return;
    requestAnimationFrame(() => {
        const pw = panel.offsetWidth, ph = panel.offsetHeight;
        let left = prevCenter.cx - pw / 2, top = prevCenter.cy - ph / 2;
        left = Math.max(0, Math.min(left, window.innerWidth - pw));
        top  = Math.max(10, Math.min(top, window.innerHeight - ph - 10));
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top  = `${Math.round(top)}px`;
    });
}

export const getPanelBody = p => p.querySelector('.ws-panel-body');

export function btn(label, onClick, extra = '') {
    const b = document.createElement('button'); b.textContent = label;
    b.className = 'ws-btn' + (extra ? ' ' + extra : ''); b.addEventListener('click', onClick); return b;
}

export function inputBox(ph) {
    const i = document.createElement('input'); i.type = 'text'; i.placeholder = ph;
    // iOS 자동교정/자동완성이 포커스를 잃을 때 앞뒤 공백을 임의로 지우는 걸 방지
    i.autocomplete = 'off'; i.autocorrect = 'off'; i.autocapitalize = 'off'; i.spellcheck = false;
    i.className = 'ws-input'; i.style.marginBottom = '10px'; return i;
}

export function searchOptions() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-bottom:10px;';
    function makeChk(label) {
        const lbl = document.createElement('label'); lbl.className = 'ws-label';
        const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check';
        lbl.appendChild(chk); lbl.appendChild(document.createTextNode(label)); wrap.appendChild(lbl); return chk;
    }
    // 2줄 배치: 대소문자 구분 | 띄어쓰기 무시
    //         온전한 단어   | 태그 무시
    const caseChk = makeChk('대소문자 구분'), spaceChk = makeChk('띄어쓰기 무시');
    const wordChk = makeChk('온전한 단어'), tagChk = makeChk('태그 무시');
    return {
        el: wrap,
        getCaseSensitive: () => caseChk.checked,
        getIgnoreSpace: () => spaceChk.checked,
        getWholeWord: () => wordChk.checked,
        getIgnoreTags: () => tagChk.checked,
    };
}

export const closePanel = id => document.getElementById(id)?.remove();

export function makeFollowChk(getVal, setVal) {
    const lbl = document.createElement('label'); lbl.className = 'ws-label';
    lbl.style.cssText = 'font-size:11px;color:var(--ws-text2);white-space:nowrap;flex-shrink:0;gap:4px;';
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check'; chk.checked = getVal();
    chk.addEventListener('change', () => setVal(chk.checked));
    lbl.appendChild(chk); lbl.appendChild(document.createTextNode('스크롤 따라가기')); return lbl;
}

export function renderList(fb, items, onBack) {
    Object.assign(fb.style, { display:'flex', flexDirection:'column', padding:'4px 16px 0', overflow:'hidden', flex:'none', height:'auto', maxHeight:'320px' });
    fb.innerHTML = '';
    const scroll = document.createElement('div'); scroll.className = 'ws-thin-scroll'; scroll.style.cssText = 'flex:1;overflow-y:auto;min-height:0;';
    items.forEach(item => scroll.appendChild(item)); fb.appendChild(scroll);
    if (onBack) {
        const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:flex-end;flex-shrink:0;padding:10px 0 12px;margin-top:4px;';
        row.appendChild(btn('돌아가기', onBack));
        fb.appendChild(row);
    }
}
