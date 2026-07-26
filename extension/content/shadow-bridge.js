(function() {
  "use strict";

  if (window.__speederPageShadowBridgeInstalled) return;

  window.__speederPageShadowBridgeInstalled = true;

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
    Element.prototype.attachShadow = function() {
      var shadowRoot = originalAttachShadow.apply(this, arguments);
      try {
        this.dispatchEvent(
          new Event("speeder-shadow-root-attached", {
            bubbles: true,
            composed: true
          })
        );
      } catch (_error) {}
      return shadowRoot;
    };
  }

  ["pushState", "replaceState"].forEach(function(method) {
    if (typeof history === "undefined" || typeof history[method] !== "function") {
      return;
    }
    var original = history[method];
    history[method] = function() {
      var result = original.apply(this, arguments);
      notifyLocationChanged();
      return result;
    };
  });
})();
