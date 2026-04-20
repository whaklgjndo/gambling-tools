// Edit these three fields once you've pushed the repo to GitHub.
// Every install button on the site builds its URL from this config.
window.SITE_CONFIG = {
  githubUser: "whaklgjndo",
  repo: "gambling-tools",
  branch: "main",
};

// Returns a raw.githubusercontent.com URL that Tampermonkey will
// auto-detect as a userscript and prompt to install.
window.scriptUrl = function (platform, filename) {
  const c = window.SITE_CONFIG;
  return `https://raw.githubusercontent.com/${c.githubUser}/${c.repo}/${c.branch}/${platform}/${filename}`;
};

// Wires up every <a data-script="Desktop/foo.user.js"> on the page.
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("a[data-script]").forEach((a) => {
    const [platform, file] = a.dataset.script.split("/");
    a.href = window.scriptUrl(platform, file);
  });
});
