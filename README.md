# Hoofcraft

A bilingual pixel-art browser game about cleaning, trimming, and shoeing a horse hoof.

Open `index.html` through GitHub Pages or any static web server. The game has no build step or external runtime dependencies. Player preferences are stored locally; leaderboard scores are synchronized through the Cloudflare Worker in `worker/index.js`, backed by `scores.json` on the repository's `scores` branch.

The Worker expects a secret named `GITHUB_TOKEN` with read/write Contents access limited to this repository. Deploy it with the checked-in `wrangler.toml`; never place the token in source code or in the browser client.
