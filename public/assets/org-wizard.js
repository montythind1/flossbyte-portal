// Add-organization wizard: one form, four steps (Organization, Locations,
// Products, User logins), submitted once at the end. Without JavaScript
// every step is simply stacked on the page and the same submit works.
(function () {
  var form = document.getElementById("orgWizard");
  if (!form) return;
  form.classList.add("js-wizard");
  var steps = Array.prototype.slice.call(form.querySelectorAll(".wstep"));
  var nodes = Array.prototype.slice.call(document.querySelectorAll(".wiz-node"));
  var fill = document.getElementById("wizFill");
  var back = document.getElementById("wizBack");
  var next = document.getElementById("wizNext");
  var create = document.getElementById("wizCreate");
  var emailMsg = document.getElementById("emailCheck");
  var locationMsg = document.getElementById("locationCheck");
  var loginMsg = document.getElementById("loginCheck");
  var current = 1;

  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
  function validPhone(v) {
    var d = String(v || "").replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    return d.length === 10;
  }

  function locationOptions() {
    var opts = [{ value: "", label: "All locations" }];
    form.querySelectorAll('input[name="loc_name[]"]').forEach(function (input, i) {
      var name = input.value.trim();
      if (name) opts.push({ value: String(i), label: name });
    });
    return opts;
  }
  function syncLocationSelects() {
    var opts = locationOptions();
    form.querySelectorAll("select.login-loc").forEach(function (sel) {
      var prev = sel.value;
      sel.innerHTML = "";
      opts.forEach(function (o) {
        var el = document.createElement("option");
        el.value = o.value; el.textContent = o.label;
        sel.appendChild(el);
      });
      sel.value = opts.some(function (o) { return o.value === prev; }) ? prev : "";
    });
  }

  function show(n) {
    current = n;
    steps.forEach(function (s) { s.classList.toggle("active", Number(s.dataset.step) === n); });
    if (fill) fill.style.width = ((n - 1) / (steps.length - 1)) * 100 + "%";
    nodes.forEach(function (node) {
      var i = Number(node.dataset.node);
      node.classList.toggle("done", i < n);
      node.classList.toggle("current", i === n);
      var dot = node.querySelector(".dot");
      if (dot) dot.textContent = i < n ? "✓" : String(i);
    });
    back.style.display = n > 1 ? "" : "none";
    next.style.display = n < 4 ? "" : "none";
    create.style.display = n === 4 ? "" : "none";
    if (n === 4) syncLocationSelects();
    window.scrollTo(0, 0);
  }

  function checkEmailThenAdvance() {
    var emailInput = form.querySelector('input[name="contact_email"]');
    var email = emailInput.value.trim();
    var name = form.querySelector('input[name="name"]').value.trim();
    var firstInput = form.querySelector('input[name="contact_first_name"]');
    var lastInput = form.querySelector('input[name="contact_last_name"]');
    var first = firstInput.value.trim();
    var last = lastInput.value.trim();
    firstInput.classList.remove("field-error");
    lastInput.classList.remove("field-error");
    emailInput.classList.remove("field-error");
    if (!name) { emailMsg.textContent = "Organization name is required."; return; }
    if (!first) { emailMsg.textContent = "First name is required."; firstInput.classList.add("field-error"); firstInput.focus(); return; }
    if (!last) { emailMsg.textContent = "Last name is required."; lastInput.classList.add("field-error"); lastInput.focus(); return; }
    if (!email) { emailMsg.textContent = "Customer admin email is required. It becomes the organization's main admin login."; return; }
    if (!validEmail(email)) { emailMsg.textContent = "Enter a valid customer admin email address."; emailInput.classList.add("field-error"); emailInput.focus(); return; }
    var phoneInput = form.querySelector('input[name="phone"]');
    phoneInput.classList.remove("field-error");
    if (!validPhone(phoneInput.value)) { emailMsg.textContent = "A valid 10-digit phone number is required."; phoneInput.classList.add("field-error"); phoneInput.focus(); return; }
    fetch("/admin/customers/check-email?email=" + encodeURIComponent(email))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.exists) {
          emailMsg.innerHTML = "An organization with this admin email already exists: " +
            '<a href="/admin/customers/' + data.id + '">' + data.name + "</a>. " +
            "An email can belong to only one organization.";
        } else if (data && data.loginFlossbyte) {
          emailMsg.textContent = "That email is a FlossByte account. It cannot be a customer admin.";
        } else if (data && data.loginTaken) {
          emailMsg.textContent = "That email is already a login under " + data.loginOrg + ". An email can belong to only one organization.";
        } else { emailMsg.textContent = ""; show(2); }
      })
      .catch(function () { show(2); });
  }

  var locationFieldNames = ["loc_name[]", "loc_address[]", "loc_city[]", "loc_state[]", "loc_zip[]"];
  function locationBlocks() {
    var holder = document.getElementById("locationBlocks");
    return holder ? Array.prototype.slice.call(holder.querySelectorAll("[data-loc]")) : [];
  }
  function blockFields(block) {
    return locationFieldNames.map(function (n) { return block.querySelector('input[name="' + n + '"]'); }).filter(Boolean);
  }
  function validateLocations() {
    var anyStarted = false, firstBad = null, firstBadMissing = [];
    locationBlocks().forEach(function (block) {
      var fields = blockFields(block);
      fields.forEach(function (f) { f.classList.remove("field-error"); });
      if (!fields.some(function (f) { return f.value.trim(); })) return;
      anyStarted = true;
      var missing = fields.filter(function (f) { return !f.value.trim(); });
      if (missing.length && !firstBad) { firstBad = missing[0]; firstBadMissing = missing; }
    });
    if (!anyStarted) {
      var firstName = form.querySelector('input[name="loc_name[]"]');
      if (locationMsg) locationMsg.textContent = "At least one office location is required.";
      if (firstName) { firstName.classList.add("field-error"); firstName.focus(); }
      return false;
    }
    if (firstBad) {
      if (locationMsg) locationMsg.textContent = "Every location needs a name, street address, city, state, and ZIP. Fill in the missing fields, or remove the extra location.";
      firstBadMissing.forEach(function (f) { f.classList.add("field-error"); });
      firstBad.focus();
      return false;
    }
    if (locationMsg) locationMsg.textContent = "";
    return true;
  }
  function checkLocationThenAdvance() { if (validateLocations()) show(3); }

  // Extra location blocks can be removed again (an accidental click on
  // "Add another location" should not trap anyone). The remove button
  // hides itself when only one block remains.
  function syncRemoveButtons() {
    var blocks = locationBlocks();
    blocks.forEach(function (block) {
      var btn = block.querySelector(".remove-location");
      if (btn) btn.style.display = blocks.length > 1 ? "" : "none";
    });
  }
  var locationHolder = document.getElementById("locationBlocks");
  if (locationHolder) {
    locationHolder.addEventListener("click", function (event) {
      var btn = event.target.closest(".remove-location");
      if (!btn) return;
      var block = btn.closest("[data-loc]");
      if (block && locationBlocks().length > 1) {
        block.remove();
        if (locationMsg) locationMsg.textContent = "";
        syncRemoveButtons();
        syncLocationSelects();
      }
    });
    if (window.MutationObserver) new MutationObserver(syncRemoveButtons).observe(locationHolder, { childList: true });
    syncRemoveButtons();
  }

  // Step 4 starts empty (the users are optional): the "+ Add user" button
  // adds a block, and every block can be removed again, down to zero.
  var loginBlocksEl = document.getElementById("loginBlocks");
  if (loginBlocksEl) {
    loginBlocksEl.addEventListener("click", function (event) {
      var btn = event.target.closest(".remove-login");
      if (!btn) return;
      var block = btn.closest("div");
      if (block) block.remove();
      if (loginMsg) loginMsg.textContent = "";
    });
  }

  form.addEventListener("input", function (event) {
    if (locationFieldNames.indexOf(event.target.name) >= 0 && event.target.value.trim()) {
      event.target.classList.remove("field-error");
      if (locationMsg) locationMsg.textContent = "";
    }
    if (event.target.name === "login_email[]" && validEmail(event.target.value.trim())) {
      event.target.classList.remove("field-error");
      if (loginMsg) loginMsg.textContent = "";
    }
    if (event.target.name === "contact_email" && validEmail(event.target.value.trim())) {
      event.target.classList.remove("field-error");
    }
    if (event.target.name === "phone" && validPhone(event.target.value)) {
      event.target.classList.remove("field-error");
    }
  });
  form.addEventListener("submit", function (event) {
    var phoneInput = form.querySelector('input[name="phone"]');
    if (!validPhone(phoneInput.value)) {
      event.preventDefault();
      show(1);
      emailMsg.textContent = "A valid 10-digit phone number is required.";
      phoneInput.classList.add("field-error");
      phoneInput.focus();
      return;
    }
    if (!validateLocations()) { event.preventDefault(); show(2); return; }
    // Additional users are optional, but a block the admin started
    // filling in must be complete: a valid email (the field is marked
    // required) plus first and last name. A completely untouched block
    // is ignored.
    var badField = null, badWhy = "";
    form.querySelectorAll("#loginBlocks > div").forEach(function (block) {
      var email = block.querySelector('input[name="login_email[]"]');
      var first = block.querySelector('input[name="login_first[]"]');
      var middle = block.querySelector('input[name="login_middle[]"]');
      var last = block.querySelector('input[name="login_last[]"]');
      [email, first, last].forEach(function (el) { if (el) el.classList.remove("field-error"); });
      if (badField) return;
      var started = [email, first, middle, last].some(function (el) { return el && el.value.trim(); });
      if (!started) return;
      if (!email || !email.value.trim()) { badField = email; badWhy = "Email is required for each additional user once you start adding one."; }
      else if (!validEmail(email.value.trim())) { badField = email; badWhy = "Enter a valid email address for each additional user."; }
      else if (first && !first.value.trim()) { badField = first; badWhy = "First and last name are required for each additional user."; }
      else if (last && !last.value.trim()) { badField = last; badWhy = "First and last name are required for each additional user."; }
    });
    if (badField) {
      event.preventDefault();
      show(4);
      if (loginMsg) loginMsg.textContent = badWhy;
      badField.classList.add("field-error");
      badField.focus();
      return;
    }
  });

  back.addEventListener("click", function () { if (current > 1) show(current - 1); });
  next.addEventListener("click", function () {
    if (current === 1) checkEmailThenAdvance();
    else if (current === 2) checkLocationThenAdvance();
    else if (current < 4) show(current + 1);
  });

  var addLoginBtn = document.getElementById("addLoginBtn");
  var loginHolder = document.getElementById("loginBlocks");
  var loginTpl = document.getElementById("loginTemplate");
  if (addLoginBtn && loginHolder && loginTpl) {
    addLoginBtn.addEventListener("click", function () {
      loginHolder.appendChild(loginTpl.content.firstElementChild.cloneNode(true));
      syncLocationSelects();
    });
  }
  show(1);
})();
