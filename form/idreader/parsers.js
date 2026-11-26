/* 身分証データ解析ロジック（ブラウザ / Node 共通） */
(function (root) {
  'use strict';

  // ---------- 共通 ----------
  function toHalfWidth(s) {
    return String(s)
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/　/g, ' ');
  }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  // ---------- MRZ（パスポート TD3） ----------
  var WEIGHTS = [7, 3, 1];
  function charValue(c) {
    if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
    if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
    return 0; // '<'
  }
  function checkDigit(str) {
    var sum = 0;
    for (var i = 0; i < str.length; i++) sum += charValue(str[i]) * WEIGHTS[i % 3];
    return String(sum % 10);
  }
  var TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '7', Z: '2', S: '5', B: '8', G: '6', A: '4' };
  var TO_ALPHA = { '0': 'O', '1': 'I', '2': 'Z', '4': 'A', '5': 'S', '6': 'G', '8': 'B' };
  function fixDigits(s) { return s.split('').map(function (c) { return TO_DIGIT[c] || c; }).join(''); }
  function fixAlpha(s) { return s.split('').map(function (c) { return TO_ALPHA[c] || c; }).join(''); }

  function cleanMrzLine(line) {
    return toHalfWidth(line).toUpperCase()
      .replace(/[«‹＜〈＜]/g, '<')
      .replace(/\s+/g, '')
      .replace(/[^A-Z0-9<]/g, '');
  }
  function fit(line, len) {
    if (line.length > len) return line.slice(0, len);
    while (line.length < len) line += '<';
    return line;
  }

  // OCRテキストから TD3 の2行を探す
  function findTd3Lines(text) {
    var lines = String(text).split(/\r?\n/).map(cleanMrzLine).filter(function (l) { return l.length >= 30; });
    for (var i = 0; i < lines.length - 1; i++) {
      var l1 = lines[i], l2 = lines[i + 1];
      var p = l1.search(/P[A-Z<][A-Z<]{3}/);
      if (p >= 0 && p <= 3 && l1.indexOf('<<') >= 0) {
        return [fit(l1.slice(p), 44), fit(l2, 44)];
      }
    }
    // 'P'が誤読された場合：'<<'を含む行の次の行が数字を多く含めば採用
    for (var j = 0; j < lines.length - 1; j++) {
      if (lines[j].indexOf('<<') >= 0 && (lines[j + 1].match(/[0-9]/g) || []).length >= 12) {
        var a = lines[j];
        a = 'P' + a.slice(1);
        return [fit(a, 44), fit(lines[j + 1], 44)];
      }
    }
    return null;
  }

  // 英数字混在の旅券番号はチェックディジットに合う候補を探す
  function repairByCheck(field, cd) {
    if (checkDigit(field) === cd) return field;
    var amb = { '0': 'O', 'O': '0', '1': 'I', 'I': '1', '5': 'S', 'S': '5', '8': 'B', 'B': '8', '2': 'Z', 'Z': '2', '6': 'G', 'G': '6', 'D': '0', 'Q': '0' };
    var idx = [];
    for (var i = 0; i < field.length; i++) if (amb[field[i]]) idx.push(i);
    if (idx.length > 10) return field;
    var total = 1 << idx.length;
    for (var m = 1; m < total; m++) {
      var arr = field.split('');
      for (var k = 0; k < idx.length; k++) if (m & (1 << k)) arr[idx[k]] = amb[arr[idx[k]]];
      var cand = arr.join('');
      if (checkDigit(cand) === cd) return cand;
    }
    return field;
  }

  // 埋め字 '<' は OCR で K / L / C などに誤読されやすい
  var FILLER_LIKE = /^[KLCEIX(]+$/;
  function cleanName(s) {
    var tokens = s.split('<');
    var out = [], repaired = false;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      var rest = tokens.slice(i + 1).filter(Boolean);
      var restFiller = rest.length > 0 && rest.every(function (x) { return FILLER_LIKE.test(x) || x.length <= 1 || /(.)\1{3,}/.test(x); });
      // 誤読された埋め字の並び（例: L<L<LLKLLLL）が始まったら打ち切り
      if (out.length && FILLER_LIKE.test(t) && (t.length >= 3 || restFiller)) { repaired = true; break; }
      if (out.length && /(.)\1{3,}/.test(t)) { repaired = true; break; }
      out.push(t);
    }
    return { name: out.join(' ').trim(), repaired: repaired };
  }

  var COUNTRIES = ('AFG ALB DZA ASM AND AGO AIA ATA ATG ARG ARM ABW AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BMU BTN BOL BES BIH BWA BVT BRA IOT BRN BGR BFA BDI CPV KHM CMR CAN CYM CAF TCD CHL CHN CXR CCK COL COM COD COG COK CRI HRV CUB CUW CYP CZE CIV DNK DJI DMA DOM ECU EGY SLV GNQ ERI EST SWZ ETH FLK FRO FJI FIN FRA GUF PYF ATF GAB GMB GEO DEU GHA GIB GRC GRL GRD GLP GUM GTM GGY GIN GNB GUY HTI HMD VAT HND HKG HUN ISL IND IDN IRN IRQ IRL IMN ISR ITA JAM JPN JEY JOR KAZ KEN KIR PRK KOR KWT KGZ LAO LVA LBN LSO LBR LBY LIE LTU LUX MAC MDG MWI MYS MDV MLI MLT MHL MTQ MRT MUS MYT MEX FSM MDA MCO MNG MNE MSR MAR MOZ MMR NAM NRU NPL NLD NCL NZL NIC NER NGA NIU NFK MKD MNP NOR OMN PAK PLW PSE PAN PNG PRY PER PHL PCN POL PRT PRI QAT ROU RUS RWA REU BLM SHN KNA LCA MAF SPM VCT WSM SMR STP SAU SEN SRB SYC SLE SGP SXM SVK SVN SLB SOM ZAF SGS SSD ESP LKA SDN SUR SJM SWE CHE SYR TWN TJK TZA THA TLS TGO TKL TON TTO TUN TUR TKM TCA TUV UGA UKR ARE GBR USA UMI URY UZB VUT VEN VNM VGB VIR WLF ESH YEM ZMB ZWE ' +
    'D GBD GBN GBO GBP GBS RKS UNO UNA UNK XXA XXB XXC XXX EUE XOM XPO XDC XBA XIM XCC XCE XCO XEC XES XMP UTO').split(' ');
  function isCountry(c) { return COUNTRIES.indexOf(c.replace(/</g, '')) >= 0; }
  function diff(a, b) { var n = 0; for (var i = 0; i < 3; i++) if (a[i] !== b[i]) n++; return n; }

  function mrzDate(yymmdd, isExpiry) {
    if (!/^\d{6}$/.test(yymmdd)) return '';
    var yy = +yymmdd.slice(0, 2), mm = yymmdd.slice(2, 4), dd = yymmdd.slice(4, 6);
    var nowYY = new Date().getFullYear() % 100;
    var year = isExpiry ? 2000 + yy : (yy > nowYY ? 1900 + yy : 2000 + yy);
    return year + '-' + mm + '-' + dd;
  }

  function validYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return false;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  function todayYmd() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // 注意: チェックディジットに合うように文字を入れ替える「総当たり補正」は行わない
  // （偶然一致による誤った合格を防ぐため）。数字欄・英字欄の字種の補正のみ行う。
  function parseTd3(l1, l2) {
    l1 = fit(cleanMrzLine(l1), 44);
    l2 = fit(cleanMrzLine(l2), 44);

    var docType = l1.slice(0, 2);
    var issuer = fixAlpha(l1.slice(2, 5));
    var nameField = fixAlpha(l1.slice(5));
    var sep = nameField.indexOf('<<');
    var sn = cleanName(sep >= 0 ? nameField.slice(0, sep) : nameField);
    var gn = cleanName(sep >= 0 ? nameField.slice(sep + 2) : '');
    var nameClean = /^[A-Z]+(<[A-Z]+)*<<[A-Z]+(<[A-Z]+)*<*$/.test(l1.slice(5)) || /^[A-Z]+(<[A-Z]+)*<*$/.test(l1.slice(5));

    var docNoCd = fixDigits(l2[9]);
    var docNo = l2.slice(0, 9);
    var nationality = fixAlpha(l2.slice(10, 13));
    var dob = fixDigits(l2.slice(13, 19)), dobCd = fixDigits(l2[19]);
    var sex = l2[20];
    var exp = fixDigits(l2.slice(21, 27)), expCd = fixDigits(l2[27]);
    var optional = l2.slice(28, 42), optCd = fixDigits(l2[42]);
    var finalCd = fixDigits(l2[43]);

    if (!isCountry(nationality) && isCountry(issuer) && diff(nationality, issuer) <= 1) nationality = issuer;
    if (!isCountry(issuer) && isCountry(nationality) && diff(nationality, issuer) <= 1) issuer = nationality;

    var fixedL2 = docNo + docNoCd + nationality + dob + dobCd + sex + exp + expCd + optional + optCd + finalCd;
    var composite = docNo + docNoCd + dob + dobCd + exp + expCd + optional + optCd;
    var optCheck = optional.replace(/</g, '') === '' ? (optCd === '<' || optCd === '0') : checkDigit(optional) === optCd;

    var birthDate = mrzDate(dob, false), expiryDate = mrzDate(exp, true);
    var checks = {
      documentNumber: /^[0-9]$/.test(docNoCd) && checkDigit(docNo) === docNoCd,
      birthDate: /^[0-9]$/.test(dobCd) && checkDigit(dob) === dobCd && validYmd(birthDate),
      expiryDate: /^[0-9]$/.test(expCd) && checkDigit(exp) === expCd && validYmd(expiryDate),
      personalNumber: optCheck,
      composite: /^[0-9]$/.test(finalCd) && checkDigit(composite) === finalCd
    };
    var format = {
      type: l1[0] === 'P',
      sex: /^[MF<X]$/.test(sex),
      issuingCountry: isCountry(issuer),
      nationality: isCountry(nationality),
      name: nameClean && !sn.repaired && !gn.repaired && sn.name.length > 0
    };
    var valid = checks.documentNumber && checks.birthDate && checks.expiryDate && checks.composite && checks.personalNumber;

    return {
      type: 'passport',
      fields: {
        documentType: docType.replace(/</g, ''),
        issuingCountry: issuer.replace(/</g, ''),
        surname: sn.name,
        givenNames: gn.name,
        documentNumber: docNo.replace(/</g, ''),
        nationality: nationality.replace(/</g, ''),
        birthDate: birthDate,
        sex: sex === '<' ? 'X' : sex,
        expiryDate: expiryDate,
        personalNumber: optional.replace(/</g, '')
      },
      checks: checks,
      format: format,
      valid: valid,
      expired: validYmd(expiryDate) && expiryDate < todayYmd(),
      mrz: [l1, fixedL2]
    };
  }

  function parsePassportText(text) {
    var lines = findTd3Lines(text);
    if (!lines) return null;
    return parseTd3(lines[0], lines[1]);
  }

  // ---------- 日本の運転免許証（OCRテキスト） ----------
  var ERAS = { '明治': 1868, '大正': 1912, '昭和': 1926, '平成': 1989, '令和': 2019 };
  function eraToDate(era, y, m, d) {
    var base = ERAS[era];
    if (!base) return '';
    var yy = (y === '元') ? 1 : parseInt(y, 10);
    if (!yy) return '';
    return (base + yy - 1) + '-' + pad2(m) + '-' + pad2(d);
  }
  function normalizeJa(text) {
    var t = toHalfWidth(text);
    // 日本語の文字間に入る余計なスペースを除去
    t = t.replace(/([^\x00-\x7F])[ \t]+(?=[^\x00-\x7F])/g, '$1');
    t = t.replace(/([^\x00-\x7F])[ \t]+(?=\d)/g, '$1').replace(/(\d)[ \t]+(?=[^\x00-\x7F])/g, '$1');
    t = t.replace(/(\d)[ \t]+(?=\d)/g, '$1').replace(/[（]/g, '(').replace(/[）]/g, ')');
    // よくある誤読
    t = t.replace(/[令今]和/g, '令和').replace(/平戎|平威/g, '平成').replace(/昭租|招和/g, '昭和');
    return t;
  }
  var DATE_RE = '(明治|大正|昭和|平成|令和)(元|\\d{1,2})年(\\d{1,2})月(\\d{1,2})日';

  function parseJpLicenseText(text) {
    var t = normalizeJa(text);
    var lines = t.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var all = lines.join('\n');
    var f = { name: '', birthDate: '', address: '', issueDate: '', expiryDate: '', licenseNumber: '' };

    // 氏名（同じ行に生年月日がある）
    var nm = all.match(/氏名[:：]?\s*([^\n]+?)\s*(?:(?:明治|大正|昭和|平成|令和)(?:元|\d{1,2})年|\d{4}年|$)/m);
    if (nm) f.name = nm[1].replace(/[|｜_]/g, '').trim();

    // 生年月日
    var bd = all.match(new RegExp(DATE_RE + '生'));
    if (!bd) bd = all.match(new RegExp('氏名[^\\n]*?' + DATE_RE));
    if (bd) f.birthDate = eraToDate(bd[1], bd[2], bd[3], bd[4]);
    if (!f.birthDate) {
      var bdw = all.match(/(\d{4})年(\d{1,2})月(\d{1,2})日生/);
      if (bdw) f.birthDate = bdw[1] + '-' + pad2(bdw[2]) + '-' + pad2(bdw[3]);
    }

    // 住所
    var ad = all.match(/住所[:：]?\s*([^\n]+)/);
    if (ad) f.address = ad[1].replace(/[|｜_]/g, '').trim();

    // 交付日
    var iss = all.match(new RegExp('交付[:：]?\\s*' + DATE_RE));
    if (iss) f.issueDate = eraToDate(iss[1], iss[2], iss[3], iss[4]);

    // 有効期限
    var ex = all.match(new RegExp('[^\\(]' + DATE_RE + '\\s*まで有効')) || all.match(new RegExp('^' + DATE_RE + '\\s*まで有効', 'm'));
    if (!ex) ex = all.match(new RegExp(DATE_RE + '[^\\n]{0,6}有効'));
    if (ex) f.expiryDate = eraToDate(ex[1], ex[2], ex[3], ex[4]);
    if (!f.expiryDate) {
      var exw = all.match(/(20\d{2})年[^月\n]{0,12}?[) ]?\s*(\d{1,2})月(\d{1,2})日\s*まで有効/);
      if (exw) f.expiryDate = exw[1] + '-' + pad2(exw[2]) + '-' + pad2(exw[3]);
    }

    // 免許証番号（12桁）
    var no = all.match(/第\s*([0-9OoIl]{12})\s*号/) || all.match(/番号[^\d]{0,4}(\d{12})/) || all.match(/(?:^|\D)(\d{12})(?:\D|$)/);
    if (no) f.licenseNumber = fixDigits(no[1].toUpperCase());

    var found = Object.keys(f).filter(function (k) { return f[k]; }).length;
    return { type: 'jp-license', fields: f, found: found, text: t };
  }

  // 免許証番号: 11桁目がチェックディジット（12桁目は再交付回数）
  function jpLicenseCheck(no) {
    if (!/^\d{12}$/.test(no)) return false;
    var w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2], sum = 0;
    for (var i = 0; i < 10; i++) sum += (+no[i]) * w[i];
    var r = sum % 11;
    return (r <= 1 ? 0 : 11 - r) === +no[10];
  }

  // ---------- 海外の運転免許証（PDF417 / AAMVA） ----------
  var AAMVA = {
    DCS: 'familyName', DAC: 'firstName', DAD: 'middleName', DCT: 'givenNames',
    DAQ: 'licenseNumber', DBB: 'birthDate', DBA: 'expiryDate', DBD: 'issueDate',
    DBC: 'sex', DAG: 'street', DAI: 'city', DAJ: 'state', DAK: 'postalCode', DCG: 'country',
    DAU: 'height', DAY: 'eyeColor', DCA: 'vehicleClass'
  };
  function aamvaDate(s, isCanada) {
    s = (s || '').replace(/\D/g, '');
    if (s.length !== 8) return s;
    if (isCanada || /^(19|20)\d{2}/.test(s) && +s.slice(4, 6) <= 12 && +s.slice(0, 2) >= 19) {
      if (/^(19|20)/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    }
    return s.slice(4, 8) + '-' + s.slice(0, 2) + '-' + s.slice(2, 4); // MMDDYYYY (米国)
  }
  function parseAamva(raw) {
    if (!raw || raw.indexOf('ANSI') < 0 && raw.indexOf('AAMVA') < 0 && !/\nDAQ|DCS/.test(raw)) return null;
    var f = {};
    var parts = raw.split(/[\n\r\x1e\x1d]+/);
    parts.forEach(function (p) {
      p = p.trim();
      // サブファイル見出し（例: DLDAQ...）を考慮
      var m = p.match(/(?:^|DL|ID)(D[A-Z]{2})(.*)$/);
      if (!m) return;
      var key = AAMVA[m[1]];
      if (key && !f[key]) f[key] = m[2].trim();
    });
    var isCanada = (f.country || '').toUpperCase() === 'CAN';
    ['birthDate', 'expiryDate', 'issueDate'].forEach(function (k) { if (f[k]) f[k] = aamvaDate(f[k], isCanada); });
    if (f.sex) f.sex = ({ '1': 'M', '2': 'F', '9': 'X' })[f.sex] || f.sex;
    var given = f.givenNames || [f.firstName, f.middleName].filter(Boolean).join(' ');
    return {
      type: 'aamva',
      fields: {
        familyName: f.familyName || '',
        givenNames: given || '',
        licenseNumber: f.licenseNumber || '',
        birthDate: f.birthDate || '',
        sex: f.sex || '',
        issueDate: f.issueDate || '',
        expiryDate: f.expiryDate || '',
        address: [f.street, f.city, f.state, f.postalCode].filter(Boolean).join(', '),
        country: f.country || ''
      }
    };
  }

  var api = {
    checkDigit: checkDigit, cleanMrzLine: cleanMrzLine, fit: fit, validYmd: validYmd, todayYmd: todayYmd, jpLicenseCheck: jpLicenseCheck, eraToDate: eraToDate, isCountry: isCountry, parseTd3: parseTd3, parsePassportText: parsePassportText,
    findTd3Lines: findTd3Lines, parseJpLicenseText: parseJpLicenseText, parseAamva: parseAamva,
    normalizeJa: normalizeJa
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.IdParsers = api;
})(typeof window !== 'undefined' ? window : globalThis);
