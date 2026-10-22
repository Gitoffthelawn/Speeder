/* Runs via chrome.tabs.executeScript(allFrames) in the same isolated world as inject.js */
(function () {
  function isChallengeUrl(value) {
    try {
      var url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      var hostname = url.hostname.toLowerCase().replace(/\.$/, "");
      return (
        hostname === "challenges.cloudflare.com" ||
        hostname.endsWith(".challenges.cloudflare.com") ||
        url.pathname === "/cdn-cgi/challenge-platform" ||
        url.pathname.indexOf("/cdn-cgi/challenge-platform/") === 0
      );
    } catch (_error) {
      return false;
    }
  }

  function isChallengeDocument(win) {
    try {
      if (isChallengeUrl(win.location.href)) return true;
      if (!/^about:(blank|srcdoc)(?:[?#]|$)/i.test(win.location.href)) {
        return false;
      }
      // match_about_blank can inherit a challenge document's eligibility.
      if (
        isChallengeUrl(win.document.baseURI) ||
        isChallengeUrl(win.document.referrer)
      ) {
        return true;
      }
      return win.parent !== win && isChallengeDocument(win.parent);
    } catch (_error) {
      // A cross-origin ancestor is inaccessible; use only the URLs we can read.
      return false;
    }
  }

  if (isChallengeDocument(window)) return null;
  try {
    if (typeof getPrimaryVideoElement !== "function") {
      return null;
    }
    var v = getPrimaryVideoElement();
    if (!v) return null;
    return {
      speed: v.playbackRate,
      frameToken:
        typeof tc === "object" && typeof tc.frameToken === "string"
          ? tc.frameToken
          : null,
      diagnostics:
        typeof getDiagnosticsSnapshot === "function"
          ? getDiagnosticsSnapshot(v)
          : null,
      preferred: !v.paused,
      forceLastSavedSpeed: Boolean(
        typeof tc === "object" && tc.settings && tc.settings.forceLastSavedSpeed
      ),
      forceLastSavedSpeedControlledBySiteRule: Boolean(
        typeof tc === "object" &&
          tc.activeSiteRule &&
          tc.activeSiteRule.forceLastSavedSpeed !== undefined
      )
    };
  } catch (e) {
    return null;
  }
})();
