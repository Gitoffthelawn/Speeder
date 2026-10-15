const { evaluateScript, loadHtmlString } = require("./helpers/extension-test-utils");
const bundle = require("../extension/options/vendor/lucide-icons.json");

describe("SVG allowlist", () => {
  beforeEach(() => {
    loadHtmlString("<!doctype html><html><body></body></html>");
    evaluateScript("extension/shared/ui-icons.js");
  });

  it("preserves every bundled Lucide drawing and attribute unchanged", () => {
    const elements = new Set();
    const attrs = new Set();
    for (const text of Object.values(bundle.icons)) {
      const svg = new window.DOMParser().parseFromString(text, "image/svg+xml").documentElement;
      const before = svg.outerHTML;
      const safe = window.vscSanitizeSvgTree(svg);
      expect(safe && safe.outerHTML).toBe(before);
      [svg, ...svg.querySelectorAll("*")].forEach((el) => {
        elements.add(el.localName);
        Array.from(el.attributes).forEach((attr) => attrs.add(attr.name));
      });
    }
    expect([...elements].sort()).toEqual(["circle", "ellipse", "line", "path", "polygon", "polyline", "rect", "svg"]);
    expect([...attrs].every((name) => name === "xmlns" || window.vscSvgAttributes.has(name))).toBe(true);
  });

  it("removes the audit bypasses, foreign nodes and their subtrees", () => {
    const safe = window.vscParseSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink">
      <feImage q:href="https://tracking.example/image"/>
      <path fill="u\\72l(https://tracking.example/a)" d="M0 0" q:href="https://tracking.example/b"/>
      <g xmlns="urn:foreign"><path d="bad"/></g>
      ${["image", "use", "style", "script", "foreignObject", "animate", "set", "a", "filter"].map((tag) => `<${tag}><circle r="1"/></${tag}>`).join("")}
      <rect style="fill:red" onclick="evil()" fill="url(#x)"/>
    </svg>`);
    expect([...safe.querySelectorAll("*")].map((el) => el.localName)).toEqual(["path", "rect"]);
    expect(safe.outerHTML).not.toMatch(/href|tracking|bad|onclick|style=|fill=|xmlns:q/);
  });

  it("checks attribute namespaces and values, with explicit transform grammar", () => {
    const safe = window.vscParseSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="urn:attrs">
      <path q:stroke="red" stroke="currentColor" fill="#abcdef" transform="translate(1, 2) rotate(-45)" d="M0 0"/>
      <path fill="red:blue" stroke="&amp;bad" transform="evil(1)" opacity="&lt;x" class="a:b"/>
    </svg>`);
    expect(safe.children[0].getAttribute("transform")).toBe("translate(1, 2) rotate(-45)");
    expect(safe.children[0].getAttribute("stroke")).toBe("currentColor");
    expect(safe.children[0].hasAttribute("q:stroke")).toBe(false);
    expect(safe.children[1].attributes.length).toBe(0);
    expect(window.vscParseSvg('<svg xmlns="urn:foreign"><path/></svg>')).toBeNull();
  });

  it("preserves harmless class metadata and rejects invalid or oversized classes", () => {
    const safe = window.vscParseSvg(`<svg><path class="lucide lucide-curly-braces"/>
      <path class="a:b"/><path class="a(b"/><path class="${"a".repeat(257)}"/></svg>`);
    expect(safe.children[0].getAttribute("class")).toBe("lucide lucide-curly-braces");
    for (const path of [...safe.children].slice(1)) expect(path.hasAttribute("class")).toBe(false);
  });

  it("rejects oversized strings and trees so renderers can use their default icon", () => {
    expect(window.vscParseSvg('<svg>' + ' '.repeat(32768) + '</svg>')).toBeNull();
    expect(window.vscParseSvg('<svg>' + '<path/>'.repeat(512) + '</svg>')).toBeNull();
    expect(window.vscParseSvg('<svg><!--' + 'x'.repeat(32768) + '--></svg>')).toBeNull();
    expect(window.vscCreateSvgWrap(document, '<svg>' + '<path/>'.repeat(512) + '</svg>')).toBeNull();
    expect(window.vscParseSvg('<svg><g>' + '<!--x-->'.repeat(512) + '</g></svg>')).toBeNull();
  });

  it("accepts namespace-less legacy backups and rejects malformed XML", () => {
    expect(window.vscParseSvg('<svg><path d="M0 0"/></svg>').namespaceURI).toBe(window.VSC_SVG_NS);
    expect(window.vscParseSvg('<svg/>')).not.toBeNull();
    expect(window.vscParseSvg('<svg><path></svg>')).toBeNull();
  });
});
