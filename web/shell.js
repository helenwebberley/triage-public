/*
 * brand-packs / shell.js: house shell behaviour
 *
 * The interactive half of the house shell (shell.css is the look). Framework
 * agnostic: it reads the DOM and wires the four best-in-class shell behaviours so
 * every tool gets them for free, with no per-tool code:
 *
 *   1. Command palette   Cmd/Ctrl-K, or any [data-shell-open-palette] button.
 *                        Built from the sidebar nav plus a few global commands;
 *                        selecting a nav entry just clicks the real control, so it
 *                        reuses the app's own handler (SPA or server-rendered).
 *   2. Collapse rail     any [data-shell-collapse] button toggles #layout /.layout
 *                        .nav-collapsed; state persists; collapsed items get tooltips.
 *   3. Theme             any [data-shell-theme] button toggles light/dark; persists;
 *                        defaults to the OS preference.
 *   4. Account menu      the .acct avatar button opens/closes .acct__menu, closes on
 *                        outside click.
 *
 * Extend the palette from app code:  window.Shell.registerCommand('Label', fn, 'Hint')
 *
 * House style: UK English, no em dashes.
 */
(function () {
  var root = document.documentElement;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- theme ---------- */
  var THEME_KEY = "shell:theme";
  function currentTheme() {
    return root.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function toggleTheme() {
    var next = currentTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  }
  try { var st = localStorage.getItem(THEME_KEY); if (st) root.setAttribute("data-theme", st); } catch (e) {}

  /* ---------- collapse ---------- */
  var NAV_KEY = "shell:nav";
  function layout() { return document.getElementById("layout") || $(".layout"); }
  function setCollapsed(on) {
    var l = layout(); if (!l) return;
    l.classList.toggle("nav-collapsed", !!on);
    try { localStorage.setItem(NAV_KEY, on ? "1" : "0"); } catch (e) {}
  }
  // On a phone the menu button opens and closes the drawer instead of collapsing
  // the rail; the drawer state is never remembered.
  var narrow = window.matchMedia ? window.matchMedia("(max-width: 760px)") : { matches: false };
  function setOpen(on) { var l = layout(); if (l) l.classList.toggle("nav-open", !!on); }
  function toggleCollapse() {
    var l = layout(); if (!l) return;
    if (narrow.matches) return setOpen(!l.classList.contains("nav-open"));
    setCollapsed(!l.classList.contains("nav-collapsed"));
  }
  document.addEventListener("click", function (e) {
    var l = layout(); if (!l || !l.classList.contains("nav-open")) return;
    if (e.target.closest("[data-shell-collapse]")) return;
    // Picking a page, or tapping anywhere outside the drawer, closes it.
    if (e.target.closest(".sidebar-nav a, .sidebar-nav button") || !e.target.closest(".sidebar")) setOpen(false);
  });
  try { if (localStorage.getItem(NAV_KEY) === "1") setCollapsed(true); } catch (e) {}
  function syncTips() {
    $$(".sidebar-nav a, .sidebar-nav button").forEach(function (el) {
      var l = $(".lbl", el); if (l && !el.title) el.title = l.textContent.trim();
    });
  }

  /* ---------- account menu ---------- */
  var acct = document.getElementById("acct");
  if (acct) {
    var aBtn = $(".acct__btn", acct), aMenu = $(".acct__menu", acct);
    if (aBtn && aMenu) {
      aBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = aMenu.classList.toggle("hidden");
        aBtn.setAttribute("aria-expanded", String(!open));
      });
      document.addEventListener("click", function (e) {
        if (!acct.contains(e.target)) { aMenu.classList.add("hidden"); aBtn.setAttribute("aria-expanded", "false"); }
      });
    }
  }

  $$("[data-shell-collapse]").forEach(function (b) { b.addEventListener("click", toggleCollapse); });
  $$("[data-shell-theme]").forEach(function (b) { b.addEventListener("click", toggleTheme); });

  /* ---------- command palette ---------- */
  var extra = [];
  var pal = document.createElement("div");
  pal.className = "cmdk hidden";
  pal.innerHTML =
    '<div class="cmdk__backdrop"></div>' +
    '<div class="cmdk__panel" role="dialog" aria-modal="true" aria-label="Command menu">' +
    '<input class="cmdk__input" type="text" placeholder="Search or jump to..." autocomplete="off" spellcheck="false">' +
    '<ul class="cmdk__list"></ul>' +
    '<div class="cmdk__foot"><span>&#8593;&#8595; navigate</span><span>&#8629; select</span><span>esc close</span></div>' +
    "</div>";
  document.body.appendChild(pal);
  var input = $(".cmdk__input", pal), list = $(".cmdk__list", pal);
  var filtered = [], sel = 0;

  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function collect() {
    var nav = $$(".sidebar-nav a, .sidebar-nav button").filter(function (el) {
      return !el.classList.contains("hidden") && el.offsetParent !== null;
    }).map(function (el) {
      var l = $(".lbl", el);
      return { label: (l ? l.textContent : el.textContent).trim(), el: el, hint: "Go to" };
    });
    var cmds = [{ label: "Toggle theme", run: toggleTheme, hint: "Theme" },
                { label: "Toggle sidebar", run: toggleCollapse, hint: "View" }];
    var so = document.getElementById("signout") || $("[data-shell-signout]");
    if (so) cmds.push({ label: "Sign out", run: function () { so.click(); }, hint: "Account" });
    return nav.concat(extra, cmds);
  }
  function render() {
    list.innerHTML = filtered.length ? filtered.map(function (it, i) {
      return '<li class="cmdk__item' + (i === sel ? " is-sel" : "") + '" data-i="' + i + '">' +
        "<span>" + esc(it.label) + "</span>" + (it.hint ? '<span class="cmdk__hint">' + it.hint + "</span>" : "") + "</li>";
    }).join("") : '<li class="cmdk__empty">No matches</li>';
  }
  function doFilter() {
    var q = input.value.trim().toLowerCase();
    var all = collect();
    filtered = !q ? all.slice(0, 60) : all.filter(function (it) { return it.label.toLowerCase().indexOf(q) !== -1; });
    sel = 0; render();
  }
  function activate(i) {
    var it = filtered[i]; if (!it) return;
    close();
    if (it.el) it.el.click(); else if (it.run) it.run();
  }
  function open() { pal.classList.remove("hidden"); input.value = ""; doFilter(); setTimeout(function () { input.focus(); }, 0); }
  function close() { pal.classList.add("hidden"); }

  input.addEventListener("input", doFilter);
  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); render(); scrollSel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); scrollSel(); }
    else if (e.key === "Enter") { e.preventDefault(); activate(sel); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  function scrollSel() { var el = $(".is-sel", list); if (el) el.scrollIntoView({ block: "nearest" }); }
  list.addEventListener("click", function (e) { var li = e.target.closest("[data-i]"); if (li) activate(+li.getAttribute("data-i")); });
  $(".cmdk__backdrop", pal).addEventListener("click", close);
  $$("[data-shell-open-palette]").forEach(function (b) { b.addEventListener("click", open); });
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); pal.classList.contains("hidden") ? open() : close(); }
  });

  syncTips();
  window.Shell = {
    open: open, close: close, toggleTheme: toggleTheme, toggleCollapse: toggleCollapse,
    registerCommand: function (label, run, hint) { extra.push({ label: label, run: run, hint: hint || "" }); }
  };
})();
