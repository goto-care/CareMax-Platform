/* 年間スケジュール（Kaientai-Y）の「次の予定」を1件選ぶ。TOPページのヘッダーで使う。
 * データの読み方（その年に出すスケジュール・済チェック）は schedule/app.js と同じにしてある。
 * app.js の yearDocs・progId・normMark を変えたときは、ここも合わせる。
 *
 * 選び方：
 *  - 済チェックが付いた工程は出さない。
 *  - 締切（◆）は締切の日、時期（●）・期間（バー）は始まる日で、今日以降のいちばん近いものを出す。
 *  - 「12月中旬」のような時期は、今日がその時期の中なら「今の時期」として出す。始まっている期間（バー）は出さない。 */
(function (global) {
  'use strict';

  var PART_KEYS = ['start', 'early', 'mid', 'late', 'end'];
  var PART_JA = { start: '初め', early: '上旬', mid: '中旬', late: '下旬', end: '末' };
  var TYPES = ['point', 'range', 'dead'];
  var MAX_M = 18; // 1〜12 = その年、13〜18 = 翌年1〜6月
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  var DAY_MS = 86400000;

  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function clampInt(v, lo, hi) { v = Math.round(+v); return v >= lo && v <= hi ? v : 0; }

  function normMark(k) {
    if (!k || typeof k !== 'object') return null;
    var m1 = clampInt(k.m1, 1, MAX_M); if (!m1) return null;
    var o = { type: TYPES.indexOf(k.type) >= 0 ? k.type : 'point', m1: m1,
      p1: PART_KEYS.indexOf(k.p1) >= 0 ? k.p1 : 'mid', when: str(k.when).trim(), what: str(k.what).trim() };
    if (k.p1 === 'day' && clampInt(k.d1, 1, 31)) { o.p1 = 'day'; o.d1 = clampInt(k.d1, 1, 31); }
    if (o.type === 'range') {
      o.m2 = clampInt(k.m2, 1, MAX_M) || m1;
      o.p2 = PART_KEYS.indexOf(k.p2) >= 0 ? k.p2 : 'end';
      if (k.p2 === 'day' && clampInt(k.d2, 1, 31)) { o.p2 = 'day'; o.d2 = clampInt(k.d2, 1, 31); }
    }
    return o;
  }
  function normDoc(x) {
    x = x && typeof x === 'object' ? x : {};
    return {
      year: clampInt(x.year, 1900, 2200), series: str(x.series), name: str(x.name) || '（名前なし）',
      repeat: !!x.repeat, until: clampInt(x.until, 1900, 2200), order: +x.order || 0,
      groups: arr(x.groups).map(function (g, gi) {
        g = g && typeof g === 'object' ? g : {};
        return { id: str(g.id) || 'g' + gi, tasks: arr(g.tasks).map(function (t, ti) {
          t = t && typeof t === 'object' ? t : {};
          return { id: str(t.id) || 't' + gi + '-' + ti, title: str(t.title) || '（名前なし）',
            marks: arr(t.marks).map(normMark).filter(Boolean) };
        }) };
      })
    };
  }

  function seriesOf(d) { return d.data.series || d.id; }
  function covers(d, y) { var p = d.data; return p.repeat ? (p.year <= y && (!p.until || y <= p.until)) : p.year === y; }
  function yearDocs(docs, y) {
    var own = {};
    docs.forEach(function (d) { if (!d.data.repeat && d.data.year === y) own[seriesOf(d)] = 1; });
    return docs.filter(function (d) { return covers(d, y) && !(d.data.repeat && own[seriesOf(d)]); });
  }
  function progId(y, d) { return y + '_' + seriesOf(d).replace(/[^A-Za-z0-9_\-.~:@+]/g, '-'); }
  function isDone(prog, y, d, g, t) {
    var p = prog[progId(y, d)], e = p && p.done && p.done[g.id + '__' + t.id];
    return !!(e && typeof e === 'object' && e.on);
  }

  // m（1〜18）を、y 年から見た本当の年・月にする
  function realYM(y, m) { return { y: y + (m > 12 ? 1 : 0), m: ((m - 1) % 12) + 1 }; }
  function daysIn(ym) { return new Date(ym.y, ym.m, 0).getDate(); }
  // 「上旬」などが、その月の何日から何日か
  function partRange(part, dim) {
    if (part === 'start') return [1, 5];
    if (part === 'early') return [1, 10];
    if (part === 'mid') return [11, 20];
    if (part === 'late') return [21, dim];
    return [Math.max(dim - 4, 1), dim]; // end（末）
  }
  function dateOf(y, m, part, day, last) {
    var ym = realYM(y, m), dim = daysIn(ym);
    var d = part === 'day' ? Math.min(day || 1, dim) : partRange(part, dim)[last ? 1 : 0];
    return new Date(ym.y, ym.m - 1, d);
  }
  function startOf(k, y) { return dateOf(y, k.m1, k.p1, k.d1, false); }
  function endOf(k, y) {
    if (k.type === 'range') return dateOf(y, k.m2, k.p2, k.d2, true);
    return dateOf(y, k.m1, k.p1, k.d1, true);
  }

  function pointText(y, m, part, day) {
    var ym = realYM(y, m);
    if (part === 'day') {
      var d = Math.min(day || 1, daysIn(ym));
      return ym.m + '/' + d + '（' + WD[new Date(ym.y, ym.m - 1, d).getDay()] + '）';
    }
    return ym.m + '月' + PART_JA[part];
  }
  function whenText(k, y) {
    if (k.when) return k.when;
    if (k.type === 'range') return pointText(y, k.m1, k.p1, k.d1) + '〜' + pointText(y, k.m2, k.p2, k.d2);
    return pointText(y, k.m1, k.p1, k.d1) + (k.type === 'dead' ? 'まで' : '');
  }
  function daysBetween(a, b) { return Math.round((b - a) / DAY_MS); }

  /**
   * planDocs: [{ id, data }]（schedule_plans）、progDocs: [{ id, data }]（schedule_progress）
   * 返り値：{ when, title, plan, badge, y, pid, gid, tid } か、予定が無ければ null
   */
  function findNext(planDocs, progDocs, now) {
    now = now || new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var docs = arr(planDocs).map(function (d) { return { id: d.id, data: normDoc(d.data) }; });
    var prog = {};
    arr(progDocs).forEach(function (x) { if (x && x.data && typeof x.data === 'object') prog[x.id] = x.data; });

    var best = null;
    [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1].forEach(function (y) {
      yearDocs(docs, y).forEach(function (d) {
        d.data.groups.forEach(function (g) {
          g.tasks.forEach(function (t) {
            if (isDone(prog, y, d, g, t)) return;
            t.marks.forEach(function (k) {
              var s = startOf(k, y), e = endOf(k, y), key, badge;
              if (e < today) return;
              if (k.type === 'dead') {
                key = e;
                var left = daysBetween(today, e);
                badge = left === 0 ? '今日まで' : 'あと' + left + '日';
              } else if (s >= today) {
                key = s;
                var n = daysBetween(today, s);
                badge = n === 0 ? '今日' : (n === 1 ? '明日' : 'あと' + n + '日');
              } else if (k.type === 'point') {
                key = today;
                badge = '今の時期';
              } else {
                return; // もう始まっている期間（バー）
              }
              if (best && (key > best.key || (+key === +best.key && d.data.order >= best.order))) return;
              best = { key: key, order: d.data.order, when: whenText(k, y),
                title: t.title + (k.what ? ' ' + k.what : ''), plan: d.data.name, badge: badge,
                y: y, pid: d.id, gid: g.id, tid: t.id };
            });
          });
        });
      });
    });
    if (best) delete best.key;
    if (best) delete best.order;
    return best;
  }

  // 年間スケジュールの画面で、その工程を開くためのリンク
  function linkTo(item, base) {
    return (base || 'schedule/index.html') + '#task=' +
      [item.y, item.pid, item.gid, item.tid].map(encodeURIComponent).join('/');
  }

  global.ScheduleNext = { findNext: findNext, linkTo: linkTo };
})(window);
