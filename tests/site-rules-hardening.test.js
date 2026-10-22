import siteRules from "../extension/shared/site-rules.js";
import {
  createChromeMock,
  flushAsyncWork,
  loadHtml,
  loadScript,
  triggerDomContentLoaded
} from "./helpers/browser.js";

describe("site rule pattern hardening", () => {
  it("accepts 2048 characters and skips overlong plain and regex patterns", () => {
    const atLimit = "/" + "a".repeat(2046) + "/";
    expect(siteRules.MAX_SITE_RULE_PATTERN_LENGTH).toBe(2048);
    expect(siteRules.validateSiteRulePattern(atLimit).valid).toBe(true);
    expect(siteRules.compileSiteRulePattern(atLimit)).not.toBeNull();
    for (const pattern of ["a".repeat(2049), "/" + "a".repeat(2047) + "/"]) {
      expect(siteRules.compileSiteRulePattern(pattern)).toBeNull();
      expect(siteRules.siteRuleMatchesUrl({ pattern }, "https://example.com")).toBe(false);
      expect(siteRules.validateSiteRulePattern(pattern)).toMatchObject({
        valid: false,
        error: expect.stringContaining("2048")
      });
    }
  });

  it.each(["/(a+)+$/", String.raw`/(\w*)*/`, "/(.*)*$/", "/([a-z]{1,5})+$/", "/((ab)+)+$/"])(
    "warns about nested quantifiers without rejecting %s",
    (pattern) => {
      expect(siteRules.validateSiteRulePattern(pattern)).toMatchObject({
        valid: true,
        warning: expect.stringContaining("nested quantifiers")
      });
    }
  );

  it.each([
    String.raw`/^https?:\/\/(www\.)?youtube\.com\//`,
    String.raw`/(a\+)+/`,
    "/([+*])+$/",
    "/(ab)+$/",
    "/(a+)?$/",
    "/(a{2})+$/",
    "youtube.com/watch"
  ])("does not warn for common or literal quantifiers in %s", (pattern) => {
    expect(siteRules.validateSiteRulePattern(pattern)).toMatchObject({
      valid: true,
      warning: ""
    });
  });

  it.each(["/youtube", "/[/", "/youtube/gg", "/youtube/z"])(
    "rejects invalid regex syntax and flags in %s",
    (pattern) => {
      expect(siteRules.validateSiteRulePattern(pattern).valid).toBe(false);
      expect(siteRules.siteRuleMatchesUrl({ pattern }, "https://youtube.com")).toBe(false);
    }
  );

  it("keeps decoded matching and global/sticky matching deterministic", () => {
    expect(siteRules.siteRuleMatchesUrl(
      { pattern: "/example\\.com\\/café/" },
      "https://example.com/caf%C3%A9"
    )).toBe(true);
    expect(siteRules.siteRuleMatchesUrl(
      { pattern: "example.com/café" },
      "https://sub.example.com/caf%C3%A9"
    )).toBe(true);
    for (const flags of ["g", "y", "gy"]) {
      const matcher = siteRules.compileSiteRulePattern("/^https:/" + flags);
      expect(matcher.test("https://example.com")).toBe(true);
      expect(matcher.test("https://example.com")).toBe(true);
    }
  });
});

async function bootOptions() {
  loadHtml("extension/options/options.html");
  const chrome = createChromeMock();
  globalThis.chrome = chrome;
  window.chrome = chrome;
  globalThis.fetch = vi.fn();
  for (const path of [
    "extension/shared/controller-utils.js",
    "extension/shared/key-bindings.js",
    "extension/shared/settings-core.js",
    "extension/shared/site-rules.js",
    "extension/shared/popup-controls.js",
    "extension/shared/ui-icons.js",
    "extension/options/lucide-client.js",
    "extension/options/options.js"
  ]) loadScript(path);
  triggerDomContentLoaded();
  await flushAsyncWork();
  chrome.storage.sync.set.mockClear();
  return chrome;
}

describe("options pattern feedback", () => {
  it("shows and clears an accessible inline advisory while allowing save", async () => {
    const chrome = await bootOptions();
    globalThis.createSiteRule({ pattern: "/(a+)+$/", enabled: true });
    const row = document.getElementById("siteRulesContainer").lastElementChild;
    const input = row.querySelector(".site-pattern");
    const feedback = row.querySelector(".site-pattern-feedback");
    expect(feedback.hidden).toBe(false);
    expect(feedback.textContent).toContain("nested quantifiers");
    expect(input.getAttribute("aria-describedby")).toBe(feedback.id);
    expect(input.getAttribute("aria-invalid")).toBe("false");
    globalThis.save_options();
    expect(chrome.storage.sync.set).toHaveBeenCalled();

    input.value = String.raw`/^https?:\/\/(www\.)?youtube\.com\//`;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(feedback.hidden).toBe(true);
    expect(feedback.textContent).toBe("");
  });

  it("blocks overlong patterns with a clear inline and save validation message", async () => {
    const chrome = await bootOptions();
    globalThis.createSiteRule(null);
    const row = document.getElementById("siteRulesContainer").lastElementChild;
    const input = row.querySelector(".site-pattern");
    input.value = "a".repeat(2049);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(row.querySelector(".site-pattern-feedback").textContent).toContain("2048");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    globalThis.save_options();
    expect(document.getElementById("status").textContent).toContain("2048");
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});
