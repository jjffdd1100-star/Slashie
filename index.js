// ─────────────────────────────────────────────────────────────────────────
// 참고 및 출처
// - /move, /goto, /message-button 기능 일부는 SillyTavern-LALib(@LenAnderson) 확장 프로그램의
//   /message-move 로직(DOM 클릭 방식)을 참고했습니다.
//   https://github.com/LenAnderson/SillyTavern-LALib
// - /find, /change, 빠른 수정(드래그 필) 기능에 쓰인 텍스트 선택 하이라이팅은
//   bookmark(@ring***) 확장 프로그램에서 영감을 받았습니다.
//
// Credits
// - Part of the /move, /goto, and /message-button logic (DOM-click based) was adapted
//   from the /message-move command of the SillyTavern-LALib extension (@LenAnderson).
//   https://github.com/LenAnderson/SillyTavern-LALib
// - The text-selection highlighting used in /find, /change, and the quick-replace
//   (drag pill) feature was inspired by the bookmark extension (@ring***).
// ─────────────────────────────────────────────────────────────────────────
(async () => {
    const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
    const { SlashCommand } = await import('/scripts/slash-commands/SlashCommand.js');
    const { ARGUMENT_TYPE, SlashCommandArgument } = await import('/scripts/slash-commands/SlashCommandArgument.js');

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function parseRange(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        const str = String(raw).trim();
        const single = str.match(/^(\d+)$/);
        if (single) return [parseInt(single[1], 10)];
        const range = str.match(/^(\d+)-(\d+)$/);
        if (range) {
            const s = parseInt(range[1], 10), e = parseInt(range[2], 10);
            if (s > e) return null;
            return Array.from({ length: e - s + 1 }, (_, i) => s + i);
        }
        return null;
    }

    // /change '범위 지정' 입력 전용 — 콤마로 나눈 각 조각이 단일 숫자("5") 또는 범위("2-8")면 되고,
    // 섞어서 "0,2-8,11" 처럼 써도 됨. 조각 하나라도 형식이 안 맞으면 전체 무효(null)
    function parseChangeRangeInput(raw) {
        const str = String(raw ?? '').trim();
        if (!str) return null;
        const parts = str.split(',').map(p => p.trim());
        if (!parts.length) return null;
        const result = [];
        for (const p of parts) {
            if (/^\d+$/.test(p)) { result.push(parseInt(p, 10)); continue; }
            const m = p.match(/^(\d+)-(\d+)$/);
            if (!m) return null;
            const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
            if (s > e) return null;
            for (let i = s; i <= e; i++) result.push(i);
        }
        return result;
    }

    let _scrollObserver = null, _scrollObserverTimeout = null, _scrollIntoViewTimeout = null;

    function scrollToIndex(idx) {
        if (_scrollObserver)        { _scrollObserver.disconnect();           _scrollObserver = null; }
        if (_scrollObserverTimeout) { clearTimeout(_scrollObserverTimeout);   _scrollObserverTimeout = null; }
        if (_scrollIntoViewTimeout) { clearTimeout(_scrollIntoViewTimeout);   _scrollIntoViewTimeout = null; }
        const el = document.querySelector(`[mesid="${idx}"]`);
        if (el) { _scrollIntoViewTimeout = setTimeout(() => el.scrollIntoView({ block: 'start' }), 400); return; }
        _scrollObserver = new MutationObserver(() => {
            const found = document.querySelector(`[mesid="${idx}"]`);
            if (!found) return;
            _scrollObserver.disconnect(); _scrollObserver = null;
            clearTimeout(_scrollObserverTimeout); _scrollObserverTimeout = null;
            _scrollIntoViewTimeout = setTimeout(() => found.scrollIntoView({ block: 'start' }), 400);
        });
        const chatEl = document.getElementById('chat');
        if (chatEl) _scrollObserver.observe(chatEl, { childList: true, subtree: true });
        _scrollObserverTimeout = setTimeout(() => {
            if (_scrollObserver) { _scrollObserver.disconnect(); _scrollObserver = null; }
            _scrollObserverTimeout = null;
        }, 3000);
    }

    function loadAndScrollTo(idx) {
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

    function stripText(html) {
        // <!--주석--> 은 별도로 지울 필요 없음 — DOM Comment 노드는 textContent에 애초에 포함 안 됨(스펙)
        const c = html.replace(/<style(\s[^>]*)?>[\s\S]*?<\/style>/gi, '');
        return new DOMParser().parseFromString(c, 'text/html').body.textContent || '';
    }
    function escapeHTML(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function expandDetails(html) {
        const openRe = /<details\b[^>]*>/gi, closeRe = /<\/details>/gi;
        const tags = []; let m;
        openRe.lastIndex = 0; while ((m = openRe.exec(html))) tags.push({ type:'open',  start:m.index, end:m.index+m[0].length });
        closeRe.lastIndex = 0; while ((m = closeRe.exec(html))) tags.push({ type:'close', start:m.index, end:m.index+m[0].length });
        tags.sort((a,b) => a.start - b.start);
        let depth = 0, outerOpen = null; const pairs = [];
        for (const t of tags) {
            if (t.type === 'open') { if (depth === 0) outerOpen = t; depth++; }
            else { if (depth === 0) continue; depth--; if (depth === 0 && outerOpen) { pairs.push({ open:outerOpen, close:t }); outerOpen = null; } }
        }
        if (!pairs.length) return html.trim();
        let result = html;
        for (let i = pairs.length - 1; i >= 0; i--) {
            const { open, close } = pairs[i];
            const inner = result.slice(open.end, close.start).replace(/^\s*<summary>[\s\S]*?<\/summary>/i, '');
            result = result.slice(0, open.start) + inner.trim() + result.slice(close.end);
        }
        return result.trim();
    }

    const getChat      = () => SillyTavern.getContext().chat;
    const saveAndReload = async () => { const ctx = SillyTavern.getContext(); await ctx.saveChat(); await ctx.reloadCurrentChat(); };

    async function editMessage(idx, newMes) {
        const ctx = SillyTavern.getContext(), chat = getChat();
        chat[idx].mes = newMes;
        const sid = chat[idx].swipe_id ?? 0;
        if (chat[idx].swipes && sid < chat[idx].swipes.length) chat[idx].swipes[sid] = newMes;
        const el = document.querySelector(`#chat [mesid="${idx}"] .mes_text`);
        if (el && ctx.messageFormatting)
            el.innerHTML = ctx.messageFormatting(newMes, chat[idx].name, chat[idx].is_system, chat[idx].is_user, idx);
        ctx.saveChatDebounced?.();
    }

    const SUMMARY = '꒰⍤꒱ ༘* Collapsed';
    window._wsMoveSnapshot = window._wsMoveSnapshot ?? null;

    const _ctx0 = SillyTavern.getContext();
    const _evtR = _ctx0.event_types?.MESSAGE_RECEIVED ?? 'message_received';
    const _evtS = _ctx0.event_types?.MESSAGE_SENT     ?? 'message_sent';
    if (window._wsClearSnapshot) {
        _ctx0.eventSource?.removeListener?.(_evtR, window._wsClearSnapshot);
        _ctx0.eventSource?.removeListener?.(_evtS, window._wsClearSnapshot);
    }
    window._wsClearSnapshot = () => { window._wsMoveSnapshot = null; };
    _ctx0.eventSource?.on?.(_evtR, window._wsClearSnapshot);
    _ctx0.eventSource?.on?.(_evtS, window._wsClearSnapshot);

    // ─── Panel CSS ────────────────────────────────────────────────────────────
    if (!document.getElementById('ws-theme-vars')) {
        const s = document.createElement('style'); s.id = 'ws-theme-vars';
        s.textContent = `
            :root {
                --ws-panel:#ffffff; --ws-panel2:#f9f9f9; --ws-panel3:#ffffff;
                --ws-text:#4a4a4a; --ws-text2:#999999; --ws-border:#e8e8e8;
                --ws-radius:12px; --ws-check-color:#ffc8d8;
                --ws-hl-color: rgba(177,224,179,0.9);
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
            .ws-panel-body::-webkit-scrollbar { width:5px; }
            .ws-panel-body::-webkit-scrollbar-track { background:transparent; }
            .ws-panel-body::-webkit-scrollbar-thumb { background:#dddddd; border-radius:3px; }
            .ws-result-item { padding:6px 10px; border-radius:8px; cursor:pointer; margin-bottom:6px;
                border:1px solid transparent; background:#ffffff; color:var(--ws-text);
                transition:all 0.15s; font-size:12px; line-height:1.4; }
            @media (hover: hover) {
                .ws-result-item:hover { background:var(--ws-panel2); border-color:var(--ws-border); }
            }
            .ws-result-item.active { background:#f0f0f0; border-color:#dddddd; font-weight:500; }
            .ws-label { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:12px; color:var(--ws-text); }
            input[type=checkbox].ws-check { accent-color:var(--ws-check-color)!important; width:14px; height:14px; }

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
            }
            #chat .mes_text mark[data-ws-g].ws-hl-cur {
                /* 포커스된 검색결과 하이라이트 색 */
                background: rgba(0,0,0,0.75) !important;
                color: #ffffff !important;
                font-weight: bold !important;
                padding: 0.5px 1px !important;
            }
            /* ST 기본 메시지 삭제 모드 — 선택된 메시지가 진한 빨강으로 덮여 글씨가 안 보이던 것을
               연한 톤으로 낮춰서 내용을 보면서 삭제 대상을 고를 수 있게 함 */
            #chat .mes.selected, #chat .mes.last_mes.selected {
                background: rgba(255,120,120,0.18) !important;
            }
        `;
        document.head.appendChild(s);
    }

    // ─── 에딧모드 설정 (localStorage에 저장, 기기별) ─────────────────────────────
    const WS_SETTINGS_KEY = 'ws-edit-settings';
    const WS_DEFAULT_HL_RGB = '#b1e0b3', WS_DEFAULT_HL_ALPHA = 90; // 0~100
    function loadWsSettings() {
        const fallback = { moveDisabled: false, pillDisabled: false, hlEnabled: false, hlRgb: WS_DEFAULT_HL_RGB, hlAlpha: WS_DEFAULT_HL_ALPHA };
        try {
            const raw = localStorage.getItem(WS_SETTINGS_KEY);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return {
                moveDisabled: !!parsed.moveDisabled,
                pillDisabled: !!parsed.pillDisabled,
                hlEnabled: !!parsed.hlEnabled,
                hlRgb: typeof parsed.hlRgb === 'string' ? parsed.hlRgb : WS_DEFAULT_HL_RGB,
                hlAlpha: typeof parsed.hlAlpha === 'number' ? parsed.hlAlpha : WS_DEFAULT_HL_ALPHA,
            };
        } catch { return fallback; }
    }
    let wsSettings = loadWsSettings();
    function saveWsSettings() {
        try { localStorage.setItem(WS_SETTINGS_KEY, JSON.stringify(wsSettings)); } catch {}
    }
    // hex(#rrggbb) + alpha(0~100) → rgba() 문자열 변환
    function hexAlphaToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
        return `rgba(${r},${g},${b},${(alpha/100).toFixed(2)})`;
    }
    const WS_DEFAULT_HL_COLOR = hexAlphaToRgba(WS_DEFAULT_HL_RGB, WS_DEFAULT_HL_ALPHA); // 기본 초록 — 위 두 상수에서 파생(따로 안 어긋나게)
    function applyWsHlColor() {
        const color = wsSettings.hlEnabled ? hexAlphaToRgba(wsSettings.hlRgb, wsSettings.hlAlpha) : WS_DEFAULT_HL_COLOR;
        document.documentElement.style.setProperty('--ws-hl-color', color);
    }
    applyWsHlColor();

    // ─── Panel helpers ────────────────────────────────────────────────────────
    function createPanel(id, posCenter = null, onCloseX = null) {
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
        return panel;
    }

    const centerOf = el => { const r = el.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };

    function keepCenter(panel, prevCenter) {
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

    const getPanelBody = p => p.querySelector('.ws-panel-body');
    function btn(label, onClick, extra = '') {
        const b = document.createElement('button'); b.textContent = label;
        b.className = 'ws-btn' + (extra ? ' ' + extra : ''); b.addEventListener('click', onClick); return b;
    }
    function inputBox(ph) {
        const i = document.createElement('input'); i.type = 'text'; i.placeholder = ph;
        // iOS 자동교정/자동완성이 포커스를 잃을 때 앞뒤 공백을 임의로 지우는 걸 방지
        i.autocomplete = 'off'; i.autocorrect = 'off'; i.autocapitalize = 'off'; i.spellcheck = false;
        i.className = 'ws-input'; i.style.marginBottom = '10px'; return i;
    }
    function searchOptions() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-bottom:10px;';
        function makeChk(label) {
            const lbl = document.createElement('label'); lbl.className = 'ws-label';
            const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check';
            lbl.appendChild(chk); lbl.appendChild(document.createTextNode(label)); wrap.appendChild(lbl); return chk;
        }
        // 2줄 배치: 대소문자 구분 | 띄어쓰기 무시
        //           온전한 단어   | 태그 무시
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
    const closePanel = id => document.getElementById(id)?.remove();
    function makeFollowChk(getVal, setVal) {
        const lbl = document.createElement('label'); lbl.className = 'ws-label';
        lbl.style.cssText = 'font-size:11px;color:var(--ws-text2);white-space:nowrap;flex-shrink:0;gap:4px;';
        const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check'; chk.checked = getVal();
        chk.addEventListener('change', () => setVal(chk.checked));
        lbl.appendChild(chk); lbl.appendChild(document.createTextNode('스크롤 따라가기')); return lbl;
    }
    function renderList(fb, items, onBack) {
        Object.assign(fb.style, { display:'flex', flexDirection:'column', padding:'4px 16px 0', overflow:'hidden', flex:'none', height:'auto', maxHeight:'320px' });
        fb.innerHTML = '';
        const scroll = document.createElement('div'); scroll.style.cssText = 'flex:1;overflow-y:auto;min-height:0;';
        items.forEach(item => scroll.appendChild(item)); fb.appendChild(scroll);
        if (onBack) {
            const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:flex-end;flex-shrink:0;padding:10px 0 12px;margin-top:4px;';
            row.appendChild(btn('돌아가기', onBack));
            fb.appendChild(row);
        }
    }

    // ─── DOM Highlight ────────────────────────────────────────────────────────
    let _wsHL = null;

    function clearDOMHighlights() {
        _wsHL?.observer?.disconnect();
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
    function safeHighlight(range, mark) {
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

    function applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, currentIdx, wholeWord = false) {
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
        _wsHL = { observer, byMsg, currentIdx };
    }

    function updateCurrentMark(currentIdx) {
        if (_wsHL) _wsHL.currentIdx = currentIdx;
        document.querySelectorAll('#chat .mes_text mark[data-ws-g]').forEach(mark => {
            mark.classList.toggle('ws-hl-cur', parseInt(mark.dataset.wsG) === currentIdx);
        });
    }

    function scrollToMark(currentIdx, msgIdx, follow = false) {
        if (follow) {
            const mark = document.querySelector(`#chat .mes_text mark[data-ws-g="${currentIdx}"]`);
            if (mark) {
                const chatEl = document.getElementById('chat');
                const markTop = mark.getBoundingClientRect().top;
                const chatTop = chatEl.getBoundingClientRect().top;
                chatEl.scrollTop += (markTop - chatTop) - (chatEl.clientHeight * 0.12);
            }
            else loadAndScrollTo(msgIdx);
        } else { loadAndScrollTo(msgIdx); }
    }

    // ─── Slash commands: collapse / expand / up / down / message-button / goto ─
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
        name: 'goto', helpString: 'Scroll to a message by index. Usage: /goto 5',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Message index', typeList:[ARGUMENT_TYPE.NUMBER], isRequired:true })],
        callback: (_a, value) => {
            const idx = parseInt(value, 10); if (isNaN(idx)) return '';
            const chat = getChat();
            if (idx < 0 || idx >= chat.length) { toastr.warning(`0~${chat.length-1} 사이의 숫자를 입력해 주세요.`); return ''; }
            loadAndScrollTo(idx); return '';
        },
    }));

    // ─── /move ────────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'move', helpString: 'Move a message or range to a target index. Usage: /move 2 10 or /move 2-5 10',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Source index or range, then target index', typeList:[ARGUMENT_TYPE.STRING], isRequired:true })],
        callback: async (_a, value) => {
            if (wsSettings.moveDisabled) { toastr.warning('편집 모드에서 /move 를 먼저 활성화해 주세요.', '', { timeOut:4000 }); return ''; }
            const parts = String(value).trim().split(/\s+/);
            if (parts.length !== 2) return '';
            const idxs = parseRange(parts[0]), to = parseInt(parts[1], 10);
            if (!idxs || isNaN(to)) return '';
            if (idxs.includes(to)) { toastr.error('올바르지 않은 요청입니다.', '', { timeOut:3000 }); return ''; }
            const chat = getChat();
            if (idxs.length === 1) {
                const from = idxs[0], clampedTo = Math.min(to, chat.length - 1);
                const ensureLoaded = async (mesid) => new Promise(resolve => {
                    if (document.querySelector(`#chat [mesid="${mesid}"]`)) { resolve(); return; }
                    const lb = document.getElementById('show_more_messages');
                    if (!lb) { resolve(); return; }
                    const obs = new MutationObserver(() => {
                        if (document.querySelector(`#chat [mesid="${mesid}"]`)) { obs.disconnect(); resolve(); }
                        else document.getElementById('show_more_messages')?.click();
                    });
                    obs.observe(document.getElementById('chat'), { childList:true, subtree:true });
                    setTimeout(() => { obs.disconnect(); resolve(); }, 5000);
                    lb.click();
                });
                await ensureLoaded(from);
                const editBtn = document.querySelector(`#chat [mesid="${from}"] .mes_edit`);
                const doneBtn = document.querySelector(`#chat [mesid="${from}"] .mes_edit_done`);
                if (!editBtn || !doneBtn) return '';
                const expectedLen = chat.length; // 반복 클릭 중 메시지 개수가 바뀌면(엉뚱한 버튼을 눌렀다는 신호) 즉시 중단
                editBtn.click(); await new Promise(r => requestAnimationFrame(r));
                if (from < clampedTo) {
                    const mb = document.querySelector(`#chat [mesid="${from}"] .mes_edit_down`);
                    if (!mb) { doneBtn.click(); return ''; }
                    let cur = from;
                    while (cur < clampedTo && cur + 1 < chat.length) {
                        if (!document.querySelector(`#chat [mesid="${cur+1}"]`)) { await ensureLoaded(cur+1); if (!document.querySelector(`#chat [mesid="${cur+1}"]`)) break; }
                        mb.click(); cur++;
                        if (getChat().length !== expectedLen) { toastr.error('예상치 못한 변화가 감지되어 중단했습니다.', '', { timeOut:4000 }); doneBtn.click(); return ''; }
                        if ((cur - from) % 10 === 0) await new Promise(r => setTimeout(r, 0));
                    }
                } else if (from > clampedTo) {
                    const mb = document.querySelector(`#chat [mesid="${from}"] .mes_edit_up`);
                    if (!mb) { doneBtn.click(); return ''; }
                    let cur = from;
                    while (cur > clampedTo && cur > 0) {
                        if (!document.querySelector(`#chat [mesid="${cur-1}"]`)) { await ensureLoaded(cur-1); if (!document.querySelector(`#chat [mesid="${cur-1}"]`)) break; }
                        mb.click(); cur--;
                        if (getChat().length !== expectedLen) { toastr.error('예상치 못한 변화가 감지되어 중단했습니다.', '', { timeOut:4000 }); doneBtn.click(); return ''; }
                        if ((from - cur) % 10 === 0) await new Promise(r => setTimeout(r, 0));
                    }
                }
                doneBtn.click(); await new Promise(r => setTimeout(r, 100)); loadAndScrollTo(clampedTo);
            } else {
                window._wsMoveSnapshot = { chat: structuredClone(chat), from: idxs[0] };
                const set = new Set(idxs), msgs = idxs.map(i => chat[i]);
                const rem = chat.filter((_, i) => !set.has(i));
                const before = idxs.filter(i => i < to).length;
                const adj = Math.max(0, Math.min(to - before, rem.length));
                rem.splice(adj, 0, ...msgs); chat.length = 0; chat.push(...rem);
                await saveAndReload(); loadAndScrollTo(adj);
            }
            return '';
        },
    }));

    // ─── /undo ────────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'undo', helpString: 'Undo the last /move.',
        callback: async () => {
            if (!window._wsMoveSnapshot) { toastr.warning('되돌릴 작업이 없습니다.'); return ''; }
            const chat = getChat(), { chat: saved, from } = window._wsMoveSnapshot;
            chat.length = 0; chat.push(...saved); window._wsMoveSnapshot = null;
            await saveAndReload(); scrollToIndex(from); return '';
        },
    }));

    // ─── /clip ────────────────────────────────────────────────────────────────
    async function copyText(text) {
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
    async function copyFullChat() {
        const chat = getChat(), ctx = SillyTavern.getContext(), lines = [];
        for (const msg of chat) { if (!msg) continue; lines.push(`${msg.name||(msg.is_user?ctx.name1:ctx.name2)}: ${stripText(msg.mes)}`); }
        if (!lines.length) return;
        await copyText(lines.join('\n\n\n'));
    }
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'clip', helpString: 'Copy messages to clipboard. Usage: /clip 2, /clip 2-5, /clip string, or simply /clip',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Message index, range, or literal text. Omit for full chat.', typeList:[ARGUMENT_TYPE.STRING], isRequired:false })],
        callback: async (_a, value) => {
            const trimmed = String(value ?? '').trim();
            if (trimmed && !parseRange(trimmed)) { await copyText(trimmed); return ''; }
            if (!trimmed) { await copyFullChat(); return ''; }
            const chat = getChat(), idxs = parseRange(trimmed);
            if (!idxs) return '';
            const ctx = SillyTavern.getContext(), lines = [];
            for (const idx of idxs) { const msg = chat[idx]; if (!msg) continue; lines.push(`${msg.name||(msg.is_user?ctx.name1:ctx.name2)}: ${stripText(msg.mes)}`); }
            if (!lines.length) return '';
            await copyText(lines.join('\n\n\n')); return '';
        },
    }));

    // ─── /word ────────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'word', helpString: 'Count characters. Usage: /word 2, /word 2-5, /word string, or simply /word',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description:'Message index or range. Omit for full chat.', typeList:[ARGUMENT_TYPE.STRING], isRequired:false })],
        callback: (_a, value) => {
            const trimmed = String(value ?? '').trim();
            let cleaned;
            if (trimmed && !parseRange(trimmed)) { cleaned = stripText(trimmed); }
            else {
                const chat = getChat(), idxs = trimmed ? parseRange(trimmed) : chat.map((_,i) => i);
                if (!idxs) return '';
                cleaned = stripText(idxs.map(i => chat[i]?.mes || '').join('\n'));
            }
            toastr.info(`공백 포함: ${cleaned.length.toLocaleString()}<br>공백 제외: ${cleaned.replace(/\s/g,'').length.toLocaleString()}<br>단어: ${cleaned.trim().split(/\s+/).filter(w=>w.length>0).length.toLocaleString()}`, '', { timeOut:12000, escapeHtml:false });
            return '';
        },
    }));

    // ─── /find + /change shared utilities ─────────────────────────────────────
    function buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord = false, ignoreTags = false) {
        const re_esc = applyWholeWord(applyFiller(escaped, ignoreSpace), wholeWord), all = [];
        chat.forEach((msg, msgIdx) => {
            const searchText = ignoreTags ? maskTags(msg.mes) : msg.mes;
            let re_flags = flags.includes('g') ? flags : flags + 'g';
            if (wholeWord && !re_flags.includes('u')) re_flags += 'u';
            const re = new RegExp(re_esc, re_flags);
            let m, matchIdx = 0;
            while ((m = re.exec(searchText)) !== null) {
                if (m.index === re.lastIndex) { re.lastIndex++; continue; }
                all.push({ msgIdx, matchIdx, charIdx: m.index }); matchIdx++;
            }
        });
        return all;
    }

    // ignoreSpace: 검색어의 띄어쓰기를 무시하고 각 글자 사이에 공백이 있든 없든 매치
    function applyFiller(escaped, ignoreSpace) {
        if (!ignoreSpace) return escaped;
        const stripped = escaped.replace(/ /g, ''); if (!stripped) return escaped;
        const atoms = []; let i = 0;
        while (i < stripped.length) {
            if (stripped[i] === '\\' && i + 1 < stripped.length) { atoms.push(stripped.slice(i, i+2)); i += 2; }
            else { atoms.push(stripped[i]); i++; }
        }
        return atoms.join('\\s*');
    }

    // 태그 무시 — "<"부터 ">"까지(속성값 포함) 전체를 같은 길이의 더미 문자(\u0000)로 치환해서
    // 원본 글자 오프셋은 그대로 유지한 채 검색 대상에서만 제외. 태그 밖 텍스트(예: <span>안녕</span>의 "안녕")는
    // 그대로 검색됨. 길이를 유지하는 이유: 이후 매치 위치를 원본 텍스트에 그대로 잘라붙이기 위함
    function maskTags(raw) {
        return raw.replace(/<[^>]*>/g, m => '\u0000'.repeat(m.length));
    }

    // 단어 일치 — 앞뒤로 글자/숫자/밑줄(한글 포함, \p{L}\p{N}_)이 아닌 경계에서만 매치되도록 감쌈
    // 이 패턴을 쓰려면 정규식에 'u' 플래그가 반드시 있어야 함 (호출부에서 flags 구성 시 함께 추가)
    function applyWholeWord(pattern, wholeWord) {
        if (!wholeWord) return pattern;
        return `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
    }

    // ─── /find ────────────────────────────────────────────────────────────────
    function openFindKeywordPanel() {
        const PANEL_ID = 'ws-find-panel';
        const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
        const input = inputBox('찾을 단어를 입력하세요'); body.appendChild(input);
        const opts = searchOptions(); body.appendChild(opts.el);
        const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
        const doFind = () => {
            const kw = input.value.trim(); if (!kw) return;
            const center = centerOf(panel); closePanel(PANEL_ID);
            runFind(kw, opts.getCaseSensitive(), opts.getIgnoreSpace(), opts.getWholeWord(), opts.getIgnoreTags(), center);
        };
        row.appendChild(btn('찾기', doFind, 'ws-btn-accent'));
        body.appendChild(row); setTimeout(() => input.focus(), 50);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') doFind(); });
    }
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

    function runFind(keyword, caseSensitive, ignoreSpace, wholeWord = false, ignoreTags = false, posCenter = null) {
        const PANEL_ID = 'ws-find-panel', chat = getChat();
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const flags = caseSensitive ? 'g' : 'gi';
        const allMatches = buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord, ignoreTags);
        if (!allMatches.length) { toastr.info('검색 결과가 없습니다.', '', { timeOut:3000 }); return; }

        const matchCountPerMsg = {};
        allMatches.forEach(({ msgIdx }) => { matchCountPerMsg[msgIdx] = (matchCountPerMsg[msgIdx] || 0) + 1; });
        const uniqueIdxs = [...new Set(allMatches.map(m => m.msgIdx))];
        let current = 0, showingList = false, followScroll = true;

        applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, 0, wholeWord);
        const panel = createPanel(PANEL_ID, posCenter, () => { clearDOMHighlights(); closePanel(PANEL_ID); }), fb = getPanelBody(panel);
        const FIND_H = '105px';

        function setFixed() {
            Object.assign(fb.style, { display:'block', flex:'none', height:FIND_H, maxHeight:'', overflowY:'auto', padding:'4px 16px 12px' });
        }

        function navigate(newIdx) {
            const wasMsg = allMatches[current]?.msgIdx ?? -1;
            current = newIdx; updateCurrentMark(current); render();
            const m = allMatches[current];
            if (followScroll) scrollToMark(current, m.msgIdx, true);
            else if (m.msgIdx !== wasMsg) scrollToMark(current, m.msgIdx, false);
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
                    item.addEventListener('click', () => { navigate(allMatches.findIndex(m => m.msgIdx === msgIdx)); showingList = false; render(); });
                    return item;
                });
                renderList(fb, items, () => { showingList = false; render(); });
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
    function openChangeKeywordPanel() {
        const PANEL_ID = 'ws-change-panel';
        const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
        const input = inputBox('찾을 단어를 입력하세요'); body.appendChild(input);
        const opts = searchOptions(); body.appendChild(opts.el);
        const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
        const doChange = () => {
            const kw = input.value.trim(); if (!kw) return;
            const center = centerOf(panel); closePanel(PANEL_ID);
            runChange(kw, opts.getCaseSensitive(), opts.getIgnoreSpace(), opts.getWholeWord(), opts.getIgnoreTags(), center);
        };
        row.appendChild(btn('찾기', doChange, 'ws-btn-accent'));
        body.appendChild(row); setTimeout(() => input.focus(), 50);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') doChange(); });
    }
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

    function runChange(keyword, caseSensitive, ignoreSpace, wholeWord = false, ignoreTags = false, posCenter = null) {
        const PANEL_ID = 'ws-change-panel', chat = getChat();
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re_esc = applyWholeWord(applyFiller(escaped, ignoreSpace), wholeWord);
        const flags = caseSensitive ? 'g' : 'gi';
        let allMatches = buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord, ignoreTags);
        if (!allMatches.length) { toastr.info('검색 결과가 없습니다.', '', { timeOut:3000 }); return; }

        let uniqueIdxs = [...new Set(allMatches.map(m => m.msgIdx))];
        let matchCountPerMsg = {};
        allMatches.forEach(({ msgIdx }) => { matchCountPerMsg[msgIdx] = (matchCountPerMsg[msgIdx] || 0) + 1; });
        let current = 0, mode = 'menu', listReturnMode = 'one', lastReplace = '', lastRangeInput = '', followScroll = true;

        applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, 0, wholeWord);
        const panel = createPanel(PANEL_ID, posCenter, () => { clearDOMHighlights(); SillyTavern.getContext().saveChat?.(); closePanel(PANEL_ID); }), cb = getPanelBody(panel);
        function setFixed() {
            Object.assign(cb.style, { display:'block', flex:'none', height:'', maxHeight:'', overflowY:'visible', padding:'4px 16px 16px' });
        }
        function navigate(newIdx) {
            const wasMsg = allMatches[current]?.msgIdx ?? -1;
            current = newIdx; updateCurrentMark(current); render();
            const m = allMatches[current];
            if (followScroll) scrollToMark(current, m.msgIdx, true);
            else if (m.msgIdx !== wasMsg) scrollToMark(current, m.msgIdx, false);
        }
        function buildReFlags() {
            let f = flags.includes('g') ? flags : flags + 'g';
            if (wholeWord && !f.includes('u')) f += 'u';
            if (!f.includes('d')) f += 'd';
            return f;
        }
        // ignoreTags일 때 검색은 마스킹된 텍스트로 하되(태그 안 텍스트 제외),
        // 실제 치환은 오프셋이 동일한 원본 raw 텍스트를 그대로 잘라붙여서 적용 — 검색/치환 불일치 방지
        async function doReplaceOne(msgIdx, matchIdx, rep) {
            const raw = chat[msgIdx].mes;
            const searchText = ignoreTags ? maskTags(raw) : raw;
            const re = new RegExp(re_esc, buildReFlags());
            const matches = [...searchText.matchAll(re)];
            const m = matches[matchIdx];
            if (!m?.indices) return;
            const [s, e] = m.indices[0];
            await editMessage(msgIdx, raw.slice(0, s) + rep + raw.slice(e));
        }
        async function doReplaceAll(msgIdx, rep) {
            const raw = chat[msgIdx].mes;
            const searchText = ignoreTags ? maskTags(raw) : raw;
            const re = new RegExp(re_esc, buildReFlags());
            const matches = [...searchText.matchAll(re)];
            if (!matches.length) return;
            let result = raw;
            for (let i = matches.length - 1; i >= 0; i--) {
                if (!matches[i].indices) continue;
                const [s, e] = matches[i].indices[0];
                result = result.slice(0, s) + rep + result.slice(e);
            }
            await editMessage(msgIdx, result);
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
                    item.addEventListener('click', () => { navigate(allMatches.findIndex(m => m.msgIdx === msgIdx)); mode = 'one'; render(); });
                    return item;
                });
                renderList(cb, items, () => { mode = listReturnMode; render(); });

            } else if (mode === 'menu') {
                setFixed(); cb.innerHTML = '';
                const title = document.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
                title.innerHTML = `"${escapeHTML(keyword)}" <span style="color:var(--ws-text2);font-size:12px">${allMatches.length}개 발견</span>`;
                if (caseSensitive) { const b=document.createElement('span'); b.style.cssText='font-size:11px;color:var(--ws-text2);font-weight:400;'; b.textContent='대소문자 구분'; title.appendChild(b); }
                if (ignoreSpace)   { const b=document.createElement('span'); b.style.cssText='font-size:11px;color:var(--ws-text2);font-weight:400;'; b.textContent='띄어쓰기 무시'; title.appendChild(b); }
                // 범위 지정 — "3-10"(범위) 또는 "1,3,5"(콤마 목록) 형식으로 특정 메시지 번호만 골라 "모두 바꾸기" 적용
                const rangeWrap = document.createElement('span');
                rangeWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0;';
                const rangeLabel = document.createElement('span');
                rangeLabel.textContent = '범위 지정'; rangeLabel.style.cssText = 'font-size:10px;color:var(--ws-text2);font-weight:400;white-space:nowrap;';
                const rangeInput = document.createElement('input'); rangeInput.type = 'text'; rangeInput.placeholder = '0-50';
                rangeInput.className = 'ws-range-input';
                rangeInput.value = lastRangeInput;
                rangeInput.autocomplete = 'off'; rangeInput.autocorrect = 'off'; rangeInput.autocapitalize = 'off'; rangeInput.spellcheck = false;
                rangeInput.style.cssText = 'width:42px;padding:2px 6px;font-size:11px;font-weight:400;border:1px solid var(--ws-border);border-radius:6px;background:#fff;outline:none;';
                rangeInput.addEventListener('input', () => { lastRangeInput = rangeInput.value; });
                rangeWrap.appendChild(rangeLabel); rangeWrap.appendChild(rangeInput);
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
                        if (!parsed) { toastr.error('입력 형식을 확인해 주세요.', '', { timeOut:4000 }); return; }
                        const parsedSet = new Set(parsed);
                        targetIdxs = uniqueIdxs.filter(idx => parsedSet.has(idx));
                        if (!targetIdxs.length) { toastr.info('입력한 범위에 수정할 메시지가 없습니다.', '', { timeOut:3000 }); return; }
                    }
                    for (const msgIdx of targetIdxs) await doReplaceAll(msgIdx, repInput.value);
                    await SillyTavern.getContext().saveChat?.();
                    toastr.success(`${targetIdxs.length}개의 메시지를 수정했습니다.`, '', { timeOut:3000 });
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
                    allMatches = buildAllMatches(chat, escaped, flags, ignoreSpace, wholeWord, ignoreTags);
                    uniqueIdxs = [...new Set(allMatches.map(am => am.msgIdx))];
                    matchCountPerMsg = {}; allMatches.forEach(({ msgIdx }) => { matchCountPerMsg[msgIdx] = (matchCountPerMsg[msgIdx]||0)+1; });
                    if (!allMatches.length) { await SillyTavern.getContext().saveChat?.(); toastr.success('단어 수정이 완료되었습니다.', '', { timeOut:3000 }); clearDOMHighlights(); closePanel(PANEL_ID); return; }
                    if (current >= allMatches.length) current = allMatches.length - 1;
                    applyDOMHighlights(allMatches, escaped, flags, ignoreSpace, current, wholeWord);
                    render(); scrollToMark(current, allMatches[current].msgIdx, followScroll);
                }, 'ws-btn-accent'));
                row.appendChild(left); row.appendChild(right); cb.appendChild(row);
            }
            keepCenter(panel, prevCenter);
        }
        render(); scrollToMark(0, allMatches[0].msgIdx, followScroll);
    }

    // ─── 드래그-빠른치환 — 드래그한 바로 그 위치 하나만 정확히 치환 ────────
    // 렌더링된 화면 텍스트로 "몇 번째 등장인지" 세는 방식은 메시지 안에 마크다운 서식
    // (*이탤릭*, **볼드** 등)이 섞여있으면 원본 텍스트와 글자 수/순서가 어긋나서 엉뚱한
    // 자리를 잘라내는 문제가 있었음 → 대신 선택한 텍스트 앞뒤 문맥(context)을 함께 찾아서
    // 원본 텍스트에서 "유일하게" 위치를 특정하는 방식으로 교체 (등장 횟수 세기 자체를 안 함)
    const ESC_SPECIAL = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    // 매치되는 지점을 찾음. 'd' 플래그로 캡처 그룹의 정확한 시작/끝 오프셋을 직접 얻음
    function locateRawOffset(msgIdx, beforeCtx, target, afterCtx) {
        const raw = getChat()[msgIdx]?.mes;
        if (raw === undefined) return null;
        const MD_GAP = '[*_~`]{0,10}'; // 무한 반복(*) 대신 최대 10개로 제한 — 백트래킹 폭주(ReDoS) 방지
        const escTarget = ESC_SPECIAL(target);
        for (const len of [60, 30, 15, 8, 4, 2, 1, 0]) {
            const b = beforeCtx.slice(Math.max(0, beforeCtx.length - len));
            const a = afterCtx.slice(0, len);
            const pattern = ESC_SPECIAL(b) + MD_GAP + '(' + escTarget + ')' + MD_GAP + ESC_SPECIAL(a);
            let re;
            try { re = new RegExp(pattern, 'gd'); } catch { continue; }
            const matches = [...raw.matchAll(re)];
            if (matches.length === 1 && matches[0].indices?.[1]) {
                const [s, e] = matches[0].indices[1];
                return { start: s, end: e };
            }
        }
        return null;
    }

    async function replaceAtOffset(msgIdx, start, end, rep) {
        const chat = getChat();
        const mes = chat[msgIdx].mes;
        await editMessage(msgIdx, mes.slice(0, start) + rep + mes.slice(end));
        await SillyTavern.getContext().saveChat?.();
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

    // 삽입 지점 앞/뒤 공백 여부를 확인해서, 없을 때만 한 칸 채워줌 — 문장 맨 끝/맨 앞이면
    // 그쪽엔 채울 대상이 없으므로 반대쪽만 확인
    function smartInsertSpacing(fullText, insertPos, insertedText) {
        const before = fullText[insertPos - 1], after = fullText[insertPos];
        const left  = (before !== undefined && !/\s/.test(before)) ? ' ' : '';
        const right = (after  !== undefined && !/\s/.test(after))  ? ' ' : '';
        return fullText.slice(0, insertPos) + left + insertedText + right + fullText.slice(insertPos);
    }

    async function insertAtOffset(msgIdx, pos, text) {
        const chat = getChat();
        const raw = chat[msgIdx].mes;
        await editMessage(msgIdx, smartInsertSpacing(raw, pos, text));
        await SillyTavern.getContext().saveChat?.();
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
            await replaceAtOffset(msgIdx, loc.start, loc.end, rep);
        };
        // ◀/▶: 드래그한 텍스트는 그대로 두고, 그 자리 앞(◀) 또는 뒤(▶)에 입력값만 끼워넣음(치환 아님)
        const insertLeft = document.createElement('div'); insertLeft.style.cssText = 'display:flex;gap:6px;';
        const doInsert = async (before) => {
            const val = input.value; if (!val) return;
            closePanel(PANEL_ID); clearQuickReplaceHighlight();
            const loc = locateRawOffset(msgIdx, beforeCtx, selText, afterCtx);
            if (!loc) { toastr.error('원문에서 위치를 찾지 못했습니다.', '', { timeOut:3000 }); return; }
            await insertAtOffset(msgIdx, before ? loc.start : loc.end, val);
        };
        function iconBtn(faClass, onClick) {
            const b = document.createElement('button'); b.className = 'ws-btn ws-btn-accent';
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

    // ─── /hidden ──────────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hidden', helpString: 'List all hidden (is_system) messages.',
        callback: () => {
            const PANEL_ID = 'ws-hidden-panel', chat = getChat();
            const hiddenIdxs = chat.map((msg, idx) => msg.is_system ? idx : null).filter(idx => idx !== null);
            if (!hiddenIdxs.length) { toastr.info('숨겨진 메세지가 없습니다.', '', { timeOut:5000 }); return ''; }
            const panel = createPanel(PANEL_ID), body = getPanelBody(panel);
            const title = document.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:10px;';
            title.textContent = `숨김 메시지 ${hiddenIdxs.length}개`; body.appendChild(title);
            const list = document.createElement('div'); list.style.cssText = 'max-height:400px;overflow-y:auto;margin-bottom:8px;';
            hiddenIdxs.forEach(idx => {
                const plain = stripText(chat[idx].mes);
                const item = document.createElement('div'); item.className = 'ws-result-item';
                item.style.cssText = 'display:flex;align-items:center;gap:6px;';
                const num = document.createElement('span'); num.style.cssText = 'color:var(--ws-text2);flex-shrink:0;min-width:3em;font-size:11px;'; num.textContent = `#${idx}`;
                const txt = document.createElement('span'); txt.style.cssText = 'color:var(--ws-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                txt.textContent = plain.slice(0,46) + (plain.length>46?'…':'');
                let isHidden = !!chat[idx].is_system;
                const ghost = document.createElement('i'); ghost.className = 'fa-solid fa-ghost'; ghost.title = '숨김 토글';
                ghost.style.cssText = 'flex-shrink:0;font-size:13px;padding:4px 7px;border-radius:6px;cursor:pointer;transition:opacity 0.15s,background 0.12s,color 0.15s;background:transparent;';
                const upd = () => { ghost.style.opacity = isHidden?'0.85':'0.22'; ghost.style.color = isHidden?'var(--ws-text)':'var(--ws-text2)'; };
                upd();
                ghost.addEventListener('pointerenter', () => { ghost.style.background='rgba(255,255,255,0.25)'; ghost.style.opacity='1'; });
                ghost.addEventListener('pointerleave', () => { ghost.style.background='transparent'; upd(); });
                ghost.addEventListener('click', e => {
                    e.stopPropagation(); isHidden = !isHidden; upd();
                    const cc = getChat(); cc[idx].is_system = isHidden;
                    const mesEl = document.querySelector(`#chat .mes[mesid="${idx}"]`);
                    if (mesEl) {
                        if (isHidden) mesEl.setAttribute('is_system','true'); else mesEl.removeAttribute('is_system');
                        const hb=mesEl.querySelector('.mes_hide'), ub=mesEl.querySelector('.mes_unhide');
                        if (hb) hb.style.display = isHidden?'none':'';
                        if (ub) ub.style.display = isHidden?'':'none';
                    }
                    SillyTavern.getContext().saveChatDebounced?.();
                });
                item.appendChild(num); item.appendChild(txt); item.appendChild(ghost);
                item.addEventListener('click', () => loadAndScrollTo(idx)); list.appendChild(item);
            });
            body.appendChild(list);
            return '';
        },
    }));

    // 드래그 선택 텍스트 — pill이 살아있는 동안 유지, 사라지면 초기화
    let _wsActiveDragText = '';

    // ─── /edit-mode ───────────────────────────────────────────────────────────
    // 왼쪽 사이드, find 첫 패널(createPanel 기본 위치)과 같은 y값에 고정으로 뜨는 패널
    function closeEditModePanel() { document.getElementById('ws-editmode-panel')?.remove(); }

    function openEditModePanel() {
        closeEditModePanel();
        const panel = document.createElement('div'); panel.id = 'ws-editmode-panel';
        panel.style.cssText = `position:fixed;left:14px;top:0;
            z-index:9999999!important;background:var(--ws-panel);color:var(--ws-text);
            border:1px solid var(--ws-border);border-radius:var(--ws-radius);
            box-shadow:0 4px 16px rgba(0,0,0,0.06),0 8px 32px rgba(0,0,0,0.04);
            display:flex;flex-direction:column;
            font-size:13px;font-family:inherit;width:160px;opacity:0;overflow:hidden;`;

        // 헤더 — 왼쪽은 배경만(테두리 없음), 우상단에 작은 닫기(X) 버튼만
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;padding:8px 8px 0 0;';
        const closeBtn = document.createElement('button'); closeBtn.textContent = '✕';
        closeBtn.style.cssText = `background:transparent;border:none;color:var(--ws-text2);
            font-size:13px;font-family:inherit;cursor:pointer;width:22px;height:22px;
            display:flex;align-items:center;justify-content:center;border-radius:6px;padding:0;`;
        closeBtn.addEventListener('pointerenter', () => { closeBtn.style.background = 'rgba(0,0,0,0.05)'; });
        closeBtn.addEventListener('pointerleave', () => { closeBtn.style.background = 'transparent'; });
        closeBtn.addEventListener('click', () => closeEditModePanel());
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:4px 18px 16px;';
        panel.appendChild(body);

        function makeRow(labelText) {
            const lbl = document.createElement('label'); lbl.className = 'ws-label';
            const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ws-check';
            lbl.appendChild(chk); lbl.appendChild(document.createTextNode(labelText));
            body.appendChild(lbl); return chk;
        }

        const moveChk = makeRow('/move 끄기');
        moveChk.checked = wsSettings.moveDisabled;
        moveChk.addEventListener('change', () => { wsSettings.moveDisabled = moveChk.checked; saveWsSettings(); });

        const pillChk = makeRow('드래그 필 끄기');
        pillChk.checked = wsSettings.pillDisabled;
        pillChk.addEventListener('change', () => { wsSettings.pillDisabled = pillChk.checked; saveWsSettings(); });

        // 하이라이트 변경 — 체크 안 하면 기본 하이라이트 컬러, 체크하면 아래 RGBA 값 적용
        const hlChk = makeRow('하이라이트 변경');
        hlChk.checked = wsSettings.hlEnabled;
        hlChk.addEventListener('change', () => { wsSettings.hlEnabled = hlChk.checked; applyWsHlColor(); saveWsSettings(); });

        // RGBA 선택
        const rgbaRow = document.createElement('div');
        rgbaRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const colorInput = document.createElement('input'); colorInput.type = 'color';
        colorInput.value = wsSettings.hlRgb;
        colorInput.style.cssText = 'width:26px;height:20px;padding:0;border:1px solid var(--ws-border);border-radius:4px;cursor:pointer;flex-shrink:0;';
        const alphaInput = document.createElement('input'); alphaInput.type = 'range'; alphaInput.min = '0'; alphaInput.max = '100';
        alphaInput.value = String(wsSettings.hlAlpha);
        alphaInput.style.cssText = 'flex:1;accent-color:var(--ws-check-color);';
        const onColorChange = () => {
            wsSettings.hlRgb = colorInput.value; wsSettings.hlAlpha = parseInt(alphaInput.value, 10);
            applyWsHlColor(); saveWsSettings();
        };
        colorInput.addEventListener('input', onColorChange);
        alphaInput.addEventListener('input', onColorChange);
        rgbaRow.appendChild(colorInput); rgbaRow.appendChild(alphaInput);
        body.appendChild(rgbaRow);

        document.body.appendChild(panel);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const ph = panel.offsetHeight;
            // find 첫 패널(createPanel 기본 위치)과 정확히 같은 y값
            const top = Math.max(10, Math.min((window.innerHeight - ph) / 2 - 25, window.innerHeight - ph - 10));
            panel.style.top = `${Math.round(top)}px`;
            panel.style.opacity = '1';
        }));
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'edit-mode', helpString: 'Toggle the edit-mode panel (disable /move, disable drag pill, change highlight color).',
        callback: () => {
            if (document.getElementById('ws-editmode-panel')) closeEditModePanel();
            else openEditModePanel();
            return '';
        },
    }));


    // ─── Drag-to-Search ───────────────────────────────────────────────────────
    const QR_MARKERS = ['📎','🔎','🪄'];
    function findTargetQRBtn(el) {
        const b = el?.closest('#qr--bar .qr--button, .qr--buttons .qr--button');
        if (!b) return null; return QR_MARKERS.some(m => (b.textContent??'').includes(m)) ? b : null;
    }

    (function initDragSearch() {
        if (window._wsDragSearch) window._wsDragSearch();
        const PILL = 'ws-drag-pill';
        const removePill = () => { const el=document.getElementById(PILL); if (el?._cleanup) el._cleanup(); el?.remove(); _wsActiveDragText = ''; };
        function makePillIcon(iconClass, onActivate) {
            const el = document.createElement('span');
            el.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;';
            const icon = document.createElement('i'); icon.className = iconClass; icon.style.fontSize = '12px';
            el.appendChild(icon);
            const touch = window.matchMedia('(pointer:coarse)').matches;
            el.addEventListener('mousedown', e => e.preventDefault());
            el.addEventListener('click', e => { e.stopPropagation(); onActivate(); });
            if (touch) {
                el.addEventListener('touchstart', e => { e.preventDefault(); onActivate(); }, { passive:false });
                el.addEventListener('pointerdown', e => { if (e.pointerType==='touch') { e.preventDefault(); onActivate(); } });
            }
            return el;
        }
        function showPill(x, y, text, range) {
            removePill();
            const pill = document.createElement('div'); pill.id = PILL;
            // 아이콘 간격: gap 값(px)으로 조절
            pill.style.cssText = `position:fixed;left:${x+20}px;top:${y+70}px;z-index:999999;display:flex;align-items:center;gap:20px;user-select:none;color:var(--ws-text);font-size:14px;padding:4px 2px;white-space:nowrap;`;
            pill.appendChild(makePillIcon('fa-solid fa-wand-magic-sparkles', () => { removePill(); runChange(text, false, false); }));
            document.body.appendChild(pill);
            let matchCtx = null;
            try { matchCtx = getMatchContext(range); } catch {}
            if (matchCtx) {
                const rawSelText = range.toString();
                const clonedRange = range.cloneRange();
                pill.appendChild(makePillIcon('fa-solid fa-eraser', () => { removePill(); openQuickReplacePanel(matchCtx.msgIdx, matchCtx.beforeCtx, rawSelText, matchCtx.afterCtx, clonedRange); }));
            }
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
                if (wsSettings.pillDisabled) { removePill(); return; }
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
    })();

    // ─── QR Drag-inject ───────────────────────────────────────────────────────
    (function initQRDragInject() {
        if (window._wsQRDragInject) window._wsQRDragInject();
        const getSelInChat = () => { const sel=window.getSelection(),text=sel?.toString().trim(); if (!text||sel.rangeCount<1) return null; return document.getElementById('chat')?.contains(sel.getRangeAt(0).commonAncestorContainer)?text:null; };
        const onPD = e => {
            const qrBtn = findTargetQRBtn(e.target); if (!qrBtn) return;
            const label = qrBtn.textContent ?? '';
            const selText = getSelInChat() || _wsActiveDragText;

            // 📎 클립: 드래그(또는 pill로 잡힌 텍스트)가 있으면 그걸 복사. 없으면 입력창(#send_textarea)에
            // 타이핑된 텍스트를 복사, 그것도 비어있으면 전체 채팅을 복사
            // 클립보드 API는 iOS에서 "충분히 신뢰된 제스처"가 아니면 거부함 — pointerdown 시점에
            // 바로 호출하면 거부되고, preventDefault를 걸어버리면 뒤따라올 click 자체가 안 생겨서
            // click을 기다리는 방식도 못 씀. 그래서 여기서는 preventDefault를 절대 안 걸어서
            // 진짜 click이 정상적으로 발생하게 두고, 그 click 시점에 복사를 실행함
            if (label.includes('📎')) {
                const onClickOnce = async () => {
                    if (selText) { copyText(selText); return; }
                    const typed = document.getElementById('send_textarea')?.value?.trim();
                    if (typed) { copyText(typed); return; }
                    await copyFullChat();
                };
                document.addEventListener('click', onClickOnce, { capture:true, once:true });
                setTimeout(() => document.removeEventListener('click', onClickOnce, { capture:true }), 400);
                return;
            }

            // 🔎/🪄: 드래그 텍스트가 있으면 바로 검색/바꾸기 실행, 없으면 키워드 입력 패널을 열어줌
            if (label.includes('🔎') || label.includes('🪄')) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                if (!selText) { if (label.includes('🔎')) openFindKeywordPanel(); else openChangeKeywordPanel(); return; }
                if (label.includes('🔎')) runFind(selText, false, false); else runChange(selText, false, false);
            }
        };
        document.addEventListener('pointerdown', onPD, { capture:true });
        window._wsQRDragInject = () => { document.removeEventListener('pointerdown',onPD,{capture:true}); window._wsQRDragInject=null; };
    })();

})();
