(function() {
  "use strict";

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

  function hasChallengeResource(node) {
    if (!node) return false;
    if (
      (node.nodeName === "SCRIPT" || node.nodeName === "IFRAME") &&
      isChallengeUrl(node.src)
    ) {
      return true;
    }
    if (!node.firstElementChild || typeof node.querySelectorAll !== "function") {
      return false;
    }
    var resources = node.querySelectorAll("script[src], iframe[src]");
    for (var i = 0; i < resources.length; i++) {
      if (isChallengeUrl(resources[i].src)) return true;
    }
    return false;
  }

  // Challenge pages inspect native APIs. Leave the page untouched, including
  // bridge flags and readiness events, even if the manifest was bypassed.
  if (isChallengeDocument(window) || hasChallengeResource(document)) return;

  function dispatchBridgeEvent(eventName) {
    try {
      document.dispatchEvent(
        new Event(eventName, {
          bubbles: true,
          composed: true
        })
      );
    } catch (_error) {}
  }

  function notifyBridgeReady() {
    if (window.__speederPageNavigationApiBridgeInstalled) {
      dispatchBridgeEvent("speeder-page-navigation-api-ready");
    }
    dispatchBridgeEvent("speeder-page-bridge-ready");
  }

  if (window.__speederPageShadowBridgeInstalled) {
    notifyBridgeReady();
    return;
  }

  window.__speederPageShadowBridgeInstalled = true;
  var attachShadowDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "attachShadow"
  );
  var wrappedAttachShadow = null;
  var historyWrappers = {};
  var navigation = null;

  function restorePageHooks() {
    if (wrappedAttachShadow && Element.prototype.attachShadow === wrappedAttachShadow) {
      Object.defineProperty(Element.prototype, "attachShadow", attachShadowDescriptor);
    }
    Object.keys(historyWrappers).forEach(function(method) {
      var entry = historyWrappers[method];
      if (history[method] !== entry.wrapper) return;
      if (entry.descriptor) {
        Object.defineProperty(history, method, entry.descriptor);
      } else {
        delete history[method];
      }
    });
    if (navigation && typeof navigation.removeEventListener === "function") {
      navigation.removeEventListener("currententrychange", notifyLocationChanged);
    }
    delete window.__speederPageShadowBridgeInstalled;
    delete window.__speederPageNavigationApiBridgeInstalled;
    document.removeEventListener("speeder-restore-page-hooks", restorePageHooks, true);
  }
  document.addEventListener("speeder-restore-page-hooks", restorePageHooks, true);

  function notifyLocationChanged() {
    try {
      document.dispatchEvent(
        new Event("speeder-location-changed", {
          bubbles: true,
          composed: true
        })
      );
    } catch (_error) {}
  }

  if (
    typeof Element !== "undefined" &&
    typeof Element.prototype.attachShadow === "function"
  ) {
    var originalAttachShadow = Element.prototype.attachShadow;
    wrappedAttachShadow = function() {
      var shadowRoot = originalAttachShadow.apply(this, arguments);
      try {
        (this.isConnected ? this : document).dispatchEvent(
          new Event(this.isConnected
            ? "speeder-shadow-root-attached"
            : "speeder-detached-shadow-root-attached", {
            bubbles: true,
            composed: true
          })
        );
      } catch (_error) {}
      return shadowRoot;
    };
    Element.prototype.attachShadow = wrappedAttachShadow;
  }

  ["pushState", "replaceState"].forEach(function(method) {
    if (typeof history === "undefined" || typeof history[method] !== "function") {
      return;
    }
    var original = history[method];
    var descriptor = Object.getOwnPropertyDescriptor(history, method);
    var wrapper = function() {
      var result = original.apply(this, arguments);
      notifyLocationChanged();
      return result;
    };
    historyWrappers[method] = { wrapper: wrapper, descriptor: descriptor };
    history[method] = wrapper;
  });

  // Modern Navigation API entries cover same-document navigations that do not
  // pass through the History wrappers above. The legacy content-side fallback
  // remains active when this API is unavailable or cannot be registered.
  if (
    window.navigation &&
    typeof window.navigation.addEventListener === "function"
  ) {
    try {
      window.navigation.addEventListener(
        "currententrychange",
        notifyLocationChanged
      );
      navigation = window.navigation;
      window.__speederPageNavigationApiBridgeInstalled = true;
    } catch (_error) {}
  }

  notifyBridgeReady();
})();
