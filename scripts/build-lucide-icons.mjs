import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

var root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var source = path.join(root, "node_modules/lucide-static");
var destination = path.join(root, "extension/options/vendor");
var pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
var version = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version;
if (pkg.devDependencies["lucide-static"] !== version) throw new Error("Lucide version mismatch");
var dom = new JSDOM("", { runScripts: "outside-only" });
dom.window.eval(fs.readFileSync(path.join(root, "extension/shared/ui-icons.js"), "utf8"));
var icons = {};
fs.readdirSync(path.join(source, "icons")).sort().forEach(function (file) {
  if (!file.endsWith(".svg")) return;
  var text = fs.readFileSync(path.join(source, "icons", file), "utf8");
  var svg = new dom.window.DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  // CSS class metadata and whitespace are unused by the picker. Keep only the
  // drawing, with upstream attribution in the adjacent license file.
  svg.removeAttribute("class");
  Array.from(svg.childNodes).forEach(function (node) {
    if (node.nodeType === 3 && !node.textContent.trim()) node.remove();
  });
  var before = svg.outerHTML;
  var safe = dom.window.vscSanitizeSvgTree(svg);
  if (!safe || safe.outerHTML !== before) throw new Error("Unsafe Lucide icon: " + file);
  icons[file.slice(0, -4)] = before;
});
var tags = JSON.parse(fs.readFileSync(path.join(source, "tags.json"), "utf8"));
Object.keys(tags).forEach(function (slug) {
  if (!icons[slug]) throw new Error("Missing tagged icon: " + slug);
});
fs.mkdirSync(destination, { recursive: true });
var output = JSON.stringify({ version: version, tags: tags, icons: icons });
fs.writeFileSync(path.join(destination, "lucide-icons.json"), output + "\n");
fs.copyFileSync(path.join(source, "LICENSE"), path.join(destination, "LICENSE"));
console.log(Object.keys(icons).length + " icons, " + Buffer.byteLength(output + "\n") + " bytes");
dom.window.close();
