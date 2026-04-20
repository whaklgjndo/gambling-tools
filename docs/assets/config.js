// Edit these three fields once you've pushed the repo to GitHub.
// Every install / download button on the site builds its URL from this config.
window.SITE_CONFIG = {
  githubUser: "whaklgjndo",
  repo: "gambling-tools",
  branch: "main",
};

window.scriptUrl = function (platform, filename) {
  const c = window.SITE_CONFIG;
  return `https://raw.githubusercontent.com/${c.githubUser}/${c.repo}/${c.branch}/${platform}/${filename}`;
};

// raw.githubusercontent.com serves with Access-Control-Allow-Origin: *,
// so fetch → blob → anchor.click works cross-origin and forces a true
// file download that Tampermonkey won't intercept.
async function downloadScriptFile(platform, filename) {
  const url = window.scriptUrl(platform, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 1500);
}

// Wires up every <a data-script="Platform/file.user.js"> on the page.
//
// Desktop buttons force a real file download (for the drag-into-Tampermonkey
// editor flow). Mobile buttons keep their URL — on iOS Safari the user taps
// Share → Save to Files, on Android Firefox the user long-presses and copies
// the link into the URL bar.
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("a[data-script]").forEach((a) => {
    const [platform, file] = a.dataset.script.split("/");
    a.href = window.scriptUrl(platform, file);

    if (platform === "Desktop") {
      a.setAttribute("download", file);
      const originalText = a.textContent.trim();
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        a.textContent = "Downloading…";
        try {
          await downloadScriptFile(platform, file);
          a.textContent = "Downloaded ✓";
          setTimeout(() => (a.textContent = originalText), 2500);
        } catch (err) {
          a.textContent = "Failed — right-click → Save Link As";
          console.error(err);
        }
      });
    }
  });
});
