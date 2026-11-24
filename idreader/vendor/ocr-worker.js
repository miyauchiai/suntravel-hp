/* 言語データを base64 テキストから読み込むための tesseract ワーカーのラッパー */
(function () {
  var origFetch = self.fetch.bind(self);
  self.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    if (/\.traineddata\.gz$/.test(url)) {
      return origFetch(url.replace(/\.traineddata\.gz$/, '.traineddata.b64.txt'), init).then(function (r) {
        if (!r.ok) return r;
        return r.text().then(function (t) {
          var bin = atob(t.trim()), n = bin.length, bytes = new Uint8Array(n);
          for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
          return new Response(bytes, { status: 200 });
        });
      });
    }
    return origFetch(input, init);
  };
})();
importScripts('worker.min.js');
