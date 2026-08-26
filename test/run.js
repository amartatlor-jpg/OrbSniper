/*!
 * OrbSniper - checks that run without Discord, Electron or a network.
 * node test/run.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
// Line endings are normalised because a checkout can be CRLF, and in JavaScript
// "." does not match \r - it counts as a line terminator. Without this, every
// regex here silently stops matching on a Windows checkout.
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log("  ok   " + name); })
    .catch((e) => { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message ? e.message : e)); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// Loads I18N/LANGS out of the renderer bundle without a browser.
function loadI18N() {
  const s = {};
  new Function("g", read("renderer/i18n.js") + "\ng.I18N = I18N; g.LANGS = LANGS;")(s);
  return s;
}

// Pulls a top-level function out of main.js so it can be exercised directly.
// main.js requires electron on load, so it cannot simply be require()d here.
function grabFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start !== -1, `function ${name} not found in main.js`);
  const end = source.indexOf("\n}", start);
  assert(end !== -1, `end of ${name} not found`);
  return source.slice(start, end + 2);
}

// Fake webpack registry using export names that are deliberately NOT the ones
// the old engine hardcoded. If the shape-based lookup works, the minified
// names are irrelevant - which is the whole point of the change.
function fakeDiscord(opts) {
  opts = opts || {};
  const store = Object.assign(
    Object.create({ getQuest() { return null; } }),
    { quests: opts.quests || new Map() }
  );
  const flux = Object.create({ dispatch() {}, subscribe() {}, unsubscribe() {} });

  const modules = {
    a1: { exports: { zZ: { get() {}, post() {}, put() {}, patch() {} } } },
    a2: { exports: { qQ7: flux } },
    a3: { exports: { Wp: store } },
    // decoy: has getQuest but no quest map, must not win
    a4: { exports: { Kk: Object.create({ getQuest() { return null; } }) } },
    a5: { exports: { mN: Object.create({ getRunningGames() { return []; }, getGameForPID() {} }) } },
    a6: { exports: { pL: Object.create({ getStreamerActiveStreamMetadata() {} }) } },
    a7: { exports: { rT: Object.create({ getSortedPrivateChannels() { return []; } }) } },
    a8: { exports: { vB: Object.create({ getAllGuilds() { return {}; } }) } },
    // hostile module: touching it throws, the scan must survive
    a9: { get exports() { throw new Error("boom"); } }
  };
  if (opts.empty) for (const k of Object.keys(modules)) delete modules[k];

  const wpRequire = { c: modules };
  const chunk = [];
  chunk.push = function (arg) {
    if (Array.isArray(arg) && typeof arg[2] === "function") return arg[2](wpRequire);
    return Array.prototype.push.call(this, arg);
  };
  chunk.pop = function () {};
  return chunk;
}

// Runs quest.js in a sandbox and collects the events it emits.
async function runEngine(opts) {
  const events = [];
  const sandbox = {
    console: {
      log(msg) {
        if (typeof msg === "string" && msg.startsWith("__ORBSNIPER__")) {
          try { events.push(JSON.parse(msg.slice("__ORBSNIPER__".length))); } catch (_) {}
        }
      },
      error() {}
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Symbol, Math, Date, JSON, Map, Set, Object, Array, String, Number, Promise, RegExp, Error
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (!(opts && opts.noWebpack)) sandbox.webpackChunkdiscord_app = fakeDiscord(opts || {});

  const ctx = vm.createContext(sandbox);
  const src = read("quest.js").replace("__ORB_SESSION__", "test-session");
  vm.runInContext(src, ctx, { filename: "quest.js" });

  await sleep(250);
  if (sandbox.window.__ORB__) sandbox.window.__ORB__.stop = true;
  await sleep(50);
  return { events, sandbox };
}

(async function main() {
  console.log("\nOrbSniper test suite\n");

  console.log("syntax");
  for (const f of ["main.js", "preload.js", "quest.js", "renderer/app.js", "renderer/i18n.js", "test/run.js"]) {
    await check(f + " parses", () => {
      execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
    });
  }

  console.log("\ntranslations");
  const { I18N, LANGS } = loadI18N();
  await check("every language in LANGS has a dictionary", () => {
    for (const l of LANGS) assert(I18N[l.code], `no dictionary for ${l.code}`);
  });
  await check("all languages share the exact same key set", () => {
    const ref = Object.keys(I18N.ru).sort();
    for (const [code, dict] of Object.entries(I18N)) {
      const keys = Object.keys(dict).sort();
      const missing = ref.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !ref.includes(k));
      assert(!missing.length && !extra.length,
        `${code}: missing [${missing.join(",")}] extra [${extra.join(",")}]`);
    }
  });
  await check("no empty strings and no leftover placeholders", () => {
    for (const [code, dict] of Object.entries(I18N)) {
      for (const [k, v] of Object.entries(dict)) {
        assert(typeof v === "string" && v.trim().length > 0, `${code}.${k} is empty`);
        assert(!/\{\d+\}\s*\{\d+\}\{/.test(v), `${code}.${k} looks malformed`);
      }
    }
  });
  await check("placeholder counts match the Russian source", () => {
    const count = (s) => new Set((s.match(/\{\d\}/g) || [])).size;
    for (const [code, dict] of Object.entries(I18N)) {
      if (code === "ru") continue;
      for (const k of Object.keys(I18N.ru)) {
        assert(count(dict[k]) === count(I18N.ru[k]),
          `${code}.${k} has ${count(dict[k])} placeholders, ru has ${count(I18N.ru[k])}`);
      }
    }
  });
  await check("every key used in code exists in the dictionary", () => {
    const code = read("renderer/app.js") + read("main.js") + read("renderer/index.html");
    const used = new Set();
    for (const m of code.matchAll(/\bt\(\s*"([a-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of code.matchAll(/\bsay\(\s*"([a-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of code.matchAll(/data-i18n="([a-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of code.matchAll(/"((?:l_|chk_|hint_|st_|fin_)[a-z0-9_]+)"/g)) used.add(m[1]);
    const missing = [...used].filter((k) => !(k in I18N.ru));
    assert(!missing.length, "missing keys: " + missing.join(", "));
  });

  console.log("\nengine <-> UI contract");
  await check("renderer handles every event the engine can emit", () => {
    const quest = read("quest.js");
    const emitted = new Set();
    for (const m of quest.matchAll(/ev:\s*"([a-z_]+)"/g)) emitted.add(m[1]);
    for (const m of quest.matchAll(/die\(\s*"([a-z_]+)"/g)) emitted.add(m[1]);
    // handled either by the launcher or by the renderer's EVENTS table
    const app = read("renderer/app.js");
    const handledInUI = new Set();
    const table = app.slice(app.indexOf("const EVENTS"), app.indexOf("function onEngineEvent"));
    for (const m of table.matchAll(/^\s{2}([a-z_]+):/gm)) handledInUI.add(m[1]);
    const launcherOnly = new Set(["progress", "tally", "all_done", "alive"]);
    const unhandled = [...emitted].filter((e) => !handledInUI.has(e) && !launcherOnly.has(e));
    assert(!unhandled.length, "events with no UI handling: " + unhandled.join(", "));
  });
  await check("launcher forwards the events the renderer expects", () => {
    const main = read("main.js");
    for (const ch of ["sniper:event", "sniper:progress", "sniper:tally", "sniper:done"]) {
      assert(main.includes(`"${ch}"`), `main.js never sends ${ch}`);
    }
    const preload = read("preload.js");
    for (const ch of ["sniper:event", "sniper:progress", "sniper:tally", "sniper:done", "sniper:say", "sniper:phase", "sniper:running", "sniper:log"]) {
      assert(preload.includes(`"${ch}"`), `preload.js never bridges ${ch}`);
    }
  });

  console.log("\nDiscord module lookup (the reason it failed on other machines)");
  await check("finds every store despite unknown minified export names", async () => {
    const { events } = await runEngine();
    const failed = events.find((e) => e.ev === "modules_failed");
    assert(!failed, "modules_failed: " + (failed && failed.missing));
    assert(events.some((e) => e.ev === "started"), "engine never reported 'started'");
  });
  await check("survives a module whose exports getter throws", async () => {
    const { events } = await runEngine();
    assert(!events.some((e) => e.ev === "crashed"), "engine crashed on a hostile module");
  });
  await check("picks the store that actually holds the quest map", async () => {
    const quests = new Map();
    const { events } = await runEngine({ quests });
    assert(!events.some((e) => e.ev === "modules_failed"), "decoy store won the lookup");
    assert(events.some((e) => e.ev === "tally"), "never produced a tally, so the map was wrong");
  });
  await check("reports missing modules instead of throwing", async () => {
    const { events } = await runEngine({ empty: true });
    const f = events.find((e) => e.ev === "modules_failed");
    assert(f, "no modules_failed event");
    assert(!events.some((e) => e.ev === "crashed"), "crashed instead of reporting");
  });
  await check("reports a missing webpack cleanly", async () => {
    const { events } = await runEngine({ noWebpack: true });
    const f = events.find((e) => e.ev === "modules_failed");
    assert(f && f.missing === "webpack", "did not report the webpack case");
  });
  await check("never claims completion when it actually failed", async () => {
    const { events } = await runEngine({ empty: true });
    assert(!events.some((e) => e.ev === "all_done"),
      "a failed run still emitted all_done - the old false-completion bug");
  });
  await check("a second injection evicts the first instead of lying", async () => {
    const { events } = await runEngine();
    assert(!events.some((e) => e.ev === "dup"), "fresh run should not report dup");
  });

  console.log("\nDiscord version picking");
  const mainSrc = read("main.js");
  await check("newest app-* build wins", () => {
    const ctx = { };
    vm.createContext(ctx);
    vm.runInContext(grabFunction(mainSrc, "versionTuple") + "\n" + grabFunction(mainSrc, "compareVersions"), ctx);
    const folders = ["app-1.0.887", "app-1.0.9013", "app-1.0.9200", "app-1.0.10001"];
    const sorted = folders.slice().sort(ctx.compareVersions);
    assert(sorted[0] === "app-1.0.10001",
      "sorted to " + sorted.join(", ") + " - oldest build would be launched");
  });
  await check("version comparison handles odd names", () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(grabFunction(mainSrc, "versionTuple") + "\n" + grabFunction(mainSrc, "compareVersions"), ctx);
    assert(ctx.compareVersions("app-2.0.0", "app-1.9.9") < 0, "major version ignored");
    assert(typeof ctx.compareVersions("weird", "app-1.0.0") === "number", "threw on a junk name");
  });

  console.log("\nhardening regressions");
  await check("no hardcoded C:\\Windows escape bug", () => {
    assert(!/"C:\\W/.test(mainSrc), 'found "C:\\Windows" - \\W is not an escape and collapses to C:Windows');
  });
  await check("AppData is read from the environment", () => {
    assert(mainSrc.includes("process.env.LOCALAPPDATA"), "LOCALAPPDATA not used");
    assert(mainSrc.includes("process.env.APPDATA"), "APPDATA not used");
  });
  await check("all Discord branches are searched", () => {
    for (const b of ["DiscordPTB", "DiscordCanary"]) {
      assert(mainSrc.includes(b), b + " is never looked for");
    }
  });
  await check("a busy debug port is not fatal", () => {
    assert(mainSrc.includes("choosePort"), "no alternative port selection");
    assert(!mainSrc.includes("chk_port_foreign"), "still treats a foreign port holder as fatal");
  });
  await check("kill failure is not decided by localised text", () => {
    assert(!/Отказано/.test(mainSrc), "still matches Russian taskkill output that arrives in another codepage");
  });
  await check("every failure path clears the running flag", () => {
    assert(mainSrc.includes("function fail("), "no single failure helper");
    const bad = mainSrc.match(/phase\("error"\)/g) || [];
    assert(bad.length <= 2, "phase('error') is set in " + bad.length + " places instead of going through fail()");
  });
  await check("engine control flags are namespaced and session-checked", () => {
    assert(mainSrc.includes("window.__ORB__"), "does not use the new control object");
    assert(mainSrc.includes("__ORB__.session"), "injection is not verified by session id");
  });
  await check("Discord settings are backed up and never clobbered", () => {
    assert(mainSrc.includes(".orbsniper.bak"), "no backup before writing Discord settings");
    assert(mainSrc.includes("l_settings_odd"), "damaged settings file is not reported");
  });

  console.log("\nquest engine safety");
  const questSrc = read("quest.js");
  // Comments describe the bugs that were fixed, so they must not be searched.
  const questCode = questSrc
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s+\/\/\s.*$/, ""))
    .join("\n");

  await check("no unguarded api call inside a loop", () => {
    const lines = questCode.split("\n");
    const offenders = [];
    lines.forEach((line, i) => {
      if (!/await api\.(post|get)\(/.test(line)) return;
      // guarded by a try on this line, or by one opened just above
      if (/try\s*\{/.test(line)) return;
      const before = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
      const opens = (before.match(/try\s*\{/g) || []).length;
      const closes = (before.match(/\}\s*catch/g) || []).length;
      if (opens <= closes) offenders.push(i + 1);
    });
    assert(!offenders.length, "unguarded api calls on lines " + offenders.join(", "));
  });
  await check("every async worker carries a catch", () => {
    const workers = questCode.match(/\}\)\(\)(\.catch\()?/g) || [];
    const withCatch = workers.filter((w) => w.includes(".catch(")).length;
    assert(workers.length > 0, "no async workers found");
    assert(withCatch >= 3, `only ${withCatch} of ${workers.length} async workers have a catch`);
  });
  await check("processQuest always settles", () => {
    assert(questCode.includes("const guard = setTimeout(() => settle("), "no hard time limit on a quest");
    assert(questCode.includes("if (settled) return;"), "no settle guard");
  });
  await check("optional chaining on the activity heartbeat response", () => {
    assert(!/res\.body\.progress\.PLAY_ACTIVITY\.value/.test(questCode),
      "still dereferences the activity response without guards");
    assert(/res\?\.body\?\.progress\?\.PLAY_ACTIVITY\?\.value/.test(questCode),
      "the guarded form is missing");
  });
  await check("does not delete window.$", () => {
    assert(!/delete window\.\$/.test(questCode), "still mutates the page's global $");
  });
  await check("no polled globals left over from the old protocol", () => {
    for (const g of ["__QUEST_STATUS__", "__QUEST_TALLY__", "__QUEST_AUTO_DONE__", "__QUEST_WATCHER__"]) {
      assert(!questCode.includes(g), g + " is still there - the polling protocol was not removed");
      assert(!mainSrc.includes(g), g + " is still polled by the launcher");
    }
  });

  await check("every API call goes through the shape-probing wrapper", () => {
    const direct = questCode.split("\n").filter((l) => /\bapi\.(post|get)\s*\(/.test(l));
    assert(direct.length === 0,
      "quest.js calls api." + (direct[0] || "").trim() + " directly - a client that wants " +
      "(url, {body}) would get the object stringified into the request path");
    assert(/const apiPost = /.test(questCode) && /const apiGet = /.test(questCode),
      "the apiPost/apiGet wrappers are missing");
  });

  await check("a wrong call shape is retried with the other one", async () => {
    // Two fake clients, one per signature. Whichever we guess wrong must be
    // detected by the 404 HTML page and retried the other way round.
    const HTML = '<!DOCTYPE html><html><head><title>Page Not Found | Discord</title></head></html>';
    const src = questCode.slice(questCode.indexOf("let apiStyle"), questCode.indexOf("const apiPost"));

    for (const shape of ["object", "positional"]) {
      const api = {
        async post(a, b) {
          const objectCall = typeof a !== "string";
          if ((shape === "object") !== objectCall) return { status: 404, body: HTML };
          return { status: 200, body: { ok: true, url: objectCall ? a.url : a } };
        }
      };
      const ctx = { api, module: {} };
      vm.createContext(ctx);
      vm.runInContext(src + "\nmodule.post = (u, b) => request('post', u, b);", ctx);

      const res = await ctx.module.post("/quests/1/enroll", { location: 11 });
      assert(res.status === 200, shape + " client: wrapper never found a working shape");
      assert(res.body.url === "/quests/1/enroll", shape + " client: wrong url reached the API");
    }
  });

  await check("an error page never reaches the console", () => {
    const HTML = '<!DOCTYPE html><html lang="ru"><head><title>Page Not Found</title></head>' +
                 "<body>" + "<div>filler</div>".repeat(400) + "</body></html>";
    const src = questCode.slice(questCode.indexOf("const clean ="), questCode.indexOf("const isCaptcha"));
    const ctx = { module: {} };
    vm.createContext(ctx);
    vm.runInContext(src + "\nmodule.clean = clean; module.describe = describe;", ctx);

    for (const out of [ctx.module.clean(HTML), ctx.module.describe(HTML), ctx.module.describe({ body: HTML })]) {
      assert(!/<[a-z!]/i.test(out), "markup leaked into the message: " + out.slice(0, 80));
      assert(out.length <= 200, "message is " + out.length + " chars - an error page would flood the log");
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
