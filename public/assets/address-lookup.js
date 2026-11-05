// Address autocomplete for location forms. Two sources, one behavior:
// Google Places when the portal has a Google API key connected (the
// Worker proxies it, the key stays server-side), otherwise the free
// OpenStreetMap data via the Photon service (no API key). Typing in a
// street-address field offers matching US addresses; picking one fills
// street, suite/unit, city, state, and ZIP in the same location block.
// Every field stays manually editable, and if the lookup is unreachable
// the form simply works without suggestions.
// Neither source reliably carries suite/unit numbers (Google has them
// for some buildings, OpenStreetMap for almost none), so when the person
// typed one (for example "350 Fifth Avenue Suite 2100" or "88 King St
// #400"), picking a suggestion keeps it: it lands in the form's
// Suite / Unit field when the form has one, otherwise it is appended to
// the street address ("350 Fifth Avenue, Suite 2100").
(function () {
  var mode = "unknown"; // becomes "google" or "photon" on first lookup

  function groupOf(input) { return input.closest("[data-loc]") || document; }
  function field(group, cls) { return group.querySelector("." + cls); }
  function newSession() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s" + Date.now() + Math.floor(Math.random() * 1e9);
  }
  function unitFrom(text) {
    var m = String(text || "").match(/\b(suite|ste|unit|apt|apartment)\b\.?\s*#?\s*([A-Za-z0-9][A-Za-z0-9-]*)/i);
    if (m) {
      var word = m[1].toLowerCase();
      var label = word === "unit" ? "Unit" : (word === "apt" || word === "apartment") ? "Apt" : "Suite";
      return label + " " + m[2];
    }
    var hash = String(text || "").match(/#\s*([A-Za-z0-9][A-Za-z0-9-]*)/);
    return hash ? "#" + hash[1] : "";
  }

  // unitText is a suite/unit like "Suite 200" (or "" for none). It goes
  // into the block's Suite / Unit field when the form has one; otherwise
  // it is appended to the street line.
  function applyAddress(input, street, unitText, city, state, zip) {
    var g = groupOf(input);
    var suiteField = field(g, "f-suite");
    if (unitText && suiteField) {
      if (!suiteField.value.trim()) suiteField.value = unitText;
    } else if (unitText && street.toLowerCase().indexOf(unitText.toLowerCase()) === -1) {
      street = street ? street + ", " + unitText : unitText;
    }
    input.value = street;
    var c = field(g, "f-city"); if (c) c.value = city || "";
    var s = field(g, "f-state"); if (s) s.value = state || "";
    var z = field(g, "f-zip"); if (z) z.value = zip || "";
  }

  function bind(input) {
    if (input.dataset.addrBound) return;
    input.dataset.addrBound = "1";
    var wrap = document.createElement("div");
    wrap.className = "addr-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var list = document.createElement("div");
    list.className = "addr-list";
    list.style.display = "none";
    wrap.appendChild(list);
    var timer = null, items = [], active = -1, lastQuery = "";
    var session = newSession();

    function close() { list.style.display = "none"; items = []; active = -1; }

    function fillPhoton(p) {
      var street = [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || "";
      applyAddress(input, street, unitFrom(input.value),
        p.city || p.town || p.village || "", p.state || "", p.postcode || "");
      close();
    }

    function fillGoogle(item) {
      var typed = input.value;
      fetch("/admin/places/details?id=" + encodeURIComponent(item.placeId) + "&session=" + encodeURIComponent(session))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          session = newSession(); // the details call closes the billing session
          if (!d || d.error || !d.street) throw new Error("details");
          var unit = "";
          if (d.subpremise) {
            unit = /suite|ste\b|unit|apt|#/i.test(d.subpremise) ? d.subpremise : "Suite " + d.subpremise;
          } else {
            unit = unitFrom(typed);
          }
          applyAddress(input, d.street, unit, d.city, d.state, d.zip);
          close();
        })
        .catch(function () {
          // Best effort if details fails: at least keep the street line.
          applyAddress(input, item.main, unitFrom(typed), "", "", "");
          close();
        });
    }

    function fill(item) { if (item.placeId) fillGoogle(item); else fillPhoton(item.props); }

    function render() {
      list.innerHTML = "";
      items.forEach(function (item, i) {
        var d = document.createElement("div");
        d.className = "addr-item" + (i === active ? " active" : "");
        d.textContent = item.line;
        d.addEventListener("mousedown", function (e) { e.preventDefault(); fill(item); });
        list.appendChild(d);
      });
      list.style.display = items.length ? "block" : "none";
    }

    function fetchPhoton(q) {
      fetch("https://photon.komoot.io/api/?limit=6&lang=en&q=" + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          items = (data.features || []).filter(function (f) {
            return f.properties && f.properties.countrycode === "US" && (f.properties.street || f.properties.name);
          }).slice(0, 6).map(function (f) {
            var p = f.properties;
            var line = [[p.housenumber, p.street].filter(Boolean).join(" ") || p.name,
              p.city || p.town || p.village || "", p.state || "", p.postcode || ""]
              .filter(Boolean).join(", ");
            return { line: line, props: p };
          });
          active = items.length ? 0 : -1;
          render();
        })
        .catch(function () { close(); });
    }

    function fetchGoogle(q) {
      fetch("/admin/places/autocomplete?q=" + encodeURIComponent(q) + "&session=" + encodeURIComponent(session))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.enabled === false) { mode = "photon"; fetchPhoton(q); return; }
          mode = "google";
          items = ((data && data.items) || []).map(function (i) {
            return { line: [i.main, i.secondary].filter(Boolean).join(", "), placeId: i.placeId, main: i.main };
          });
          active = items.length ? 0 : -1;
          render();
        })
        .catch(function () { close(); });
    }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      if (q.length < 3) { close(); return; }
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (q === lastQuery && items.length) { render(); return; }
        lastQuery = q;
        if (mode === "photon") fetchPhoton(q); else fetchGoogle(q);
      }, 250);
    });
    input.addEventListener("keydown", function (e) {
      if (list.style.display === "none") return;
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === "Enter" && active >= 0 && items[active]) { e.preventDefault(); fill(items[active]); }
      else if (e.key === "Escape") { close(); }
    });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
  }

  function bindAll(root) {
    (root || document).querySelectorAll("input[data-address]").forEach(bind);
  }
  bindAll(document);

  // "Add another location" on the create-organization form: clone the
  // template block, bind its address lookup, append it.
  var addBtn = document.getElementById("addLocationBtn");
  var holder = document.getElementById("locationBlocks");
  var tpl = document.getElementById("locationTemplate");
  if (addBtn && holder && tpl) {
    addBtn.addEventListener("click", function () {
      var node = tpl.content.firstElementChild.cloneNode(true);
      holder.appendChild(node);
      bindAll(node);
    });
  }
})();
