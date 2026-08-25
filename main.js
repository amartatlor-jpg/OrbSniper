/*!
 * OrbSniper v1.4.0 - Discord Orb farmer (GUI)
 * Copyright (c) 2026 synaps_ss - tg: @synaps_ss
 * Licensed under MIT. Use at your own risk. Violates Discord ToS.
 */

const { app, BrowserWindow, ipcMain, clipboard, shell } = require("electron");

const DONATE_ADDRESS = "TJXGAkovUoA2z9C7mWBiB9SGLVQu6oSsf";
const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const WebSocket = require("ws");

const VERSION = "1.4.0";
const PORT = 9222;

let win = null;
const state = {
  running: false,
  ws: null,
  msgId: 0,
  readinessIds: new Set(),
  injected: false,
  poll: null
};

// ---------- UI helpers ----------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function uiLog(msg) { send("sniper:log", msg); }
function say(key, level, arg) { send("sniper:say", { key, level, arg }); }
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

function killDiscord() {
  try { execSync("taskkill /F /IM Discord.exe /T", { stdio: "ignore" }); } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForMainPage(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const main = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl && /discord\.com\/(app|channels)/.test(t.url));
      if (main) return main;
    } catch (_) {}
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
          evalInPage("window.__QUEST_STATUS__ || ''");
          evalInPage("window.__QUEST_TALLY__ || ''");
          evalInPage("window.__QUEST_AUTO_DONE__ === true");
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
    if (!msg.id || !msg.result || state.readinessIds.has(msg.id)) return;
    const val = msg.result.result?.value;
    if (typeof val === "string" && val.startsWith("{")) {
      if (val !== lastTally) { lastTally = val; try { send("sniper:tally", JSON.parse(val)); } catch (_) {} }
      return;
    }
    if (typeof val === "string" && val && val !== lastStatus) {
      lastStatus = val;
      send("sniper:status", val);
    }
    if (val === true) {
      send("sniper:done", true);
      if (state.poll) { clearInterval(state.poll); state.poll = null; }
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

  const busy = await portInUse(PORT);
  if (busy) say("chk_port_busy", "warn", String(PORT));
  else say("chk_port_free", "ok", String(PORT));

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

    phase("closing");
    killDiscord();
    await sleep(1500);
    enableDevTools();

    phase("launching");
    exec(`start "" "${exe}" --remote-debugging-port=${PORT}`);

    phase("waiting");
    const target = await waitForMainPage();
    if (!target) {
      uiLog("[!] Main Discord window never appeared on the debug port.");
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
  state.running = false;
  send("sniper:running", false);
}

ipcMain.handle("sniper:start", () => { runFlow(); });
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
