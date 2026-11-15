# Hoofcraft

A bilingual pixel-art browser game about cleaning, trimming, and shoeing a horse hoof.

Open `index.html` through GitHub Pages or any static web server. The game has no build step or external runtime dependencies. It is an installable progressive web app: `manifest.webmanifest` and `sw.js` let it be added to a phone's home screen and played offline, with fonts and icons served from `fonts/` and `icons/`. Player preferences are stored locally; leaderboard scores are synchronized through the Cloudflare Worker in `worker/index.js`, backed by `scores.json` on the repository's `scores` branch.

The Worker expects a secret named `GITHUB_TOKEN` with read/write Contents access limited to this repository. Deploy it with the checked-in `wrangler.toml`; never place the token in source code or in the browser client.
