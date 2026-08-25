/*!
 * OrbSniper v1.5.0 - Discord Orb farmer (quest engine)
 * Copyright (c) 2026 synaps_ss - tg: @synaps_ss
 * Licensed under MIT. Use at your own risk. Violates Discord ToS.
 */

// Injected into the Discord desktop client over CDP.
//
// It talks to the launcher through exactly one channel: JSON events written to
// console.log with a tag prefix. Nothing is polled, nothing is scraped out of
// human-readable text. Control flags live on window.__ORB__ and are written by
// the launcher.

(async function () {
  "use strict";

  const TAG = "__ORBSNIPER__";
  const SESSION = "__ORB_SESSION__"; // the launcher substitutes a unique id here

  const emit = (o) => {
    try { o.s = SESSION; console.log(TAG + JSON.stringify(o)); } catch (_) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- take over from a previous watcher ----------
  // Start after Stop used to race: the old watcher was still finishing a quest
  // while the new injection bailed out on the "already running" guard, and the
  // launcher was told everything was fine. Now the new one evicts the old one
  // and only gives up if it refuses to die.
  const prev = window.__ORB__;
  if (prev && prev.alive && prev.session !== SESSION) {
    prev.stop = true;
    emit({ ev: "takeover" });
    for (let i = 0; i < 40 && prev.alive; i++) await sleep(500);
    if (prev.alive) { emit({ ev: "dup" }); return; }
  }

  const ORB = { alive: true, session: SESSION, skip: false, stop: false };
  window.__ORB__ = ORB;

  const STALL_TIMEOUT_MS = 3 * 60 * 1000;   // auto-skip a quest with no progress
  const SCAN_INTERVAL_MS = 20 * 1000;       // scan cycle
  const ENROLL_COOLDOWN_MS = 3 * 60 * 1000; // wait before re-trying a failed accept
  const CLAIM_COOLDOWN_MS = 5 * 60 * 1000;  // wait before re-trying a failed claim
  const ALIVE_INTERVAL_MS = 30 * 1000;      // proof-of-life for the launcher

  // The launcher re-injects us if these stop arriving, so they must keep coming
  // even while a quest is running.
  const aliveTimer = setInterval(() => {
    if (!ORB.alive) { clearInterval(aliveTimer); return; }
    emit({ ev: "alive" });
  }, ALIVE_INTERVAL_MS);

  const die = (ev, extra) => {
    ORB.alive = false;
    clearInterval(aliveTimer);
    emit(Object.assign({ ev }, extra || {}));
  };

  try {
    // ---------- locate Discord internals ----------
    if (typeof webpackChunkdiscord_app === "undefined") {
      die("modules_failed", { missing: "webpack" });
      return;
    }

    const wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, (r) => r]);
    webpackChunkdiscord_app.pop();
    if (!wpRequire || !wpRequire.c) {
      die("modules_failed", { missing: "webpack" });
      return;
    }

    // Find modules by SHAPE, never by minified export name.
    //
    // The old code looked for exports.Bo.get, exports.Ay.getRunningGames and
    // friends. Those two-letter names are minifier output: they change whenever
    // Discord ships a new build, and they differ between stable, PTB and
    // Canary. That is why the engine worked on one machine and died on another
    // with "Failed to locate Discord modules".
    //
    // Method names survive minification, because Discord calls them by name
    // internally. So we look for an object carrying the right set of methods,
    // wherever it happens to live.
    const need = {
      api: ["get", "post", "put", "patch"],
      FluxDispatcher: ["dispatch", "subscribe", "unsubscribe"],
      QuestsStore: ["getQuest"],
      RunningGameStore: ["getRunningGames", "getGameForPID"],
      ApplicationStreamingStore: ["getStreamerActiveStreamMetadata"],
      ChannelStore: ["getSortedPrivateChannels"],
      GuildChannelStore: ["getAllGuilds"]
    };
    const found = {};

    const hasAll = (obj, names) => {
      if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return false;
      for (const n of names) {
        // typeof reaches through the prototype chain, so Flux stores (whose
        // methods live on the prototype) match without touching __proto__.
        let fn;
        try { fn = obj[n]; } catch (_) { return false; }
        if (typeof fn !== "function") return false;
      }
      return true;
    };

    const consider = (obj) => {
      if (!obj) return;
      for (const key in need) {
        if (found[key]) continue;
        if (hasAll(obj, need[key])) found[key] = obj;
      }
    };

    // One pass over every module, checking every shape against the export and
    // its first-level properties. Property access is wrapped because some
    // Discord exports are getters that throw when touched out of context.
    for (const mod of Object.values(wpRequire.c)) {
      let exp;
      try { exp = mod && mod.exports; } catch (_) { continue; }
      if (!exp) continue;
      consider(exp);
      let keys = [];
      try { keys = Object.keys(exp); } catch (_) { continue; }
      for (const k of keys) {
        let sub;
        try { sub = exp[k]; } catch (_) { continue; }
        consider(sub);
      }
    }

    // Several stores expose getQuest; the one we want also holds the quest map.
    const isQuestsStore = (c) => {
      try { return c && typeof c.getQuest === "function" && c.quests instanceof Map; }
      catch (_) { return false; }
    };
    if (!isQuestsStore(found.QuestsStore)) {
      found.QuestsStore = null;
      outer:
      for (const mod of Object.values(wpRequire.c)) {
        let exp;
        try { exp = mod && mod.exports; } catch (_) { continue; }
        if (!exp) continue;
        if (isQuestsStore(exp)) { found.QuestsStore = exp; break; }
        let keys = [];
        try { keys = Object.keys(exp); } catch (_) { continue; }
        for (const k of keys) {
          let sub;
          try { sub = exp[k]; } catch (_) { continue; }
          if (isQuestsStore(sub)) { found.QuestsStore = sub; break outer; }
        }
      }
    }

    const api = found.api;
    const FluxDispatcher = found.FluxDispatcher;
    const QuestsStore = found.QuestsStore;
    const RunningGameStore = found.RunningGameStore;
    const ApplicationStreamingStore = found.ApplicationStreamingStore;
    const ChannelStore = found.ChannelStore;
    const GuildChannelStore = found.GuildChannelStore;

    // Only these three are required for any quest at all. The rest gate
    // individual quest types and are reported per quest instead of killing the
    // whole run.
    const missing = ["api", "FluxDispatcher", "QuestsStore"].filter((k) => !found[k]);
    if (missing.length) {
      die("modules_failed", { missing: missing.join(", ") });
      return;
    }

    const manualClaim = new Set();
    const SUPPORTED = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "PLAY_ON_DESKTOP_V2", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];
    const isApp = typeof DiscordNative !== "undefined";
    const LOC_QUEST_HOME = 11;
    const PLATFORM_PC = 4;

    const taskOf = (quest) => {
      const tc = quest && quest.config && (quest.config.taskConfig || quest.config.taskConfigV2);
      return SUPPORTED.find((t) => tc && tc.tasks && tc.tasks[t] != null);
    };
    const nameOf = (quest) => quest?.config?.messages?.questName ?? "quest";

    // Discord answers with plain objects, not Errors.
    function describe(e) {
      if (!e) return "unknown";
      if (typeof e === "string") return e;
      if (e.message) return e.message;
      const status = e.status ?? e.statusCode;
      const body = e.body ?? e.response?.body;
      const detail =
        body?.message ||
        body?.errors?.[0]?.message ||
        (body && typeof body === "object" ? JSON.stringify(body).slice(0, 160) : body);
      if (status && detail) return `HTTP ${status}: ${detail}`;
      if (status) return `HTTP ${status}`;
      if (detail) return String(detail);
      try { return JSON.stringify(e).slice(0, 160); } catch (_) { return String(e); }
    }
    const isCaptcha = (x) => /captcha/i.test(String(x || ""));

    async function enroll(quest) {
      const name = nameOf(quest);
      try {
        const res = await api.post({ url: `/quests/${quest.id}/enroll`, body: { location: LOC_QUEST_HOME } });
        const t = res?.body?.type;
        if (t === "success" || t === "previous_in_flight_request" || (res?.status === 200 && !t)) {
          emit({ ev: "accepted", quest: name });
          await sleep(2000);
          return QuestsStore.getQuest(quest.id) ?? quest;
        }
        if (isCaptcha(t)) emit({ ev: "captcha", quest: name, at: "accept" });
        else emit({ ev: "accept_failed", quest: name, why: String(t || res?.status || "unknown") });
        return null;
      } catch (e) {
        const why = describe(e);
        if (isCaptcha(why)) emit({ ev: "captcha", quest: name, at: "accept" });
        else emit({ ev: "accept_failed", quest: name, why });
        return null;
      }
    }

    const claimTries = new Map();
    const MAX_CLAIM_TRIES = 3;

    async function claimReward(quest) {
      const name = nameOf(quest);
      const tries = claimTries.get(quest.id) ?? 0;
      if (tries >= MAX_CLAIM_TRIES) { manualClaim.add(quest.id); return false; }
      claimTries.set(quest.id, tries + 1);

      try {
        emit({ ev: "claiming", quest: name });
        const res = await api.post({ url: `/quests/${quest.id}/claim-reward`, body: { location: LOC_QUEST_HOME, platform: PLATFORM_PC } });
        const errs = res?.body?.errors;
        if (res?.status === 200 && (!errs || errs.length === 0)) {
          claimTries.delete(quest.id);
          manualClaim.delete(quest.id);
          emit({ ev: "claimed", quest: name });
          return true;
        }
        manualClaim.add(quest.id);
        const why = errs?.[0]?.message || res?.body?.message || `status ${res?.status}`;
        if (isCaptcha(why)) emit({ ev: "captcha", quest: name, at: "claim" });
        else emit({ ev: "claim_blocked", quest: name, why: String(why) });
        return false;
      } catch (e) {
        manualClaim.add(quest.id);
        const why = describe(e);
        if (isCaptcha(why)) emit({ ev: "captcha", quest: name, at: "claim" });
        else if (tries + 1 >= MAX_CLAIM_TRIES) emit({ ev: "claim_giveup", quest: name, why });
        else emit({ ev: "claim_retry", quest: name, why });
        return false;
      }
    }

    // ---------- one quest ----------
    // The contract of this function is that it ALWAYS resolves. Every branch
    // funnels through settle(), there is a hard time limit on top, and no await
    // is left without a catch. A single unhandled rejection in here used to
    // wedge the whole watcher forever while the UI kept showing "farming".
    function processQuest(quest) {
      return new Promise((resolve) => {
        const questName = nameOf(quest);
        const tc = quest.config.taskConfig || quest.config.taskConfigV2;
        const taskName = taskOf(quest);
        const taskData = tc && tc.tasks && tc.tasks[taskName];
        if (!taskData) { emit({ ev: "quest_skipped", quest: questName, why: "unsupported" }); resolve(); return; }

        const pid = Math.floor(Math.random() * 30000) + 1000;
        const gameName = quest.config.application?.name ?? quest.config.messages?.gameTitle ?? "";
        const applicationId = quest.config.application?.id ?? taskData.applications?.[0]?.id;
        const secondsNeeded = taskData.target;
        let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

        const startedAt = Date.now();
        let lastProgressAt = startedAt;
        let lastSeen = secondsDone;
        let settled = false;
        const cleanups = [];

        // Belt and braces: even if every other guard fails, one quest cannot
        // hold the watcher for longer than this.
        const hardLimit = Math.max(10 * 60 * 1000, (secondsNeeded - secondsDone) * 3000 + 10 * 60 * 1000);
        const guard = setTimeout(() => settle("timeout"), hardLimit);
        cleanups.push(() => clearTimeout(guard));

        function settle(reason) {
          if (settled) return;
          settled = true;
          for (const fn of cleanups) { try { fn(); } catch (_) {} }
          ORB.skip = false;
          if (reason === "done") emit({ ev: "quest_done", quest: questName });
          else emit({ ev: "quest_skipped", quest: questName, why: reason });
          claimReward(quest).catch(() => {}).then(() => resolve());
        }

        const stopped = () => {
          if (ORB.skip || ORB.stop) return "skip";
          if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) return "stalled";
          return null;
        };
        const report = () => emit({
          ev: "progress", quest: questName, task: taskName,
          done: Math.round(secondsDone), need: secondsNeeded, elapsed: Date.now() - startedAt
        });
        const progress = (value) => {
          if (typeof value !== "number" || !(value > secondsDone)) return;
          secondsDone = value;
          if (secondsDone > lastSeen) { lastSeen = secondsDone; lastProgressAt = Date.now(); }
          report();
        };

        emit({ ev: "quest_start", quest: questName, task: taskName, game: gameName, done: Math.round(secondsDone), need: secondsNeeded });
        report();

        // ----- video -----
        if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
          const speed = 7;
          let completed = false;
          (async () => {
            while (!settled) {
              const why = stopped();
              if (why) { settle(why); return; }
              const remaining = Math.max(0, Math.min(speed, secondsNeeded - secondsDone));
              await sleep(remaining * 1000);
              if (settled) return;
              const why2 = stopped();
              if (why2) { settle(why2); return; }

              const timestamp = secondsDone + speed;
              try {
                const res = await api.post({
                  url: `/quests/${quest.id}/video-progress`,
                  body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }
                });
                completed = res?.body?.completed_at != null;
              } catch (e) {
                // This used to reject out of the IIFE and hang the watcher.
                emit({ ev: "api_retry", quest: questName, why: describe(e) });
                await sleep(5000);
                continue;
              }
              progress(Math.min(secondsNeeded, timestamp));
              if (timestamp >= secondsNeeded) break;
            }
            if (settled) return;
            if (!completed) {
              try { await api.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } }); }
              catch (e) { emit({ ev: "api_retry", quest: questName, why: describe(e) }); }
            }
            settle("done");
          })().catch((e) => { emit({ ev: "api_retry", quest: questName, why: describe(e) }); settle("error"); });

        // ----- desktop game -----
        } else if (taskName === "PLAY_ON_DESKTOP" || taskName === "PLAY_ON_DESKTOP_V2") {
          if (!isApp) { settle("no desktop client"); return; }

          // The spoof only makes the Discord UI show the game as running.
          // Heartbeats do the real work, so a missing store is not fatal here.
          if (RunningGameStore) {
            api.get({ url: `/applications/public?application_ids=${applicationId}` }).then((res) => {
              if (settled || !res?.body?.[0]) return;
              const appData = res.body[0];
              const exeName = appData.executables?.find((x) => x.os === "win32")?.name?.replace(">", "")
                ?? String(appData.name || "game").replace(/[\/\\:*?"<>|]/g, "");
              const fakeGame = {
                cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`, exeName,
                exePath: `c:/program files/${String(appData.name).toLowerCase()}/${exeName}`,
                hidden: false, isLauncher: false, id: applicationId, name: appData.name,
                pid, pidPath: [pid], processName: appData.name, start: Date.now()
              };
              const realGames = RunningGameStore.getRunningGames();
              const realGetRunning = RunningGameStore.getRunningGames;
              const realGetForPID = RunningGameStore.getGameForPID;
              RunningGameStore.getRunningGames = () => [fakeGame];
              RunningGameStore.getGameForPID = (p) => [fakeGame].find((x) => x.pid === p);
              FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] });
              cleanups.push(() => {
                RunningGameStore.getRunningGames = realGetRunning;
                RunningGameStore.getGameForPID = realGetForPID;
                try { FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] }); } catch (_) {}
              });
            }).catch(() => {});
          }

          const skipWatcher = setInterval(() => {
            const why = stopped();
            if (why) settle(why);
          }, 2000);
          cleanups.push(() => clearInterval(skipWatcher));

          (async () => {
            while (!settled) {
              await sleep(20 * 1000);
              if (settled) return;
              const why = stopped();
              if (why) { settle(why); return; }
              try {
                const res = await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { application_id: applicationId, terminal: false } });
                progress(res?.body?.progress?.[taskName]?.value);
                if (secondsDone >= secondsNeeded) {
                  api.post({ url: `/quests/${quest.id}/heartbeat`, body: { application_id: applicationId, terminal: true } }).catch(() => {});
                  settle("done");
                  return;
                }
              } catch (e) {
                emit({ ev: "api_retry", quest: questName, why: describe(e) });
                await sleep(5000);
              }
            }
          })().catch((e) => { emit({ ev: "api_retry", quest: questName, why: describe(e) }); settle("error"); });

        // ----- stream -----
        } else if (taskName === "STREAM_ON_DESKTOP") {
          if (!isApp) { settle("no desktop client"); return; }
          if (!ApplicationStreamingStore) { settle("module missing"); return; }

          const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
          ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({ id: applicationId, pid, sourceName: null });

          const listener = (data) => {
            try {
              const value = quest.config.configVersion === 1
                ? data?.userStatus?.streamProgressSeconds
                : Math.floor(data?.userStatus?.progress?.STREAM_ON_DESKTOP?.value ?? 0);
              progress(value);
              if (secondsDone >= secondsNeeded) settle("done");
            } catch (_) {}
          };
          const skipWatcher = setInterval(() => {
            const why = stopped();
            if (why) settle(why);
          }, 2000);

          cleanups.push(() => {
            ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
            try { FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener); } catch (_) {}
            clearInterval(skipWatcher);
          });
          FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);

        // ----- activity -----
        } else if (taskName === "PLAY_ACTIVITY") {
          let channelId = null;
          try {
            channelId = ChannelStore?.getSortedPrivateChannels?.()?.[0]?.id ??
              Object.values(GuildChannelStore?.getAllGuilds?.() ?? {}).find((x) => x?.VOCAL?.length > 0)?.VOCAL?.[0]?.channel?.id;
          } catch (_) {}
          if (!channelId) { settle("no voice channel"); return; }
          const streamKey = `call:${channelId}:1`;

          (async () => {
            while (!settled) {
              const why = stopped();
              if (why) { settle(why); return; }
              try {
                const res = await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: false } });
                // This was res.body.progress.PLAY_ACTIVITY.value with no guards:
                // one odd response wedged the watcher for good.
                progress(res?.body?.progress?.PLAY_ACTIVITY?.value);
              } catch (e) {
                emit({ ev: "api_retry", quest: questName, why: describe(e) });
                await sleep(5000);
                continue;
              }
              if (secondsDone >= secondsNeeded) {
                try { await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } }); } catch (_) {}
                settle("done");
                return;
              }
              await sleep(20 * 1000);
            }
          })().catch((e) => { emit({ ev: "api_retry", quest: questName, why: describe(e) }); settle("error"); });

        } else {
          settle("unsupported");
        }
      });
    }

    // ---------- watcher loop ----------
    const processed = new Set();
    const enrollFailedAt = new Map();
    const claimFailedAt = new Map();
    const notifiedUnsupported = new Set();
    let workedThisSession = false;
    let announcedIdle = false;
    let announcedDone = false;

    function tally(all) {
      const doable = all.filter((q) => taskOf(q));
      return {
        total: doable.length,
        done: doable.filter((q) => q.userStatus?.claimedAt).length,
        left: doable.filter((q) => !processed.has(q.id) && !q.userStatus?.completedAt).length,
        manual: doable.filter((q) => manualClaim.has(q.id) && !q.userStatus?.claimedAt).length
      };
    }

    async function scanOnce() {
      const now = Date.now();
      const all = [...QuestsStore.quests.values()]
        .filter((q) => { try { return new Date(q.config.expiresAt).getTime() > now; } catch (_) { return false; } });

      // 1) claim what is already finished
      for (const q of all) {
        if (ORB.stop) return tally(all);
        if (processed.has(q.id)) continue;
        if (!q.userStatus?.completedAt) continue;
        if (q.userStatus.claimedAt) { processed.add(q.id); continue; }
        const failedAt = claimFailedAt.get(q.id) ?? 0;
        if (now - failedAt < CLAIM_COOLDOWN_MS) continue;
        workedThisSession = true;
        announcedDone = false;
        if (await claimReward(q)) processed.add(q.id);
        else {
          claimFailedAt.set(q.id, Date.now());
          if (manualClaim.has(q.id)) processed.add(q.id);
        }
      }

      // 2) work the active ones
      for (const q of all) {
        if (ORB.stop) return tally(all);
        if (processed.has(q.id)) continue;
        if (q.userStatus?.completedAt) continue;

        if (!taskOf(q)) {
          if (!notifiedUnsupported.has(q.id)) {
            notifiedUnsupported.add(q.id);
            emit({ ev: "unsupported", quest: nameOf(q) });
          }
          processed.add(q.id);
          continue;
        }

        let quest = q;
        if (!quest.userStatus?.enrolledAt) {
          const failedAt = enrollFailedAt.get(quest.id) ?? 0;
          if (now - failedAt < ENROLL_COOLDOWN_MS) continue;
          emit({ ev: "accepting", quest: nameOf(quest) });
          const enrolled = await enroll(quest);
          if (!enrolled) { enrollFailedAt.set(quest.id, Date.now()); continue; }
          quest = enrolled;
        }

        workedThisSession = true;
        announcedDone = false;
        await processQuest(quest);
        processed.add(quest.id);
        ORB.skip = false;
      }

      return tally(all);
    }

    emit({ ev: "started" });

    while (!ORB.stop) {
      let counts = null;
      try {
        counts = await scanOnce();
      } catch (e) {
        emit({ ev: "scan_error", why: describe(e) });
      }

      if (counts) {
        emit({ ev: "tally", total: counts.total, done: counts.done, left: counts.left, manual: counts.manual });

        // "Everything is done" is a real event now, instead of a flag that only
        // ever meant "the engine crashed". The watcher keeps running: new
        // quests are still picked up, exactly as the README promises.
        if (counts.left === 0 && workedThisSession && !announcedDone) {
          announcedDone = true;
          announcedIdle = false;
          emit({ ev: "all_done", done: counts.done, manual: counts.manual });
        } else if (counts.left === 0 && !workedThisSession && !announcedIdle) {
          announcedIdle = true;
          emit({ ev: "idle" });
        } else if (counts.left > 0) {
          announcedIdle = false;
        }
      }

      for (let i = 0; i < SCAN_INTERVAL_MS / 500 && !ORB.stop; i++) await sleep(500);
    }

    die("stopped");
  } catch (e) {
    const why = (e && (e.stack || e.message)) ? String(e.stack || e.message).split("\n")[0] : String(e);
    die("crashed", { why });
  }
})();
