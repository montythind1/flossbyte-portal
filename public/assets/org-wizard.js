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
  var current = 1;

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
    var email = form.querySelector('input[name="contact_email"]').value.trim();
    var name = form.querySelector('input[name="name"]').value.trim();
    if (!name) { emailMsg.textContent = "Organization name is required."; return; }
    if (!email) { emailMsg.textContent = "Customer admin email is required. It becomes the organization's main admin login."; return; }
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

  function locationInputs() {
    return Array.prototype.slice.call(form.querySelectorAll('input[name="loc_name[]"]'));
  }
  function hasLocation() {
    return locationInputs().some(function (input) { return input.value.trim(); });
  }
  function checkLocationThenAdvance() {
    var inputs = locationInputs();
    if (hasLocation()) {
      if (locationMsg) locationMsg.textContent = "";
      inputs.forEach(function (input) { input.classList.remove("field-error"); });
      show(3);
      return;
    }
    if (locationMsg) locationMsg.textContent = "At least one office location is required.";
    if (inputs[0]) { inputs[0].classList.add("field-error"); inputs[0].focus(); }
  }
  form.addEventListener("input", function (event) {
    if (event.target.name === "loc_name[]" && event.target.value.trim()) {
      if (locationMsg) locationMsg.textContent = "";
      locationInputs().forEach(function (input) { input.classList.remove("field-error"); });
    }
  });
  form.addEventListener("submit", function (event) {
    if (!hasLocation()) {
      event.preventDefault();
      show(2);
      checkLocationThenAdvance();
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
