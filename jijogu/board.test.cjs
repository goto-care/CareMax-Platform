const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(records, options = {}) {
    const elements = new Map();
    function element(tag = 'div') {
        const classes = new Set();
        return {
            tagName: String(tag).toUpperCase(), children: [], value: '', innerHTML: '', textContent: '', checked: false, disabled: false, hidden: false, dataset: {}, style: {}, attributes: {},
            classList: {
                add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
                toggle(name, force) { (force === undefined ? !classes.has(name) : force) ? classes.add(name) : classes.delete(name); },
                contains(name) { return classes.has(name); }
            },
            appendChild(child) { this.children.push(child); child.parent = this; },
            replaceChildren() { this.children = []; },
            remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
            addEventListener(type, handler) { this[type] = handler; },
            setAttribute(name, value) { this.attributes[name] = value; },
            querySelector() { return element(); },
            querySelectorAll() { return []; }
        };
    }
    const writes = [];
    const confirmations = [];
    const storage = new Map([['caremax-jijogu', JSON.stringify(records)], ...(options.storage || [])]);
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document: {
            getElementById(id) {
                if (!elements.has(id)) {
                    const created = element();
                    // Dialogs start closed, as in index.html.
                    if (id.endsWith('-modal')) created.classList.add('hidden');
                    elements.set(id, created);
                }
                return elements.get(id);
            },
            createElement: element,
            querySelectorAll() { return [element(), element()]; }
        },
        window: {}, setTimeout() { return 1; }, clearTimeout() {},
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, value); writes.push({ key, value }); }
        },
        alert(message) { throw new Error(message); },
        confirm(message) { confirmations.push(message); return false; },
        URL: { createObjectURL() { return 'blob:test'; } }, Blob
    });
    for (const file of ['board.js', 'holidays-data.js', 'business-days.js', 'app.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
    }
    vm.runInContext('loadLocalData(); render();', context);
    const recordWrites = () => writes.filter(write => write.key === 'caremax-jijogu');
    return { context, elements, writes, recordWrites, confirmations, run: source => vm.runInContext(source, context) };
}

// Minimal Firestore stand-in that records what the screen sends.
function fakeFirestore({ counter = 0, storedMax = 0, failSet = false, failTransaction = false } = {}) {
    const calls = [];
    const failure = () => Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    function docRef(pathName) {
        return {
            path: pathName,
            collection(name) { return collectionRef(pathName + '/' + name); },
            set(data, opts) { calls.push({ op: 'set', path: pathName, data: structuredClone(data), opts: structuredClone(opts) }); return failSet ? failure() : Promise.resolve(); },
            onSnapshot() { return () => {}; }
        };
    }
    function collectionRef(pathName) {
        return {
            doc(id) { return docRef(pathName + '/' + id); },
            add(data) { calls.push({ op: 'add', path: pathName, data: structuredClone(data) }); return Promise.resolve(); },
            orderBy() { return this; },
            limit() { return this; },
            get() {
                const docs = storedMax ? [{ data: () => ({ managementNo: storedMax }) }] : [];
                return Promise.resolve({ empty: !docs.length, forEach: fn => docs.forEach(fn) });
            },
            onSnapshot() { return () => {}; }
        };
    }
    return {
        calls,
        db: {
            collection: collectionRef,
            async runTransaction(fn) {
                if (failTransaction) return failure();
                const tx = {
                    get: async ref => ({ exists: counter > 0 && ref.path === 'jijogu_settings/managementNo', data: () => ({ last: counter }) }),
                    set(ref, data, opts) { calls.push({ op: 'tx.set', path: ref.path, data: structuredClone(data), opts: structuredClone(opts) }); }
                };
                return fn(tx);
            }
        }
    };
}

function withFirestore(app, options) {
    const fake = fakeFirestore(options);
    app.context.__fakeDb = fake.db;
    app.run('db = __fakeDb');
    return fake;
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

function fill(app, values) {
    for (const [id, value] of Object.entries(values)) app.elements.get(id) ? (app.elements.get(id).value = value) : (app.context.document.getElementById(id).value = value);
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

test('editing an old record saves only the changed field and keeps its ID and all existing fields', () => {
    const app = setup(fixtures);
    app.run("openModal('old-string-id')");
    // Older records have no shipping fields yet; they stay unset unless someone chooses them.
    assert.equal(app.elements.get('f-ship-method').value, '');
    assert.equal(app.elements.get('f-ship-to-kind').value, '');
    assert.equal(app.elements.get('ship-to-unset').hidden, false);
    app.elements.get('f-delivery-date').value = '2026-10-23';
    // No.2 starts later and this record has no return date yet, so saving asks first.
    app.context.confirm = message => { app.confirmations.push(message); return true; };
    app.run('saveRecord()');
    assert.match(app.confirmations[0], /この案件の返却予定日が未入力のため、後の No.2/);
    const saved = JSON.parse(app.recordWrites().at(-1).value);
    assert.equal(saved.length, fixtures.length);
    assert.deepEqual(saved[0], { ...fixtures[0], deliveryDate: '2026-10-23' });
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

test('cards are ordered by delivery date, latest first, with undated reservations on top and loans last; ties keep newest registration first', () => {
    const undatedLoan = { ...fixtures[0], createdAt: '2026-10-01T09:00:00Z' };
    const undatedReservation = { ...fixtures[1], id: 'r20', managementNo: 20, createdAt: '2026-10-02T09:00:00Z', deliveryDate: '' };
    const laterRegisteredEarlierDate = { ...fixtures[1], managementNo: 15, createdAt: '2026-10-21T09:00:00Z', deliveryDate: '2026-11-09' };
    const earlierRegisteredLaterDate = { ...fixtures[1], id: 'r13', managementNo: 13, createdAt: '2026-10-10T09:00:00Z', deliveryDate: '2026-11-17' };
    const sameDateNewer = { ...fixtures[1], id: 'r16', managementNo: 16, createdAt: '2026-10-25T09:00:00Z', deliveryDate: '2026-11-09' };
    const records = [undatedLoan, undatedReservation, laterRegisteredEarlierDate, earlierRegisteredLaterDate, sameDateNewer];
    const app = setup(records);
    const cards = cardsIn(app.elements.get('sets-board').children[0]);
    assert.deepEqual(cards.map(card => card.innerHTML.match(/No\.(\d+)/)[1]), ['20', '13', '16', '15', '1']);
    assert.equal(app.run('JSON.stringify(state.records)'), JSON.stringify(records));
    assert.equal(app.run('sortedRecords(state.records)[0].managementNo'), 16);
    assert.equal(app.writes.length, 0);
});

test('CSV keeps the original columns in place and adds shipping columns at the end', async () => {
    const records = [...fixtures, {
        id: 5, managementNo: 5, setName: 'Z', status: '発送待', customerCode: '005', customerName: '別送り先', shipMethod: 'sagawa', autoLabel: true,
        shipTo: { name: 'ひだまり苑', person: '山田 花子', zip: '123-4567', tel: '03-1234-5678', addressLines: ['東京都港区1-2-3', '2階'], subDestCode: '' }
    }];
    const app = setup(records);
    let blob;
    app.context.URL.createObjectURL = value => { blob = value; return 'blob:test'; };
    app.context.document.createElement = () => ({ click() {} });
    app.run('exportCSV()');
    const rows = (await blob.text()).trim().split('\n').map(row => row.split(','));
    const index = rows[0].indexOf('納品希望日');
    assert.equal(index, 8);
    assert.equal(rows[1][index], '');
    assert.equal(rows[2][index], '2026-11-10');
    assert.deepEqual(rows[0].slice(14), ['発送のしかた', '送り状の自動発行', '送り先', '送り先名', '宛名', '郵便番号', '住所1', '住所2', '電話番号', '送付先CD']);
    assert.deepEqual(rows[5].slice(14), ['当社から佐川で発送', 'する', '別の送り先', 'ひだまり苑', '山田 花子', '123-4567', '東京都港区1-2-3', '2階', '03-1234-5678', '']);
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

test('A3: business days are added and subtracted around weekends and holidays', () => {
    const app = setup([]);
    const examples = [
        ['2026-11-24', -1, '2026-11-20'], // Monday 11/23 is a holiday.
        ['2026-11-20', -2, '2026-11-18'],
        ['2026-11-24', 10, '2026-12-08'],
        ['2026-05-07', -1, '2026-05-01'], // Golden Week.
        ['2026-11-06', 0, '2026-11-06'],
        ['2027-12-24', 10, ''], // Past the holiday data.
        ['', 1, '']
    ];
    for (const [date, n, expected] of examples) {
        assert.equal(app.run('addBusinessDays(' + JSON.stringify(date) + ',' + n + ')'), expected, date + ' ' + n);
    }
    assert.equal(app.run('JSON.stringify(scheduleFromUsage("2026-11-24"))'), JSON.stringify({ deliveryDate: '2026-11-20', shipDate: '2026-11-18', expectedReturn: '2026-12-08' }));
});

test('A3: the usage date fills delivery, ship and return dates; dates typed by hand are kept unless re-filled', () => {
    const app = setup([]);
    app.run('openModal()');
    app.elements.get('f-usage-date').value = '2026-11-24';
    app.run('fillDatesFromUsage()');
    assert.equal(app.elements.get('f-delivery-date').value, '2026-11-20');
    assert.equal(app.elements.get('f-ship-date').value, '2026-11-18');
    assert.equal(app.elements.get('f-expected-return').value, '2026-12-08');
    // A later usage date moves the auto-filled dates, but not the delivery date typed by hand.
    app.elements.get('f-delivery-date').value = '2026-11-19';
    app.run('onDeliveryDateInput()');
    assert.equal(app.elements.get('f-ship-date').value, '2026-11-17');
    app.elements.get('f-usage-date').value = '2026-11-26';
    app.run('fillDatesFromUsage()');
    assert.equal(app.elements.get('f-delivery-date').value, '2026-11-19');
    assert.equal(app.elements.get('f-ship-date').value, '2026-11-17');
    assert.equal(app.elements.get('f-expected-return').value, '2026-12-10');
    assert.match(app.elements.get('schedule-hint').textContent, /納品希望日は入力済み/);
    app.run('fillDatesFromUsage(true)');
    assert.equal(app.elements.get('f-delivery-date').value, '2026-11-25');
    assert.equal(app.elements.get('f-ship-date').value, '2026-11-20');
    // Opening an existing record never rewrites its stored dates.
    const existing = setup([{ ...fixtures[1], usageDate: '2026-11-12', expectedReturn: '2026-11-20' }]);
    existing.run('openModal(2)');
    existing.elements.get('f-usage-date').value = '2026-11-13';
    existing.run('fillDatesFromUsage()');
    assert.equal(existing.elements.get('f-delivery-date').value, '2026-11-10');
    assert.equal(existing.elements.get('f-expected-return').value, '2026-11-20');
    assert.equal(existing.elements.get('f-ship-date').value, '2026-11-06');
});

test('A4: a booking inserted between two others is checked against both neighbours, not only the latest registration', () => {
    // Y set: No.15 returns 11-09, No.13 is delivered 11-10 (1 business day), registered in the opposite order.
    const records = [
        { id: 'y13', managementNo: 13, setName: 'Y', status: '発送待', customerCode: '13', customerName: '後の予約', deliveryDate: '2026-11-10', expectedReturn: '2026-11-24', createdAt: '2026-10-01T00:00:00Z' },
        { id: 'y15', managementNo: 15, setName: 'Y', status: '貸出中', customerCode: '15', customerName: '前の貸出', deliveryDate: '2026-10-26', expectedReturn: '2026-11-09', createdAt: '2026-10-20T00:00:00Z' },
        { id: 'y1', managementNo: 1, setName: 'Y', status: '貸出中', customerCode: '1', customerName: '点検済み', deliveryDate: '2026-11-09', expectedReturn: '2026-11-11', lastCheck: '2026-11-12' },
        { id: 'y2', managementNo: 2, setName: 'Y', status: '取消', customerCode: '2', customerName: '取消済み', deliveryDate: '2026-11-09', expectedReturn: '2026-11-11' }
    ];
    const app = setup(records);
    // Editing No.13 now warns about No.15 before it.
    app.run("openModal('y13')");
    const edit = app.run('updateDeliveryWarning()');
    assert.equal(edit.code, 'short-gap');
    assert.equal(edit.businessDays, 1);
    assert.match(edit.message, /No\.15 の返却予定日（2026-11-09）から、この案件の納品希望日（2026-11-10）まで 1 営業日/);
    assert.doesNotMatch(edit.message, /No\.1 |No\.2 |No\.13/);
    // A new booking squeezed in after No.15 is checked against No.13 after it, too.
    const assessment = app.run('assessDeliveryDate(state.records, "Y", "2026-11-16", "2026-11-20")');
    assert.equal(assessment.code, 'overlap');
    assert.match(assessment.message, /No\.13（2026-11-10〜2026-11-24）と日程が重なっています/);
    const between = app.run('assessDeliveryDate(state.records.filter(r => r.id !== "y13"), "Y", "2026-11-13", "2026-11-17")');
    assert.equal(between, null);
    const tightAfter = app.run('assessDeliveryDate([...state.records, { id: "y16", managementNo: 16, setName: "Y", status: "発送待", deliveryDate: "2026-11-30", expectedReturn: "2026-12-04" }].filter(r => r.id !== "y13"), "Y", "2026-11-13", "2026-11-26")');
    assert.equal(tightAfter.code, 'short-gap');
    assert.match(tightAfter.message, /この案件の返却予定日（2026-11-26）から、次の No\.16 の納品希望日（2026-11-30）まで 2 営業日/);
    assert.equal(app.writes.length, 0);
});

test('A4: overlaps, missing dates and unsupported calendars produce explicit warnings', () => {
    const app = setup([{ ...fixtures[0], expectedReturn: '2026-11-20' }]);
    for (const delivery of ['2026-11-19', '2026-11-20']) {
        assert.equal(app.run('assessDeliveryDate(state.records,"X",' + JSON.stringify(delivery) + ').code'), 'overlap');
    }
    assert.equal(app.run('assessDeliveryDate(state.records,"X","2028-01-05").code'), 'unknown-calendar');
    assert.equal(app.run('assessDeliveryDate(state.records,"X","")'), null);
    assert.equal(app.run('assessDeliveryDate([{setName:"X"}],"X","2026-11-26").code'), 'missing-return');
    assert.equal(app.run('assessDeliveryDate([{setName:"X", status:"発送待", deliveryDate:"2026-12-01"}],"X","2026-11-26").code'), 'missing-own-return');
    assert.equal(app.run('assessDeliveryDate([{setName:"X", status:"返却済"}],"X","2026-11-26")'), null);
    assert.equal(app.run('assessDeliveryDate([],"X","2026-11-26","2026-11-20").code'), 'invalid-range');
});

test('A4: new registration warns again at save; cancellation preserves records and confirmation permits saving', () => {
    const record = { ...fixtures[0], expectedReturn: '2026-11-20' };
    const app = setup([record]);
    app.run('openModal()');
    app.elements.get('f-customer-code').value = '999';
    app.elements.get('f-customer-name').value = '新規の得意先';
    app.elements.get('f-delivery-date').value = '2026-11-26';
    app.run('saveRecord()');
    assert.equal(app.confirmations.length, 1);
    assert.match(app.confirmations[0], /No\.1 の返却予定日（2026-11-20）から、この案件の納品希望日（2026-11-26）まで 3 営業日/);
    assert.equal(app.writes.length, 0);
    assert.equal(app.run('JSON.stringify(state.records)'), JSON.stringify([record]));
    app.context.confirm = () => true;
    app.run('saveRecord()');
    const saved = JSON.parse(app.recordWrites()[0].value);
    assert.equal(saved.length, 2);
    assert.equal(saved[1].deliveryDate, '2026-11-26');
    assert.equal(saved[1].managementNo, 2);
    assert.deepEqual(saved[0], record);
});

test('A4: editing shows the warning too, but asks at save only when the schedule changed', () => {
    const records = [{ ...fixtures[0], expectedReturn: '2026-11-20' }, { ...fixtures[1], expectedReturn: '2026-11-30' }];
    const app = setup(records);
    app.run('openModal(2)');
    assert.equal(app.run('updateDeliveryWarning().code'), 'overlap');
    assert.equal(app.elements.get('delivery-warning').classList.contains('hidden'), false);
    // Changing only the notes saves without asking.
    app.elements.get('f-notes').value = 'メモ';
    app.run('saveRecord()');
    assert.equal(app.confirmations.length, 0);
    assert.equal(JSON.parse(app.recordWrites().at(-1).value)[1].notes, 'メモ');
    // Changing the delivery date asks again.
    app.run('openModal(2)');
    app.elements.get('f-delivery-date').value = '2026-11-19';
    app.run('saveRecord()');
    assert.equal(app.confirmations.length, 1);
    assert.equal(JSON.parse(app.recordWrites().at(-1).value)[1].deliveryDate, '2026-11-10');
});

test('A1/A2: new records default to Sagawa with automatic labels to the customer address; other destinations use the jijoguAuto.dest shape', () => {
    const app = setup([]);
    app.context.confirm = () => true;
    app.run('openModal()');
    assert.equal(app.elements.get('f-ship-method').value, 'sagawa');
    assert.equal(app.elements.get('f-auto-label').checked, true);
    assert.equal(app.elements.get('f-ship-to-kind').value, 'customer');
    assert.equal(app.elements.get('ship-method-unset').hidden, true);
    fill(app, { 'f-customer-code': '100', 'f-customer-name': '得意先の住所へ' });
    app.run('saveRecord()');
    let saved = JSON.parse(app.recordWrites().at(-1).value).at(-1);
    assert.equal(saved.shipMethod, 'sagawa');
    assert.equal(saved.autoLabel, true);
    assert.equal(saved.shipTo, null);

    app.run('openModal()');
    fill(app, {
        'f-customer-code': '101', 'f-customer-name': '別の送り先へ', 'f-ship-to-kind': 'other',
        'f-ship-to-name': 'ひだまり苑', 'f-ship-to-person': '山田 花子', 'f-ship-to-zip': '１２３ー４５６７', 'f-ship-to-tel': '03-1234-5678',
        'f-ship-to-address1': '東京都港区1-2-3', 'f-ship-to-address2': ''
    });
    app.run('saveRecord()');
    saved = JSON.parse(app.recordWrites().at(-1).value).at(-1);
    assert.deepEqual(saved.shipTo, { name: 'ひだまり苑', person: '山田 花子', zip: '123-4567', tel: '03-1234-5678', addressLines: ['東京都港区1-2-3'], subDestCode: '' });

    app.run('openModal()');
    fill(app, { 'f-customer-code': '102', 'f-customer-name': '送付先CD', 'f-ship-to-kind': 'code', 'f-ship-to-code': '０１２', 'f-ship-method': 'direct' });
    app.run('saveRecord()');
    saved = JSON.parse(app.recordWrites().at(-1).value).at(-1);
    assert.deepEqual(saved.shipTo, { name: '', person: '', zip: '', tel: '', addressLines: [], subDestCode: '012' });
    assert.equal(saved.shipMethod, 'direct');
    assert.equal(saved.autoLabel, false);

    app.run('render()');
    const card = cardsIn(app.elements.get('sets-board').children[0]).find(item => item.innerHTML.includes('別の送り先へ'));
    assert.match(card.innerHTML, /佐川・送り状は自動/);
    assert.match(card.innerHTML, /送り先：ひだまり苑/);
});

test('A1: other destinations need a name and address, and zip/tel when labels are automatic', async () => {
    const app = setup([]);
    app.run('openModal()');
    fill(app, { 'f-customer-code': '101', 'f-customer-name': '別の送り先へ', 'f-ship-to-kind': 'other', 'f-ship-to-name': 'ひだまり苑' });
    await assert.rejects(app.run('saveRecord()'), /送り先名」と「住所（1行目）/);
    fill(app, { 'f-ship-to-address1': '東京都港区1-2-3' });
    await assert.rejects(app.run('saveRecord()'), /郵便番号と電話番号/);
    app.elements.get('f-auto-label').checked = false;
    await app.run('saveRecord()');
    assert.equal(JSON.parse(app.recordWrites().at(-1).value)[0].autoLabel, false);
    app.run('openModal()');
    fill(app, { 'f-customer-code': '102', 'f-customer-name': 'CD未入力', 'f-ship-to-kind': 'code' });
    await assert.rejects(app.run('saveRecord()'), /送付先CDを入力/);
    assert.equal(app.recordWrites().length, 1);
});

test('A1: choosing the customer address on an older record writes shipTo null so the notes are no longer needed', () => {
    const app = setup(fixtures);
    app.run("openModal('old-string-id')");
    fill(app, { 'f-ship-to-kind': 'customer', 'f-ship-method': 'handover' });
    app.run('saveRecord()');
    const saved = JSON.parse(app.recordWrites().at(-1).value)[0];
    assert.equal(saved.shipTo, null);
    assert.equal(saved.shipMethod, 'handover');
    assert.equal(saved.autoLabel, false);
    assert.equal(saved.customField, '保持する項目');
});

test('A5: return and check buttons record the date and keep the status in step', () => {
    const app = setup(fixtures);
    let cards = cardsIn(app.elements.get('sets-board').children[0]);
    const loan = cards.find(card => card.className.includes('phase-lending'));
    assert.match(loan.innerHTML, /data-action="return"/);
    assert.ok(cards.filter(card => card !== loan).every(card => !card.innerHTML.includes('data-action="return"')));
    loan.click({ target: { closest: () => ({ dataset: { action: 'return' } }) } });
    assert.equal(app.elements.get('quick-modal').classList.contains('hidden'), false);
    assert.equal(app.elements.get('quick-title').textContent, '返却を記録');
    app.elements.get('quick-date').value = '2026-11-05';
    app.run('confirmQuickAction()');
    let saved = JSON.parse(app.recordWrites().at(-1).value)[0];
    assert.equal(saved.returnDate, '2026-11-05');
    assert.equal(saved.status, '返却済');
    assert.equal(saved.customField, '保持する項目');
    app.run('render()');
    cards = cardsIn(app.elements.get('sets-board').children[0]);
    const returned = cards.find(card => card.innerHTML.includes('既存の得意先'));
    assert.match(returned.innerHTML, /返却済・確認待ち/);
    assert.match(returned.innerHTML, /data-action="check"/);
    returned.click({ target: { closest: () => ({ dataset: { action: 'check' } }) } });
    app.elements.get('quick-date').value = '2026-11-06';
    app.run('confirmQuickAction()');
    saved = JSON.parse(app.recordWrites().at(-1).value)[0];
    assert.equal(saved.lastCheck, '2026-11-06');
    assert.equal(saved.status, '返却済');
    // Clicking elsewhere on the card still opens the details.
    returned.click({ target: { closest: () => null } });
    assert.equal(app.elements.get('modal-title').textContent, '案件の詳細・編集');
});

test('A5: entering a return date or a final check in the dialog changes 貸出中 to 返却済', () => {
    const app = setup(fixtures);
    app.run("openModal('old-string-id')");
    app.elements.get('f-last-check').value = '2026-11-02';
    app.run('syncStatusField()');
    assert.equal(app.elements.get('f-status').value, '返却済');
    app.elements.get('f-status').value = '貸出中';
    app.run('saveRecord()');
    const saved = JSON.parse(app.recordWrites().at(-1).value)[0];
    assert.equal(saved.status, '返却済');
    assert.equal(saved.lastCheck, '2026-11-02');
});

test('C2: cancelling keeps the record with status 取消, shown only under the 取消 filter and ignored by schedule checks', () => {
    const app = setup([...fixtures, { id: 5, managementNo: 5, setName: 'X', status: '発送待', customerCode: '005', customerName: '取り消す予約', deliveryDate: '2026-11-20', expectedReturn: '2026-11-27' }]);
    app.context.confirm = () => true;
    app.run('openModal(5)');
    assert.equal(app.elements.get('cancel-record-btn').classList.contains('hidden'), false);
    app.run('cancelRecord()');
    const saved = JSON.parse(app.recordWrites().at(-1).value);
    assert.equal(saved.length, 5);
    assert.equal(saved[4].status, '取消');
    app.run('render()');
    assert.ok(app.elements.get('sets-board').children.flatMap(cardsIn).every(card => !card.innerHTML.includes('取り消す予約')));
    assert.match(app.elements.get('sets-board').children[0].children[0].innerHTML, /予約 1件/);
    app.run("setFilter('取消'); render();");
    const cancelled = app.elements.get('sets-board').children.flatMap(cardsIn);
    assert.equal(cancelled.length, 1);
    assert.match(cancelled[0].className, /phase-cancelled/);
    assert.doesNotMatch(app.run('assessDeliveryDate(state.records, "X", "2026-11-24", "2026-11-25").message'), /No.5/);
});

test('B1/B5: edits send only the changed fields with merge, never jijoguAuto, and leave a history entry', async () => {
    const auto = { trackingNo: '1234-5678-9012', issuing: false, dest: { name: '自動の送り先', addressLines: ['大阪府'], zip: '530-0001', tel: '06', person: '', subDestCode: '' } };
    const app = setup([{ ...fixtures[1], jijoguAuto: auto, shipMethod: 'sagawa', autoLabel: true, shipTo: null }]);
    const fake = withFirestore(app);
    app.context.auth = undefined;
    app.run('openModal(2)');
    app.elements.get('f-notes').value = '電話で確認済み';
    await app.run('saveRecord()');
    const set = fake.calls.find(call => call.op === 'set');
    assert.equal(set.path, 'jijogu_records/2');
    assert.deepEqual(set.data, { notes: '電話で確認済み' });
    assert.deepEqual(set.opts, { merge: true });
    const history = fake.calls.find(call => call.op === 'add');
    assert.equal(history.path, 'jijogu_records/2/history');
    assert.equal(history.data.action, 'update');
    assert.deepEqual(history.data.changes, [{ field: 'notes', label: '備考', before: '', after: '電話で確認済み' }]);
    assert.deepEqual(JSON.parse(app.recordWrites().at(-1).value)[0].jijoguAuto, auto);
});

test('B1: a failed save shows a red notice with a retry that sends the same change again', async () => {
    const app = setup(fixtures);
    const fake = withFirestore(app, { failSet: true });
    app.run("openModal('old-string-id')");
    app.elements.get('f-notes').value = '変更';
    await app.run('saveRecord()');
    const toasts = app.elements.get('toast-area').children;
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].className, 'toast toast-error');
    assert.match(toasts[0].children[0].textContent, /No\.1（既存の得意先）の保存に失敗しました/);
    assert.match(toasts[0].children[0].textContent, /権限がありません/);
    const retry = toasts[0].children[1].children[0];
    assert.equal(retry.textContent, 'もう一度保存');
    retry.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fake.calls.filter(call => call.op === 'set').length, 2);
    assert.deepEqual(fake.calls.at(-1).data, { notes: '変更' });
    assert.equal(fake.calls.filter(call => call.op === 'add').length, 0);
});

test('B2: new management numbers come from a transaction over the counter and the highest stored number', async () => {
    const app = setup(fixtures);
    const fake = withFirestore(app, { counter: 7, storedMax: 9 });
    app.context.confirm = () => true;
    app.run('openModal()');
    fill(app, { 'f-customer-code': '200', 'f-customer-name': '新しい得意先' });
    await app.run('saveRecord()');
    const counter = fake.calls.find(call => call.op === 'tx.set' && call.path === 'jijogu_settings/managementNo');
    assert.equal(counter.data.last, 10);
    const created = fake.calls.find(call => call.op === 'tx.set' && call.path.startsWith('jijogu_records/'));
    assert.equal(created.data.managementNo, 10);
    assert.equal(created.data.customerName, '新しい得意先');
    assert.match(app.elements.get('toast-area').children[0].children[0].textContent, /No\.10 で登録しました/);
    assert.equal(fake.calls.find(call => call.op === 'add').data.action, 'create');
    assert.equal(JSON.parse(app.recordWrites().at(-1).value).at(-1).managementNo, 10);
});

test('B2: when the transaction fails, the record is still saved with the screen number and a warning is shown', async () => {
    const app = setup(fixtures);
    const fake = withFirestore(app, { failTransaction: true });
    app.context.confirm = () => true;
    app.run('openModal()');
    fill(app, { 'f-customer-code': '201', 'f-customer-name': '番号を確かめられない' });
    await app.run('saveRecord()');
    await new Promise(resolve => setImmediate(resolve));
    const set = fake.calls.find(call => call.op === 'set');
    assert.equal(set.data.managementNo, 5);
    assert.equal(app.elements.get('toast-area').children[0].className, 'toast toast-warning');
});

test('B3: Claude\'s jijoguAuto fields are listed in the dialog and the tracking number is shown on the card', () => {
    const record = {
        ...fixtures[1],
        jijoguAuto: {
            trackingNo: '1234-5678-9012', autoIssued: true, switchDate: '2026-11-04', deliveryStatus: '配達完了',
            cybozu: { eventId: '991', url: 'https://example.invalid/e/991' }, issuedAt: { seconds: 1793836800, nanoseconds: 0 },
            dest: { name: 'ひだまり苑', person: '', zip: '123-4567', tel: '03', addressLines: ['東京都港区1-2-3'], subDestCode: '' },
            customKey: '<b>そのまま</b>'
        }
    };
    const app = setup([record]);
    const card = cardsIn(app.elements.get('sets-board').children[0])[0];
    assert.match(card.innerHTML, /送り状 1234-5678-9012・配達完了/);
    app.run('openModal(2)');
    assert.equal(app.elements.get('auto-info-section').classList.contains('hidden'), false);
    const html = app.elements.get('auto-info-list').innerHTML;
    assert.match(html, /<dt>送り状番号<\/dt><dd>1234-5678-9012<\/dd>/);
    assert.match(html, /<dt>配達状況<\/dt><dd>配達完了<\/dd>/);
    assert.match(html, /<dt>送り状の自動発行<\/dt><dd>はい<\/dd>/);
    assert.match(html, /<dt>切り替え日<\/dt><dd>2026-11-04<\/dd>/);
    assert.match(html, /<dt>サイボウズ予定<\/dt><dd>eventId：991 \/ url：https:\/\/example.invalid\/e\/991<\/dd>/);
    assert.match(html, /<dt>送り先（自動処理が使う）<\/dt><dd>〒123-4567 東京都港区1-2-3 ひだまり苑 TEL 03<\/dd>/);
    assert.match(html, /<dt>customKey<\/dt><dd>&lt;b&gt;そのまま&lt;\/b&gt;<\/dd>/);
    assert.ok(html.indexOf('送り状番号') < html.indexOf('customKey'));
    app.run("openModal('missing')");
    const plain = setup(fixtures);
    plain.run('openModal(2)');
    assert.equal(plain.elements.get('auto-info-section').classList.contains('hidden'), true);
});

test('B4: staff are chosen from the shared list; values outside the list are kept, and records are offered until a list exists', () => {
    const records = [{ ...fixtures[1], supportStaff: '田中', salesStaff: '宇原 承子' }];
    const draft = setup(records);
    draft.run('openModal(2)');
    assert.deepEqual(draft.elements.get('f-support-staff').children.map(option => option.value), ['', '宇原 承子', '田中']);
    assert.equal(draft.elements.get('staff-empty-note').classList.contains('hidden'), false);
    draft.run('openStaffEditor()');
    assert.equal(draft.elements.get('staff-list-input').value, '宇原 承子\n田中');
    draft.elements.get('staff-list-input').value = '宇原 承子\n\n田中 太郎\n宇原 承子 ';
    draft.run('saveStaffList()');
    assert.deepEqual(JSON.parse(draft.writes.find(write => write.key === 'caremax-jijogu-staff').value), ['宇原 承子', '田中 太郎']);

    const app = setup(records, { storage: [['caremax-jijogu-staff', JSON.stringify(['宇原 承子', '田中 太郎'])]] });
    app.run('loadStaffList(); openModal(2)');
    const support = app.elements.get('f-support-staff');
    assert.deepEqual(support.children.map(option => option.textContent), ['（選んでください）', '宇原 承子', '田中 太郎', '田中（一覧にない表記）']);
    assert.equal(support.value, '田中');
    assert.equal(app.elements.get('f-sales-staff').value, '宇原 承子');
    assert.equal(app.elements.get('staff-empty-note').classList.contains('hidden'), true);
    app.run('saveRecord()');
    assert.equal(app.recordWrites().length, 0);
});

test("A2: the morning a label will be issued follows the ship date and the skill's skip rules", () => {
    const app = setup([]);
    const info = (record, options) => app.run('JSON.stringify(labelIssueInfo(' + JSON.stringify(record) + ',' + JSON.stringify({ today: '2026-11-06', ...options }) + '))');
    const auto = { shipMethod: 'sagawa', autoLabel: true };
    assert.equal(info({ ...auto, autoLabel: false, shipDate: '2026-11-25' }), 'null');
    assert.equal(info({ shipMethod: 'direct', autoLabel: false, shipDate: '2026-11-25' }), 'null');
    assert.equal(JSON.parse(info({ ...auto })).tone, 'pending');
    assert.deepEqual(JSON.parse(info({ ...auto, shipDate: '2026-11-25' })), { tone: 'info', date: '2026-11-25', text: '送り状は 11/25（水） の朝（9:15ごろ）に自動で出ます。' });
    assert.match(JSON.parse(info({ ...auto, shipDate: '2026-11-05' })).text, /過ぎているため、送り状は自動では出ません/);
    assert.match(JSON.parse(info({ ...auto, shipDate: '2026-11-06' }, { isNew: true })).text, /当日に登録した案件は、送り状が自動では出ません/);
    assert.match(JSON.parse(info({ ...auto, shipDate: '2026-11-06', createdAt: '2026-11-06T01:00:00Z' })).text, /当日に登録した案件/);
    assert.match(JSON.parse(info({ ...auto, shipDate: '2026-11-06', createdAt: '2026-10-30T01:00:00Z' })).text, /今日 11\/6（金） の朝/);
    for (const holiday of ['2026-11-07', '2026-11-23']) {
        assert.equal(JSON.parse(info({ ...auto, shipDate: holiday })).tone, 'warning', holiday);
    }
});

test('A2: the dialog and the card show the issue morning once the ship date is set', () => {
    const app = setup([
        { id: 7, managementNo: 7, setName: 'Z', status: '発送待', customerCode: '7', customerName: '自動で発行', shipMethod: 'sagawa', autoLabel: true, shipTo: null, shipDate: '2026-11-25', deliveryDate: '2026-11-27' },
        { id: 8, managementNo: 8, setName: 'Y', status: '発送待', customerCode: '8', customerName: '発行済み', shipMethod: 'sagawa', autoLabel: true, shipTo: null, shipDate: '2026-11-25', jijoguAuto: { trackingNo: '5555-6666-7777' } }
    ]);
    app.run('localToday = () => "2026-11-06"; render();');
    const columns = app.elements.get('sets-board').children;
    assert.match(cardsIn(columns[2])[0].innerHTML, /送り状：11\/25（水） の朝に自動で出ます/);
    assert.match(cardsIn(columns[1])[0].innerHTML, /送り状 5555-6666-7777/);
    app.run('openModal()');
    const note = app.elements.get('label-issue-note');
    assert.match(note.className, /tone-pending/);
    app.elements.get('f-usage-date').value = '2026-11-30';
    app.run('fillDatesFromUsage()');
    assert.equal(app.elements.get('f-ship-date').value, '2026-11-25');
    assert.equal(note.textContent, '送り状は 11/25（水） の朝（9:15ごろ）に自動で出ます。');
    assert.match(note.className, /tone-info/);
    app.elements.get('f-auto-label').checked = false;
    app.run('updateLabelIssueNote()');
    assert.match(note.className, /hidden/);
    app.run('openModal(8)');
    assert.equal(note.textContent, '送り状は発行済みです（送り状番号 5555-6666-7777）。');
});

test('C1: a notice appears from October of the last year in the holiday data', () => {
    const app = setup([]);
    assert.equal(app.run('JAPAN_HOLIDAY_CALENDAR.lastYear'), 2027);
    assert.equal(app.run('holidayDataNotice("2027-09-30")'), '');
    assert.match(app.run('holidayDataNotice("2027-10-01")'), /2027 年 12 月まで/);
    assert.match(app.run('holidayDataNotice("2028-01-04")'), /2028 年以降の営業日を数えられません/);
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
    // Display order follows delivery dates, not the next-shipment highlight.
    assert.match(cards[0].innerHTML, /No.4/);
    app.run("state.records[0].lastCheck = '2026-10-21'; render();");
    assert.equal(cardsIn(app.elements.get('sets-board').children[0]).filter(card => card.className.includes('next-shipment-card')).length, 1);
    assert.equal(app.writes.length, 0);
});
