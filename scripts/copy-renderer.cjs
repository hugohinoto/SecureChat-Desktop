const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const source = path.join(root, "src", "renderer");
const target = path.join(root, "dist", "src", "renderer");
const webSource = path.join(root, "src", "web-client");
const webTarget = path.join(target, "web-client");

fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });
fs.mkdirSync(webTarget, { recursive: true });
fs.cpSync(webSource, webTarget, { recursive: true });

for (const name of fs.readdirSync(webTarget).filter(name => name.endsWith(".html"))) {
  const file = path.join(webTarget, name);
  let html = fs.readFileSync(file, "utf8");
  html = html.replace(/href="\//g, 'href="').replace(/src="\//g, 'src="');
  html = html.replace(/href="admin"/g, 'href="admin.html"');
  html = html.replace(/href="bug-report"/g, 'href="bug-report.html"');
  html = html.replace(/href=""/g, 'href="index.html"');
  if (name !== "offline.html" && !html.includes("desktop-bootstrap.js")) {
    html = html.replace(/<head>/i, '<head>\n  <script src="desktop-bootstrap.js"></script>');
  }
  fs.writeFileSync(file, html);
}

const appJs = path.join(webTarget, "app.js");
let appSource = fs.readFileSync(appJs, "utf8");
appSource = appSource.replace(/import\(["']\/crypto-v2\.bundle\.js["']\)/g, 'import("./crypto-v2.bundle.js")');
fs.writeFileSync(appJs, appSource);

for (const name of fs.readdirSync(webTarget).filter(name => name.endsWith(".css"))) {
  const file = path.join(webTarget, name);
  const css = fs.readFileSync(file, "utf8").replace(/url\((['"]?)\//g, "url($1./");
  fs.writeFileSync(file, css);
}

esbuild.buildSync({
  entryPoints: [path.join(webTarget, "crypto-v2.js")],
  outfile: path.join(webTarget, "crypto-v2.bundle.js"),
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  conditions: ["browser"],
  loader: { ".wasm": "file" },
  assetNames: "crypto/[name]-[hash]",
  publicPath: "./",
  legalComments: "none",
  logLevel: "info"
});
