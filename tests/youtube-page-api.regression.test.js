const {
  createChromeMock,
  evaluateScript,
  loadHtmlString
} = require("./helpers/extension-test-utils");

function bootYouTube(url = "https://www.youtube.com/watch?v=test") {
  loadHtmlString("<!doctype html><html><body></body></html>", { url });
  const chrome = createChromeMock();
  global.chrome = chrome;
  window.chrome = chrome;
  evaluateScript("extension/shared/settings-core.js");
  evaluateScript("extension/shared/controller-utils.js");
  evaluateScript("extension/shared/key-bindings.js");
  evaluateScript("extension/shared/site-rules.js");
  evaluateScript("extension/shared/ui-icons.js");
  evaluateScript("extension/content/inject.js");

  // A detached player avoids unrelated controller lifecycle work.
  const player = document.createElement("div");
  player.className = "html5-video-player";
  const video = document.createElement("video");
  player.appendChild(video);
  return { player, video };
}

function throwOnRead(object, key) {
  Object.defineProperty(object, key, {
    configurable: true,
    get() {
      throw new Error("page getter failed");
    }
  });
}

describe("YouTube page API boundary", () => {
  afterEach(() => {
    delete global.chrome;
  });

  it.each([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "embed.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "embed.youtube-nocookie.com"
  ])("recognizes the YouTube host %s", (host) => {
    bootYouTube(`https://${host}/`);
    expect(window.isOnYouTube()).toBe(true);
  });

  it.each([
    "notyoutube.com",
    "youtube.com.example.org",
    "youtube-nocookie.com.example.org",
    "notyoutube-nocookie.com",
    "example.org"
  ])("never reads page APIs on the lookalike host %s", (host) => {
    const { player, video } = bootYouTube(`https://${host}/`);
    const readWrapper = vi.fn(() => ({}));
    Object.defineProperty(player, "wrappedJSObject", { get: readWrapper });

    expect(window.isOnYouTube()).toBe(false);
    expect(window.getYouTubePlayerApi(video)).toBeNull();
    expect(window.tryYouTubeNativeSpeed(video, 1.5)).toBe(false);
    window.syncYouTubePlayerVolume(video, 0.5);
    window.muted(video);
    expect(video.muted).toBe(true);
    expect(readWrapper).not.toHaveBeenCalled();
  });

  it("synchronizes speed, volume, mute, and unmute with the page receiver", () => {
    const { player, video } = bootYouTube();
    const api = {
      setPlaybackRate: vi.fn(function(rate) {
        expect(this).toBe(api);
        video.playbackRate = rate;
      }),
      setVolume: vi.fn(function(volume) {
        expect(this).toBe(api);
        expect(volume).toBe(43);
      }),
      mute: vi.fn(function() { expect(this).toBe(api); }),
      unMute: vi.fn(function() { expect(this).toBe(api); })
    };
    player.wrappedJSObject = api;

    expect(window.tryYouTubeNativeSpeed(video, 1.5)).toBe(true);
    expect(api.setPlaybackRate).toHaveBeenCalledWith(1.5);
    window.setVideoVolume(video, 0.43);
    expect(video.volume).toBe(0.43);
    expect(api.setVolume).toHaveBeenCalledWith(43);
    expect(api.unMute).toHaveBeenCalledTimes(1);
    window.muted(video);
    expect(video.muted).toBe(true);
    expect(api.mute).toHaveBeenCalledTimes(1);
    window.muted(video);
    expect(video.muted).toBe(false);
    expect(api.unMute).toHaveBeenCalledTimes(2);
  });

  it("uses the player element when no wrapped page object exists", () => {
    const { player, video } = bootYouTube();
    player.setPlaybackRate = vi.fn((rate) => { video.playbackRate = rate; });
    expect(window.getYouTubePlayerApi(video)).toBe(player);
    expect(window.tryYouTubeNativeSpeed(video, 1.25)).toBe(true);
  });

  it("falls back when the page silently clamps speed", () => {
    const { player, video } = bootYouTube();
    player.wrappedJSObject = { setPlaybackRate: vi.fn() };
    expect(window.tryYouTubeNativeSpeed(video, 1.5)).toBe(false);
  });

  it("rejects nonprimitive and nonfinite numeric arguments without coercion", () => {
    const { player, video } = bootYouTube();
    const coerce = vi.fn(() => 1);
    const api = { setPlaybackRate: vi.fn(), setVolume: vi.fn() };
    player.wrappedJSObject = api;
    const invalid = [NaN, Infinity, -Infinity, "1", new Number(1), { valueOf: coerce }];

    invalid.forEach((value) => {
      expect(window.tryYouTubeNativeSpeed(video, value)).toBe(false);
      expect(() => window.syncYouTubePlayerVolume(video, value)).not.toThrow();
    });
    [-1, 1.1].forEach((volume) => window.syncYouTubePlayerVolume(video, volume));
    expect(api.setPlaybackRate).not.toHaveBeenCalled();
    expect(api.setVolume).not.toHaveBeenCalled();
    expect(coerce).not.toHaveBeenCalled();
  });

  it("contains a throwing wrapped object getter for every native action", () => {
    const { player, video } = bootYouTube();
    throwOnRead(player, "wrappedJSObject");
    expect(window.getYouTubePlayerApi(video)).toBeNull();
    expect(window.tryYouTubeNativeSpeed(video, 1.5)).toBe(false);
    expect(() => window.setVideoVolume(video, 0.6)).not.toThrow();
    expect(video.volume).toBe(0.6);
    expect(() => window.muted(video)).not.toThrow();
    expect(video.muted).toBe(true);
  });

  it.each(["setPlaybackRate", "setVolume", "mute", "unMute"])(
    "contains a throwing %s getter",
    (method) => {
      const { player, video } = bootYouTube();
      const api = { setVolume: vi.fn() };
      throwOnRead(api, method);
      player.wrappedJSObject = api;
      if (method === "setPlaybackRate") {
        expect(window.tryYouTubeNativeSpeed(video, 1.5)).toBe(false);
      } else if (method === "setVolume") {
        expect(() => window.setVideoVolume(video, 0.6)).not.toThrow();
        expect(video.volume).toBe(0.6);
      } else {
        video.muted = method === "unMute";
        expect(() => window.muted(video)).not.toThrow();
        expect(video.muted).toBe(method === "mute");
        if (method === "unMute") {
          expect(() => window.syncYouTubePlayerVolume(video, 0.6)).not.toThrow();
        }
      }
    }
  );

  it.each(["setPlaybackRate", "setVolume", "mute", "unMute"])(
    "contains an exception from %s",
    (method) => {
      const { player, video } = bootYouTube();
      const api = { setVolume: vi.fn() };
      api[method] = vi.fn(() => { throw new Error("page method failed"); });
      player.wrappedJSObject = api;
      if (method === "setPlaybackRate") {
        expect(window.tryYouTubeNativeSpeed(video, 1.5)).toBe(false);
      } else if (method === "setVolume") {
        expect(() => window.setVideoVolume(video, 0.6)).not.toThrow();
        expect(video.volume).toBe(0.6);
      } else {
        video.muted = method === "unMute";
        expect(() => window.muted(video)).not.toThrow();
        expect(video.muted).toBe(method === "mute");
        if (method === "unMute") {
          expect(() => window.syncYouTubePlayerVolume(video, 0.6)).not.toThrow();
        }
      }
      expect(api[method]).toHaveBeenCalled();
    }
  );

  it("ignores noncallable page properties", () => {
    const { player, video } = bootYouTube();
    player.wrappedJSObject = { setPlaybackRate: {}, setVolume: true, mute: 1, unMute: "yes" };
    expect(window.tryYouTubeNativeSpeed(video, 1.5)).toBe(false);
    expect(() => window.syncYouTubePlayerVolume(video, 0.6)).not.toThrow();
    expect(() => window.muted(video)).not.toThrow();
    expect(() => window.muted(video)).not.toThrow();
  });
});
