/* 展示会備品 — rules shared by the page and the tests (no DOM, no database).
 * Every item is counted: how many are in the base (大阪) and how many are lent to each place.
 * Each operation takes the latest item and returns the new
 * item plus the history entry, so the page can write both together in one transaction. */
(function (root) {
    'use strict';

    const ACTION_LABELS = Object.freeze({
        register: '登録', edit: '編集', out: '出庫', return: '返却', transfer: '転送',
        add: '追加', remove: '減らす'
    });
    const ADJUST_ACTIONS = Object.freeze({
        add: { label: '追加する', hint: '補充した・見つかった' },
        remove: { label: '減らす', hint: 'なくなった・壊れた・捨てた' }
    });

    function defaultMaster() {
        return {
            areas: [
                { id: 'osaka', name: '大阪', base: true },
                { id: 'okayama', name: '岡山' },
                { id: 'nagoya', name: '名古屋' },
                { id: 'ehime', name: '愛媛' },
                { id: 'other', name: 'その他' }
            ]
        };
    }
    function normalizeMaster(saved) {
        const base = defaultMaster();
        if (!saved || typeof saved !== 'object') return base;
        return {
            areas: Array.isArray(saved.areas) && saved.areas.length ? saved.areas : base.areas
        };
    }

    // ---- small helpers ----
    function n(value) { const x = Number(value); return Number.isFinite(x) ? x : 0; }
    function sum(list, pick) { return list.reduce((total, x) => total + n(pick(x)), 0); }
    function pad(value) { return String(value).padStart(2, '0'); }
    function userError(message) { const error = new Error(message); error.userMessage = message; return error; }
    function toHalf(value) {
        return String(value == null ? '' : value)
            .replace(/[０-９Ａ-Ｚａ-ｚ－／．：]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
            .replace(/[ー―‐−]/g, '-')
            .trim();
    }
    function toInt(value) {
        if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
        const textValue = toHalf(value).replace(/,/g, '');
        return /^-?\d+$/.test(textValue) ? Number(textValue) : NaN;
    }
    // Blank means 0 (for optional counts).
    function countOf(value) { return value === undefined || value === null || String(value).trim() === '' ? 0 : toInt(value); }
    function text(value) { return String(value == null ? '' : value).trim(); }
    // For matching names and searching: full/half width and case do not matter.
    function normalizeKey(value) { return String(value == null ? '' : value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); }

    // ---- dates (YYYY-MM-DD strings, compared as text) ----
    function todayStr(now) {
        const d = now || new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
    function localISO(now) {
        const d = now || new Date();
        const offset = -d.getTimezoneOffset();
        const abs = Math.abs(offset);
        return todayStr(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' +
            String(d.getMilliseconds()).padStart(3, '0') + (offset >= 0 ? '+' : '-') + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
    }
    function isDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
        const [y, m, d] = value.split('-').map(Number);
        const date = new Date(Date.UTC(y, m - 1, d));
        return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
    }
    function normalizeDate(value) {
        const match = toHalf(value).match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/);
        if (!match) return '';
        const date = match[1] + '-' + pad(match[2]) + '-' + pad(match[3]);
        return isDate(date) ? date : '';
    }
    function addDays(date, days) {
        const [y, m, d] = date.split('-').map(Number);
        const t = new Date(Date.UTC(y, m - 1, d + days));
        return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
    }
    function daysBetween(from, to) {
        const a = from.split('-').map(Number);
        const b = to.split('-').map(Number);
        return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
    }
    function formatDate(date, today) {
        if (!isDate(date)) return '';
        const [y, m, d] = date.split('-').map(Number);
        const weekday = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
        return (today && today.slice(0, 4) === date.slice(0, 4) ? '' : y + '/') + m + '/' + d + '(' + weekday + ')';
    }
    function formatDateTime(at, today) {
        if (!at || typeof at !== 'string' || !isDate(at.slice(0, 10))) return '';
        const [y, m, d] = at.slice(0, 10).split('-').map(Number);
        return (today && today.slice(0, 4) === at.slice(0, 4) ? '' : y + '/') + m + '/' + d + ' ' + at.slice(11, 16);
    }

    // ---- places ----
    function areaOf(master, id) { return (master.areas || []).find(area => area.id === id) || null; }
    function areaName(master, id) { const area = areaOf(master, id); return area ? area.name : (id ? '（削除された拠点）' : ''); }
    function baseArea(master) {
        const areas = master.areas || [];
        return areas.find(area => area.base) || areas[0] || { id: 'osaka', name: '大阪', base: true };
    }
    function destLabel(out, master) { return areaName(master, out.areaId) + (out.place ? '・' + out.place : ''); }

    // ---- counts ----
    function counts(item) {
        const outs = Array.isArray(item.outs) ? item.outs.filter(out => n(out.qty) > 0) : [];
        const result = { stock: n(item.stock), out: sum(outs, out => out.qty), outs };
        result.total = result.stock + result.out;
        return result;
    }
    function withCounts(item, parts) {
        const outs = (parts.outs || []).filter(out => n(out.qty) > 0);
        const stock = n(parts.stock);
        return Object.assign({}, item, { stock, outs, total: stock + sum(outs, out => out.qty) });
    }
    function groupOuts(outs, master) {
        const groups = [];
        outs.forEach(out => {
            const name = areaName(master, out.areaId);
            const group = groups.find(g => g.name === name);
            if (group) group.qty += n(out.qty); else groups.push({ name, qty: n(out.qty) });
        });
        return groups;
    }
    // "大阪 15・岡山 5"
    function breakdownLabel(item, master) {
        const c = counts(item);
        const parts = [baseArea(master).name + ' ' + c.stock];
        groupOuts(c.outs, master).forEach(group => parts.push(group.name + ' ' + group.qty));
        return parts.join('・');
    }

    // ---- what needs attention (worked out from the counts and dates) ----
    function computeView(item, ctx) {
        const c = counts(item);
        const late = c.outs.filter(out => out.dueDate && out.dueDate < ctx.today);
        const overdue = late.length ? { days: Math.max.apply(null, late.map(out => daysBetween(out.dueDate, ctx.today))), qty: sum(late, out => out.qty) } : null;
        const minQty = n(item.minQty);
        const short = minQty > 0 && c.total < minQty ? { need: minQty - c.total } : null;
        const dues = c.outs.map(out => out.dueDate).filter(Boolean).sort();
        let rank = 4;
        if (overdue) rank = 0;
        else if (short) rank = 1;
        else if (c.out) rank = 3;
        return { counts: c, overdue, short, dueDate: dues[0] || '', breakdown: breakdownLabel(item, ctx.master), rank };
    }

    // ---- operations ----
    function touch(item, ctx) {
        return Object.assign({}, item, { rev: n(item.rev) + 1, updatedAt: ctx.now, updatedBy: ctx.actor.email || '', updatedByName: ctx.actor.name || '' });
    }
    function makeHistory(ctx, before, after, data) {
        return Object.assign({
            id: ctx.newId(), at: ctx.now, by: ctx.actor.email || '', byName: ctx.actor.name || '',
            itemId: after.id, itemName: after.name || '',
            before: before ? breakdownLabel(before, ctx.master) : '', after: breakdownLabel(after, ctx.master),
            qty: 0, place: '', dueDate: '', inspection: '', comment: ''
        }, data);
    }
    function readCount(value, label, min) {
        const count = toInt(value);
        if (!(count >= min)) throw userError(label + 'は' + min + '以上の数で入れてください。');
        return count;
    }
    function readDue(value) {
        if (!value) return '';
        if (!isDate(value)) throw userError('返却予定日の形が正しくありません。');
        return value;
    }
    function readArea(areaId, ctx) {
        if (!areaOf(ctx.master, areaId)) throw userError('貸出先を選んでください。');
        return areaId;
    }
    function addOut(outs, entry) {
        const same = outs.find(out => out.areaId === entry.areaId && (out.place || '') === entry.place && (out.dueDate || '') === entry.dueDate);
        if (same) same.qty = n(same.qty) + entry.qty; else outs.push(entry);
        return outs;
    }
    function findOut(item, c, key) {
        const out = c.outs.find(o => o.key === key);
        if (!out) throw userError(item.name + '：貸出先が見つかりません。画面を読み込み直してください。');
        return out;
    }

    // 出庫: from the base to another place.
    function opOut(item, input, ctx) {
        const areaId = readArea(input.areaId, ctx);
        const dueDate = readDue(input.dueDate);
        const c = counts(item);
        const qty = readCount(input.qty, item.name + 'の出す数', 1);
        if (qty > c.stock) throw userError(item.name + '：' + baseArea(ctx.master).name + 'にあるのは' + c.stock + '個です。');
        const entry = { key: ctx.newId(), areaId, place: text(input.place), qty, dueDate, outAt: ctx.today };
        const outs = addOut(c.outs.map(out => Object.assign({}, out)), entry);
        const next = touch(withCounts(item, { stock: c.stock - qty, outs }), ctx);
        return { item: next, history: [makeHistory(ctx, item, next, { action: 'out', qty, place: destLabel(entry, ctx.master), dueDate, comment: text(input.comment) })] };
    }

    // 返却: back / missing (→ fewer owned). Anything not counted stays lent.
    function opReturn(item, input, ctx) {
        const c = counts(item);
        const out = findOut(item, c, input.outKey);
        const back = countOf(input.back);
        const missing = countOf(input.missing);
        if (![back, missing].every(x => x >= 0)) throw userError(item.name + '：数は0以上で入れてください。');
        const qty = back + missing;
        if (qty < 1) throw userError(item.name + '：戻った数を入れてください。');
        if (qty > n(out.qty)) throw userError(item.name + '：' + destLabel(out, ctx.master) + 'に貸しているのは' + out.qty + '個です。');
        const outs = c.outs.map(o => (o.key === out.key ? Object.assign({}, o, { qty: n(o.qty) - qty }) : Object.assign({}, o)));
        const next = touch(withCounts(item, { stock: c.stock + back, outs }), ctx);
        const inspection = [['戻った', back], ['足りない', missing]].filter(p => p[1]).map(p => p[0] + ' ' + p[1]).join('・');
        return { item: next, history: [makeHistory(ctx, item, next, { action: 'return', qty, place: destLabel(out, ctx.master), inspection, comment: text(input.comment) })] };
    }

    // 転送: sent on from one place to another without coming back.
    function opTransfer(item, input, ctx) {
        const c = counts(item);
        const out = findOut(item, c, input.outKey);
        const areaId = readArea(input.areaId, ctx);
        const dueDate = readDue(input.dueDate);
        const qty = readCount(input.qty, '転送する数', 1);
        if (qty > n(out.qty)) throw userError(item.name + '：' + destLabel(out, ctx.master) + 'に貸しているのは' + out.qty + '個です。');
        const outs = c.outs.map(o => (o.key === out.key ? Object.assign({}, o, { qty: n(o.qty) - qty }) : Object.assign({}, o)));
        const entry = { key: ctx.newId(), areaId, place: text(input.place), qty, dueDate, outAt: ctx.today };
        addOut(outs, entry);
        const next = touch(withCounts(item, { stock: c.stock, outs }), ctx);
        return { item: next, history: [makeHistory(ctx, item, next, { action: 'transfer', qty, place: destLabel(out, ctx.master) + ' → ' + destLabel(entry, ctx.master), dueDate, comment: text(input.comment) })] };
    }

    // 数を変える: add (bought more, found) / remove (lost, broken, thrown away) at the base.
    function opAdjust(item, input, ctx) {
        const action = input.action;
        if (!ADJUST_ACTIONS[action]) throw userError('どうするかを選んでください。');
        const c = counts(item);
        const qty = readCount(input.qty, '数', 1);
        if (action === 'remove' && qty > c.stock) throw userError(baseArea(ctx.master).name + 'にあるのは' + c.stock + '個です。');
        const next = touch(withCounts(item, { stock: c.stock + (action === 'add' ? qty : -qty), outs: c.outs }), ctx);
        return { item: next, history: [makeHistory(ctx, item, next, { action, qty, comment: text(input.comment) })] };
    }

    function readBasics(input, ctx, names, selfId) {
        const name = text(input.name);
        if (!name) throw userError('備品名を入れてください。');
        const key = normalizeKey(name);
        if (names && names.some(other => other.id !== selfId && normalizeKey(other.name) === key)) throw userError('「' + name + '」はもう登録されています。');
        const minQty = countOf(input.minQty);
        if (!(minQty >= 0)) throw userError('必要数は0以上の数で入れてください。');
        return { name, minQty, note: text(input.note) };
    }

    // 登録. names: [{ id, name }] already registered (names must not repeat).
    function opRegister(input, ctx, names) {
        const basics = readBasics(input, ctx, names, null);
        const total = readCount(input.total, '保有数', 1);
        const outQty = countOf(input.outQty);
        if (!(outQty >= 0)) throw userError('貸出中の数は0以上の数で入れてください。');
        if (outQty > total) throw userError('貸出中の数が保有数を超えています。');
        const outs = [];
        if (outQty) outs.push({ key: ctx.newId(), areaId: readArea(input.areaId, ctx), place: text(input.place), qty: outQty, dueDate: readDue(input.dueDate), outAt: '' });
        const item = touch(withCounts(Object.assign({ id: ctx.newId() }, basics, {
            thumb: input.thumb || '', hasPhoto: !!input.thumb, rev: 0,
            createdAt: ctx.now, createdBy: ctx.actor.email || '', createdByName: ctx.actor.name || ''
        }), { stock: total - outQty, outs }), ctx);
        return { item, history: [makeHistory(ctx, null, item, { action: 'register', qty: total, comment: text(input.historyNote) })] };
    }

    // 編集: name, note, the count it should have, photo (counts change through the other operations).
    function opEdit(item, input, ctx, names) {
        const basics = readBasics(input, ctx, names, item.id);
        const labels = { name: '備品名', minQty: '必要数', note: '備考' };
        const changed = Object.keys(labels).filter(key => basics[key] !== (key === 'minQty' ? n(item.minQty) : text(item[key])));
        const next = Object.assign({}, item, basics);
        if (input.thumb !== undefined && (input.thumb || '') !== (item.thumb || '')) {
            changed.push('photo');
            next.thumb = input.thumb || '';
            next.hasPhoto = !!input.thumb;
        }
        if (!changed.length) return null;
        const touched = touch(next, ctx);
        const comment = changed.map(key => (key === 'photo' ? '写真' : labels[key])).join('、') + 'を変更';
        return { item: touched, history: [makeHistory(ctx, item, touched, { action: 'edit', comment, before: '', after: '' })] };
    }

    // ---- CSV ----
    function parseCSV(source) {
        const input = String(source || '').replace(/^﻿/, '');
        const rows = [];
        let row = [];
        let field = '';
        let quoted = false;
        for (let i = 0; i < input.length; i++) {
            const ch = input[i];
            if (quoted) {
                if (ch === '"') {
                    if (input[i + 1] === '"') { field += '"'; i++; } else quoted = false;
                } else field += ch;
            } else if (ch === '"') quoted = true;
            else if (ch === ',') { row.push(field); field = ''; }
            else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else if (ch !== '\r') field += ch;
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        return rows.filter(r => r.some(cell => cell.trim() !== ''));
    }
    function csvCell(value) {
        let s = value == null ? '' : String(value);
        // Keep spreadsheet programs from reading a typed value as a formula.
        if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) s = "'" + s;
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function toCSV(rows) { return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

    const IMPORT_COLUMNS = ['備品名', '保有数', '必要数', '備考', '貸出中の数', '貸出先', '会場・メモ', '返却予定日'];
    function importTemplate() {
        return [
            IMPORT_COLUMNS,
            ['バーコードスキャナー', '4', '', '例：今は全部大阪にある', '', '', '', ''],
            ['ネームホルダー', '200', '150', '例：貸出中があれば数と貸出先も', '50', '岡山', 'コンベックス岡山', '2026-12-05']
        ];
    }
    function readImportRows(rows, ctx) {
        const errors = [];
        const inputs = [];
        let skipped = 0;
        if (!rows.length) return { inputs, errors: [{ rowNo: 1, message: 'CSVが空です。' }], skipped };
        const header = rows[0].map(cell => text(cell).replace(/^﻿/, ''));
        const index = {};
        header.forEach((name, i) => { index[name] = i; });
        const missing = ['備品名', '保有数'].filter(name => !(name in index));
        if (missing.length) return { inputs, errors: [{ rowNo: 1, message: '1行目に「' + missing.join('」「') + '」の列がありません。ひな形の見出しを使ってください。' }], skipped };
        const cell = (row, name) => (name in index ? text(row[index[name]]) : '');
        rows.slice(1).forEach((row, i) => {
            const rowNo = i + 2;
            // The template's sample rows (備考 starting with 例：) are never imported.
            if (/^例[：:]/.test(cell(row, '備考'))) { skipped++; return; }
            const areaText = normalizeKey(cell(row, '貸出先'));
            const area = areaText ? (ctx.master.areas || []).find(a => normalizeKey(a.name) === areaText) : null;
            if (areaText && !area) { errors.push({ rowNo, message: '貸出先「' + cell(row, '貸出先') + '」が拠点にありません。' }); return; }
            const due = cell(row, '返却予定日');
            const dueDate = due ? normalizeDate(due) : '';
            if (due && !dueDate) { errors.push({ rowNo, message: '返却予定日「' + due + '」を日付として読めません（例：2026-12-05）。' }); return; }
            inputs.push({
                rowNo,
                input: {
                    name: cell(row, '備品名'), total: cell(row, '保有数'), minQty: cell(row, '必要数'), note: cell(row, '備考'),
                    outQty: cell(row, '貸出中の数'), areaId: area ? area.id : '', place: cell(row, '会場・メモ'), dueDate, historyNote: 'CSV一括登録'
                }
            });
        });
        return { inputs, errors, skipped };
    }

    const api = {
        ACTION_LABELS, ADJUST_ACTIONS, IMPORT_COLUMNS,
        defaultMaster, normalizeMaster, userError, toHalf, toInt, normalizeKey,
        todayStr, localISO, isDate, normalizeDate, addDays, daysBetween, formatDate, formatDateTime,
        areaOf, areaName, baseArea, destLabel, counts, breakdownLabel, computeView,
        opOut, opReturn, opTransfer, opAdjust, opRegister, opEdit,
        parseCSV, toCSV, importTemplate, readImportRows
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ExhibitLogic = api;
})(typeof window !== 'undefined' ? window : this);
