// Shared code for all pages. Recipes are read from data/recipes.txt.

const CATEGORIES = [
  { id: "breakfast", name: "Breakfast", emoji: "🍳" },
  { id: "entree", name: "Entrees", emoji: "🍽️" },
  { id: "side", name: "Sides", emoji: "🥗" },
  { id: "soup", name: "Soups", emoji: "🍲" },
  { id: "bread", name: "Breads", emoji: "🍞" },
  { id: "dessert", name: "Desserts", emoji: "🍰" },
  { id: "snack", name: "Snacks", emoji: "🍿" },
  { id: "sauce", name: "Sauces & Basics", emoji: "🥫" },
];

let RECIPES = [];

function categoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || { id, name: id || "Other", emoji: "🍴" };
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

// ---------- Parsing data/recipes.txt ----------

const SMALL_WORDS = new Set(["a", "an", "and", "of", "de", "la", "the", "in", "with", "for", "or", "to"]);

// "GREAT-GRANDMOTHER'S CHERRY CAKE (Elfriede ...)" -> "Great-Grandmother's Cherry Cake (Elfriede ...)"
function prettyTitle(raw) {
  return raw.split(" ").map((word, i) => {
    if (!/[A-Z]/.test(word) || word !== word.toUpperCase()) return word; // leave mixed-case words alone
    const lower = word.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.replace(/(^|[-(/"])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }).join(" ");
}

function slugify(s) {
  return s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isHeading(line) {
  return line.length <= 60 && line.endsWith(":") && !/^-\s/.test(line) &&
    !/^\d+\.\s/.test(line) && !/\.\s/.test(line);
}

function parseRecipeBlock(block) {
  const rawLines = block.replace(/\s+$/, "").split(/\r?\n/);
  const fullTitle = prettyTitle(rawLines[0].trim());
  // Split "Main Name (source / notes)" or "Main Name — notes" into title + subtitle.
  const split = fullTitle.match(/^(.+?)\s+(?:\(|—\s*)(.*)$/);
  const title = split ? split[1] : fullTitle;
  const subtitle = split ? split[2].replace(/\)$/, "").replace(/\) \(/g, " · ").replace(/\) —\s*/, " · ") : "";
  const recipe = { title, subtitle, fullTitle, category: "", sections: [], intro: [], text: block };
  let section = { heading: "", blocks: [] };
  recipe.sections.push(section);
  let last = null; // current list/paragraph block, reset by blank lines

  for (const raw of rawLines.slice(1)) {
    const line = raw.trim();
    if (!line) { last = null; continue; }

    const cat = line.match(/^Category:\s*(.+)$/i);
    if (cat) { recipe.category = cat[1].trim().toLowerCase(); continue; }

    if (isHeading(line)) {
      section = { heading: line.slice(0, -1), blocks: [] };
      recipe.sections.push(section);
      last = null;
      continue;
    }

    // Indented line continues the previous list item.
    if (/^\s/.test(raw) && last && last.type !== "p") {
      last.items[last.items.length - 1] += " " + line.replace(/^-\s+/, "");
      continue;
    }

    let type = "p", content = line;
    if (/^-\s+/.test(line)) { type = "ul"; content = line.replace(/^-\s+/, ""); }
    else if (/^\d+\.\s+/.test(line)) { type = "ol"; content = line.replace(/^\d+\.\s+/, ""); }

    if (type !== "p" && last && last.type === type) {
      last.items.push(content);
    } else {
      last = { type, items: [content] };
      section.blocks.push(last);
      if (type === "p") last = null; // each paragraph line stands alone
    }
    if (recipe.sections.length === 1 && type === "p") recipe.intro.push(content);
  }

  recipe.sections = recipe.sections.filter((s) => s.blocks.length || s.heading);

  // Pull quick facts out of the intro lines (e.g. "Prep 15 min | Cook 20 min | Serves 4").
  const meta = recipe.intro.join(" | ");
  const grab = (re) => {
    const m = meta.match(re);
    if (!m) return "";
    let v = m[1].trim().replace(/[.;,]$/, "");
    if (v.endsWith(")") && !v.includes("(")) v = v.slice(0, -1);
    return v;
  };
  recipe.prep = grab(/\b(?:Prep|Active):?\s+(\d[^|;]*?)(?=\s*(?:\||;|$))/i);
  recipe.cook = grab(/\b(?:Cook|Bake):?\s+(\d[^|;]*?)(?=\s*(?:\||;|$))/i);
  recipe.total = grab(/\bTotal:?\s+([\d][^|;.]*)/i);
  recipe.yield = grab(/\b(?:Serves|Yield|Makes):?\s+([^|;.(]+)/i) ||
                 grab(/^(\d+\s+servings)/i);

  // Short description for cards: the first intro line, if there is one.
  recipe.description = (recipe.intro[0] || "").replace(/^\(|\)$/g, "");
  recipe.searchText = (title + " " + block + " " + categoryById(recipe.category).name).toLowerCase();
  return recipe;
}

function parseRecipes(text) {
  const parts = text.split(/^={10,}\s*$/m);
  const body = parts[parts.length - 1];
  const used = new Set();
  return body.split(/^-{10,}\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const r = parseRecipeBlock(b);
      const base = slugify(r.fullTitle).slice(0, 60).replace(/-$/, "") || "recipe";
      let id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      used.add(id);
      r.id = id;
      return r;
    });
}

async function loadRecipes() {
  try {
    const res = await fetch("data/recipes.txt", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    RECIPES = parseRecipes(await res.text());
  } catch (err) {
    console.error("Could not load recipes", err);
    document.querySelector("main")?.insertAdjacentHTML("afterbegin",
      `<div class="notes" style="margin-top:24px">Couldn't load the recipe list. If you opened this file
       directly from your computer, view it through GitHub Pages or a local web server instead.</div>`);
  }
  return RECIPES;
}

// ---------- Search & rendering helpers ----------

function searchRecipes(query, category) {
  const terms = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return RECIPES.filter((r) => {
    if (category && category !== "all" && r.category !== category) return false;
    return terms.every((t) => r.searchText.includes(t));
  }).sort((a, b) => a.title.localeCompare(b.title));
}

function timeLabel(r) {
  if (r.total) return r.total;
  if (r.prep && r.cook) return `${r.prep} + ${r.cook}`;
  return r.prep || r.cook || "";
}

function recipeCardHtml(r) {
  const cat = categoryById(r.category);
  const time = timeLabel(r);
  return `
    <a class="recipe-card" href="recipe.html?id=${encodeURIComponent(r.id)}">
      <div class="thumb">${cat.emoji}</div>
      <div class="body">
        <span class="badge">${escapeHtml(cat.name)}</span>
        <h3>${escapeHtml(r.title)}</h3>
        ${r.subtitle ? `<div class="subtitle">${escapeHtml(r.subtitle)}</div>` : ""}
        ${r.description ? `<p>${escapeHtml(r.description)}</p>` : ""}
        <div class="meta">
          ${time ? `<span>⏱ ${escapeHtml(time)}</span>` : ""}
          ${r.yield ? `<span>🍽 ${escapeHtml(r.yield)}</span>` : ""}
        </div>
      </div>
    </a>`;
}

function setFooterYear() {
  const el = document.getElementById("year");
  if (el) el.textContent = new Date().getFullYear();
}

document.addEventListener("DOMContentLoaded", setFooterYear);
