/* ふたりの家計簿 — アプリ本体(Firebase / GitHub Pages 版) */
'use strict';
const FB_VERSION = '12.19.0';
const FB_BASE = 'https://www.gstatic.com/firebasejs/' + FB_VERSION + '/';

/* ---------- 小さな道具 ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch (e) { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) {} },
  del(k) { try { localStorage.removeItem(k) } catch (e) {} }
};
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200) }
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') };

/* 共有ID(合言葉)。推測されないよう22文字のランダム英数字にする */
function newHouseholdId() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = new Uint8Array(24); crypto.getRandomValues(buf);
  let s = ''; for (const b of buf) { if (b < 248) s += abc[b % abc.length]; if (s.length === 22) break }
  while (s.length < 22) { const x = new Uint8Array(1); crypto.getRandomValues(x); s += abc[x[0] % abc.length] }
  return s;
}
function parseHid(str) {
  if (!str) return null; str = String(str).trim();
  const m = str.match(/[#?&]h=([A-Za-z0-9]{20,64})(?![A-Za-z0-9])/); if (m) return m[1];
  return /^[A-Za-z0-9]{20,64}$/.test(str) ? str : null;
}
function errMsg(e) {
  const c = e && e.code || '';
  if (c.includes('permission-denied')) return '保存が許可されませんでした。Firestore のルール設定を確認してください';
  if (c.includes('resource-exhausted')) return '今日の無料枠を使い切りました。明日になると戻ります';
  if (c.includes('unavailable')) return '通信できません。つながると自動で送られます';
  return '保存できませんでした。もう一度お試しください';
}

/* ---------- ② データ層:Firestore / 端末内保存 の共通窓口 ---------- */
const Store = (() => {
  let mode = 'local', F = null, db = null, app = null, hid = null;
  const KEY = 'kakeibo-local-v1';
  let local = LS.get(KEY, { settings: null, trips: {}, entries: {} });
  const subs = new Set();
  const persist = () => { LS.set(KEY, local); subs.forEach(s => s()) };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const localWatch = fn => { subs.add(fn); fn(); return () => subs.delete(fn) };
  const docs = q => q.docs.map(d => Object.assign({ id: d.id }, d.data()));
  const onErr = e => toast(e && String(e.code).includes('permission-denied') ? 'データを読めません。Firestore のルール設定を確認してください' : '読み込みに失敗しました。開き直してください');
  const col = name => F.collection(db, 'households', hid, name);
  /* オフラインでも固まらないよう、送信完了を最大0.7秒だけ待つ。それ以降の失敗はトーストで知らせる */
  function write(p) {
    return new Promise((res, rej) => {
      let done = false;
      const t = setTimeout(() => { done = true; res() }, 700);
      p.then(() => { if (!done) { clearTimeout(t); done = true; res() } },
        e => { if (!done) { clearTimeout(t); done = true; rej(e) } else toast(errMsg(e)) });
    });
  }
  return {
    get mode() { return mode }, get app() { return app }, get hid() { return hid },
    async initCloud(cfg, householdId) {
      const appM = await import(FB_BASE + 'firebase-app.js');
      F = await import(FB_BASE + 'firebase-firestore.js');
      app = appM.initializeApp(cfg.firebase);
      try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }) }
      catch (e) { db = F.getFirestore(app) }
      hid = householdId; mode = 'cloud';
    },
    watchSettings(cb) {
      if (mode === 'cloud') return F.onSnapshot(F.doc(db, 'households', hid, 'meta', 'settings'), s => cb(s.exists() ? s.data() : null), onErr);
      return localWatch(() => cb(local.settings));
    },
    async saveSettings(data) {
      if (mode === 'cloud') return write(F.setDoc(F.doc(db, 'households', hid, 'meta', 'settings'), data));
      local.settings = data; persist();
    },
    watchTrips(cb) {
      if (mode === 'cloud') return F.onSnapshot(col('trips'), q => cb(docs(q)), onErr);
      return localWatch(() => cb(Object.entries(local.trips).map(([id, v]) => Object.assign({ id }, v))));
    },
    async saveTrip(id, data) {
      if (mode === 'cloud') return write(F.setDoc(id ? F.doc(col('trips'), id) : F.doc(col('trips')), data));
      local.trips[id || newId()] = data; persist();
    },
    async deleteTrip(id) {
      const list = await this.query('trip', id);
      for (const e of list) { const { id: eid, ...rest } = e; await this.saveEntry(eid, Object.assign(rest, { trip: '' })) }
      if (mode === 'cloud') return write(F.deleteDoc(F.doc(col('trips'), id)));
      delete local.trips[id]; persist();
    },
    watchEntries(field, value, cb) {
      if (mode === 'cloud') return F.onSnapshot(F.query(col('entries'), F.where(field, '==', value)), q => cb(docs(q)), onErr);
      return localWatch(() => cb(Object.entries(local.entries).filter(([, v]) => v[field] === value).map(([id, v]) => Object.assign({ id }, v))));
    },
    async query(field, value) {
      if (mode === 'cloud') return docs(await F.getDocs(F.query(col('entries'), F.where(field, '==', value))));
      return Object.entries(local.entries).filter(([, v]) => v[field] === value).map(([id, v]) => Object.assign({ id }, v));
    },
    async queryMonths(from, to) {
      if (mode === 'cloud') return docs(await F.getDocs(F.query(col('entries'), F.where('month', '>=', from), F.where('month', '<=', to))));
      return Object.entries(local.entries).filter(([, v]) => v.month >= from && v.month <= to).map(([id, v]) => Object.assign({ id }, v));
    },
    async saveEntry(id, data) {
      if (mode === 'cloud') return write(F.setDoc(id ? F.doc(col('entries'), id) : F.doc(col('entries')), data));
      local.entries[id || newId()] = data; persist();
    },
    async deleteEntry(id) {
      if (mode === 'cloud') return write(F.deleteDoc(F.doc(col('entries'), id)));
      delete local.entries[id]; persist();
    }
  };
})();

/* ---------- 初期設定 ---------- */
const DEFAULTS = {
  members: [{ id: 'a', name: '滉太' }, { id: 'b', name: '知香' }],
  categories: [
    { id: 'living', name: '生活費(食料・日用品)', living: true },
    { id: 'house', name: '住まい・光熱', living: true },
    { id: 'eatout', name: '外食', living: false },
    { id: 'fun', name: '娯楽', living: false },
    { id: 'move', name: '交通', living: false },
    { id: 'wear', name: '衣服・美容', living: false },
    { id: 'health', name: '医療・健康', living: false },
    { id: 'gift', name: '交際', living: false },
    { id: 'other', name: 'その他', living: false }
  ],
  purposes: [
    { id: 'living', name: '生活費', living: true },
    { id: 'saving', name: '貯金', living: false },
    { id: 'trip', name: '旅行', living: false },
    { id: 'other', name: 'その他', living: false }
  ]
};

/* ---------- 状態 ---------- */
const state = {
  boot: 'loading', configured: false, cfg: null,
  settingsRaw: null, trips: [], month: today().slice(0, 7), book: 'daily', monthEntries: null,
  tab: 'month', tripId: null, tripEntries: null,
  diff: { from: Calc.shiftMonth(today().slice(0, 7), -5), to: today().slice(0, 7), rows: null },
  me: LS.get('kakeibo-me', 'a'), draft: null, form: null, scanning: false, model: null, receiptOn: false
};
const S = () => {
  const r = state.settingsRaw || {};
  return {
    members: (r.members && r.members.length === 2) ? r.members : DEFAULTS.members,
    categories: (r.categories && r.categories.length) ? r.categories : DEFAULTS.categories,
    purposes: (r.purposes && r.purposes.length) ? r.purposes : DEFAULTS.purposes
  };
};
const color = id => id === 'a' ? 'var(--a)' : 'var(--b)';
const nameOf = id => { const m = S().members.find(x => x.id === id); return m ? m.name : '—' };
const fig = (n, cls = '') => `<span class="fig ${cls}">${Calc.yen(n)}</span>`;
const sfig = (n, cls = '') => `<span class="fig ${n >= 0 ? 'plus' : 'minus'} ${cls}">${Calc.signed(n)}</span>`;
const jpDate = d => { const [y, m, dd] = d.split('-').map(Number); const w = '日月火水木金土'[new Date(y, m - 1, dd).getDay()]; return `${m}月${dd}日(${w})` };
const jpMonth = m => { const [y, mo] = m.split('-').map(Number); return `${y}年${mo}月` };
const tripName = id => { const t = state.trips.find(x => x.id === id); return t ? t.name : '旅' };
const shareUrl = () => location.origin + location.pathname + '#h=' + Store.hid;

/* ---------- 購読 ---------- */
let unMonth = null, unTrip = null;
function subMonth() { if (unMonth) unMonth(); state.monthEntries = null; unMonth = Store.watchEntries('month', state.month, l => { state.monthEntries = l; render() }) }
function subTrip() { if (unTrip) unTrip(); unTrip = null; state.tripEntries = null; if (!state.tripId) return; unTrip = Store.watchEntries('trip', state.tripId, l => { state.tripEntries = l; render() }) }

/* ---------- ⑤ 画面 ---------- */
const TABS = [['month', '今月'], ['list', '明細'], ['ease', 'ゆとり'], ['trips', '旅'], ['settings', '設定']];
function render() {
  const ready = state.boot === 'ready';
  $('#tabbar').hidden = !ready;
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button data-act="tab:${k}" ${state.tab === k ? 'aria-current="page"' : ''}>${l}</button>`).join('');
  $('#monthnav').style.visibility = ready && (state.tab === 'month' || state.tab === 'list') ? 'visible' : 'hidden';
  $('#fab').hidden = !ready || state.tab === 'settings' || state.tab === 'ease' || (state.tab === 'trips' && !state.tripId);
  $('#mode').textContent = !ready ? '' : Store.mode === 'cloud' ? (navigator.onLine ? 'ふたりで共有中' : 'オフライン ― つながると同期します') : 'お試し中(この端末だけに保存)';
  const v = $('#view');
  if (state.boot === 'loading') { v.innerHTML = '<p class="loading">ひらいています…</p>'; return }
  if (state.boot === 'welcome') { v.innerHTML = viewWelcome(); return }
  if (state.boot === 'error') { v.innerHTML = viewError(); return }
  v.innerHTML = { month: viewMonth, list: viewList, ease: viewEase, trips: viewTrips, settings: viewSettings }[state.tab]();
}
function viewWelcome() {
  return `<section class="welcome"><h1>ふたりの<br>家計簿</h1>
  <p class="lede">はじめに、ふたりで使う家計簿をつくります。どちらか一方が「新しくはじめる」を押し、もう一方には設定画面から共有リンクを送ってください。</p>
  <button class="btn" data-act="hh-new">新しくはじめる</button>
  <section class="sec"><h2>受け取ったリンクで参加する</h2>
    <div class="field"><label for="hh-in">共有リンク(または合言葉)</label><input class="inp" id="hh-in" autocomplete="off" placeholder="https://…#h=…"></div>
    <div class="btnrow"><button class="btn ghost" data-act="hh-join">参加する</button></div></section></section>`;
}
function viewError() {
  return `<section class="welcome"><h1>つながりません</h1>
  <p class="lede">データの保管場所(Firebase)に接続できませんでした。通信を確かめてから、もう一度ひらいてください。初めて設置した直後なら、config.js の貼り付け内容も確認してください。</p>
  <button class="btn" data-act="reload">もう一度ひらく</button></section>`;
}
function bookChips(all) {
  const ids = new Set(all.filter(e => e.trip).map(e => e.trip));
  state.trips.forEach(t => { if (t.start && t.start.slice(0, 7) <= state.month && (t.end || t.start).slice(0, 7) >= state.month) ids.add(t.id) });
  const opts = [['daily', '日々の暮らし'], ...[...ids].map(id => [id, '旅 ' + tripName(id)]), ['all', 'すべて']];
  if (!opts.find(o => o[0] === state.book)) state.book = 'daily';
  return `<div class="seg" role="group" aria-label="集計の範囲">${opts.map(([id, l]) => `<button class="chip" data-act="book:${esc(id)}" aria-pressed="${state.book === id}">${esc(l)}</button>`).join('')}</div>`;
}
function payerBlock(sum, s) {
  const [A, B] = s.members, oa = sum.outBy[A.id] || 0, ob = sum.outBy[B.id] || 0, tot = oa + ob;
  const person = mm => `<div><div class="who"><i class="dot" style="background:${color(mm.id)}"></i>${esc(mm.name)}</div><dl><dt>支払い</dt><dd>${fig(sum.outBy[mm.id] || 0)}</dd><dt>入金</dt><dd>${fig(sum.inBy[mm.id] || 0)}</dd></dl></div>`;
  return `<div class="split" aria-hidden="true"><span style="width:${tot ? oa / tot * 100 : 50}%"></span><span style="width:${tot ? ob / tot * 100 : 50}%"></span></div><div class="pair">${person(A)}${person(B)}</div>`;
}
function catBars(sum, s, markLiving) {
  const cats = Object.entries(sum.byCat).sort((a, b) => b[1] - a[1]); if (!cats.length) return '';
  const max = cats[0][1];
  return `<ul class="rows">${cats.map(([id, a]) => { const c = Calc.catOf(s, id); const liv = markLiving && c && c.living; return `<li><div class="r"><span>${esc(c ? c.name : '未分類')}${liv ? '<i class="tag">生活費</i>' : ''}</span>${fig(a)}</div><div class="bar"><span class="${liv ? 'living' : ''}" style="width:${Math.max(2, a / max * 100)}%"></span></div></li>` }).join('')}</ul>`;
}
function viewMonth() {
  const all = state.monthEntries; if (!all) return '<p class="loading">ひらいています…</p>';
  const s = S(), [y, m] = state.month.split('-').map(Number);
  const chips = bookChips(all);
  const list = Calc.filterBook(all, state.book), sum = Calc.summarize(list, s), liv = Calc.summarize(all, s);
  const label = state.book === 'daily' ? '日々の暮らし' : state.book === 'all' ? 'この月ぜんぶ' : tripName(state.book);
  const lede = sum.count ? `${esc(label)}の記録は${sum.count}件。使ったお金は<b>${Calc.yen(sum.totalOut)}</b>、入れたお金は<b>${Calc.yen(sum.totalIn)}</b>。` : `${esc(label)}の記録はまだありません。右下の「記録する」から最初の一件を。`;
  const purRows = Object.entries(sum.byPurpose).sort((a, b) => b[1] - a[1]).map(([id, a]) => { const p = Calc.purOf(s, id); return `<li><div class="r"><span>${esc(p ? p.name : 'その他')}</span>${fig(a)}</div></li>` }).join('');
  const bars = catBars(sum, s, true);
  return `
  <section class="cover"><div class="year">${y}</div><div class="num" aria-label="${m}月">${m}</div><div class="gou" aria-hidden="true"><span>月</span><span>号</span></div></section>
  <p class="lede">${lede}</p>
  ${Store.mode === 'local' ? '<p class="banner">お試し中です。ふたりで共有するには、README の手順で Firebase を設定してください。</p>' : ''}
  ${chips}
  <section class="sec"><h2>使ったお金</h2>${bars || '<p class="note">支出の記録はまだありません。</p>'}</section>
  <section class="sec"><h2>入れたお金</h2>${purRows ? `<ul class="rows">${purRows}</ul>` : '<p class="note">入金の記録はまだありません。</p>'}</section>
  <section class="sec"><h2>ふたりの支払い</h2>${payerBlock(sum, s)}</section>
  <section class="sec"><h2>生活費のゆとり</h2>
    <p class="note">生活費として入れたお金から、生活費の項目で使ったお金を引いた額です。旅の記録は含みません。</p>
    <div class="ease"><div class="lbl">${m}月の差分</div><div class="big">${sfig(liv.livingDiff)}</div>
    <div class="calc"><span>入金 ${fig(liv.livingIn)}</span><span>支出 ${fig(liv.livingOut)}</span></div>
    <button class="link" data-act="tab:ease">数ヶ月の通算を見る</button></div></section>`;
}
function itemRow(e) {
  const s = S();
  const title = e.kind === 'in' ? '入金 ' + ((Calc.purOf(s, e.purpose) || {}).name || 'その他') : ((Calc.catOf(s, e.cat) || {}).name || '未分類');
  const meta = [`<span class="payer"><i class="dot" style="background:${color(e.payer)}"></i>${esc(nameOf(e.payer))}</span>`];
  if (e.trip) meta.push('旅 ' + esc(tripName(e.trip)));
  if (e.kind === 'out') meta.push(e.receipt ? '証憑あり' : '証憑なし');
  if (e.memo) meta.push(esc(e.memo));
  return `<button class="item ${e.kind}" data-act="edit:${esc(e.id)}"><span class="cat">${esc(title)}</span><span class="fig amt">${e.kind === 'in' ? '+' : ''}${Calc.yen(e.amount)}</span><span class="meta">${meta.join('<span aria-hidden="true">/</span>')}</span></button>`;
}
function groupByDay(list) {
  const g = {}; list.forEach(e => { (g[e.date] = g[e.date] || []).push(e) });
  return Object.keys(g).sort().reverse().map(d => `<div class="day"><h3>${jpDate(d)}</h3>${g[d].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(itemRow).join('')}</div>`).join('');
}
function viewList() {
  const all = state.monthEntries; if (!all) return '<p class="loading">ひらいています…</p>';
  const chips = bookChips(all), list = Calc.filterBook(all, state.book);
  return `<section class="tripcover"><h1>${jpMonth(state.month)}の明細</h1></section>${chips}${list.length ? groupByDay(list) : '<p class="empty">この範囲の記録はまだありません。</p>'}`;
}
function viewEase() {
  const d = state.diff, rows = d.rows;
  let body = '<p class="loading">集計しています…</p>';
  if (rows) {
    const last = rows.length ? rows[rows.length - 1].cumulative : 0;
    const tin = rows.reduce((a, r) => a + r.livingIn, 0), tout = rows.reduce((a, r) => a + r.livingOut, 0);
    body = `<div class="ease"><div class="lbl">${jpMonth(rows[0] ? rows[0].month : d.from)}〜${jpMonth(rows.length ? rows[rows.length - 1].month : d.to)}の通算</div>
      <div class="big">${sfig(last)}</div><div class="calc"><span>入金 ${fig(tin)}</span><span>支出 ${fig(tout)}</span></div></div>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>月</th><th>入金</th><th>支出</th><th>差分</th><th>通算</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${Number(r.month.slice(5))}月<br><small style="color:var(--ink-2)">${r.month.slice(0, 4)}</small></td><td>${fig(r.livingIn)}</td><td>${fig(r.livingOut)}</td><td>${sfig(r.diff)}</td><td>${sfig(r.cumulative)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  return `<section class="tripcover"><h1>生活費のゆとり</h1><p>生活費として入れたお金と、生活費の項目で使ったお金の差を、月ごとと通算で見ます。</p></section>
  <div class="seg">${[3, 6, 12].map(n => `<button class="chip" data-act="ease-preset:${n}">直近${n}ヶ月</button>`).join('')}</div>
  <div class="range"><input type="month" id="ef" value="${d.from}" aria-label="開始月"><span>〜</span><input type="month" id="et" value="${d.to}" aria-label="終了月"></div>
  ${body}`;
}
let easeSeq = 0;
async function loadEase() {
  const d = state.diff, seq = ++easeSeq; d.rows = null; render();
  if (d.from > d.to) { const t = d.from; d.from = d.to; d.to = t }
  const months = Calc.monthsBetween(d.from, d.to);
  try {
    const list = await Store.queryMonths(months[0], months[months.length - 1]);
    if (seq !== easeSeq) return;
    d.rows = Calc.livingSeries(Calc.groupByMonth(list, months), S());
  } catch (e) { if (seq !== easeSeq) return; d.rows = []; toast('集計に失敗しました。通信を確かめてもう一度ひらいてください') }
  if (state.tab === 'ease') render();
}
function viewTrips() {
  if (state.tripId) {
    const t = state.trips.find(x => x.id === state.tripId);
    if (!t) { state.tripId = null; subTrip(); return viewTrips() }
    const list = state.tripEntries; if (!list) return '<p class="loading">ひらいています…</p>';
    const s = S(), sum = Calc.summarize(list, s);
    const [A, B] = s.members, oa = sum.outBy[A.id] || 0, ob = sum.outBy[B.id] || 0, tot = oa + ob;
    const diffA = oa - Math.round(tot / 2);
    return `<button class="back" data-act="trip-back">‹ 旅の一覧</button>
    <section class="tripcover"><h1>${esc(t.name)}</h1><p>${t.start ? jpDate(t.start) : ''}${t.end && t.end !== t.start ? ' 〜 ' + jpDate(t.end) : ''}</p></section>
    <p class="lede">この旅で使ったお金は<b>${Calc.yen(sum.totalOut)}</b>、旅のために入れたお金は<b>${Calc.yen(sum.totalIn)}</b>。</p>
    <section class="sec"><h2>使ったお金</h2>${catBars(sum, s, false) || '<p class="note">支出の記録はまだありません。</p>'}</section>
    <section class="sec"><h2>ふたりの支払い</h2>${payerBlock(sum, s)}
      ${tot ? `<p class="note">半分ずつにするなら、${diffA === 0 ? '精算は不要です。' : `${esc(diffA > 0 ? B.name : A.name)}さんから${esc(diffA > 0 ? A.name : B.name)}さんへ ${Calc.yen(diffA)}。`}</p>` : ''}</section>
    <section class="sec"><h2>明細</h2>${list.length ? groupByDay(list) : '<p class="note">「記録する」で旅の支出を追加すると、ここに並びます。</p>'}</section>
    <div class="actions"><button class="btn warn" data-act="trip-delete">この旅を削除</button></div>`;
  }
  const trips = [...state.trips].sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  return `<section class="tripcover"><h1>旅の記録</h1><p>旅の支出は日々の生活費と分けて集計します。</p></section>
  ${trips.length ? trips.map(t => `<button class="trip" data-act="trip-open:${esc(t.id)}"><span class="nm">${esc(t.name)}</span><span class="dt">${t.start ? jpDate(t.start) : ''}${t.end && t.end !== t.start ? ' 〜 ' + jpDate(t.end) : ''}</span></button>`).join('') : '<p class="empty">まだ旅はありません。下で最初の旅をつくりましょう。</p>'}
  <section class="sec"><h2>旅をつくる</h2>
    <div class="field"><label for="tn">名前</label><input class="inp" id="tn" maxlength="40" placeholder="例:秋の松島"></div>
    <div class="field"><label for="ts">はじまり</label><input class="inp" type="date" id="ts" value="${today()}"></div>
    <div class="field"><label for="te">おわり</label><input class="inp" type="date" id="te" value="${today()}"></div>
    <div class="actions"><span></span><button class="btn" data-act="trip-add">旅をつくる</button></div></section>`;
}
function viewSettings() {
  if (!state.draft) state.draft = JSON.parse(JSON.stringify(S()));
  const d = state.draft;
  const row = (kind, x, i) => `<div class="setrow"><input class="inp" data-set="${kind}-name" data-i="${i}" value="${esc(x.name)}" maxlength="30" aria-label="名前">
    <label class="chk"><input type="checkbox" data-set="${kind}-living" data-i="${i}" ${x.living ? 'checked' : ''}>生活費</label>
    <button class="x" data-act="set-del:${kind}:${i}" aria-label="${esc(x.name)}を削除">×</button></div>`;
  const share = Store.mode === 'cloud' ? `<section class="sec"><h2>ふたりで共有する</h2>
    <p class="note">このリンクを開いた人は、誰でもこの家計簿を見て書き込めます。ふたり以外には送らないでください。</p>
    <div class="sharebox" id="share-url">${esc(shareUrl())}</div>
    <div class="btnrow"><button class="btn" data-act="share">リンクを送る</button><button class="btn ghost" data-act="copy">リンクをコピー</button></div></section>` : '';
  return `<section class="tripcover"><h1>設定</h1></section>
  ${share}
  <section class="sec"><h2>この端末で使う人</h2><p class="note">記録するとき、支払った人の初期値になります。</p>
    <div class="chips" style="margin-top:14px">${d.members.map(m => `<button class="chip" data-act="me:${m.id}" aria-pressed="${state.me === m.id}">${esc(m.name)}</button>`).join('')}</div></section>
  <section class="sec"><h2>ふたりの名前</h2>${d.members.map((m, i) => `<div class="field"><label>${i === 0 ? 'ひとりめ' : 'ふたりめ'}</label><input class="inp" data-set="member-name" data-i="${i}" value="${esc(m.name)}" maxlength="20"></div>`).join('')}</section>
  <section class="sec"><h2>支出の項目</h2><p class="note">「生活費」に印をつけた項目が、生活費のゆとりの計算に入ります。</p>
    <div style="margin-top:10px">${d.categories.map((c, i) => row('cat', c, i)).join('')}</div>
    <button class="link" data-act="set-add:cat">項目を追加</button></section>
  <section class="sec"><h2>入金の用途</h2><p class="note">「生活費」に印をつけた用途の入金が、生活費のゆとりの計算に入ります。</p>
    <div style="margin-top:10px">${d.purposes.map((p, i) => row('pur', p, i)).join('')}</div>
    <button class="link" data-act="set-add:pur">用途を追加</button></section>
  <div class="actions"><button class="btn ghost" data-act="set-reset">変更を取り消す</button><button class="btn" data-act="set-save">設定を保存</button></div>
  ${Store.mode === 'cloud' ? `<section class="sec"><h2>この端末の接続</h2><p class="note">接続を解除しても、家計簿のデータは消えません。共有リンクを開けば、また戻れます。</p>
    <div class="btnrow"><button class="btn warn" data-act="hh-leave">この端末の接続を解除</button></div></section>` : ''}`;
}

/* ---------- 記録シート ---------- */
function tripForDate(d) { const t = state.trips.find(t => t.start && d >= t.start && d <= (t.end || t.start)); return t ? t.id : '' }
function openSheet(entry) {
  const s = S();
  if (entry) state.form = Object.assign({}, entry, { tripTouched: true });
  else {
    const d = state.month === today().slice(0, 7) ? today() : state.month + '-01';
    const tr = state.tab === 'trips' && state.tripId ? state.tripId : (state.book !== 'daily' && state.book !== 'all' ? state.book : tripForDate(d));
    state.form = { kind: 'out', amount: '', date: d, cat: s.categories[0].id, purpose: s.purposes[0].id, payer: state.me, memo: '', receipt: false, trip: tr, tripTouched: false };
  }
  renderSheet(); $('#sheet').classList.add('open'); $('#scrim').classList.add('open');
  if (!entry) setTimeout(() => { const a = $('#f-amount'); if (a) a.focus() }, 300);
}
function closeSheet() { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); $('#sheet').classList.remove('open'); $('#scrim').classList.remove('open'); state.form = null }
function syncForm() {
  const f = state.form; if (!f) return;
  const a = $('#f-amount'), d = $('#f-date'), m = $('#f-memo'), t = $('#f-trip');
  if (a) f.amount = a.value; if (d) f.date = d.value; if (m) f.memo = m.value; if (t) f.trip = t.value;
}
function renderSheet() {
  const f = state.form, s = S(); if (!f) return;
  const out = f.kind === 'out', editing = !!f.id;
  $('#sheet').innerHTML = `<div class="grab"></div>
  <div class="sheethead"><h2>${editing ? '記録を直す' : '記録する'}</h2><button class="x" data-act="sheet-close" aria-label="閉じる">×</button></div>
  <div class="chips" style="margin-top:14px"><button class="chip" data-act="f-kind:out" aria-pressed="${out}">支出</button><button class="chip" data-act="f-kind:in" aria-pressed="${!out}">入金</button></div>
  ${out && state.receiptOn && !editing ? `<button class="scan" data-act="scan" ${state.scanning ? 'disabled' : ''}>${state.scanning ? 'レシートを読み取っています…' : 'レシートを撮って読み取る'}</button>` : ''}
  <div class="field"><label for="f-amount">金額</label><div class="amount"><span>¥</span><input id="f-amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(f.amount ? Calc.toInt(f.amount).toLocaleString('ja-JP') : '')}"></div></div>
  <div class="field"><label for="f-date">日付</label><input class="inp" type="date" id="f-date" value="${esc(f.date)}"></div>
  <div class="field"><span class="lab">${out ? '項目' : '用途'}</span><div class="chips">${out ? s.categories.map(c => `<button class="chip" data-act="f-cat:${esc(c.id)}" aria-pressed="${f.cat === c.id}">${esc(c.name)}</button>`).join('') : s.purposes.map(p => `<button class="chip" data-act="f-pur:${esc(p.id)}" aria-pressed="${f.purpose === p.id}">${esc(p.name)}</button>`).join('')}</div></div>
  <div class="field"><span class="lab">${out ? '支払った人' : '入金した人'}</span><div class="chips">${s.members.map(m => `<button class="chip" data-act="f-payer:${m.id}" aria-pressed="${f.payer === m.id}"><i class="dot" style="background:${color(m.id)};margin-right:6px"></i>${esc(m.name)}</button>`).join('')}</div></div>
  <div class="field"><label for="f-trip">集計先</label><select class="inp" id="f-trip"><option value="">日々の暮らし</option>${state.trips.map(t => `<option value="${esc(t.id)}" ${f.trip === t.id ? 'selected' : ''}>旅 ${esc(t.name)}</option>`).join('')}</select></div>
  ${out ? `<div class="toggle"><span>証憑(レシート・領収書)あり</span><button class="sw" role="switch" aria-checked="${!!f.receipt}" data-act="f-receipt" aria-label="証憑あり"></button></div>` : ''}
  <div class="field"><label for="f-memo">メモ</label><textarea class="inp" id="f-memo" rows="2" maxlength="200" placeholder="お店や中身など">${esc(f.memo)}</textarea></div>
  <div class="actions">${editing ? '<button class="btn warn" data-act="f-delete">削除</button>' : '<span></span>'}<button class="btn" data-act="f-save">${editing ? '更新する' : '記録する'}</button></div>`;
}
async function saveForm() {
  syncForm(); const f = state.form, amt = Calc.toInt(f.amount);
  if (!amt) { toast('金額を入れてください'); return }
  if (amt > 100000000) { toast('金額が大きすぎます'); return }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { toast('日付を選んでください'); return }
  const data = { kind: f.kind, amount: amt, date: f.date, month: f.date.slice(0, 7), payer: f.payer, memo: (f.memo || '').slice(0, 200), trip: f.trip || '', createdAt: f.createdAt || Date.now() };
  if (f.kind === 'out') { data.cat = f.cat; data.receipt = !!f.receipt } else { data.purpose = f.purpose }
  const btn = document.querySelector('[data-act="f-save"]'); if (btn) btn.disabled = true;
  try { await Store.saveEntry(f.id || null, data); toast(f.id ? '更新しました' : '記録しました'); closeSheet() }
  catch (e) { if (btn) btn.disabled = false; toast(errMsg(e)) }
}

/* ---------- ⑦ レシート読み取り(Firebase AI Logic / 任意) ---------- */
async function initReceipt(cfg) {
  try {
    if (cfg.receipt.recaptchaSiteKey) {
      const ac = await import(FB_BASE + 'firebase-app-check.js');
      ac.initializeAppCheck(Store.app, { provider: new ac.ReCaptchaEnterpriseProvider(cfg.receipt.recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
    }
    const ai = await import(FB_BASE + 'firebase-ai.js');
    const inst = ai.getAI(Store.app, { backend: new ai.GoogleAIBackend() });
    state.model = ai.getGenerativeModel(inst, { model: cfg.receipt.model || 'gemini-3.5-flash', generationConfig: { responseMimeType: 'application/json' } });
    state.receiptOn = true; if (state.form) { syncForm(); renderSheet() }
  } catch (e) { console.warn('レシート読み取りを準備できませんでした', e) }
}
async function shrink(file) {
  try {
    const img = await createImageBitmap(file); const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', .85));
  } catch (e) { return file }
}
const toBase64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('read')); r.readAsDataURL(blob) });
function parseJsonLoose(t) {
  try { return JSON.parse(t) } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch (e) {} }
  return null;
}
async function scanReceipt(file) {
  if (!state.model || !state.form) return;
  syncForm(); state.scanning = true; renderSheet();
  const s = S();
  const prompt = `添付画像は日本のレシートです。読み取って、次の形のJSONだけを返してください。
{"date":"YYYY-MM-DD または null","total":税込合計金額の整数(円) または null,"store":"店名(なければ空文字)","summary":"主な品目を20字以内で","category":"次のidから最も近いもの1つ"}
category の候補: ${s.categories.map(c => `${c.id}=${c.name}`).join(', ')}
年が書かれていない場合は ${today().slice(0, 4)} 年とします。読めない項目は null にしてください。`;
  try {
    const img = await shrink(file);
    const res = await state.model.generateContent([prompt, { inlineData: { data: await toBase64(img), mimeType: img.type || 'image/jpeg' } }]);
    const r = parseJsonLoose(res.response.text());
    const f = state.form; if (!f) return;
    if (!r) throw Object.assign(new Error('json'), { code: 'invalid_json' });
    if (Number.isFinite(Number(r.total)) && Number(r.total) > 0) f.amount = String(Math.round(Number(r.total)));
    if (typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) { f.date = r.date; if (!f.tripTouched) f.trip = tripForDate(r.date) }
    if (s.categories.find(c => c.id === r.category)) f.cat = r.category;
    const memo = [r.store, r.summary].filter(Boolean).join(' ').slice(0, 200); if (memo) f.memo = memo;
    f.receipt = true;
    toast('読み取りました。内容を確かめてから記録してください');
  } catch (e) {
    const m = String(e && (e.code || e.message) || '');
    toast(/app-check|appCheck|403/i.test(m) ? 'レシート読み取りの設定(App Check)を確認してください'
      : /429|quota|exhausted/i.test(m) ? '読み取りの無料枠を使い切りました。時間をおいてお試しください'
      : /invalid_json/.test(m) ? 'うまく読み取れませんでした。手で入力してください'
      : '読み取りに失敗しました。手で入力してください');
  } finally { state.scanning = false; if (state.form) renderSheet() }
}

/* ---------- 共有 ---------- */
async function shareLink() {
  const url = shareUrl();
  if (navigator.share) { try { await navigator.share({ title: 'ふたりの家計簿', text: 'ふたりの家計簿の共有リンクです', url }); return } catch (e) { if (e && e.name === 'AbortError') return } }
  copyLink();
}
async function copyLink() {
  const url = shareUrl();
  try { await navigator.clipboard.writeText(url); toast('リンクをコピーしました') }
  catch (e) { const r = document.createRange(); const el = $('#share-url'); if (el) { r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r) } toast('リンクを長押ししてコピーしてください') }
}

/* ---------- イベント ---------- */
document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const full = el.dataset.act, [act, arg, arg2] = full.split(':');
  const rest = full.slice(act.length + 1);
  switch (act) {
    case 'tab':
      if (state.tab === 'settings' && arg !== 'settings') state.draft = null;
      state.tab = arg; if (arg === 'ease') loadEase(); render(); window.scrollTo(0, 0); break;
    case 'month-prev': case 'month-next':
      state.month = Calc.shiftMonth(state.month, act === 'month-prev' ? -1 : 1); subMonth(); render(); break;
    case 'book': state.book = rest; render(); break;
    case 'open-add': openSheet(null); break;
    case 'edit': { const src = (state.tab === 'trips' ? state.tripEntries : state.monthEntries) || []; const e = src.find(x => x.id === rest); if (e) openSheet(e); break }
    case 'sheet-close': closeSheet(); break;
    case 'f-kind': syncForm(); state.form.kind = arg; renderSheet(); break;
    case 'f-cat': syncForm(); state.form.cat = rest; renderSheet(); break;
    case 'f-pur': syncForm(); state.form.purpose = rest; renderSheet(); break;
    case 'f-payer': syncForm(); state.form.payer = arg; renderSheet(); break;
    case 'f-receipt': syncForm(); state.form.receipt = !state.form.receipt; renderSheet(); break;
    case 'f-save': saveForm(); break;
    case 'f-delete':
      if (confirm('この記録を削除します。元に戻せません。')) { try { await Store.deleteEntry(state.form.id); toast('削除しました'); closeSheet() } catch (e) { toast(errMsg(e)) } } break;
    case 'scan': $('#rcpt').value = ''; $('#rcpt').click(); break;
    case 'ease-preset': state.diff.to = today().slice(0, 7); state.diff.from = Calc.shiftMonth(state.diff.to, -(Number(arg) - 1)); loadEase(); break;
    case 'trip-open': state.tripId = rest; subTrip(); render(); window.scrollTo(0, 0); break;
    case 'trip-back': state.tripId = null; subTrip(); render(); break;
    case 'trip-add': {
      const n = $('#tn').value.trim(), s = $('#ts').value, e = $('#te').value || s;
      if (!n) { toast('旅の名前を入れてください'); return } if (!s) { toast('はじまりの日を選んでください'); return }
      try { await Store.saveTrip(null, { name: n.slice(0, 40), start: s <= e ? s : e, end: s <= e ? e : s }); toast('旅をつくりました') } catch (err) { toast(errMsg(err)) } break
    }
    case 'trip-delete':
      if (confirm('この旅を削除します。旅の記録は「日々の暮らし」に移ります。')) { const id = state.tripId; state.tripId = null; subTrip(); render(); try { await Store.deleteTrip(id); toast('旅を削除しました') } catch (e) { toast(errMsg(e)) } } break;
    case 'me': state.me = arg; LS.set('kakeibo-me', arg); render(); break;
    case 'set-add': { const d = state.draft, list = arg === 'cat' ? d.categories : d.purposes; list.push({ id: (arg === 'cat' ? 'c' : 'p') + Date.now().toString(36), name: arg === 'cat' ? '新しい項目' : '新しい用途', living: false }); render(); break }
    case 'set-del': { const d = state.draft, list = arg === 'cat' ? d.categories : d.purposes; if (list.length <= 1) { toast('最低ひとつは残してください'); return } list.splice(Number(arg2), 1); render(); break }
    case 'set-reset': state.draft = null; render(); break;
    case 'set-save': {
      const d = state.draft; if (d.members.some(m => !m.name.trim()) || d.categories.some(c => !c.name.trim()) || d.purposes.some(p => !p.name.trim())) { toast('空の名前があります'); return }
      try { await Store.saveSettings(JSON.parse(JSON.stringify(d))); state.draft = null; toast('設定を保存しました') } catch (e) { toast(errMsg(e)) } break
    }
    case 'share': shareLink(); break;
    case 'copy': copyLink(); break;
    case 'hh-new': { const id = newHouseholdId(); LS.set('kakeibo-hid', id); location.hash = 'h=' + id; location.reload(); break }
    case 'hh-join': {
      const id = parseHid($('#hh-in').value);
      if (!id) { toast('共有リンクをそのまま貼り付けてください'); return }
      LS.set('kakeibo-hid', id); location.hash = 'h=' + id; location.reload(); break
    }
    case 'hh-leave':
      if (confirm('この端末の接続を解除します。データは消えません。')) { LS.del('kakeibo-hid'); history.replaceState(null, '', location.pathname); location.reload() } break;
    case 'reload': location.reload(); break;
  }
});
document.addEventListener('input', ev => {
  const t = ev.target;
  if (t.id === 'f-amount') { const n = Calc.toInt(t.value); t.value = n ? n.toLocaleString('ja-JP') : '' }
  if (t.id === 'f-date' && state.form) { syncForm(); if (!state.form.tripTouched) { state.form.trip = tripForDate(t.value); const sel = $('#f-trip'); if (sel) sel.value = state.form.trip } }
  if (t.dataset && t.dataset.set && state.draft) {
    const i = Number(t.dataset.i), d = state.draft;
    ({ 'member-name': () => d.members[i].name = t.value, 'cat-name': () => d.categories[i].name = t.value, 'pur-name': () => d.purposes[i].name = t.value,
      'cat-living': () => d.categories[i].living = t.checked, 'pur-living': () => d.purposes[i].living = t.checked }[t.dataset.set] || (() => {}))();
  }
});
document.addEventListener('change', ev => {
  const t = ev.target;
  if ((t.id === 'ef' || t.id === 'et') && t.value) { state.diff[t.id === 'ef' ? 'from' : 'to'] = t.value; loadEase() }
  if (t.id === 'f-trip' && state.form) state.form.tripTouched = true;
});
$('#rcpt').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) scanReceipt(f) });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.form) closeSheet() });
addEventListener('online', render); addEventListener('offline', render);
addEventListener('hashchange', () => { const h = parseHid(location.hash); if (h && h !== Store.hid) { LS.set('kakeibo-hid', h); location.reload() } });

/* ---------- 起動 ---------- */
(async () => {
  const cfg = window.KAKEIBO_CONFIG || {};
  const fb = cfg.firebase || {};
  state.cfg = cfg; state.configured = !!(fb.apiKey && fb.projectId);
  render();
  if (state.configured) {
    const fromHash = parseHid(location.hash);
    if (fromHash) LS.set('kakeibo-hid', fromHash);
    const hid = fromHash || LS.get('kakeibo-hid', null);
    if (!hid) { state.boot = 'welcome'; render(); return }
    try { await Store.initCloud(cfg, hid) }
    catch (e) { console.error(e); state.boot = 'error'; render(); return }
    if (!fromHash) history.replaceState(null, '', location.pathname + '#h=' + hid);
    if (cfg.receipt && cfg.receipt.enabled) initReceipt(cfg);
  }
  state.boot = 'ready';
  Store.watchSettings(v => { state.settingsRaw = v; render() });
  Store.watchTrips(l => { state.trips = l; render() });
  subMonth();
})();
