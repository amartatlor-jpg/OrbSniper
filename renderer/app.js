/*!
 * OrbSniper - renderer
 * (c) 2026 synaps_ss - tg: @synaps_ss
 */

const GITHUB_URL = "https://github.com/syntaxixr/OrbSniper";
const TELEGRAM_URL = "https://t.me/synaps_ss";
const TOS_URL = "https://discord.com/terms";

// Discord help centre locale codes; anything missing redirects to en-us
const POLICY_LOCALE = { ru: "ru", en: "en-us", de: "de", fr: "fr", es: "es", pl: "pl", tr: "tr", pt: "pt-br", uk: "en-us", zh: "en-us" };
const policyUrl = () =>
  `https://support.discord.com/hc/${POLICY_LOCALE[lang] || "en-us"}/articles/115002192352`;

const $ = (id) => document.getElementById(id);
const LOG_LIMIT = 400;

let lang = "ru";
let running = false;
let claimed = 0;
let stickToBottom = true;
let tally = { total: 0, done: 0, left: 0, manual: 0 };

// ---------- i18n ----------
function t(key, ...args) {
  let s = (I18N[lang] && I18N[lang][key]) || I18N.ru[key] || key;
  // split/join instead of replace: paths may contain $& patterns
  args.forEach((v, i) => { s = s.split("{" + i + "}").join(String(v)); });
  return s;
}

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  const cur = LANGS.find((l) => l.code === lang);
  $("lang-cur").textContent = cur ? cur.tag : lang.toUpperCase();
  $("btn-help").title = t("help_title");
  renderLangMenu();
  if (!running) setIdle();
}

function renderLangMenu() {
  const menu = $("lang-menu");
  menu.replaceChildren();
  for (const l of LANGS) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "option";
    b.setAttribute("aria-selected", String(l.code === lang));
    if (l.code === lang) b.className = "on";
    const name = document.createElement("span");
    name.textContent = l.label;
    const code = document.createElement("span");
    code.className = "lm-code";
    code.textContent = l.tag;
    b.append(name, code);
    b.addEventListener("click", () => {
      lang = l.code;
      try { localStorage.setItem("orbsniper.lang", lang); } catch (_) {}
      closeLangMenu();
      applyLang();
    });
    menu.append(b);
  }
}

function closeLangMenu() {
  $("lang-menu").hidden = true;
  $("lang-btn").setAttribute("aria-expanded", "false");
}

// ---------- log messages ----------
// raw engine output -> readable text in the current language
const RULES = [
  [/Discord\.exe not found/i,                 "l_nodiscord", "err"],
  [/Main Discord window never appeared/i,     "l_nowindow",  "err"],
  [/Webpack never became ready/i,             "l_notready",  "err"],
  [/Failed to locate Discord modules/i,       "l_nomodules", "err"],
  [/WebSocket error:?\s*(.*)/i,               "l_wserror",   "err"],
  [/Fatal:?\s*(.*)/i,                         "l_fatal",     "err"],
  [/Scan error:?\s*(.*)/i,                    "l_scanerror", "err"],
  [/captcha/i,                                "l_captcha",   "warn"],
  [/"(.+?)"\s*[—-]\s*no progress for 3 min/i, "l_stalled",   "warn"],
  [/"(.+?)"\s*skipped/i,                      "l_skipped",   "warn"],
  [/"(.+?)".*reward claimed|claimed.*"(.+?)"/i, "l_claimed", "ok"],
  [/"(.+?)"\s*completed/i,                    "l_completed", "ok"],
  [/"(.+?)"\s*accepted/i,                     "l_accepted",  "ok"],
  [/Injected/i,                               "l_injected",  "ok"],
  [/Watcher started/i,                        "l_watching",  "info"],
  [/Watcher stopped/i,                        "l_stopped",   "info"],
  [/Found (\d+) quests?/i,                    "l_found",     "info"],
  [/No quests in progress|Watching for new/i, "l_noquests",  "info"],
  [/Discord closed/i,                         "l_closed",    "info"],
  [/Relaunching Discord|remote debugging port/i, "l_relaunch", "info"],
  [/Debug connection closed/i,                "l_disconnected", "info"]
];

function humanize(raw) {
  const s = String(raw).replace(/^\[quest-auto\]\s*/i, "").replace(/^\[[!✓i]\]\s*/, "").trim();
  for (const [re, key, level] of RULES) {
    const m = s.match(re);
    if (m) {
      const arg = m[1] || m[2] || "";
      return { text: t(key, arg), level };
    }
  }
  // unknown line: show as-is, guess the level from markers
  const level = /^\[!\]/.test(String(raw)) || /error|failed/i.test(s) ? "err" : "info";
  return { text: s, level };
}

// ---------- state ----------
function setButtons() {
  $("btn-start").disabled = running;
  $("btn-stop").disabled = !running;
  $("btn-skip").disabled = !running;
}

function setBeacon(cls) { $("beacon").className = "beacon " + cls; }

function setStatus(title, hint, beacon, stateCls) {
  $("status-text").textContent = title;
  $("status-hint").textContent = hint;
  setBeacon(beacon || "");
  $("status").className = "status" + (stateCls ? " " + stateCls : "");
}

function setIdle() {
  running = false;
  setStatus(t("st_idle"), t("hint_idle"), "", "");
  $("bar").hidden = true;
  $("facts").hidden = true;
  setButtons();
}

function setProgress(pct) {
  $("bar").hidden = false;
  $("bar").value = pct;           // attribute, not inline style (keeps CSP strict)
}

// ---------- quest summary ----------
function renderTally(data) {
  tally = data || tally;
  const has = tally.total > 0;
  $("tally").hidden = !has;
  if (!has) return;
  $("tl-done").textContent = String(tally.done);
  $("tl-left").textContent = String(tally.left);
  $("tl-manual-n").textContent = String(tally.manual);
  $("tl-manual").hidden = !tally.manual;
}

// ---------- finish screen ----------
function showFinish() {
  $("fin-done").textContent = String(tally.done);
  $("fin-manual").textContent = String(tally.manual);
  $("fin-manual-box").hidden = !tally.manual;
  $("fin-note").hidden = !tally.manual;
  $("finish-lead").textContent = tally.manual ? t("fin_lead_manual") : t("fin_lead");
  $("finish").hidden = false;
}

function closeFinish() {
  const el = $("finish");
  el.classList.add("closing");
  setTimeout(() => { el.hidden = true; el.classList.remove("closing"); }, 240);
}

// ---------- console log ----------
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function pushLine(text, level) {
  const box = $("log");
  $("cn-body").classList.add("live");

  const last = box.lastElementChild;
  if (last && last.dataset.text === text) {
    const n = (parseInt(last.dataset.count || "1", 10) || 1) + 1;
    last.dataset.count = String(n);
    let badge = last.querySelector(".rep");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "rep";
      last.querySelector(".tx").append(badge);
    }
    badge.textContent = "×" + n;
    last.querySelector("time").textContent = nowStamp();
    return;
  }

  const line = document.createElement("div");
  line.className = "line " + level;
  line.dataset.text = text;
  const time = document.createElement("time");
  time.textContent = nowStamp();
  const tx = document.createElement("span");
  tx.className = "tx";
  tx.textContent = text;
  line.append(time, tx);
  box.append(line);

  while (box.children.length > LOG_LIMIT) box.firstElementChild.remove();

  if (stickToBottom) {
    box.scrollTop = box.scrollHeight;
    $("jump").hidden = true;
  } else {
    $("jump").hidden = false;
  }
}

function addLog(raw) {
  if (!raw) return;
  const { text, level } = humanize(raw);
  if (!text) return;
  pushLine(text, level);
  if (level === "ok" && /claim|заб|получ|награ|reward|领取|resgat|obten/i.test(text)) {
    claimed++;
    $("f-claimed").textContent = String(claimed);
    $("facts").hidden = false;
  }
}

function say(key) { pushLine(t(key), "info"); }

function logText() {
  return [...$("log").children].map((l) => {
    const rep = l.dataset.count && l.dataset.count !== "1" ? ` (x${l.dataset.count})` : "";
    return `${l.querySelector("time").textContent}  ${l.querySelector(".tx").textContent}${rep}`;
  }).join("\n");
}

// ---------- phases ----------
const PHASE_HINT = {
  closing: "hint_closing",
  launching: "hint_launching",
  waiting: "hint_waiting",
  connecting: "hint_connecting",
  farming: "hint_farming"
};

function setPhase(phase) {
  if (phase === "error") {
    running = false;
    setStatus(t("st_err"), t("hint_err"), "err", "err");
    setButtons();
    return;
  }
  running = true;
  const title = phase === "farming" ? t("st_running") : t("st_starting");
  setStatus(title, t(PHASE_HINT[phase] || "hint_starting"), "run", "");
  setButtons();
}

// ---------- current quest ----------
function updateQuest(statusStr) {
  if (!statusStr) return;

  if (statusStr.startsWith("watching") || statusStr === "idle" || statusStr === "starting") {
    $("f-target").textContent = t("f_searching");
    $("f-pct").textContent = "—";
    $("f-time").textContent = "—";
    $("facts").hidden = false;
    $("bar").hidden = true;
    return;
  }

  const m = statusStr.match(/^"(.+)"\s*\|\s*(\S+)\s*\|\s*(\d+)\/(\d+)s?\s*\|\s*(\S+)/);
  if (!m) return;

  const done = parseInt(m[3], 10);
  const total = parseInt(m[4], 10);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  setProgress(pct);
  $("facts").hidden = false;
  $("f-target").textContent = m[1];
  $("f-pct").textContent = pct + "%";
  $("f-time").textContent = m[5];
  $("status-text").textContent = t("st_running");
  $("status-hint").textContent = t("hint_quest", m[1]);
}

// ---------- toast & modals ----------
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

let openModal = null;
function showModal(id) {
  closeModal();
  openModal = $(id);
  openModal.hidden = false;
  $("scrim").hidden = false;
  openModal.setAttribute("tabindex", "-1");
  openModal.focus();
}
function closeModal() {
  if (openModal) openModal.hidden = true;
  openModal = null;
  $("scrim").hidden = true;
}

function flash(btn, labelEl, key) {
  labelEl.textContent = t("copied");
  btn.classList.add("done");
  setTimeout(() => {
    labelEl.textContent = t(key);
    btn.classList.remove("done");
  }, 1600);
}

// ---------- disclaimer ----------
// Shown on every launch: the user has to confirm the risk each time.
function closeGate() {
  const gate = $("gate");
  gate.classList.add("closing");
  setTimeout(() => { gate.hidden = true; gate.classList.remove("closing"); }, 260);
}

function initGate() {
  const gate = $("gate");
  const box = $("agree-box");
  box.checked = false;
  $("btn-agree").disabled = true;
  gate.hidden = false;

  box.addEventListener("change", (e) => {
    $("btn-agree").disabled = !e.target.checked;
  });

  $("btn-agree").addEventListener("click", () => {
    if (!box.checked) return;
    closeGate();
  });

  $("btn-quit").addEventListener("click", () => window.sniper.close());
  $("lnk-policy").addEventListener("click", () => window.sniper.openExternal(policyUrl()));
  $("lnk-tos").addEventListener("click", () => window.sniper.openExternal(TOS_URL));
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", () => {
  try {
    const saved = localStorage.getItem("orbsniper.lang");
    if (saved && I18N[saved]) lang = saved;
    else {
      const nav = (navigator.language || "ru").slice(0, 2).toLowerCase();
      if (I18N[nav]) lang = nav;
    }
  } catch (_) {}

  applyLang();
  setIdle();
  initGate();

  $("btn-min").addEventListener("click", () => window.sniper.minimize());
  $("btn-close").addEventListener("click", () => window.sniper.close());

  $("lang-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("lang-menu");
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    $("lang-btn").setAttribute("aria-expanded", String(willOpen));
  });
  document.addEventListener("click", (e) => {
    if (!$("lang-wrap").contains(e.target)) closeLangMenu();
  });

  $("btn-start").addEventListener("click", () => {
    running = true;
    claimed = 0;
    tally = { total: 0, done: 0, left: 0, manual: 0 };
    $("tally").hidden = true;
    $("finish").hidden = true;
    $("f-claimed").textContent = "0";
    setButtons();
    setStatus(t("st_starting"), t("hint_starting"), "run", "");
    say("l_begin");
    window.sniper.start();
  });

  $("btn-stop").addEventListener("click", async () => {
    await window.sniper.stop();
    setIdle();
    setStatus(t("st_stopped"), t("hint_stopped"), "", "");
    say("l_userstop");
    toast(t("st_stopped"));
  });

  $("btn-skip").addEventListener("click", () => {
    window.sniper.skip();
    say("l_userskip");
  });

  document.querySelectorAll(".f").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".f").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      const body = $("cn-body");
      body.classList.remove("f-ok", "f-err");
      if (btn.dataset.filter !== "all") body.classList.add("f-" + btn.dataset.filter);
    });
  });

  $("log").addEventListener("scroll", () => {
    const box = $("log");
    stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    if (stickToBottom) $("jump").hidden = true;
  });

  $("jump").addEventListener("click", () => {
    const box = $("log");
    box.scrollTop = box.scrollHeight;
    stickToBottom = true;
    $("jump").hidden = true;
  });

  $("btn-copylog").addEventListener("click", async () => {
    const text = logText();
    if (!text) { toast(t("m_empty")); return; }
    await window.sniper.copyText(text);
    flash($("btn-copylog"), $("copylog-label"), "copy");
  });

  $("btn-clearlog").addEventListener("click", () => {
    $("log").replaceChildren();
    $("cn-body").classList.remove("live");
    $("jump").hidden = true;
  });

  const openTg = () => window.sniper.openExternal(TELEGRAM_URL);
  const openGh = () => window.sniper.openExternal(GITHUB_URL);
  $("lnk-tg").addEventListener("click", openTg);
  $("lnk-tg2").addEventListener("click", openTg);
  $("lnk-gh").addEventListener("click", openGh);
  $("lnk-gh2").addEventListener("click", openGh);
  $("gh-handle").textContent = GITHUB_URL.replace(/^https:\/\/github\.com\//, "");

  $("btn-help").addEventListener("click", () => showModal("modal-help"));
  $("btn-donate").addEventListener("click", () => showModal("modal-donate"));
  $("scrim").addEventListener("click", closeModal);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); closeLangMenu(); if (!$("finish").hidden) closeFinish(); }
  });

  $("btn-copyaddr").addEventListener("click", async () => {
    await window.sniper.copyText($("cr-addr").textContent.trim());
    flash($("btn-copyaddr"), $("copyaddr-label"), "copy");
  });

  window.sniper.onLog(addLog);
  window.sniper.onSay(({ key, level, arg }) => pushLine(t(key, arg || ""), level || "info"));
  window.sniper.onPhase(setPhase);
  window.sniper.onStatus(updateQuest);
  window.sniper.onTally(renderTally);
  window.sniper.onRunning((isRunning) => { running = isRunning; setButtons(); });
  window.sniper.onDone(() => {
    running = false;
    setProgress(100);
    setStatus(t("st_done"), tally.manual ? t("hint_done_manual") : t("hint_done"), "ok", "done");
    setButtons();
    say(tally.manual ? "l_alldone_manual" : "l_alldone");
    showFinish();
  });

  $("btn-fin-ok").addEventListener("click", closeFinish);
  $("btn-fin-donate").addEventListener("click", () => { closeFinish(); showModal("modal-donate"); });
});
