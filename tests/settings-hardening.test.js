const {
  createChromeMock, evaluateScript, loadHtmlString
} = require("./helpers/extension-test-utils");
const icons = require("../extension/options/vendor/lucide-icons.json").icons;

function boot() {
  loadHtmlString('<!doctype html><html><body><div id="status"></div></body></html>');
  window.chrome = createChromeMock();
  global.chrome = window.chrome;
  evaluateScript("extension/shared/ui-icons.js");
  evaluateScript("extension/shared/key-bindings.js");
  evaluateScript("extension/shared/settings-core.js");
  evaluateScript("extension/shared/site-rules.js");
  evaluateScript("extension/shared/import-export.js");
  evaluateScript("extension/options/import-export.js");
}

function exportImportExport(raw, local) {
  const first = window.SpeederShared.importExport.buildBackupPayload(
    window.normalizedSettingsForExport(raw), local || {}, "2026-10-15T00:00:00Z"
  );
  const parsed = window.SpeederShared.importExport.extractImportSettings(first);
  const chrome = window.chrome;
  window.persistImportedSyncSettings(chrome.storage.sync._dump(), parsed.settings, (error) => {
    expect(error).toBeNull();
  });
  window.importLocalSettings(parsed.localSettings, (error) => expect(error).toBeNull());
  const second = window.SpeederShared.importExport.buildBackupPayload(
    window.normalizedSettingsForExport(chrome.storage.sync._dump()),
    window.SpeederShared.importExport.filterLocalSettingsForExport(chrome.storage.local._dump()),
    "2026-10-15T00:00:00Z"
  );
  expect(second).toEqual(first);
  return second;
}

describe("canonical field validation", () => {
  beforeEach(boot);

  it("repairs the audit probe identically for hydration and managed saves, and reports it", () => {
    const probe = {
      controllerLocation: { bad: true },
      controllerButtons: ["madeUp", 42, "pause", "rewind", "pause"],
      popupControllerButtons: ["settings", "pause", "pause"],
      keyBindings: [
        { action: "madeUp", code: 42, value: 7 },
        { action: "faster", code: "KeyD", value: 0.2, disabled: false, force: false }
      ],
      siteRules: [{ pattern: "example.org", mystery: true, controllerLocation: {}, controllerButtons: ["madeUp", "fast", "fast"] }]
    };
    const report = [];
    const hydrated = window.vscExpandStoredSettings(probe, report);
    expect(hydrated.controllerLocation).toBe("top-left");
    expect(hydrated.controllerButtons).toEqual(["pause", "rewind"]);
    expect(hydrated.popupControllerButtons).toEqual(["pause"]);
    expect(hydrated.keyBindings.map((binding) => binding.action)).toEqual(["faster"]);
    expect(hydrated.siteRules).toEqual([{ pattern: "example.org", controllerLocation: "top-left", controllerButtons: ["fast"] }]);
    expect(report).toEqual(expect.arrayContaining(["controllerLocation", "controllerButtons", "popupControllerButtons", "keyBindings", "siteRules[0]"]));
    const saved = window.vscExpandStoredSettings(window.vscBuildManagedStorageMutation({}, probe).set);
    expect(saved.controllerButtons).toEqual(hydrated.controllerButtons);
    expect(saved.keyBindings).toEqual(hydrated.keyBindings);
    expect(saved.siteRules).toEqual(hydrated.siteRules);
  });

  it("uses the same action value constraints before and after key-bindings loads", () => {
    for (const [action, value] of [["slower", 0], ["faster", 17], ["fast", 0.09], ["rewind", -1], ["advance", 0], ["louder", 2], ["softer", 0.3]]) {
      expect(window.SpeederShared.keyBindings.getActionValueError(action, value)).toBe(window.vscGetActionValueError(action, value));
      const stored = window.vscExpandStoredSettings({ keyBindings: [{ action, code: "KeyD", value }] });
      expect(stored.keyBindings[0].value).toBe(window.SpeederShared.keyBindings.sanitizeActionValue(action, value));
    }
    // Popup intentionally does not load key-bindings.js; hydration still validates.
    delete window.SpeederShared.keyBindings;
    expect(window.vscExpandStoredSettings({ keyBindings: [{ action: "fast", code: "KeyG", value: 100 }] }).keyBindings[0].value).toBe(1.8);
  });

  it("repairs JSON objects that cannot be converted to shortcut numbers", () => {
    const malformed = { toString: null, valueOf: null };
    const report = [];
    const settings = window.vscExpandStoredSettings({ keyBindings: [
      { action: "fast", code: "KeyG", value: malformed }
    ] }, report);
    expect(settings.keyBindings[0].value).toBe(1.8);
    expect(report).toContain("keyBindings");
    expect(window.SpeederShared.keyBindings.getActionValueError("fast", malformed)).toBe("must be a finite number");
    expect(() => window.vscExpandStoredSettings({ speedStep: malformed, resetKeyCode: malformed })).not.toThrow();
  });

  it("preserves disabled, Shift and numeric legacy bindings while dropping malformed fields", () => {
    const settings = window.vscExpandStoredSettings({ keyBindings: [
      { action: "pause", code: null, key: null, keyCode: null, value: 0 },
      { action: "advance", key: 88, shiftKey: true, value: 3, force: true },
      { action: "slower", key: "S", code: 23, value: 0.25, arbitrary: "drop" }
    ] });
    expect(settings.keyBindings[0].disabled).toBe(true);
    expect(settings.keyBindings[1]).toMatchObject({ key: 88, shiftKey: true, force: true });
    expect(window.SpeederShared.keyBindings.inferBindingCode(settings.keyBindings[1])).toBe("KeyX");
    expect(settings.keyBindings[2]).toMatchObject({ key: "S", value: 0.25 });
    expect(settings.keyBindings[2]).not.toHaveProperty("code");
    expect(settings.keyBindings[2]).not.toHaveProperty("arbitrary");
  });

  it("validates every local icon entry, sanitizes audit payloads and reports repairs", () => {
    const report = [];
    const clean = window.vscNormalizeLocalSettings({ customButtonIcons: {
      faster: { slug: "rocket", svg: icons.rocket },
      slower: { slug: "bad", svg: '<svg xmlns:q="http://www.w3.org/1999/xlink"><feImage q:href="https://example.org/a"/><path fill="u\\72l(https://example.org/a)" d="M0 0"/></svg>' },
      pause: { slug: "x", svg: "x".repeat(32769) },
      madeUp: { slug: "rocket", svg: icons.rocket },
      rewind: { slug: 42, svg: icons.rocket },
      advance: { slug: "rocket" }
    } }, report);
    expect(Object.keys(clean.customButtonIcons)).toEqual(["faster", "slower"]);
    expect(clean.customButtonIcons.faster.svg).toBe(icons.rocket);
    expect(clean.customButtonIcons.slower.svg).not.toMatch(/href|feImage|fill=|example/);
    expect(report).toEqual(expect.arrayContaining(["customButtonIcons.slower", "customButtonIcons.pause", "customButtonIcons.madeUp", "customButtonIcons.rewind", "customButtonIcons.advance"]));
  });

  it("drops overlong import patterns, reports them, and keeps 2048 characters", () => {
    const report = [];
    const raw = { siteRules: [{ pattern: "a".repeat(2049) }, { pattern: "a".repeat(2048), enabled: false }] };
    const settings = window.vscExpandStoredSettings(raw, report);
    expect(settings.siteRules).toHaveLength(1);
    expect(settings.siteRules[0].pattern).toHaveLength(2048);
    expect(report).toEqual(["siteRules[0]"]);
  });

  it("reports rejected legacy blacklist lines with their original indexes", () => {
    const report = [];
    const settings = window.vscExpandStoredSettings({ blacklist: "good.test\n\n" + "a".repeat(2049) }, report);
    expect(settings.siteRules.some((rule) => rule.pattern === "good.test")).toBe(true);
    expect(settings.siteRules.every((rule) => rule.pattern.length <= 2048)).toBe(true);
    expect(report).toEqual(["blacklist[2]"]);
  });

  it("round-trips a rich config including deletions, margins, lastSpeed and custom icons", () => {
    const settings = window.vscGetSettingsDefaults();
    settings.siteRules.splice(2, 1);
    delete settings.siteRules[0].title;
    delete settings.siteRules[1].rememberSpeed;
    settings.siteRules.push({ title: "My player", pattern: "example.org/watch", enabled: true, preferredSpeed: 1.75, controllerButtons: ["pause", "fast"], popupMatchHoverControls: false, popupControllerButtons: ["pause"], shortcuts: [
      { action: "fast", code: "KeyG", shiftKey: true, value: 2.4, force: true },
      { action: "pause", code: null, disabled: true, value: 0, force: false }
    ] });
    settings.keyBindings[2].disabled = true;
    settings.keyBindings[3].shiftKey = true;
    settings.controllerMarginRight = 23.5;
    settings.controllerMarginLeft = 17;
    settings.controllerMarginTop = 5.5;
    settings.controllerLocation = "bottom-center";
    settings.popupMatchHoverControls = false;
    settings.popupControllerButtons = ["pause", "fast"];
    settings.subtitleNudgeAmount = 0.004;
    const raw = window.vscBuildStoredSettingsDiff(settings);
    raw.lastSpeed = 1.85;
    const result = exportImportExport(raw, { customButtonIcons: {
      faster: { slug: "rocket", svg: icons.rocket }, subtitleNudgeOff: { slug: "x", svg: icons.x }
    } });
    expect(result.settings.lastSpeed).toBe(1.85);
    const restored = window.vscExpandStoredSettings(result.settings);
    expect(restored.controllerMarginRight).toBe(23.5);
    expect(restored.siteRules[0]).not.toHaveProperty("title");
    expect(restored.siteRules[1]).not.toHaveProperty("rememberSpeed");
  });

  it.each([
    { rememberSpeed: true },
    { speedStep: 0.25, rewindTime: 7, advanceTime: 14, fastSpeed: 2.25, displayKeyCode: 81, fasterKeyCode: 70, hideWithYouTubeControls: true, blacklist: "bad.test\nhttps://blocked.test/watch" },
    { siteRulesFormat: "defaults-diff-v1", siteRules: [{ pattern: "/youtube/i", controllerMarginTop: 72 }] },
    { keyBindings: [{ action: "pause", key: 80, value: 0 }, { action: "advance", keyCode: 88, shiftKey: true, value: 3 }] },
    { siteRules: [] }
  ])("round-trips legacy raw and wrapped backup settings %j", (fixture) => {
    for (const backup of [fixture, { version: "1.1", settings: fixture, localSettings: {} }]) {
      const parsed = window.SpeederShared.importExport.extractImportSettings(backup);
      expect(parsed).not.toBeNull();
      exportImportExport(parsed.settings, parsed.localSettings || {});
    }
  });

  it("round-trips the old full default list and legacy default rule patches", () => {
    const defaults = window.vscGetSettingsDefaults();
    const oldFullList = defaults.siteRules.slice(0, 2).map((rule) => {
      const old = { ...rule, audioBoolean: false, forceLastSavedSpeed: false };
      delete old.title;
      return old;
    });
    for (const fixture of [
      { siteRules: oldFullList },
      { siteRulesFormat: "defaults-diff-v1", siteRules: [{ pattern: defaults.siteRules[1].pattern, controllerMarginTop: 72 }] }
    ]) {
      for (const backup of [fixture, { settings: fixture }]) {
        const parsed = window.SpeederShared.importExport.extractImportSettings(backup);
        const restored = exportImportExport(parsed.settings, {});
        expect(window.vscExpandStoredSettings(restored.settings).siteRules).toHaveLength(3);
      }
    }
  });

  it.each([false, true])("surfaces partial imports including legacy blacklist losses (legacy=%s)", (legacy) => {
    vi.useFakeTimers();
    try {
      window.restore_options = vi.fn();
      const createElement = document.createElement.bind(document);
      const input = createElement("input");
      const payload = { settings: {
        controllerLocation: { bad: true }, controllerButtons: ["madeUp", 42],
        keyBindings: [{ action: "madeUp", code: 42 }],
        siteRules: [{ pattern: "example.org", unknown: true }, { pattern: "a".repeat(2049) }]
      }, localSettings: { customButtonIcons: { pause: { slug: "x", svg: "bad" } } } };
      if (legacy) payload.settings = { blacklist: "a".repeat(2049) };
      input.click = () => input.onchange({ target: { files: [{}] } });
      vi.spyOn(document, "createElement").mockImplementation((tag) => tag === "input" ? input : createElement(tag));
      window.FileReader = class { readAsText() { this.onload({ target: { result: JSON.stringify(payload) } }); } };
      window.importSettings();
      expect(document.getElementById("status").textContent).toMatch(/imported with repairs or dropped items/);
      for (const field of (legacy ? ["blacklist[0]"] : ["controllerLocation", "controllerButtons", "keyBindings", "siteRules[0]", "siteRules[1]", "customButtonIcons.pause"])) {
        expect(document.getElementById("status").textContent).toContain(field);
      }
      vi.advanceTimersByTime(500);
      expect(window.restore_options).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
