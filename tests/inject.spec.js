const {
  createChromeMock,
  evaluateScript,
  flushAsyncWork,
  loadHtmlString
} = require("./helpers/extension-test-utils");

function bootInject(options) {
  const config = options || {};

  loadHtmlString("<!doctype html><html><body></body></html>");

  const chrome = createChromeMock({
    syncData: config.syncData,
    localData: config.localData
  });

  global.chrome = chrome;
  window.chrome = chrome;
  window.requestIdleCallback = (callback, opts) =>
    setTimeout(
      () =>
        callback({
          didTimeout: false,
          timeRemaining() {
            return 1;
          }
        }),
      (opts && opts.timeout) || 0
    );
  window.cancelIdleCallback = (id) => clearTimeout(id);

  evaluateScript("extension/shared/controller-utils.js");
  evaluateScript("extension/shared/key-bindings.js");
  evaluateScript("extension/shared/site-rules.js");
  evaluateScript("extension/shared/ui-icons.js");
  evaluateScript("extension/content/inject.js");

  return chrome;
}

describe("inject.js helper logic", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete global.chrome;
  });

  it("normalizes bindings from legacy formats", async () => {
    bootInject();
    await flushAsyncWork(3);

    expect(
      window.normalizeStoredBinding({
        action: "faster",
        key: "g",
        value: 1.8,
        force: false
      }).code
    ).toBe("KeyG");

    expect(
      window.normalizeStoredBinding({
        action: "pause",
        code: null,
        key: null,
        keyCode: null,
        value: 0
      })
    ).toEqual({
      action: "pause",
      code: null,
      disabled: true,
      value: 0,
      force: "false",
      predefined: false
    });

    expect(window.defaultKeyBindings({ speedStep: 0.25, rewindTime: 5 })[0]).toEqual(
      {
        action: "slower",
        code: "KeyS",
        value: 0.25,
        force: false,
        predefined: true
      }
    );
  });

  it("clamps controller margins and ignores stale source-specific target speeds", async () => {
    bootInject();
    await flushAsyncWork(3);

    expect(window.normalizeControllerMarginPx(250, 0)).toBe(200);
    expect(window.normalizeControllerMarginPx(-5, 65)).toBe(0);
    expect(window.normalizeControllerMarginPx("bad", 65)).toBe(65);

    const staleVideo = {
      currentSrc: "fresh.mp4",
      vsc: {
        targetSpeed: 1.75,
        targetSpeedSourceKey: "old.mp4"
      }
    };

    expect(window.getControllerTargetSpeed(staleVideo)).toBeNull();

    window.tc.settings.rememberSpeed = true;
    window.tc.settings.forceLastSavedSpeed = false;
    window.tc.settings.lastSpeed = 1.3;
    window.tc.settings.speeds = { "fresh.mp4": 1.6 };

    expect(window.getRememberedSpeed({ currentSrc: "fresh.mp4" })).toBe(1.6);
    expect(window.getDesiredSpeed(staleVideo)).toBe(1.6);
  });

  it("applies site rule overrides and detects disabled sites", async () => {
    bootInject();
    await flushAsyncWork(3);

    window.tc.settings.siteRules = [{ pattern: "example.org", enabled: false }];
    window.captureSiteRuleBase();
    expect(window.applySiteRuleOverrides()).toBe(true);

    window.resetSettingsFromSiteRuleBase();
    window.tc.settings.siteRules = [
      {
        pattern: "example.org",
        controllerLocation: "bottom-left",
        controllerMarginTop: 300,
        controllerMarginBottom: -10,
        rememberSpeed: true
      }
    ];
    window.captureSiteRuleBase();

    expect(window.applySiteRuleOverrides()).toBe(false);
    expect(window.tc.settings.controllerLocation).toBe("bottom-left");
    expect(window.tc.settings.controllerMarginTop).toBe(200);
    expect(window.tc.settings.controllerMarginBottom).toBe(0);
    expect(window.tc.settings.rememberSpeed).toBe(true);
  });

  it("sizes and positions the controller host to the video bounds", async () => {
    bootInject();
    await flushAsyncWork(3);

    const mount = document.createElement("div");
    const video = document.createElement("video");
    const wrapper = document.createElement("div");
    wrapper.className = "vsc-controller";
    mount.append(video, wrapper);
    document.body.appendChild(mount);

    Object.defineProperties(mount, {
      offsetWidth: { value: 400 },
      offsetHeight: { value: 240 },
      clientLeft: { value: 2 },
      clientTop: { value: 2 }
    });
    mount.getBoundingClientRect = () => ({
      left: 100,
      top: 50,
      right: 500,
      bottom: 290,
      width: 400,
      height: 240
    });
    video.getBoundingClientRect = () => ({
      left: 140,
      top: 70,
      right: 460,
      bottom: 250,
      width: 320,
      height: 180
    });

    window.positionControllerHost(wrapper, video, mount);

    expect(wrapper.style.getPropertyValue("left")).toBe("38px");
    expect(wrapper.style.getPropertyValue("top")).toBe("18px");
    expect(wrapper.style.getPropertyValue("width")).toBe("320px");
    expect(wrapper.style.getPropertyValue("height")).toBe("180px");
    expect(wrapper.style.getPropertyPriority("width")).toBe("important");
  });

  it("does not mount the controller outside a player stacking boundary", async () => {
    bootInject();
    await flushAsyncWork(3);

    const page = document.createElement("main");
    const outsidePlayer = document.createElement("section");
    const isolatedPlayer = document.createElement("div");
    const videoParent = document.createElement("div");
    const video = document.createElement("video");
    isolatedPlayer.style.isolation = "isolate";
    videoParent.appendChild(video);
    isolatedPlayer.appendChild(videoParent);
    outsidePlayer.appendChild(isolatedPlayer);
    page.appendChild(outsidePlayer);
    document.body.appendChild(page);

    const rect = {
      left: 10,
      top: 100,
      right: 650,
      bottom: 460,
      width: 640,
      height: 360
    };
    [video, videoParent, isolatedPlayer, outsidePlayer].forEach((element) => {
      element.getBoundingClientRect = () => rect;
    });

    expect(window.getControllerMount(video)).toBe(isolatedPlayer);
  });
});
