// Skip puppeteer's own ~150 MB Chrome download when a browser that can run
// WhatsApp Web is already installed (Microsoft Edge ships with Windows).
const { existsSync } = require("node:fs");
const { systemBrowserCandidates } = require("./src/browser-paths.cjs");

module.exports = {
  skipDownload: systemBrowserCandidates().some((path) => existsSync(path)),
};
