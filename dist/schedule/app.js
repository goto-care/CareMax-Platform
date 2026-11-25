/* Kaientai-Y 年間スケジュール — CareMax Platform
 * ログイン中は Firestore（schedule_plans / schedule_progress）、デモ（?demo=1）はこのブラウザの中に保存する。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // ===== 決まった値 =====
  var COLORS = ['green', 'blue', 'amber', 'violet', 'rose', 'teal'];
  var COLOR_JA = { green: '緑', blue: '青', amber: 'オレンジ', violet: '紫', rose: 'ピンク', teal: '水色' };
  var PART_KEYS = ['start', 'early', 'mid', 'late', 'end'];
  var PART_JA = { start: '初め', early: '上旬', mid: '中旬', late: '下旬', end: '末' };
  var TYPES = ['point', 'range', 'dead'];
  var TYPE_JA = { point: '時期（●）', range: '期間（バー）', dead: '締切（◆）' };
  // 月の中の位置（0〜1）。点・締切／期間の始まり／期間の終わり
  var OFF_POINT = { start: 0.06, early: 0.15, mid: 0.5, late: 0.8, end: 0.9 };
  var OFF_START = { start: 0, early: 0.05, mid: 0.36, late: 0.7, end: 0.85 };
  var OFF_END = { start: 0.14, early: 0.33, mid: 0.64, late: 0.92, end: 1 };
  var MAX_M = 18; // 1〜12 = その年、13〜18 = 翌年1〜6月
  var KNOWN_PARTY = { '柴田先生': 0, 'リデザイン': 1, '社内': 2, 'システム部': 3, '仕入先': 4, '得意先': 5 };
  var CHEV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var PENCIL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.3 2.3l2.4 2.4L5.4 13l-3 .6.6-3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  var CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var WD = ['日', '月', '火', '水', '木', '金', '土'];

  var now = new Date();
  var T = { y: now.getFullYear(), m: now.getMonth() + 1 };
  T.frac = (now.getDate() - 1) / new Date(T.y, T.m, 0).getDate();

  // ===== 状態 =====
  var state = { docs: [], loaded: false, error: null, slow: false, local: false, canWrite: true, year: T.y, open: {}, openTask: {}, prog: {}, progDead: false };
  var store = null;
  try { state.open = JSON.parse(localStorage.getItem('sched-open-v2') || '{}') || {}; } catch (e) { state.open = {}; }
  function saveOpen() { try { localStorage.setItem('sched-open-v2', JSON.stringify(state.open)); } catch (e) {} }

  // ===== 小道具 =====
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function clampInt(v, lo, hi) { v = Math.round(+v); return v >= lo && v <= hi ? v : 0; }
  function newId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pct(x, cols) { return (x / cols * 100).toFixed(3) + '%'; }
  function monthLabel(m) { return (m > 12 ? '翌年' : '') + (((m - 1) % 12) + 1) + '月'; }
  function dimOf(m) { return DIM[(m - 1) % 12]; }
  function usesDay(k) { return k.p1 === 'day' || (k.type === 'range' && k.p2 === 'day'); }
  // 月の中の位置。日付で指定した印（p1 = 'day'）はその日から、ほかは「上旬・中旬…」から決める
  function mStart(k) {
    if (k.p1 === 'day') return (k.m1 - 1) + (Math.min(k.d1 || 1, dimOf(k.m1)) - (k.type === 'range' ? 1 : 0.5)) / dimOf(k.m1);
    return (k.m1 - 1) + (k.type === 'range' ? OFF_START : OFF_POINT)[k.p1];
  }
  function mEnd(k) {
    if (k.type !== 'range') return mStart(k);
    if (k.p2 === 'day') return (k.m2 - 1) + Math.min(k.d2 || 1, dimOf(k.m2)) / dimOf(k.m2);
    return (k.m2 - 1) + OFF_END[k.p2];
  }
  // 「4/21（水）」。曜日は、見ている年のもの
  function dayText(m, d, y, short) {
    var mm = ((m - 1) % 12) + 1, yy = (y || state.year) + (m > 12 ? 1 : 0);
    return (m > 12 && !short ? '翌年' : '') + mm + '/' + d + (short ? '' : '（' + WD[new Date(yy, mm - 1, d).getDay()] + '）');
  }
  function autoWhen(k, y) {
    if (k.type === 'range') {
      if (usesDay(k)) {
        return (k.p1 === 'day' ? dayText(k.m1, k.d1, y) : monthLabel(k.m1) + PART_JA[k.p1]) + '〜' +
          (k.p2 === 'day' ? dayText(k.m2, k.d2, y) : monthLabel(k.m2) + PART_JA[k.p2]);
      }
      var a = k.p1 === 'start' ? '' : PART_JA[k.p1], b = k.p2 === 'end' ? '' : PART_JA[k.p2];
      if (k.m1 === k.m2 && !a && !b) return monthLabel(k.m1) + '中';
      if (k.m1 === k.m2) return monthLabel(k.m1) + (a || '初め') + '〜' + (b || '末');
      return monthLabel(k.m1) + a + '〜' + monthLabel(k.m2) + b;
    }
    if (k.p1 === 'day') return dayText(k.m1, k.d1, y) + (k.type === 'dead' ? 'まで' : '');
    return monthLabel(k.m1) + PART_JA[k.p1] + (k.type === 'dead' ? 'まで' : '');
  }
  function whenText(k, y) { return k.when || autoWhen(k, y); }
  // 年表の小さな文字用（曜日なし）
  function shortWhen(k, y) {
    if (k.when) return k.when;
    if (k.p1 === 'day') {
      return dayText(k.m1, k.d1, y, true) +
        (k.type === 'range' && k.p2 === 'day' && !(k.m2 === k.m1 && k.d2 === k.d1) ? '〜' + (k.m2 === k.m1 ? k.d2 : dayText(k.m2, k.d2, y, true)) : '');
    }
    return autoWhen(k, y);
  }
  function chartLabel(k, y) { var w = whenText(k, y); return k.what ? w + ' ' + k.what : w; }
  function partyClass(name) {
    if (KNOWN_PARTY.hasOwnProperty(name)) return 'pt-' + KNOWN_PARTY[name];
    var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
    return 'pt-' + (h % 6);
  }

  // 共有データは信用しない：形をそろえてから使う
  function normMark(k, i) {
    if (!k || typeof k !== 'object') return null;
    var m1 = clampInt(k.m1, 1, MAX_M); if (!m1) return null;
    var o = { id: str(k.id) || 'm' + i, type: TYPES.indexOf(k.type) >= 0 ? k.type : 'point', m1: m1,
      p1: PART_KEYS.indexOf(k.p1) >= 0 ? k.p1 : 'mid', when: str(k.when), what: str(k.what) };
    if (k.p1 === 'day' && clampInt(k.d1, 1, 31)) { o.p1 = 'day'; o.d1 = clampInt(k.d1, 1, 31); }
    if (o.type === 'range') {
      o.m2 = clampInt(k.m2, 1, MAX_M) || m1;
      o.p2 = PART_KEYS.indexOf(k.p2) >= 0 ? k.p2 : 'end';
      if (k.p2 === 'day' && clampInt(k.d2, 1, 31)) { o.p2 = 'day'; o.d2 = clampInt(k.d2, 1, 31); }
      if (mEnd(o) < mStart(o)) {
        o.m2 = o.m1;
        if (o.p1 === 'day') { o.p2 = 'day'; o.d2 = o.d1; } else { o.p1 = 'start'; o.p2 = 'end'; delete o.d2; }
      }
      o.fade = !!k.fade;
    }
    return o;
  }
  function normDoc(x) {
    x = x && typeof x === 'object' ? x : {};
    var groups = arr(x.groups).map(function (g, gi) {
      g = g && typeof g === 'object' ? g : {};
      return { id: str(g.id) || 'g' + gi, name: str(g.name), color: COLORS.indexOf(g.color) >= 0 ? g.color : 'green',
        tasks: arr(g.tasks).map(function (t, ti) {
          t = t && typeof t === 'object' ? t : {};
          return { id: str(t.id) || 't' + gi + '-' + ti, title: str(t.title) || '（名前なし）', party: str(t.party),
            todo: arr(t.todo).map(str).filter(Boolean), note: str(t.note),
            marks: arr(t.marks).map(normMark).filter(Boolean) };
        }) };
    });
    if (!groups.length) groups = [{ id: 'g0', name: '', color: 'green', tasks: [] }];
    return { year: clampInt(x.year, 1900, 2200), series: str(x.series), name: str(x.name) || '（名前なし）', sub: str(x.sub), order: +x.order || 0,
      repeat: !!x.repeat, until: clampInt(x.until, 1900, 2200), view: x.view === 'dots' ? 'dots' : 'bar', groups: groups };
  }

  function findDoc(id) { for (var i = 0; i < state.docs.length; i++) if (state.docs[i].id === id) return state.docs[i]; return null; }
  function seriesOf(d) { return d.data.series || d.id; }
  // 毎年のスケジュールは「始まりの年」から先のすべての年に出る（until があればその年まで）
  function covers(d, y) { var p = d.data; return p.repeat ? (p.year <= y && (!p.until || y <= p.until)) : p.year === y; }
  // その年に出すもの：その年だけのスケジュール＋毎年のスケジュール。
  // 同じスケジュールに「その年だけの内容」があれば、毎年の方は出さずにそちらを出す
  function yearDocs(y) {
    var own = {};
    state.docs.forEach(function (d) { if (!d.data.repeat && d.data.year === y) own[seriesOf(d)] = 1; });
    return state.docs.filter(function (d) { return covers(d, y) && !(d.data.repeat && own[seriesOf(d)]); })
      .sort(function (a, b) { return (a.data.order - b.data.order) || (a.id < b.id ? -1 : 1); });
  }
  // 「その年だけの内容」の元になっている、毎年のスケジュール
  function baseOf(d) {
    if (d.data.repeat) return null;
    var hit = null;
    state.docs.forEach(function (o) { if (o !== d && o.data.repeat && seriesOf(o) === seriesOf(d) && covers(o, d.data.year)) hit = o; });
    return hit;
  }
  function chipYears() {
    var lo = Math.min(T.y, state.year), hi = Math.max(T.y, state.year), floor = lo - 15;
    state.docs.forEach(function (d) {
      if (!d.data.year) return;
      lo = Math.min(lo, d.data.year);
      if (!d.data.repeat) hi = Math.max(hi, d.data.year);
    });
    var out = []; for (var y = Math.max(lo, floor); y <= hi + 1; y++) out.push(y);
    return out;
  }
  // コピー元にできる年：その年に、この年にはまだないスケジュールがある年
  function copySources(to) {
    var have = {}; yearDocs(to).forEach(function (d) { have[seriesOf(d)] = 1; });
    return chipYears().filter(function (y) { return y !== to && yearDocs(y).some(function (d) { return !have[seriesOf(d)]; }); });
  }
  function groupSpan(g) {
    var s = Infinity, e = -Infinity;
    g.tasks.forEach(function (t) { t.marks.forEach(function (k) { s = Math.min(s, mStart(k)); e = Math.max(e, mEnd(k)); }); });
    return s === Infinity ? null : [s, e];
  }
  function spanText(s, e) {
    var a = Math.floor(s + 1e-9) + 1, b = Math.max(Math.ceil(e - 1e-9), a);
    return a === b ? monthLabel(a) : monthLabel(a) + '〜' + monthLabel(b);
  }
  function taskCount(d) { var n = 0; d.data.groups.forEach(function (g) { n += g.tasks.length; }); return n; }
  function showGroupHead(d) { return d.data.groups.length > 1 || !!d.data.groups[0].name; }
  function groupName(g) { return g.name || '（区分名なし）'; }
  function taskKey(pid, gid, tid) { return pid + '|' + gid + '|' + tid; }

  // ===== 保存先 =====
  function deepMerge(a, b) {
    Object.keys(b).forEach(function (k) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
        if (!a[k] || typeof a[k] !== 'object') a[k] = {};
        deepMerge(a[k], b[k]);
      } else a[k] = b[k];
    });
    return a;
  }
  // 企画部ポータルにログインしているとき：Firestore（kikakubu-portal）に保存する
  var COLLECTIONS = { plans: 'schedule_plans', progress: 'schedule_progress' };
  function makeFirestoreStore(db) {
    var col = db.collection(COLLECTIONS.plans), pcol = db.collection(COLLECTIONS.progress);
    function pack(snap) { return snap.docs.map(function (d) { return { id: d.id, data: d.data() }; }); }
    return {
      subscribe: function (next, error) { return col.onSnapshot(function (snap) { next(pack(snap), snap.metadata.fromCache); }, error); },
      set: function (id, data) { return col.doc(id).set(data); },
      remove: function (id) { return col.doc(id).delete(); },
      reload: function (next) { return col.get().then(function (snap) { next(pack(snap), false); }); },
      subscribeProg: function (next, error) { return pcol.onSnapshot(function (snap) { next(pack(snap)); }, error); },
      // 済チェックは merge で「足しこむ」（ほかの人が付けたチェックを消さないため）
      mergeProg: function (id, patch) { return pcol.doc(id).set(patch, { merge: true }); }
    };
  }
  // デモ（?demo=1 か、ポータルのデモユーザー）のときは、このブラウザにだけ保存する
  function makeLocalStore() {
    var KEY = 'schedule-local-v1', PKEY = 'schedule-progress-v1';
    function read(k) { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { return {}; } }
    function list(k) { var m = read(k); return Object.keys(m).map(function (id) { return { id: id, data: m[id] }; }); }
    function write(k, m) { try { localStorage.setItem(k, JSON.stringify(m)); return Promise.resolve(); } catch (e) { return Promise.reject({ code: 'quota_exceeded' }); } }
    return {
      subscribe: function (next) { setTimeout(function () { next(list(KEY), false); }, 0); },
      set: function (id, data) { var m = read(KEY); m[id] = data; return write(KEY, m); },
      remove: function (id) { var m = read(KEY); delete m[id]; return write(KEY, m); },
      reload: function (next) { next(list(KEY), false); return Promise.resolve(); },
      subscribeProg: function (next) { setTimeout(function () { next(list(PKEY)); }, 0); },
      mergeProg: function (id, patch) { var m = read(PKEY); m[id] = deepMerge(m[id] || {}, patch); return write(PKEY, m); }
    };
  }

  function onDocs(docs, fromCache) {
    state.docs = docs.map(function (d) { return { id: d.id, data: normDoc(d.data) }; });
    state.loaded = true;
    if (!fromCache) { clearTimeout(slowTimer); state.slow = false; }
    render();
  }
  var slowTimer = null;
  function subscribe() {
    slowTimer = setTimeout(function () { state.slow = true; renderNotice(); }, 10000);
    store.subscribe(onDocs, function (e) {
      clearTimeout(slowTimer); state.slow = false; state.loaded = true;
      state.error = e && e.code === 'permission-denied' ? 'denied' : 'dead'; render();
    });
    store.subscribeProg(onProg, function () { state.progDead = true; if (state.loaded) render(); });
  }

  // 書き込みは、1つのスケジュールにつき1つずつ順番に
  var chains = {};
  function queue(id, job) {
    var p = (chains[id] || Promise.resolve()).then(job, job);
    chains[id] = p.catch(function () {});
    return p;
  }
  function retrying(fn) {
    return fn().catch(function (e) {
      if (e && e.code === 'unavailable') return wait(500 + Math.random() * 800).then(fn);
      throw e;
    });
  }
  function applyLocal(id, data) {
    var i = -1; state.docs.forEach(function (d, n) { if (d.id === id) i = n; });
    if (data === null) { if (i >= 0) state.docs.splice(i, 1); }
    else if (i >= 0) state.docs[i] = { id: id, data: normDoc(data) };
    else state.docs.push({ id: id, data: normDoc(data) });
    render();
  }
  function stamp(data) { data.updatedAt = new Date().toISOString(); return data; }
  function putDoc(id, data) {
    return queue(id, function () { stamp(data); applyLocal(id, data); return retrying(function () { return store.set(id, data); }); });
  }
  function mutate(id, fn) {
    return queue(id, function () {
      var cur = findDoc(id);
      if (!cur) return Promise.reject({ code: 'gone' });
      var data = clone(cur.data);
      if (fn(data) === false) return Promise.reject({ code: 'gone' });
      stamp(data); applyLocal(id, data);
      return retrying(function () { return store.set(id, data); });
    });
  }
  function removeDoc(id) {
    return queue(id, function () { applyLocal(id, null); return retrying(function () { return store.remove(id); }); });
  }
  function report(p, okMsg) {
    return p.then(function () { toast(okMsg); }, function (e) {
      var c = e && e.code, msg = '保存できませんでした。少し待って、もう一度試してください。';
      if (c === 'gone') msg = '保存できませんでした。ほかの人が先に消したようです。';
      else if (c === 'permission-denied' || c === 'invalid_argument' || c === 'not_granted' || c === 'revoked') { msg = '保存できませんでした。このページを編集できる権限がないようです。'; state.canWrite = false; }
      else if (c === 'quota_exceeded') msg = '保存できませんでした。保存できる量がいっぱいです。';
      toast(msg, true);
      if (store && store.reload) store.reload(onDocs).catch(function () {});
    });
  }

  // ===== 済チェックと年ごとのメモ（年×スケジュールごとに1つの記録） =====
  function progId(y, d) { return y + '_' + seriesOf(d).replace(/[^A-Za-z0-9_\-.~:@+]/g, '-'); }
  function progKey(g, t) { return g.id + '__' + t.id; }
  function progEntry(y, d, g, t) { var p = state.prog[progId(y, d)], e = p && p.done && p.done[progKey(g, t)]; return e && typeof e === 'object' ? e : null; }
  function isDone(y, d, g, t) { var e = progEntry(y, d, g, t); return !!(e && e.on); }
  function doneAt(y, d, g, t) { var e = progEntry(y, d, g, t); return e && e.on && typeof e.at === 'string' ? e.at : ''; }
  function memoOf(y, d, g, t) { var p = state.prog[progId(y, d)], v = p && p.memo && p.memo[progKey(g, t)]; return typeof v === 'string' ? v : ''; }
  // その年・そのスケジュールで、済チェックを使い始めているか（1つでも済があるか）
  function tracking(y, d) {
    var p = state.prog[progId(y, d)], on = false;
    if (p && p.done && typeof p.done === 'object') Object.keys(p.done).forEach(function (k) { if (p.done[k] && p.done[k].on) on = true; });
    return on;
  }
  function doneCount(y, d, g) {
    var n = 0;
    (g ? [g] : d.data.groups).forEach(function (gg) { gg.tasks.forEach(function (t) { if (isDone(y, d, gg, t)) n++; }); });
    return n;
  }
  function saveProg(y, d, patch, okMsg) {
    var id = progId(y, d);
    patch.year = y; patch.series = seriesOf(d);
    state.prog[id] = deepMerge(state.prog[id] ? clone(state.prog[id]) : {}, patch);
    keepScroll(render);
    queue('prog:' + id, function () { return retrying(function () { return store.mergeProg(id, patch); }); })
      .then(function () { if (okMsg) toast(okMsg); }, function (e) {
        var c = e && e.code;
        toast(c === 'permission-denied' || c === 'invalid_argument' || c === 'not_granted' || c === 'revoked'
          ? '保存できませんでした。このページを編集できる権限がないようです。'
          : '保存できませんでした。少し待って、もう一度試してください。', true);
      });
  }
  function onProg(docs) {
    var m = {};
    docs.forEach(function (x) { if (x.data && typeof x.data === 'object') m[x.id] = x.data; });
    state.prog = m;
    if (state.loaded) keepScroll(render);
  }
  function keepScroll(fn) { var sc = $('sched-scroll'), left = sc.scrollLeft; fn(); sc.scrollLeft = left; }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('toast');
    el.textContent = msg; el.classList.toggle('is-error', !!isError); el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isError ? 6000 : 2200);
  }

  // ===== 画面を描く =====
  function render() { renderYears(); renderActions(); renderNotice(); renderSched(); renderNow(); }

  function renderYears() {
    $('years').innerHTML = chipYears().map(function (y) {
      return '<button type="button" class="ychip' + (yearDocs(y).length ? '' : ' is-empty') + '" aria-pressed="' + (y === state.year) + '" data-year="' + y + '">' + y + '年</button>';
    }).join('');
  }

  function renderActions() {
    var html = '';
    if (state.loaded && !state.error && state.canWrite) {
      if (copySources(state.year).length) html += '<button type="button" class="btn" data-act="copy">ほかの年からコピー</button>';
      html += '<button type="button" class="btn" data-act="backup">バックアップ</button>';
      html += '<button type="button" class="btn primary" data-act="new-project">＋ 新しいスケジュール</button>';
    }
    $('actions').innerHTML = html;
  }

  function renderNotice() {
    var el = $('notice'), msg = '';
    if (state.error === 'nodb') msg = 'データベースの部品を読み込めませんでした。通信を確かめて、読み込み直してください。';
    else if (state.error === 'signin') msg = 'ログインが必要です。TOPページでログインしてから、もう一度開いてください。';
    else if (state.error === 'denied') msg = 'データベースの読み書きが許可されていません。Firebase（kikakubu-portal）の Firestore のルールで、schedule_ で始まるコレクションの読み書きを許可してください。';
    else if (state.error === 'dead') msg = 'データとの接続が切れました。ページを開き直してください。';
    else if (state.slow) msg = 'データにまだ届きません。つながりしだい表示します。見えている内容は古いかもしれません。';
    else if (state.local) msg = 'デモの画面です。入れた内容は、このブラウザにだけ保存されます。';
    else if (state.loaded && !state.canWrite) msg = '保存が許可されませんでした。直すには、書き込みの権限が要ります。';
    el.textContent = msg; el.hidden = !msg;
  }

  function cellsHTML(cols, nowCol, todayPos) {
    var h = '<div class="cells">';
    for (var c = 0; c < cols; c++) h += '<i class="' + (c === nowCol ? 'now' : '') + (c === 12 ? ' next-year' : '') + '"></i>';
    h += '</div>';
    if (todayPos !== null) h += '<span class="today" style="left:' + pct(todayPos, cols) + '"></span>';
    return h;
  }

  function markHTML(k, cols, y) {
    var s = mStart(k), e = mEnd(k), h;
    if (k.type === 'range') h = '<span class="mk mk-range' + (k.fade ? ' fade' : '') + '" style="left:' + pct(s, cols) + ';width:' + pct(Math.max(e - s, 0.02), cols) + '"></span>';
    else h = '<span class="mk mk-' + (k.type === 'dead' ? 'dead' : 'point') + '" style="left:' + pct(s, cols) + '"></span>';
    var txt = esc(chartLabel(k, y));
    h += e / cols > 0.8
      ? '<span class="mk-label" style="right:calc(' + pct(cols - s, cols) + ' + 10px)">' + txt + '</span>'
      : '<span class="mk-label" style="left:calc(' + pct(e, cols) + ' + 12px)">' + txt + '</span>';
    return '<div class="line">' + h + '</div>';
  }
  // 文字のおおよその幅（全角 = size、半角 = size の6割）
  function textPx(s, size) { var n = 0; for (var i = 0; i < s.length; i++) n += s.charCodeAt(i) > 255 ? size : size * 0.6; return n; }
  function fmtDate(iso) { var t = new Date(iso); return isNaN(t.getTime()) ? '' : (t.getMonth() + 1) + '/' + t.getDate(); }

  function renderSched() {
    var el = $('sched'), hint = $('hint'), y = state.year;
    if (!state.loaded) { el.className = 'sched is-empty'; el.innerHTML = '<div class="empty"><p>読み込み中…</p></div>'; hint.textContent = ''; return; }
    var list = yearDocs(y);
    if (!list.length) {
      var src = copySources(y);
      var btns = '';
      if (state.canWrite && !state.error) {
        if (src.length) btns += '<button type="button" class="btn primary" data-act="copy">ほかの年からコピーして作る</button>';
        btns += '<button type="button" class="btn' + (src.length ? '' : ' primary') + '" data-act="new-project">＋ 新しいスケジュール</button>';
      }
      el.className = 'sched is-empty';
      el.innerHTML = '<div class="empty"><strong>' + y + '年のスケジュールは、まだありません</strong>' +
        (btns ? (src.length ? '<p>ほかの年の内容をコピーしてから、時期だけ直すと早く作れます。</p>' : '<p>「毎年」で作ると、この年から先のすべての年に出ます。</p>') + '<div class="actions">' + btns + '</div>' : '') + '</div>';
      hint.textContent = '';
      return;
    }

    // 列の数：12か月＋翌年にはみ出す分
    var cols = 12;
    list.forEach(function (d) { d.data.groups.forEach(function (g) { var sp = groupSpan(g); if (sp) cols = Math.max(cols, Math.ceil(sp[1] - 1e-9)); }); });
    cols = Math.min(cols, MAX_M);
    var tp = (T.y - y) * 12 + T.m - 1 + T.frac;
    var todayPos = tp >= 0 && tp < cols ? tp : null;
    var nowCol = todayPos === null ? -1 : Math.floor(tp);
    var cells = cellsHTML(cols, nowCol, todayPos);
    // 1か月ぶんの幅（px）。バーの中に文字が入るかどうかを決めるのに使う
    var rs = getComputedStyle(document.documentElement);
    var labelW = parseFloat(rs.getPropertyValue('--label-w')) || 300, colMin = parseFloat(rs.getPropertyValue('--col-min')) || 56;
    var colPx = Math.max(($('sched-scroll').clientWidth || 1100) - labelW, cols * colMin) / cols;
    var canCheck = state.canWrite && !state.progDead && !state.error;

    var html = '<div class="row head-row"><div class="label">スケジュール・作業</div><div class="months">';
    for (var c = 0; c < cols; c++) {
      html += '<div class="' + (c === nowCol ? 'now' : '') + (c === 12 ? ' next-year' : '') + '">' + (c % 12 + 1) + '月<small>' +
        (c === 0 ? y + '年' : (c === 12 ? '翌年' : '&nbsp;')) + '</small></div>';
    }
    html += '</div></div>';

    function outLabel(s, e, text, color) {
      return e / cols > 0.78
        ? '<span class="pbar-out k-' + color + '" style="right:calc(' + pct(cols - s, cols) + ' + 8px)">' + esc(text) + '</span>'
        : '<span class="pbar-out k-' + color + '" style="left:calc(' + pct(e, cols) + ' + 8px)">' + esc(text) + '</span>';
    }

    var anyOpen = false;
    list.forEach(function (d, pi) {
      var p = d.data, open = !!state.open[d.id], dots = p.view === 'dots', unit = dots ? '件' : '工程';
      if (open) anyOpen = true;
      var bars = '', hasBar = false;
      p.groups.forEach(function (g) {
        if (dots) {
          // 点で出す：印を1つずつ並べる（展示会のように、1年に何回もあるもの）
          var items = [], lastRight = -99;
          g.tasks.forEach(function (t) { t.marks.forEach(function (k) { items.push({ t: t, k: k, s: mStart(k), e: mEnd(k) }); }); });
          items.sort(function (a, b) { return a.s - b.s; });
          items.forEach(function (it) {
            hasBar = true;
            var done = isDone(y, d, g, it.t), tip = esc(it.t.title + '　' + whenText(it.k, y) + (done ? '（済）' : ''));
            var cls = ' k-' + g.color + (done ? ' is-done' : ''), mid = (it.s + it.e) / 2;
            if (it.k.type === 'range') bars += '<span class="pdot rng' + cls + '" style="left:' + pct(it.s, cols) + ';width:' + pct(Math.max(it.e - it.s, 0.02), cols) + '" title="' + tip + '"></span>';
            else bars += '<span class="pdot' + (it.k.type === 'dead' ? ' dead' : '') + cls + '" style="left:' + pct(it.s, cols) + '" title="' + tip + '"></span>';
            var txt = shortWhen(it.k, y), w = textPx(txt, 10), left = mid * colPx - w / 2;
            if (left >= lastRight + 6) { bars += '<span class="pdot-label" style="left:' + pct(mid, cols) + '">' + esc(txt) + '</span>'; lastRight = left + w; }
          });
          return;
        }
        var sp = groupSpan(g); if (!sp) return;
        hasBar = true;
        var s = sp[0], e = Math.min(sp[1], cols), w = Math.max(e - s, 0.02), only = null, n = 0;
        g.tasks.forEach(function (t) { t.marks.forEach(function (k) { n++; only = k; }); });
        // 印が1つだけなら、その印の文字（例：10/6（水）〜10/8（金））をそのまま出す
        var label = (g.name ? g.name + '　' : '') + (n === 1 ? whenText(only, y) : spanText(sp[0], sp[1]));
        var fits = textPx(label, 12.5) + 30 <= w * colPx;
        bars += '<span class="pbar k-' + g.color + (fits ? '' : ' no-text') + '" style="left:' + pct(s, cols) + ';width:' + pct(w, cols) + '" title="' + esc(label) + '">' + (fits ? esc(label) : '') + '</span>';
        // バーが短くて文字が入らないときは、バーの横に出す
        if (!fits) bars += outLabel(s, Math.max(e, s + 18 / colPx), label, g.color);
      });
      // 前の年の同じスケジュールが、この年にはみ出している分
      var prev = null;
      yearDocs(y - 1).forEach(function (o) { if (seriesOf(o) === seriesOf(d)) prev = o; });
      if (prev && prev.data.view !== 'dots') prev.data.groups.forEach(function (g) {
        var sp = groupSpan(g); if (!sp || sp[1] <= 12) return;
        var s = Math.max(sp[0] - 12, 0), e = Math.min(sp[1] - 12, cols);
        var label = '前年' + (g.name ? ' ' + g.name : '');
        bars += '<button type="button" class="pbar prev k-' + g.color + '" data-act="go-year" data-year="' + (y - 1) + '" style="left:' + pct(s, cols) + ';width:' + pct(Math.max(e - s, 0.3), cols) + '" title="' + esc((y - 1) + '年の' + p.name + (g.name ? ' ' + g.name : '') + 'のつづき。押すと' + (y - 1) + '年を開きます') + '">' + esc(label) + '</button>';
      });
      if (!hasBar) bars += '<span class="track-note">時期はまだ登録されていません</span>';

      var dn = doneCount(y, d);
      html += '<div class="row l1 k-' + p.groups[0].color + (open ? ' is-open' : '') + '" data-pid="' + esc(d.id) + '">' +
        '<div class="label"><button type="button" class="rowbtn" aria-expanded="' + open + '" aria-controls="l2-' + pi + '">' +
        '<span class="chev">' + CHEV + '</span><span class="l1-text"><span class="l1-name">' + esc(p.name) + '</span>' +
        '<span class="l1-sub">' + (p.repeat ? '<span class="rtag">毎年</span>' : (baseOf(d) ? '<span class="rtag one">この年だけ</span>' : '')) +
        esc(p.sub ? p.sub + '・' : '') + '全' + taskCount(d) + unit + (dn ? '<span class="done-n">済 ' + dn + '</span>' : '') + '</span></span></button>' +
        (state.canWrite ? '<button type="button" class="icon-btn" data-act="edit-project" aria-label="' + esc(p.name) + ' を編集" title="このスケジュールを編集">' + PENCIL + '</button>' : '') +
        '</div><div class="track">' + cells + bars + '</div></div>';

      html += '<div class="l2-wrap" id="l2-' + pi + '"' + (open ? '' : ' hidden') + '>';
      var head = showGroupHead(d);
      p.groups.forEach(function (g, gi) {
        var kc = ' k-' + g.color;
        if (head) {
          var sp = groupSpan(g), gdn = doneCount(y, d, g);
          html += '<div class="row group' + kc + '"><div class="label"><span class="gchip">' + esc(groupName(g)) + '</span>' +
            '<span class="count">全' + g.tasks.length + unit + (gdn ? '・済 ' + gdn : '') + '</span></div><div class="track">' + cells +
            (sp && !dots ? '<span class="gbar" style="left:' + pct(sp[0], cols) + ';width:' + pct(Math.min(Math.max(sp[1] - sp[0], 0.3), cols - sp[0]), cols) + '"></span>' : '') + '</div></div>';
        }
        g.tasks.forEach(function (t, ti) {
          var key = taskKey(d.id, g.id, t.id), topen = !!state.openTask[key], did = 'd-' + pi + '-' + gi + '-' + ti;
          var done = isDone(y, d, g, t), at = doneAt(y, d, g, t), memo = memoOf(y, d, g, t);
          var ids = ' data-pid="' + esc(d.id) + '" data-gid="' + esc(g.id) + '" data-tid="' + esc(t.id) + '"';
          var meta = (t.party ? '<span class="party ' + partyClass(t.party) + '">' + esc(t.party) + '</span>' : '') +
            (t.marks.length ? '<span class="tchip">' + esc(t.marks.map(function (k) { return whenText(k, y); }).join('・')) + '</span>' : '<span class="tchip none">時期：未記入</span>');
          var lines = t.marks.map(function (k) { return markHTML(k, cols, y); }).join('');
          var no = canCheck
            ? '<button type="button" class="t-no' + (done ? ' is-done' : '') + '" data-act="toggle-done" aria-pressed="' + done + '" aria-label="' + esc(t.title) + (done ? ' の「済」を取り消す' : ' を「済」にする') + '" title="' + (done ? '済（押すと取り消し）' : '押すと「済」にします') + '">' + (done ? CHECK : (ti + 1)) + '</button>'
            : '<span class="t-no' + (done ? ' is-done' : '') + '">' + (done ? CHECK : (ti + 1)) + '</span>';
          html += '<div class="row task' + kc + (ti % 2 ? ' alt' : '') + (topen ? ' is-open' : '') + (done ? ' is-done' : '') + '"' + ids + '>' +
            '<div class="label">' + no + '<button type="button" class="rowbtn" aria-expanded="' + topen + '" aria-controls="' + did + '">' +
            '<span class="t-main"><span class="t-title">' + esc(t.title) + '</span>' +
            '<span class="t-meta">' + meta + '</span></span></button><span class="t-open">' + CHEV + '</span></div>' +
            '<div class="track" style="min-height:' + Math.max(t.marks.length * 24 + 16, 52) + 'px">' + cells + '<div class="lines">' + lines + '</div></div></div>';
          var todo = t.todo.length
            ? '<ul class="todo">' + t.todo.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
            : '<p class="d-none">まだ書かれていません。</p>';
          var side = '<div class="d-side' + kc + '"><p class="d-status' + (done ? ' is-done' : '') + '">' + y + '年：' + (done ? '済' + (at ? '（' + fmtDate(at) + '）' : '') : 'まだ') + '</p>' +
            (canCheck ? '<button type="button" class="btn small' + (done ? '' : ' primary') + '" data-act="toggle-done">' + (done ? '「済」を取り消す' : '「済」にする') + '</button>' +
              '<button type="button" class="btn small" data-act="memo">' + y + '年のメモを' + (memo ? '直す' : '書く') + '</button>' : '') +
            (state.canWrite ? '<button type="button" class="btn small" data-act="edit-task">この作業を編集</button>' : '') + '</div>';
          html += '<div class="detail" id="' + did + '"' + ids + (topen ? '' : ' hidden') + '><div class="detail-in">' +
            '<div><h4>やること</h4>' + todo + '</div>' +
            '<div><h4>備考</h4>' + (t.note ? '<p class="d-note">' + esc(t.note) + '</p>' : '<p class="d-none">なし</p>') +
            (memo ? '<h4 class="h-memo">' + y + '年のメモ</h4><p class="d-note d-memo">' + esc(memo) + '</p>' : '') + '</div>' +
            side + '</div></div>';
        });
        if (state.canWrite) {
          html += '<div class="row addrow' + kc + '"><div class="label"><div class="add-acts">' +
            '<button type="button" class="add-task" data-act="add-task" data-pid="' + esc(d.id) + '" data-gid="' + esc(g.id) + '">＋ 作業を追加' + (head ? '（' + esc(groupName(g)) + '）' : '') + '</button>' +
            '<button type="button" class="add-task" data-act="bulk" data-pid="' + esc(d.id) + '" data-gid="' + esc(g.id) + '">まとめて追加</button>' +
            '</div></div><div class="track">' + cells + '</div></div>';
        } else if (!g.tasks.length) {
          html += '<div class="row addrow"><div class="label"><span class="d-none">作業はまだありません</span></div><div class="track">' + cells + '</div></div>';
        }
      });
      html += '</div>';
    });

    el.className = 'sched';
    el.style.setProperty('--cols', cols);
    el.innerHTML = html;
    hint.textContent = anyOpen
      ? '作業を押すと「やること」と備考が開きます。' + (canCheck ? '番号の丸を押すと、その年の「済」が付きます。' : '') + 'スケジュール名をもう一度押すと閉じます。'
      : 'スケジュールのバーを押すと、中の作業が開きます。';
    fitDetail();
  }

  function renderNow() {
    var all = [];
    [T.y - 1, T.y, T.y + 1].forEach(function (yy) { yearDocs(yy).forEach(function (d) { d.data.groups.forEach(function (g) { g.tasks.forEach(function (t) {
      var done = isDone(yy, d, g, t);
      t.marks.forEach(function (k) { all.push({ y: yy, d: d, g: g, t: t, k: k, s: yy * 12 + mStart(k), e: yy * 12 + mEnd(k), done: done }); });
    }); }); }); });
    var m0 = T.y * 12 + T.m - 1, m1 = m0 + 1;
    function bySt(a, b) { return a.s - b.s; }
    var cur = all.filter(function (o) { return o.k.type === 'range' ? (o.s < m1 && o.e > m0) : (o.s >= m0 && o.s < m1); }).sort(bySt);
    var next = all.filter(function (o) { return o.s >= m1 && !o.done; }).sort(bySt).slice(0, 3);
    // 時期を過ぎたのに済でない作業。済チェックを使い始めたスケジュールだけを対象にする
    var lastOf = {}, late = [];
    all.forEach(function (o) {
      if (o.done || !tracking(o.y, o.d)) return;
      var key = o.y + '|' + o.d.id + '|' + o.g.id + '|' + o.t.id;
      if (!lastOf[key] || o.e > lastOf[key].e) lastOf[key] = o;
    });
    Object.keys(lastOf).forEach(function (k) { if (lastOf[k].e <= m0) late.push(lastOf[k]); });
    late.sort(function (a, b) { return b.e - a.e; });
    function item(o) {
      var p = o.d.data;
      return '<li><button type="button" class="jump' + (o.done ? ' is-done' : '') + '" data-year="' + o.y + '" data-pid="' + esc(o.d.id) + '" data-gid="' + esc(o.g.id) + '" data-tid="' + esc(o.t.id) + '">' +
        '<span class="when">' + esc(whenText(o.k, o.y)) + '</span><span>' +
        (o.done ? '<span class="done-tag">済</span>' : '') +
        (o.g.name ? '<span class="gchip k-' + o.g.color + '">' + esc(o.g.name) + '</span>' : '') +
        esc(o.t.title + (o.k.what ? '：' + o.k.what : '')) +
        '<small>' + esc(p.name + (o.y !== T.y ? '（' + o.y + '年）' : '')) + '</small></span></button></li>';
    }
    $('now-title').innerHTML = '今月<small>' + T.y + '年' + T.m + '月</small>';
    $('now-list').innerHTML = cur.map(item).join('');
    $('now-empty').hidden = !state.loaded || cur.length > 0;
    $('late-head').hidden = !late.length;
    $('late-list').innerHTML = late.slice(0, 4).map(item).join('');
    $('late-more').hidden = late.length <= 4;
    $('late-more').textContent = late.length > 4 ? 'ほか ' + (late.length - 4) + ' 件' : '';
    $('next-list').innerHTML = next.map(item).join('');
    $('next-empty').hidden = !state.loaded || next.length > 0;
  }

  // 詳細の幅を、見えている幅に合わせる（横にずらしても読めるように）
  function fitDetail() { var sc = $('sched-scroll'); sc.style.setProperty('--vw', sc.clientWidth + 'px'); }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    fitDetail();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (state.loaded) keepScroll(renderSched); }, 150); // 幅が変わったら、バーの文字の出し方を決め直す
  });

  // ===== 押したときの動き =====
  function setYear(y) { state.year = y; render(); }

  function hostIds(el) {
    var h = el.closest('[data-tid]');
    return h ? { pid: h.getAttribute('data-pid'), gid: h.getAttribute('data-gid'), tid: h.getAttribute('data-tid') } : null;
  }
  function findTask(ids) {
    var d = ids && findDoc(ids.pid), g = null, t = null;
    if (d) d.data.groups.forEach(function (x) { if (x.id === ids.gid) g = x; });
    if (g) g.tasks.forEach(function (x) { if (x.id === ids.tid) t = x; });
    return t ? { d: d, g: g, t: t } : null;
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var yc = t.closest('.ychip');
    if (yc) { setYear(+yc.getAttribute('data-year')); return; }
    var j = t.closest('.jump');
    if (j) { jumpTo(+j.getAttribute('data-year'), j.getAttribute('data-pid'), j.getAttribute('data-gid'), j.getAttribute('data-tid')); return; }
    var a = t.closest('[data-act]');
    if (a && !a.closest('#dlg')) {
      var act = a.getAttribute('data-act'), ids = hostIds(a), hit;
      if (act === 'new-project') openProjectEditor(null);
      else if (act === 'copy') openCopy();
      else if (act === 'backup') openBackup();
      else if (act === 'go-year') setYear(+a.getAttribute('data-year'));
      else if (act === 'edit-project') openProjectEditor(a.closest('.row').getAttribute('data-pid'));
      else if (act === 'add-task') openTaskEditor(a.getAttribute('data-pid'), a.getAttribute('data-gid'), null);
      else if (act === 'bulk') openBulk(a.getAttribute('data-pid'), a.getAttribute('data-gid'));
      else if (act === 'edit-task' && ids) openTaskEditor(ids.pid, ids.gid, ids.tid);
      else if (act === 'memo' && ids) openMemo(ids);
      else if (act === 'toggle-done' && (hit = findTask(ids))) {
        var patch = { done: {} };
        patch.done[progKey(hit.g, hit.t)] = { on: !isDone(state.year, hit.d, hit.g, hit.t), at: new Date().toISOString() };
        saveProg(state.year, hit.d, patch);
      }
      return;
    }
    var row = t.closest('.row.l1, .row.task');
    if (row && row.closest('#sched')) {
      if (row.classList.contains('l1')) {
        var pid = row.getAttribute('data-pid');
        state.open[pid] = !state.open[pid]; saveOpen();
      } else {
        var key = taskKey(row.getAttribute('data-pid'), row.getAttribute('data-gid'), row.getAttribute('data-tid'));
        state.openTask[key] = !state.openTask[key];
      }
      keepScroll(renderSched);
    }
  });

  function jumpTo(y, pid, gid, tid) {
    state.year = y; state.open[pid] = true; state.openTask[taskKey(pid, gid, tid)] = true; saveOpen();
    render();
    var rows = document.querySelectorAll('#sched .row.task');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.getAttribute('data-pid') === pid && r.getAttribute('data-gid') === gid && r.getAttribute('data-tid') === tid) {
        r.scrollIntoView({ block: 'center', behavior: 'smooth' });
        var b = r.querySelector('.rowbtn'); if (b) b.focus({ preventScroll: true });
        break;
      }
    }
  }

  // ===== 編集の画面 =====
  var dlg = $('dlg'), form = $('dlg-form'), W = null;
  function showDialog(html, focusId) {
    form.innerHTML = html;
    if (!dlg.open) dlg.showModal();
    var f = focusId && $(focusId); if (f) f.focus();
  }
  function closeDialog() { W = null; if (dlg.open) dlg.close(); form.innerHTML = ''; }
  dlg.addEventListener('close', function () { W = null; form.innerHTML = ''; });
  function opts(list, cur) {
    return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }
  function posOpts(n, cur) { var l = []; for (var i = 0; i < n; i++) l.push([i, (i + 1) + '番目']); return opts(l, cur); }
  function delFoot(label) {
    return W.confirmDel
      ? '<span class="err">本当に削除しますか？ 元に戻せません。</span><button type="button" class="btn danger" data-act="del-yes">削除する</button><button type="button" class="btn" data-act="del-no">やめる</button>'
      : '<button type="button" class="btn danger" data-act="del">' + label + '</button>';
  }

  // --- スケジュール（第1階層） ---
  function openProjectEditor(pid) {
    var d = pid ? findDoc(pid) : null, list = yearDocs(state.year);
    if (pid && !d) return;
    W = { kind: 'project', pid: pid, name: d ? d.data.name : '', sub: d ? d.data.sub : '', err: '', confirmDel: false,
      repeat: d ? d.data.repeat : true, wasRepeat: d ? d.data.repeat : false, isOverride: !!(d && baseOf(d)),
      start: d ? d.data.year : state.year, until: d ? d.data.until : 0, viewYear: state.year, view: d ? d.data.view : 'bar',
      pos: d ? list.indexOf(d) : list.length, count: list.length,
      groups: d ? d.data.groups.map(function (g) { return { id: g.id, name: g.name, color: g.color, count: g.tasks.length, del: false }; })
        : [{ id: newId('g'), name: '', color: 'green', count: 0, del: false }] };
    drawProject('f-name');
  }
  function drawProject(focusId) {
    var rows = W.groups.map(function (g, i) {
      return '<div class="grow' + (g.del ? ' is-del' : '') + '">' +
        '<input type="text" id="g-name-' + i + '" data-g="' + i + '" data-f="gname" value="' + esc(g.name) + '" maxlength="30" placeholder="区分の名前（例：-1号）" aria-label="区分の名前"' + (g.del ? ' disabled' : '') + '>' +
        '<select id="g-color-' + i + '" data-g="' + i + '" data-f="gcolor" aria-label="色"' + (g.del ? ' disabled' : '') + '>' + opts(COLORS.map(function (c) { return [c, COLOR_JA[c]]; }), g.color) + '</select>' +
        (g.del ? '<button type="button" class="btn small" data-act="gundo" data-g="' + i + '">元に戻す</button>'
          : '<button type="button" class="btn small danger" data-act="gdel" data-g="' + i + '">削除</button>') +
        (g.del ? '<p class="grow-note">保存すると、この区分' + (g.count ? 'と中の作業' + g.count + '件' : '') + 'が消えます。</p>' : '') + '</div>';
    }).join('');
    var Y = W.viewYear, rp = '';
    if (W.isOverride) {
      rp = '<p class="note-box">' + Y + '年だけの内容です。毎年の設定とは別に、この年の分だけ直せます。</p>';
    } else {
      rp = '<div class="field"><label for="f-repeat">くり返し</label><select id="f-repeat" data-f="repeat">' +
        opts([['1', '毎年（' + (W.pid ? W.start : Y) + '年から）'], ['0', 'この年だけ（' + Y + '年）']], W.repeat ? '1' : '0') + '</select>';
      if (W.pid && W.wasRepeat) {
        rp += '<p class="help">毎年のスケジュールです。ここで直すと、すべての年に反映されます。' + (W.until ? W.until + '年までで終わりにしてあります。' : '') +
          '「この年だけ」に変えると、' + Y + '年のほかの年からは消えます。</p>' +
          '<div class="inline-acts"><button type="button" class="btn small" data-act="override">' + Y + '年だけ別の内容にする</button>' +
          (W.until ? '<button type="button" class="btn small" data-act="no-until">終わりの年をなくす</button>' : '') + '</div>';
      } else {
        rp += '<p class="help">「毎年」にすると、' + (W.pid ? W.start : Y) + '年から先のすべての年に出ます。あとから、ある年だけ別の内容にもできます。</p>';
      }
      rp += '</div>';
    }
    var foot = '';
    if (W.pid) {
      if (W.confirmDel && W.wasRepeat) {
        foot = '<span class="err">毎年のスケジュールです。どこまで消しますか？ 元に戻せません。</span>' +
          '<button type="button" class="btn danger" data-act="del-yes">すべての年から削除</button>' +
          (Y > W.start ? '<button type="button" class="btn danger" data-act="del-from">' + Y + '年から先だけやめる</button>' : '') +
          '<button type="button" class="btn" data-act="del-no">やめる</button>';
      } else {
        foot = delFoot(W.isOverride ? 'この年だけの内容を消す（毎年の設定に戻す）' : 'このスケジュールを削除');
      }
    }
    showDialog(
      '<h2 id="dlg-title">' + (W.pid ? 'スケジュールを編集' : '新しいスケジュール') + '<small class="help">　' + state.year + '年</small></h2>' +
      '<div class="field"><label for="f-name">名前</label><input type="text" id="f-name" data-f="name" value="' + esc(W.name) + '" maxlength="60" placeholder="例：介援隊ニュース"></div>' +
      '<div class="field"><label for="f-sub">説明（なくてもよい）</label><input type="text" id="f-sub" data-f="sub" value="' + esc(W.sub) + '" maxlength="80"></div>' +
      rp +
      '<div class="field"><label for="f-view">年表の出し方</label><select id="f-view" data-f="view">' +
      opts([['bar', 'バー（始まりから終わりまでをつなぐ）'], ['dots', '点（開催日などを、1つずつ出す）']], W.view) + '</select>' +
      '<p class="help">展示会のように、1年に何回もあるものは「点」が合います。</p></div>' +
      (W.pid && W.count > 1 ? '<div class="field"><label for="f-pos">並び順</label><select id="f-pos" data-f="pos">' + posOpts(W.count, W.pos) + '</select></div>' : '') +
      '<fieldset><legend>区分と色</legend>' +
      '<p class="help">「-1号・-2号」のように中を分けるときは、区分を足します。分けないときは、区分は1つのままで、名前は空でかまいません。</p>' +
      rows + '<div><button type="button" class="btn small" data-act="gadd">＋ 区分を追加</button></div></fieldset>' +
      (W.err ? '<p class="err" role="alert">' + esc(W.err) + '</p>' : '') +
      '<div class="dlg-foot">' + (W.pid ? '<span class="left">' + foot + '</span>' : '') +
      '<button type="button" class="btn" data-act="cancel">キャンセル</button><button type="submit" class="btn primary">保存</button></div>', focusId);
  }
  function saveProject() {
    var name = W.name.trim();
    if (!name) { W.err = '名前を入れてください。'; drawProject('f-name'); return; }
    var w = W, alive = w.groups.filter(function (g) { return !g.del; });
    closeDialog();
    if (!w.pid) {
      var id = newId('p');
      if (!alive.length) alive = [{ id: newId('g'), name: '', color: 'green' }];
      var maxOrder = 0; yearDocs(state.year).forEach(function (d) { maxOrder = Math.max(maxOrder, d.data.order); });
      state.open[id] = true; saveOpen();
      report(putDoc(id, { year: state.year, series: id, name: name, sub: w.sub.trim(), order: maxOrder + 1, repeat: !!w.repeat, until: 0, view: w.view,
        groups: alive.map(function (g) { return { id: g.id, name: g.name.trim(), color: g.color, tasks: [] }; }) }),
        '「' + name + '」を' + (w.repeat ? '毎年のスケジュールとして' : state.year + '年だけのスケジュールとして') + '追加しました');
      return;
    }
    // 並び順が変わるなら、その年のスケジュールの順番を振り直す
    var list = yearDocs(state.year), cur = findDoc(w.pid), idx = list.indexOf(cur), orderOf = {};
    if (cur && idx >= 0 && w.pos !== idx) {
      list.splice(idx, 1); list.splice(Math.max(0, Math.min(w.pos, list.length)), 0, cur);
      list.forEach(function (d, i) { orderOf[d.id] = i + 1; });
    }
    var jobs = [mutate(w.pid, function (data) {
      data.name = name; data.sub = w.sub.trim(); data.view = w.view;
      if (orderOf[w.pid]) data.order = orderOf[w.pid];
      if (!w.isOverride && w.repeat !== !!data.repeat) {
        data.repeat = w.repeat;
        if (!w.repeat) { data.year = w.viewYear; data.until = 0; } // この年だけにする：見ている年のものにする
      }
      var known = {}; w.groups.forEach(function (g) { known[g.id] = g; });
      data.groups = data.groups.filter(function (g) { return !(known[g.id] && known[g.id].del); });
      data.groups.forEach(function (g) { var k = known[g.id]; if (k) { g.name = k.name.trim(); g.color = k.color; } });
      var have = {}; data.groups.forEach(function (g) { have[g.id] = 1; });
      alive.forEach(function (g) { if (!have[g.id]) data.groups.push({ id: g.id, name: g.name.trim(), color: g.color, tasks: [] }); });
      if (!data.groups.length) data.groups.push({ id: newId('g'), name: '', color: 'green', tasks: [] });
    })];
    Object.keys(orderOf).forEach(function (id) {
      var d = findDoc(id);
      if (id !== w.pid && d && d.data.order !== orderOf[id]) jobs.push(mutate(id, function (data) { data.order = orderOf[id]; }));
    });
    report(Promise.all(jobs), '保存しました');
  }

  // --- 作業（第2階層） ---
  function openTaskEditor(pid, gid, tid) {
    var d = findDoc(pid); if (!d) return;
    var g = null; d.data.groups.forEach(function (x) { if (x.id === gid) g = x; });
    g = g || d.data.groups[0];
    var t = null; if (tid) g.tasks.forEach(function (x) { if (x.id === tid) t = x; });
    if (tid && !t) return;
    W = { kind: 'task', pid: pid, gid: g.id, origGid: g.id, tid: t ? t.id : null, err: '', confirmDel: false,
      title: t ? t.title : '', party: t ? t.party : '', todo: t ? t.todo.join('\n') : '', note: t ? t.note : '',
      pos: t ? g.tasks.indexOf(t) : g.tasks.length, marks: t ? clone(t.marks) : [] };
    drawTask('t-title');
  }
  function monthOpts(cur) { var l = []; for (var m = 1; m <= MAX_M; m++) l.push([m, monthLabel(m)]); return opts(l, cur); }
  function partOpts(cur) { return opts(PART_KEYS.map(function (p) { return [p, PART_JA[p]]; }).concat([['day', '日付で指定']]), cur); }
  function dayInput(i, f, v) {
    return '<input type="text" inputmode="numeric" class="m-day" id="m-' + f + '-' + i + '" data-k="' + i + '" data-f="' + f + '" value="' + (v || '') + '" maxlength="2" aria-label="日"><span class="sep">日</span>';
  }
  function drawTask(focusId) {
    var d = findDoc(W.pid); if (!d) { closeDialog(); return; }
    var groups = d.data.groups, g = groups[0];
    groups.forEach(function (x) { if (x.id === W.gid) g = x; });
    var n = g.tasks.length + ((W.tid && W.gid === W.origGid) ? 0 : 1);
    W.pos = Math.max(0, Math.min(W.pos, n - 1));
    var parties = {}; state.docs.forEach(function (o) { o.data.groups.forEach(function (gg) { gg.tasks.forEach(function (t) { if (t.party) parties[t.party] = 1; }); }); });
    var marks = W.marks.map(function (k, i) {
      var range = k.type === 'range';
      return '<div class="mrow"><div class="mrow-top">' +
        '<select id="m-type-' + i + '" data-k="' + i + '" data-f="type" aria-label="印の種類">' + opts(TYPES.map(function (x) { return [x, TYPE_JA[x]]; }), k.type) + '</select>' +
        '<select id="m-m1-' + i + '" data-k="' + i + '" data-f="m1" aria-label="' + (range ? '始まりの月' : '月') + '">' + monthOpts(k.m1) + '</select>' +
        '<select id="m-p1-' + i + '" data-k="' + i + '" data-f="p1" aria-label="' + (range ? '始まりの時期' : '時期') + '">' + partOpts(k.p1) + '</select>' +
        (k.p1 === 'day' ? dayInput(i, 'd1', k.d1) : '') +
        (range ? '<span class="sep">〜</span>' +
          '<select id="m-m2-' + i + '" data-k="' + i + '" data-f="m2" aria-label="終わりの月">' + monthOpts(k.m2) + '</select>' +
          '<select id="m-p2-' + i + '" data-k="' + i + '" data-f="p2" aria-label="終わりの時期">' + partOpts(k.p2) + '</select>' +
          (k.p2 === 'day' ? dayInput(i, 'd2', k.d2) : '') : '') +
        '<span class="spacer"></span><button type="button" class="btn small danger" data-act="mdel" data-k="' + i + '">この時期を削除</button></div>' +
        '<div class="mrow-text">' +
        '<div class="field"><label for="m-when-' + i + '">表示する文字' + (usesDay(k) ? '（空なら日付と曜日）' : '') + '</label><input type="text" id="m-when-' + i + '" data-k="' + i + '" data-f="when" value="' + esc(k.when) + '" maxlength="30" placeholder="' + esc(autoWhen(k, state.year)) + '"></div>' +
        '<div class="field"><label for="m-what-' + i + '">内容（なくてもよい）</label><input type="text" id="m-what-' + i + '" data-k="' + i + '" data-f="what" value="' + esc(k.what) + '" maxlength="60" placeholder="例：日程決め"></div></div>' +
        (range ? '<label class="check"><input type="checkbox" id="m-fade-' + i + '" data-k="' + i + '" data-f="fade"' + (k.fade ? ' checked' : '') + '> 終わりは目安（バーの右をぼかす）</label>' : '') +
        '</div>';
    }).join('');
    showDialog(
      '<h2 id="dlg-title">' + (W.tid ? '作業を編集' : '作業を追加') + '<small class="help">　' + esc(d.data.name) + '</small></h2>' +
      (d.data.repeat ? '<p class="note-box">毎年のスケジュールです。ここで直すと、すべての年に反映されます。ある年だけ変えたいときは、スケジュールの編集で「○年だけ別の内容にする」を使います。</p>'
        : (baseOf(d) ? '<p class="note-box">' + d.data.year + '年だけの内容を直しています。ほかの年は変わりません。</p>' : '')) +
      '<div class="field"><label for="t-title">作業名</label><input type="text" id="t-title" data-f="title" value="' + esc(W.title) + '" maxlength="80"></div>' +
      '<div class="two">' +
      (groups.length > 1 ? '<div class="field"><label for="t-gid">区分</label><select id="t-gid" data-f="gid">' + opts(groups.map(function (x) { return [x.id, groupName(x)]; }), W.gid) + '</select></div>' : '') +
      '<div class="field"><label for="t-pos">順番</label><select id="t-pos" data-f="pos">' + posOpts(n, W.pos) + '</select></div>' +
      '<div class="field"><label for="t-party">相手・宛先（なくてもよい）</label><input type="text" id="t-party" data-f="party" value="' + esc(W.party) + '" maxlength="30" list="party-list">' +
      '<datalist id="party-list">' + Object.keys(parties).map(function (p) { return '<option value="' + esc(p) + '">'; }).join('') + '</datalist></div></div>' +
      '<div class="field"><label for="t-todo">やること（1行に1つ）</label><textarea id="t-todo" data-f="todo" rows="4">' + esc(W.todo) + '</textarea></div>' +
      '<div class="field"><label for="t-note">備考（なくてもよい）</label><textarea id="t-note" data-f="note" rows="2">' + esc(W.note) + '</textarea></div>' +
      '<fieldset><legend>時期（年表に出る印）</legend>' +
      '<div class="field"><label for="m-quick">文字で入れる</label><div class="quick"><input type="text" id="m-quick" maxlength="80" placeholder="例：4/21　10/6〜10/8　8月末まで　3〜4月頃　7月上旬">' +
      '<button type="button" class="btn small" data-act="mquick">追加</button></div></div>' +
      marks +
      '<div><button type="button" class="btn small" data-act="madd">＋ 選んで追加</button></div>' +
      '<p class="help">時期を入れない作業は、年表に印が出ず「時期：未記入」と表示されます。「日付で指定」にすると、その日の位置に印が出て、曜日も付きます。</p></fieldset>' +
      (W.err ? '<p class="err" role="alert">' + esc(W.err) + '</p>' : '') +
      '<div class="dlg-foot">' + (W.tid ? '<span class="left">' + delFoot('この作業を削除') + '</span>' : '') +
      '<button type="button" class="btn" data-act="cancel">キャンセル</button><button type="submit" class="btn primary">保存</button></div>', focusId);
  }
  // 保存する形の印にする
  function finishMark(k) {
    var o = { id: k.id || newId('m'), type: k.type, m1: k.m1, p1: k.p1, when: (k.when || '').trim() || (usesDay(k) ? '' : autoWhen(k)), what: (k.what || '').trim().slice(0, 60) };
    if (k.p1 === 'day') o.d1 = k.d1;
    if (k.type === 'range') { o.m2 = k.m2; o.p2 = k.p2; o.fade = !!k.fade; if (k.p2 === 'day') o.d2 = k.d2; }
    return o;
  }
  function saveTask() {
    var title = W.title.trim();
    if (!title) { W.err = '作業名を入れてください。'; drawTask('t-title'); return; }
    var bad = -1;
    W.marks.forEach(function (k, i) { if (bad < 0 && k.type === 'range' && mEnd(k) < mStart(k)) bad = i; });
    if (bad >= 0) { W.err = '期間の終わりが、始まりより前になっています。日付を直してください。'; drawTask('m-m2-' + bad); return; }
    var w = W;
    var task = { id: w.tid || newId('t'), title: title, party: w.party.trim(), note: w.note.trim(),
      todo: w.todo.split('\n').map(function (s) { return s.replace(/^[\s・]+/, '').trim(); }).filter(Boolean),
      marks: w.marks.map(finishMark) };
    closeDialog();
    state.openTask[taskKey(w.pid, w.gid, task.id)] = true;
    report(mutate(w.pid, function (data) {
      // 元の区分の中からだけ取りのぞく（ほかの区分の作業には触れない）
      if (w.tid) data.groups.forEach(function (g) { if (g.id === w.origGid) g.tasks = g.tasks.filter(function (t) { return t.id !== w.tid; }); });
      var g = data.groups[0]; data.groups.forEach(function (x) { if (x.id === w.gid) g = x; });
      if (!g) return false;
      if (g.tasks.some(function (t) { return t.id === task.id; })) task.id = newId('t');
      g.tasks.splice(Math.max(0, Math.min(w.pos, g.tasks.length)), 0, task);
    }), '保存しました');
  }

  // --- 文字から時期を読み取る（「4/21」「10/6〜10/8」「8月末まで」「3〜4月頃」「9月中」など） ---
  var PART_WORD = { '上旬': 'early', '初旬': 'early', '中旬': 'mid', '半ば': 'mid', '中頃': 'mid', '下旬': 'late', '月末': 'end', '末': 'end', '終わり': 'end', '月初': 'start', '初め': 'start', 'はじめ': 'start', '頭': 'start' };
  var R_PW = '(上旬|初旬|中旬|半ば|中頃|下旬|月末|末|終わり|月初|初め|はじめ|頭)';
  var R_NY = '(翌年|来年)?', R_YEAR = '(?:\\d{4}[/年])?', R_WD = '(?:[（(][日月火水木金土][）)])?', R_GORO = '(?:頃|ごろ)?';
  function pMon(v, ny) { v = +v; return v >= 1 && v <= 12 ? v + (ny ? 12 : 0) : 0; }
  function pDay(v) { v = +v; return v >= 1 && v <= 31 ? v : 0; }
  function pDayRange(m) {
    var a = pMon(m[2], m[1]), b = m[5] ? pMon(m[5], m[4] || m[1]) : a, k;
    if (!a || !b || !pDay(m[3]) || !pDay(m[6])) return null;
    k = { type: 'range', m1: a, p1: 'day', d1: +m[3], m2: b, p2: 'day', d2: +m[6] };
    return mEnd(k) < mStart(k) ? null : k;
  }
  function pDayPoint(m) { var a = pMon(m[2], m[1]); return a && pDay(m[3]) ? { type: 'point', m1: a, p1: 'day', d1: +m[3] } : null; }
  var WHEN_PATTERNS = [
    { day: true, re: new RegExp(R_YEAR + R_NY + '(\\d{1,2})/(\\d{1,2})' + R_WD + '\\s*〜\\s*(?:' + R_NY + '(\\d{1,2})/)?(\\d{1,2})' + R_WD, 'g'), make: pDayRange },
    { day: true, re: new RegExp(R_YEAR + R_NY + '(\\d{1,2})月(\\d{1,2})日' + R_WD + '\\s*〜\\s*(?:' + R_NY + '(\\d{1,2})月)?(\\d{1,2})日' + R_WD, 'g'), make: pDayRange },
    { day: true, tail: true, re: new RegExp(R_YEAR + R_NY + '(\\d{1,2})/(\\d{1,2})' + R_WD, 'g'), make: pDayPoint },
    { tail: true, re: new RegExp(R_YEAR + R_NY + '(\\d{1,2})月(\\d{1,2})日' + R_WD, 'g'), make: pDayPoint },
    { re: new RegExp(R_NY + '(\\d{1,2})月?' + R_PW + '?' + R_GORO + '\\s*〜\\s*' + R_NY + '(\\d{1,2})月' + R_PW + '?' + R_GORO, 'g'),
      make: function (m) {
        var a = pMon(m[2], m[1]), b = pMon(m[5], m[4] || m[1]), k;
        if (!a || !b) return null;
        k = { type: 'range', m1: a, p1: m[3] ? PART_WORD[m[3]] : 'start', m2: b, p2: m[6] ? PART_WORD[m[6]] : 'end' };
        return mEnd(k) < mStart(k) ? null : k;
      } },
    { re: new RegExp(R_NY + '(\\d{1,2})月(?:中(?![旬頃])|いっぱい)', 'g'),
      make: function (m) { var a = pMon(m[2], m[1]); return a ? { type: 'range', m1: a, p1: 'start', m2: a, p2: 'end' } : null; } },
    { tail: true, re: new RegExp(R_NY + '(\\d{1,2})月' + R_PW + '?' + R_GORO, 'g'),
      make: function (m) {
        var a = pMon(m[2], m[1]);
        if (!a) return null;
        return m[3] ? { type: 'point', m1: a, p1: PART_WORD[m[3]] } : { type: 'range', m1: a, p1: 'start', m2: a, p2: 'end', whole: true };
      } }
  ];
  function normWhenText(s) {
    return String(s).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/／/g, '/').replace(/[～~]/g, '〜');
  }
  // 文の中から、いちばん左にある時期を1つ見つける。{ index, length, mark } を返す
  function findWhen(raw) {
    var text = normWhenText(raw), best = null;
    WHEN_PATTERNS.forEach(function (pat) {
      var m;
      pat.re.lastIndex = 0;
      while ((m = pat.re.exec(text))) {
        var prev = text.charAt(m.index - 1), nxt = text.charAt(m.index + m[0].length);
        var k = /[0-9\/.]/.test(prev) || (pat.day && /[0-9\/]/.test(nxt)) ? null : pat.make(m);
        if (k) {
          if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.length)) best = { index: m.index, length: m[0].length, mark: k, pat: pat };
          break;
        }
        pat.re.lastIndex = m.index + 1;
      }
    });
    if (!best) return null;
    var k = best.mark, rest = text.slice(best.index + best.length), sfx, typed = true;
    if (best.pat.tail && (sfx = /^\s*(まで(?:に)?|〆切|締切|締め切り)/.exec(rest))) {
      // 「8月末まで」「4/21まで」→ 締切
      if (k.whole) k = { type: 'dead', m1: k.m1, p1: 'end' }; else k.type = 'dead';
      best.length += sfx[0].length;
    } else if (best.pat.tail && (sfx = /^\s*(〜|から|以降)/.exec(rest))) {
      // 「7月末頃〜」「7月から」→ 終わりをぼかした期間
      var late = k.p1 === 'day' ? k.d1 > 15 : (k.p1 === 'mid' || k.p1 === 'late' || k.p1 === 'end' || k.whole);
      var m2 = late && k.m1 < MAX_M ? k.m1 + 1 : k.m1;
      k = { type: 'range', m1: k.m1, p1: k.whole ? 'start' : k.p1, d1: k.d1, m2: m2, p2: m2 === k.m1 ? 'end' : 'mid', fade: true };
      if (k.p1 !== 'day') delete k.d1;
      best.length += sfx[0].length;
    }
    if (usesDay(k) && !k.fade) typed = false; // 日付のときは、曜日つきの文字を自動で出す
    delete k.whole;
    k.when = typed ? text.substr(best.index, best.length).replace(/\s+/g, '').slice(0, 30) : '';
    k.what = '';
    best.mark = k;
    return best;
  }
  function cleanText(s) {
    s = String(s).replace(/^[\s　、。,，:：・には]+/, '').replace(/[\s　、。,，:：]+$/, '');
    s = s.replace(/^[)）]+/, '').replace(/[(（]+$/, '').trim();
    var m = /^[(（]([^()（）]*)[)）]$/.exec(s);
    return m ? m[1].trim() : s;
  }
  // 文の中の時期をぜんぶ拾う。「内容」には、時期のうしろ（なければ前）の言葉を入れる
  function marksFromText(text) {
    var out = [];
    String(text).split(/[、。,，\n]/).forEach(function (seg) {
      var guard = 0, f;
      while (seg && guard++ < 8 && (f = findWhen(seg))) {
        var before = cleanText(seg.slice(0, f.index)), after = seg.slice(f.index + f.length), f2 = findWhen(after);
        f.mark.what = (cleanText(f2 ? after.slice(0, f2.index) : after) || before).slice(0, 60);
        out.push(f.mark);
        seg = f2 ? after : '';
      }
    });
    return out;
  }
  // まとめて追加：1行に1作業。行のはじめが空いている行・「・」の行は、上の作業の「やること」
  function parseBulk(text) {
    var out = [], cur = null;
    function detail(s) {
      s = s.replace(/^[\s　・]+/, '').trim();
      if (!s) return;
      var ms = marksFromText(s);
      ms.forEach(function (k) { cur.marks.push(k); });
      if (!(ms.length && ms.every(function (k) { return !k.what; }))) cur.todo.push(s); // 時期だけの行は「やること」に入れない
    }
    String(text).split(/\r?\n/).forEach(function (raw) {
      if (!raw.trim()) return;
      var cells = raw.split('\t'), isDetail = !!cur && (/^[\s　・]/.test(raw) || cells[0].trim() === '');
      cells = cells.map(function (c) { return c.trim(); }).filter(Boolean);
      if (!cells.length) return;
      if (isDetail) { cells.forEach(detail); return; }
      if (cells.length > 1 && /^(\d+[.．)）]?|[①-⑳])$/.test(cells[0])) cells.shift(); // Excel の番号の列
      var title = cells[0].replace(/^(\d+[.．)）]\s*|[①-⑳]\s*)/, ''), names = [];
      cur = { title: '', todo: [], marks: [] }; out.push(cur);
      // 題名の中の「（3月末頃）」のような時期を取り出す
      title = title.replace(/[（(]([^（）()]*)[）)]/g, function (all, inner, off, whole) {
        var f = findWhen(inner);
        if (!f || cleanText(inner.slice(0, f.index) + inner.slice(f.index + f.length)).length > 4) return all;
        cur.marks.push(f.mark);
        names.push(cleanText(whole.slice(0, off).split(/[、,，]/).pop()));
        return '';
      });
      if (cur.marks.length > 1) cur.marks.forEach(function (k, i) { k.what = (names[i] || '').slice(0, 60); });
      // 「ふくしま展示会　4/21」「4/21　ふくしま展示会」のように、題名の前後に時期が付いているとき
      var f2 = findWhen(title);
      if (f2) {
        var b = title.slice(0, f2.index), a = title.slice(f2.index + f2.length);
        if (!a.trim() || (!b.trim() && /^[\s　]/.test(a))) { cur.marks.push(f2.mark); title = b + a; }
      }
      cur.title = cleanText(title).slice(0, 80) || '（名前なし）';
      cells.slice(1).forEach(detail);
    });
    return out.slice(0, 100);
  }
  function openBulk(pid, gid) {
    var d = findDoc(pid), color = 'green';
    if (!d) return;
    d.data.groups.forEach(function (g) { if (g.id === gid) color = g.color; });
    W = { kind: 'bulk', pid: pid, gid: gid, color: color, text: '', err: '' };
    drawBulk('b-text');
  }
  function drawBulk(focusId) {
    var d = findDoc(W.pid); if (!d) { closeDialog(); return; }
    showDialog(
      '<h2 id="dlg-title">まとめて追加<small class="help">　' + esc(d.data.name) + '</small></h2>' +
      '<p class="help">1行に1つ、作業を書きます。時期を一緒に書くと、年表の印になります。Excelの表も、そのまま貼り付けられます。</p>' +
      '<div class="field"><label for="b-text">作業の一覧</label><textarea id="b-text" data-f="text" rows="8" placeholder="ふくしま展示会　4/21&#10;新潟展示会　10/28&#10;価格表の作成（8月末まで）&#10;　モノタロウには未完成でも先に出す">' + esc(W.text) + '</textarea></div>' +
      '<p class="help">行のはじめを空けるか「・」を付けると、すぐ上の作業の「やること」になります。</p>' +
      '<fieldset><legend>読み取った結果</legend><div id="b-prev" class="bulk-prev k-' + W.color + '"></div></fieldset>' +
      (W.err ? '<p class="err" role="alert">' + esc(W.err) + '</p>' : '') +
      '<div class="dlg-foot"><button type="button" class="btn" data-act="cancel">キャンセル</button><button type="submit" class="btn primary" id="b-save">追加する</button></div>', focusId);
    drawBulkPreview();
  }
  function drawBulkPreview() {
    var box = $('b-prev'), list = parseBulk(W.text);
    if (!box) return;
    box.innerHTML = list.length ? list.map(function (t, i) {
      return '<div class="bulk-item"><span class="t-no">' + (i + 1) + '</span><span><strong>' + esc(t.title) + '</strong><span class="t-meta">' +
        (t.marks.length ? t.marks.map(function (k) { return '<span class="tchip">' + esc(chartLabel(k, state.year)) + '</span>'; }).join('') : '<span class="tchip none">時期：未記入</span>') +
        (t.todo.length ? '<span class="tchip">やること ' + t.todo.length + '行</span>' : '') + '</span></span></div>';
    }).join('') : '<p class="help">ここに、読み取った作業と時期が出ます。</p>';
    var b = $('b-save'); if (b) b.textContent = list.length ? list.length + '件を追加する' : '追加する';
  }
  function saveBulk() {
    var list = parseBulk(W.text), w = W;
    if (!list.length) { W.err = '作業を1行以上書いてください。'; drawBulk('b-text'); return; }
    closeDialog();
    report(mutate(w.pid, function (data) {
      var g = data.groups[0]; data.groups.forEach(function (x) { if (x.id === w.gid) g = x; });
      if (!g) return false;
      list.forEach(function (t) { g.tasks.push({ id: newId('t'), title: t.title, party: '', todo: t.todo, note: '', marks: t.marks.map(finishMark) }); });
    }), list.length + '件 追加しました');
  }

  // --- 年ごとのメモ ---
  function openMemo(ids) {
    var hit = findTask(ids); if (!hit) return;
    W = { kind: 'memo', ids: ids, year: state.year, title: hit.t.title, text: memoOf(state.year, hit.d, hit.g, hit.t), err: '' };
    drawMemo('memo-text');
  }
  function drawMemo(focusId) {
    showDialog(
      '<h2 id="dlg-title">' + W.year + '年のメモ<small class="help">　' + esc(W.title) + '</small></h2>' +
      '<div class="field"><label for="memo-text">メモ</label><textarea id="memo-text" data-f="text" rows="4" maxlength="500" placeholder="例：下版は8/20。校正が2日のびた">' + esc(W.text) + '</textarea></div>' +
      '<p class="help">' + W.year + '年だけのメモです。ほかの年には出ません。空にして保存すると消えます。</p>' +
      '<div class="dlg-foot"><button type="button" class="btn" data-act="cancel">キャンセル</button><button type="submit" class="btn primary">保存</button></div>', focusId);
  }
  function saveMemo() {
    var w = W, hit = findTask(w.ids), patch = { memo: {} };
    closeDialog();
    if (!hit) return;
    patch.memo[progKey(hit.g, hit.t)] = w.text.trim().slice(0, 500);
    saveProg(w.year, hit.d, patch, '保存しました');
  }

  // --- ほかの年からコピー ---
  function openCopy() {
    var src = copySources(state.year);
    if (!src.length) return;
    var from = src.indexOf(state.year - 1) >= 0 ? state.year - 1 : src[src.length - 1];
    W = { kind: 'copy', from: from, years: src, pick: null, err: '' };
    drawCopy('c-from');
  }
  function drawCopy(focusId) {
    var have = {}; yearDocs(state.year).forEach(function (d) { have[seriesOf(d)] = 1; });
    var list = yearDocs(W.from);
    if (!W.pick) { W.pick = {}; list.forEach(function (d) { W.pick[d.id] = !have[seriesOf(d)]; }); }
    var rows = list.map(function (d, i) {
      var dup = !!have[seriesOf(d)];
      return '<label for="c-pick-' + i + '"><input type="checkbox" id="c-pick-' + i + '" data-f="pick" data-id="' + esc(d.id) + '"' + (W.pick[d.id] && !dup ? ' checked' : '') + (dup ? ' disabled' : '') + '> ' +
        esc(d.data.name) + '<small>全' + taskCount(d) + '工程' + (dup ? '・' + state.year + '年にもうあります' : '') + '</small></label>';
    }).join('');
    showDialog(
      '<h2 id="dlg-title">ほかの年からコピー<small class="help">　→ ' + state.year + '年へ</small></h2>' +
      '<div class="field"><label for="c-from">コピー元の年</label><select id="c-from" data-f="from">' + opts(W.years.map(function (y) { return [y, y + '年']; }), W.from) + '</select></div>' +
      '<fieldset><legend>コピーするスケジュール</legend><div class="copy-list">' + (rows || '<p class="help">この年には、スケジュールがありません。</p>') + '</div>' +
      '<p class="help">作業・時期・やることを、そのままコピーします。コピーした分は「' + state.year + '年だけ」のスケジュールになります（元の年は変わりません）。</p></fieldset>' +
      (W.err ? '<p class="err" role="alert">' + esc(W.err) + '</p>' : '') +
      '<div class="dlg-foot"><button type="button" class="btn" data-act="cancel">キャンセル</button><button type="submit" class="btn primary">コピーする</button></div>', focusId);
  }
  function saveCopy() {
    var w = W, to = state.year, have = {};
    yearDocs(to).forEach(function (d) { have[seriesOf(d)] = 1; });
    var picked = yearDocs(w.from).filter(function (d) { return w.pick[d.id] && !have[seriesOf(d)]; });
    if (!picked.length) { W.err = 'コピーするスケジュールを選んでください。'; drawCopy(); return; }
    closeDialog();
    var maxOrder = 0; yearDocs(to).forEach(function (d) { maxOrder = Math.max(maxOrder, d.data.order); });
    var jobs = picked.map(function (d, i) {
      var data = clone(d.data); data.year = to; data.order = maxOrder + i + 1;
      data.series = seriesOf(d); data.repeat = false; data.until = 0;
      return putDoc(newId('p'), data);
    });
    report(Promise.all(jobs), w.from + '年から' + picked.length + '件コピーしました');
  }

  // --- バックアップ（ファイルに書き出す・ファイルから取り込む） ---
  function openBackup() { W = { kind: 'backup', data: null, info: '', err: '' }; drawBackup(); }
  function drawBackup() {
    showDialog(
      '<h2 id="dlg-title">バックアップ</h2>' +
      '<fieldset><legend>書き出す</legend><p class="help">今のスケジュール ' + state.docs.length + ' 件と、済チェック・年ごとのメモを、1つのファイルに書き出します。</p>' +
      '<div><button type="button" class="btn small" data-act="bk-export">ファイルに書き出す</button></div></fieldset>' +
      '<fieldset><legend>取り込む</legend><p class="help">書き出したファイルを選ぶと、中のスケジュールと済チェックを取り込みます。同じスケジュールがあるときは、ファイルの内容で上書きします。</p>' +
      '<input type="file" id="bk-file" accept=".json,application/json" aria-label="取り込むファイル">' +
      (W.info ? '<p class="note-box">' + esc(W.info) + '</p>' : '') + '</fieldset>' +
      (W.err ? '<p class="err" role="alert">' + esc(W.err) + '</p>' : '') +
      '<div class="dlg-foot"><button type="button" class="btn" data-act="cancel">閉じる</button>' +
      (W.data ? '<button type="submit" class="btn primary">取り込む</button>' : '') + '</div>');
  }
  function exportBackup() {
    var out = { format: 'caremax-schedule-backup', version: 1, exportedAt: new Date().toISOString(), schedules: {}, progress: clone(state.prog) };
    state.docs.forEach(function (d) { out.schedules[d.id] = clone(d.data); });
    var t = new Date(), ymd = t.getFullYear() + ('0' + (t.getMonth() + 1)).slice(-2) + ('0' + t.getDate()).slice(-2);
    var a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
    a.href = url; a.download = '年間スケジュール_バックアップ_' + ymd + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
    toast('ファイルに書き出しました');
  }
  function readBackupFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      if (!W || W.kind !== 'backup') return;
      var data = null;
      try { data = JSON.parse(String(reader.result)); } catch (e) { data = null; }
      if (!data || typeof data !== 'object' || !data.schedules || typeof data.schedules !== 'object') {
        W.data = null; W.info = ''; W.err = 'このファイルは読み取れませんでした。「バックアップ」で書き出したファイルを選んでください。';
      } else {
        W.data = { schedules: data.schedules, progress: data.progress && typeof data.progress === 'object' ? data.progress : {} };
        W.err = ''; W.info = 'スケジュール ' + Object.keys(W.data.schedules).length + ' 件、済チェックの記録 ' + Object.keys(W.data.progress).length + ' 件が入っています。「取り込む」を押すと保存します。';
      }
      drawBackup();
    };
    reader.onerror = function () { if (W && W.kind === 'backup') { W.err = 'ファイルを読めませんでした。'; drawBackup(); } };
    reader.readAsText(file);
  }
  // Firestore の文書の名前に使えない文字をよける
  function safeDocId(id) { return String(id).replace(/[\/]/g, '-').replace(/^\.+$/, '-').slice(0, 200) || newId('p'); }
  function saveBackup() {
    var w = W, ids = Object.keys(w.data.schedules), jobs = [];
    closeDialog();
    ids.forEach(function (id) { jobs.push(putDoc(safeDocId(id), normDoc(w.data.schedules[id]))); });
    Object.keys(w.data.progress).forEach(function (id) {
      var p = w.data.progress[id], pid = safeDocId(id);
      if (!p || typeof p !== 'object') return;
      p = clone(p);
      state.prog[pid] = deepMerge(state.prog[pid] ? clone(state.prog[pid]) : {}, p);
      jobs.push(queue('prog:' + pid, function () { return retrying(function () { return store.mergeProg(pid, p); }); }));
    });
    report(Promise.all(jobs), 'スケジュール ' + ids.length + ' 件を取り込みました');
  }

  // --- 編集の画面の中の操作 ---
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!W) return;
    if (W.kind === 'task' && document.activeElement && document.activeElement.id === 'm-quick' && document.activeElement.value.trim()) { quickAdd(); return; }
    if (W.kind === 'project') saveProject(); else if (W.kind === 'task') saveTask(); else if (W.kind === 'copy') saveCopy();
    else if (W.kind === 'bulk') saveBulk(); else if (W.kind === 'memo') saveMemo();
    else if (W.kind === 'backup' && W.data) saveBackup();
  });
  function redraw(focusId) { if (W.kind === 'project') drawProject(focusId); else if (W.kind === 'task') drawTask(focusId); else drawCopy(focusId); }
  // 「文字で入れる」の欄から、時期を足す（Enter でも足せる）
  function quickAdd() {
    var el = $('m-quick'), ms = el ? marksFromText(el.value) : [];
    if (!ms.length) { W.err = '時期を読み取れませんでした。「4/21」「10/6〜10/8」「8月末まで」「3〜4月頃」のように入れてください。'; drawTask('m-quick'); return; }
    W.err = '';
    ms.forEach(function (k) { k.id = newId('m'); W.marks.push(k); });
    drawTask('m-quick');
  }
  form.addEventListener('click', function (ev) {
    var a = ev.target.closest('[data-act]'); if (!a || !W) return;
    var act = a.getAttribute('data-act'), i = +a.getAttribute('data-g'), ki = +a.getAttribute('data-k');
    if (act === 'cancel') { closeDialog(); return; }
    if (act === 'bk-export') { exportBackup(); return; }
    if (act === 'del') { W.confirmDel = true; redraw(); return; }
    if (act === 'del-no') { W.confirmDel = false; redraw(); return; }
    if (act === 'del-yes') {
      var w = W; closeDialog();
      if (w.kind === 'project') { delete state.open[w.pid]; saveOpen(); report(removeDoc(w.pid), '削除しました'); }
      else report(mutate(w.pid, function (data) { data.groups.forEach(function (g) { if (g.id === w.origGid) g.tasks = g.tasks.filter(function (t) { return t.id !== w.tid; }); }); }), '削除しました');
      return;
    }
    if (act === 'del-from') {
      var wf = W; closeDialog();
      report(mutate(wf.pid, function (data) { data.until = wf.viewYear - 1; }), wf.viewYear + '年から先は出さないようにしました');
      return;
    }
    if (act === 'no-until') {
      var wn = W; closeDialog();
      report(mutate(wn.pid, function (data) { data.until = 0; }), '終わりの年をなくしました');
      return;
    }
    if (act === 'override') {
      var wo = W, src = findDoc(wo.pid); closeDialog();
      if (!src) return;
      var copy = clone(src.data), nid = newId('p');
      copy.repeat = false; copy.until = 0; copy.year = wo.viewYear; copy.series = seriesOf(src);
      if (state.open[wo.pid]) { state.open[nid] = true; saveOpen(); }
      report(putDoc(nid, copy), wo.viewYear + '年だけの内容を作りました。この年の分だけ直せます');
      return;
    }
    if (act === 'gadd') { W.groups.push({ id: newId('g'), name: '', color: COLORS[W.groups.length % COLORS.length], count: 0, del: false }); drawProject('g-name-' + (W.groups.length - 1)); return; }
    if (act === 'gdel') { var g = W.groups[i]; if (g.count === 0 && !findGroupSaved(g.id)) W.groups.splice(i, 1); else g.del = true; drawProject(); return; }
    if (act === 'gundo') { W.groups[i].del = false; drawProject('g-name-' + i); return; }
    if (act === 'mquick') { quickAdd(); return; }
    if (act === 'madd') {
      var last = W.marks[W.marks.length - 1];
      W.marks.push({ id: newId('m'), type: 'point', m1: last ? last.m1 : (state.year === T.y ? T.m : 1), p1: 'mid', when: '', what: '' });
      var n = W.marks.length - 1; W.marks[n].when = autoWhen(W.marks[n]);
      drawTask('m-type-' + n); return;
    }
    if (act === 'mdel') { W.marks.splice(ki, 1); drawTask(); return; }
  });
  function findGroupSaved(gid) {
    var d = W && W.pid ? findDoc(W.pid) : null, hit = false;
    if (d) d.data.groups.forEach(function (g) { if (g.id === gid) hit = true; });
    return hit;
  }
  function onField(ev) {
    var el = ev.target, f = el.getAttribute('data-f');
    if (!W || !f) return;
    var isChoice = el.tagName === 'SELECT' || el.type === 'checkbox';
    if ((ev.type === 'change') !== isChoice) return; // 文字は input、選ぶものは change で受ける
    if (el.hasAttribute('data-k')) {
      var i = +el.getAttribute('data-k'), k = W.marks[i]; if (!k) return;
      if (f === 'when') { k.when = el.value; return; }
      if (f === 'what') { k.what = el.value; return; }
      if (f === 'fade') { k.fade = el.checked; return; }
      if (f === 'type') {
        var was = k.type; k.type = el.value;
        if (k.type === 'range' && was !== 'range') {
          k.m2 = k.m1;
          if (k.p1 === 'day') { k.p2 = 'day'; k.d2 = k.d1; } else { k.p1 = 'start'; k.p2 = 'end'; }
        }
        if (k.type !== 'range' && was === 'range') { if (k.p1 !== 'day') k.p1 = 'mid'; delete k.m2; delete k.p2; delete k.d2; delete k.fade; }
        if (k.type === 'dead' && k.p1 !== 'day') k.p1 = 'end'; // 締切は、まず「月末まで」にしておく
        k.when = usesDay(k) ? '' : autoWhen(k); drawTask('m-type-' + i); return;
      }
      if (f === 'd1' || f === 'd2') { var dv = clampInt(el.value, 1, 31); if (!dv) return; k[f] = dv; }
      else if (f === 'm1' || f === 'm2') k[f] = +el.value;
      else k[f] = el.value;
      if (k.p1 === 'day' && !k.d1) k.d1 = 1;
      if (k.p1 !== 'day') delete k.d1;
      if (k.type === 'range' && k.p2 === 'day' && !k.d2) k.d2 = k.p1 === 'day' && k.m2 === k.m1 ? k.d1 : dimOf(k.m2);
      if (k.type === 'range' && k.p2 !== 'day') delete k.d2;
      var fixed = false;
      if (k.type === 'range' && mEnd(k) < mStart(k) && f !== 'd1' && f !== 'd2') {
        // 終わりが始まりより前になったら、動かした側に合わせる（日を打っている途中は直さず、保存のときに確かめる）
        fixed = true;
        if (f === 'm1' || f === 'p1') { k.m2 = k.m1; if (mEnd(k) < mStart(k)) { if (k.p1 === 'day') { k.p2 = 'day'; k.d2 = k.d1; } else { k.p2 = 'end'; delete k.d2; } } }
        else { k.m1 = k.m2; if (mEnd(k) < mStart(k)) { if (k.p2 === 'day') { k.p1 = 'day'; k.d1 = k.d2; } else { k.p1 = 'start'; delete k.d1; } } }
      }
      k.when = usesDay(k) ? '' : autoWhen(k);
      if (f === 'p1' || f === 'p2' || fixed) { drawTask(el.id); return; }
      var wi = $('m-when-' + i); if (wi) { wi.value = k.when; wi.placeholder = autoWhen(k, state.year); }
      return;
    }
    if (el.hasAttribute('data-g')) { var g = W.groups[+el.getAttribute('data-g')]; if (g) g[f === 'gname' ? 'name' : 'color'] = el.value; return; }
    if (f === 'pick') { W.pick[el.getAttribute('data-id')] = el.checked; return; }
    if (f === 'from') { W.from = +el.value; W.pick = null; drawCopy('c-from'); return; }
    if (f === 'pos') { W.pos = +el.value; return; }
    if (f === 'repeat') { W.repeat = el.value === '1'; return; }
    if (f === 'gid') { W.gid = el.value; W.pos = 9999; drawTask('t-gid'); return; }
    W[f] = el.value;
    if (W.kind === 'bulk' && f === 'text') drawBulkPreview();
  }
  form.addEventListener('input', onField);
  form.addEventListener('change', onField);
  form.addEventListener('change', function (ev) {
    if (ev.target.id === 'bk-file' && ev.target.files && ev.target.files[0]) readBackupFile(ev.target.files[0]);
  });

  // ===== はじめる =====
  // デモの最初の1回だけ、見本を入れる
  function seedDemo() {
    try { if (localStorage.getItem('schedule-local-v1')) return; } catch (e) { return; }
    store.set('demo-sample', { year: T.y, series: 'demo-sample', name: '（見本）カタログ制作', sub: 'デモ用の見本です', order: 1, repeat: true, until: 0, view: 'bar',
      groups: [{ id: 'g1', name: '', color: 'violet', tasks: [
        { id: 's1', title: '制作の打ち合わせ', party: '社内', todo: ['日程を決める'], note: '', marks: [{ id: 'm1', type: 'point', m1: 3, p1: 'end', when: '3月末頃', what: '' }] },
        { id: 's2', title: '校正', party: '制作会社', todo: ['初校を確かめる', '直しをまとめて返す'], note: '', marks: [{ id: 'm1', type: 'range', m1: 6, p1: 'start', m2: 7, p2: 'end', when: '6月〜7月', what: '' }] },
        { id: 's3', title: '入稿', party: '', todo: [], note: '', marks: [{ id: 'm1', type: 'dead', m1: 8, p1: 'day', d1: 20, when: '', what: '' }] }
      ] }] });
  }
  render();
  (function start() {
    var portalUser = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    if (/[?&]demo=1(&|$)/.test(location.search) || (portalUser && portalUser.isDemo)) {
      state.local = true; store = makeLocalStore(); seedDemo(); subscribe();
      return;
    }
    if (typeof firebase === 'undefined' || typeof firebaseConfig === 'undefined') { state.error = 'nodb'; state.loaded = true; render(); return; }
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    var db = firebase.firestore(), started = false;
    firebase.auth().onAuthStateChanged(function (user) {
      if (!user) { if (!started) { state.error = 'signin'; state.loaded = true; render(); } return; }
      if (started) return;
      started = true; state.error = null; state.loaded = false;
      store = makeFirestoreStore(db);
      render();
      subscribe();
    });
  })();
})();
