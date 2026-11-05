// Organization page: tab switching and Cancel buttons.
// The server renders the active tab from the ?tab= parameter (actions
// redirect back to their own tab); this script only switches in place.
// Cancel resets the form to the values the page loaded with (the saved
// values) and, for forms inside a folded "+ Add" panel, closes the panel.
document.addEventListener("DOMContentLoaded", function () {
  var btns = document.querySelectorAll(".tab-btn");
  var panels = document.querySelectorAll(".tab-panel");
  btns.forEach(function (b) {
    b.addEventListener("click", function () {
      btns.forEach(function (x) { x.classList.toggle("active", x === b); });
      panels.forEach(function (p) {
        p.classList.toggle("active", p.getAttribute("data-panel") === b.getAttribute("data-tab"));
      });
    });
  });
  document.querySelectorAll("[data-cancel]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var form = btn.closest("form");
      if (form) form.reset();
      var det = btn.closest("details");
      if (det) det.open = false;
    });
  });
});
