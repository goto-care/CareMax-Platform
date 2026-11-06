// Assistive Device Manager (Jijogu) - app.js

// Firebase Configuration
// Firebase Configuration is loaded from ../auth.js
if (typeof firebaseConfig === 'undefined') {
    console.error("firebaseConfig not found. Make sure auth.js is loaded.");
}

// Initialize Firebase
let db;
let auth;
let persistencePromise = Promise.resolve();
try {
    if (typeof firebase !== 'undefined' && firebase.apps) {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        db = firebase.firestore();
        auth = firebase.auth();

        persistencePromise = db.enablePersistence({ synchronizeTabs: true })
            .catch((err) => {
                console.warn("Persistence error:", err.code);
            });
    } else {
        console.warn("Firebase SDK not loaded. Using local storage.");
    }
} catch (e) {
    console.warn("Firebase initialization failed, falling back to local storage:", e);
}

// Claude reads and writes this collection too (see the agreement in the 2026-11-05 proposal):
// saves only merge the changed fields, so fields this screen does not show (jijoguAuto, etc.) are kept.
const RECORDS_COLLECTION = 'jijogu_records';
const SETTINGS_COLLECTION = 'jijogu_settings';
const LOCAL_RECORDS_KEY = 'caremax-jijogu';
const LOCAL_STAFF_KEY = 'caremax-jijogu-staff';

const state = {
    records: [],
    statusFilter: '',
    staffNames: [],
    staffListSaved: false
};

let editingId = null;
let editingOriginal = null;
let autoFilledDates = {};
let quickAction = null;
let savingNew = false;

const FORM_FIELDS = Object.freeze({
    customerCode: 'f-customer-code',
    customerName: 'f-customer-name',
    status: 'f-status',
    setName: 'f-set-name',
    supportStaff: 'f-support-staff',
    salesStaff: 'f-sales-staff',
    requestDate: 'f-request-date',
    usageDate: 'f-usage-date',
    deliveryDate: 'f-delivery-date',
    shipDate: 'f-ship-date',
    expectedReturn: 'f-expected-return',
    returnDate: 'f-return-date',
    lastCheck: 'f-last-check',
    notes: 'f-notes'
});

const FIELD_LABELS = Object.freeze({
    customerCode: '得意先コード', customerName: '得意先名', status: '状況', setName: 'セット名',
    supportStaff: 'CMC対応担当', salesStaff: 'CMC営業担当', requestDate: '依頼日', usageDate: '使用日',
    deliveryDate: '納品希望日', shipDate: '発送日', expectedReturn: '返却予定日', returnDate: '返却日',
    lastCheck: '最終チェック日', notes: '備考', shipMethod: '発送のしかた', autoLabel: '送り状の自動発行',
    shipTo: '送り先', managementNo: '管理番号'
});

const HISTORY_ACTION_LABELS = Object.freeze({
    create: '新規登録', update: '編集', return: '返却を記録', check: '点検完了', cancel: '取消'
});

function el(id) {
    return document.getElementById(id);
}

function fieldValue(id) {
    return el(id).value;
}

function stripNotifyEmail(record) {
    if (!record || typeof record !== 'object') return record;
    const { notifyEmail, ...rest } = record;
    return rest;
}

function serverTime() {
    return typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue
        ? firebase.firestore.FieldValue.serverTimestamp()
        : new Date().toISOString();
}

function currentUserLabel() {
    const user = auth && auth.currentUser;
    return user ? { by: user.email || user.uid || '', byName: user.displayName || '' } : { by: '', byName: '' };
}

function maxManagementNo() {
    return state.records.reduce((max, r) => Math.max(max, Number(r.managementNo) || 0), 0);
}

// IDs stay millisecond numbers like the existing records, but never reuse one already on screen.
function newRecordId() {
    let id = Date.now();
    while (state.records.some(r => Number(r.id) === id)) id++;
    return id;
}

function recordTitle(record) {
    return 'No.' + (record.managementNo || '-') + (record.customerName ? '（' + record.customerName + '）' : '');
}

// Debounce helper
let renderTimeout;
function debounceRender() {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => {
        render();
    }, 100);
}

// Notices (B1: save failures are shown on screen, with a retry)
function showToast({ type = 'info', message, actionLabel, onAction }) {
    const area = el('toast-area');
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const text = document.createElement('p');
    text.textContent = message;
    toast.appendChild(text);
    const buttons = document.createElement('div');
    buttons.className = 'toast-actions';
    if (actionLabel && onAction) {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'toast-action';
        action.textContent = actionLabel;
        action.addEventListener('click', () => { toast.remove(); onAction(); });
        buttons.appendChild(action);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.textContent = '閉じる';
    close.addEventListener('click', () => toast.remove());
    buttons.appendChild(close);
    toast.appendChild(buttons);
    area.appendChild(toast);
    // Errors and warnings stay until someone reads them.
    if (type === 'success' || type === 'info') setTimeout(() => toast.remove(), 6000);
    return toast;
}

function errorReason(error) {
    const code = error && error.code;
    if (code === 'permission-denied') return '権限がありません。ログインし直してから、もう一度保存してください。';
    if (code === 'unavailable' || code === 'deadline-exceeded') return '通信できませんでした。つながってから、もう一度保存してください。';
    return 'もう一度保存してください。';
}

function showSaveError(record, retry, error) {
    showToast({
        type: 'error',
        message: recordTitle(record) + 'の保存に失敗しました。画面の内容はサーバーに保存されていません。' + errorReason(error),
        actionLabel: 'もう一度保存',
        onAction: retry
    });
}

// Init
function init() {
    if (db) {
        db.collection(RECORDS_COLLECTION).onSnapshot(snapshot => {
            state.records = [];
            snapshot.forEach(doc => {
                state.records.push(stripNotifyEmail({ id: doc.id, ...doc.data() }));
            });
            // Persist remote changes to local storage for offline robustness
            localStorage.setItem(LOCAL_RECORDS_KEY, JSON.stringify(state.records));
            debounceRender();
        }, error => {
            console.error("Error fetching jijogu records:", error);
            showToast({ type: 'error', message: 'サーバーから案件を読み込めませんでした。表示は前回の内容です。', actionLabel: '読み込み直す', onAction: () => location.reload() });
            loadLocalData();
        });
    } else {
        loadLocalData();
    }
    loadStaffList();
}

function loadLocalData() {
    const saved = localStorage.getItem(LOCAL_RECORDS_KEY);
    if (saved) {
        state.records = JSON.parse(saved).map(stripNotifyEmail);
    }
    debounceRender();
}

function applyLocal(record) {
    const idx = state.records.findIndex(r => r.id === record.id);
    if (idx > -1) state.records[idx] = record;
    else state.records.push(record);
    localStorage.setItem(LOCAL_RECORDS_KEY, JSON.stringify(state.records));
    debounceRender();
}

// Filters
function setFilter(status) {
    state.statusFilter = status;
    document.querySelectorAll('.filter-section')[0].querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    const id = { '': 'filter-all', '発送待': 'filter-waiting', '貸出中': 'filter-lending', '返却済': 'filter-returned', '取消': 'filter-cancelled' }[status] || 'filter-all';
    el(id).classList.add('active');
    debounceRender();
}

// Staff list (B4): the same notation as Cybozu users, so Claude can match schedule participants.
function readLocalStaff() {
    try {
        const names = JSON.parse(localStorage.getItem(LOCAL_STAFF_KEY) || 'null');
        return Array.isArray(names) ? names.filter(name => typeof name === 'string' && name.trim()) : null;
    } catch (e) {
        return null;
    }
}

function loadStaffList() {
    if (db) {
        db.collection(SETTINGS_COLLECTION).doc('staff').onSnapshot(doc => {
            const names = doc.exists && Array.isArray(doc.data().names) ? doc.data().names : [];
            setStaffNames(names, doc.exists);
        }, error => {
            // Until the list can be read, the names already used in records are offered instead.
            console.warn('Staff list unavailable:', error);
            setStaffNames([], false);
        });
    } else {
        const names = readLocalStaff();
        setStaffNames(names || [], names !== null);
    }
}

function setStaffNames(names, saved) {
    state.staffNames = names;
    state.staffListSaved = saved;
    if (!el('record-modal').classList.contains('hidden')) refreshStaffSelects();
}

function draftStaffNames() {
    const names = state.records.flatMap(r => [r.supportStaff, r.salesStaff]).filter(name => typeof name === 'string' && name.trim()).map(name => name.trim());
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'ja'));
}

// Before the list is made once, the names already used in records are offered so registration is never blocked.
function staffOptions() {
    return state.staffListSaved ? state.staffNames : draftStaffNames();
}

function fillStaffSelect(id, current) {
    const select = el(id);
    const names = staffOptions();
    select.replaceChildren();
    const add = (value, text) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
    };
    add('', '（選んでください）');
    names.forEach(name => add(name, name));
    // Keep values that are not in the list, so opening and saving never drops them.
    if (current && !names.includes(current)) add(current, current + '（一覧にない表記）');
    select.value = current || '';
}

function refreshStaffSelects() {
    fillStaffSelect('f-support-staff', fieldValue('f-support-staff'));
    fillStaffSelect('f-sales-staff', fieldValue('f-sales-staff'));
    el('staff-empty-note').classList.toggle('hidden', state.staffListSaved);
}

function openStaffEditor() {
    el('staff-list-input').value = staffOptions().join('\n');
    el('staff-draft-note').classList.toggle('hidden', state.staffListSaved);
    el('staff-modal').classList.remove('hidden');
}

function closeStaffEditor() {
    el('staff-modal').classList.add('hidden');
}

async function saveStaffList() {
    const names = [...new Set(fieldValue('staff-list-input').split(/\r?\n/).map(name => name.trim()).filter(Boolean))];
    setStaffNames(names, true);
    closeStaffEditor();
    if (!db) {
        localStorage.setItem(LOCAL_STAFF_KEY, JSON.stringify(names));
        return;
    }
    try {
        await db.collection(SETTINGS_COLLECTION).doc('staff').set({ names, updatedAt: serverTime(), updatedBy: currentUserLabel().by });
    } catch (error) {
        console.error('Staff list save failed:', error);
        showToast({ type: 'error', message: '担当者の一覧を保存できませんでした。' + errorReason(error), actionLabel: '一覧を開く', onAction: openStaffEditor });
    }
}

// Shipping fields (A1, A2)
function setOptionalSelect(selectId, unsetOptionId, value) {
    // "未設定" is shown only for older records that were registered before the field existed.
    el(unsetOptionId).hidden = value !== '';
    el(selectId).value = value;
}

function fillShippingFields(record) {
    setOptionalSelect('f-ship-method', 'ship-method-unset', record ? record.shipMethod || '' : 'sagawa');
    el('f-auto-label').checked = record ? !!record.autoLabel : true;
    const kind = record ? shipToKind(record) : 'customer';
    setOptionalSelect('f-ship-to-kind', 'ship-to-unset', kind);
    const shipTo = (record && record.shipTo) || {};
    const lines = Array.isArray(shipTo.addressLines) ? shipTo.addressLines : [];
    el('f-ship-to-name').value = shipTo.name || '';
    el('f-ship-to-person').value = shipTo.person || '';
    el('f-ship-to-zip').value = shipTo.zip || '';
    el('f-ship-to-tel').value = shipTo.tel || '';
    el('f-ship-to-address1').value = lines[0] || '';
    el('f-ship-to-address2').value = lines.slice(1).join(' ');
    el('f-ship-to-code').value = shipTo.subDestCode || '';
}

function updateShipFields() {
    const method = fieldValue('f-ship-method');
    const kind = fieldValue('f-ship-to-kind');
    el('auto-label-group').classList.toggle('hidden', method !== 'sagawa');
    document.querySelectorAll('.ship-other-only').forEach(node => node.classList.toggle('hidden', kind !== 'other'));
    document.querySelectorAll('.ship-code-only').forEach(node => node.classList.toggle('hidden', kind !== 'code'));
    el('ship-name-group').classList.toggle('hidden', kind !== 'other' && kind !== 'code');
    el('ship-name-label').textContent = kind === 'code' ? '送り先名（わかれば）' : '送り先名';
    el('ship-customer-note').classList.toggle('hidden', kind !== 'customer');
    el('ship-unset-note').classList.toggle('hidden', kind !== '');
    updateLabelIssueNote();
}

// When the label will be issued (shown once the ship date is set), or that it already has been.
function updateLabelIssueNote() {
    const note = el('label-issue-note');
    const method = fieldValue('f-ship-method');
    const trackingNo = editingOriginal && method === 'sagawa' ? autoInfoValue(editingOriginal, '送り状番号') : '';
    const info = trackingNo
        ? { tone: 'done', text: '送り状は発行済みです（送り状番号 ' + trackingNo + '）。' }
        : labelIssueInfo({
            shipMethod: method,
            autoLabel: !!el('f-auto-label').checked,
            shipDate: fieldValue('f-ship-date'),
            createdAt: editingOriginal ? editingOriginal.createdAt : ''
        }, { isNew: editingId === null });
    note.textContent = info ? info.text : '';
    note.className = 'label-issue-note field-full' + (info ? ' tone-' + info.tone : ' hidden');
}

function toHalfWidth(value) {
    return String(value || '').trim()
        .replace(/[０-９Ａ-Ｚａ-ｚ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
        .replace(/[－ー―‐−]/g, '-');
}

// Same shape as Claude's jijoguAuto.dest. null = the customer's own address.
function readShipTo(kind) {
    if (kind === 'customer') return null;
    const name = fieldValue('f-ship-to-name').trim();
    if (kind === 'code') {
        return { name, person: '', zip: '', tel: '', addressLines: [], subDestCode: toHalfWidth(fieldValue('f-ship-to-code')) };
    }
    return {
        name,
        person: fieldValue('f-ship-to-person').trim(),
        zip: toHalfWidth(fieldValue('f-ship-to-zip')),
        tel: toHalfWidth(fieldValue('f-ship-to-tel')),
        addressLines: [fieldValue('f-ship-to-address1').trim(), fieldValue('f-ship-to-address2').trim()].filter(Boolean),
        subDestCode: ''
    };
}

function validateShipping(data, kind) {
    if (kind === 'code' && !data.shipTo.subDestCode) return '送付先CDを入力してください。';
    if (kind === 'other') {
        if (!data.shipTo.name || !data.shipTo.addressLines.length) return '別の送り先の「送り先名」と「住所（1行目）」を入力してください。';
        if (data.autoLabel && (!data.shipTo.zip || !data.shipTo.tel)) return '送り状を自動で出すには、送り先の郵便番号と電話番号も入力してください。';
    }
    return '';
}

// Dates (A3) and status (A5)
function setAutoDate(id, value, force) {
    const input = el(id);
    // A date someone typed is kept; only empty or previously auto-filled dates follow the usage date.
    if (!force && input.value && input.value !== autoFilledDates[id]) return false;
    input.value = value;
    autoFilledDates[id] = value;
    return true;
}

function fillDatesFromUsage(force = false) {
    const usage = fieldValue('f-usage-date');
    const hint = el('schedule-hint');
    if (parseCalendarDate(usage)) {
        const planned = scheduleFromUsage(usage);
        if (!planned.deliveryDate || !planned.expectedReturn) {
            hint.textContent = '祝日データの対象期間外のため、日付を自動で入れられませんでした。手で入力してください。';
        } else {
            const kept = [];
            if (!setAutoDate('f-delivery-date', planned.deliveryDate, force)) kept.push('納品希望日');
            if (!setAutoDate('f-ship-date', addBusinessDays(fieldValue('f-delivery-date'), -SCHEDULE_RULES.shipBeforeDelivery), force)) kept.push('発送日');
            if (!setAutoDate('f-expected-return', planned.expectedReturn, force)) kept.push('返却予定日');
            hint.textContent = kept.length
                ? '使用日から計算しました。' + kept.join('・') + 'は入力済みのため変えていません（「使用日から入れ直す」で上書きできます）。'
                : '使用日から納品希望日・発送日・返却予定日を入れました。手で直せます。';
        }
    }
    updateLabelIssueNote();
    updateDeliveryWarning();
}

function onDeliveryDateInput() {
    setAutoDate('f-ship-date', addBusinessDays(fieldValue('f-delivery-date'), -SCHEDULE_RULES.shipBeforeDelivery), false);
    updateLabelIssueNote();
    updateDeliveryWarning();
}

function returnedStatus(status, returnDate, lastCheck) {
    return (returnDate || lastCheck) && (status === '発送待' || status === '貸出中') ? '返却済' : status;
}

function syncStatusField() {
    const status = el('f-status');
    status.value = returnedStatus(status.value, fieldValue('f-return-date'), fieldValue('f-last-check'));
    updateDeliveryWarning();
}

// Modal
function resetScheduleHint() {
    el('schedule-hint').textContent = '使用日を入れると、納品希望日（' + SCHEDULE_RULES.deliveryBeforeUsage + '営業日前）・発送日（納品希望日の' +
        SCHEDULE_RULES.shipBeforeDelivery + '営業日前）・返却予定日（' + SCHEDULE_RULES.returnAfterUsage + '営業日後）を自動で入れます。土日祝は数えません。手で直せます。';
}

function renderAutoInfo(record) {
    const entries = record ? autoInfoEntries(record) : [];
    el('auto-info-section').classList.toggle('hidden', !entries.length);
    el('auto-info-list').innerHTML = entries.map(entry => '<div><dt>' + escapeHTML(entry.label) + '</dt><dd>' + escapeHTML(entry.value) + '</dd></div>').join('');
}

function openModal(id = null) {
    const record = id === null ? null : state.records.find(r => r.id === id);
    if (id !== null && !record) return;
    editingId = id;
    editingOriginal = record ? { ...record } : null;
    autoFilledDates = {};

    for (const [key, fieldId] of Object.entries(FORM_FIELDS)) {
        el(fieldId).value = record ? record[key] || '' : '';
    }
    if (record) {
        el('modal-title').textContent = '案件の詳細・編集';
        el('f-management-no').value = 'No.' + (record.managementNo || '-');
        el('f-status').value = record.status || '発送待';
        el('f-set-name').value = record.setName || 'X';
    } else {
        el('modal-title').textContent = '新規登録';
        el('f-management-no').value = 'No.' + (maxManagementNo() + 1) + (db ? '（保存時に決まります）' : '');
        el('f-status').value = '発送待';
        el('f-set-name').value = 'X';
        el('f-request-date').value = localToday();
    }
    fillStaffSelect('f-support-staff', record ? record.supportStaff || '' : '');
    fillStaffSelect('f-sales-staff', record ? record.salesStaff || '' : '');
    el('staff-empty-note').classList.toggle('hidden', state.staffListSaved);
    fillShippingFields(record);
    updateShipFields();
    resetScheduleHint();
    renderAutoInfo(record);
    el('cancel-record-btn').classList.toggle('hidden', !record || record.status === '取消');
    el('history-section').classList.toggle('hidden', !record || !db);
    el('history-list').replaceChildren();
    el('history-status').textContent = '';

    el('record-modal').classList.remove('hidden');
    updateDeliveryWarning();
}

function closeModal() {
    el('record-modal').classList.add('hidden');
    editingId = null;
    editingOriginal = null;
}

function readForm() {
    const data = {};
    for (const [key, fieldId] of Object.entries(FORM_FIELDS)) data[key] = String(fieldValue(fieldId)).trim();
    const method = fieldValue('f-ship-method');
    if (method) {
        data.shipMethod = method;
        data.autoLabel = method === 'sagawa' && !!el('f-auto-label').checked;
    }
    const kind = fieldValue('f-ship-to-kind');
    if (kind) data.shipTo = readShipTo(kind);
    data.status = returnedStatus(data.status, data.returnDate, data.lastCheck);
    return { data, kind };
}

function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
}

// Only fields that differ from the record as it was when the dialog opened are written.
function changedFields(original, data) {
    const changes = {};
    for (const [key, after] of Object.entries(data)) {
        const before = original[key];
        if (key === 'shipTo') {
            if (before === undefined || stableStringify(before) !== stableStringify(after)) changes[key] = after;
        } else if (typeof after === 'boolean') {
            if (before !== after) changes[key] = after;
        } else if (String(before ?? '') !== String(after ?? '')) {
            changes[key] = after;
        }
    }
    return changes;
}

function displayValue(field, value) {
    if (field === 'shipTo') return value === undefined ? '' : formatShipTo(value);
    if (field === 'shipMethod') return SHIP_METHOD_LABELS[value] || String(value ?? '');
    if (field === 'autoLabel') return value === undefined ? '' : value ? 'する' : 'しない';
    return String(value ?? '');
}

function describeChanges(original, changes) {
    return Object.keys(changes).map(field => ({
        field,
        label: FIELD_LABELS[field] || field,
        before: original ? displayValue(field, original[field]) : '',
        after: displayValue(field, changes[field])
    }));
}

// History (B5): who changed what and when, in a subcollection so the record itself stays as it is.
function writeHistory(id, action, changes) {
    if (!db || !changes.length) return;
    db.collection(RECORDS_COLLECTION).doc(String(id)).collection('history').add({
        at: serverTime(),
        clientAt: new Date().toISOString(),
        ...currentUserLabel(),
        action,
        changes
    }).catch(error => console.warn('History write failed:', error));
}

async function loadHistory() {
    const list = el('history-list');
    const status = el('history-status');
    list.replaceChildren();
    if (!db || editingId === null) {
        status.textContent = 'この画面では履歴を読み込めません。';
        return;
    }
    const id = editingId;
    status.textContent = '読み込んでいます…';
    try {
        const snapshot = await db.collection(RECORDS_COLLECTION).doc(String(id)).collection('history').orderBy('at', 'desc').limit(30).get();
        if (editingId !== id) return;
        status.textContent = snapshot.empty ? 'まだ履歴はありません（この機能を入れた後の変更から残ります）。' : '';
        snapshot.forEach(doc => {
            const entry = doc.data();
            const item = document.createElement('li');
            const when = formatAutoValue(entry.at) || formatAutoValue(entry.clientAt);
            const head = document.createElement('p');
            head.className = 'history-head';
            head.textContent = when + '　' + (entry.byName || entry.by || '不明') + '　' + (HISTORY_ACTION_LABELS[entry.action] || entry.action || '');
            item.appendChild(head);
            const changes = document.createElement('ul');
            (entry.changes || []).forEach(change => {
                const line = document.createElement('li');
                line.textContent = change.label + '：' + (change.before || '（空）') + ' → ' + (change.after || '（空）');
                changes.appendChild(line);
            });
            item.appendChild(changes);
            list.appendChild(item);
        });
    } catch (error) {
        console.warn('History read failed:', error);
        status.textContent = '履歴を読み込めませんでした。';
    }
}

// Saving
async function saveChanges(original, changes, action) {
    const id = original.id;
    const current = state.records.find(r => r.id === id) || original;
    applyLocal(stripNotifyEmail({ ...current, ...changes }));
    if (!db) return true;
    try {
        // merge: only these fields change; jijoguAuto and every other existing field stay as they are on the server.
        await db.collection(RECORDS_COLLECTION).doc(String(id)).set(changes, { merge: true });
    } catch (error) {
        console.error('Save failed:', error);
        showSaveError(current, () => saveChanges(original, changes, action), error);
        return false;
    }
    writeHistory(id, action, describeChanges(original, changes));
    return true;
}

async function persistNewRecord(record, data) {
    try {
        await db.collection(RECORDS_COLLECTION).doc(String(record.id)).set(stripNotifyEmail(record), { merge: true });
    } catch (error) {
        console.error('Save failed:', error);
        showSaveError(record, () => persistNewRecord(record, data), error);
        return false;
    }
    writeHistory(record.id, 'create', describeChanges(null, data));
    return true;
}

// B2: the number is decided in a transaction against a counter, so two people saving at once never share it.
// Records written by others without the counter are respected through the highest number already stored.
async function createWithServerNumber(base, data) {
    const records = db.collection(RECORDS_COLLECTION);
    const counterRef = db.collection(SETTINGS_COLLECTION).doc('managementNo');
    let storedMax = 0;
    try {
        const top = await records.orderBy('managementNo', 'desc').limit(1).get();
        top.forEach(doc => { storedMax = Math.max(storedMax, Number(doc.data().managementNo) || 0); });
    } catch (error) {
        console.warn('Could not read the highest management number:', error);
    }
    return db.runTransaction(async tx => {
        const counter = await tx.get(counterRef);
        // Someone else may have taken the same millisecond ID: move to the next free one.
        let id = base.id;
        while ((await tx.get(records.doc(String(id)))).exists) id++;
        const last = counter.exists ? Number(counter.data().last) || 0 : 0;
        const managementNo = Math.max(last, storedMax, maxManagementNo()) + 1;
        tx.set(counterRef, { last: managementNo, updatedAt: serverTime() }, { merge: true });
        tx.set(records.doc(String(id)), { id, managementNo, createdAt: base.createdAt, ...data });
        return { id, managementNo };
    });
}

function setSaving(saving) {
    savingNew = saving;
    const button = el('save-btn');
    button.disabled = saving;
    button.textContent = saving ? '保存中…' : '保存';
}

async function createRecord(data) {
    const base = { id: newRecordId(), createdAt: new Date().toISOString() };
    const build = (managementNo, id = base.id) => ({ id, managementNo, createdAt: base.createdAt, ...data });
    if (!db) {
        applyLocal(build(maxManagementNo() + 1));
        closeModal();
        return;
    }
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (!offline) {
        setSaving(true);
        try {
            const { id, managementNo } = await createWithServerNumber(base, data);
            setSaving(false);
            applyLocal(build(managementNo, id));
            closeModal();
            showToast({ type: 'success', message: 'No.' + managementNo + ' で登録しました。' });
            writeHistory(id, 'create', describeChanges(null, data));
            return;
        } catch (error) {
            setSaving(false);
            console.warn('Management number transaction failed:', error);
        }
    }
    // Fallback (offline, or the counter could not be used): number on this screen as before; Firestore sends it when it can.
    const record = build(maxManagementNo() + 1);
    applyLocal(record);
    closeModal();
    showToast({
        type: 'warning',
        message: (offline ? 'オフラインのため、' : '管理番号をサーバーで確かめられなかったため、') + '画面側で No.' + record.managementNo + ' を付けました。ほかの人の登録と番号が重なっていないか確認してください。'
    });
    persistNewRecord(record, data);
}

async function saveRecord() {
    if (savingNew) return;
    const { data, kind } = readForm();

    if (!data.customerCode || !data.customerName) {
        alert('得意先コードと得意先名を入力してください');
        return;
    }
    const shippingError = validateShipping(data, kind);
    if (shippingError) {
        alert(shippingError);
        return;
    }

    const original = editingId === null ? null : editingOriginal;
    const changes = original ? changedFields(original, data) : data;
    if (original && !Object.keys(changes).length) {
        closeModal();
        return;
    }

    // Warn at save only when this save touches the schedule, so recording a return on a tight booking does not nag.
    const deliveryWarning = updateDeliveryWarning();
    const scheduleTouched = !original || ['setName', 'status', 'deliveryDate', 'expectedReturn', 'returnDate', 'lastCheck'].some(key => key in changes);
    if (deliveryWarning && scheduleTouched && !confirm(deliveryWarning.message + '\n\nこの日程で登録しますか？')) return;

    if (original) {
        closeModal();
        await saveChanges(original, changes, 'update');
        return;
    }
    await createRecord(data);
}

// C2: cancelled bookings stay on record with status 取消 (Claude's Cybozu / Notion records keep matching).
function cancelRecord() {
    if (editingId === null) return;
    const record = state.records.find(r => r.id === editingId) || editingOriginal;
    if (!record) return;
    if (!confirm(recordTitle(record) + ' を取り消しますか？\n\n削除はせず、状況を「取消」にして記録を残します。')) return;
    closeModal();
    saveChanges(record, { status: '取消' }, 'cancel');
}

// Quick actions on cards (A5)
function openQuickAction(id, kind) {
    const record = state.records.find(r => r.id === id);
    if (!record) return;
    quickAction = { id, kind };
    const isReturn = kind === 'return';
    el('quick-title').textContent = isReturn ? '返却を記録' : '点検完了を記録';
    el('quick-description').textContent = recordTitle(record) + '・セット ' + (record.setName || '未設定');
    el('quick-label').textContent = isReturn ? '返却日' : '最終チェック日（点検した日）';
    el('quick-note').textContent = isReturn
        ? '記録すると、状況が「返却済」になります（点検が済んだら「点検完了」を押してください）。'
        : '記録すると「確認完了」になり、このセットの案件はおしまいです。';
    el('quick-date').value = localToday();
    el('quick-modal').classList.remove('hidden');
}

function closeQuickAction() {
    el('quick-modal').classList.add('hidden');
    quickAction = null;
}

function confirmQuickAction() {
    if (!quickAction) return;
    const value = fieldValue('quick-date');
    if (!parseCalendarDate(value)) {
        alert('日付を入力してください');
        return;
    }
    const record = state.records.find(r => r.id === quickAction.id);
    const kind = quickAction.kind;
    closeQuickAction();
    if (!record) return;
    const fields = kind === 'return' ? { returnDate: value } : { lastCheck: value };
    const status = returnedStatus(record.status || '', kind === 'return' ? value : record.returnDate, kind === 'check' ? value : record.lastCheck);
    if (status !== (record.status || '')) fields.status = status;
    saveChanges(record, fields, kind);
}

// Board rendering is defined in board.js.

// Export CSV
function exportCSV() {
    const headers = ['得意先コード', '得意先名', '状況', 'セット名', 'CMC対応担当', 'CMC営業担当', '依頼日', '使用日', '納品希望日', '発送日', '返却予定日', '返却日', '最終チェック日', '備考',
        '発送のしかた', '送り状の自動発行', '送り先', '送り先名', '宛名', '郵便番号', '住所1', '住所2', '電話番号', '送付先CD'];
    let csv = '﻿' + headers.join(',') + '\n';

    const escapeCSV = (field) => {
        if (field === null || field === undefined) return '';
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    };

    state.records.forEach(r => {
        const shipTo = r.shipTo || {};
        const lines = Array.isArray(shipTo.addressLines) ? shipTo.addressLines : [];
        const kind = shipToKind(r);
        const row = [
            r.customerCode, r.customerName, r.status, r.setName, r.supportStaff, r.salesStaff,
            r.requestDate, r.usageDate, r.deliveryDate, r.shipDate, r.expectedReturn, r.returnDate, r.lastCheck, r.notes,
            SHIP_METHOD_LABELS[r.shipMethod] || '',
            r.shipMethod === 'sagawa' ? (r.autoLabel ? 'する' : 'しない') : '',
            SHIP_TO_KIND_LABELS[kind] || '',
            shipTo.name, shipTo.person, shipTo.zip, lines[0], lines.slice(1).join(' '), shipTo.tel, shipTo.subDestCode
        ].map(escapeCSV);
        csv += row.join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `jijogu_${localToday()}`;
    link.download += '.csv';
    link.click();
}

// Global assignments
Object.assign(window, {
    setFilter, openModal, closeModal, saveRecord, cancelRecord, exportCSV,
    updateShipFields, updateLabelIssueNote, fillDatesFromUsage, onDeliveryDateInput, syncStatusField,
    openQuickAction, closeQuickAction, confirmQuickAction,
    openStaffEditor, closeStaffEditor, saveStaffList, loadHistory
});

// Start
persistencePromise.finally(() => {
    // Wait for Auth to be ready before initializing DB listeners
    if (auth) {
        auth.onAuthStateChanged((user) => {
            if (user) {
                console.log("Jijogu: Authenticated as", user.email);
                init();
            } else {
                console.warn("Jijogu: No user logged in. Using local data.");
                loadLocalData();
            }
        });
    } else {
        // Fallback for when Firebase isn't loaded or configured (Demo/Offline)
        try {
            init();
            console.log("Jijogu App Initialized (Local Mode)");
        } catch (e) {
            console.error("Jijogu Init Failed:", e);
            loadLocalData();
        }
    }
});
