/* パスポート入力欄（参加者・申請者ごと）。ツアー予約フォーム・ビザ申請フォームで共通
 *  ・パスポートをお持ちの方 … 写真を選ぶと idreader（身分証リーダーと同じエンジン）で読み取り、項目を自動入力
 *  ・申請中・更新中の方       … ローマ字氏名・生年月日・性別・国籍を手入力
 *
 *  var pp = PPForm.create({
 *    box: 要素, title(i), tag(i),
 *    extraHtml(i)   … 人ごとの追加項目（data-x="キー" の入力欄、data-ximg="キー" の写真欄）
 *    onLeadRead(f)  … 1人目の読み取り結果（代表者欄への反映用）
 *    onChange(i, q) … 入力が変わったとき（国籍で表示を切り替える等）
 *    applyingNote   … 申請中を選んだときの注意書き
 *  });
 *  pp.sync(人数) / pp.validate({returnDate}) / pp.data() / pp.confirmHtml() / pp.warm() / pp.seed(0, {surname,…})
 */
(function (root) {
  'use strict';
  var FIELDS = [['surname', '姓（ローマ字）', 'YAMADA'], ['givenNames', '名（ローマ字）', 'HANAKO'], ['documentNumber', '旅券番号', 'TK1234567'],
    ['nationality', '国籍', 'JPN'], ['birthDate', '生年月日', ''], ['sex', '性別', ''], ['expiryDate', '有効期限', '']];
  var MANUAL = ['surname', 'givenNames', 'birthDate', 'sex', 'nationality'];
  var NATS = [['JPN', '日本'], ['KOR', '韓国'], ['CHN', '中国'], ['TWN', '台湾'], ['PHL', 'フィリピン'], ['VNM', 'ベトナム'], ['NPL', 'ネパール'], ['IDN', 'インドネシア'],
    ['THA', 'タイ'], ['MMR', 'ミャンマー'], ['LKA', 'スリランカ'], ['BGD', 'バングラデシュ'], ['IND', 'インド'], ['MNG', 'モンゴル'], ['USA', 'アメリカ'], ['BRA', 'ブラジル'], ['PER', 'ペルー'], ['OTHER', 'その他']];
  var ROMA = /^[A-Za-z][A-Za-z \-]*$/;
  var LABEL = {}; FIELDS.forEach(function (f) { LABEL[f[0]] = f[1]; });

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(s) { if (!s) return ''; var d = new Date(s + 'T00:00:00'); if (isNaN(d)) return esc(s); return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
  function natName(c) { for (var i = 0; i < NATS.length; i++) if (NATS[i][0] === c) return NATS[i][1]; return c || ''; }

  function toCanvas(file) {
    return new Promise(function (ok, ng) {
      var done = function (img) {
        var s = Math.min(1, 3600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); ok(c);
      };
      var viaImg = function () {
        var u = URL.createObjectURL(file), im = new Image();
        im.onload = function () { done(im); URL.revokeObjectURL(u); };
        im.onerror = function () { ng(new Error('画像を開けませんでした。JPEGかPNGの写真でお試しください。')); };
        im.src = u;
      };
      if (root.createImageBitmap) createImageBitmap(file, { imageOrientation: 'from-image' }).then(done, viaImg); else viaImg();
    });
  }
  function toJpeg(c, max) { // 送信用に縮小
    var s = Math.min(1, (max || 1800) / Math.max(c.width, c.height)), o = document.createElement('canvas');
    o.width = Math.round(c.width * s); o.height = Math.round(c.height * s); o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
    return o.toDataURL('image/jpeg', 0.85);
  }
  function rotate(c) { var o = document.createElement('canvas'); o.width = c.height; o.height = c.width; var x = o.getContext('2d'); x.translate(o.width, 0); x.rotate(Math.PI / 2); x.drawImage(c, 0, 0); return o; }

  // 小さい写真（SNSで送られた画像など）は、MRZの文字が数ピクセルしかなく読めないため拡大してから読む
  function scaled(c, minLong) {
    var L = Math.max(c.width, c.height); if (L >= minLong) return c;
    var s = minLong / L, o = document.createElement('canvas'); o.width = Math.round(c.width * s); o.height = Math.round(c.height * s);
    var x = o.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, o.width, o.height); return o;
  }
  function fit(c, longSide) { // 長辺を longSide に合わせる（拡大・縮小）
    var s = longSide / Math.max(c.width, c.height); if (Math.abs(s - 1) < 0.05) return c;
    var o = document.createElement('canvas'); o.width = Math.round(c.width * s); o.height = Math.round(c.height * s);
    var x = o.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, o.width, o.height); return o;
  }

  /* ---------- 券面の印字（VIZ）からの読み取り：MRZが読めない・検証できないときの予備 ---------- */
  var MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  var NATWORD = [[/JAPAN/, 'JPN'], [/KOREA/, 'KOR'], [/PHILIPPIN|PILIPINAS|FILIPINO/, 'PHL'], [/CHINA|CHINESE/, 'CHN'], [/DEUTSCH|GERMAN/, 'DEU'], [/VIET/, 'VNM'],
    [/TAIWAN/, 'TWN'], [/NEPAL/, 'NPL'], [/INDONESIA/, 'IDN'], [/THAI/, 'THA'], [/MONGOLIA/, 'MNG'], [/UNITED STATES|AMERICA/, 'USA'], [/BRAZIL|BRASIL/, 'BRA']];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function datesIn(s) {
    var out = [], m, U = s.toUpperCase(), re1 = /(\d{1,2})\s*([A-Z]{3})[A-Z]*\s*\/?\s*(?:[A-Z]{3,}\s*)?((?:19|20)\d{2})/g, re2 = /\b(\d{2})[.\/\- ](\d{2})[.\/\- ]((?:19|20)\d{2})\b/g;
    while ((m = re1.exec(U))) if (MON[m[2]] && +m[1] >= 1 && +m[1] <= 31) out.push({ i: m.index, v: m[3] + '-' + pad(MON[m[2]]) + '-' + pad(+m[1]) });
    while ((m = re2.exec(U))) if (+m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) out.push({ i: m.index, v: m[3] + '-' + m[2] + '-' + m[1] });
    return out.sort(function (a, b) { return a.i - b.i; }).map(function (d) { return d.v; });
  }
  function nameTok(s) { // 「O SMITH」「@ | JOHN」のような前後のゴミを除いて、英字の名前だけにする
    var t = String(s || '').toUpperCase().replace(/[^A-Z \-]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 2; });
    return t.join(' ');
  }
  function parseViz(text) {
    var lines = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(String), f = {}, i, j;
    var low = lines.map(function (l) { return l.toLowerCase(); });
    function after(re, k, test) { // ラベルの行（同じ行の後ろ→次の k 行）から値を探す
      for (i = 0; i < low.length; i++) if (re.test(low[i])) {
        var rest = lines[i].replace(new RegExp('^.*?(' + re.source + ')[^A-Za-z0-9]*', 'i'), '');
        var cand = [rest].concat(lines.slice(i + 1, i + 1 + k));
        for (j = 0; j < cand.length; j++) { var v = test(cand[j]); if (v) return v; }
      }
      return '';
    }
    // MRZの1行目（P<国コード 姓<<名）は2行目が読めなくても氏名の手がかりになる
    for (i = 0; i < lines.length; i++) {
      var z = lines[i].replace(/\s/g, '').toUpperCase().replace(/[«‹]/g, '<');
      var m = z.match(/^P[A-Z<]([A-Z<]{3})([A-Z]+(?:<[A-Z]+)*)<<([A-Z]+(?:<[A-Z]+)*)/);
      if (m && z.indexOf('<') > 0) { f.issuingCountry = m[1].replace(/</g, ''); f.surname = m[2].replace(/</g, ' '); f.givenNames = m[3].replace(/</g, ' '); f.mrz1 = true; break; }
    }
    var isLabel = function (s) { return /surname|given|name|birth|sex|nation|expir|issue|passport|type|code|authority|date/i.test(s); };
    if (!f.surname) f.surname = after(/surname|nom\b|姓/, 2, function (s) { return isLabel(s) ? '' : nameTok(s); });
    if (!f.givenNames) f.givenNames = after(/given names?|prénoms|vornamen|名/, 2, function (s) { return isLabel(s) ? '' : nameTok(s); });
    f.birthDate = after(/date of birth|birth date|geburtstag|生年月日/, 2, function (s) { return datesIn(s)[0] || ''; });
    f.expiryDate = after(/date of expiry|expiry|expiration|gültig|有効期間満了/, 2, function (s) { return datesIn(s)[0] || ''; });
    var all = datesIn(lines.join('\n')).sort();
    if (!f.birthDate && all.length) f.birthDate = all[0];
    if (!f.expiryDate && all.length > 1) f.expiryDate = all[all.length - 1];
    var docRe = /\b([A-Z]{1,2}[0-9]{6,8}[A-Z0-9]{0,2})\b/;
    f.documentNumber = after(/passport no|passport number|pass-nr|旅券番号/, 2, function (s) { var mm = s.toUpperCase().replace(/[^A-Z0-9 ]/g, '').match(docRe); return mm ? mm[1] : ''; });
    if (!f.documentNumber) for (i = 0; i < lines.length && !f.documentNumber; i++) { if (/<</.test(lines[i])) continue; var mm2 = lines[i].toUpperCase().replace(/[^A-Z0-9 ]/g, '').match(docRe); if (mm2) f.documentNumber = mm2[1]; }
    f.sex = after(/\bsex\b|geschlecht|性別/, 2, function (s) { var mm = s.match(/(^|[^A-Za-z])([MFmf])([^A-Za-z]|$)/); return mm ? mm[2].toUpperCase() : ''; });
    var nat = f.issuingCountry || after(/country code|code du pays|kode/, 2, function (s) { var mm = s.toUpperCase().match(/\b([A-Z]{3})\b/); return mm ? mm[1] : ''; });
    if (!nat) { var U2 = lines.join(' ').toUpperCase(); for (i = 0; i < NATWORD.length; i++) if (NATWORD[i][0].test(U2)) { nat = NATWORD[i][1]; break; } }
    f.nationality = nat === 'D' ? 'DEU' : nat || '';
    return f;
  }
  function readViz(c) {
    var U = root.IdReader && IdReader._util; if (!U) return Promise.reject(new Error('no ocr'));
    var img = fit(c, 1600), P3 = { tessedit_pageseg_mode: '3', tessedit_char_whitelist: '', preserve_interword_spaces: '0' }, P11 = { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '', preserve_interword_spaces: '0' };
    return U.ocr('eng', 0, img, P3, false, 20000).then(function (d) {
      var f = parseViz(d.text);
      var missing = ['surname', 'givenNames', 'documentNumber', 'birthDate', 'expiryDate', 'sex'].some(function (k) { return !f[k]; });
      if (!missing) return f;
      return U.ocr('eng', 0, img, P11, false, 20000).then(function (d2) { var g = parseViz(d2.text); Object.keys(g).forEach(function (k) { if (!f[k]) f[k] = g[k]; }); return f; }, function () { return f; });
    });
  }

  // 読み取りは1件ずつ順番に（端末の負荷を抑える）
  var queue = Promise.resolve();

  /** パスポート1枚を読む。1) MRZ（小さい写真は拡大して、2つの大きさで試す） 2) だめなら券面の印字（VIZ）
   *  戻り値は IdReader と同じ形の結果に via: 'mrz' | 'viz' を付けたもの */
  function readPassport(src, onStatus, onUpdate) {
    var L = Math.max(src.width, src.height), sizes = L < 1200 ? [1200, 1600] : [0];
    var tryAt = function (k) {
      var c = sizes[k] ? fit(src, sizes[k]) : src;
      return IdReader.read('passport', c, { onStatus: onStatus, onUpdate: onUpdate }).then(function (r) { r.via = 'mrz'; return r; }, function (e) {
        if (k + 1 < sizes.length) return tryAt(k + 1);
        throw e;
      });
    };
    return tryAt(0).catch(function (e) {
      onStatus('下部2行を読み取れないため、券面の印字から読み取っています…');
      return readViz(src).then(function (f) {
        var got = ['surname', 'givenNames', 'documentNumber', 'birthDate', 'expiryDate'].filter(function (k) { return f[k]; }).length;
        if (got < 2) throw e;
        var today = new Date(); today.setHours(0, 0, 0, 0);
        var r = { via: 'viz', fields: { surname: f.surname || '', givenNames: f.givenNames || '', documentNumber: f.documentNumber || '', nationality: f.nationality || '',
          birthDate: f.birthDate || '', sex: f.sex || '', expiryDate: f.expiryDate || '', issuingCountry: f.issuingCountry || '' }, checks: {}, viz: { status: 'viz' } };
        r.expired = !!f.expiryDate && new Date(f.expiryDate + 'T00:00:00') < today;
        r.verdict = { level: 'review', reasons: [{ level: 'review', text: '下部2行（MRZ）を読み取れなかったため、券面の印字から読み取りました。チェックディジットで検証できないので、すべての項目をパスポートと見比べてください。' }] };
        return r;
      });
    });
  }

  function create(o) {
    var box = o.box, P = [];
    o.title = o.title || function (i) { return i === 0 ? '代表者' : '参加者 ' + (i + 1); };
    o.tag = o.tag || function () { return ''; };
    o.onChange = o.onChange || function () {};

    function card(i) { return box.children[i]; }
    function input(i, k) { return card(i).querySelector('[data-pf="' + k + '"]'); }

    function build(i) {
      var q = P[i], el = document.createElement('div'); el.className = 'pax';
      var nm = 'pps' + i + '_' + Math.random().toString(36).slice(2, 7);
      var h = '<div class="pax-h"><h3></h3><span class="tag"></span></div>'
        + '<div class="choice" role="radiogroup" aria-label="パスポートの状況">'
        + '<label><input type="radio" name="' + nm + '" value="have" checked><span><b>パスポートを持っている</b><small>写真を選ぶと自動で入力します</small></span></label>'
        + '<label><input type="radio" name="' + nm + '" value="applying"><span><b>申請中・更新中</b><small>氏名などを手入力します</small></span></label></div>'
        + '<div class="pp-have"><label class="drop"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg>'
        + '<div><b>パスポートを撮影・選択</b><span>顔写真のページ全体を、明るい場所で。下部2行（「&lt;」の並ぶ部分）まで写してください</span></div><input type="file" accept="image/*"></label>'
        + '<div class="shot"><img alt="選択したパスポートの写真"><div class="st"><div class="msg"></div><div class="bar" hidden><i></i></div><div class="shot-btns"><label class="btn s chg">写真を変更する<input type="file" accept="image/*"></label><button type="button" class="btn s rot">↻ 回転して読み直す</button><button type="button" class="btn s del">写真を削除</button></div></div></div>'
        + '<div class="vd"></div></div>'
        + '<p class="manual-note pp-applying" hidden>' + esc(o.applyingNote || 'パスポート申請書に書いたローマ字（ヘボン式）と同じ表記で入力してください。旅券番号・有効期限は、受け取り後にお知らせください。') + '</p>'
        + '<div class="grid pp-fields" hidden>';
      FIELDS.forEach(function (f) {
        var k = f[0], ctl;
        if (k === 'sex') ctl = '<select data-pf="sex"><option value="">選択</option><option value="F">女性（F）</option><option value="M">男性（M）</option><option value="X">指定なし（X）</option></select>';
        else if (/Date$/.test(k)) ctl = '<input type="date" data-pf="' + k + '">';
        else ctl = '<input data-pf="' + k + '" autocapitalize="characters" autocomplete="off" placeholder="' + f[2] + '">';
        h += '<label class="fld" data-row="' + k + '"><span>' + f[1] + ' <i class="req">必須</i><em class="mk" data-mk="' + k + '"></em></span>' + ctl + '</label>';
      });
      h += '<label class="fld" data-row="nationalitySel" hidden><span>国籍 <i class="req">必須</i></span><select data-pf="nationalitySel">'
        + NATS.map(function (n) { return '<option value="' + n[0] + '">' + n[1] + '</option>'; }).join('') + '</select></label>'
        + '<label class="fld" data-row="natOther" hidden><span>国籍（その他） <i class="req">必須</i></span><input data-pf="natOther" placeholder="例：フランス"></label>'
        + '<label class="fld" data-row="pickup" hidden><span>' + esc(o.pickupLabel || 'パスポート受取予定日') + ' ' + (o.pickupRequired ? '<i class="req">必須</i>' : '<i class="opt">任意</i>') + '</span><input type="date" data-pf="pickup"></label>'
        + '</div>' + (o.extraHtml ? '<div class="pp-extra">' + o.extraHtml(i) + '</div>' : '');
      el.innerHTML = h;

      el.querySelectorAll('.choice input').forEach(function (r) { r.addEventListener('change', function () { if (r.checked) { q.status = r.value; mode(i); o.onChange(i, q); } }); });
      var file = el.querySelector('.drop input'), drop = el.querySelector('.drop');
      file.addEventListener('change', function () { if (file.files[0]) load(i, file.files[0]); file.value = ''; });
      ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) load(i, f); });
      el.querySelector('.rot').addEventListener('click', function () { if (!q.src || q.state === 'reading') return; q.src = rotate(q.src); q.img = toJpeg(q.src); shot(i); read(i); });
      var chg = el.querySelector('.chg input');
      chg.addEventListener('change', function () { if (chg.files[0]) load(i, chg.files[0]); chg.value = ''; });
      el.querySelector('.del').addEventListener('click', function () { clearPhoto(i); });
      el.querySelectorAll('[data-pf]').forEach(function (inp) {
        var h2 = function () {
          var k = inp.dataset.pf; q.f[k] = inp.value.trim();
          if (q.state === 'read' && q.status === 'have') q.edited = true;
          if (k === 'nationalitySel') natSel(i);
          if (i === 0 && o.onLeadRead && (k === 'surname' || k === 'givenNames' || k === 'birthDate' || k === 'sex')) o.onLeadRead(q.f, false);
          o.onChange(i, q);
        };
        inp.addEventListener('input', h2); inp.addEventListener('change', h2);
      });
      el.querySelectorAll('[data-x]').forEach(function (inp) { var h3 = function () { q.x[inp.dataset.x] = inp.type === 'checkbox' ? inp.checked : inp.value.trim(); o.onChange(i, q); }; inp.addEventListener('input', h3); inp.addEventListener('change', h3); });
      el.querySelectorAll('[data-ximg]').forEach(function (inp) {
        inp.addEventListener('change', function () {
          var f = inp.files[0], lab = inp.closest('.up'); if (!f) return;
          toCanvas(f).then(function (c) { q.ximg[inp.dataset.ximg] = toJpeg(c, 1600); lab.classList.add('has'); var im = lab.querySelector('img'); if (im) { im.src = q.ximg[inp.dataset.ximg]; im.hidden = false; } })
            .catch(function (e) { alertMsg(i, e.message); });
          inp.value = '';
        });
      });
      return el;
    }
    function alertMsg(i, t) { var m = card(i).querySelector('.msg'); if (m) m.textContent = t; }

    // 表示の切り替え：お持ち（写真→自動入力）／申請中（手入力）
    function mode(i) {
      var q = P[i], el = card(i), have = q.status === 'have';
      el.querySelector('.pp-have').hidden = !have;
      el.querySelector('.drop').hidden = !!q.img;
      el.querySelector('.shot').style.display = q.img ? 'flex' : 'none';
      el.querySelector('.pp-applying').hidden = have;
      // お持ちの方は写真を選ぶまで入力欄を出さない（読み取り後に確認・修正）
      el.querySelector('.pp-fields').hidden = have && !q.img;
      ['documentNumber', 'expiryDate'].forEach(function (k) { el.querySelector('[data-row="' + k + '"]').hidden = !have; });
      el.querySelector('[data-row="nationality"]').hidden = !have;
      el.querySelector('[data-row="nationalitySel"]').hidden = have;
      el.querySelector('[data-row="pickup"]').hidden = have;
      natSel(i);
      el.querySelectorAll('[data-mk]').forEach(function (m) { if (!have) { m.textContent = ''; m.className = 'mk'; } });
      if (have) verdict(i); else el.querySelector('.vd').innerHTML = '';
    }
    function natSel(i) { var q = P[i], el = card(i); el.querySelector('[data-row="natOther"]').hidden = q.status === 'have' || input(i, 'nationalitySel').value !== 'OTHER'; }

    // 前の写真の読み取り結果を消す（新しい写真が読めなかったときに古い値が残らないように）
    function resetRead(i) {
      var q = P[i]; q.token = (q.token || 0) + 1; q.verdict = null; q.edited = false; q.via = ''; q.expired = false; q.checks = {}; q.vizOk = false;
      FIELDS.forEach(function (f) { q.f[f[0]] = ''; input(i, f[0]).value = ''; });
      verdict(i);
    }
    function load(i, file) {
      var q = P[i];
      toCanvas(file).then(function (c) { resetRead(i); q.src = c; q.img = toJpeg(c); shot(i); mode(i); read(i); o.onChange(i, q); })
        .catch(function (e) { card(i).querySelector('.shot').style.display = 'flex'; msg(i, e.message, false); });
    }
    function clearPhoto(i) {
      var q = P[i]; resetRead(i); q.src = null; q.img = null; q.state = 'empty';
      msg(i, '', false); mode(i); o.onChange(i, q);
    }
    function shot(i) { var el = card(i); el.querySelector('.shot').style.display = 'flex'; el.querySelector('.shot img').src = P[i].img; }
    function msg(i, t, busy) { var el = card(i); el.querySelector('.msg').textContent = t; el.querySelector('.bar').hidden = !busy; }

    function read(i) {
      var q = P[i], token = (q.token || 0) + 1; q.token = token; q.state = 'reading'; q.verdict = null; verdict(i);
      if (!root.IdReader) { msg(i, '自動読み取りを利用できません。下の欄に手入力してください。', false); q.state = 'read'; return; }
      msg(i, '読み取りの順番を待っています…', true);
      queue = queue.then(function () {
        if (q.token !== token) return;
        return readPassport(q.src, function (t) { if (q.token === token) msg(i, t, true); }, function (r) { if (q.token === token) apply(i, r, false); })
          .then(function (r) {
            if (q.token !== token) return; apply(i, r, true);
            msg(i, r.via === 'viz' ? '券面の印字から読み取りました。パスポートと見比べて、違うところは直してください。' : '読み取りが完了しました。内容をパスポートと見比べてご確認ください。', false);
          }).catch(function (e) {
            if (q.token !== token) return; q.state = 'read';
            q.verdict = { level: 'ng', reasons: [{ text: '文字を読み取れませんでした。顔写真ページ全体が明るく写るように撮り直すか、下の欄に手入力してください。' }] };
            verdict(i); msg(i, (e && e.message) || '読み取れませんでした。', false);
          });
      });
    }
    function apply(i, r, final) {
      var q = P[i], f = r.fields || {};
      FIELDS.forEach(function (p) { var k = p[0], v = f[k] || ''; if (k === 'surname' || k === 'givenNames') v = v.toUpperCase(); if (k === 'sex' && v === '<') v = 'X'; if (k === 'nationality' && v === 'D') v = 'DEU'; q.f[k] = v; input(i, k).value = v; });
      q.edited = false; q.via = r.via || 'mrz'; q.verdict = r.verdict; q.expired = !!r.expired; q.checks = r.checks || {}; q.vizOk = !!(r.viz && r.viz.status === 'match');
      if (final) q.state = 'read';
      verdict(i);
      if (i === 0 && o.onLeadRead) o.onLeadRead(q.f, true);
      o.onChange(i, q);
    }
    function verdict(i) {
      var q = P[i], el = card(i), b = el.querySelector('.vd');
      el.querySelectorAll('[data-mk]').forEach(function (m) { m.textContent = ''; m.className = 'mk'; });
      if (!q.verdict || q.status !== 'have') { b.innerHTML = ''; return; }
      var v = q.verdict, t = { ok: '✓ 自動確認OK', review: '！ 一部の項目をご確認ください', ng: '✕ 読み取りを確認できませんでした' }[v.level];
      if (q.expired) t = '✕ このパスポートは有効期限が切れています';
      b.innerHTML = '<div class="verdict ' + (q.expired ? 'ng' : v.level) + '"><b>' + t + '</b>' + (v.reasons || []).filter(function (x) { return x.level !== 'info'; }).slice(0, 3).map(function (x) { return esc(x.text); }).join('<br>') + '</div>';
      var c = q.checks || {};
      function mk(k, cls, s) { var m = el.querySelector('[data-mk="' + k + '"]'); if (m) { m.className = 'mk ' + cls; m.textContent = s; } }
      ['documentNumber', 'birthDate', 'expiryDate'].forEach(function (k) { if (k in c) mk(k, c[k] ? 'ok' : 'ng', c[k] ? '✓ 検証OK' : '✕ 要確認'); });
      if (q.expired) mk('expiryDate', 'ng', '✕ 期限切れ');
      if (q.via === 'viz') { FIELDS.forEach(function (f) { mk(f[0], 'warn', q.f[f[0]] ? '！ 要確認' : '！ 入力してください'); }); if (q.expired) mk('expiryDate', 'ng', '✕ 期限切れ'); return; }
      if (q.state === 'read') ['surname', 'givenNames'].forEach(function (k) { mk(k, q.vizOk ? 'ok' : 'warn', q.vizOk ? '✓ 券面と一致' : '！ 要確認'); });
    }

    function nationality(q) { return q.status === 'have' ? String(q.f.nationality || '').toUpperCase() : (q.f.nationalitySel === 'OTHER' ? String(q.f.natOther || '') : (q.f.nationalitySel || 'JPN')); }

    var api = {
      sync: function (n) {
        while (P.length < n) P.push({ status: 'have', f: { nationalitySel: 'JPN' }, x: {}, ximg: {}, img: null, verdict: null, edited: false, state: 'empty' });
        P.length = n;
        while (box.children.length > n) box.lastElementChild.remove();
        for (var i = box.children.length; i < n; i++) { box.appendChild(build(i)); mode(i); }
        for (i = 0; i < n; i++) { card(i).querySelector('h3').textContent = o.title(i); var tg = o.tag(i), t = card(i).querySelector('.tag'); t.textContent = tg; t.hidden = !tg; }
      },
      warm: function () { if (root.IdReader) IdReader.warmup('passport'); },
      // 先に入力済みの代表者情報を、パスポート欄の初期値にする（写真を選ぶ前の手入力用）
      seed: function (i, m) {
        var q = P[i]; if (!q || q.state !== 'empty') return;
        Object.keys(m).forEach(function (k) { if (m[k] && !q.f[k]) { q.f[k] = m[k]; var e = input(i, k); if (e) e.value = m[k]; } });
      },
      people: function () { return P; },
      nationality: nationality,
      // opt.returnDate: 帰国日（Date）。opt.extra(i, q, el) → エラー {el, msg} または null
      validate: function (opt) {
        opt = opt || {};
        for (var i = 0; i < P.length; i++) {
          var q = P[i], el = card(i), who = o.title(i);
          if (q.status === 'have') {
            if (q.state === 'reading') return { el: null, msg: who + 'のパスポートを読み取り中です。完了までお待ちください。' };
            if (!q.img) return { el: el.querySelector('.drop'), msg: who + 'のパスポートの写真を選択してください（申請中・更新中の方は「申請中・更新中」を選んでください）。' };
          }
          var keys = q.status === 'have' ? FIELDS.map(function (f) { return f[0]; }) : ['surname', 'givenNames', 'birthDate', 'sex'];
          for (var k = 0; k < keys.length; k++) {
            var inp = input(i, keys[k]), v = inp.value.trim();
            if (!v) return { el: inp, msg: who + 'の「' + LABEL[keys[k]] + '」をご入力ください。' };
            if ((keys[k] === 'surname' || keys[k] === 'givenNames') && !ROMA.test(v)) return { el: inp, msg: who + 'のローマ字は半角英字で入力してください。' };
          }
          if (q.status === 'applying' && input(i, 'nationalitySel').value === 'OTHER' && !input(i, 'natOther').value.trim()) return { el: input(i, 'natOther'), msg: who + 'の国籍をご入力ください。' };
          if (q.status === 'applying' && o.pickupRequired && !input(i, 'pickup').value) return { el: input(i, 'pickup'), msg: who + 'の「' + (o.pickupLabel || 'パスポート受取予定日') + '」をご入力ください。' };
          if (q.status === 'have') {
            var exp = new Date(q.f.expiryDate + 'T00:00:00');
            if (exp < new Date()) return { el: input(i, 'expiryDate'), msg: who + 'のパスポートは有効期限が切れています。更新中の場合は「申請中・更新中」を選んでください。' };
            if (opt.returnDate && exp <= opt.returnDate) return { el: input(i, 'expiryDate'), msg: who + 'のパスポートの有効期限が、帰国日より前です。' };
            if (opt.minExpiry && exp < opt.minExpiry.date) return { el: input(i, 'expiryDate'), msg: who + 'のパスポートは' + opt.minExpiry.text };
          }
          if (opt.extra) { var e2 = opt.extra(i, q, el); if (e2) return e2; }
        }
        return null;
      },
      data: function () {
        return P.map(function (q) {
          var have = q.status === 'have', U = function (v) { return String(v || '').toUpperCase(); };
          return {
            passport: have ? 'have' : 'applying',
            verdict: have ? (q.via === 'viz' ? '要確認（券面から読取）' : q.verdict ? { ok: 'OK', review: '要確認', ng: '不可' }[q.verdict.level] : '手入力') : '申請中',
            edited: have && !!q.edited,
            fields: { surname: U(q.f.surname), givenNames: U(q.f.givenNames), birthDate: q.f.birthDate || '', sex: U(q.f.sex), nationality: U(nationality(q)),
              documentNumber: have ? U(q.f.documentNumber) : '', expiryDate: have ? (q.f.expiryDate || '') : '', pickup: have ? '' : (q.f.pickup || '') },
            image: have ? (q.img || '') : '', extra: q.x, extraImages: q.ximg
          };
        });
      },
      confirmHtml: function (extraLine) {
        return P.map(function (q, i) {
          var f = q.f, have = q.status === 'have', st;
          if (have) st = '<span class="mk ' + ({ ok: 'ok', review: 'warn', ng: 'ng' }[q.verdict ? q.verdict.level : 'review']) + '">' + (q.verdict ? { ok: '✓ 自動確認OK', review: '！ 担当者が確認します', ng: '！ 担当者が確認します' }[q.verdict.level] : '手入力') + (q.edited ? '（手修正あり）' : '') + '</span>';
          return '<dl style="margin-bottom:10px"><dt>' + esc(o.title(i)) + '</dt><dd><b>' + esc((f.surname || '') + ' ' + (f.givenNames || '')).toUpperCase() + '</b>　' + fmt(f.birthDate) + '　' + esc({ F: '女性', M: '男性', X: '指定なし' }[String(f.sex || '').toUpperCase()] || '')
            + (have ? '<br>旅券番号 ' + esc(f.documentNumber || '') + '／国籍 ' + esc(natName(nationality(q)) ) + '／有効期限 ' + fmt(f.expiryDate) + '<br>' + st
              : '<br>国籍 ' + esc(natName(nationality(q))) + '<br><span class="mk warn">パスポート申請中・更新中' + (f.pickup ? '（' + esc(o.pickupLabel || '受取予定日') + ' ' + fmt(f.pickup) + '）' : '') + '</span>')
            + (extraLine ? extraLine(i, q) : '') + '</dd></dl>';
        }).join('');
      }
    };
    return api;
  }
  root.PPForm = { create: create, readPassport: readPassport, parseViz: parseViz, esc: esc, fmt: fmt, natName: natName, NATS: NATS };
})(window);
