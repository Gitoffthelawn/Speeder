const {
  createChromeMock,
  evaluateScript,
  flushAsyncWork,
  fireDOMContentLoaded,
  installCommonWindowMocks,
  loadHtmlString
} = require("./helpers/extension-test-utils");

function bootImportExport(options) {
  const config = options || {};

  loadHtmlString(`<!doctype html><html><body>
    <button id="exportSettings">Export</button>
    <button id="importSettings">Import</button>
    <div id="status"></div>
  </body></html>`);

  installCommonWindowMocks();

  const chrome = createChromeMock({
    syncData: config.syncData,
    localData: config.localData
  });

  global.chrome = chrome;
  window.chrome = chrome;

  class TestBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
    }

    async text() {
      return this.parts.join("");
    }
  }
  global.Blob = TestBlob;
  window.Blob = TestBlob;

  const createObjectURL = vi.fn(() => "blob:test");
  const revokeObjectURL = vi.fn();
  Object.defineProperty(window.URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL
  });
  Object.defineProperty(window.URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL
  });
  global.URL = window.URL;

  evaluateScript("extension/shared/import-export.js");
  evaluateScript("extension/options/import-export.js");
  fireDOMContentLoaded();
  return { chrome, createObjectURL, revokeObjectURL };
}

describe("options/import-export.js", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete global.chrome;
  });

  it("generates timestamped backup filenames", () => {
    vi.setSystemTime(new Date("2026-04-04T13:14:15Z"));
    bootImportExport();

    expect(window.generateBackupFilename()).toBe(
      "speeder-backup_2026-04-04_09.14.15.json"
    );
  });

  it("exports sync and local settings into a downloadable backup", async () => {
    Object.defineProperty(window.HTMLAnchorElement.prototype, "click", {
      configurable: true,
      value: vi.fn()
    });
    const { createObjectURL, revokeObjectURL } = bootImportExport({
      syncData: {
        rememberSpeed: true,
        keyBindings: [{ action: "faster", code: "KeyD", value: 0.1 }]
      },
      localData: {
        customButtonIcons: {
          faster: { slug: "rocket", svg: "<svg></svg>" }
        }
      }
    });

    document.querySelector("#exportSettings").click();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    const backup = JSON.parse(await blob.text());

    expect(backup.settings.rememberSpeed).toBe(true);
    expect(backup.localSettings.customButtonIcons.faster.slug).toBe("rocket");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(document.querySelector("#status").textContent).toContain("exported");
  });

  it("omits Lucide tags cache from exported localSettings", async () => {
    Object.defineProperty(window.HTMLAnchorElement.prototype, "click", {
      configurable: true,
      value: vi.fn()
    });
    const { createObjectURL } = bootImportExport({
      syncData: { rememberSpeed: true },
      localData: {
        customButtonIcons: {
          faster: { slug: "rocket", svg: "<svg></svg>" }
        },
        lucideTagsCacheV1: { "a-arrow-down": ["letter", "text"] },
        lucideTagsCacheV1At: 999
      }
    });

    document.querySelector("#exportSettings").click();

    const blob = createObjectURL.mock.calls[0][0];
    const backup = JSON.parse(await blob.text());

    expect(backup.localSettings).toEqual({
      customButtonIcons: {
        faster: { slug: "rocket", svg: "<svg></svg>" }
      }
    });
    expect(backup.localSettings.lucideTagsCacheV1).toBeUndefined();
    expect(backup.localSettings.lucideTagsCacheV1At).toBeUndefined();
  });

  it("imports wrapped backups, restores local data, and refreshes the options page", async () => {
    const { chrome } = bootImportExport();
    window.restore_options = vi.fn();

    const realCreateElement = document.createElement.bind(document);
    const fakeInput = realCreateElement("input");
    Object.defineProperty(fakeInput, "files", {
      configurable: true,
      value: [
        {
          __contents: JSON.stringify({
            settings: {
              rememberSpeed: true,
              enabled: false
            },
            localSettings: {
              customButtonIcons: {
                faster: { slug: "rocket", svg: "<svg></svg>" }
              }
            }
          })
        }
      ]
    });
    fakeInput.click = vi.fn(() => {
      fakeInput.onchange({ target: fakeInput });
    });

    vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      if (String(tagName).toLowerCase() === "input") {
        return fakeInput;
      }
      return realCreateElement(tagName);
    });

    class FakeFileReader {
      readAsText(file) {
        this.onload({ target: { result: file.__contents } });
      }
    }

    vi.stubGlobal("FileReader", FakeFileReader);
    window.FileReader = FakeFileReader;

    document.querySelector("#importSettings").click();
    await flushAsyncWork();

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      {
        customButtonIcons: {
          faster: { slug: "rocket", svg: "<svg></svg>" }
        }
      },
      expect.any(Function)
    );
    expect(chrome.storage.sync.clear).toHaveBeenCalled();
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(
      { rememberSpeed: true, enabled: false },
      expect.any(Function)
    );

    vi.advanceTimersByTime(500);
    expect(window.restore_options).toHaveBeenCalled();
  });

  it("shows an error for malformed backups", async () => {
    bootImportExport();

    const realCreateElement = document.createElement.bind(document);
    const fakeInput = realCreateElement("input");
    Object.defineProperty(fakeInput, "files", {
      configurable: true,
      value: [{ __contents: "{bad json" }]
    });
    fakeInput.click = vi.fn(() => {
      fakeInput.onchange({ target: fakeInput });
    });

    vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      if (String(tagName).toLowerCase() === "input") {
        return fakeInput;
      }
      return realCreateElement(tagName);
    });

    class FakeFileReader {
      readAsText(file) {
        this.onload({ target: { result: file.__contents } });
      }
    }

    vi.stubGlobal("FileReader", FakeFileReader);
    window.FileReader = FakeFileReader;

    document.querySelector("#importSettings").click();
    await flushAsyncWork();

    expect(document.querySelector("#status").textContent).toContain(
      "Failed to parse backup file"
    );
  });
});
