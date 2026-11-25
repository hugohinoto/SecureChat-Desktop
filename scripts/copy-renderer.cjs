const fs = require("node:fs");
const path = require("node:path");
const source = path.join(__dirname, "..", "src", "renderer");
const target = path.join(__dirname, "..", "dist", "src", "renderer");
fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });
