/**
 * サントラベル 予約管理 × 公式サイト 連携スクリプト
 * スプレッドシート「サントラベル予約管理」の［拡張機能］→［Apps Script］に貼り付けて使います。
 *
 *  GET  ?action=tours   … 公開中のツアーと、受付中の出発日・残席を返す（サイトの表示・空席カレンダー用）
 *  GET  ?action=formTours … しおり（SHIORIMakerPro）で「販売中」にしたツアーを返す（海外旅行申込フォーム用）
 *  しおり → スプレッドシート：しおりで「販売中」にしたツアーを「ツアー」「出発日」シートに自動で書き込む（syncShiori）
 *                          「HPにも載せる」にしたものは「公開」、それ以外は「非公開」。HPの予約ボタンは申込フォームを開く
 *  POST {action:'book'} … サイトからの予約を「予約」「同行者」シートに追加し、カレンダーを更新する
 *  POST {action:'entry'}… 海外旅行申込フォーム（サーバーの /form/）。「フォーム受付」「本人確認書類」シートに追加
 *  POST {action:'visa'} … ビザ申請フォーム（サーバーの /form/visa.html）。「ビザ申込」「本人確認書類」シートに追加
 *                          どちらもパスポート等の写真をドライブ「本人確認書類（写真）」フォルダに保存する
 *
 * ⚠️ このコードを書き換えたら：［デプロイ］→［デプロイを管理］→ 鉛筆アイコン →「新バージョン」で更新すること。
 *    ［新しいデプロイ］を作るとURLが変わり、サイト（tours.html の API_URL）とつながらなくなります。
 */
const CONFIG = {
  SHEET_TOURS: 'ツアー',
  SHEET_DEPS: '出発日',
  SHEET_BOOKINGS: '予約',
  SHEET_TRAVELERS: '同行者',
  SHEET_ENTRIES: 'フォーム受付',
  SHEET_VISA: 'ビザ申込',
  // しおり（SHIORIMakerPro）のツアー保存先：ドライブ「Shiorimaker-pro / shiori-data / tours」
  SHIORI_TOURS_FOLDER_ID: '1GfJkCjHlutJvhkwvyZLTPzvL5znLTxkv',
  SHIORI_CACHE_SEC: 300,
  SHIORI_SYNC_SEC: 300,           // しおり → シートの自動取り込みの間隔（秒）。サイトが開かれたときにこの間隔で確認する
  SHIORI_IMG_FOLDER: 'しおり（HP用写真）',   // HPに出す写真の保存先（スプレッドシートと同じフォルダに自動作成・リンクを知っている全員が閲覧可）
  SHIORI_DEFAULT_CAPACITY: 20,    // しおりの人数が読めないときの定員
  FORM_URL: 'https://suntravel.jp/form/',   // 海外旅行申込フォーム（しおりのツアーはHPの予約ボタンでここを開く）          // しおりの一覧を覚えておく秒数（しおりで変更してからフォームに出るまで最大この時間）
  SHEET_IDDOCS: '本人確認書類',
  PHOTO_FOLDER: '本人確認書類（写真）',   // スプレッドシートと同じフォルダに作成（なければ自動作成）
  // 身分証リーダーの保存先（IdReaderSave.gs のウェブアプリ）にも、同じ形式でパスポートを保存する。
  // URL と合言葉はコードに書かず、［プロジェクトの設定］→［スクリプト プロパティ］に
  //   IDREADER_URL（ウェブアプリのURL）・IDREADER_TOKEN（IdReaderSave.gs の TOKEN）を登録すると有効になる（未登録なら送らない）
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
    if (action === 'tours') { syncShioriIfStale_(); return json_({ ok: true, tours: getTours_(), updated: new Date().toISOString() }); }
    if (action === 'formTours') return json_({ ok: true, tours: shioriTours_(e.parameter.fresh === '1') });
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
    if (body.action === 'entry') return json_(entry_(body));
    if (body.action === 'visa') return json_(visa_(body));
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
      dates: dates,
      form: t['しおりID'] ? CONFIG.FORM_URL + '?tour=' + encodeURIComponent(String(t['しおりID'])) : ''
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

/* ============ しおり（SHIORIMakerPro）のツアー → 海外旅行申込フォーム ============ */
/** しおりで「販売中」にチェックし、アーカイブしておらず、出発日が今日以降（または未定）のツアー */
function shioriTours_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) { const hit = cache.get('shioriTours'); if (hit) return JSON.parse(hit); }
  const out = shioriRead_().filter(function (x) { return x.live; }).map(function (x) {
    return { id: x.id, name: x.name, code: x.code, start: x.start, end: x.end, days: x.days, price: x.price };
  });
  out.sort(function (a, b) { return (a.start || '9999') < (b.start || '9999') ? -1 : (a.start || '9999') > (b.start || '9999') ? 1 : a.name < b.name ? -1 : 1; });
  try { cache.put('shioriTours', JSON.stringify(out), CONFIG.SHIORI_CACHE_SEC); } catch (e) {}
  return out;
}

/** しおりのツアーファイルをすべて読む。live＝販売中・アーカイブしていない・出発日が今日以降（または未定） */
function shioriRead_() {
  const today = ymd_(today_());
  const out = [];
  const it = DriveApp.getFolderById(CONFIG.SHIORI_TOURS_FOLDER_ID).getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/\.json$/.test(f.getName())) continue;
    let j;
    try { j = JSON.parse(f.getBlob().getDataAsString('UTF-8')); } catch (e) { continue; }
    if (!j || !j.data || !j.data.meta) continue;
    const m = j.data.meta, c = j.data.cost || {};
    const start = /^\d{4}-\d{2}-\d{2}$/.test(m.start || '') ? m.start : '';
    const days = Array.isArray(j.data.days) ? j.data.days.length : 0;
    let end = /^\d{4}-\d{2}-\d{2}$/.test(m.end || '') ? m.end : '';
    if (!end && start && days) { const d = new Date(start + 'T00:00:00+09:00'); d.setDate(d.getDate() + days - 1); end = ymd_(d); }
    const name = String(m.title || m.footerTitle || '').replace(/\s*\n\s*/g, ' ').trim();
    if (!name) continue;
    const price = num_(String(c.sell || '').replace(/[^\d.]/g, ''));
    const cats = Object.keys(m.hpCats || {}).filter(function (k) { return m.hpCats[k] === true; });
    const cap = num_(String(c.pax || '').replace(/[^\d]/g, '')) || num_((String(m.pax || '').match(/\d+/) || [''])[0]);
    out.push({
      id: String(j.id || f.getName().replace(/\.json$/, '')), name: name, code: String(m.code || ''), start: start, end: end, days: days, price: price,
      live: m.sale === true && !j.archived && (!start || start >= today), hp: m.hp === true,
      sub: String(m.hpSub || m.catch || '').trim(), area: String(m.hpArea || 'other'), cats: cats.length ? cats : ['package'],
      adult: num_(String(m.hpAdult || '').replace(/[^\d.]/g, '')) || price, child: num_(String(m.hpChild || '').replace(/[^\d.]/g, '')),
      inc: String(m.hpInc || '').trim(), exc: String(m.hpExc || '').trim(),
      badges: String(m.hpBadges || '').split(/[、,，]/).map(function (x) { return x.trim(); }).filter(String).join(','),
      img: /^data:image\/(jpeg|png|webp);base64,/.test(String(m.hpImg || '')) ? String(m.hpImg) : '', cap: cap
    });
  }
  return out;
}

/* ============ しおり → スプレッドシート（ツアー・出発日） ============ */
/** サイトが開かれたときに、前回から SHIORI_SYNC_SEC 秒以上たっていれば取り込む */
function syncShioriIfStale_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('shioriSyncAt')) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try { cache.put('shioriSyncAt', '1', CONFIG.SHIORI_SYNC_SEC); syncShiori_(); } catch (e) { console.error(e); } finally { lock.releaseLock(); }
}

/** メニュー［しおりから取り込む］ */
function syncShiori() {
  const r = syncShiori_();
  CacheService.getScriptCache().removeAll(['shioriTours', 'shioriSyncAt']);
  try { SpreadsheetApp.getUi().alert('しおりから取り込みました。\n\n追加：' + r.added + '件　更新：' + r.updated + '件　非公開にした：' + r.hidden + '件\n出発日の追加：' + r.deps + '件'); } catch (e) {}
}

/** しおりで「販売中」のツアーを「ツアー」「出発日」シートに書き込む。
 *  しおりが持っている項目（ツアー名・サブタイトル・エリア・カテゴリ・日数・料金・含まれるもの・バッジ・写真・公開）はしおりの内容で上書き。
 *  1名1室追加・燃油・最少催行人員・評価・定員・受付などはシートで管理（最初に作るときだけ初期値を入れる） */
function syncShiori_() {
  const list = shioriRead_();
  const sh = sheet_(CONFIG.SHEET_TOURS);
  let head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  if (head.indexOf('しおりID') < 0) { sh.getRange(1, head.length + 1).setValue('しおりID'); head.push('しおりID'); }
  const col = function (name) { return head.indexOf(name) + 1; };
  const tours = rows_(CONFIG.SHEET_TOURS);
  const byShiori = {};
  tours.forEach(function (t) { if (t['しおりID']) byShiori[String(t['しおりID'])] = t; });
  const r = { added: 0, updated: 0, hidden: 0, deps: 0 };
  list.forEach(function (x) {
    let row = byShiori[x.id];
    if (!x.live) {
      if (row && row['公開'] !== '非公開') { sh.getRange(row._row, col('公開')).setValue('非公開'); r.hidden++; }
      if (row) closeShioriDeps_(row['ツアーID'], '');
      return;
    }
    const tid = row ? String(row['ツアーID']) : 'sh-' + x.id;
    const v = {
      'ツアーID': tid, 'ツアー名': x.name, '種別': '航空券付き', '日数': x.days || 1, '所要時間': (x.days || 1) + '日間',
      'エリア': x.area, 'カテゴリ': x.cats.join(','), '公開': x.hp ? '公開' : '非公開', 'しおりID': x.id
    };
    if (x.sub) v['サブタイトル'] = x.sub;
    if (x.adult) v['大人料金'] = x.adult;
    if (x.child) v['子供料金'] = x.child;
    if (x.inc) v['含まれるもの'] = x.inc;
    if (x.exc) v['含まれないもの'] = x.exc;
    if (x.badges) v['バッジ'] = x.badges;
    if (x.img) { const url = shioriImage_(x.id, x.img); if (url) v['画像'] = url; }
    if (!row) {
      v['1名1室追加'] = 0; v['燃油・諸税（目安）'] = 0; v['最少催行人員'] = 1; v['評価（見本）'] = 0; v['体験談数（見本）'] = 0;
      v['検索キーワード'] = [x.code, x.name].filter(String).join(' ');
      const n = firstEmptyRow_(sh);
      const vals = head.map(function (h) { return v[h] !== undefined ? v[h] : ''; });
      sh.getRange(n, 1, 1, vals.length).setValues([vals]);
      r.added++;
    } else {
      let changed = false;
      Object.keys(v).forEach(function (h) {
        if (!col(h)) return;
        const cur = row[h];
        if (String(cur) === String(v[h])) return;
        sh.getRange(row._row, col(h)).setValue(v[h]); changed = true;
      });
      if (changed) r.updated++;
    }
    if (x.start) { if (ensureShioriDep_(tid, x.start, x.cap || CONFIG.SHIORI_DEFAULT_CAPACITY)) r.deps++; closeShioriDeps_(tid, x.start); }
  });
  SpreadsheetApp.flush();
  return r;
}

/** 出発日シートに、そのツアーの出発日の行がなければ追加する（計算式は2行目からコピー） */
function ensureShioriDep_(tid, start, cap) {
  const sh = sheet_(CONFIG.SHEET_DEPS);
  const hit = rows_(CONFIG.SHEET_DEPS).filter(function (d) { return String(d['ツアーID']) === tid && d['出発日'] instanceof Date && ymd_(d['出発日']) === start; })[0];
  if (hit) { if (hit['受付'] === '停止') sh.getRange(hit._row, 4).setValue('受付中'); return false; }   // 定員はシートで管理。受付はしおりの「販売中」に合わせる
  const n = firstEmptyRow_(sh);
  sh.getRange(n, 1, 1, 4).setValues([[tid, new Date(start + 'T00:00:00+09:00'), cap, '受付中']]);
  if (n > 2) sh.getRange(2, 5, 1, 7).copyTo(sh.getRange(n, 5, 1, 7));   // ツアー名〜未収額の計算式
  return true;
}

/** しおりの出発日が変わった・販売をやめたとき：予約のない古い出発日の受付を「停止」にする */
function closeShioriDeps_(tid, keepStart) {
  const sh = sheet_(CONFIG.SHEET_DEPS);
  rows_(CONFIG.SHEET_DEPS).forEach(function (d) {
    if (String(d['ツアーID']) !== String(tid) || !(d['出発日'] instanceof Date)) return;
    if (keepStart && ymd_(d['出発日']) === keepStart) return;
    if (d['受付'] === '受付中' && !num_(d['予約人数'])) sh.getRange(d._row, 4).setValue('停止');
  });
}

/** HPに出す写真をドライブに保存して、表示用のURLを返す（同じ写真なら保存し直さない） */
function shioriImage_(id, dataUrl) {
  try {
    const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    if (!m) return '';
    const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, m[2]));
    const folder = shioriImgFolder_();
    const name = id + (m[1] === 'image/png' ? '.png' : '.jpg');
    const it = folder.getFilesByName(name);
    let f = it.hasNext() ? it.next() : null;
    if (f && f.getDescription() === hash) return 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w1200';
    if (f) f.setTrashed(true);
    f = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name));
    f.setDescription(hash);
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w1200';
  } catch (e) { console.error(e); return ''; }
}

function shioriImgFolder_() {
  const file = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  const parents = file.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const it = parent.getFoldersByName(CONFIG.SHIORI_IMG_FOLDER);
  return it.hasNext() ? it.next() : parent.createFolder(CONFIG.SHIORI_IMG_FOLDER);
}

/* ============ フォーム共通（サーバーの /form/ と /form/visa.html） ============ */
function upper_(v) { return String(v || '').toUpperCase().trim(); }
function dateOf_(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? new Date(v + 'T00:00:00+09:00') : ''; }

/** 共通の入力チェック。問題があればエラーメッセージ、なければ '' */
function checkForm_(b, needLead) {
  const L = b.lead || {};
  for (let i = 0; i < needLead.length; i++) if (!String(L[needLead[i]] || '').trim()) return '代表者情報に未入力の項目があります。';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(L.mail || ''))) return 'メールアドレスを正しく入力してください。';
  const tv = Array.isArray(b.travelers) ? b.travelers : [];
  if (!tv.length || tv.length > 9) return '参加者の情報がありません。';
  for (let i = 0; i < tv.length; i++) {
    const imgs = [tv[i].image].concat(Object.keys(tv[i].extraImages || {}).map(function (k) { return tv[i].extraImages[k]; }));
    for (let j = 0; j < imgs.length; j++) {
      const img = String(imgs[j] || '');
      if (img && (!/^data:image\/(jpeg|png);base64,/.test(img) || img.length > 6 * 1024 * 1024)) return '写真の形式が正しくありません。撮り直してお試しください。';
    }
    const f = tv[i].fields || {};
    if (!upper_(f.surname) || !upper_(f.givenNames) || !dateOf_(f.birthDate)) return '参加者の氏名・生年月日に未入力の項目があります。';
  }
  if (!b.agree) return '個人情報の取り扱いへの同意が必要です。';
  return '';
}

/** 写真をドライブに保存し、URLを返す（共有設定はフォルダを引き継ぐ＝担当者のみ） */
function savePhoto_(dataUrl, name) {
  const m = String(dataUrl || '').match(/^data:(image\/(jpeg|png));base64,(.*)$/);
  if (!m) return '';
  const blob = Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], name + (m[2] === 'png' ? '.png' : '.jpg'));
  return photoFolder_().createFile(blob).getUrl();
}

/** 「本人確認書類」シートに1人1行で追加。写真のURLは「写真」列、追加の写真はメモ列へ */
function addIdDocs_(key, no, leadName, tv, memoOf) {
  const now = new Date();
  const XN = { zairyuFront: '在留カード表', zairyuBack: '在留カード裏', photo: '証明写真' };
  const rows = tv.map(function (t, i) {
    const f = t.fields || {}, have = t.passport !== 'applying';
    const base = key + '_' + (i + 1) + '_' + upper_(f.surname).replace(/[^A-Z]/g, '');
    const url = have && t.image ? savePhoto_(t.image, base) : '';
    const ex = Object.keys(t.extraImages || {}).map(function (k) { const u = savePhoto_(t.extraImages[k], base + '_' + k); return u ? (XN[k] || k) + '：' + u : ''; }).filter(String);
    const fw = have ? forwardToIdReader_(t, key + '　' + memoOf(t, i).split('\n')[0]) : '';
    const memo = [memoOf(t, i), have ? '' : 'パスポート申請中・更新中' + (f.pickup ? '（発行・受取予定 ' + f.pickup + '）' : '')].concat(ex, [fw]).filter(String).join('\n');
    return [now, key, have ? 'パスポート' : 'パスポート（申請中）', have ? String(t.verdict || '手入力') : '申請中', t.edited ? 'あり' : '',
      upper_(f.surname), upper_(f.givenNames), i === 0 ? leadName : '', dateOf_(f.birthDate), upper_(f.sex), upper_(f.nationality),
      have ? upper_(f.documentNumber) : '', '', have ? dateOf_(f.expiryDate) : '', '', '', url, '', memo];
  });
  const ds = sheet_(CONFIG.SHEET_IDDOCS);
  ds.getRange(ds.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/** 身分証リーダーの保存先（免許証一覧「パスポート」シート・処理済みフォルダ）へ送る。合言葉はサーバー側だけで使う */
function forwardToIdReader_(t, memo) {
  const pr = PropertiesService.getScriptProperties();
  const url = pr.getProperty('IDREADER_URL'), token = pr.getProperty('IDREADER_TOKEN');
  if (!url || !token || t.passport === 'applying') return '';
  const f = t.fields || {}, m = String(t.image || '').match(/^data:(image\/(?:jpeg|png));base64,(.*)$/);
  const body = { token: token, action: 'save',
    record: { docKind: 'passport', surname: upper_(f.surname), givenNames: upper_(f.givenNames), sex: upper_(f.sex), nationality: upper_(f.nationality),
      passportNo: upper_(f.documentNumber), birthDate: String(f.birthDate || ''), expiryDate: String(f.expiryDate || ''),
      reasons: String(t.verdict || '') === 'OK' ? '' : '要確認', verdict: String(t.verdict || '手入力'), edited: !!t.edited, memo: memo },
    image: m ? { data: m[2], mimeType: m[1] } : null };
  try {
    const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: JSON.stringify(body), muteHttpExceptions: true, followRedirects: true });
    const j = JSON.parse(res.getContentText());
    return j.ok ? '身分証リーダー保存先：' + j.sheet + ' ' + j.row + '行目' : '身分証リーダー保存先エラー：' + j.error;
  } catch (e) { console.error('idreader', e); return '身分証リーダー保存先に送れませんでした'; }
}

function travelerList_(tv) {
  return tv.map(function (t, i) {
    const f = t.fields || {};
    return (i + 1) + '. ' + upper_(f.surname) + ' ' + upper_(f.givenNames) + '（' + (f.birthDate || '') + '）' + (t.passport === 'applying' ? ' 申請中' : '');
  }).join('\n');
}

function sheetWithHead_(name, head, setup) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#E3EFEA');
    sh.setFrozenRows(1);
    if (setup) setup(sh);
  }
  return sh;
}

function photoFolder_() {
  if (photoFolder_.cache) return photoFolder_.cache;
  const file = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  const parents = file.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const it = parent.getFoldersByName(CONFIG.PHOTO_FOLDER);
  return (photoFolder_.cache = it.hasNext() ? it.next() : parent.createFolder(CONFIG.PHOTO_FOLDER));
}

function newFormNo_(prefix, sheetName) {
  const used = {};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { used[r[0]] = 1; });
  const head = prefix + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyMMdd') + '-';
  let no;
  do { no = head + String(1000 + Math.floor(Math.random() * 9000)); } while (used[no]);
  return no;
}

function passportCount_(tv) {
  const c = { ok: 0, review: 0, applying: 0 };
  tv.forEach(function (t) { if (t.passport === 'applying') c.applying++; else if (t.verdict === 'OK') c.ok++; else c.review++; });
  return c;
}

/* ============ 海外旅行申込フォーム（サーバーの /form/） ============ */
const ENTRY_HEAD = ['受付番号', '受付日時', '予約番号', 'ツアーID', 'ツアー・ご旅行内容', '出発日', '帰国日', '大人', '子供', 'サロン会員',
  '代表者氏名', 'ローマ字', '生年月日', '電話', 'メール', '郵便番号', '住所', '緊急連絡先氏名', '続柄', '緊急連絡先電話',
  '海外旅行保険', '食物アレルギー', 'アレルギーの内容', '無料両替', '両替額（万円）', 'その他連絡事項',
  '参加者（ローマ字・生年月日）', 'パスポート申請中', '対応状況', '担当者', 'メモ'];
const STATUS_LIST = ['未対応', '対応中', '予約登録済み', '完了', '対象外'];

/** 見出し名に合わせて1行追加する（見出しが足りなければ右端に足す。列の並べ替えにも強い） */
function appendByHead_(sh, obj) {
  const lastCol = Math.max(1, sh.getLastColumn());
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  Object.keys(obj).forEach(function (k) { if (head.indexOf(k) < 0) { head.push(k); sh.getRange(1, head.length).setValue(k).setFontWeight('bold').setBackground('#E3EFEA'); } });
  sh.appendRow(head.map(function (h) { return h in obj ? obj[h] : ''; }));
}

function entry_(b) {
  if (b.company) return { ok: true, no: 'SF000000-0000' };   // ボット対策（人には見えない欄に入力があれば保存しない）
  const err = checkForm_(b, ['sei', 'mei', 'rs', 'rm', 'tel', 'mail']);
  if (err) return { ok: false, error: err };
  if (!String(b.tourName || '').trim() || !dateOf_(b.date) || !dateOf_(b.retDate)) return { ok: false, error: 'ツアーと出発日・帰国日をご入力ください。' };
  const E = b.emergency || {};
  if (!String(E.name || '').trim()) return { ok: false, error: '緊急連絡先の氏名をご入力ください。' };
  if (['加入する', '加入しない'].indexOf(b.insurance) < 0) return { ok: false, error: '海外旅行保険に加入されるかどうかを選択してください。' };
  const L = b.lead, tv = b.travelers;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: '混み合っています。少し時間をおいてもう一度お試しください。' };
  try {
    const no = newFormNo_('SF', CONFIG.SHEET_ENTRIES);
    const bookingNo = /^ST\d{6}-\d{4}$/.test(String(b.bookingNo || '')) ? String(b.bookingNo) : '';
    const leadName = String(L.sei).trim() + ' ' + String(L.mei).trim();
    addIdDocs_(bookingNo || no, no, leadName, tv, function (t, i) {
      return (i === 0 ? '代表者' : '参加者' + (i + 1)) + '（' + (t.kind === 'child' ? '子供' : '大人') + '）' + (bookingNo ? '' : '　受付番号 ' + no);
    });
    const applying = passportCount_(tv).applying;
    const es = sheetWithHead_(CONFIG.SHEET_ENTRIES, ENTRY_HEAD, function (sh) {
      sh.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
      ['F:F', 'G:G', 'M:M'].forEach(function (r) { sh.getRange(r).setNumberFormat('yyyy/mm/dd'); });
      sh.getRange('AC2:AC').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUS_LIST, true).build());
    });
    appendByHead_(es, {
      '受付番号': no, '受付日時': new Date(), '予約番号': bookingNo, 'ツアーID': String(b.tourId || ''), 'ツアー・ご旅行内容': String(b.tourName),
      '出発日': dateOf_(b.date), '帰国日': dateOf_(b.retDate), '大人': Math.floor(num_(b.adults)), '子供': Math.floor(num_(b.children)), 'サロン会員': String(b.salon || ''),
      '代表者氏名': leadName, 'ローマ字': upper_(L.rs) + ' ' + upper_(L.rm), '生年月日': dateOf_(L.birth), '電話': "'" + String(L.tel), 'メール': String(L.mail),
      '郵便番号': L.zip ? "'" + String(L.zip) : '', '住所': String(L.addr || ''),
      '緊急連絡先氏名': String(E.name), '続柄': String(E.relation || ''), '緊急連絡先電話': E.tel ? "'" + String(E.tel) : '',
      '海外旅行保険': String(b.insurance), '食物アレルギー': String(b.allergy || ''), 'アレルギーの内容': String(b.allergyDetail || ''),
      '無料両替': b.exchange ? '申請する' : '', '両替額（万円）': b.exchange ? num_(b.exchangeAmount) : '', 'その他連絡事項': String(b.request || ''),
      '参加者（ローマ字・生年月日）': travelerList_(tv), 'パスポート申請中': applying ? applying + '名' : '', '対応状況': '未対応',
      'ツアーコード': String(b.tourCode || '')
    });
    SpreadsheetApp.flush();
    try {
      notifyForm_('【海外旅行申込フォーム】' + no + '　' + b.tourName + '（' + b.date + '発・' + tv.length + '名）',
        '受付番号：' + no + (bookingNo ? '\n予約番号：' + bookingNo : '') + '\nツアー：' + b.tourName + '\n出発日：' + b.date + '　帰国日：' + b.retDate +
        '\n海外旅行保険：' + b.insurance + (b.exchange ? '\n無料両替：' + b.exchangeAmount + '万円' : '') + (b.allergy === 'あり' ? '\n食物アレルギー：' + b.allergyDetail : ''),
        L, tv, '「フォーム受付」「本人確認書類」');
    } catch (e2) { console.error('mail', e2); }
    return { ok: true, no: no };
  } finally {
    lock.releaseLock();
  }
}

/* ============ ビザ申請フォーム（サーバーの /form/visa.html） ============ */
const VISA_HEAD = ['受付番号', '受付日時', 'ビザ種類', 'ビザ名', '人数', 'お住まい', '管轄', '渡航予定日', '帰国予定日', '渡航目的', '公演・招へい先', '申請先公館',
  '面接場所', '米国ビザ・ESTA歴', '便名', '滞在先', '滞在先住所', 'お持ち込み先', '記入代行', '緊急申請', '代行手数料（目安）',
  '代表者氏名', 'ローマ字', '生年月日', '性別', '電話', 'メール', '郵便番号', '住所', '連絡方法', '申請者（ローマ字・生年月日）', 'パスポート申請中', 'ご質問',
  '対応状況', '担当者', '申請日', '受取予定日', 'メモ'];
const VISA_STATUS = ['未対応', '書類案内済み', '書類受領', '申請済み', '発給済み', '返却済み', '不許可', 'キャンセル'];

function visa_(b) {
  if (b.company) return { ok: true, no: 'VS000000-0000' };
  const err = checkForm_(b, ['sei', 'mei', 'rs', 'rm', 'birth', 'tel', 'mail', 'zip', 'addr']);
  if (err) return { ok: false, error: err };
  if (!String(b.visaId || '').trim() || !dateOf_(b.dep)) return { ok: false, error: 'ビザの種類と渡航予定日を選択してください。' };
  const L = b.lead, tv = b.travelers;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: '混み合っています。少し時間をおいてもう一度お試しください。' };
  try {
    const no = newFormNo_('VS', CONFIG.SHEET_VISA);
    const leadName = String(L.sei).trim() + ' ' + String(L.mei).trim();
    addIdDocs_(no, no, leadName, tv, function (t, i) {
      const x = t.extra || {};
      return 'ビザ ' + b.visaId + '　' + (i === 0 ? '代表者' : '申請者' + (i + 1)) +
        (x.job ? '　' + x.job + (x.org ? '（' + x.org + '）' : '') : '') + (x.status ? '\n在留資格 ' + x.status + (x.statusExp ? '（' + x.statusExp + 'まで）' : '') : '');
    });
    const sh = sheetWithHead_(CONFIG.SHEET_VISA, VISA_HEAD, function (s) {
      s.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
      ['H:H', 'I:I', 'X:X', 'AJ:AJ', 'AK:AK'].forEach(function (r) { s.getRange(r).setNumberFormat('yyyy/mm/dd'); });
      s.getRange('U:U').setNumberFormat('¥#,##0');
      s.getRange('AH2:AH').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(VISA_STATUS, true).build());
    });
    const applying = passportCount_(tv).applying;
    sh.appendRow([no, new Date(), String(b.visaId), String(b.visaName || ''), tv.length, String(b.pref || ''), String(b.jurisdiction || ''),
      dateOf_(b.dep), dateOf_(b.ret), String(b.purpose || ''), String(b.c4name || ''), String(b.c4office || ''),
      String(b.usPlace || ''), String(b.usHist || ''), String(b.flight || ''), String(b.hotel || ''), String(b.hotelAddr || ''), String(b.office || ''),
      b.optFill ? 'あり' : '', b.optRush ? 'あり' : '', b.feeEstimate === '' || b.feeEstimate == null ? 'ご相談' : num_(b.feeEstimate),
      leadName, upper_(L.rs) + ' ' + upper_(L.rm), dateOf_(L.birth), { F: '女性', M: '男性' }[L.sex] || '—', "'" + String(L.tel), String(L.mail),
      "'" + String(L.zip), String(L.addr), String(L.contact || ''), travelerList_(tv), applying ? applying + '名' : '', String(b.request || ''),
      '未対応', '', '', '', '']);
    SpreadsheetApp.flush();
    try {
      notifyForm_('【ビザ申請フォーム】' + no + '　' + b.visaId + '（' + b.dep + '渡航・' + tv.length + '名）',
        '受付番号：' + no + '\nビザ：' + b.visaName + '\n渡航予定日：' + b.dep + '\nお住まい：' + b.pref + (b.jurisdiction ? '（' + b.jurisdiction + '管轄）' : ''), L, tv, '「ビザ申込」「本人確認書類」');
    } catch (e2) { console.error('mail', e2); }
    return { ok: true, no: no };
  } finally {
    lock.releaseLock();
  }
}

function notifyForm_(subject, head, L, tv, sheets) {
  if (!CONFIG.STAFF_EMAIL) return;
  const c = passportCount_(tv);
  MailApp.sendEmail(CONFIG.STAFF_EMAIL, subject,
    'フォームから送信がありました。\n\n' + head + '\n代表者：' + L.sei + ' ' + L.mei + '（' + L.tel + '）\n人数：' + tv.length + '名' +
    '\nパスポート：自動確認OK ' + c.ok + '名／要確認 ' + c.review + '名／申請中 ' + c.applying + '名' +
    '\n\n' + sheets + 'シートを確認してください。\n' + SpreadsheetApp.getActiveSpreadsheet().getUrl());
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
    .addItem('しおりから取り込む（ツアー・出発日）', 'syncShiori')
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
