/* 身分証読み取りエンジン（UIから独立。window.IdReader として他の画面にも組み込めます）
 *   IdReader.init({ base })            … vendor/ と lang/ の置き場所
 *   IdReader.warmup(mode)              … 事前にエンジンを起動（体感速度の改善）
 *   IdReader.read(mode, canvas, opts)  … 読み取り。Promise<result>
 *       mode: 'passport' | 'jp' | 'aamva'
 *       opts.onStatus(text), opts.onUpdate(result)  … 途中経過（MRZ確定→券面照合の順）
 */
(function (root) {
  'use strict';
  var P = root.IdParsers;
  var cfg = { base: '', mrzModel: 'ocrb' };
  var pool = {};
  var now = function () { return (root.performance && performance.now) ? performance.now() : Date.now(); };

  function init(o) { for (var k in o) cfg[k] = o[k]; }

  // ---------- OCRワーカー ----------
  // CPUコアやメモリの少ない端末では、並列実行せず1つのワーカーを使い回す
  var parallel = (root.navigator && navigator.hardwareConcurrency || 4) >= 2 && !(root.navigator && navigator.deviceMemory && navigator.deviceMemory < 4);
  function getWorker(lang, slot) {
    var key = lang + '#' + (parallel ? (slot || 0) : 0);
    if (!pool[key]) {
      // cfg.workerUrl があれば（1ファイル版）、そのワーカーに認識エンジンと言語データが同梱されている
      pool[key] = root.Tesseract.createWorker(lang, 1, {
        workerPath: cfg.workerUrl ? cfg.workerUrl(lang) : cfg.base + 'vendor/ocr-worker.js',
        workerBlobURL: false,
        corePath: cfg.workerUrl ? 'inline.js' : cfg.base + 'vendor/',
        langPath: cfg.workerUrl ? 'inline' : cfg.base + 'lang',
        cacheMethod: 'none'
      }).then(function (w) { return { w: w, chain: Promise.resolve() }; })
        .catch(function (e) { delete pool[key]; throw e; });
    }
    return pool[key];
  }
  // 同じワーカーへの要求は直列化する（パラメータの取り違え防止）
  // timeoutMs を超えたらワーカーごと打ち切る（模様の多い画像で認識が極端に長引くのを防ぐ）
  function ocr(lang, slot, canvas, params, wantLines, timeoutMs) {
    var key = lang + '#' + (parallel ? (slot || 0) : 0);
    return getWorker(lang, slot).then(function (h) {
      var job = h.chain.then(function () {
        return new Promise(function (resolve, reject) {
          var timer = timeoutMs && setTimeout(function () {
            if (pool[key]) { delete pool[key]; try { h.w.terminate(); } catch (e) {} }
            var err = new Error('timeout'); err.timeout = true; reject(err);
          }, timeoutMs);
          h.w.setParameters(params).then(function () {
            return h.w.recognize(canvas, {}, { text: true, blocks: !!wantLines, hocr: false, tsv: false });
          }).then(function (r) { clearTimeout(timer); resolve(r); }, function (e) { clearTimeout(timer); reject(e); });
        });
      });
      h.chain = job.catch(function () {});
      return job;
    }).then(function (r) { return r.data; });
  }
  // 使わない書類種別のワーカーは終了してメモリを空ける
  function release(keepLangs) {
    Object.keys(pool).forEach(function (key) {
      if (keepLangs.indexOf(key.split('#')[0]) >= 0) return;
      var h = pool[key]; delete pool[key];
      h.then(function (x) { return x.chain.then(function () { return x.w.terminate(); }); }).catch(function () {});
    });
  }
  function warmup(mode) {
    release(mode === 'passport' ? [cfg.mrzModel, 'eng'] : mode === 'jp' ? ['jpn'] : []);
    var jobs = mode === 'passport' ? [getWorker(cfg.mrzModel, 0), getWorker(cfg.mrzModel, 1), getWorker('eng', 0)]
      : mode === 'jp' ? [getWorker('jpn', 0), getWorker('jpn', 1)] : [];
    return Promise.all(jobs).catch(function () {});
  }

  // ---------- 画像処理 ----------
  function toGray(src, maxW) {
    var s = Math.min(1, maxW / src.width);
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    var p = ctx.getImageData(0, 0, c.width, c.height).data, n = c.width * c.height, g = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = (p[j] * 77 + p[j + 1] * 150 + p[j + 2] * 29) >> 8;
    return { g: g, w: c.width, h: c.height, scale: s };
  }
  // 周囲の平均より暗い画素（=文字）を取り出す
  function darkMap(g, w, h, r, ratio) {
    var W = w + 1, integ = new Float64Array(W * (h + 1));
    for (var y = 0; y < h; y++) {
      var row = 0;
      for (var x = 0; x < w; x++) { row += g[y * w + x]; integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row; }
    }
    var B = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var mean = (integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0]) / ((y1 - y0) * (x1 - x0));
        if (g[y * w + x] < mean * ratio - 4) B[y * w + x] = 1;
      }
    }
    return B;
  }
  // 縦の帯ごとに、各行の「白→黒の切り替わり回数」を数える（文字行ほど多い）
  function stripTransitions(B, w, h, K) {
    var T = [], sw = w / K;
    for (var k = 0; k < K; k++) {
      var t = new Uint16Array(h), x0 = Math.round(k * sw), x1 = Math.round((k + 1) * sw);
      for (var y = 0; y < h; y++) {
        var c = 0, o = y * w;
        for (var x = x0 + 1; x < x1; x++) if (B[o + x] && !B[o + x - 1]) c++;
        t[y] = c;
      }
      T.push(t);
    }
    return T;
  }
  // 行方向の投影が最もくっきりする角度＝文字行の傾き
  function estimateAngle(T, w, h, maxDeg) {
    var K = T.length, sw = w / K, best = 0, bestScore = -1;
    for (var a = -maxDeg; a <= maxDeg + 1e-6; a += 0.25) {
      var tan = Math.tan(a * Math.PI / 180), score = 0, offs = [];
      for (var k = 0; k < K; k++) offs.push(Math.round(tan * ((k + 0.5) * sw - w / 2)));
      for (var y = 0; y < h; y++) {
        var s = 0;
        for (k = 0; k < K; k++) { var yy = y + offs[k]; if (yy >= 0 && yy < h) s += T[k][yy]; }
        score += s * s;
      }
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }
  // 傾きを補正しつつ、指定した領域を切り出す（cx,cy,bw,bh は元画像の座標）
  function extract(src, cx, cy, bw, bh, angleDeg, scale) {
    var c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(bw * scale)); c.height = Math.max(8, Math.round(bh * scale));
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(c.width / 2, c.height / 2);
    ctx.scale(scale, scale);
    ctx.rotate(-angleDeg * Math.PI / 180);
    ctx.translate(-cx, -cy);
    ctx.drawImage(src, 0, 0);
    return c;
  }
  // グレースケール化＋明るさむらの除去（背景を白に近づける）。binarize 指定で二値化
  function normalize(c, binarize, tile) {
    var ctx = c.getContext('2d', { willReadFrequently: true }), d = ctx.getImageData(0, 0, c.width, c.height), p = d.data;
    var w = c.width, h = c.height, n = w * h, g = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = (p[j] * 77 + p[j + 1] * 150 + p[j + 2] * 29) >> 8;
    // 背景推定：タイルごとの明るい側（上位20%）を補間
    var acc, ts = tile || Math.max(16, Math.round(h / 3)), gx = Math.ceil(w / ts), gy = Math.ceil(h / ts), bg = new Float32Array(gx * gy), lo = new Float32Array(gx * gy);
    for (var ty = 0; ty < gy; ty++) for (var tx = 0; tx < gx; tx++) {
      var hist = new Uint32Array(256), cnt = 0; acc = 0;
      for (var y = ty * ts; y < Math.min(h, (ty + 1) * ts); y++) for (var x = tx * ts; x < Math.min(w, (tx + 1) * ts); x++) { hist[g[y * w + x]]++; cnt++; }
      var v = 255; for (; v > 0; v--) { acc += hist[v]; if (acc >= cnt * 0.2) break; }
      bg[ty * gx + tx] = Math.max(v, 30);
      acc = 0; var u = 0; for (; u < 255; u++) { acc += hist[u]; if (acc >= cnt * 0.03) break; }
      lo[ty * gx + tx] = u;
    }
    function sample(arr, x, y) {
      var fx = Math.min(gx - 1, Math.max(0, x / ts - 0.5)), fy = Math.min(gy - 1, Math.max(0, y / ts - 0.5));
      var x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(gx - 1, x0 + 1), y1 = Math.min(gy - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      return (arr[y0 * gx + x0] * (1 - ax) + arr[y0 * gx + x1] * ax) * (1 - ay) + (arr[y1 * gx + x0] * (1 - ax) + arr[y1 * gx + x1] * ax) * ay;
    }
    // 文字のない区画でノイズを増幅しないよう、画像全体のコントラストを下限にする
    var gh = new Uint32Array(256); for (i = 0; i < n; i += 3) gh[g[i]]++;
    var tot = Math.ceil(n / 3), gLo = 0, gHi = 255; acc = 0; for (; gLo < 255; gLo++) { acc += gh[gLo]; if (acc >= tot * 0.02) break; }
    acc = 0; for (; gHi > 0; gHi--) { acc += gh[gHi]; if (acc >= tot * 0.2) break; }
    var minC = Math.max(30, 0.6 * (gHi - gLo));
    // 'ink' 用：背景に対する明るさの比を「文字」と「背景・地紋」の2群に分けるしきい値（大津の方法）
    var inkT = 0.55;
    if (binarize === 'ink') {
      var rh = new Uint32Array(256), rn = 0, step = Math.max(1, Math.floor(Math.sqrt(n / 60000)));
      for (y = 0; y < h; y += step) for (x = 0; x < w; x += step) { var rr = Math.min(255, Math.round(g[y * w + x] / sample(bg, x, y) * 200)); rh[rr]++; rn++; }
      var sumAll = 0, sumB = 0, wB = 0, best = -1, t;
      for (t = 0; t < 256; t++) sumAll += t * rh[t];
      for (t = 0; t < 256; t++) {
        wB += rh[t]; if (!wB) continue; var wF = rn - wB; if (!wF) break;
        sumB += t * rh[t]; var mB = sumB / wB, mF = (sumAll - sumB) / wF, bet = wB * wF * (mB - mF) * (mB - mF);
        if (bet > best) { best = bet; inkT = t / 200; }
      }
      inkT = Math.max(0.42, Math.min(0.72, inkT));
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      var b = sample(bg, x, y), l = Math.min(sample(lo, x, y), b - minC);
      var o = (g[i] - l) * 255 / (b - l);
      // 'ink'：背景より十分に暗い画素（黒い文字）だけを残し、淡い地紋・模様を白に飛ばす
      if (binarize === 'ink') o = (g[i] / b - (inkT - 0.14)) * 255 / 0.2;
      else if (binarize) o = o > 140 ? 255 : 0;
      o = o < 0 ? 0 : o > 255 ? 255 : o;
      p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = o; p[i * 4 + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }
  function rotated(src, quarter) { // quarter × 90°（時計回り）
    if (!quarter) return src;
    var c = document.createElement('canvas'), odd = quarter % 2 === 1;
    c.width = odd ? src.height : src.width; c.height = odd ? src.width : src.height;
    var ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2); ctx.rotate(quarter * Math.PI / 2); ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  // 文字行が横向きか縦向き（写真が90°回っている）かを、行方向の投影のくっきり度で判定し、試す向きの順番を返す
  function orientationOrder(src) {
    var G = toGray(src, 600), w = G.w, h = G.h, B = darkMap(G.g, w, h, 14, 0.7), Bt = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) Bt[x * h + y] = B[y * w + x];
    function peak(M, mw, mh) {
      var T = stripTransitions(M, mw, mh, 12), a = estimateAngle(T, mw, mh, 10), tan = Math.tan(a * Math.PI / 180), sw = mw / 12, sum = 0, sq = 0;
      for (var yy = 0; yy < mh; yy++) {
        var s = 0;
        for (var k = 0; k < 12; k++) { var q = yy + Math.round(tan * ((k + 0.5) * sw - mw / 2)); if (q >= 0 && q < mh) s += T[k][q]; }
        sum += s; sq += s * s;
      }
      var mean = sum / mh; return mean > 0 ? (sq / mh - mean * mean) / (mean * mean) : 0;
    }
    return peak(Bt, h, w) > peak(B, w, h) * 1.25 ? [1, 3, 0, 2] : [0, 2, 1, 3];
  }

  // ---------- パスポート：MRZの位置を画像処理で特定 ----------
  function locateMrz(src) {
    var G = toGray(src, 900), w = G.w, h = G.h, K = 12;
    var B = darkMap(G.g, w, h, Math.round(w / 45), 0.86);
    var T = stripTransitions(B, w, h, K);
    var angle = estimateAngle(T, w, h, 10);
    var tan = Math.tan(angle * Math.PI / 180), sw = w / K, offs = [];
    for (var k = 0; k < K; k++) offs.push(Math.round(tan * ((k + 0.5) * sw - w / 2)));
    // 行ごと：文字らしい帯の数（S）と切り替わり総数（D）
    var S = new Uint8Array(h), D = new Float32Array(h);
    for (var y = 0; y < h; y++) {
      var run = 0, bestRun = 0, sum = 0;
      for (k = 0; k < K; k++) {
        var yy = y + offs[k], v = (yy >= 0 && yy < h) ? T[k][yy] : 0;
        if (v >= 3) { run++; sum += v; if (run > bestRun) bestRun = run; } else run = 0;
      }
      S[y] = bestRun; D[y] = sum;
    }
    // 横に広く続く文字行（MRZは44文字がページ幅いっぱいに並ぶ）
    var need = Math.round(K * 0.55), runs = [], st = -1, gap = 0;
    for (y = 0; y <= h; y++) {
      var good = y < h && S[y] >= need;
      if (good) { if (st < 0) st = y; gap = 0; }
      else if (st >= 0) { gap++; if (gap > 1 || y === h) { var e = y - gap; if (e - st >= 3) runs.push({ y0: st, y1: e }); st = -1; gap = 0; } }
    }
    runs.forEach(function (r) { var s = 0; for (var q = r.y0; q <= r.y1; q++) s += D[q]; r.h = r.y1 - r.y0 + 1; r.d = s / r.h; });
    if (!runs.length) return null;
    function extent(c) { // 横方向の範囲
      var col = new Uint8Array(w), x, yy2, q;
      for (x = 0; x < w; x++) {
        var off = Math.round(tan * (x - w / 2));
        for (q = c.y0; q <= c.y1; q++) { yy2 = q + off; if (yy2 >= 0 && yy2 < h && B[yy2 * w + x]) { col[x] = 1; break; } }
      }
      var maxGap = Math.round(c.lineH * 1.3), segs = [], s0 = -1, last = -1;
      for (x = 0; x < w; x++) if (col[x]) {
        if (s0 < 0) s0 = x; else if (x - last > maxGap) { segs.push([s0, last]); s0 = x; }
        last = x;
      }
      if (s0 >= 0) segs.push([s0, last]);
      segs.sort(function (p, q2) { return (q2[1] - q2[0]) - (p[1] - p[0]); });
      c.x0 = segs.length ? segs[0][0] : 0; c.x1 = segs.length ? segs[0][1] : w - 1;
      // MRZは44文字。文字の高さと全幅の比が決まっているので、それに合うものだけ採用
      var ratio = c.lineH / Math.max(1, c.x1 - c.x0);
      return ratio > 0.011 && ratio < 0.05 && (c.x1 - c.x0) > w * 0.3;
    }
    var cands = [];
    for (var i = 0; i + 1 < runs.length; i++) {
      var a = runs[i], b = runs[i + 1], mh = Math.max(a.h, b.h);
      if (b.y0 - a.y1 > 2.2 * mh || mh > 2.5 * Math.min(a.h, b.h) || Math.min(a.d, b.d) < 0.5 * Math.max(a.d, b.d)) continue;
      cands.push({ sc: (a.d + b.d) * (1 + 0.25 * (b.y1 / h)), y0: a.y0, y1: b.y1, lineH: (a.h + b.h) / 2 });
    }
    cands.sort(function (p, q) { return q.sc - p.sc; });
    // 2行がつながって見える／1行しか検出できない場合の候補
    runs.slice().sort(function (p, q) { return q.d * Math.min(q.h, 40) - p.d * Math.min(p.h, 40); }).slice(0, 3).forEach(function (r1) {
      var lh = r1.h > 28 ? r1.h / 2.3 : r1.h;
      cands.push(r1.h > 28 ? { y0: r1.y0, y1: r1.y1, lineH: lh } : { y0: Math.max(0, r1.y0 - Math.round(2 * lh)), y1: Math.min(h - 1, r1.y1 + Math.round(2 * lh)), lineH: lh });
    });
    var best = null;
    for (i = 0; i < cands.length; i++) if (extent(cands[i])) { best = cands[i]; break; }
    if (!best) return null;
    var x0 = best.x0, x1 = best.x1;
    var inv = 1 / G.scale, cxs = (x0 + x1) / 2, cys = (best.y0 + best.y1) / 2 + tan * (cxs - w / 2);
    var cos = Math.cos(angle * Math.PI / 180);
    return {
      angle: angle, cx: cxs * inv, cy: cys * inv,
      width: (x1 - x0) / cos * inv, height: (best.y1 - best.y0 + 1) * cos * inv, lineH: best.lineH * inv
    };
  }

  var MRZ_PARAMS = { tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', tessedit_pageseg_mode: '6', preserve_interword_spaces: '0' };

  function mrzLines(text) {
    var lines = String(text).split(/\r?\n/).map(P.cleanMrzLine).filter(function (l) { return l.length >= 38 && l.length <= 48; });
    if (lines.length < 2) return null;
    // 最後の2行を採用（切り出し済みなので通常ちょうど2行）
    var l1 = lines[lines.length - 2], l2 = lines[lines.length - 1];
    for (var i = 0; i < lines.length - 1; i++) if (/^P[A-Z<]/.test(lines[i]) && lines[i].indexOf('<<') > 0) { l1 = lines[i]; l2 = lines[i + 1]; break; }
    return [l1, l2];
  }
  // 行頭・行末の余計な文字や1文字の脱落を整える（2行目は全チェックディジットが通る場合に限る）
  function alignLine1(l1) {
    var changed = false, m;
    if (!/^P[A-Z<]/.test(l1)) {
      m = /^.{0,2}?(P[A-Z<][A-Z]{3}.*)$/.exec(l1);
      if (m) { l1 = m[1]; changed = true; }
      else if (P.isCountry(l1.slice(1, 4)) && l1[0] === '<') { l1 = 'P' + l1; changed = true; }
    } else if (l1[1] !== '<' && !P.isCountry(l1.slice(2, 5)) && P.isCountry(l1.slice(1, 4))) { l1 = 'P<' + l1.slice(1); changed = true; }
    var guard = 0;
    while (l1.length > 44 && guard++ < 4) {
      changed = true;
      if (/<[^<]$/.test(l1)) l1 = l1.slice(0, -1);                                   // 末尾の余計な1文字
      else if (/[0-9]/.test(l1.slice(5))) { var k = 5 + l1.slice(5).search(/[0-9]/); l1 = l1.slice(0, k) + l1.slice(k + 1); } // 氏名欄に数字は入らない
      else if (/<$/.test(l1)) l1 = l1.slice(0, -1);
      else return null;
    }
    if (l1.length > 44) return null;
    if (l1.length < 44) { if (!/<<$/.test(l1) || l1.length < 40) return null; l1 = P.fit(l1, 44); changed = true; }
    return { s: l1, changed: changed };
  }
  function alignLine2(l2, l1) {
    if (l2.length === 44) return { s: l2, changed: false };
    var out = [], i;
    if (l2.length > 44 && l2.length <= 47) for (i = 0; i + 44 <= l2.length; i++) out.push(l2.slice(i, i + 44));
    if (l2.length === 45) for (i = 0; i < 45; i++) out.push(l2.slice(0, i) + l2.slice(i + 1));
    if (l2.length === 43) for (i = 28; i <= 43; i++) out.push(l2.slice(0, i) + '<' + l2.slice(i));
    out = out.filter(function (x, idx) { return out.indexOf(x) === idx && P.parseTd3(l1, x).valid; });
    return out.length === 1 ? { s: out[0], changed: true } : null;
  }
  var AMBIG = { O: '0', '0': 'O', Q: '0', D: '0', S: '5', '5': 'S', B: '8', '8': 'B', I: '1', '1': 'I', Z: '2', '2': 'Z' };
  // 旅券番号の補正：紛らわしい1文字を入れ替えて全チェックが通る候補が「ただ1つ」のときだけ採用
  function repairDocNo(l1, l2) {
    var jp = l2.slice(10, 13) === 'JPN' || l1.slice(2, 5) === 'JPN', TD = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' }, TA = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G' };
    if (jp) { // 日本の旅券番号は「英字2文字＋数字7桁」
      var d = l2.slice(0, 9).split('').map(function (c, i) { return i < 2 ? (TA[c] || c) : (TD[c] || c); }).join('');
      if (d !== l2.slice(0, 9)) { var j = d + l2.slice(9); if (P.parseTd3(l1, j).valid) return { s: j, how: 'format' }; }
    }
    var r = P.parseTd3(l1, l2);
    if (r.valid || r.checks.documentNumber || !r.checks.birthDate || !r.checks.expiryDate) return null;
    var ok = [];
    for (var i = 0; i < 9; i++) {
      var alt = AMBIG[l2[i]]; if (!alt) continue;
      var c2 = l2.slice(0, i) + alt + l2.slice(i + 1);
      if (P.parseTd3(l1, c2).valid) ok.push(c2);
    }
    return ok.length === 1 ? { s: ok[0], how: 'flip' } : null;
  }
  function candidateFrom(text) {
    var ls = mrzLines(text);
    if (!ls) return null;
    var a1 = alignLine1(ls[0]);
    if (!a1) return null;
    var a2 = alignLine2(ls[1], a1.s);
    if (!a2) return null;
    var c = { l1: a1.s, l2: a2.s, aligned: a1.changed || a2.changed };
    var rep = repairDocNo(c.l1, c.l2);
    if (rep) { c.l2 = rep.s; c.repaired = rep.how; }
    return c;
  }
  function vote(strs) {
    var out = '', unanimous = true, majority = true;
    for (var i = 0; i < 44; i++) {
      var cnt = {}, bestC = '', bestN = 0;
      strs.forEach(function (s) { var c = s[i]; cnt[c] = (cnt[c] || 0) + 1; if (cnt[c] > bestN) { bestN = cnt[c]; bestC = c; } });
      if (bestN < strs.length) unanimous = false;
      if (bestN < 2) majority = false;
      out += bestC;
    }
    return { s: out, unanimous: unanimous, majority: majority };
  }

  function mrzCrop(src, loc, lineTarget, binarize, pad) {
    var sc = lineTarget / loc.lineH;
    var bw = loc.width + loc.lineH * 3 * pad, bh = loc.height + loc.lineH * 1.6 * pad;
    if (bw * sc > 2200) sc = 2200 / bw;
    var c = normalize(extract(src, loc.cx, loc.cy, bw, bh, loc.angle, sc), binarize);
    // 文字範囲の外側（ページの端・机など）を白く塗り、余計な文字の誤検出を防ぐ
    var ctx = c.getContext('2d'), mx = Math.round((bw - loc.width - loc.lineH * 0.9) / 2 * sc), my = Math.round((bh - loc.height - loc.lineH * 0.9) / 2 * sc);
    ctx.fillStyle = '#fff';
    if (mx > 0) { ctx.fillRect(0, 0, mx, c.height); ctx.fillRect(c.width - mx, 0, mx, c.height); }
    if (my > 0) { ctx.fillRect(0, 0, c.width, my); ctx.fillRect(0, c.height - my, c.width, my); }
    return c;
  }

  function readMrzAt(src, loc, opts) {
    var variants = [
      function () { return mrzCrop(src, loc, 38, false, 1); },
      function () { return mrzCrop(src, loc, 30, false, 1.3); },
      function () { return mrzCrop(src, loc, 46, true, 0.8); }
    ];
    var cands = [], raws = [];
    function pass(i) {
      return ocr(cfg.mrzModel, i % 2, variants[i](), MRZ_PARAMS, false, 6000).catch(function (e) { if (e && e.timeout) return { text: '' }; throw e; }).then(function (d) {
        raws.push(d.text.trim());
        var c = candidateFrom(d.text);
        if (c) cands.push(c);
      });
    }
    function decide(final) {
      if (cands.length >= 2) {
        // 2回の独立した認識が完全一致し、チェックディジットも通れば確定
        for (var i = 0; i < cands.length; i++) for (var j = i + 1; j < cands.length; j++) {
          if (cands[i].l1 === cands[j].l1 && cands[i].l2 === cands[j].l2) {
            var r = P.parseTd3(cands[i].l1, cands[i].l2);
            if (r.valid || final) { r.agree = true; r.repaired = cands[i].repaired === 'flip' || cands[j].repaired === 'flip'; return r; }
          }
        }
      }
      if (!final) return null;
      if (cands.length === 3) {
        var v1 = vote(cands.map(function (c) { return c.l1; })), v2 = vote(cands.map(function (c) { return c.l2; }));
        var rv = P.parseTd3(v1.s, v2.s);
        if (rv.valid) { rv.agree = v1.majority && v2.majority; rv.repaired = cands.some(function (c) { return c.repaired === 'flip'; }); return rv; }
      }
      // 一致しない場合は、チェックが最も多く通る候補を「要確認」として返す
      var best = null, bs = -1;
      cands.forEach(function (c) {
        var r = P.parseTd3(c.l1, c.l2), s = 0; for (var k in r.checks) if (r.checks[k]) s++;
        if (s > bs) { bs = s; best = r; best.repaired = c.repaired === 'flip'; }
      });
      if (best) best.agree = false;
      return best;
    }
    return Promise.all([pass(0), pass(1)]).then(function () {
      var r = decide(false);
      if (r) return r;
      return pass(2).then(function () { return decide(true); });
    }).then(function (r) {
      if (!r || !r.valid || (r.format.type && r.format.name && r.format.issuingCountry)) return r;
      // 2行目は検証済みだが1行目（氏名行）が不自然：OCR-B以外の書体の可能性があるため汎用モデルで読み直す
      return ocr('eng', 0, variants[0](), MRZ_PARAMS, false, 5000).then(function (d) {
        raws.push(d.text.trim());
        var ls = mrzLines(d.text), a1 = ls && alignLine1(ls[0]);
        if (!a1) return r;
        var r2 = P.parseTd3(a1.s, r.mrz[1]);
        if (r2.valid && r2.format.type && r2.format.name && r2.format.issuingCountry) { r2.agree = false; r2.repaired = r.repaired; return r2; }
        return r;
      }).catch(function () { return r; });
    }).then(function (r) { if (r) r.raw = raws; return r || { failed: true, raw: raws }; });
  }

  // ---------- パスポート：券面（上部の印字）との照合 ----------
  function editDistance(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) d[i] = [i];
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function vizOcr(src, loc) {
    // MRZの上側、ページ1枚分を切り出して英字OCR（MRZの認識と並行して実行）
    var pageW = loc.width * 1.08, pageH = loc.width * 0.66, rad = loc.angle * Math.PI / 180;
    var dist = loc.height / 2 + pageH / 2;
    var cx = loc.cx + Math.sin(rad) * dist, cy = loc.cy - Math.cos(rad) * dist;
    var sc = Math.min(1.6, 1200 / pageW);
    var c = normalize(extract(src, cx, cy, pageW, pageH, loc.angle, sc), 'ink', 48);
    return ocr('eng', 0, c, { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '', preserve_interword_spaces: '0' }, false, 6000)
      .then(function (d) { return d.text.toUpperCase(); }).catch(function () { return ''; });
  }
  function vizCompare(text, fields) {
    var tokens = text.replace(/[^A-Z0-9]+/g, ' ').split(' ').filter(Boolean);
    if (tokens.length < 4) return { status: 'unreadable' };
    var want = (fields.surname + ' ' + fields.givenNames).split(' ').filter(Boolean);
    var missing = [], near = [];
    want.forEach(function (t) {
      if (tokens.indexOf(t) >= 0) return;
      var alt = t.length >= 3 && tokens.filter(function (x) { return Math.abs(x.length - t.length) <= 1 && editDistance(x, t) === 1; })[0];
      if (alt) near.push({ mrz: t, viz: alt }); else missing.push(t);
    });
    return { status: (!missing.length && !near.length) ? 'match' : near.length ? 'near' : 'missing', near: near, missing: missing,
      docSeen: tokens.indexOf(fields.documentNumber) >= 0 };
  }

  function passportVerdict(r) {
    var reasons = [], level = 'ok';
    function add(lv, msg) { reasons.push({ level: lv, text: msg }); if (lv === 'ng' || (lv === 'review' && level === 'ok')) level = lv; }
    var ck = r.checks;
    if (!r.valid) {
      var bad = [];
      if (!ck.documentNumber) bad.push('旅券番号'); if (!ck.birthDate) bad.push('生年月日'); if (!ck.expiryDate) bad.push('有効期限');
      if (!ck.personalNumber) bad.push('個人番号欄'); if (!bad.length || !ck.composite) bad.push('総合チェック');
      add('ng', 'チェックディジットが一致しません（' + bad.join('・') + '）。撮り直してください。');
    }
    if (r.valid && !r.agree) add('review', '複数回の認識結果が一致しませんでした。');
    var docConfirmed = r.viz && r.viz.docSeen;
    var no = r.fields.documentNumber, jpFmt = r.fields.issuingCountry === 'JPN' && /^[A-Z]{2}[0-9]{7}$/.test(no);
    r.docAmbiguous = !jpFmt && (/O/.test(no) || /0[A-Z]|[A-Z]0/.test(no));
    // O と 0 は券面の印字でも機械では見分けにくいため、券面照合が一致しても目視確認とする
    if (r.valid && r.docAmbiguous) add('review', '旅券番号に「O（オー）」と「0（ゼロ）」の紛らわしい文字があります。券面と見比べてください。');
    else if (r.valid && r.repaired && r.viz && !docConfirmed) add('review', '旅券番号の紛らわしい1文字をチェックディジットに合わせて補正しました。券面と見比べてください。');
    if (!r.format.type) add('review', '旅券（P）以外の種別の可能性があります。');
    if (!r.format.issuingCountry || !r.format.nationality) add('review', '国コードが一覧にありません。');
    if (!r.format.sex) add('review', '性別欄を読み取れませんでした。');
    if (!r.format.name) add('review', '氏名欄に不自然な文字があります。');
    if (r.expired) add('ng', '有効期限が切れています。');
    var v = r.viz;
    if (!v) add('review', '氏名・旅券番号を券面の印字と照合中です。');
    else if (v.status === 'match') reasons.push({ level: 'ok', text: '氏名が券面の印字と一致しました' + (v.docSeen ? '（旅券番号も一致）。' : '。') });
    else if (v.status === 'near') add('review', '氏名が券面の印字と1文字異なります（MRZ: ' + v.near.map(function (n) { return n.mrz + ' / 券面: ' + n.viz; }).join('、') + '）。');
    else add('review', '氏名を券面の印字と照合できませんでした（氏名はチェックディジットの対象外です）。');
    if (r.valid) reasons.unshift({ level: 'ok', text: 'チェックディジット（旅券番号・生年月日・有効期限・総合）がすべて一致しました。' });
    r.verdict = { level: level, reasons: reasons };
    return r;
  }

  function readPassport(src, opts) {
    var t0 = now();
    opts.onStatus('MRZの位置を検出中…');
    function attempt(img) {
      var loc = locateMrz(img);
      if (!loc) return Promise.resolve({ failed: true, raw: [] });
      opts.onStatus('MRZを読み取り中…');
      var vizP = vizOcr(img, loc);
      return readMrzAt(img, loc, opts).then(function (r) { r.vizP = vizP; return r; });
    }
    // 向きの自動判定：そのまま → 上下逆 → 横向き（左右）の順に、検証を通るまで試す
    var order = orientationOrder(src), bestR = null;
    function next(i) {
      if (i >= order.length) return Promise.resolve(bestR || { failed: true, raw: [] });
      return attempt(rotated(src, order[i])).then(function (r) {
        if (!r.failed && r.valid) return r;
        if (!r.failed && (!bestR || bestR.failed)) bestR = r; else if (!bestR) bestR = r;
        return next(i + 1);
      });
    }
    return next(0).then(function (r) {
      if (r.failed) {
        var e = new Error('MRZ（下部の2行）を読み取れませんでした。下部の2行がはっきり写るように撮り直してください。');
        e.raw = (r.raw || []).join('\n---\n'); throw e;
      }
      var vizP = r.vizP; delete r.vizP;
      r.type = 'passport';
      r.ms = { mrz: Math.round(now() - t0) };
      r.raw = r.mrz.join('\n') + '\n\n--- 認識結果（各回） ---\n' + r.raw.join('\n---\n');
      passportVerdict(r);
      opts.onUpdate(r);
      if (!r.valid) { r.viz = { status: 'skipped' }; r.ms.total = r.ms.mrz; return passportVerdict(r); }
      opts.onStatus('氏名を券面の印字と照合中…');
      return vizP.then(function (text) {
        r.viz = vizCompare(text, r.fields); r.ms.total = Math.round(now() - t0);
        return passportVerdict(r);
      });
    });
  }

  root.IdReader = { init: init, warmup: warmup, read: function (mode, canvas, opts) {
    opts = opts || {}; opts.onStatus = opts.onStatus || function () {}; opts.onUpdate = opts.onUpdate || function () {};
    if (mode === 'passport') return readPassport(canvas, opts);
    if (mode === 'jp') return root.IdReader._readJp(canvas, opts);
    return root.IdReader._readAamva(canvas, opts);
  }, _util: { orientationOrder: orientationOrder, rotated: rotated, getWorker: getWorker, toGray: toGray, darkMap: darkMap, stripTransitions: stripTransitions, estimateAngle: estimateAngle, extract: extract, normalize: normalize, ocr: ocr, now: now, locateMrz: locateMrz, mrzCrop: mrzCrop, cfg: cfg } };
})(window);
