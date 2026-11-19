/* 展示会備品 — the page: list, item detail, 出庫・返却 and the other dialogs, history, settings.
 * Rules live in logic.js and storage in store.js. Anyone signed in to the portal can do everything;
 * every change is written with the operator's name into the append-only history. */
(function () {
    'use strict';

    const L = window.ExhibitLogic;
    const params = new URLSearchParams(location.search);
    const DEMO_KEY = 'caremax-exhibit-demo-v4';
    const ALERTS_KEY = 'caremax-exhibit-alerts';
    const PREF_KEY = 'caremax-exhibit-prefs';
    const IMPORT_CHUNK = 150;
    const HISTORY_PAGE = 200;
    const REQUIRED = ['items', 'master'];

    const state = {
        mode: '', user: null, gate: 'loading', gateMessage: '',
        loaded: new Set(), errors: {},
        items: [], master: L.defaultMaster(),
        view: 'items', pendingItem: '',
        filters: { area: '', keyword: '', attention: '' },
        selected: new Set(),
        history: { entries: null, limit: HISTORY_PAGE, loading: false, error: '', from: '', to: '', action: '', keyword: '' },
        settingsShown: false
    };
    let store = null;
    let derived = null;
    let renderQueued = false;
    const liveModals = new Set();
    const modalStack = [];

    // ================= small helpers =================
    function el(id) { return document.getElementById(id); }
    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
    function today() { return L.todayStr(); }
    function fd(date) { return L.formatDate(date, today()); }
    function fdt(at) { return L.formatDateTime(at, today()); }
    function baseName() { return L.baseArea(state.master).name; }
    function newId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    function makeCtx() {
        return { master: state.master, today: today(), now: L.localISO(), actor: state.user || { email: '', name: '' }, newId };
    }
    function errorMessage(error) {
        if (error && error.userMessage) return error.userMessage;
        const code = error && error.code;
        if (code === 'permission-denied') return '保存が許可されていません。ポータルでログインし直してください。';
        if (code === 'unavailable' || code === 'deadline-exceeded') return '通信できませんでした。もう一度押してください。';
        return '保存できませんでした。もう一度押してください。（' + ((error && (error.message || error.code)) || '原因不明') + '）';
    }
    function showToast(type, message, action) {
        const toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const body = document.createElement('div');
        body.textContent = message;
        toast.appendChild(body);
        const buttons = document.createElement('div');
        buttons.className = 'toast-actions';
        if (action) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action.label;
            button.addEventListener('click', () => { toast.remove(); action.run(); });
            buttons.appendChild(button);
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '閉じる';
        close.addEventListener('click', () => toast.remove());
        buttons.appendChild(close);
        toast.appendChild(buttons);
        el('toast-area').appendChild(toast);
        if (type === 'success' || type === 'info') setTimeout(() => toast.remove(), 5000);
    }
    function download(filename, rows) {
        const blob = new Blob(['﻿' + L.toCSV(rows)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function stamp() { return today().replace(/-/g, ''); }
    function readPref(key, fallback) {
        try { const prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); return key in prefs ? prefs[key] : fallback; } catch (error) { return fallback; }
    }
    function writePref(key, value) {
        try { const prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); prefs[key] = value; localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (error) { /* private mode */ }
    }
    function revsOf(ids) {
        const revs = {};
        ids.forEach(id => { const item = derived.itemsById[id]; revs[id] = item ? Number(item.rev) || 0 : -1; });
        return revs;
    }
    function setOptions(select, html) {
        if (select.dataset.sig === html) return;
        const value = select.value;
        select.innerHTML = html;
        select.dataset.sig = html;
        if ([...select.options].some(o => o.value === value)) select.value = value;
    }
    function areaOptions(selected, firstLabel) {
        return (firstLabel ? '<option value="">' + esc(firstLabel) + '</option>' : '') +
            state.master.areas.map(a => '<option value="' + esc(a.id) + '"' + (a.id === selected ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('');
    }
    function viewOf(id) { return derived.views.get(id); }
    function canOut(item) { return L.counts(item).stock > 0; }
    function canReturn(item) { return L.counts(item).outs.length > 0; }

    // ================= boot =================
    function boot() {
        bindStatic();
        window.addEventListener('hashchange', () => route(false));
        route(true);
        const portalUser = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
        if (params.get('demo') === '1' || (portalUser && portalUser.isDemo)) { startDemo(portalUser); return; }
        if (typeof firebase === 'undefined' || typeof firebaseConfig === 'undefined') {
            showGate('error', 'データベースの部品を読み込めませんでした。通信を確かめて、読み込み直してください。');
            return;
        }
        startFirestore();
    }

    function startDemo(portalUser) {
        state.mode = 'local';
        state.user = { email: (portalUser && portalUser.email) || 'demo@caremax.local', name: (portalUser && portalUser.displayName) || 'デモユーザー' };
        store = window.ExhibitStore.createLocalStore(DEMO_KEY, () => window.ExhibitDemo.seed(L));
        el('demo-banner').hidden = false;
        subscribe();
    }

    function startFirestore() {
        showGate('loading');
        if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
        const db = firebase.firestore();
        db.enablePersistence({ synchronizeTabs: true }).catch(error => console.warn('Offline cache unavailable:', error.code));
        let started = false;
        firebase.auth().onAuthStateChanged(user => {
            if (!user) { store = null; showGate('signin'); return; }
            state.user = { email: user.email || '', name: user.displayName || user.email || '' };
            if (started) { store = store || window.ExhibitStore.createFirestoreStore(db); scheduleRender(); return; }
            started = true;
            state.mode = 'firestore';
            store = window.ExhibitStore.createFirestoreStore(db);
            subscribe();
        });
    }

    function subscribe() {
        store.subscribe({
            onData(key, value) {
                if (key === 'master') state.master = L.normalizeMaster(value);
                else state[key] = Array.isArray(value) ? value : [];
                state.loaded.add(key);
                delete state.errors[key];
                scheduleRender();
            },
            onError(key, error) {
                console.error('Could not load ' + key + ':', error);
                state.errors[key] = error;
                state.loaded.add(key);
                scheduleRender();
            }
        });
    }

    function showGate(kind, message) {
        state.gate = kind;
        state.gateMessage = message || '';
        scheduleRender();
    }
    function currentGate() {
        if (!store) return state.gate || 'loading';
        if (Object.keys(state.errors).length) return 'error';
        if (!REQUIRED.every(key => state.loaded.has(key))) return 'loading';
        return '';
    }
    function renderGate(kind) {
        const gate = el('gate');
        if (kind === 'loading') {
            gate.innerHTML = '<div class="gate-icon"><i class="fa-solid fa-spinner fa-spin"></i></div><h1>読み込んでいます…</h1>';
        } else if (kind === 'signin') {
            gate.innerHTML = '<div class="gate-icon"><i class="fa-solid fa-right-to-bracket"></i></div><h1>ログインが必要です</h1>' +
                '<p>TOPページでログインしてから開いてください。</p><a class="btn btn-primary" href="../index.html">TOPページへ</a>';
        } else {
            const error = Object.values(state.errors)[0];
            const denied = error && error.code === 'permission-denied';
            gate.innerHTML = '<div class="gate-icon" style="color:var(--danger)"><i class="fa-solid fa-triangle-exclamation"></i></div><h1>読み込めませんでした</h1>' +
                '<p>' + esc(state.gateMessage || (denied ? 'データベースの読み取りが許可されていません。' : '通信を確かめて、読み込み直してください。')) + '</p>' +
                (denied ? '<p class="gate-detail">Firebase（kikakubu-portal）の Firestore のルールで、exhibit_ で始まるコレクションの読み書きを許可してください。</p>' : '') +
                (error ? '<p class="gate-detail">' + esc(error.code || error.message || '') + '</p>' : '') +
                '<button type="button" class="btn btn-primary" onclick="location.reload()">読み込み直す</button>';
        }
    }

    // ================= derived data & render =================
    function derive() {
        const itemsById = {};
        state.items.forEach(item => { itemsById[item.id] = item; });
        derived = { itemsById, views: new Map() };
        const ctx = makeCtx();
        state.items.forEach(item => derived.views.set(item.id, L.computeView(item, ctx)));
    }

    function scheduleRender() {
        if (renderQueued) return;
        renderQueued = true;
        setTimeout(() => { renderQueued = false; render(); }, 0);
    }

    function render() {
        const gate = currentGate();
        el('gate').hidden = !gate;
        el('main').hidden = !!gate;
        el('header-actions').hidden = !!gate;
        renderTabs();
        renderUser();
        if (gate) { renderGate(gate); return; }
        derive();
        [...state.selected].forEach(id => { if (!derived.itemsById[id]) state.selected.delete(id); });
        ['items', 'history', 'settings'].forEach(name => { el('view-' + name).hidden = state.view !== name; });
        if (state.view === 'items') renderItems();
        else if (state.view === 'history') renderHistory();
        else if (state.view === 'settings' && !state.settingsShown) renderSettings();
        renderHeaderCounts();
        liveModals.forEach(refresh => refresh());
        openPendingItem();
        writeAlerts();
    }

    function renderTabs() {
        document.querySelectorAll('.tab').forEach(tab => {
            const active = tab.dataset.tab === state.view;
            tab.classList.toggle('active', active);
            if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
        });
    }
    function renderUser() {
        const user = state.user;
        el('user-chip').innerHTML = user ? '<span class="avatar">' + esc((user.name || user.email || '?').charAt(0)) + '</span><span title="' + esc(user.email) + '">' + esc(user.name || user.email) + '</span>' : '';
    }
    function renderHeaderCounts() {
        const selected = [...state.selected].map(id => derived.itemsById[id]).filter(Boolean);
        el('out-count').textContent = selected.length ? String(selected.filter(canOut).length) : '';
        el('return-count').textContent = selected.length ? String(selected.filter(canReturn).length) : '';
    }
    // The portal's TOP page shows this number on the card (real data only).
    function writeAlerts() {
        if (state.mode !== 'firestore') return;
        let count = 0;
        derived.views.forEach(v => { if (v.overdue || v.short) count++; });
        try { localStorage.setItem(ALERTS_KEY, JSON.stringify({ count, at: L.localISO() })); } catch (error) { /* ignore */ }
    }

    // ================= routing =================
    function route(initial) {
        const parts = location.hash.replace(/^#\/?/, '').split('/');
        const previous = state.view;
        if (parts[0] === 'item' && parts[1]) {
            state.pendingItem = decodeURIComponent(parts[1]);
            state.view = 'items';
        } else {
            state.view = ['items', 'history', 'settings'].includes(parts[0]) ? parts[0] : 'items';
        }
        if (state.view === 'settings' && previous !== 'settings') state.settingsShown = false;
        if (state.view === 'history' && previous !== 'history') state.history.entries = null;
        if (!initial && previous !== state.view) window.scrollTo(0, 0);
        if (!initial) scheduleRender();
    }
    // #/item/<id or name> opens that item (for labels with a QR code later).
    function openPendingItem() {
        if (!state.pendingItem) return;
        const key = L.normalizeKey(state.pendingItem);
        state.pendingItem = '';
        const item = state.items.find(i => i.id === key || L.normalizeKey(i.name) === key);
        history.replaceState(null, '', '#/items');
        if (item) openItemDetail(item.id); else showToast('warn', '備品が見つかりませんでした。');
    }

    // ================= static bindings =================
    function bindStatic() {
        document.addEventListener('click', onClick);
        document.addEventListener('change', onChange);
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !modalStack.length) return;
            const top = modalStack[modalStack.length - 1];
            if (top.escClose) top.close();
        });
        el('f-area').addEventListener('change', event => { state.filters.area = event.target.value; renderItems(); });
        let timer;
        el('f-keyword').addEventListener('input', event => {
            clearTimeout(timer);
            timer = setTimeout(() => { state.filters.keyword = event.target.value; renderItems(); }, 120);
        });
        el('h-from').addEventListener('change', event => { state.history.from = event.target.value; reloadHistory(); });
        el('h-to').addEventListener('change', event => { state.history.to = event.target.value; reloadHistory(); });
        el('h-action').addEventListener('change', event => { state.history.action = event.target.value; renderHistory(); });
        el('h-keyword').addEventListener('input', event => { state.history.keyword = event.target.value; renderHistory(); });
    }

    function onClick(event) {
        const target = event.target.closest('[data-act]');
        if (!target || target.disabled) return;
        const act = target.dataset.act;
        const selected = () => [...state.selected].map(id => derived.itemsById[id]).filter(Boolean);
        switch (act) {
            case 'noop': return;
            case 'attention': state.filters.attention = state.filters.attention === target.dataset.key ? '' : target.dataset.key; renderItems(); return;
            case 'clear-filters': clearFilters(); return;
            case 'print-area': printAreaSlip(state.filters.area); return;
            case 'item': openItemDetail(target.dataset.id); return;
            case 'new-item': openItemForm(); return;
            case 'import': openImport(); return;
            case 'out': openOut(selected().filter(canOut).map(item => item.id)); return;
            case 'return': openReturn(selected().filter(canReturn).map(item => item.id)); return;
            case 'clear-selection': state.selected.clear(); renderItems(); renderHeaderCounts(); return;
            case 'history-csv': exportHistoryCSV(filteredHistory(), '展示会備品_履歴_' + stamp() + '.csv'); return;
            case 'history-more': state.history.limit += HISTORY_PAGE; reloadHistory(true); return;
            case 'demo-reset':
                if (store && store.reset && confirm('デモのデータを最初に戻しますか？')) { store.reset(); state.selected.clear(); state.settingsShown = false; }
                return;
            default: return;
        }
    }

    function onChange(event) {
        const target = event.target;
        if (target.matches('[data-select]')) {
            if (target.checked) state.selected.add(target.dataset.select); else state.selected.delete(target.dataset.select);
            const row = target.closest('tr');
            if (row) row.classList.toggle('selected', target.checked);
            renderSelectionBar();
            renderHeaderCounts();
        } else if (target.matches('[data-select-all]')) {
            visibleItems().forEach(item => { if (target.checked) state.selected.add(item.id); else state.selected.delete(item.id); });
            renderItems();
            renderHeaderCounts();
        }
    }

    function clearFilters() {
        state.filters = { area: '', keyword: '', attention: '' };
        el('f-area').value = '';
        el('f-keyword').value = '';
        renderItems();
    }

    // ================= items =================
    function matchItem(item) {
        const f = state.filters;
        const v = viewOf(item.id);
        if (f.attention === 'out' ? !v.counts.outs.length : f.attention && !v[f.attention]) return false;
        if (f.area) {
            const base = L.baseArea(state.master).id;
            const here = (f.area === base && v.counts.stock > 0) || v.counts.outs.some(out => out.areaId === f.area);
            if (!here) return false;
        }
        if (f.keyword) {
            const words = L.normalizeKey(f.keyword).split(' ').filter(Boolean);
            const haystack = L.normalizeKey([item.name, item.note, v.breakdown, v.counts.outs.map(out => out.place).join(' ')].join(' '));
            if (!words.every(word => haystack.includes(word))) return false;
        }
        return true;
    }
    function visibleItems() {
        return state.items.filter(matchItem).sort((a, b) => viewOf(a.id).rank - viewOf(b.id).rank || a.name.localeCompare(b.name, 'ja'));
    }

    function renderItems() {
        if (!derived) return;
        renderSummary();
        setOptions(el('f-area'), areaOptions(state.filters.area, 'すべての場所'));
        el('f-area').value = state.filters.area;
        const f = state.filters;
        const area = f.area ? L.areaOf(state.master, f.area) : null;
        const printable = area && !area.base && state.items.some(item => L.counts(item).outs.some(out => out.areaId === area.id));
        el('filter-note').innerHTML = (printable ? '<button type="button" class="btn btn-small" data-act="print-area"><i class="fa-solid fa-print"></i>' + esc(area.name) + 'の貸出票</button>' : '') +
            (f.area || f.keyword || f.attention ? '<button type="button" class="filter-note" data-act="clear-filters"><i class="fa-solid fa-xmark"></i>絞り込みを解除</button>' : '');
        renderSelectionBar();
        const list = visibleItems();
        const results = el('items-results');
        if (!state.items.length) {
            results.innerHTML = '<div class="empty"><h2>まだ備品がありません</h2>' +
                '<button type="button" class="btn btn-primary" data-act="new-item"><i class="fa-solid fa-plus"></i>備品登録</button>' +
                '<button type="button" class="btn" data-act="import"><i class="fa-solid fa-file-import"></i>CSVで登録</button></div>';
        } else if (!list.length) {
            results.innerHTML = '<div class="empty"><h2>見つかりません</h2><button type="button" class="btn" data-act="clear-filters">絞り込みを解除</button></div>';
        } else {
            results.innerHTML = tableHTML(list);
        }
    }

    function renderSummary() {
        const views = state.items.map(item => viewOf(item.id));
        const lent = views.filter(v => v.counts.outs.length);
        const lentQty = lent.reduce((total, v) => total + v.counts.out, 0);
        const tiles = [
            { key: '', label: '備品', value: state.items.length, sub: '' },
            { key: 'out', label: '貸出中', value: lent.length, sub: lentQty ? '計 ' + lentQty + '個' : '' },
            { key: 'overdue', label: '返却遅れ', value: views.filter(v => v.overdue).length, sub: '', tone: 'danger' },
            { key: 'short', label: '補充が必要', value: views.filter(v => v.short).length, sub: '', tone: 'warn' }
        ];
        el('attention').innerHTML = tiles.map(tile => {
            const active = state.filters.attention === tile.key;
            return '<button type="button" class="stat' + (tile.tone ? ' tone-' + tile.tone : '') + (tile.value ? ' has-value' : '') + (active ? ' active' : '') + '" data-act="attention" data-key="' + tile.key + '" aria-pressed="' + active + '">' +
                '<span class="stat-label">' + tile.label + '</span><span class="stat-value"><strong>' + tile.value + '</strong>品</span>' +
                (tile.sub ? '<span class="stat-sub">' + esc(tile.sub) + '</span>' : '') + '</button>';
        }).join('');
    }

    function renderSelectionBar() {
        const bar = el('selection-bar');
        const items = [...state.selected].map(id => derived.itemsById[id]).filter(Boolean);
        if (!items.length) { bar.hidden = true; bar.innerHTML = ''; return; }
        const outable = items.filter(canOut).length;
        const returnable = items.filter(canReturn).length;
        bar.hidden = false;
        bar.innerHTML = '<span><strong>' + items.length + '件</strong>選択中</span>' +
            '<button type="button" class="btn btn-primary" data-act="out"' + (outable ? '' : ' disabled') + '><i class="fa-solid fa-truck-ramp-box"></i>出庫</button>' +
            '<button type="button" class="btn btn-primary alt" data-act="return"' + (returnable ? '' : ' disabled') + '><i class="fa-solid fa-rotate-left"></i>返却</button>' +
            '<button type="button" class="btn btn-quiet" data-act="clear-selection">選択を外す</button>';
    }

    function noteBadges(v) {
        let html = '';
        if (v.overdue) html += '<span class="row-note tone-danger">返却遅れ ' + v.overdue.days + '日</span>';
        if (v.short) html += '<span class="row-note tone-warn">あと' + v.short.need + '個 補充</span>';
        return html ? '<span class="row-notes">' + html + '</span>' : '';
    }
    // Lent counts per place, with whether any of them is late.
    function outGroups(c) {
        const groups = [];
        c.outs.forEach(out => {
            const name = L.areaName(state.master, out.areaId);
            let group = groups.find(g => g.name === name);
            if (!group) groups.push(group = { name, qty: 0, late: false });
            group.qty += Number(out.qty || 0);
            if (out.dueDate && out.dueDate < today()) group.late = true;
        });
        return groups;
    }
    // Where the items are: chips plus a thin bar of the same proportions.
    function placeHTML(v) {
        const c = v.counts;
        const groups = outGroups(c);
        const pct = qty => (c.total ? Math.max(qty ? 3 : 0, qty / c.total * 100) : 0).toFixed(1);
        const chips = '<span class="place-chip is-base">' + esc(baseName()) + ' <b>' + c.stock + '</b></span>' +
            groups.map(g => '<span class="place-chip' + (g.late ? ' is-late' : '') + '">' + esc(g.name) + ' <b>' + g.qty + '</b></span>').join('');
        const bar = c.total && groups.length ? '<span class="place-bar" aria-hidden="true"><span class="seg-base" style="width:' + pct(c.stock) + '%"></span>' +
            groups.map(g => '<span class="seg-out' + (g.late ? ' is-late' : '') + '" style="width:' + pct(g.qty) + '%"></span>').join('') + '</span>' : '';
        return '<div class="place-chips">' + chips + '</div>' + bar;
    }

    const AVATAR_TONES = [['#ede9fe', '#5b21b6'], ['#dbeafe', '#1e40af'], ['#dcfce7', '#166534'], ['#fef3c7', '#92400e'], ['#fce7f3', '#9d174d'], ['#e0f2fe', '#075985']];
    // The photo when there is one, otherwise the first letter on a soft colour picked from the name.
    function avatarHTML(item, large) {
        const cls = 'avatar-item' + (large ? ' avatar-large' : '');
        if (item.thumb) return '<img class="' + cls + '" src="' + esc(item.thumb) + '" alt="" loading="lazy">';
        const letters = [...String(item.name || '?')];
        const hash = letters.reduce((total, ch) => total + ch.codePointAt(0), 0);
        const tone = AVATAR_TONES[hash % AVATAR_TONES.length];
        return '<span class="' + cls + '" style="background:' + tone[0] + ';color:' + tone[1] + '" aria-hidden="true">' + esc(letters[0]) + '</span>';
    }

    function tableHTML(list) {
        const allSelected = list.every(item => state.selected.has(item.id));
        return '<div class="table-wrap"><table class="item-table"><thead><tr>' +
            '<th class="col-check"><input type="checkbox" data-select-all aria-label="表示中をすべて選ぶ"' + (allSelected ? ' checked' : '') + '></th>' +
            '<th>備品</th><th class="num">保有数</th><th>どこにあるか</th><th>返却予定</th><th>更新</th>' +
            '</tr></thead><tbody>' + list.map(rowHTML).join('') + '</tbody></table></div>' +
            '<p class="result-count">' + list.length + '品</p>';
    }

    function rowHTML(item) {
        const v = viewOf(item.id);
        const c = v.counts;
        const selected = state.selected.has(item.id);
        const tone = v.overdue ? ' row-alert' : v.short ? ' row-warn' : '';
        return '<tr class="item-row' + tone + (selected ? ' selected' : '') + '" data-act="item" data-id="' + esc(item.id) + '">' +
            '<td class="col-check" data-act="noop"><input type="checkbox" data-select="' + esc(item.id) + '"' + (selected ? ' checked' : '') + ' aria-label="' + esc(item.name) + 'を選ぶ"></td>' +
            '<td class="col-name"><div class="name-cell">' + avatarHTML(item) + '<div class="name-text"><button type="button" class="link-btn" data-act="item" data-id="' + esc(item.id) + '">' + esc(item.name) + '</button>' + noteBadges(v) + '</div></div></td>' +
            '<td class="col-total num" data-label="保有">' + c.total + (item.minQty ? '<span class="sub">必要 ' + item.minQty + '</span>' : '') + '</td>' +
            '<td class="col-place">' + placeHTML(v) + '</td>' +
            '<td class="col-due' + (v.dueDate ? '' : ' is-empty') + '" data-label="返却">' + (v.dueDate ? '<span class="' + (v.overdue ? 'late' : '') + '">' + esc(fd(v.dueDate)) + '</span>' : '<span class="muted">—</span>') + '</td>' +
            '<td class="col-updated">' + esc(fdt(item.updatedAt)) + '<span class="sub" title="' + esc(item.updatedBy || '') + '">' + esc(item.updatedByName || '') + '</span></td>' +
            '</tr>';
    }

    // ================= modal =================
    function openModal(options) {
        const wrap = document.createElement('div');
        wrap.className = 'modal-backdrop';
        const titleId = 'm-' + newId();
        wrap.innerHTML = '<div class="modal modal-' + (options.size || 'md') + '" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '" tabindex="-1">' +
            '<header class="modal-head"><div class="modal-titles"><h2 id="' + titleId + '"></h2><p class="modal-sub"></p></div>' +
            '<button type="button" class="icon-btn" data-close aria-label="閉じる"><i class="fa-solid fa-xmark"></i></button></header>' +
            '<div class="modal-body"></div><div class="modal-error" role="alert" hidden></div><footer class="modal-foot"></footer></div>';
        const modal = {
            el: wrap,
            box: wrap.firstElementChild,
            body: wrap.querySelector('.modal-body'),
            foot: wrap.querySelector('.modal-foot'),
            escClose: !!options.escClose,
            onClose: null,
            busy: false,
            returnFocus: document.activeElement,
            setTitle(title, sub) {
                wrap.querySelector('h2').textContent = title || '';
                const p = wrap.querySelector('.modal-sub');
                p.textContent = sub || '';
                p.hidden = !sub;
            },
            setError(message) {
                const box = wrap.querySelector('.modal-error');
                box.textContent = message || '';
                box.hidden = !message;
            },
            close() {
                const index = modalStack.indexOf(modal);
                if (index > -1) modalStack.splice(index, 1);
                wrap.remove();
                if (modal.onClose) modal.onClose();
                if (!modalStack.length) document.body.classList.remove('modal-open');
                if (modal.returnFocus && modal.returnFocus.isConnected && modal.returnFocus.focus) modal.returnFocus.focus({ preventScroll: true });
            }
        };
        modal.setTitle(options.title, options.subtitle);
        modal.body.innerHTML = options.body || '';
        modal.foot.innerHTML = options.footer || '';
        modal.foot.hidden = !options.footer;
        wrap.addEventListener('click', event => { if (event.target.closest('[data-close]')) modal.close(); });
        el('modal-root').appendChild(wrap);
        document.body.classList.add('modal-open');
        modalStack.push(modal);
        setTimeout(() => modal.box.focus({ preventScroll: true }), 0);
        return modal;
    }

    async function submit(modal, button, work, success) {
        if (modal.busy) return;
        modal.busy = true;
        modal.setError('');
        const label = button ? button.innerHTML : '';
        if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中…'; }
        try {
            const result = await work();
            modal.close();
            const message = typeof success === 'function' ? success(result) : success;
            if (message) showToast('success', message);
        } catch (error) {
            if (!error || !error.userMessage) console.error(error);
            modal.setError(errorMessage(error));
            if (error && error.code === 'exhibit/stale' && modal.onStale) modal.onStale();
        } finally {
            modal.busy = false;
            if (button && button.isConnected) { button.disabled = false; button.innerHTML = label; }
        }
    }

    // Runs one operation per item in one transaction and refuses if someone else changed them since.
    function commitOps(ids, revs, run) {
        return store.commit({ itemIds: ids, expectRevs: revs }, ({ items }) => {
            const ctx = makeCtx();
            const writes = { items: [], history: [] };
            ids.forEach(id => {
                if (!items[id]) throw L.userError('備品が見つかりません。読み込み直してください。');
                const result = run(items[id], ctx);
                if (!result) return;
                writes.items.push(result.item);
                result.history.forEach(entry => writes.history.push(entry));
            });
            return writes;
        });
    }

    // ================= item detail =================
    function openItemDetail(id) {
        if (!derived.itemsById[id]) return;
        const modal = openModal({ size: 'md', escClose: true });
        let entries = null;
        let entriesRev = null;
        let photo = null;
        let photoRequested = false;
        const refresh = () => {
            const item = derived.itemsById[id];
            if (!item) { modal.close(); return; }
            if (entriesRev !== item.rev) {
                entriesRev = item.rev;
                store.loadItemHistory(id).then(list => { entries = list; refresh(); }).catch(error => { console.error(error); entries = 'error'; refresh(); });
            }
            if (item.hasPhoto && !photoRequested) {
                photoRequested = true;
                store.loadPhoto(id).then(data => { if (data) { photo = data; refresh(); } }).catch(error => console.warn('Photo:', error));
            }
            const scroll = modal.body.scrollTop;
            modal.setTitle(item.name, '');
            modal.body.innerHTML = detailBodyHTML(item, viewOf(id), entries, photo);
            modal.body.scrollTop = scroll;
            modal.foot.innerHTML = detailFooterHTML(item);
            modal.foot.hidden = false;
        };
        modal.onClose = () => liveModals.delete(refresh);
        modal.foot.addEventListener('click', event => {
            const button = event.target.closest('[data-detail]');
            if (!button) return;
            ({ out: () => openOut([id]), return: () => openReturn([id]), transfer: () => openTransfer(id), adjust: () => openAdjust(id), edit: () => openItemForm(id) })[button.dataset.detail]();
        });
        liveModals.add(refresh);
        refresh();
    }

    function detailBodyHTML(item, v, entries, photo) {
        const c = v.counts;
        const groups = outGroups(c);
        const stats = [['保有', c.total, item.minQty ? '必要 ' + item.minQty : ''], [baseName(), c.stock, ''], ['貸出中', c.out, groups.length ? groups.length + 'か所' : '']];
        const alerts = [];
        if (v.overdue) alerts.push(['danger', '返却予定日を' + v.overdue.days + '日過ぎています']);
        if (v.short) alerts.push(['warn', '必要数まで、あと' + v.short.need + '個']);
        const media = photo || item.thumb ? '<img class="detail-photo" src="' + esc(photo || item.thumb) + '" alt="' + esc(item.name) + 'の写真">' : '';
        const loans = c.outs.length ? '<ul class="loan-list">' + c.outs.map(out => {
            const late = out.dueDate && out.dueDate < today();
            return '<li><span class="loan-place">' + esc(L.destLabel(out, state.master)) + '</span><span class="loan-qty">' + out.qty + '個</span>' +
                '<span class="loan-due' + (late ? ' late' : '') + '">' + (out.dueDate ? '〜' + esc(fd(out.dueDate)) : '') + '</span></li>';
        }).join('') + '</ul>' : '';
        return '<div class="detail-top">' + media + '<div class="detail-stats">' +
            stats.map(s => '<div class="dstat"><span class="dstat-label">' + esc(s[0]) + '</span><strong>' + s[1] + '</strong><span class="dstat-sub">' + esc(s[2]) + '</span></div>').join('') + '</div></div>' +
            alerts.map(a => '<div class="alert tone-' + a[0] + '">' + esc(a[1]) + '</div>').join('') + loans +
            (item.note ? '<p class="detail-note">' + esc(item.note) + '</p>' : '') +
            '<section class="history-block"><h3>履歴</h3>' + timelineHTML(entries) + '</section>';
    }

    function timelineHTML(entries) {
        if (entries === null) return '<p class="muted">読み込み中…</p>';
        if (entries === 'error') return '<p class="muted">読み込めませんでした。</p>';
        if (!entries.length) return '<p class="muted">まだありません。</p>';
        return '<ol class="timeline">' + entries.map(entry => {
            const what = [entry.qty && entry.action !== 'edit' ? entry.qty + '個' : '', entry.place, entry.inspection, entry.dueDate ? '〜' + fd(entry.dueDate) : ''].filter(Boolean).join('　');
            return '<li class="tl-' + esc(entry.action) + '"><div class="tl-head"><span class="tl-action">' + esc(L.ACTION_LABELS[entry.action] || entry.action) + '</span>' +
                (what ? '<span class="tl-what">' + esc(what) + '</span>' : '') + '</div>' +
                (entry.comment ? '<div class="tl-comment">' + esc(entry.comment) + '</div>' : '') +
                '<div class="tl-meta">' + esc(fdt(entry.at)) + '・' + esc(entry.byName || entry.by || '') + '</div></li>';
        }).join('') + '</ol>';
    }

    function detailFooterHTML(item) {
        const buttons = [];
        if (canOut(item)) buttons.push('<button type="button" class="btn btn-primary" data-detail="out">出庫</button>');
        if (canReturn(item)) {
            buttons.push('<button type="button" class="btn btn-primary alt" data-detail="return">返却</button>');
            buttons.push('<button type="button" class="btn" data-detail="transfer">転送</button>');
        }
        buttons.push('<button type="button" class="btn" data-detail="adjust">数を変える</button>');
        buttons.push('<span class="spacer"></span><button type="button" class="btn btn-quiet" data-detail="edit"><i class="fa-solid fa-pen"></i>編集</button>');
        return buttons.join('');
    }

    // ================= register / edit =================
    function openItemForm(id) {
        const item = id ? derived.itemsById[id] : null;
        const startRev = item ? Number(item.rev) || 0 : 0;
        const photo = { thumb: item ? item.thumb || '' : '', full: undefined };
        const v = item || {};
        const body = '<div class="form-section"><div class="field-grid">' +
            '<label class="field field-wide"><span>備品名<em>必須</em></span><input type="text" id="i-name" value="' + esc(v.name || '') + '" maxlength="60"></label>' +
            (item ? '' : '<label class="field"><span>保有数<em>必須</em></span><input type="number" id="i-total" min="1" inputmode="numeric"></label>') +
            '<label class="field"><span>必要数（下回ったら知らせる）</span><input type="number" id="i-min" min="0" inputmode="numeric" value="' + esc(v.minQty || '') + '"></label>' +
            '<div class="field field-wide"><span>写真</span><div class="photo-field"><div class="photo-preview" id="i-photo-preview"></div><div class="photo-buttons">' +
            '<label class="btn btn-small file-btn"><i class="fa-solid fa-camera"></i>選ぶ・撮る<input type="file" id="i-photo" accept="image/*"></label>' +
            '<button type="button" class="btn btn-small btn-quiet" id="i-photo-clear">外す</button></div></div></div>' +
            '<label class="field field-wide"><span>備考</span><textarea id="i-note" rows="2">' + esc(v.note || '') + '</textarea></label>' +
            '</div></div>';
        const footer = (item ? '' : '<button type="button" class="btn btn-quiet" data-import><i class="fa-solid fa-file-import"></i>CSVで登録</button><span class="spacer"></span>') +
            '<button type="button" class="btn" data-close>キャンセル</button><button type="button" class="btn btn-primary" data-save>' + (item ? '保存' : '登録') + '</button>';
        const modal = openModal({ title: item ? '編集' : '備品登録', size: 'sm', body, footer });
        const root = modal.el;
        const showPhoto = () => {
            root.querySelector('#i-photo-preview').innerHTML = photo.thumb ? '<img src="' + esc(photo.thumb) + '" alt="">' : '<i class="fa-solid fa-image" aria-hidden="true"></i>';
            root.querySelector('#i-photo-clear').hidden = !photo.thumb;
        };
        showPhoto();
        root.querySelector('#i-photo').addEventListener('change', async event => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            try { Object.assign(photo, await readImage(file)); showPhoto(); } catch (error) { modal.setError('写真を読み込めませんでした。'); }
        });
        root.querySelector('#i-photo-clear').addEventListener('click', () => { photo.thumb = ''; photo.full = null; showPhoto(); });
        const importButton = root.querySelector('[data-import]');
        if (importButton) importButton.addEventListener('click', () => { modal.close(); openImport(); });
        const savePhoto = async itemId => {
            if (photo.full === undefined) return;
            try { await store.savePhoto(itemId, photo.full); } catch (error) { showToast('warn', '大きい写真を保存できませんでした。' + errorMessage(error)); }
        };
        root.querySelector('[data-save]').addEventListener('click', event => {
            const input = {
                name: root.querySelector('#i-name').value,
                total: item ? undefined : root.querySelector('#i-total').value,
                minQty: root.querySelector('#i-min').value,
                note: root.querySelector('#i-note').value,
                thumb: photo.thumb
            };
            submit(modal, event.currentTarget, async () => {
                if (item) {
                    await store.commit({ itemIds: [id], expectRevs: { [id]: startRev } }, ({ items }) => {
                        if (!items[id]) throw L.userError('この備品が見つかりません。');
                        const result = L.opEdit(items[id], input, makeCtx(), state.items);
                        return result ? { items: [result.item], history: result.history } : {};
                    });
                    await savePhoto(id);
                    return null;
                }
                const created = await store.commit({ itemIds: [] }, () => {
                    const result = L.opRegister(input, makeCtx(), state.items);
                    return { items: [result.item], history: result.history, result: result.item };
                });
                await savePhoto(created.id);
                return created;
            }, created => (created ? '「' + created.name + '」を登録しました。' : '保存しました。'));
        });
    }

    // Photos are shrunk in the browser: a small one for the list, a larger one for the detail.
    function readImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => {
                const draw = (max, quality) => {
                    const scale = Math.min(1, max / Math.max(image.width, image.height));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(image.width * scale));
                    canvas.height = Math.max(1, Math.round(image.height * scale));
                    const context = canvas.getContext('2d');
                    context.fillStyle = '#fff';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    context.drawImage(image, 0, 0, canvas.width, canvas.height);
                    return canvas.toDataURL('image/jpeg', quality);
                };
                let full = draw(1200, 0.8);
                if (full.length > 700000) full = draw(900, 0.7);
                const thumb = draw(160, 0.72);
                URL.revokeObjectURL(url);
                resolve({ thumb, full });
            };
            image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
            image.src = url;
        });
    }

    // ================= CSV import =================
    function decodeText(buffer) {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch (error) { return new TextDecoder('shift_jis').decode(buffer); }
    }
    function openImport() {
        const body = '<div class="form-section"><div class="op-tools">' +
            '<button type="button" class="btn btn-small" data-template><i class="fa-solid fa-download"></i>ひな形</button>' +
            '<label class="btn btn-small btn-primary file-btn"><i class="fa-solid fa-file-csv"></i>CSVを選ぶ<input type="file" accept=".csv,text/csv" data-file></label></div>' +
            '<p class="field-note">ひな形に1行1品で入れて、CSVで保存してください。</p></div><div data-preview></div>';
        const modal = openModal({ title: 'CSVで登録', size: 'md', body, footer: '<button type="button" class="btn" data-close>キャンセル</button><button type="button" class="btn btn-primary" data-run disabled>登録</button>' });
        const root = modal.el;
        let inputs = [];
        root.querySelector('[data-template]').addEventListener('click', () => download('展示会備品_ひな形.csv', L.importTemplate()));
        root.querySelector('[data-file]').addEventListener('change', async event => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            modal.setError('');
            const ctx = makeCtx();
            const read = L.readImportRows(L.parseCSV(decodeText(await file.arrayBuffer())), ctx);
            const errors = read.errors.slice();
            const preview = [];
            const names = state.items.slice();
            read.inputs.forEach(row => {
                try {
                    const result = L.opRegister(row.input, ctx, names);
                    names.push(result.item);
                    preview.push(result.item);
                } catch (error) { errors.push({ rowNo: row.rowNo, message: error.userMessage || error.message }); }
            });
            errors.sort((a, b) => a.rowNo - b.rowNo);
            inputs = errors.length ? [] : read.inputs;
            const button = root.querySelector('[data-run]');
            button.disabled = !inputs.length;
            button.textContent = inputs.length ? inputs.length + '件を登録' : '登録';
            root.querySelector('[data-preview]').innerHTML =
                (errors.length ? '<ul class="import-errors">' + errors.map(e => '<li>' + e.rowNo + '行目：' + esc(e.message) + '</li>').join('') + '</ul>'
                    : preview.length ? '' : '<p class="field-note warn">登録する行がありません。</p>') +
                (read.skipped ? '<p class="field-note">「例：」の行（' + read.skipped + '行）は飛ばします。</p>' : '') +
                (preview.length ? '<div class="import-table-wrap"><table class="import-table"><thead><tr><th>備品名</th><th>保有数</th><th>内訳</th></tr></thead><tbody>' +
                    preview.map(p => '<tr><td>' + esc(p.name) + '</td><td>' + p.total + '</td><td>' + esc(L.breakdownLabel(p, state.master)) + '</td></tr>').join('') + '</tbody></table></div>' : '');
        });
        root.querySelector('[data-run]').addEventListener('click', event => {
            const all = inputs.slice();
            submit(modal, event.currentTarget, async () => {
                const names = state.items.slice();
                for (let start = 0; start < all.length; start += IMPORT_CHUNK) {
                    const chunk = all.slice(start, start + IMPORT_CHUNK);
                    const added = await store.commit({ itemIds: [] }, () => {
                        const ctx = makeCtx();
                        const known = names.slice();
                        const writes = { items: [], history: [] };
                        chunk.forEach(row => {
                            try {
                                const result = L.opRegister(row.input, ctx, known);
                                known.push(result.item);
                                writes.items.push(result.item);
                                result.history.forEach(entry => writes.history.push(entry));
                            } catch (error) {
                                throw L.userError(row.rowNo + '行目：' + (error.userMessage || error.message) + (start ? '（' + start + '件は登録済み）' : ''));
                            }
                        });
                        writes.result = writes.items;
                        return writes;
                    });
                    added.forEach(item => names.push(item));
                }
                return all.length;
            }, count => count + '件を登録しました。');
        });
    }

    // ================= shared parts of the dialogs =================
    function destFieldsHTML(prefix, initial) {
        return '<div class="field-grid three">' +
            '<label class="field"><span>貸出先<em>必須</em></span><select id="' + prefix + '-area">' + areaOptions(initial.areaId || '', '選んでください') + '</select></label>' +
            '<label class="field"><span>会場・メモ</span><input type="text" id="' + prefix + '-place" value="' + esc(initial.place || '') + '" placeholder="例：コンベックス岡山"></label>' +
            '<label class="field"><span>返却予定日</span><input type="date" id="' + prefix + '-due" value="' + esc(initial.dueDate || '') + '"></label></div>';
    }
    function readDest(root, prefix) {
        return { areaId: root.querySelector('#' + prefix + '-area').value, place: root.querySelector('#' + prefix + '-place').value, dueDate: root.querySelector('#' + prefix + '-due').value };
    }
    function pickerHTML(placeholder) {
        return '<div class="picker"><i class="fa-solid fa-plus" aria-hidden="true"></i><input type="search" class="picker-input" placeholder="' + esc(placeholder) + '" autocomplete="off" aria-label="' + esc(placeholder) + '"><div class="picker-results" hidden></div></div>';
    }
    function bindPicker(root, candidates, onPick) {
        const input = root.querySelector('.picker-input');
        const box = root.querySelector('.picker-results');
        const show = () => {
            const words = L.normalizeKey(input.value).split(' ').filter(Boolean);
            const list = candidates().filter(item => words.every(word => L.normalizeKey(item.name).includes(word))).slice(0, 8);
            box.innerHTML = list.length ? list.map(item => '<button type="button" class="picker-option" data-pick="' + esc(item.id) + '"><span>' + esc(item.name) + '</span><span class="muted">' + esc(viewOf(item.id).breakdown) + '</span></button>').join('')
                : '<p class="picker-empty">ありません</p>';
            box.hidden = false;
        };
        input.addEventListener('input', show);
        input.addEventListener('focus', show);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); const first = box.querySelector('[data-pick]'); if (first) first.click(); }
            if (event.key === 'Escape' && !box.hidden) { event.stopPropagation(); box.hidden = true; }
        });
        box.addEventListener('click', event => {
            const button = event.target.closest('[data-pick]');
            if (!button) return;
            onPick(button.dataset.pick);
            input.value = '';
            box.hidden = true;
        });
        root.addEventListener('click', event => { if (!event.target.closest('.picker')) box.hidden = true; });
    }

    // ================= 出庫 =================
    function openOut(itemIds) {
        const rows = [];
        let revs = {};
        const add = id => {
            if (rows.some(row => row.id === id) || !derived.itemsById[id]) return;
            rows.push({ id, qty: 1 });
            revs[id] = Number(derived.itemsById[id].rev) || 0;
        };
        itemIds.forEach(add);
        const body = '<div class="form-section">' + destFieldsHTML('o', {}) + '</div>' +
            '<div class="form-section"><div class="op-list" data-rows></div>' + pickerHTML('備品を追加') + '</div>' +
            '<label class="check slip-check"><input type="checkbox" id="o-print"' + (readPref('slip', true) ? ' checked' : '') + '>貸出票を印刷する</label>';
        const modal = openModal({ title: '出庫', size: 'md', body, footer: '<button type="button" class="btn" data-close>キャンセル</button><button type="button" class="btn btn-primary" data-save>出庫する</button>' });
        const root = modal.el;
        const renderRows = () => {
            root.querySelector('[data-rows]').innerHTML = rows.length ? rows.map(row => {
                const item = derived.itemsById[row.id];
                if (!item) return '';
                const stock = L.counts(item).stock;
                return '<div class="op-row' + (stock ? '' : ' is-blocked') + '"><div class="op-item"><strong>' + esc(item.name) + '</strong><span class="op-sub">' + esc(baseName()) + 'に ' + stock + '個</span></div>' +
                    '<div class="op-qty">' + (stock ? '<input type="number" min="1" max="' + stock + '" value="' + esc(row.qty) + '" data-qty="' + esc(item.id) + '" inputmode="numeric" aria-label="' + esc(item.name) + 'の数"><span class="op-of">個</span>' : '<span class="op-reason">ありません</span>') + '</div>' +
                    '<button type="button" class="icon-btn" data-remove="' + esc(item.id) + '" aria-label="外す"><i class="fa-solid fa-xmark"></i></button></div>';
            }).join('') : '<p class="op-empty">下の欄から備品を追加してください。</p>';
        };
        root.querySelector('[data-rows]').addEventListener('click', event => {
            const button = event.target.closest('[data-remove]');
            if (!button) return;
            rows.splice(rows.findIndex(row => row.id === button.dataset.remove), 1);
            renderRows();
        });
        root.querySelector('[data-rows]').addEventListener('input', event => {
            const input = event.target.closest('[data-qty]');
            const row = input && rows.find(r => r.id === input.dataset.qty);
            if (row) row.qty = input.value;
        });
        bindPicker(root, () => state.items.filter(item => canOut(item) && !rows.some(row => row.id === item.id)), id => { add(id); renderRows(); });
        modal.onStale = () => { revs = revsOf(rows.map(row => row.id)); renderRows(); };
        renderRows();
        root.querySelector('[data-save]').addEventListener('click', event => {
            const dest = readDest(root, 'o');
            const ready = rows.filter(row => derived.itemsById[row.id] && canOut(derived.itemsById[row.id]));
            const wantSlip = root.querySelector('#o-print').checked;
            writePref('slip', wantSlip);
            submit(modal, event.currentTarget, async () => {
                if (!ready.length) throw L.userError('備品を追加してください。');
                const ids = ready.map(row => row.id);
                const expect = {};
                ids.forEach(id => { expect[id] = revs[id]; });
                const slipRows = ready.map(row => ({ name: derived.itemsById[row.id].name, qty: L.toInt(row.qty) }));
                await commitOps(ids, expect, (item, ctx) => L.opOut(item, Object.assign({ qty: ready.find(row => row.id === item.id).qty }, dest), ctx));
                ids.forEach(id => state.selected.delete(id));
                if (wantSlip) {
                    setTimeout(() => printSlip({ dest: L.destLabel(dest, state.master), dateLabel: '出庫日', date: today(), due: dest.dueDate, rows: slipRows }), 300);
                }
                return ids.length;
            }, count => count + '件を出庫しました。');
        });
    }

    // ================= 返却 =================
    function openReturn(itemIds) {
        const rows = [];
        let revs = {};
        const add = (id, areaId) => {
            const item = derived.itemsById[id];
            if (!item) return;
            L.counts(item).outs.forEach(out => {
                if (areaId && out.areaId !== areaId) return;
                if (rows.some(row => row.id === id && row.outKey === out.key)) return;
                rows.push({ id, outKey: out.key, include: true, back: out.qty, missing: 0 });
            });
            revs[id] = Number(item.rev) || 0;
        };
        itemIds.forEach(id => add(id));
        // One button per place that has something lent, to bring in everything from there at once.
        const lentAreas = state.master.areas.map(area => ({ area, count: state.items.filter(item => L.counts(item).outs.some(out => out.areaId === area.id)).length })).filter(x => x.count);
        const body = '<div class="form-section">' +
            (lentAreas.length ? '<div class="area-buttons">' + lentAreas.map(x => '<button type="button" class="btn btn-small" data-area-all="' + esc(x.area.id) + '"><i class="fa-solid fa-plus"></i>' + esc(x.area.name) + 'の分をすべて（' + x.count + '品）</button>').join('') + '</div>' : '') +
            '<div class="op-list" data-rows></div>' + pickerHTML('貸出中の備品を追加') + '</div>' +
            '<div class="form-section"><label class="field"><span>メモ</span><input type="text" id="r-comment" placeholder="例：2個は会場に確認中"></label></div>';
        const modal = openModal({ title: '返却', size: 'md', body, footer: '<button type="button" class="btn" data-close>キャンセル</button><button type="button" class="btn btn-primary alt" data-save>返却する</button>' });
        const root = modal.el;
        const renderRows = () => {
            root.querySelector('[data-rows]').innerHTML = rows.length ? rows.map((row, index) => {
                const item = derived.itemsById[row.id];
                const out = item && L.counts(item).outs.find(o => o.key === row.outKey);
                if (!out) return '';
                const late = out.dueDate && out.dueDate < today();
                return '<div class="op-row return-row' + (row.include ? '' : ' is-off') + '"><label class="check"><input type="checkbox" data-include="' + index + '"' + (row.include ? ' checked' : '') + ' aria-label="' + esc(item.name) + 'を返却"></label>' +
                    '<div class="op-item"><strong>' + esc(item.name) + '</strong><span class="op-sub">' + esc(L.destLabel(out, state.master)) + '・' + out.qty + '個' +
                    (out.dueDate ? '・<span class="' + (late ? 'late' : '') + '">〜' + esc(fd(out.dueDate)) + '</span>' : '') + '</span></div>' +
                    '<div class="qty-split">' + [['back', '戻った'], ['missing', '足りない']].map(p => '<label>' + p[1] + '<input type="number" min="0" max="' + out.qty + '" value="' + esc(row[p[0]]) + '" data-split="' + index + '" data-part="' + p[0] + '" inputmode="numeric"></label>').join('') + '</div></div>';
            }).join('') : '<p class="op-empty">下の欄から貸出中の備品を追加してください。</p>';
        };
        root.querySelectorAll('[data-area-all]').forEach(button => button.addEventListener('click', () => {
            state.items.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja')).forEach(item => add(item.id, button.dataset.areaAll));
            renderRows();
        }));
        root.querySelector('[data-rows]').addEventListener('change', event => {
            if (event.target.dataset.include === undefined) return;
            rows[Number(event.target.dataset.include)].include = event.target.checked;
            renderRows();
        });
        root.querySelector('[data-rows]').addEventListener('input', event => {
            const target = event.target;
            if (target.dataset.split !== undefined) rows[Number(target.dataset.split)][target.dataset.part] = target.value;
        });
        bindPicker(root, () => state.items.filter(item => canReturn(item) && !rows.some(row => row.id === item.id)), id => { add(id); renderRows(); });
        modal.onStale = () => { revs = revsOf([...new Set(rows.map(row => row.id))]); renderRows(); };
        renderRows();
        root.querySelector('[data-save]').addEventListener('click', event => {
            const comment = root.querySelector('#r-comment').value;
            const chosen = rows.filter(row => row.include);
            submit(modal, event.currentTarget, async () => {
                if (!chosen.length) throw L.userError('返却する備品にチェックを入れてください。');
                const ids = [...new Set(chosen.map(row => row.id))];
                const expect = {};
                ids.forEach(id => { expect[id] = revs[id]; });
                await commitOps(ids, expect, (item, ctx) => {
                    let current = item;
                    const history = [];
                    chosen.filter(row => row.id === item.id).forEach(row => {
                        const result = L.opReturn(current, Object.assign({}, row, { comment }), ctx);
                        current = result.item;
                        history.push(...result.history);
                    });
                    return { item: current, history };
                });
                ids.forEach(id => state.selected.delete(id));
                return chosen.length;
            }, count => count + '件を返却しました。');
        });
    }

    // ================= 転送 =================
    function openTransfer(id) {
        const item = derived.itemsById[id];
        if (!item) return;
        const rev = Number(item.rev) || 0;
        const outs = L.counts(item).outs;
        const body = '<div class="form-section"><div class="field-grid">' +
            '<label class="field"><span>今の貸出先</span><select id="t-from">' + outs.map(out => '<option value="' + esc(out.key) + '">' + esc(L.destLabel(out, state.master)) + '（' + out.qty + '個）</option>').join('') + '</select></label>' +
            '<label class="field"><span>数</span><input type="number" id="t-qty" min="1" value="' + (outs[0] ? outs[0].qty : 1) + '" inputmode="numeric"></label></div></div>' +
            '<div class="form-section"><h3>次の貸出先</h3>' + destFieldsHTML('t', {}) + '</div>';
        const modal = openModal({ title: '転送', subtitle: item.name, size: 'md', body, footer: '<button type="button" class="btn" data-close>キャンセル</button><button type="button" class="btn btn-primary" data-save>転送する</button>' });
        const root = modal.el;
        const from = root.querySelector('#t-from');
        from.addEventListener('change', () => { const out = outs.find(o => o.key === from.value); if (out) root.querySelector('#t-qty').value = out.qty; });
        root.querySelector('[data-save]').addEventListener('click', event => {
            const input = Object.assign({ outKey: from.value, qty: root.querySelector('#t-qty').value }, readDest(root, 't'));
            submit(modal, event.currentTarget, () => commitOps([id], { [id]: rev }, (fresh, ctx) => L.opTransfer(fresh, input, ctx)), '転送しました。');
        });
    }

    // ================= 数を変える =================
    function openAdjust(id) {
        const item = derived.itemsById[id];
        if (!item) return;
        const rev = Number(item.rev) || 0;
        const c = L.counts(item);
        const actions = Object.keys(L.ADJUST_ACTIONS).filter(key => key === 'add' || c.stock > 0);
        const body = '<div class="form-section"><div class="radio-cards">' + actions.map((key, i) => {
            const action = L.ADJUST_ACTIONS[key];
            return '<label class="radio-card"><input type="radio" name="a-action" value="' + key + '"' + (i === 0 ? ' checked' : '') + '><span><strong>' + action.label + '</strong>' + (action.hint ? '<small>' + action.hint + '</small>' : '') + '</span></label>';
        }).join('') + '</div><div class="field-grid">' +
            '<label class="field"><span>数</span><input type="number" id="a-qty" min="1" value="1" inputmode="numeric"></label>' +
            '<label class="field field-wide"><span>メモ</span><input type="text" id="a-comment"></label></div></div>';
        const modal = openModal({ title: '数を変える', subtitle: item.name + '（' + L.breakdownLabel(item, state.master) + '）', size: 'sm', body, footer: '<button type="button" class="btn" data-close>キャンセル</button><button type="button" class="btn btn-primary" data-save>保存</button>' });
        const root = modal.el;
        root.querySelector('[data-save]').addEventListener('click', event => {
            const action = root.querySelector('input[name="a-action"]:checked').value;
            const input = { action, qty: root.querySelector('#a-qty').value, comment: root.querySelector('#a-comment').value };
            submit(modal, event.currentTarget, () => commitOps([id], { [id]: rev }, (fresh, ctx) => L.opAdjust(fresh, input, ctx)), '保存しました。');
        });
    }

    // ================= 貸出票 =================
    function printSlip(opts) {
        const rows = opts.rows;
        const total = rows.reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
        const showPlace = rows.some(row => row.place);
        const showDue = rows.some(row => row.due);
        const cell = (label, value) => '<th>' + esc(label) + '</th><td>' + esc(value || '') + '</td>';
        el('print-root').innerHTML = '<div class="slip"><div class="slip-head"><h1>貸出票</h1><span>展示会備品</span></div>' +
            '<table class="slip-info"><tbody><tr>' + cell('貸出先', opts.dest) + cell(opts.dateLabel, fd(opts.date)) + '</tr>' +
            '<tr>' + (opts.due ? cell('返却予定日', fd(opts.due)) + cell('担当', state.user ? state.user.name : '') : '<th>担当</th><td colspan="3">' + esc(state.user ? state.user.name : '') + '</td>') + '</tr></tbody></table>' +
            '<table class="slip-list"><thead><tr><th>備品名</th>' + (showPlace ? '<th>会場・メモ</th>' : '') + (showDue ? '<th>返却予定</th>' : '') + '<th class="n">数</th><th class="n">戻った数</th></tr></thead><tbody>' +
            rows.map(row => '<tr><td>' + esc(row.name) + '</td>' + (showPlace ? '<td>' + esc(row.place || '') + '</td>' : '') + (showDue ? '<td>' + esc(row.due ? fd(row.due) : '') + '</td>' : '') +
                '<td class="n">' + esc(row.qty) + '</td><td class="n"></td></tr>').join('') +
            '</tbody><tfoot><tr><td colspan="' + (1 + (showPlace ? 1 : 0) + (showDue ? 1 : 0)) + '">計 ' + rows.length + '品</td><td class="n">' + total + '</td><td></td></tr></tfoot></table>' +
            '<div class="slip-memo">メモ</div></div>';
        window.print();
    }
    // Everything lent to one place right now (to print again, or for the place to check what it has).
    function printAreaSlip(areaId) {
        const rows = [];
        state.items.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja')).forEach(item => L.counts(item).outs.forEach(out => {
            if (out.areaId === areaId) rows.push({ name: item.name, qty: out.qty, place: out.place, due: out.dueDate });
        }));
        if (rows.length) printSlip({ dest: L.areaName(state.master, areaId), dateLabel: '印刷日', date: today(), due: '', rows });
    }

    // ================= history =================
    function reloadHistory(keep) {
        if (!store) return;
        if (!keep) state.history.limit = HISTORY_PAGE;
        state.history.loading = true;
        state.history.error = '';
        renderHistory();
        store.loadHistory({ from: state.history.from, to: state.history.to, limit: state.history.limit })
            .then(entries => { state.history.entries = entries; })
            .catch(error => { console.error(error); state.history.error = errorMessage(error); })
            .finally(() => { state.history.loading = false; renderHistory(); });
    }
    function filteredHistory() {
        const words = L.normalizeKey(state.history.keyword).split(' ').filter(Boolean);
        return (state.history.entries || []).filter(entry => {
            if (state.history.action && entry.action !== state.history.action) return false;
            const haystack = L.normalizeKey([entry.itemName, entry.place, entry.comment, entry.byName, entry.by].join(' '));
            return words.every(word => haystack.includes(word));
        });
    }
    function renderHistory() {
        setOptions(el('h-action'), '<option value="">すべての操作</option>' + Object.keys(L.ACTION_LABELS).map(key => '<option value="' + key + '">' + L.ACTION_LABELS[key] + '</option>').join(''));
        if (state.history.entries === null && !state.history.loading && !state.history.error) { reloadHistory(); return; }
        const box = el('history-results');
        if (state.history.error) { box.innerHTML = '<div class="empty"><h2>読み込めませんでした</h2><p>' + esc(state.history.error) + '</p></div>'; return; }
        if (state.history.entries === null) { box.innerHTML = '<p class="muted">読み込み中…</p>'; return; }
        const list = filteredHistory();
        const more = state.history.entries.length >= state.history.limit;
        box.innerHTML = (list.length ? '<div class="table-wrap"><table class="history-table"><thead><tr><th>日時</th><th>操作</th><th>備品</th><th>内容</th><th>操作者</th></tr></thead><tbody>' +
            list.map(entry => {
                const what = [entry.qty && entry.action !== 'edit' ? entry.qty + '個' : '', entry.place, entry.inspection, entry.dueDate ? '〜' + fd(entry.dueDate) : ''].filter(Boolean).join('　');
                return '<tr><td class="nowrap">' + esc(fdt(entry.at)) + '</td>' +
                    '<td><span class="action-tag action-' + esc(entry.action) + '">' + esc(L.ACTION_LABELS[entry.action] || entry.action) + '</span></td>' +
                    '<td><button type="button" class="link-btn" data-act="item" data-id="' + esc(entry.itemId) + '">' + esc(entry.itemName) + '</button></td>' +
                    '<td class="h-what">' + esc(what) + (entry.comment ? '<span class="sub">' + esc(entry.comment) + '</span>' : '') + '</td>' +
                    '<td class="nowrap" title="' + esc(entry.by) + '">' + esc(entry.byName || entry.by) + '</td></tr>';
            }).join('') + '</tbody></table></div>' : '<div class="empty"><h2>ありません</h2></div>') +
            (more ? '<div class="load-more"><button type="button" class="btn" data-act="history-more">もっと見る</button></div>' : '');
    }

    // ================= settings =================
    function renderSettings() {
        state.settingsShown = true;
        const root = el('view-settings');
        const used = {};
        state.items.forEach(item => L.counts(item).outs.forEach(out => { used[out.areaId] = (used[out.areaId] || 0) + 1; }));
        const areaRow = a => '<tr data-area="' + esc(a.id) + '"><td><input type="text" data-field="name" value="' + esc(a.name) + '" aria-label="拠点名"></td>' +
            '<td class="center"><input type="radio" name="s-base" value="' + esc(a.id) + '"' + (a.base ? ' checked' : '') + ' aria-label="保管する拠点"></td>' +
            '<td>' + (used[a.id] || a.base ? '' : '<button type="button" class="icon-btn" data-remove-row aria-label="削除"><i class="fa-solid fa-trash"></i></button>') + '</td></tr>';
        root.innerHTML = '<div class="settings-grid">' +
            '<section class="panel"><h2>拠点</h2><div class="table-wrap"><table class="edit-table"><thead><tr><th>名前</th><th>保管する拠点</th><th></th></tr></thead><tbody id="s-areas">' + state.master.areas.map(areaRow).join('') + '</tbody></table></div>' +
            '<div class="settings-save"><button type="button" class="btn btn-small" id="s-add-area"><i class="fa-solid fa-plus"></i>拠点を追加</button><span class="spacer"></span><span class="muted" id="s-status"></span><button type="button" class="btn btn-primary" id="s-save">保存</button></div></section>' +
            '<section class="panel"><h2>CSVで書き出す</h2><div class="export-buttons">' +
            '<button type="button" class="btn" id="x-items"><i class="fa-solid fa-file-csv"></i>備品一覧</button>' +
            '<button type="button" class="btn" id="x-history"><i class="fa-solid fa-file-csv"></i>履歴（全件）</button></div></section></div>';
        root.querySelector('#s-add-area').addEventListener('click', () => {
            root.querySelector('#s-areas').insertAdjacentHTML('beforeend', areaRow({ id: 'area-' + newId().slice(0, 8), name: '' }));
            root.querySelector('#s-areas tr:last-child input').focus();
        });
        root.querySelector('#s-areas').addEventListener('click', event => { const button = event.target.closest('[data-remove-row]'); if (button) button.closest('tr').remove(); });
        root.querySelector('#s-save').addEventListener('click', event => saveSettings(root, event.currentTarget));
        root.querySelector('#x-items').addEventListener('click', exportItemsCSV);
        root.querySelector('#x-history').addEventListener('click', exportAllHistory);
    }

    async function saveSettings(root, button) {
        const status = root.querySelector('#s-status');
        const baseId = (root.querySelector('input[name="s-base"]:checked') || {}).value;
        const areas = [...root.querySelectorAll('#s-areas tr')].map(row => {
            const area = { id: row.dataset.area, name: row.querySelector('[data-field="name"]').value.trim() };
            if (area.id === baseId) area.base = true;
            return area;
        });
        const problem = !areas.length || areas.some(a => !a.name) ? '拠点の名前を入れてください。'
            : new Set(areas.map(a => a.name)).size !== areas.length ? '拠点の名前が重なっています。'
                : !areas.some(a => a.base) ? '保管する拠点を1つ選んでください。' : '';
        if (problem) { status.textContent = problem; status.style.color = 'var(--danger)'; return; }
        const master = {
            areas,
            updatedAt: L.localISO(), updatedBy: state.user ? state.user.email : ''
        };
        button.disabled = true;
        status.style.color = '';
        status.textContent = '保存中…';
        try {
            await store.saveSettings('master', master);
            state.settingsShown = false;
            showToast('success', '保存しました。');
        } catch (error) {
            status.textContent = errorMessage(error);
            status.style.color = 'var(--danger)';
        } finally {
            button.disabled = false;
        }
    }

    // ================= CSV export =================
    function exportItemsCSV() {
        const areas = state.master.areas.filter(a => !a.base);
        const rows = [['備品名', '保有数', '必要数', baseName()].concat(areas.map(a => a.name), ['返却予定日', '備考', '更新日時', '更新者'])];
        state.items.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja')).forEach(item => {
            const v = viewOf(item.id);
            const c = v.counts;
            const byArea = id => c.outs.filter(out => out.areaId === id).reduce((t, out) => t + Number(out.qty || 0), 0);
            rows.push([item.name, c.total, item.minQty || '', c.stock].concat(areas.map(a => byArea(a.id)),
                [v.dueDate, item.note, (item.updatedAt || '').slice(0, 16).replace('T', ' '), item.updatedByName || '']));
        });
        download('展示会備品_一覧_' + stamp() + '.csv', rows);
    }
    function exportHistoryCSV(entries, filename) {
        const rows = [['日時', '操作', '備品名', '数', '場所', '検品', '返却予定日', '変更前', '変更後', 'メモ', '操作者']];
        entries.forEach(entry => rows.push([(entry.at || '').slice(0, 19).replace('T', ' '), L.ACTION_LABELS[entry.action] || entry.action, entry.itemName,
            entry.qty || '', entry.place, entry.inspection, entry.dueDate, entry.before, entry.after, entry.comment, entry.byName || entry.by]));
        download(filename, rows);
    }
    async function exportAllHistory() {
        try { exportHistoryCSV(await store.loadHistory({}), '展示会備品_履歴_全件_' + stamp() + '.csv'); } catch (error) { showToast('error', '書き出せませんでした。' + errorMessage(error)); }
    }

    boot();
})();
