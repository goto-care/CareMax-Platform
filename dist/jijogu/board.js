// Presentation only: existing records are never changed by this board.
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

const SHIP_METHOD_LABELS = Object.freeze({
    sagawa: '当社から佐川で発送',
    direct: '他拠点・営業から直送',
    handover: '手渡し・引き取り'
});

const SHIP_TO_KIND_LABELS = Object.freeze({
    customer: '得意先の住所',
    other: '別の送り先',
    code: '販売管理の送付先CD'
});

function recordPhase(record) {
    if (record.status === '取消') return 'cancelled';
    // A return date or final check means the set is back, even when an older status was left unchanged.
    if (record.lastCheck || record.status === '返却済' || record.returnDate) return 'returned';
    if (record.status === '貸出中') return 'lending';
    return 'waiting';
}

// '' = not entered with the shipping fields yet (older records); the notes may still say where to send.
function shipToKind(record) {
    if (!record || record.shipTo === undefined) return '';
    if (!record.shipTo) return 'customer';
    return record.shipTo.subDestCode ? 'code' : 'other';
}

function formatShipTo(shipTo) {
    if (shipTo === null) return SHIP_TO_KIND_LABELS.customer;
    if (!shipTo || typeof shipTo !== 'object') return '';
    if (shipTo.subDestCode) return '送付先CD ' + shipTo.subDestCode + (shipTo.name ? '（' + shipTo.name + '）' : '');
    const lines = Array.isArray(shipTo.addressLines) ? shipTo.addressLines.filter(Boolean) : [];
    return [
        shipTo.zip ? '〒' + shipTo.zip : '',
        lines.join(' '),
        shipTo.name || '',
        shipTo.person ? shipTo.person + ' 様' : '',
        shipTo.tel ? 'TEL ' + shipTo.tel : ''
    ].filter(Boolean).join(' ');
}

function shippingChip(record) {
    if (record.shipMethod === 'sagawa') {
        return record.autoLabel
            ? { className: 'ship-auto', text: '佐川・送り状は自動' }
            : { className: 'ship-manual', text: '佐川・送り状は手で' };
    }
    if (record.shipMethod === 'direct') return { className: 'ship-direct', text: '直送' };
    if (record.shipMethod === 'handover') return { className: 'ship-handover', text: '手渡し・引き取り' };
    return null;
}

// Fields Claude writes under jijoguAuto (not entered on this screen). Unknown keys are shown as they are.
const AUTO_INFO_LABELS = Object.freeze({
    trackingNo: '送り状番号', trackingNumber: '送り状番号', slipNo: '送り状番号', waybillNo: '送り状番号', invoiceNo: '送り状番号', okurijoNo: '送り状番号',
    deliveryStatus: '配達状況', trackingStatus: '配達状況',
    autoIssue: '送り状の自動発行', autoIssued: '送り状の自動発行', issued: '送り状の発行', issuedAt: '送り状の発行日時',
    issuing: '発行中の印', issuingAt: '発行を始めた日時', lock: '発行中の印',
    switchDate: '切り替え日', switchedAt: '切り替え日', switchedOn: '切り替え日',
    cybozu: 'サイボウズ予定', cybozuEventId: 'サイボウズ予定', cybozuEvents: 'サイボウズ予定', cybozuSchedule: 'サイボウズ予定',
    notion: 'Notion', notionPageId: 'Notion',
    dest: '送り先（自動処理が使う）',
    updatedAt: '最終更新'
});

function formatAutoDate(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
    return localToday(date) + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

function formatAutoValue(value, key = '') {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') {
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? formatAutoDate(new Date(value)) || value : value;
    }
    if (value instanceof Date) return formatAutoDate(value);
    if (typeof value.toDate === 'function') return formatAutoDate(value.toDate());
    if (typeof value.seconds === 'number' && Object.keys(value).every(name => name === 'seconds' || name === 'nanoseconds')) {
        return formatAutoDate(new Date(value.seconds * 1000));
    }
    if (Array.isArray(value)) return value.map(item => formatAutoValue(item)).filter(Boolean).join('、');
    if (key === 'dest' || 'addressLines' in value || 'subDestCode' in value) return formatShipTo(value);
    return Object.keys(value)
        .map(name => [name, formatAutoValue(value[name], name)])
        .filter(([, text]) => text)
        .map(([name, text]) => (AUTO_INFO_LABELS[name] || name) + '：' + text)
        .join(' / ');
}

function autoInfoEntries(record) {
    const auto = record && record.jijoguAuto;
    if (!auto || typeof auto !== 'object') return [];
    const known = Object.keys(AUTO_INFO_LABELS);
    const keys = Object.keys(auto).sort((a, b) => {
        const ai = known.indexOf(a);
        const bi = known.indexOf(b);
        return (ai < 0 ? known.length : ai) - (bi < 0 ? known.length : bi) || a.localeCompare(b);
    });
    return keys
        .map(key => ({ key, label: AUTO_INFO_LABELS[key] || key, value: formatAutoValue(auto[key], key) }))
        .filter(entry => entry.value);
}

function autoInfoValue(record, label) {
    const entry = autoInfoEntries(record).find(item => item.label === label);
    return entry ? entry.value : '';
}

function scheduleDate(record) {
    return record.deliveryDate || record.shipDate || record.usageDate || record.requestDate || '';
}

function registeredTime(record) {
    const created = record.createdAt ? Date.parse(record.createdAt) : NaN;
    if (Number.isFinite(created)) return created;
    // Legacy records used a millisecond timestamp as their ID.
    const id = Number(record.id);
    return Number.isFinite(id) && id >= 100000000000 ? id : null;
}

function sortedRecords(records) {
    return [...records].sort((a, b) => {
        const aTime = registeredTime(a);
        const bTime = registeredTime(b);
        if (aTime !== null || bTime !== null) {
            if (aTime === null) return 1;
            if (bTime === null) return -1;
            if (aTime !== bTime) return bTime - aTime;
        }
        // Management numbers increase at registration, including records without createdAt.
        return (Number(b.managementNo) || 0) - (Number(a.managementNo) || 0) ||
            String(b.requestDate || scheduleDate(b)).localeCompare(String(a.requestDate || scheduleDate(a)));
    });
}

// Board order: current loans last; otherwise undated records first, then the latest delivery date.
// Ties keep registration order.
function displayRecords(records) {
    const registered = sortedRecords(records);
    return registered.sort((a, b) => {
        const aLending = recordPhase(a) === 'lending';
        const bLending = recordPhase(b) === 'lending';
        if (aLending !== bLending) return aLending ? 1 : -1;
        const aDate = a.deliveryDate || '';
        const bDate = b.deliveryDate || '';
        if (!aDate && bDate) return -1;
        if (aDate && !bDate) return 1;
        return bDate.localeCompare(aDate);
    });
}

function nextWaitingRecord(records) {
    return records.filter(record => recordPhase(record) === 'waiting').sort((a, b) => {
        const aDate = a.deliveryDate || a.shipDate || a.usageDate || '';
        const bDate = b.deliveryDate || b.shipDate || b.usageDate || '';
        if (!aDate && bDate) return 1;
        if (aDate && !bDate) return -1;
        return aDate.localeCompare(bDate) || (Number(a.managementNo) || 0) - (Number(b.managementNo) || 0);
    })[0] || null;
}

function matchesStatusFilter(record, filter) {
    const phase = recordPhase(record);
    if (filter === '取消') return phase === 'cancelled';
    if (phase === 'cancelled') return false;
    // Final check marks completion, even when an older status was left unchanged.
    if (filter === '返却済') return phase === 'returned';
    if (record.lastCheck) return false;
    if (filter === '発送待') return phase === 'waiting';
    if (filter === '貸出中') return phase === 'lending';
    return true;
}

function cardLabel(record, phase, isNextShipment) {
    if (phase === 'cancelled') return '取消';
    if (record.lastCheck) return '確認完了';
    if (isNextShipment) return '次の発送・発送待';
    if (phase === 'waiting') return '予約済・発送待';
    if (phase === 'returned') return '返却済・確認待ち';
    return record.status || '状況未設定';
}

function createRecordCard(record, isNextShipment = false) {
    const phase = recordPhase(record);
    const card = document.createElement('article');
    const isCurrent = !record.lastCheck && (phase === 'lending' || phase === 'returned');
    card.className = 'record-card phase-' + phase + (record.lastCheck ? ' checked-card' : '') + (isCurrent ? ' current-card' : '') + (isNextShipment ? ' next-shipment-card' : '');
    const label = cardLabel(record, phase, isNextShipment);
    const statusIcon = !record.lastCheck && (phase === 'lending' || phase === 'waiting')
        ? '<span class="card-status-icon" aria-hidden="true">' + (phase === 'lending' ? '↗' : '⇧') + '</span>' : '';
    const chip = shippingChip(record);
    const kind = shipToKind(record);
    const destination = kind === 'other' ? '送り先：' + (record.shipTo.name || '名称未入力') : kind === 'code' ? '送付先CD ' + record.shipTo.subDestCode : '';
    const shipping = chip || destination
        ? '<p class="card-shipping">' + (chip ? '<span class="ship-chip ' + chip.className + '">' + escapeHTML(chip.text) + '</span>' : '') +
            (destination ? '<span class="ship-dest">' + escapeHTML(destination) + '</span>' : '') + '</p>'
        : '';
    const autoParts = [autoInfoValue(record, '送り状番号'), autoInfoValue(record, '配達状況')];
    // Before the label exists, a reservation shows the morning it will be issued.
    const issue = !autoParts[0] && phase === 'waiting' && typeof labelIssueInfo === 'function' ? labelIssueInfo(record) : null;
    const autoText = autoParts[0] || autoParts[1]
        ? (autoParts[0] ? '送り状 ' + autoParts[0] : '') + (autoParts[0] && autoParts[1] ? '・' : '') + autoParts[1]
        : issue && issue.date ? '送り状：' + formatShortDate(issue.date) + ' の朝に自動で出ます' : '';
    const auto = autoText ? '<p class="card-auto">' + escapeHTML(autoText) + '</p>' : '';
    const actions = [];
    if (phase === 'lending') actions.push('<button type="button" class="card-action action-return" data-action="return">返却を記録</button>');
    if (phase === 'returned' && !record.lastCheck) actions.push('<button type="button" class="card-action action-check" data-action="check">点検完了</button>');
    card.innerHTML = '<div class="card-top"><strong>No.' + escapeHTML(record.managementNo || '-') + '</strong>' +
        '<span class="status-badge badge-' + phase + '">' + statusIcon + escapeHTML(label) + '</span></div>' +
        '<span class="customer-code">得意先CD ' + escapeHTML(record.customerCode || '-') + '</span>' +
        '<span class="customer-name">' + escapeHTML(record.customerName || '得意先未設定') + '</span>' +
        shipping +
        '<dl class="card-dates"><div><dt>納品希望日</dt><dd>' + escapeHTML(record.deliveryDate || '未設定') + '</dd></div>' +
        '<div><dt>返却予定日</dt><dd>' + escapeHTML(record.expectedReturn || '未設定') + '</dd></div></dl>' +
        auto +
        '<div class="card-footer">' + actions.join('') +
        '<button type="button" class="card-link" data-action="open">詳細・編集 <span aria-hidden="true">→</span></button></div>';
    // The whole card opens the details; the return/check buttons record just that step.
    card.addEventListener('click', event => {
        const target = event && event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-action]') : null;
        const action = target ? target.dataset.action : 'open';
        if (action === 'return' || action === 'check') openQuickAction(record.id, action);
        else openModal(record.id);
    });
    return card;
}

function renderCalendarNotice() {
    const notice = document.getElementById('calendar-notice');
    if (!notice || typeof holidayDataNotice !== 'function') return;
    const text = holidayDataNotice();
    notice.textContent = text;
    notice.classList.toggle('hidden', !text);
}

function render() {
    const board = document.getElementById('sets-board');
    board.replaceChildren();
    // Keep records with older or unexpected set names visible, too.
    const setNames = [...new Set(['X', 'Y', 'Z', ...state.records.map(r => r.setName || '未設定')])];
    let visibleCount = 0;
    setNames.forEach(name => {
        const records = state.records.filter(r => (r.setName || '未設定') === name);
        const filtered = records.filter(r => matchesStatusFilter(r, state.statusFilter));
        visibleCount += filtered.length;
        const column = document.createElement('section');
        const setClass = { X: 'set-x', Y: 'set-y', Z: 'set-z' }[name] || 'set-neutral';
        column.className = 'set-column ' + setClass;
        const lending = records.filter(r => recordPhase(r) === 'lending').length;
        const waiting = records.filter(r => recordPhase(r) === 'waiting').length;
        const checking = records.filter(r => !r.lastCheck && recordPhase(r) === 'returned').length;
        const nextShipment = lending ? null : nextWaitingRecord(records);
        const setStatus = lending ? { key: 'lending', label: '貸出中', icon: '↗' } :
            waiting ? { key: 'waiting', label: '発送待', icon: '⇧' } : { key: 'free', label: 'フリー', icon: '✓' };
        const heading = document.createElement('header');
        heading.className = 'set-heading';
        heading.innerHTML = '<div class="set-heading-top"><h2>セット ' + escapeHTML(name) + '</h2>' +
            '<span class="set-status set-status-' + setStatus.key + '"><span aria-hidden="true">' + setStatus.icon + '</span> ' + setStatus.label + '</span></div>' +
            '<div class="set-meta">' + (waiting ? '<span class="reservation-count">予約 ' + waiting + '件</span>' : '<span>予約なし</span>') +
            (checking ? '<span class="checking-count">返却後の確認待ち ' + checking + '件</span>' : '') + '</div>';
        column.appendChild(heading);
        if (filtered.length) {
            const section = document.createElement('section');
            section.className = 'record-list';
            const title = document.createElement('h3');
            title.className = 'phase-title';
            title.textContent = '納品希望日が遅い順（貸出中は最後）';
            section.appendChild(title);
            displayRecords(filtered).forEach(record => section.appendChild(createRecordCard(record, record === nextShipment)));
            column.appendChild(section);
        }
        if (!filtered.length) {
            const empty = document.createElement('p');
            empty.className = 'empty-state';
            empty.textContent = '該当する案件はありません';
            column.appendChild(empty);
        }
        board.appendChild(column);
    });
    document.getElementById('board-count').textContent = visibleCount + '件を表示';
    renderCalendarNotice();
}
