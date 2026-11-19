// node --test exhibit/logic.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('./logic.js');

function makeCtx() {
    let seq = 0;
    return {
        master: L.defaultMaster(),
        today: '2026-11-19',
        now: '2026-11-19T10:00:00.000+09:00',
        actor: { email: 'tester@example.com', name: 'テスト' },
        newId: () => 'id' + (++seq)
    };
}
function holders(fields = {}) {
    return Object.assign({ id: 'h1', name: 'ネームホルダー', stock: 200, outs: [], total: 200, rev: 1 }, fields);
}

test('出庫 moves a number from 大阪 to a place; the return date is optional', () => {
    const ctx = makeCtx();
    const result = L.opOut(holders(), { areaId: 'okayama', place: 'コンベックス岡山', qty: 50 }, ctx);
    assert.equal(result.item.stock, 150);
    assert.equal(result.item.total, 200);
    assert.equal(result.item.rev, 2);
    assert.equal(result.history[0].before, '大阪 200');
    assert.equal(result.history[0].after, '大阪 150・岡山 50');
    assert.equal(result.history[0].place, '岡山・コンベックス岡山');
    assert.throws(() => L.opOut(holders(), { areaId: '', qty: 1 }, ctx), /貸出先/);
    assert.throws(() => L.opOut(holders(), { areaId: 'okayama', qty: 201 }, ctx), /大阪にあるのは200個/);
    assert.throws(() => L.opOut(holders(), { areaId: 'okayama', qty: '' }, ctx), /出す数/);
});

test('返却 counts back and missing; missing ones leave the total', () => {
    const ctx = makeCtx();
    const lent = L.opOut(holders(), { areaId: 'nagoya', qty: 50, dueDate: '2026-11-30' }, ctx).item;
    const key = lent.outs[0].key;
    const back = L.opReturn(lent, { outKey: key, back: 45, missing: 5 }, ctx);
    assert.equal(back.item.stock, 195);
    assert.equal(back.item.outs.length, 0);
    assert.equal(back.item.total, 195);
    assert.equal(back.history[0].inspection, '戻った 45・足りない 5');
    // Only part came back: the rest stays lent.
    const part = L.opReturn(lent, { outKey: key, back: 20 }, ctx).item;
    assert.equal(part.outs[0].qty, 30);
    assert.throws(() => L.opReturn(lent, { outKey: key, back: 51 }, ctx), /50個/);
    assert.throws(() => L.opReturn(lent, { outKey: key }, ctx), /戻った数/);
});

test('転送 moves part of a loan to another place', () => {
    const ctx = makeCtx();
    const lent = L.opOut(holders(), { areaId: 'okayama', qty: 50 }, ctx).item;
    const moved = L.opTransfer(lent, { outKey: lent.outs[0].key, areaId: 'ehime', qty: 20, dueDate: '2026-12-10' }, ctx);
    assert.equal(moved.item.stock, 150);
    assert.equal(L.breakdownLabel(moved.item, ctx.master), '大阪 150・岡山 30・愛媛 20');
    assert.equal(moved.history[0].place, '岡山 → 愛媛');
});

test('数を変える: add and remove at the base', () => {
    const ctx = makeCtx();
    const added = L.opAdjust(holders(), { action: 'add', qty: 30, comment: '購入' }, ctx);
    assert.equal(added.item.total, 230);
    assert.equal(added.history[0].action, 'add');
    assert.equal(L.opAdjust(holders(), { action: 'remove', qty: 10 }, ctx).item.total, 190);
    const lent = L.opOut(holders(), { areaId: 'okayama', qty: 150 }, ctx).item;
    assert.throws(() => L.opAdjust(lent, { action: 'remove', qty: 51 }, ctx), /大阪にあるのは50個/);
    assert.throws(() => L.opAdjust(holders(), { action: 'repair', qty: 1 }, ctx), /どうするか/);
});

test('warnings come from dates and the needed count', () => {
    const ctx = makeCtx();
    const late = holders({ stock: 150, outs: [{ key: 'a', areaId: 'okayama', qty: 50, dueDate: '2026-11-15' }], total: 200, minQty: 210 });
    const view = L.computeView(late, ctx);
    assert.equal(view.overdue.days, 4);
    assert.equal(view.short.need, 10);
    assert.equal(view.rank, 0);
    assert.equal(view.dueDate, '2026-11-15');
    assert.equal(L.computeView(holders(), ctx).overdue, null);
});

test('登録 needs a name that is not taken and at least one', () => {
    const ctx = makeCtx();
    const names = [{ id: 'h1', name: 'ネームホルダー' }];
    const scanner = L.opRegister({ name: 'バーコードスキャナー', total: '４' }, ctx, names);
    assert.equal(scanner.item.total, 4);
    assert.equal(scanner.item.stock, 4);
    assert.throws(() => L.opRegister({ name: 'ﾈｰﾑﾎﾙﾀﾞｰ', total: 5 }, ctx, names), /もう登録/);
    assert.throws(() => L.opRegister({ name: 'x', total: 0 }, ctx, names), /保有数/);
    const lent = L.opRegister({ name: 'のぼり', total: 20, outQty: 5, areaId: 'nagoya', dueDate: '2026-12-10' }, ctx, names).item;
    assert.equal(L.breakdownLabel(lent, ctx.master), '大阪 15・名古屋 5');
});

test('編集 changes the details but not the counts', () => {
    const ctx = makeCtx();
    const edited = L.opEdit(holders(), { name: 'ネームホルダー', minQty: 150, note: '来場者用' }, ctx, []);
    assert.equal(edited.item.minQty, 150);
    assert.equal(edited.item.total, 200);
    assert.equal(edited.history[0].comment, '必要数、備考を変更');
    assert.equal(L.opEdit(holders(), { name: 'ネームホルダー' }, ctx, []), null);
});

test('CSV round trip and import rows (template samples are skipped)', () => {
    const csv = L.toCSV([['a', 'b,c', 'say "hi"'], ['=SUM(A1)', '-5', '改行\nあり']]);
    assert.deepEqual(L.parseCSV('﻿' + csv), [['a', 'b,c', 'say "hi"'], ["'=SUM(A1)", '-5', '改行\nあり']]);
    const ctx = makeCtx();
    assert.deepEqual(L.readImportRows(L.importTemplate(), ctx), { inputs: [], errors: [], skipped: 2 });
    const rows = L.importTemplate().map((row, i) => (i ? row.slice(0, 3).concat([''], row.slice(4)) : row));
    const { inputs, errors } = L.readImportRows(rows, ctx);
    assert.equal(errors.length, 0);
    assert.equal(inputs[1].input.areaId, 'okayama');
    assert.equal(inputs[1].input.dueDate, '2026-12-05');
    const bad = L.readImportRows([['備品名', '保有数', '貸出先'], ['x', '1', '札幌']], ctx);
    assert.match(bad.errors[0].message, /札幌/);
});
