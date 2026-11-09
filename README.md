# Recipe Box

A simple static recipe website, ready for GitHub Pages. No build step and no server code.

## Pages
- `index.html`: home page with search, browse-by-type tiles, and recently added recipes
- `recipes.html`: searchable list with type filters (`?q=chicken`, `?type=dessert`)
- `recipe.html?id=...`: single recipe view with checkable ingredients

## Adding / editing recipes
Every recipe lives in one plain-text file: [`data/recipes.txt`](data/recipes.txt). The top of that
file explains the layout. In short: a title line, a `Category:` line, then sections like
`Ingredients:` and `Directions:`, with recipes separated by a line of dashes.

You can edit it right on GitHub (open the file, click the pencil icon, then **Commit changes**) and
the site updates within a minute or two.

### Adding a recipe from a photo
Click **+ Add recipe** on the site. It opens the private Recipe Inbox page on claude.ai
(https://claude.ai/artifact/JEoWe4Y1Pf7oDjzLF7nLAP), where you add photos, have Claude type them
up, fix anything, and click **Approve**. Then ask Claude Code to "add the approved recipes from my
Recipe Inbox": it copies them into `data/recipes.txt`, pushes, and marks them "On the site".

Categories: `breakfast`, `entree`, `side`, `soup`, `bread`, `dessert`, `snack`, `sauce`.
To add or rename categories, edit the `CATEGORIES` list at the top of [`js/app.js`](js/app.js).

Note: the pages load the recipe file over the web, so opening `index.html` straight from your
computer shows a "couldn't load" message. Use the GitHub Pages link instead.

## Publishing on GitHub Pages
1. Create a new repository on GitHub and push this folder to it.
2. In the repo, go to **Settings → Pages**, set **Source** to "Deploy from a branch",
   pick `main` and `/ (root)`, then save.
3. The site will appear at `https://<your-username>.github.io/<repo-name>/` within a minute or two.
