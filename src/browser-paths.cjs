// Shared by .puppeteerrc.cjs (install time, CommonJS) and src/browser.ts (run time).
const path = require("node:path");

function systemBrowserCandidates() {
  const env = process.env;
  if (process.platform === "win32") {
    const roots = [env["PROGRAMFILES(X86)"], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((root) => [
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    ]);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}

module.exports = { systemBrowserCandidates };
