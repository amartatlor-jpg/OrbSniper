/*!
 * OrbSniper v1.5.0 - Discord Orb farmer (quest engine)
 * Copyright (c) 2026 synaps_ss - tg: @synaps_ss
 * Licensed under MIT. Use at your own risk. Violates Discord ToS.
 */

// Discord quest auto-completer — WATCHER MODE (injected into the desktop client via CDP).
// Scans for quests every 20s: auto-accepts, completes, claims rewards.
// Manual skip: window.__QUEST_SKIP__ = true  (launcher binds key S)
// Stop watcher: window.__QUEST_STOP__ = true

(async function () {
  const log = (m) => console.log(`[quest-auto] ${m}`);
  const err = (m) => console.error(`[quest-auto] ${m}`);

  window.__QUEST_SKIP__ = false;
  window.__QUEST_STOP__ = false;
  window.__QUEST_STATUS__ = "starting";
  window.__QUEST_AUTO_DONE__ = false;
  // progress summary for the UI
  window.__QUEST_TALLY__ = '{"total":0,"done":0,"left":0,"manual":0}';

  const STALL_TIMEOUT_MS = 3 * 60 * 1000;   // auto-skip quest with no progress for 3 min
  const SCAN_INTERVAL_MS = 20 * 1000;       // scan cycle
  const ENROLL_COOLDOWN_MS = 3 * 60 * 1000; // wait before re-trying a failed accept

  try {
    delete window.$;
    const wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, (r) => r]);
    webpackChunkdiscord_app.pop();

    const mods = Object.values(wpRequire.c);
    const pick = (pred) => mods.find(pred);
    const ApplicationStreamingStore = pick((x) => x?.exports?.A?.__proto__?.getStreamerActiveStreamMetadata)?.exports?.A;
    const RunningGameStore = pick((x) => x?.exports?.Ay?.getRunningGames)?.exports?.Ay;
    const QuestsStore = pick((x) => x?.exports?.A?.__proto__?.getQuest)?.exports?.A;
    const ChannelStore = pick((x) => x?.exports?.A?.__proto__?.getAllThreadsForParent)?.exports?.A;
    const GuildChannelStore = pick((x) => x?.exports?.Ay?.getSFWDefaultChannel)?.exports?.Ay;
    const FluxDispatcher = pick((x) => x?.exports?.h?.__proto__?.flushWaitQueue)?.exports?.h;
    const api = pick((x) => x?.exports?.Bo?.get)?.exports?.Bo;

    if (!QuestsStore || !api || !FluxDispatcher) {
      err("Failed to locate Discord modules. Client updated?");
      window.__QUEST_AUTO_DONE__ = true;
      return;
    }

    const manualClaim = new Set();   // rewards Discord refused to hand over
    const SUPPORTED = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "PLAY_ON_DESKTOP_V2", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];
    const isApp = typeof DiscordNative !== "undefined";
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const LOC_QUEST_HOME = 11;
    const PLATFORM_PC = 4;

    const fmtTime = (ms) => {
      const s = Math.floor(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };

    const taskOf = (quest) => {
      const tc = quest.config.taskConfig ?? quest.config.taskConfigV2;
      return SUPPORTED.find((t) => tc?.tasks?.[t] != null);
    };

    async function enroll(quest) {
      try {
        const res = await api.post({ url: `/quests/${quest.id}/enroll`, body: { location: LOC_QUEST_HOME } });
        const t = res.body?.type;
        if (t === "success" || t === "previous_in_flight_request" || (res.status === 200 && !t)) {
          log(`Accepted: "${quest.config.messages.questName}".`);
          await sleep(2000);
          return QuestsStore.getQuest(quest.id) ?? quest;
        }
        if (t === "captcha_failed") log(`CAPTCHA on accept for "${quest.config.messages.questName}" — accept it manually in the Quests tab, I'll pick it up.`);
        else log(`Accept failed (${t || res.status}) for "${quest.config.messages.questName}".`);
        return null;
      } catch (e) {
        log(`Accept error for "${quest.config.messages.questName}": ${e?.message || e}`);
        return null;
      }
    }

    async function claimReward(quest) {
      try {
        log(`Claiming reward for "${quest.config.messages.questName}"...`);
        const res = await api.post({ url: `/quests/${quest.id}/claim-reward`, body: { location: LOC_QUEST_HOME, platform: PLATFORM_PC } });
        const errs = res.body?.errors;
        if (res.status === 200 && (!errs || errs.length === 0)) {
          log(`Reward claimed: "${quest.config.messages.questName}".`);
          return true;
        }
        manualClaim.add(quest.id);
        log(`Claim blocked for "${quest.config.messages.questName}" (status ${res.status}) — claim manually in the Quests tab.`);
        return false;
      } catch (e) {
        manualClaim.add(quest.id);
        log(`Claim error for "${quest.config.messages.questName}": ${e?.message || e} — claim manually.`);
        return false;
      }
    }

    // Returns a Promise resolving when the quest is done, skipped or failed.
    function processQuest(quest) {
      return new Promise((resolve) => {
        const pid = Math.floor(Math.random() * 30000) + 1000;
        const questName = quest.config.messages.questName;
        const gameName = quest.config.application?.name ?? quest.config.messages?.gameTitle ?? "the game";
        const tc = quest.config.taskConfig ?? quest.config.taskConfigV2;
        const taskName = taskOf(quest);
        const taskData = tc.tasks[taskName];
        const applicationId = quest.config.application?.id ?? taskData.applications?.[0]?.id;
        const secondsNeeded = taskData.target;
        let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

        const startedAt = Date.now();
        let lastProgressAt = startedAt;
        let lastSeen = secondsDone;

        const checkSkip = () => {
          if (window.__QUEST_SKIP__ || window.__QUEST_STOP__) return true;
          if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
            log(`"${questName}" — no progress for 3 min, auto-skip (probably needs real action).`);
            return true;
          }
          return false;
        };
        const updateStatus = () => {
          window.__QUEST_STATUS__ = `"${questName}" | ${taskName} | ${secondsDone}/${secondsNeeded}s | ${fmtTime(Date.now() - startedAt)}`;
        };

        const finish = async (reason) => {
          window.__QUEST_SKIP__ = false;
          if (reason === "done") log(`"${questName}" completed.`);
          else log(`"${questName}" skipped (${reason}).`);
          updateStatus();
          await claimReward(quest);
          resolve();
        };

        if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
          const speed = 7;
          let completed = false;
          log(`Video quest "${questName}" — spoofing watch (${secondsNeeded}s).`);
          (async () => {
            while (true) {
              if (checkSkip()) { finish("skip"); return; }
              const remaining = Math.min(speed, secondsNeeded - secondsDone);
              await sleep(remaining * 1000);
              if (checkSkip()) { finish("skip"); return; }
              const timestamp = secondsDone + speed;
              const res = await api.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) } });
              completed = res.body?.completed_at != null;
              secondsDone = Math.min(secondsNeeded, timestamp);
              if (secondsDone > lastSeen) { lastSeen = secondsDone; lastProgressAt = Date.now(); }
              updateStatus();
              if (timestamp >= secondsNeeded) break;
            }
            if (!completed) await api.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
            finish("done");
          })();
        } else if (taskName === "PLAY_ON_DESKTOP" || taskName === "PLAY_ON_DESKTOP_V2") {
          if (!isApp) { finish("no desktop client"); return; }
          const mins = Math.ceil((secondsNeeded - secondsDone) / 60);
          log(`Game quest "${questName}" — play "${gameName}" ~${mins} min. Spoofing launch + direct heartbeats. Press S to skip.`);

          let finished = false;
          let spoofTeardown = () => {};

          // Best-effort spoof so the Discord UI shows the game as running.
          api.get({ url: `/applications/public?application_ids=${applicationId}` }).then((res) => {
            if (finished || !res.body?.[0]) return;
            const appData = res.body[0];
            const exeName = appData.executables?.find((x) => x.os === "win32")?.name?.replace(">", "") ?? appData.name.replace(/[\/\\:*?"<>|]/g, "");
            const fakeGame = {
              cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`, exeName,
              exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
              hidden: false, isLauncher: false, id: applicationId, name: appData.name,
              pid, pidPath: [pid], processName: appData.name, start: Date.now()
            };
            const realGames = RunningGameStore.getRunningGames();
            const realGetRunning = RunningGameStore.getRunningGames;
            const realGetForPID = RunningGameStore.getGameForPID;
            RunningGameStore.getRunningGames = () => [fakeGame];
            RunningGameStore.getGameForPID = (p) => [fakeGame].find((x) => x.pid === p);
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] });
            spoofTeardown = () => {
              RunningGameStore.getRunningGames = realGetRunning;
              RunningGameStore.getGameForPID = realGetForPID;
              FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
            };
          }).catch(() => {}); // spoof is optional — heartbeats do the real work

          const end = (reason) => {
            if (finished) return;
            finished = true;
            clearInterval(skipWatcher);
            spoofTeardown();
            finish(reason);
          };
          const skipWatcher = setInterval(() => {
            if (checkSkip()) end("skip");
          }, 2000);

          // Primary progress driver: direct heartbeats every 20s.
          (async () => {
            while (!finished) {
              await sleep(20 * 1000);
              if (finished) break;
              if (checkSkip()) { end("skip"); break; }
              try {
                const res = await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { application_id: applicationId, terminal: false } });
                const progress = res.body?.progress?.[taskName]?.value;
                if (typeof progress === "number" && progress > secondsDone) {
                  secondsDone = progress;
                  if (secondsDone > lastSeen) { lastSeen = secondsDone; lastProgressAt = Date.now(); }
                  updateStatus();
                  log(`"${questName}" game: ${secondsDone}/${secondsNeeded}s (${fmtTime(Date.now() - startedAt)})`);
                }
                if (secondsDone >= secondsNeeded) {
                  api.post({ url: `/quests/${quest.id}/heartbeat`, body: { application_id: applicationId, terminal: true } }).catch(() => {});
                  end("done");
                  break;
                }
              } catch (e) {
                log(`"${questName}" heartbeat error: ${e?.message || e} — retrying.`);
                await sleep(5000);
              }
            }
          })();
        } else if (taskName === "STREAM_ON_DESKTOP") {
          if (!isApp) { finish("no desktop client"); return; }
          const mins = Math.ceil((secondsNeeded - secondsDone) / 60);
          log(`Stream quest "${questName}" — stream "${gameName}" ~${mins} min in VC. Spoofing metadata.`);
          log(`NOTE: stream quests usually need a REAL stream in a voice channel. If stuck 3 min — auto-skip.`);
          const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
          ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({ id: applicationId, pid, sourceName: null });
          let torn = false;
          const teardown = () => {
            if (torn) return; torn = true;
            ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);
            clearInterval(skipWatcher);
          };
          const listener = (data) => {
            const progress = quest.config.configVersion === 1
              ? data.userStatus.streamProgressSeconds
              : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);
            if (progress > lastSeen) { lastSeen = progress; lastProgressAt = Date.now(); }
            secondsDone = progress;
            updateStatus();
            if (progress >= secondsNeeded) { teardown(); finish("done"); }
          };
          const skipWatcher = setInterval(() => {
            if (checkSkip()) { teardown(); finish("skip"); }
          }, 2000);
          FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);
        } else if (taskName === "PLAY_ACTIVITY") {
          const channelId = ChannelStore.getSortedPrivateChannels()?.[0]?.id ??
            Object.values(GuildChannelStore.getAllGuilds()).find((x) => x?.VOCAL?.length > 0)?.VOCAL[0]?.channel?.id;
          if (!channelId) { finish("no voice channel"); return; }
          const streamKey = `call:${channelId}:1`;
          log(`Activity quest "${questName}" — heartbeats (${secondsNeeded}s).`);
          (async () => {
            while (true) {
              if (checkSkip()) { finish("skip"); return; }
              const res = await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: false } });
              const progress = res.body.progress.PLAY_ACTIVITY.value;
              if (progress > lastSeen) { lastSeen = progress; lastProgressAt = Date.now(); }
              secondsDone = progress;
              updateStatus();
              await sleep(20 * 1000);
              if (progress >= secondsNeeded) {
                await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } });
                break;
              }
            }
            finish("done");
          })();
        } else {
          finish("unsupported");
        }
      });
    }

    // ---------- watcher loop ----------
    const processed = new Set();      // quest ids fully handled
    const enrollFailedAt = new Map(); // quest id -> timestamp of failed accept
    const claimFailedAt = new Map();  // quest id -> timestamp of failed claim
    const notifiedUnsupported = new Set();

    async function scanOnce() {
      const now = Date.now();
      const all = [...QuestsStore.quests.values()].filter((q) => new Date(q.config.expiresAt).getTime() > now);

      // 1) claim completed-but-unclaimed (with retry cooldown)
      for (const q of all) {
        if (processed.has(q.id)) continue;
        if (q.userStatus?.completedAt) {
          if (!q.userStatus.claimedAt) {
            const failedAt = claimFailedAt.get(q.id) ?? 0;
            if (now - failedAt < ENROLL_COOLDOWN_MS) continue;
            if (await claimReward(q)) processed.add(q.id);
            else claimFailedAt.set(q.id, Date.now());
          } else {
            processed.add(q.id);
          }
        }
      }

      // 2) process active quests one by one
      for (const q of all) {
        if (processed.has(q.id)) continue;
        if (q.userStatus?.completedAt) continue;

        if (!taskOf(q)) {
          if (!notifiedUnsupported.has(q.id)) {
            notifiedUnsupported.add(q.id);
            log(`"${q.config.messages.questName}" — console/achievement only, can't auto-do. Skipping.`);
          }
          processed.add(q.id);
          continue;
        }

        let quest = q;
        if (!quest.userStatus?.enrolledAt) {
          const failedAt = enrollFailedAt.get(quest.id) ?? 0;
          if (now - failedAt < ENROLL_COOLDOWN_MS) continue;
          log(`"${quest.config.messages.questName}" — accepting (PC)...`);
          const enrolled = await enroll(quest);
          if (!enrolled) { enrollFailedAt.set(quest.id, Date.now()); continue; }
          quest = enrolled;
        }

        await processQuest(quest);
        processed.add(quest.id);
        window.__QUEST_SKIP__ = false;
      }

      // only count quests we can actually do
      const doable = all.filter((q) => taskOf(q));
      const left = doable.filter((q) => !processed.has(q.id) && !q.userStatus?.completedAt).length;
      window.__QUEST_TALLY__ = JSON.stringify({
        total: doable.length,
        done: doable.filter((q) => q.userStatus?.claimedAt).length,
        left,
        manual: doable.filter((q) => manualClaim.has(q.id) && !q.userStatus?.claimedAt).length
      });

      return left;
    }

    log("Watcher started. Scanning every 20s — new quests are picked up automatically.");
    let lastPending = -1;
    while (true) {
      if (window.__QUEST_STOP__) break;
      try {
        const pending = await scanOnce();
        if (pending !== lastPending) {
          lastPending = pending;
          if (pending === 0) log("No quests in progress. Watching for new ones...");
        }
      } catch (e) {
        err(`Scan error: ${e?.message || e}`);
      }
      window.__QUEST_STATUS__ = `watching... ${new Date().toLocaleTimeString()}`;
      await sleep(SCAN_INTERVAL_MS);
    }
    log("Watcher stopped.");
  } catch (e) {
    err(`Fatal: ${e?.stack || e}`);
    window.__QUEST_AUTO_DONE__ = true;
  }
})();
