// Renders the MFA enrollment QR code from the otpauth URL carried in the
// page's data attribute. Uses qrcode.js (QR Code Generator for JavaScript,
// Kazuhiko Arase, MIT license). If anything fails, the text key stays
// visible on the page as the fallback.
(function () {
  var el = document.getElementById("mfaQr");
  if (!el || typeof qrcode !== "function") return;
  var url = el.getAttribute("data-url");
  if (!url) return;
  try {
    var qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    el.innerHTML = qr.createSvgTag(5, 16);
  } catch (e) {
    /* Text key fallback is already on the page. */
  }
})();
