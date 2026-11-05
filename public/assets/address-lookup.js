// Address autocomplete for location forms. Free OpenStreetMap data via the
// Photon service (no API key). Typing in a street-address field offers
// matching addresses anywhere in the United States (results are filtered
// to the US, with no regional bias, so every state shows up equally);
// picking one fills street, city, state, and ZIP in the same location
// block. Every field stays manually editable, and if the lookup is
// unreachable the form simply works without suggestions.
// The map data has no suite/unit numbers, so when the person typed one
// (for example "350 Fifth Avenue Suite 2100" or "88 King St #400"),
// picking a suggestion keeps it: the filled street address becomes
// "350 Fifth Avenue, Suite 2100".
(function () {
  function groupOf(input) { return input.closest("[data-loc]") || document; }
  function field(group, cls) { return group.querySelector("." + cls); }
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

    function close() { list.style.display = "none"; items = []; active = -1; }
    function fill(p) {
      var g = groupOf(input);
      var street = [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || "";
      var unit = unitFrom(input.value);
      if (unit && street.toLowerCase().indexOf(unit.toLowerCase()) === -1) street += ", " + unit;
      input.value = street;
      var city = field(g, "f-city"); if (city) city.value = p.city || p.town || p.village || "";
      var state = field(g, "f-state"); if (state) state.value = p.state || "";
      var zip = field(g, "f-zip"); if (zip) zip.value = p.postcode || "";
      close();
    }
    function render() {
      list.innerHTML = "";
      items.forEach(function (f, i) {
        var p = f.properties;
        var line = [[p.housenumber, p.street].filter(Boolean).join(" ") || p.name,
          p.city || p.town || p.village || "", p.state || "", p.postcode || ""]
          .filter(Boolean).join(", ");
        var d = document.createElement("div");
        d.className = "addr-item" + (i === active ? " active" : "");
        d.textContent = line;
        d.addEventListener("mousedown", function (e) { e.preventDefault(); fill(p); });
        list.appendChild(d);
      });
      list.style.display = items.length ? "block" : "none";
    }
    input.addEventListener("input", function () {
      var q = input.value.trim();
      if (q.length < 3) { close(); return; }
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (q === lastQuery && items.length) { render(); return; }
        lastQuery = q;
        fetch("https://photon.komoot.io/api/?limit=6&lang=en&q=" + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            items = (data.features || []).filter(function (f) {
              return f.properties && f.properties.countrycode === "US" && (f.properties.street || f.properties.name);
            }).slice(0, 6);
            active = items.length ? 0 : -1;
            render();
          })
          .catch(function () { close(); });
      }, 250);
    });
    input.addEventListener("keydown", function (e) {
      if (list.style.display === "none") return;
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === "Enter" && active >= 0 && items[active]) { e.preventDefault(); fill(items[active].properties); }
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
