/* 展示会備品 — made-up data for the demo (?demo=1 or the portal's demo login).
 * Built with the same operations as the real screen, so the history and the counts always agree.
 * Dates are relative to today, so the warnings on the top screen always have something to show. */
(function (root) {
    'use strict';

    function seed(L) {
        const master = L.defaultMaster();
        const data = { items: [], history: [], photos: {}, settings: { master } };
        const actors = [{ email: 'demo@caremax.local', name: 'デモユーザー' }, { email: 'tanaka@example.com', name: '田中（企画部）' }];
        let seq = 0;
        function ctxAt(offset, hour, actorIndex) {
            const d = new Date();
            d.setDate(d.getDate() + offset);
            d.setHours(hour || 10, (seq * 7) % 60, 0, 0);
            return { master, today: L.todayStr(d), now: L.localISO(d), actor: actors[actorIndex || 0], newId: () => 'demo' + (++seq).toString(36).padStart(4, '0') };
        }
        const day = offset => L.addDays(L.todayStr(), offset);
        const get = id => data.items.find(item => item.id === id);
        function apply(result) {
            const index = data.items.findIndex(item => item.id === result.item.id);
            if (index > -1) data.items[index] = result.item; else data.items.push(result.item);
            result.history.forEach(entry => data.history.push(entry));
            return result.item;
        }
        const register = input => apply(L.opRegister(input, ctxAt(-40, 9), data.items)).id;
        const out = (id, input, offset) => apply(L.opOut(get(id), input, ctxAt(offset, 16, 1)));
        const back = (id, input, offset) => apply(L.opReturn(get(id), Object.assign({ outKey: L.counts(get(id)).outs[0].key }, input), ctxAt(offset, 14)));
        const adjust = (id, input, offset) => apply(L.opAdjust(get(id), input, ctxAt(offset, 11)));

        const scanner = register({ name: 'バーコードスキャナー', total: 4, note: '充電器とセットで貸し出す' });
        const holders = register({ name: 'ネームホルダー（首掛け）', total: 200, minQty: 180, note: '来場者用。持ち帰られることがある' });
        const pens = register({ name: '来場者用ボールペン', total: 100, minQty: 80 });
        const tablet = register({ name: '受付用タブレット', total: 3 });
        const projector = register({ name: 'プロジェクター', total: 1 });
        const flags = register({ name: 'のぼり（介援隊）', total: 20, note: 'ポールとセット' });
        const cloth = register({ name: 'テーブルクロス（紺）', total: 8 });
        register({ name: '延長コード（5m）', total: 10 });
        register({ name: '案内看板（A型）', total: 4 });
        register({ name: 'カタログスタンド', total: 12 });

        out(holders, { areaId: 'ehime', place: '愛媛県産業技術研究所', qty: 60, dueDate: day(-20) }, -30);
        back(holders, { back: 52, missing: 8, comment: '来場者が持ち帰った分' }, -20);
        out(holders, { areaId: 'okayama', place: 'コンベックス岡山', qty: 80, dueDate: day(-3) }, -9);
        back(holders, { back: 60, missing: 20 }, -3);
        out(scanner, { areaId: 'nagoya', place: '名古屋営業所', qty: 2, dueDate: day(-2) }, -12);
        adjust(pens, { action: 'add', qty: 20, comment: '補充（購入）' }, -5);
        adjust(projector, { action: 'remove', qty: 1, comment: 'ランプが切れて使えないため処分' }, -4);
        adjust(projector, { action: 'add', qty: 1, comment: '新しいものを購入' }, -3);
        out(flags, { areaId: 'okayama', place: 'コンベックス岡山', qty: 10, dueDate: day(8) }, -2);
        out(cloth, { areaId: 'okayama', place: 'コンベックス岡山', qty: 4, dueDate: day(8) }, -2);
        out(pens, { areaId: 'ehime', qty: 30, dueDate: day(5) }, -1);
        out(tablet, { areaId: 'other', place: '神戸国際展示場', qty: 1, dueDate: day(2) }, -1);
        return data;
    }

    root.ExhibitDemo = { seed };
})(window);
