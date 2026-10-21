// Presentation only: existing records are never changed by this board.
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function recordPhase(record) {
    if (record.lastCheck || record.status === '返却済') return 'returned';
    if (record.status === '貸出中') return 'lending';
    return 'waiting';
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

function nextWaitingRecord(records) {
    return records.filter(record => recordPhase(record) === 'waiting').sort((a, b) => {
        const aDate = a.deliveryDate || a.shipDate || a.usageDate || '';
        const bDate = b.deliveryDate || b.shipDate || b.usageDate || '';
        if (!aDate && bDate) return 1;
        if (aDate && !bDate) return -1;
        return aDate.localeCompare(bDate) || (Number(a.managementNo) || 0) - (Number(b.managementNo) || 0);
    })[0] || null;
}

function createRecordCard(record, isNextShipment = false) {
    const phase = recordPhase(record);
    const card = document.createElement('button');
    card.type = 'button';
    const isCurrent = !record.lastCheck && (phase === 'lending' || phase === 'returned');
    card.className = 'record-card phase-' + phase + (record.lastCheck ? ' checked-card' : '') + (isCurrent ? ' current-card' : '') + (isNextShipment ? ' next-shipment-card' : '');
    const label = record.lastCheck ? '確認完了' : isNextShipment ? '次の発送・発送待' : record.status === '発送待' ? '予約済・発送待' : phase === 'returned' ? '返却済・確認待ち' : (record.status || '状況未設定');
    const statusIcon = !record.lastCheck && (phase === 'lending' || phase === 'waiting')
        ? '<span class="card-status-icon" aria-hidden="true">' + (phase === 'lending' ? '↗' : '⇧') + '</span>' : '';
    card.innerHTML = '<div class="card-top"><strong>No.' + escapeHTML(record.managementNo || '-') + '</strong>' +
        '<span class="status-badge badge-' + phase + '">' + statusIcon + escapeHTML(label) + '</span></div>' +
        '<span class="customer-code">得意先CD ' + escapeHTML(record.customerCode || '-') + '</span>' +
        '<span class="customer-name">' + escapeHTML(record.customerName || '得意先未設定') + '</span>' +
        '<dl class="card-dates"><div><dt>納品希望日</dt><dd>' + escapeHTML(record.deliveryDate || '未設定') + '</dd></div>' +
        '<div><dt>返却予定日</dt><dd>' + escapeHTML(record.expectedReturn || '未設定') + '</dd></div></dl>' +
        '<span class="card-link">詳細・編集 <span aria-hidden="true">→</span></span>';
    card.addEventListener('click', () => openModal(record.id));
    return card;
}

function render() {
    const board = document.getElementById('sets-board');
    board.replaceChildren();
    // Keep records with older or unexpected set names visible, too.
    const setNames = [...new Set(['X', 'Y', 'Z', ...state.records.map(r => r.setName || '未設定')])];
    let visibleCount = 0;
    setNames.forEach(name => {
        const records = state.records.filter(r => (r.setName || '未設定') === name);
        const filtered = records.filter(r => {
            // Final check marks completion, even when an older status was left unchanged.
            if (state.statusFilter === '返却済') return !!r.lastCheck || r.status === '返却済';
            return !r.lastCheck && (!state.statusFilter || r.status === state.statusFilter);
        });
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
            title.textContent = '登録が新しい順';
            section.appendChild(title);
            sortedRecords(filtered).forEach(record => section.appendChild(createRecordCard(record, record === nextShipment)));
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
}
