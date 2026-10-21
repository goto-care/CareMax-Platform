const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(records) {
    const elements = new Map();
    function element() {
        return {
            children: [], value: '', innerHTML: '', textContent: '',
            classList: { add() {}, remove() {}, toggle() {} },
            appendChild(child) { this.children.push(child); },
            replaceChildren() { this.children = []; },
            addEventListener(type, handler) { this[type] = handler; },
            querySelectorAll() { return []; }
        };
    }
    const writes = [];
    const confirmations = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            },
            createElement: element,
            querySelectorAll() { return [element(), element()]; }
        },
        window: {}, setTimeout() { return 1; }, clearTimeout() {},
        localStorage: {
            getItem() { return JSON.stringify(records); },
            setItem(key, value) { writes.push({ key, value }); }
        },
        alert(message) { throw new Error(message); },
        confirm(message) { confirmations.push(message); return false; },
        URL: { createObjectURL() { return 'blob:test'; } }, Blob
    });
    for (const file of ['board.js', 'holidays-data.js', 'business-days.js', 'app.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
    }
    vm.runInContext('loadLocalData(); render();', context);
    return { context, elements, writes, confirmations, run: source => vm.runInContext(source, context) };
}

const fixtures = [
    { id: 'old-string-id', managementNo: 1, setName: 'X', status: '貸出中', customerCode: '001', customerName: '既存の得意先', requestDate: '2026-09-01', usageDate: '2026-10-21', notes: '既存備考', customField: '保持する項目' },
    { id: 2, managementNo: 2, setName: 'X', status: '発送待', customerCode: '002', customerName: '予約先', deliveryDate: '2026-11-10' },
    { id: 3, managementNo: 3, setName: 'Y', status: '返却済', customerCode: '003', customerName: '<script>test</script>', lastCheck: '2026-10-10' },
    { id: 4, managementNo: 4, status: '発送待', customerCode: '004', customerName: 'セット未設定の旧案件' }
];

function cardsIn(column) {
    return column.children.slice(1).flatMap(section => section.children || []).filter(child => child.className?.includes('record-card'));
}

test('existing records stay visible, including missing set and delivery date; rendering never writes data', () => {
    const app = setup(fixtures);
    const board = app.elements.get('sets-board');
    assert.equal(board.children.length, 4);
    assert.equal(app.elements.get('board-count').textContent, '3件を表示');
    const x = board.children[0];
    const lendingCard = cardsIn(x).find(card => card.className.includes('phase-lending'));
    assert.match(lendingCard.innerHTML, /既存の得意先/);
    assert.match(lendingCard.innerHTML, /未設定/);
    assert.doesNotMatch(lendingCard.innerHTML, /2026-09-01|2026-10-21/);
    lendingCard.click();
    assert.equal(app.elements.get('f-request-date').value, '2026-09-01');
    assert.equal(app.elements.get('f-usage-date').value, '2026-10-21');
    assert.equal(app.elements.get('f-delivery-date').value, '');
    assert.equal(app.writes.length, 0);
    assert.equal(app.run('JSON.stringify(state.records)'), JSON.stringify(fixtures));
});

test('editing an old record adds delivery date and preserves its ID and all existing fields', () => {
    const app = setup(fixtures);
    app.run("openModal('old-string-id')");
    app.elements.get('f-delivery-date').value = '2026-10-23';
    app.run('saveRecord()');
    const saved = JSON.parse(app.writes.at(-1).value);
    assert.equal(saved.length, fixtures.length);
    assert.deepEqual(saved[0], { ...fixtures[0], deliveryDate: '2026-10-23', supportStaff: '', salesStaff: '', shipDate: '', expectedReturn: '', returnDate: '', lastCheck: '' });
    assert.deepEqual(saved.slice(1), fixtures.slice(1));
});

test('status filtering keeps every set visible and does not modify records', () => {
    const app = setup(fixtures);
    app.run("setFilter('発送待'); render();");
    const board = app.elements.get('sets-board');
    assert.equal(board.children.length, 4);
    assert.equal(app.elements.get('board-count').textContent, '2件を表示');
    assert.match(cardsIn(board.children[0])[0].innerHTML, /予約先/);
    app.run("setFilter(''); render();");
    assert.equal(app.elements.get('board-count').textContent, '3件を表示');
    assert.equal(app.writes.length, 0);
});

test('untrusted customer names are escaped; empty data displays three usable columns', () => {
    const app = setup(fixtures);
    app.run("setFilter('返却済'); render();");
    const y = app.elements.get('sets-board').children[1];
    assert.match(cardsIn(y)[0].innerHTML, /&lt;script&gt;/);
    const empty = setup([]);
    assert.equal(empty.elements.get('sets-board').children.length, 3);
    assert.equal(empty.elements.get('board-count').textContent, '0件を表示');
});

test('completed records appear only under returned filter, without altering saved data', () => {
    const records = [...fixtures, { ...fixtures[0], id: 'completed-with-old-status', lastCheck: '2026-10-20' }];
    const app = setup(records);
    for (const status of ['', '発送待', '貸出中']) {
        app.run('setFilter(' + JSON.stringify(status) + '); render();');
        const cards = app.elements.get('sets-board').children.flatMap(cardsIn);
        assert.ok(cards.every(card => !card.className.includes('checked-card')));
    }
    app.run("setFilter('返却済'); render();");
    const cards = app.elements.get('sets-board').children.flatMap(cardsIn);
    assert.equal(cards.length, 2);
    assert.ok(cards.every(card => card.className.includes('checked-card')));
    assert.ok(cards.every(card => !card.className.includes('current-card')));
    assert.equal(app.run('JSON.stringify(state.records)'), JSON.stringify(records));
    assert.equal(app.writes.length, 0);
});

test('current loans and returned records awaiting checks stay distinct from reservations', () => {
    const pendingReturn = { ...fixtures[2], id: 'awaiting-check', lastCheck: '' };
    const app = setup([...fixtures, pendingReturn]);
    const columns = app.elements.get('sets-board').children;
    const xCards = cardsIn(columns[0]);
    const loan = xCards.find(card => card.className.includes('phase-lending'));
    const waiting = xCards.find(card => card.className.includes('phase-waiting'));
    assert.match(loan.className, /current-card/);
    assert.doesNotMatch(waiting.className, /current-card/);
    const yCards = cardsIn(columns[1]);
    assert.equal(yCards.length, 1);
    assert.match(yCards[0].className, /current-card/);
    assert.match(yCards[0].innerHTML, /返却済・確認待ち/);
    app.run("setFilter('返却済'); render();");
    assert.equal(app.elements.get('board-count').textContent, '2件を表示');
});

test('new registrations appear above older records across statuses; legacy records use management number', () => {
    const oldLoan = { ...fixtures[0], createdAt: '2026-10-01T09:00:00Z' };
    const newReservation = { ...fixtures[1], createdAt: '2026-10-21T09:00:00Z', deliveryDate: '2026-09-01' };
    const app = setup([oldLoan, newReservation]);
    const cards = cardsIn(app.elements.get('sets-board').children[0]);
    assert.match(cards[0].innerHTML, /No.2/);
    assert.match(cards[1].innerHTML, /No.1/);
    assert.equal(app.run('JSON.stringify(state.records)'), JSON.stringify([oldLoan, newReservation]));
    const legacy = setup(fixtures);
    const legacyCards = cardsIn(legacy.elements.get('sets-board').children[0]);
    assert.match(legacyCards[0].innerHTML, /No.2/);
    assert.match(legacyCards[1].innerHTML, /No.1/);
    assert.equal(app.writes.length, 0);
});

test('CSV includes delivery date at the matching column for both new and old records', async () => {
    const app = setup(fixtures);
    let blob;
    app.context.URL.createObjectURL = value => { blob = value; return 'blob:test'; };
    app.context.document.createElement = () => ({ click() {} });
    app.run('exportCSV()');
    const rows = (await blob.text()).trim().split('\n').map(row => row.split(','));
    const index = rows[0].indexOf('納品希望日');
    assert.equal(index, 8);
    assert.equal(rows[1][index], '');
    assert.equal(rows[2][index], '2026-11-10');
    assert.ok(rows.every(row => row.length === rows[0].length));
});

test('three-business-day boundary excludes weekends, national holidays, substitute holidays and year-end holidays', () => {
    const app = setup([]);
    const examples = [
        ['2026-11-20', '2026-11-26', 3], // Labor Thanksgiving Day on Monday.
        ['2026-11-20', '2026-11-27', 4],
        ['2026-09-18', '2026-09-28', 3], // Includes the citizens holiday on September 22.
        ['2026-09-18', '2026-09-29', 4],
        ['2026-05-01', '2026-05-07', 1], // Golden Week and substitute holiday on May 6.
        ['2027-03-19', '2027-03-23', 1], // Vernal equinox substitute holiday.
        ['2026-12-31', '2027-01-06', 3]
    ];
    for (const [start, end, expected] of examples) {
        assert.equal(app.run('businessDaysAfter(' + JSON.stringify(start) + ',' + JSON.stringify(end) + ')'), expected, start + ' to ' + end);
    }
});

test('delivery assessment compares only the latest registration of the selected set, regardless of display filters', () => {
    const records = [
        { ...fixtures[0], managementNo: 1, expectedReturn: '2026-11-01' },
        { ...fixtures[1], managementNo: 2, expectedReturn: '2026-11-20' },
        { ...fixtures[2], managementNo: 99, expectedReturn: '2026-12-01' }
    ];
    const app = setup(records);
    app.run("setFilter('貸出中'); openModal();");
    app.elements.get('f-set-name').value = 'X';
    app.elements.get('f-delivery-date').value = '2026-11-26';
    assert.equal(app.run('updateDeliveryWarning().code'), 'short-gap');
    assert.match(app.elements.get('delivery-warning').textContent, /No.2/);
    assert.match(app.elements.get('delivery-warning').textContent, /3 営業日/);
    app.elements.get('f-delivery-date').value = '2026-11-27';
    assert.equal(app.run('updateDeliveryWarning()'), null);
    assert.equal(app.elements.get('delivery-warning').textContent, '');
    app.elements.get('f-set-name').value = 'Z';
    assert.equal(app.run('updateDeliveryWarning()'), null);
    assert.equal(app.writes.length, 0);
});

test('overlapping dates, missing return dates and unsupported calendars produce explicit warnings', () => {
    const app = setup([{ ...fixtures[0], expectedReturn: '2026-11-20' }]);
    for (const delivery of ['2026-11-19', '2026-11-20']) {
        assert.equal(app.run('assessDeliveryDate(state.records,"X",' + JSON.stringify(delivery) + ').code'), 'overlap');
    }
    assert.equal(app.run('assessDeliveryDate(state.records,"X","2028-01-05").code'), 'unknown-calendar');
    assert.equal(app.run('assessDeliveryDate(state.records,"X","")'), null);
    assert.equal(app.run('assessDeliveryDate([{setName:"X"}],"X","2026-11-26").code'), 'missing-return');
});

test('new registration warns again at save; cancellation preserves records and confirmation permits saving', () => {
    const record = { ...fixtures[0], expectedReturn: '2026-11-20' };
    const app = setup([record]);
    app.run('openModal()');
    app.elements.get('f-customer-code').value = '999';
    app.elements.get('f-customer-name').value = '新規の得意先';
    app.elements.get('f-delivery-date').value = '2026-11-26';
    app.run('saveRecord()');
    assert.equal(app.confirmations.length, 1);
    assert.equal(app.writes.length, 0);
    assert.equal(app.run('JSON.stringify(state.records)'), JSON.stringify([record]));
    app.context.confirm = () => true;
    app.run('saveRecord()');
    const saved = JSON.parse(app.writes[0].value);
    assert.equal(saved.length, 2);
    assert.equal(saved[1].deliveryDate, '2026-11-26');
    assert.deepEqual(saved[0], record);
});

test('editing an existing record does not produce the new-registration delivery warning', () => {
    const app = setup([{ ...fixtures[0], expectedReturn: '2026-11-20' }]);
    app.run("openModal('old-string-id')");
    app.elements.get('f-delivery-date').value = '2026-11-19';
    assert.equal(app.run('updateDeliveryWarning()'), null);
    app.run('saveRecord()');
    assert.equal(app.confirmations.length, 0);
    assert.equal(app.writes.length, 1);
});

test('set status and reservation counts reflect actual records even when a display filter hides the loan', () => {
    const app = setup(fixtures);
    let columns = app.elements.get('sets-board').children;
    assert.match(columns[0].children[0].innerHTML, /set-status-lending/);
    assert.match(columns[0].children[0].innerHTML, /予約 1件/);
    assert.match(columns[1].children[0].innerHTML, /set-status-free/);
    assert.doesNotMatch(columns[1].children[0].innerHTML, /reservation-count/);
    app.run("setFilter('発送待'); render();");
    columns = app.elements.get('sets-board').children;
    assert.match(columns[0].children[0].innerHTML, /set-status-lending/);
    assert.ok(cardsIn(columns[0]).every(card => !card.className.includes('next-shipment-card')));
    assert.equal(app.writes.length, 0);
});

test('returning the loan highlights only the next scheduled shipment, with undated reservations last', () => {
    const records = [
        fixtures[0],
        { ...fixtures[1], id: 2, managementNo: 2, deliveryDate: '2026-11-02' },
        { ...fixtures[1], id: 3, managementNo: 3, deliveryDate: '2026-11-10' },
        { ...fixtures[1], id: 4, managementNo: 4, deliveryDate: '', usageDate: '' }
    ];
    const app = setup(records);
    assert.ok(cardsIn(app.elements.get('sets-board').children[0]).every(card => !card.className.includes('next-shipment-card')));
    app.run("state.records[0].status = '返却済'; render();");
    const column = app.elements.get('sets-board').children[0];
    assert.match(column.children[0].innerHTML, /set-status-waiting/);
    assert.match(column.children[0].innerHTML, /予約 3件/);
    const cards = cardsIn(column);
    const next = cards.filter(card => card.className.includes('next-shipment-card'));
    assert.equal(next.length, 1);
    assert.match(next[0].innerHTML, /No.2/);
    assert.match(next[0].innerHTML, /次の発送/);
    assert.doesNotMatch(next[0].className, /current-card/);
    // Registration order stays newest-first even when the next shipment is an older reservation.
    assert.match(cards[0].innerHTML, /No.4/);
    app.run("state.records[0].lastCheck = '2026-10-21'; render();");
    assert.equal(cardsIn(app.elements.get('sets-board').children[0]).filter(card => card.className.includes('next-shipment-card')).length, 1);
    assert.equal(app.writes.length, 0);
});
