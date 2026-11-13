/**
 * サントラベル 予約管理 × 公式サイト 連携スクリプト
 * スプレッドシート「サントラベル予約管理」の［拡張機能］→［Apps Script］に貼り付けて使います。
 *
 *  GET  ?action=tours   … 公開中のツアーと、受付中の出発日・残席を返す（サイトの表示・空席カレンダー用）
 *  POST {action:'book'} … サイトからの予約を「予約」「同行者」シートに追加し、カレンダーを更新する
 *
 * ⚠️ このコードを書き換えたら：［デプロイ］→［デプロイを管理］→ 鉛筆アイコン →「新バージョン」で更新すること。
 *    ［新しいデプロイ］を作るとURLが変わり、サイト（tours.html の API_URL）とつながらなくなります。
 */
const CONFIG = {
  SHEET_TOURS: 'ツアー',
  SHEET_DEPS: '出発日',
  SHEET_BOOKINGS: '予約',
  SHEET_TRAVELERS: '同行者',
  FUEL_DEFAULT: 6240,          // 燃油・諸税（目安）の初期値
  STAFF_EMAIL: '',             // 新規予約の通知先（例：'info@suntravel.co.jp'）。空欄なら送らない
  SEND_CUSTOMER_MAIL: false,   // true にするとお客様へ受付メールを送る（文面は sendCustomerMail_ を確認）
  CALENDAR_ID: '',             // 同期先のGoogleカレンダーID。空欄ならスプレッドシート所有者のメインカレンダー
  SITE_NAME: 'サントラベル',
  TEL: '03-3366-3221'
};

/* ============ Web API ============ */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'tours';
  try {
    if (action === 'tours') return json_({ ok: true, tours: getTours_(), updated: new Date().toISOString() });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'データを読み込めませんでした。' });
  }
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'リクエストの形式が正しくありません。' }); }
  try {
    if (body.action === 'book') return json_(book_(body));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: '予約を登録できませんでした。お手数ですがお電話（' + CONFIG.TEL + '）でご連絡ください。' });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ============ 読み込み ============ */
function sheet_(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }

function rows_(name) {
  const v = sheet_(name).getDataRange().getValues();
  const head = v.shift();
  const out = [];
  v.forEach(function (r, i) {
    if (r[0] === '' || r[0] === null) return;
    const o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    out.push(o);
  });
  return out;
}

function list_(s, sep) { return String(s || '').split(sep).map(function (x) { return x.trim(); }).filter(String); }
function num_(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function today_() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function ymd_(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd'); }

function getTours_() {
  const today = today_();
  const deps = rows_(CONFIG.SHEET_DEPS);
  return rows_(CONFIG.SHEET_TOURS).filter(function (t) { return t['公開'] === '公開'; }).map(function (t) {
    const id = String(t['ツアーID']).trim();
    const local = t['種別'] === '現地発';
    const dates = deps.filter(function (d) {
      return String(d['ツアーID']).trim() === id && d['受付'] === '受付中' && d['出発日'] instanceof Date && d['出発日'] >= today;
    }).sort(function (a, b) { return a['出発日'] - b['出発日']; })
      .map(function (d) { return [ymd_(d['出発日']), Math.max(0, num_(d['残席']))]; });
    return {
      id: id,
      name: String(t['ツアー名']),
      sub: String(t['サブタイトル'] || ''),
      code: 'ST-' + id.slice(0, 2).toUpperCase(),
      area: String(t['エリア'] || 'seoul'),
      cat: list_(t['カテゴリ'], ','),
      local: local,
      air: !local,
      days: num_(t['日数']) || 1,
      dur: String(t['所要時間'] || ''),
      adult: num_(t['大人料金']),
      child: num_(t['子供料金']),
      single: num_(t['1名1室追加']),
      fuel: local ? 0 : (num_(t['燃油・諸税（目安）']) || CONFIG.FUEL_DEFAULT),
      min: num_(t['最少催行人員']) || 1,
      inc: list_(t['含まれるもの'], '\n'),
      exc: list_(t['含まれないもの'], '\n'),
      badges: list_(t['バッジ'], ','),
      img: String(t['画像'] || ''),
      rating: num_(t['評価（見本）']),
      reviews: num_(t['体験談数（見本）']),
      kw: String(t['検索キーワード'] || ''),
      dates: dates
    };
  });
}

/* ============ 予約登録 ============ */
function depositPP_(p) { return p < 30000 ? p : p < 60000 ? 10000 : p < 100000 ? 20000 : p < 150000 ? 30000 : Math.round(p * 0.2); }

function book_(b) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: '混み合っています。少し時間をおいてもう一度お試しください。' };
  try {
    const t = getTours_().filter(function (x) { return x.id === b.tourId; })[0];
    if (!t) return { ok: false, error: 'このツアーは現在お申し込みいただけません。' };
    const dep = t.dates.filter(function (d) { return d[0] === b.date; })[0];
    if (!dep) return { ok: false, error: 'この出発日は受付を終了しました。別の日程をお選びください。' };

    const adults = Math.floor(num_(b.adults)), children = Math.floor(num_(b.children)), pax = adults + children;
    if (adults < 1 || children < 0 || pax > 9) return { ok: false, error: '人数が正しくありません。' };
    if (pax < t.min) return { ok: false, error: 'このツアーは' + t.min + '名様から催行します。' };
    if (pax > dep[1]) return { ok: false, error: dep[1] === 0 ? 'この出発日は満席になりました。' : '残席が足りません（残り' + dep[1] + '席）。' };

    const L = b.lead || {};
    const need = ['sei', 'mei', 'rs', 'rm', 'tel', 'mail'];
    for (let i = 0; i < need.length; i++) if (!String(L[need[i]] || '').trim()) return { ok: false, error: 'お客様情報に未入力の項目があります。' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(L.mail)) return { ok: false, error: 'メールアドレスを正しく入力してください。' };
    if (!(b.agree && b.agree.a && b.agree.b && b.agree.c)) return { ok: false, error: '旅行条件への同意が必要です。' };

    // 料金はサーバー側で計算し直す（サイトから送られた金額は使わない）
    const single = t.days > 1 && b.room === 'single';
    const total = t.adult * adults + t.child * children + (single ? t.single * pax : 0) + (t.air ? t.fuel * pax : 0);
    const depDate = new Date(b.date + 'T00:00:00+09:00');
    const due = new Date(depDate.getTime()); due.setDate(due.getDate() - 21);
    const now = new Date(), today = today_();
    const canDeposit = !t.local && due > today;
    const deposit = canDeposit ? depositPP_(t.adult) * adults + depositPP_(t.child) * children : total;
    const useDeposit = b.amount === 'deposit' && canDeposit;
    const payNow = useDeposit ? deposit : total;
    const method = b.method === 'bank' ? '銀行振込' : 'クレジットカード';
    let last = today;
    if (useDeposit) last = due;
    else if (method === '銀行振込') { last = new Date(today.getTime()); last.setDate(last.getDate() + 3); }

    const no = newNo_();
    const depId = t.id + '-' + b.date.replace(/-/g, '');
    const row = [no, now, depId, t.id, t.name, depDate, adults, children,
      t.days > 1 ? (single ? '1名1室' : '2名1室') : '—', t.air ? String(b.origin || '') : '—',
      String(L.sei).trim() + ' ' + String(L.mei).trim(), (String(L.rs) + ' ' + String(L.rm)).toUpperCase(),
      L.birth ? new Date(L.birth + 'T00:00:00+09:00') : '', String(L.tel), String(L.mail),
      L.pp ? new Date(L.pp + 'T00:00:00+09:00') : '',
      total, useDeposit ? '申込金' : '全額', method, payNow, last, '仮予約', 0, '', '', 'サイトから受付'];
    const sh = sheet_(CONFIG.SHEET_BOOKINGS);
    const r = firstEmptyRow_(sh);
    sh.getRange(r, 1, 1, row.length).setValues([row]);
    // 自動計算の列（AA〜AD）。事前入力の範囲を超えた行にも式を入れる
    sh.getRange(r, 27, 1, 4).setFormulasR1C1([[
      '=IF(RC1="","",N(RC7)+N(RC8))',
      '=IF(RC1="","",IF(RC22="キャンセル",0,RC17-N(RC23)))',
      '=IF(RC1="","",IF(RC22="キャンセル","—",IF(N(RC23)<=0,"未入金",IF(RC23<RC17,"一部入金","入金済み"))))',
      '=IF(RC1="","",IF(AND(RC28>0,RC21<>"",RC21<TODAY(),RC22<>"キャンセル"),"期限超過",""))'
    ]]);

    const comps = Array.isArray(b.companions) ? b.companions.slice(0, 8) : [];
    if (comps.length) {
      const tv = sheet_(CONFIG.SHEET_TRAVELERS);
      const rows = comps.map(function (c, i) {
        return [no, i + 1, c.kind === 'child' ? '子供' : '大人', String(c.s || '').toUpperCase(), String(c.m || '').toUpperCase(), c.b ? new Date(c.b + 'T00:00:00+09:00') : ''];
      });
      tv.getRange(tv.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    }
    SpreadsheetApp.flush();

    try { syncDeparture_(depId); } catch (err) { console.error('calendar', err); }
    try { notifyStaff_(no, t, b.date, pax, total, method); } catch (err) { console.error('mail', err); }
    if (CONFIG.SEND_CUSTOMER_MAIL) { try { sendCustomerMail_(L, no, t, b.date, pax, total, payNow, method, last); } catch (err) { console.error('mail', err); } }

    return { ok: true, no: no, total: total, payNow: payNow, balance: total - payNow, due: useDeposit ? ymd_(due) : null, status: '仮予約' };
  } finally {
    lock.releaseLock();
  }
}

function firstEmptyRow_(sh) {
  const n = Math.max(1, sh.getMaxRows() - 1);
  const v = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < v.length; i++) if (v[i][0] === '') return i + 2;
  sh.insertRowsAfter(sh.getMaxRows(), 100);
  return n + 2;
}

function newNo_() {
  const sh = sheet_(CONFIG.SHEET_BOOKINGS);
  const used = {};
  sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), 1).getValues().forEach(function (r) { if (r[0]) used[r[0]] = 1; });
  const head = 'ST' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyMMdd') + '-';
  let no;
  do { no = head + String(1000 + Math.floor(Math.random() * 9000)); } while (used[no]);
  return no;
}

/* ============ メール ============ */
function notifyStaff_(no, t, date, pax, total, method) {
  if (!CONFIG.STAFF_EMAIL) return;
  MailApp.sendEmail(CONFIG.STAFF_EMAIL, '【新規予約】' + no + '　' + t.name + '（' + date + '発・' + pax + '名）',
    'サイトから新しい予約が入りました。\n\n予約番号：' + no + '\nツアー：' + t.name + '\n出発日：' + date + '\n人数：' + pax + '名\n旅行代金：¥' + total.toLocaleString() + '\n支払方法：' + method +
    '\n\n予約状況は「仮予約」です。内容を確認し、入金後に「確定」に変更してください。\n' + SpreadsheetApp.getActiveSpreadsheet().getUrl());
}

function sendCustomerMail_(L, no, t, date, pax, total, payNow, method, last) {
  // 注意：この受付メールは「契約書面」ではありません。契約書面の文面・交付方法は旅行条件書とあわせて確認してください。
  const body = String(L.sei) + ' ' + String(L.mei) + ' 様\n\n' + CONFIG.SITE_NAME + 'をご利用いただき、ありがとうございます。\n以下の内容でお申込みを受け付けました（仮予約）。\n\n' +
    '予約番号：' + no + '\nツアー：' + t.name + '\n出発日：' + date + '\n人数：' + pax + '名\n旅行代金合計：¥' + total.toLocaleString() +
    '\nお支払い方法：' + method + '\n今回のご請求額：¥' + payNow.toLocaleString() + '\nお支払い期限：' + ymd_(last) +
    '\n\n担当者が空席と内容を確認のうえ、お支払いのご案内とご予約確定のご連絡をお送りします。\n\n株式会社サントラベル（観光庁長官登録旅行業 第1791号）\n東京本店営業所 ' + CONFIG.TEL;
  MailApp.sendEmail(String(L.mail), '【' + CONFIG.SITE_NAME + '】お申込みを受け付けました（予約番号 ' + no + '）', body);
}

/* ============ Googleカレンダー連携 ============ */
function calendar_() {
  return CONFIG.CALENDAR_ID ? CalendarApp.getCalendarById(CONFIG.CALENDAR_ID) : CalendarApp.getDefaultCalendar();
}

/** 出発日シートの全行をカレンダーに反映（メニュー・時間トリガー用） */
function syncCalendar() {
  rows_(CONFIG.SHEET_DEPS).forEach(function (d) { if (d['出発日ID']) syncRow_(d); });
}

function syncDeparture_(depId) {
  rows_(CONFIG.SHEET_DEPS).forEach(function (d) { if (d['出発日ID'] === depId) syncRow_(d); });
}

function syncRow_(d) {
  if (!(d['出発日'] instanceof Date)) return;
  const cal = calendar_();
  const tour = rows_(CONFIG.SHEET_TOURS).filter(function (t) { return String(t['ツアーID']) === String(d['ツアーID']); })[0] || {};
  const days = num_(tour['日数']) || 1;
  const start = new Date(d['出発日'].getTime());
  const end = new Date(start.getTime()); end.setDate(end.getDate() + days);
  const title = '【' + (d['催行状況'] || '') + '】' + (d['ツアー名'] || d['ツアーID']) + '　予約' + num_(d['予約人数']) + '名／残' + num_(d['残席']) + '席';
  const bookings = rows_(CONFIG.SHEET_BOOKINGS).filter(function (b) { return b['出発日ID'] === d['出発日ID'] && b['予約状況'] !== 'キャンセル'; });
  const desc = '出発日ID：' + d['出発日ID'] + '\n定員：' + d['定員'] + '名　受付：' + d['受付'] + '\n\n' +
    (bookings.length ? bookings.map(function (b) { return '・' + b['予約番号'] + '　' + b['代表者氏名'] + '　' + num_(b['人数']) + '名　' + b['予約状況'] + '／' + b['入金状況']; }).join('\n') : '予約はまだありません');
  const sh = sheet_(CONFIG.SHEET_DEPS);
  const idCol = 12;
  let ev = d['カレンダー予定ID'] ? safeEvent_(cal, d['カレンダー予定ID']) : null;
  if (ev) {
    ev.setTitle(title); ev.setDescription(desc); ev.setAllDayDates(start, end);
  } else {
    ev = cal.createAllDayEvent(title, start, end, { description: desc });
    sh.getRange(d._row, idCol).setValue(ev.getId());
  }
  const st = d['催行状況'];
  ev.setColor(st === '満席' ? CalendarApp.EventColor.RED : st === '催行決定' ? CalendarApp.EventColor.GREEN : CalendarApp.EventColor.YELLOW);
}

function safeEvent_(cal, id) { try { return cal.getEventById(id); } catch (e) { return null; } }

/* ============ メニュー ============ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('サントラベル')
    .addItem('選択した予約を「入金済み・確定」にする', 'markPaid')
    .addItem('選択した予約をキャンセルにする', 'markCancel')
    .addSeparator()
    .addItem('カレンダーに同期', 'syncCalendar')
    .addItem('毎時の自動同期をオンにする', 'installTrigger')
    .addToUi();
}

function selectedBookingRows_() {
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== CONFIG.SHEET_BOOKINGS) { SpreadsheetApp.getUi().alert('「予約」シートで行を選んでから実行してください。'); return null; }
  const r = sh.getActiveRange();
  const out = [];
  for (let i = r.getRow(); i < r.getRow() + r.getNumRows(); i++) if (i > 1 && sh.getRange(i, 1).getValue()) out.push(i);
  return { sh: sh, rows: out };
}

function markPaid() {
  const s = selectedBookingRows_(); if (!s) return;
  s.rows.forEach(function (i) {
    const total = s.sh.getRange(i, 17).getValue();
    s.sh.getRange(i, 22).setValue('確定');
    s.sh.getRange(i, 23).setValue(total);
    s.sh.getRange(i, 24).setValue(today_());
  });
  SpreadsheetApp.flush();
  s.rows.forEach(function (i) { try { syncDeparture_(s.sh.getRange(i, 3).getValue()); } catch (e) { } });
}

function markCancel() {
  const s = selectedBookingRows_(); if (!s) return;
  const ui = SpreadsheetApp.getUi();
  if (ui.alert(s.rows.length + '件の予約をキャンセルにします。よろしいですか？', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  s.rows.forEach(function (i) { s.sh.getRange(i, 22).setValue('キャンセル'); });
  SpreadsheetApp.flush();
  s.rows.forEach(function (i) { try { syncDeparture_(s.sh.getRange(i, 3).getValue()); } catch (e) { } });
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncCalendar') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncCalendar').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('1時間ごとにカレンダーへ同期します。');
}
