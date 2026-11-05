// Auto-format US phone inputs as (AAA) BBB-CCCC while typing. Typing
// 6013450188 lands as (601) 345-0188; a leading country-code 1 is
// dropped. The server normalizes the same way, so what is stored is
// always the formatted number.
(function () {
  function format(v) {
    var d = String(v || "").replace(/\D/g, "");
    if (d.length > 10 && d.charAt(0) === "1") d = d.slice(1);
    d = d.slice(0, 10);
    if (d.length === 0) return "";
    if (d.length < 4) return "(" + d;
    if (d.length < 7) return "(" + d.slice(0, 3) + ") " + d.slice(3);
    return "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
  }
  document.querySelectorAll("input[data-phone]").forEach(function (input) {
    input.addEventListener("input", function () { input.value = format(input.value); });
    input.addEventListener("blur", function () { input.value = format(input.value); });
    if (input.value) input.value = format(input.value);
  });
})();
