const {
  createChromeMock,
  evaluateScript,
  flushAsyncWork,
  loadHtmlString
} = require("./helpers/extension-test-utils");

function bootInject(syncData, url, localData) {
  loadHtmlString("<!doctype html><html><body></body></html>", {
    url: url || "https://example.org/"
  });
  const chrome = createChromeMock({
    syncData: syncData || {},
    localData: localData || {}
  });
  global.chrome = chrome;
  window.chrome = chrome;
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.requestIdleCallback = (callback) =>
    setTimeout(
      () => callback({ didTimeout: false, timeRemaining: () => 1 }),
      0
    );
  window.cancelIdleCallback = (id) => clearTimeout(id);

  evaluateScript("extension/shared/settings-core.js");
  evaluateScript("extension/shared/controller-utils.js");
  evaluateScript("extension/shared/key-bindings.js");
  evaluateScript("extension/shared/site-rules.js");
  evaluateScript("extension/shared/ui-icons.js");
  evaluateScript("extension/content/inject.js");
  return chrome;
}

async function createVideo() {
  await flushAsyncWork(4);
  const mount = document.createElement("div");
  const video = document.createElement("video");
  video.src = "https://example.org/a.mp4";
  mount.appendChild(video);
  document.body.appendChild(mount);
  window.ensureController(video, mount);
  return video;
}

describe("durable playback-speed intent", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete global.chrome;
  });

  it("activates the built-in Shorts remember-speed rule on empty storage", async () => {
    bootInject({}, "https://www.youtube.com/shorts/abc123");
    await flushAsyncWork(4);

    expect(window.tc.settings.siteRules).toHaveLength(3);
    expect(window.tc.activeSiteRule).toEqual(
      expect.objectContaining({ rememberSpeed: true })
    );
    expect(window.tc.settings.rememberSpeed).toBe(true);
  });

  it("also activates the built-in remember rule on mobile YouTube Shorts", async () => {
    bootInject({}, "https://m.youtube.com/shorts/mobile123");
    await flushAsyncWork(4);

    expect(window.tc.activeSiteRule).toEqual(
      expect.objectContaining({ rememberSpeed: true })
    );
    expect(window.tc.settings.rememberSpeed).toBe(true);
  });

  it("seeds a brand-new Short from lastSpeed when remember is active", async () => {
    bootInject(
      { lastSpeed: 1.8 },
      "https://www.youtube.com/shorts/new-source"
    );
    const video = await createVideo();

    expect(window.tc.settings.rememberSpeed).toBe(true);
    expect(window.getRememberedSpeed(video)).toBe(1.8);
    expect(video.playbackRate).toBe(1.8);
  });

  it("prefers per-source speed over lastSpeed fallback", async () => {
    bootInject(
      { lastSpeed: 2.0, rememberSpeed: true },
      "https://example.org/watch",
      {
        rememberedSpeeds: {
          "https://example.org/a.mp4": { speed: 1.4, updatedAt: 100 }
        }
      }
    );
    const video = await createVideo();

    expect(window.getRememberedSpeed(video)).toBe(1.4);
    expect(video.playbackRate).toBe(1.4);
  });

  it("does not fall back to lastSpeed when remember is off", async () => {
    bootInject(
      { lastSpeed: 1.8, rememberSpeed: false },
      "https://example.org/watch"
    );
    const video = await createVideo();

    expect(window.getRememberedSpeed(video)).toBeNull();
    expect(video.playbackRate).toBe(1);
  });

  it("does not let an automatic remember-off reset overwrite lastSpeed", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({ lastSpeed: 1.8, rememberSpeed: false });
    const video = await createVideo();

    video.src = "https://example.org/b.mp4";
    window.applySourceTransitionPolicy(video, true);
    video.dispatchEvent(new Event("ratechange"));
    await vi.advanceTimersByTimeAsync(300);

    expect(video.playbackRate).toBe(1);
    expect(window.tc.settings.lastSpeed).toBe(1.8);
    expect(chrome.storage.sync._dump().lastSpeed).toBe(1.8);
  });

  it("persists an explicit Speeder speed even before a native event arrives", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({ lastSpeed: 1.25, rememberSpeed: false });
    const video = await createVideo();

    window.setSpeed(video, 1.75, false, true);
    await vi.advanceTimersByTimeAsync(300);

    expect(window.tc.settings.lastSpeed).toBe(1.75);
    expect(chrome.storage.sync._dump().lastSpeed).toBe(1.75);
  });

  it("does not treat an external ratechange as saved intent when remember is off", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({ lastSpeed: 1.8, rememberSpeed: false });
    const video = await createVideo();

    video.playbackRate = 0.75;
    video.dispatchEvent(new Event("ratechange"));
    await vi.advanceTimersByTimeAsync(300);

    expect(window.tc.settings.lastSpeed).toBe(1.8);
    expect(chrome.storage.sync._dump().lastSpeed).toBe(1.8);
  });

  it("does not let a site reset corrupt saved intent when remember is on", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({ lastSpeed: 1.8, rememberSpeed: true });
    const video = await createVideo();

    video.playbackRate = 1;
    video.dispatchEvent(new Event("ratechange"));
    await vi.advanceTimersByTimeAsync(600);

    expect(window.tc.settings.lastSpeed).toBe(1.8);
    expect(chrome.storage.sync._dump().lastSpeed).toBe(1.8);
  });

  it("gives force mode precedence over per-source memory", async () => {
    bootInject({
      lastSpeed: 1.8,
      rememberSpeed: true,
      forceLastSavedSpeed: true
    });
    const video = await createVideo();
    const sourceKey = window.getVideoSourceKey(video);
    window.tc.settings.speeds[sourceKey] = 1.25;
    video.vsc.targetSpeed = 1.25;
    video.vsc.targetSpeedSourceKey = sourceKey;

    expect(window.getRememberedSpeed(video)).toBe(1.8);
    expect(window.getDesiredSpeed(video)).toBe(1.8);
  });

  it("persists a bounded per-source speed map in local storage", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({ lastSpeed: 1.25, rememberSpeed: true });
    const video = await createVideo();

    window.setSpeed(video, 1.6, false, true);
    await vi.advanceTimersByTimeAsync(600);

    const remembered = chrome.storage.local._dump().rememberedSpeeds;
    expect(remembered["https://example.org/a.mp4"]).toEqual(
      expect.objectContaining({ speed: 1.6 })
    );
  });

  it("hydrates per-source speed before creating the first controller", async () => {
    bootInject(
      { lastSpeed: 1.8, rememberSpeed: true },
      "https://example.org/watch",
      {
        rememberedSpeeds: {
          "https://example.org/a.mp4": {
            speed: 1.4,
            updatedAt: 100
          }
        }
      }
    );
    const video = await createVideo();

    expect(video.playbackRate).toBe(1.4);
    expect(window.getRememberedSpeed(video)).toBe(1.4);
  });

  it("merges another frame's source map without losing a queued local speed", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({ lastSpeed: 1.25, rememberSpeed: true });
    const video = await createVideo();

    window.setSpeed(video, 1.6, false, true);
    chrome.storage.local.set({
      rememberedSpeeds: {
        "https://example.org/other.mp4": {
          speed: 1.3,
          updatedAt: Date.now() + 1
        }
      }
    });
    await vi.advanceTimersByTimeAsync(700);

    const remembered = chrome.storage.local._dump().rememberedSpeeds;
    expect(remembered["https://example.org/a.mp4"].speed).toBe(1.6);
    expect(remembered["https://example.org/other.mp4"].speed).toBe(1.3);
  });

  it("drops a stale pre-reset write without deleting a newer cross-frame speed", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({ lastSpeed: 1.25, rememberSpeed: true });
    const video = await createVideo();
    const originalSet = chrome.storage.local.set.getMockImplementation();
    let finishStaleSet;
    chrome.storage.local.set.mockImplementationOnce((items, callback) => {
      finishStaleSet = () => originalSet(items, callback);
    });

    window.setSpeed(video, 1.6, false, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(finishStaleSet).toBeTypeOf("function");

    const resetAt = Date.now();
    chrome.storage.local.set({
      rememberedSpeedsResetAt: resetAt,
      rememberedSpeeds: {}
    });
    chrome.storage.local.set({
      rememberedSpeeds: {
        "https://example.org/new-after-reset.mp4": {
          speed: 1.4,
          updatedAt: resetAt + 1
        }
      }
    });
    finishStaleSet();
    await vi.advanceTimersByTimeAsync(0);

    expect(chrome.storage.local._dump().rememberedSpeeds).toEqual({
      "https://example.org/new-after-reset.mp4": {
        speed: 1.4,
        updatedAt: resetAt + 1
      }
    });
    expect(window.tc.settings.speeds).not.toHaveProperty(
      "https://example.org/a.mp4"
    );
    expect(window.tc.settings.speeds).toHaveProperty(
      "https://example.org/new-after-reset.mp4",
      1.4
    );
  });

  it("reapplies the Shorts rule on same-source SPA navigation and resists an immediate reset", async () => {
    vi.useFakeTimers();
    bootInject(
      { lastSpeed: 1.8 },
      "https://www.youtube.com/watch?v=same-source",
      {
        rememberedSpeeds: {
          "https://example.org/a.mp4": { speed: 1.8, updatedAt: 100 }
        }
      }
    );
    const video = await createVideo();
    Object.defineProperty(video, "paused", {
      configurable: true,
      value: false
    });

    window.history.pushState({}, "", "/shorts/same-source");
    await vi.advanceTimersByTimeAsync(350);
    await flushAsyncWork(2);

    expect(window.tc.settings.rememberSpeed).toBe(true);
    expect(video.playbackRate).toBe(1.8);

    video.playbackRate = 1;
    video.dispatchEvent(new Event("ratechange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBe(1.8);
  });

  it("disarms remembered policy when same-source SPA navigation leaves Shorts", async () => {
    vi.useFakeTimers();
    bootInject(
      { lastSpeed: 1.8 },
      "https://www.youtube.com/shorts/leaving",
      {
        rememberedSpeeds: {
          "https://example.org/a.mp4": { speed: 1.8, updatedAt: 100 }
        }
      }
    );
    const video = await createVideo();
    expect(video.vsc.targetSpeedOrigin).toBe("policy");

    window.history.pushState({}, "", "/watch?v=leaving");
    await vi.advanceTimersByTimeAsync(350);
    await flushAsyncWork(2);

    expect(window.tc.settings.rememberSpeed).toBe(false);
    expect(video.vsc.targetSpeedOrigin).not.toBe("policy");
    video.playbackRate = 1;
    video.dispatchEvent(new Event("ratechange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBe(1);
  });

  it("live-reloads sparse settings without leaking a route override into the global base", async () => {
    vi.useFakeTimers();
    const chrome = bootInject(
      {
        rememberSpeed: false,
        siteRules: [
          {
            pattern: "example.org/shorts/",
            enabled: true,
            rememberSpeed: true
          }
        ]
      },
      "https://example.org/shorts/one"
    );
    await createVideo();
    expect(window.tc.settings.rememberSpeed).toBe(true);

    chrome.storage.sync.set({ controllerOpacity: 0.7 });
    await vi.advanceTimersByTimeAsync(100);
    expect(window.tc.siteRuleBase.rememberSpeed).toBe(false);
    expect(window.tc.settings.rememberSpeed).toBe(true);

    window.history.pushState({}, "", "/watch/two");
    await vi.advanceTimersByTimeAsync(350);
    expect(window.tc.activeSiteRule).toBeNull();
    expect(window.tc.settings.rememberSpeed).toBe(false);
  });

  it("does not trust forged force-mode ratechange metadata as user intent", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({
      lastSpeed: 1.8,
      forceLastSavedSpeed: true
    });
    const video = await createVideo();
    video.vsc.pendingRateChange = null;

    video.dispatchEvent(
      new CustomEvent("ratechange", {
        detail: {
          origin: "videoSpeed",
          speed: 0.5,
          fromUserInput: true
        }
      })
    );
    await vi.advanceTimersByTimeAsync(300);

    expect(video.playbackRate).toBe(1.8);
    expect(window.tc.settings.lastSpeed).toBe(1.8);
    expect(chrome.storage.sync._dump().lastSpeed).toBe(1.8);
  });

  it("ignores a stale popup speed payload and can still persist that value later", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({ lastSpeed: 2 });
    const video = await createVideo();
    const listener = chrome.runtime.onMessage.listeners[0];
    let response;

    listener(
      {
        action: "set_force_last_saved_speed",
        enabled: true,
        speed: 1.5
      },
      {},
      (value) => {
        response = value;
      }
    );

    expect(response.enabled).toBe(true);
    expect(window.tc.settings.lastSpeed).toBe(2);
    expect(window.tc.persistedLastSpeed).toBe(2);

    window.setSpeed(video, 1.5, false, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.storage.sync._dump().lastSpeed).toBe(1.5);
  });

  it("clears the anti-reset window when force mode is turned off", async () => {
    const chrome = bootInject({
      lastSpeed: 1.8,
      forceLastSavedSpeed: true
    });
    const video = await createVideo();
    video.vsc.speedRestoreUntil = Date.now() + 5000;
    video.vsc.restoreSpeedTimer = setTimeout(() => {}, 5000);
    const listener = chrome.runtime.onMessage.listeners[0];

    listener(
      { action: "set_force_last_saved_speed", enabled: false },
      {},
      () => {}
    );

    expect(window.tc.settings.forceLastSavedSpeed).toBe(false);
    expect(video.vsc.speedRestoreUntil).toBe(0);
    expect(video.vsc.restoreSpeedTimer).toBeNull();
    expect(video.vsc.targetSpeedOrigin).not.toBe("policy");

    video.playbackRate = 1;
    video.dispatchEvent(new Event("ratechange"));
    expect(video.playbackRate).toBe(1);
  });

  it("keeps force ownership through a redundant event so disabling force fully releases it", async () => {
    const chrome = bootInject({
      lastSpeed: 1.8,
      forceLastSavedSpeed: true
    });
    const video = await createVideo();
    const listener = chrome.runtime.onMessage.listeners[0];

    video.dispatchEvent(new Event("ratechange"));
    expect(video.vsc.targetSpeedOrigin).toBe("policy");

    listener(
      { action: "set_force_last_saved_speed", enabled: false },
      {},
      () => {}
    );
    video.playbackRate = 1;
    video.dispatchEvent(new Event("ratechange"));

    expect(video.playbackRate).toBe(1);
    expect(video.vsc.targetSpeedOrigin).toBe("external");
  });

  it("accepts a native speed change while paused when no Speeder policy owns the target", async () => {
    vi.useFakeTimers();
    const chrome = bootInject({ lastSpeed: 1.8, rememberSpeed: false });
    const video = await createVideo();

    expect(video.paused).toBe(true);
    expect(video.vsc.targetSpeedOrigin).toBe("initial");
    video.playbackRate = 1.5;
    video.dispatchEvent(new Event("ratechange"));
    await vi.advanceTimersByTimeAsync(300);

    expect(video.playbackRate).toBe(1.5);
    expect(video.vsc.targetSpeedOrigin).toBe("external");
    expect(window.tc.settings.lastSpeed).toBe(1.8);
    expect(chrome.storage.sync._dump().lastSpeed).toBe(1.8);
  });

  it("defensively replaces an invalid zero speed step instead of jumping to 16x", async () => {
    bootInject({
      keyBindings: [
        {
          action: "faster",
          code: "KeyD",
          value: 0,
          disabled: false
        }
      ]
    });
    const video = await createVideo();

    window.runAction("faster", 0, null, video);

    expect(video.playbackRate).toBeCloseTo(1.1, 5);
    expect(video.playbackRate).not.toBe(16);
  });

  it("bounds verification retries when a player silently rejects forced speed", async () => {
    vi.useFakeTimers();
    bootInject({ lastSpeed: 1.8, forceLastSavedSpeed: true });
    const video = await createVideo();
    await vi.advanceTimersByTimeAsync(200);
    let assignmentCount = 0;
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get() {
        return 1;
      },
      set() {
        assignmentCount += 1;
      }
    });

    window.setSpeed(video, 1.8, false, false);
    await vi.advanceTimersByTimeAsync(2000);

    expect(assignmentCount).toBe(4);
    expect(video.vsc.speedVerificationTimer).toBeNull();
    expect(video.vsc.speedVerificationAttempts).toBe(0);
  });
});
