/*!
 * OrbSniper v1.5.0 - Discord Orb farmer (GUI)
 * Copyright (c) 2026 synaps_ss - tg: @synaps_ss
 * Licensed under MIT. Use at your own risk. Violates Discord ToS.
 */

const { app, BrowserWindow, ipcMain, clipboard, shell } = require("electron");

const DONATE_ADDRESS = "TJXGAkovUoA2z9C7mWBiB9SGLVQu6oSsf";
const { execSync, exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const WebSocket = require("ws");

const VERSION = "1.5.0";
const PORT = 9222;

let win = null;
const state = {
  running: false,
  ws: null,
  msgId: 0,
  readinessIds: new Set(),
  statusIds: new Set(),
  tallyIds: new Set(),
  doneIds: new Set(),
  injected: false,
  poll: null
};

// ---------- UI helpers ----------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function uiLog(msg) { send("sniper:log", msg); }
function say(key, level, ...args) { send("sniper:say", { key, level, args }); }
function phase(p) { send("sniper:phase", p); }

// ---------- Discord launcher logic ----------
function findDiscordExe() {
  const base = path.join(os.homedir(), "AppData", "Local", "Discord");
  const candidates = [];
  try {
    for (const entry of fs.readdirSync(base)) {
      if (entry.startsWith("app-")) candidates.push(path.join(base, entry, "Discord.exe"));
    }
  } catch (_) {}
  candidates.push("C:\\Program Files\\Discord\\Discord.exe");
  candidates.sort((a, b) => {
    const va = (a.match(/app-(\d+)/) || [0, 0])[1];
    const vb = (b.match(/app-(\d+)/) || [0, 0])[1];
    return vb - va;
  });
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function enableDevTools() {
  try {
    const settingsPath = path.join(os.homedir(), "AppData", "Roaming", "discord", "settings.json");
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch (_) {}
    }
    settings.DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING = true;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (_) {}
}

function discordPids() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Discord.exe" /FO CSV /NH', { encoding: "utf8" });
    return out.split("\n")
      .map((l) => l.split('","')[1])
      .filter((x) => x && /^\d+$/.test(x.trim()))
      .map((x) => parseInt(x, 10));
  } catch (_) { return []; }
}

function killDiscord() {
  try { execSync("taskkill /F /IM Discord.exe /T", { stdio: "ignore" }); } catch (_) {}
}

// Kills Discord and waits until the processes are actually gone.
// A fixed sleep is not enough: if one is still alive, the new instance just
// forwards its arguments to it and the debug port never opens.
async function killDiscordAndWait(timeoutMs = 15000) {
  const started = Date.now();
  let attempt = 0;

  while (Date.now() - started < timeoutMs) {
    const pids = discordPids();
    if (pids.length === 0) return true;

    attempt++;
    killDiscord();
    if (attempt > 2) {
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore" }); } catch (_) {}
      }
    }
    await sleep(700);
  }
  return discordPids().length === 0;
}

// Returns the PID holding the port, or 0.
function pidOnPort(port) {
  try {
    const out = execSync(`netstat -ano -p TCP | findstr LISTENING | findstr :${port}`, { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.includes(`:${port}`));
    if (!line) return 0;
    const parts = line.trim().split(/\s+/);
    const pid = parseInt(parts[parts.length - 1], 10);
    return Number.isFinite(pid) ? pid : 0;
  } catch (_) { return 0; }
}

function processName(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: "utf8" });
    const m = out.match(/^"([^"]+)"/);
    return m ? m[1] : "";
  } catch (_) { return ""; }
}

// Frees the debug port. Returns "free" | "killed" | "foreign" | "stuck".
async function freePort(port) {
  const pid = pidOnPort(port);
  if (!pid) return "free";

  const name = processName(pid);
  if (!/discord/i.test(name)) return "foreign";

  try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore" }); } catch (_) {}
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    if (!pidOnPort(port)) return "killed";
  }
  return "stuck";
}

// Launching through cmd's `start` swallows failures; spawn tells us if it broke.
function launchDiscord(exe) {
  try {
    const child = spawn(exe, [`--remote-debugging-port=${PORT}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return true;
  } catch (e) {
    uiLog("[!] Failed to launch Discord: " + (e?.message || e));
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One quick look at the debug port — is a usable Discord page already there?
async function probeMainPage() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: ctl.signal });
    clearTimeout(timer);
    const targets = await res.json();
    return targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl && /discord\.com\/(app|channels)/.test(t.url)) || null;
  } catch (_) { return null; }
}

// Waits for the Discord window to show up on the debug port.
// Reports progress so the app doesn't look frozen while it waits.
async function waitForMainPage(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let sawPort = false;
  let lastNotice = 0;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      if (!sawPort) { sawPort = true; say("l_portup", "ok"); }

      const main = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl && /discord\.com\/(app|channels)/.test(t.url));
      if (main) return main;

      const loggedIn = targets.some((t) => t.type === "page" && /discord\.com/.test(t.url));
      const waited = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
      if (loggedIn && waited - lastNotice >= 15) {
        lastNotice = waited;
        say("l_waitlogin", "warn");
      }
    } catch (_) {
      const waited = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
      if (waited - lastNotice >= 10) {
        lastNotice = waited;
        say("l_waiting", "info", String(waited));
      }
    }
    await sleep(1500);
  }
  return null;
}

function evalInPage(expression) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return -1;
  ws.send(JSON.stringify({ id: ++state.msgId, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  return state.msgId;
}

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  state.ws = ws;
  state.msgId = 0;
  state.readinessIds.clear();
  state.statusIds.clear();
  state.tallyIds.clear();
  state.doneIds.clear();
  state.injected = false;

  ws.on("open", () => {
    let attempts = 0;
    const readyPoll = setInterval(() => {
      attempts++;
      if (state.injected || ws.readyState !== WebSocket.OPEN) { clearInterval(readyPoll); return; }
      if (attempts > 60) {
        clearInterval(readyPoll);
        uiLog("[!] Webpack never became ready. Restart Discord and try again.");
        phase("error");
        state.running = false;
        return;
      }
      state.readinessIds.add(evalInPage("typeof webpackChunkdiscord_app !== 'undefined'"));
    }, 2000);
  });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }

    if (msg.id && state.readinessIds.has(msg.id)) {
      state.readinessIds.delete(msg.id);
      if (msg.result?.result?.value === true && !state.injected) {
        state.injected = true;
        phase("farming");
        uiLog("[вњ“] Injected. Goblin mode: ON.");
        ws.send(JSON.stringify({ id: ++state.msgId, method: "Runtime.enable" }));
        const questCode = fs.readFileSync(path.join(__dirname, "quest.js"), "utf8");
        ws.send(JSON.stringify({ id: ++state.msgId, method: "Runtime.evaluate", params: { expression: questCode, returnByValue: true } }));

        state.poll = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          // Tag every request so the reply can't be mistaken for another one.
          state.statusIds.add(evalInPage("window.__QUEST_STATUS__ || ''"));
          state.tallyIds.add(evalInPage("window.__QUEST_TALLY__ || ''"));
          state.doneIds.add(evalInPage("window.__QUEST_AUTO_DONE__ === true"));
        }, 3000);
      }
      return;
    }

    if (msg.method === "Runtime.consoleAPICalled") {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (args.includes("[quest-auto]")) uiLog(args);
    }

    if (msg.method === "Runtime.exceptionThrown") {
      const desc = msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "";
      if (desc.includes("quest-auto")) uiLog("[!] " + desc.split("\n")[0]);
    }
  });

  ws.on("close", () => {
    if (state.poll) { clearInterval(state.poll); state.poll = null; }
    uiLog("[i] Debug connection closed.");
  });

  ws.on("error", (e) => {
    uiLog("[!] WebSocket error: " + e.message);
  });

  // status + done forwarding
  let lastStatus = "";
  let lastTally = "";
  const handler = (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (!msg.id || !msg.result) return;
    const val = msg.result.result?.value;

    if (state.tallyIds.delete(msg.id)) {
      if (typeof val === "string" && val.startsWith("{") && val !== lastTally) {
        lastTally = val;
        try { send("sniper:tally", JSON.parse(val)); } catch (_) {}
      }
      return;
    }

    if (state.statusIds.delete(msg.id)) {
      if (typeof val === "string" && val && val !== lastStatus) {
        lastStatus = val;
        send("sniper:status", val);
      }
      return;
    }

    if (state.doneIds.delete(msg.id)) {
      if (val === true) {
        send("sniper:done", true);
        if (state.poll) { clearInterval(state.poll); state.poll = null; }
      }
      return;
    }
  };
  ws.on("message", handler);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => { try { sock.destroy(); } catch (_) {} resolve(v); };
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

function canReachDiscord() {
  return new Promise((resolve) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    fetch("https://discord.com/api/v9/gateway", { signal: ctl.signal })
      .then((r) => { clearTimeout(timer); resolve(r.ok || r.status === 401); })
      .catch(() => { clearTimeout(timer); resolve(false); });
  });
}

function settingsWritable() {
  try {
    const dir = path.join(os.homedir(), "AppData", "Roaming", "discord");
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".orbsniper-probe");
    fs.writeFileSync(probe, "1");
    fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
}

// Checks everything we need before launching.
// Returns the Discord.exe path, or null when we can't continue.
async function preflight() {
  say("chk_start", "info");
  let fatal = false;

  const exe = findDiscordExe();
  if (exe) say("chk_discord_ok", "ok", exe);
  else { say("chk_discord_missing", "err"); fatal = true; }

  if (settingsWritable()) say("chk_settings_ok", "ok");
  else { say("chk_settings_fail", "err"); fatal = true; }

  // Being busy is only a problem when something other than Discord holds it.
  const holder = pidOnPort(PORT);
  if (!holder) {
    say("chk_port_free", "ok", String(PORT));
  } else {
    const name = processName(holder);
    if (/discord/i.test(name)) {
      say("chk_port_busy", "warn", String(PORT));
    } else {
      say("chk_port_foreign", "err", String(PORT), name || String(holder));
      fatal = true;
    }
  }

  const online = await canReachDiscord();
  if (online) say("chk_net_ok", "ok");
  else { say("chk_net_fail", "err"); fatal = true; }

  if (fatal) { say("chk_stop", "err"); return null; }
  say("chk_pass", "ok");
  return exe;
}

async function runFlow() {
  if (state.running) return;
  state.running = true;
  send("sniper:running", true);
  try {
    const exe = await preflight();
    if (!exe) {
      phase("error");
      state.running = false;
      send("sniper:running", false);
      return;
    }

    // If Discord is already up on the debug port, skip the restart entirely.
    // Faster, and avoids the whole class of "it didn't come back up" failures.
    const alive = await probeMainPage();
    if (alive) {
      say("l_already", "ok");
      phase("connecting");
      connect(alive);
      return;
    }

    phase("closing");

    const portState = await freePort(PORT);
    if (portState === "foreign") {
      say("chk_port_foreign", "err", String(PORT));
      phase("error");
      state.running = false;
      send("sniper:running", false);
      return;
    }
    if (portState === "killed") say("l_portfreed", "ok", String(PORT));

    say("l_closing", "info");
    const closed = await killDiscordAndWait();
    if (!closed) {
      say("l_killfail", "err");
      phase("error");
      state.running = false;
      send("sniper:running", false);
      return;
    }
    say("l_closed", "ok");
    enableDevTools();

    phase("launching");
    say("l_launching", "info");
    if (!launchDiscord(exe)) {
      phase("error");
      state.running = false;
      send("sniper:running", false);
      return;
    }

    phase("waiting");
    const target = await waitForMainPage();
    if (!target) {
      say("l_nowindow_help", "err");
      phase("error");
      state.running = false;
      send("sniper:running", false);
      return;
    }

    phase("connecting");
    connect(target);
  } catch (e) {
    uiLog("[!] Fatal: " + (e?.message || e));
    phase("error");
    state.running = false;
    send("sniper:running", false);
  }
}

// ---------- IPC ----------
function stopFlow() {
  try { evalInPage("window.__QUEST_STOP__ = true"); } catch (_) {}
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
  if (state.ws) {
    try { state.ws.removeAllListeners(); state.ws.close(); } catch (_) {}
    state.ws = null;
  }
  state.injected = false;
  state.readinessIds.clear();
  state.statusIds.clear();
  state.tallyIds.clear();
  state.doneIds.clear();
  state.running = false;
  send("sniper:running", false);
}

ipcMain.handle("sniper:start", () => { runFlow(); });

// Hard reset for when things are stuck: drop the connection, kill every Discord
// process, free the debug port, then start over from scratch.
ipcMain.handle("sniper:repair", async () => {
  say("l_repair_start", "info");
  stopFlow();

  const port = await freePort(PORT);
  if (port === "foreign") {
    say("chk_port_foreign", "err", String(PORT));
    phase("error");
    return false;
  }
  if (port === "killed") say("l_portfreed", "ok", String(PORT));

  const closed = await killDiscordAndWait(20000);
  if (!closed) {
    say("l_killfail", "err");
    phase("error");
    return false;
  }

  say("l_repair_done", "ok");
  await sleep(800);
  runFlow();
  return true;
});
ipcMain.handle("sniper:stop", () => { stopFlow(); return true; });
ipcMain.handle("sniper:skip", () => { evalInPage("window.__QUEST_SKIP__ = true"); });
ipcMain.handle("donate:copy", () => { clipboard.writeText(DONATE_ADDRESS); return true; });
ipcMain.handle("app:copy", (_e, text) => { clipboard.writeText(String(text || "")); return true; });
ipcMain.handle("app:version", () => VERSION);
ipcMain.handle("app:open", (_e, url) => {
  const u = String(url || "");
  if (!/^https:\/\//i.test(u)) return false;   // https only
  shell.openExternal(u);
  return true;
});
ipcMain.handle("win:minimize", () => { if (win) win.minimize(); });
ipcMain.handle("win:close", () => { if (win) win.close(); });

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 780,
    height: 740,
    minWidth: 600,
    minHeight: 600,
    frame: false,
    resizable: true,
    backgroundColor: "#000000",
    icon: path.join(__dirname, "icon.ico"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => app.quit());
}
