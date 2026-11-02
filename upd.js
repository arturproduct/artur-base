/* История товара на странице разбора: читает updates.json и дописывает обновления Артура под разбором. */
(function () {
  var MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  function day(d) { var m = /(\d{4})-(\d{2})-(\d{2})/.exec(d || ""); return m ? (+m[3]) + " " + MON[+m[2] - 1] : (d || ""); }
  function esc(s) { return String(s || "").replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function plural(n, a, b, c) { var m = n % 100, k = n % 10; if (m > 10 && m < 20) return c; if (k === 1) return a; if (k > 1 && k < 5) return b; return c; }
  function fresh(d) { var m = /(\d{4})-(\d{2})-(\d{2})/.exec(d || ""); if (!m) return false; return (Date.now() - new Date(+m[1], +m[2] - 1, +m[3]).getTime()) < 14 * 864e5; }
  var ICO = {
    post: '<svg viewBox="0 0 24 24"><path d="M21 4L3 11l6 2 2 6 3-4 5 4z"/></svg>',
    voice: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/></svg>'
  };
  var CSS =
    ".uptop{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:-8px 0 18px}" +
    ".uptop .chip{display:inline-flex;align-items:center;gap:7px;background:var(--panel,#fff);border:2px solid var(--line,#e8e6e0);border-radius:999px;padding:6px 12px 6px 10px;font:700 12.5px/1.2 'Montserrat',system-ui,sans-serif;color:var(--ink,#0a0a08);cursor:pointer;text-decoration:none}" +
    ".uptop .chip i{width:8px;height:8px;border-radius:50%;background:var(--accent,#f0482c);box-shadow:0 0 0 4px rgba(240,72,44,.15)}" +
    ".uptop .chip b{color:var(--accent,#f0482c);font-weight:800}" +
    ".hist{margin:26px 0 22px}" +
    ".hist .hh{display:flex;align-items:center;gap:10px;font-weight:800;font-size:16px;margin:0 0 4px}" +
    ".hist .hh::before{content:'';width:18px;height:4px;border-radius:2px;background:var(--accent,#f0482c)}" +
    ".hist .hs{color:var(--meta,#7c7f84);font-size:12.5px;font-weight:700;margin:0 0 16px}" +
    ".tl{list-style:none;margin:0;padding:0;position:relative}" +
    ".tl::before{content:'';position:absolute;left:7px;top:10px;bottom:18px;width:2px;background:var(--line,#e8e6e0)}" +
    ".tl>li{position:relative;padding:0 0 18px 28px}" +
    ".tl>li>i{position:absolute;left:0;top:3px;width:16px;height:16px;border-radius:50%;background:var(--panel,#fff);border:3px solid var(--line,#e8e6e0)}" +
    ".tl>li.up>i{border-color:var(--accent,#f0482c)}" +
    ".tl>li.up.last>i{background:var(--accent,#f0482c);box-shadow:0 0 0 5px rgba(240,72,44,.15)}" +
    ".tl .wh{display:flex;align-items:center;gap:8px;font-weight:800;font-size:13px;color:var(--ink,#0a0a08);margin-bottom:8px}" +
    ".tl .wh span{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:var(--meta,#7c7f84)}" +
    ".tl .wh span.nw{color:#fff;background:var(--accent,#f0482c);border-radius:999px;padding:3px 8px;letter-spacing:.2px}" +
    ".tl .start .tx0{color:var(--meta,#7c7f84);font-size:14px;font-weight:700}" +
    ".tl .cardu{background:var(--panel,#fff);border:2px solid var(--line,#e8e6e0);border-radius:16px;padding:14px 14px 12px}" +
    ".tl .cardu h5{margin:0 0 8px;font-size:16px;line-height:1.35;font-weight:800;color:var(--ink,#0a0a08)}" +
    ".tl .cardu p{margin:0 0 10px;font-size:15px;line-height:1.55;color:var(--grey,#333335)}" +
    ".tl .cardu p strong,.tl .cardu li strong{color:var(--ink,#0a0a08);font-weight:700}" +
    ".tl .cardu ul{margin:0 0 10px;padding-left:20px;font-size:15px;line-height:1.55;color:var(--grey,#333335)}" +
    ".tl .cardu a{color:var(--accent,#f0482c);border-bottom:2px solid var(--line,#e8e6e0)}" +
    ".tl .ims{display:grid;gap:10px;margin:4px 0 12px}" +
    ".tl .ims.g2{grid-template-columns:1fr 1fr}" +
    ".tl .ims figure{margin:0}" +
    ".tl .ims img{display:block;width:100%;border-radius:10px;border:1px solid var(--line,#e8e6e0);background:#fff}" +
    ".tl .ims.g2 img{aspect-ratio:1/1;object-fit:cover}" +
    ".tl .ims figcaption{color:var(--meta,#7c7f84);font-size:12px;font-weight:700;line-height:1.35;margin-top:5px}" +
    ".tl .uls{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}" +
    ".tl .uls a{display:inline-flex;align-items:center;gap:6px;background:var(--bg,#f9f8f4);border:2px solid var(--line,#e8e6e0);border-radius:999px;padding:7px 12px;font-size:12.5px;font-weight:700;color:var(--ink,#0a0a08)}" +
    ".tl .uls svg{flex:none;width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}" +
    ".tl>li.flash .cardu{animation:upflash 1.6s ease}" +
    "@keyframes upflash{0%{box-shadow:0 0 0 0 rgba(240,72,44,.55)}100%{box-shadow:0 0 0 14px rgba(240,72,44,0)}}";

  function ready(f) { if (document.readyState !== "loading") f(); else document.addEventListener("DOMContentLoaded", f); }
  ready(function () {
    var slug = (location.pathname.split("/").pop() || "").replace(/\.html$/, "");
    var a = document.querySelector('a[href*="startapp="]');
    var m = a && /startapp=[pbt]_([A-Z]\d+)/.exec(a.getAttribute("href") || "");
    fetch("updates.json?" + Date.now(), { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (U) {
      var id = (m && m[1]) || (U._pages || {})[slug];
      if (!id) return;
      var list = U[id]; if (typeof list === "string") list = U[list];
      if (!list || !list.length) return;
      list = list.slice().sort(function (x, y) { return (x.date || "").localeCompare(y.date || ""); });
      render(list, id);
    }).catch(function () {});
  });

  function render(list, id) {
    var isBrand = /^R/.test(id);
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    var last = list[list.length - 1];
    var dateEl = document.querySelector(".wrap .date") || document.querySelector("h1");
    var pubTxt = dateEl && dateEl.classList.contains("date") ? (dateEl.textContent.split("·").pop() || "").trim() : "";

    var top = document.createElement("div"); top.className = "uptop";
    top.innerHTML = '<a class="chip" href="#hist"><i></i>Обновлено <b>' + esc(day(last.date)) + "</b> · " + list.length + " " + plural(list.length, "обновление", "обновления", "обновлений") + "</a>";
    if (dateEl && dateEl.parentNode) dateEl.parentNode.insertBefore(top, dateEl.nextSibling);

    var items = '<li class="start"><i></i><div class="wh">' + esc(pubTxt.replace(/\s*\d{4}$/, "") || "Старт") + "<span>Вышел разбор</span></div><div class=\"tx0\">Полный разбор — выше на этой странице</div></li>";
    list.forEach(function (u, i) {
      var isLast = i === list.length - 1, nw = isLast && fresh(u.date);
      var ims = (u.images || []).filter(function (x) { return x && x.src; });
      var grid = ims.length > 1 && !ims.some(function (x) { return x.cap; });
      var imgs = ims.length ? '<div class="ims' + (grid ? " g2" : "") + '">' + ims.map(function (x) {
        return '<figure><a href="' + esc(x.src) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + esc(x.src) + '" alt=""></a>' + (x.cap ? "<figcaption>" + esc(x.cap) + "</figcaption>" : "") + "</figure>";
      }).join("") + "</div>" : "";
      var lks = (u.links || []).length ? '<div class="uls">' + u.links.map(function (l) { return '<a href="' + esc(l.u) + '" target="_blank" rel="noopener">' + (ICO[l.kind] || ICO.link) + esc(l.t) + "</a>"; }).join("") + "</div>" : "";
      items += '<li class="up' + (isLast ? " last" : "") + '" id="upd-' + i + '"><i></i><div class="wh">' + esc(day(u.date)) + "<span" + (nw ? ' class="nw">Новое' : ">Обновление") + "</span></div>" +
        '<div class="cardu">' + (u.title ? "<h5>" + esc(u.title) + "</h5>" : "") + (u.html || "") + imgs + lks + "</div></li>";
    });
    var sec = document.createElement("section"); sec.className = "hist"; sec.id = "hist";
    sec.innerHTML = '<div class="hh">История ' + (isBrand ? "бренда" : "товара") + '</div><div class="hs">Новые данные и выводы после выхода разбора</div><ol class="tl">' + items + "</ol>";
    var anchor = document.querySelector(".wrap .lnks") || document.querySelector(".wrap .cta") || document.querySelector(".wrap footer");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(sec, anchor); else (document.querySelector(".wrap") || document.body).appendChild(sec);

    top.querySelector(".chip").addEventListener("click", function (e) {
      e.preventDefault();
      var li = document.getElementById("upd-" + (list.length - 1)) || sec;
      li.scrollIntoView({ behavior: "smooth", block: "start" });
      li.classList.remove("flash"); void li.offsetWidth; li.classList.add("flash");
    });
    if (location.hash === "#hist") setTimeout(function () { sec.scrollIntoView({ block: "start" }); }, 300);
  }
})();
