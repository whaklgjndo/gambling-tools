# Gambling Tools — Site

Static site for the Tampermonkey userscripts (Stake + Nuts). Free to host on
GitHub Pages, Netlify, or Cloudflare Pages.

## 1. Wire up install links

Open `site/assets/config.js` and fill in your GitHub username, repo name, and branch:

```js
window.SITE_CONFIG = {
  githubUser: "YOUR_GITHUB_USER",
  repo: "YOUR_REPO",
  branch: "main",
};
```

Every install button on the site builds its URL from these three values — you
only edit this file once.

## 2. Repo layout expected by the install buttons

Push this to GitHub as-is. The buttons point at:

```
https://raw.githubusercontent.com/<user>/<repo>/<branch>/Desktop/<file>.user.js
https://raw.githubusercontent.com/<user>/<repo>/<branch>/Mobile/<file>.user.js
```

So your repo root should contain:

```
/Desktop/    <-- all *-desktop.user.js files
/Mobile/     <-- all *-mobile.user.js files
/site/       <-- this site
```

That matches what's already on disk — no moving required.

## 3. Deploy to GitHub Pages

1. Create a public repo on GitHub and push this folder.
2. Repo → Settings → Pages → Source: **Deploy from a branch**.
3. Branch: `main`, folder: `/site`. Save.
4. Wait ~1 minute, your site will be at `https://<user>.github.io/<repo>/`.

## 4. (Optional) Custom domain

Add a `CNAME` file in `site/` with your domain, then point a CNAME DNS record at
`<user>.github.io`.

## 5. Local preview

Any static server works. Simplest:

```bash
cd site
python -m http.server 8000
# open http://localhost:8000
```

## How install buttons work

Tampermonkey auto-detects any URL ending in `.user.js` and prompts to install.
The `data-script="Desktop/foo.user.js"` attribute on each button is turned into
a raw GitHub URL by `assets/config.js` on page load.

If you ever move the userscripts into a subfolder, change the URL template in
`assets/config.js` — the rest of the site doesn't need to change.
