// Recipe Box submissions - a Cloudflare Worker.
//
//   /               public page where anyone can send in a new recipe (plus optional dish photos)
//   /photos         public page for adding dish photos (or a cover photo) to a recipe already on the site
//   /admin          password-protected page where the owner approves or deletes submissions
//   /api/approved   read-only JSON list of approved submissions (used when adding them to the site)
//
// Once a submission is on the site (its id is in data/imported-submissions.txt), its photos are
// deleted from storage here, so storage doesn't fill up. That happens when /admin is opened and
// on the optional daily cron trigger (see SETUP.md).
//
// Setup (see SETUP.md): bind a KV namespace as SUBMISSIONS and add an ADMIN_PASSWORD secret.
// Optional spam check: TURNSTILE_SITE_KEY (variable) and TURNSTILE_SECRET_KEY (secret).

const SITE_URL = "https://lawevanp.github.io/recipe-box/";
const IMPORTED_URL = SITE_URL + "data/imported-submissions.txt";
const RECIPES_URL = SITE_URL + "data/recipes.txt";
const MAX_PHOTOS = 6;       // photos of the recipe itself (card, cookbook page...)
const MAX_DISH_PHOTOS = 6;  // photos of the finished dish
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const SUBMITS_PER_HOUR = 5;
const LOGINS_PER_HOUR = 10;
const CATEGORIES = ["breakfast", "entree", "side", "soup", "bread", "dessert", "snack", "sauce"];
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (!env.SUBMISSIONS || !env.ADMIN_PASSWORD) {
        return text("This page isn't set up yet: the SUBMISSIONS storage or ADMIN_PASSWORD is missing.", 503);
      }
      if (path === "/" && request.method === "GET") return html(submitPage(env));
      if (path === "/photos" && request.method === "GET") return html(await photosPage(env, url));
      if (path === "/submit" && request.method === "POST") return await submit(request, env);
      if (path === "/admin" && request.method === "GET") return await adminPage(request, env, url);
      if (path === "/admin" && request.method === "POST") return await login(request, env);
      if (path === "/admin/action" && request.method === "POST") return await adminAction(request, env);
      if (path === "/admin/logout") return logout();
      if (path.startsWith("/photo/") && request.method === "GET") return await photo(request, env, path.slice(7));
      if (path === "/api/approved" && request.method === "GET") return await approvedApi(env, url);
      return text("Not found", 404);
    } catch (err) {
      console.error(err);
      return text("Something went wrong. Please try again.", 500);
    }
  },
  // Optional daily cron trigger: clear out photos of submissions that are now on the site.
  async scheduled(event, env, ctx) {
    if (env.SUBMISSIONS) ctx.waitUntil(cleanUpImported(env, await importedIds(), await allSubs(env)));
  },
};

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      ...headers,
    },
  });
}
const text = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const json = (data) => new Response(JSON.stringify(data, null, 2), {
  headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" },
});
const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const clientIp = (request) => request.headers.get("cf-connecting-ip") || "unknown";

// Allow `limit` actions per hour per visitor (stored as a counter that expires).
async function underLimit(env, kind, request, limit) {
  const key = `rl:${kind}:${await sha256(clientIp(request))}:${Math.floor(Date.now() / 3600000)}`;
  const count = parseInt((await env.SUBMISSIONS.get(key)) || "0", 10);
  if (count >= limit) return false;
  await env.SUBMISSIONS.put(key, String(count + 1), { expirationTtl: 3700 });
  return true;
}

async function adminToken(env) { return sha256(env.ADMIN_PASSWORD + "|recipe-box-admin"); }
async function isAdmin(request, env) {
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)rb_admin=([0-9a-f]{64})/);
  return !!m && m[1] === (await adminToken(env));
}

async function getSub(env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return env.SUBMISSIONS.get(`sub:${id}`, "json");
}
async function putSub(env, sub) {
  await env.SUBMISSIONS.put(`sub:${sub.id}`, JSON.stringify(sub), {
    metadata: { status: sub.status, createdAt: sub.createdAt },
  });
}
async function allSubs(env) {
  const subs = [];
  let cursor;
  do {
    const page = await env.SUBMISSIONS.list({ prefix: "sub:", cursor });
    for (const k of page.keys) {
      const s = await env.SUBMISSIONS.get(k.name, "json");
      if (s) subs.push(s);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const dishOf = (sub) => sub.dish || [];
const kindOf = (sub) => sub.kind || "recipe";

// Delete stored photos for submissions that are already on the site. The submission record
// itself (a few hundred bytes) is kept so it still shows under "On the site".
async function cleanUpImported(env, imported, subs) {
  for (const sub of subs) {
    if (!imported.has(sub.id) || sub.cleaned) continue;
    for (const p of [...sub.photos, ...dishOf(sub).map((d) => d.pid)]) await env.SUBMISSIONS.delete(`photo:${p}`);
    sub.cleaned = true;
    sub.cleanedAt = new Date().toISOString();
    await putSub(env, sub);
  }
}

const SMALL_WORDS = new Set(["a", "an", "and", "of", "de", "la", "the", "in", "with", "for", "or", "to"]);
function prettyTitle(raw) { // same as the site: "APPLE PIE (from Jane)" -> "Apple Pie (from Jane)"
  return raw.split(" ").map((word, i) => {
    if (!/[A-Z]/.test(word) || word !== word.toUpperCase()) return word;
    const lower = word.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.replace(/(^|[-(/"])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }).join(" ");
}

// Recipes on the site: [{ title (exact first line in recipes.txt), name (pretty), hasCover }].
async function siteRecipes() {
  try {
    const r = await fetch(RECIPES_URL, { cf: { cacheTtl: 300 } });
    if (!r.ok) return [];
    const parts = (await r.text()).split(/^={10,}\s*$/m);
    return parts[parts.length - 1].split(/^-{10,}\s*$/m).map((b) => b.trim()).filter(Boolean).map((b) => {
      const title = b.split(/\r?\n/)[0].trim();
      return { title, name: prettyTitle(title), hasCover: /^Cover photo:/im.test(b) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// Submission ids already added to the site (listed in the site's repo).
async function importedIds() {
  try {
    const r = await fetch(IMPORTED_URL, { cf: { cacheTtl: 60 } });
    if (!r.ok) return new Set();
    return new Set((await r.text()).split(/\s+/).filter(Boolean));
  } catch { return new Set(); }
}

// ---------------------------------------------------------------- shared look

const STYLE = `
:root{--bg:#fbf8f3;--card:#fff;--ink:#2b2622;--muted:#6f655c;--accent:#c0562f;--accent-ink:#fff;--line:#e8e0d5;--chip:#f3ebe0;--bad:#a33a2a;--good:#2f6b3f}
@media (prefers-color-scheme:dark){:root{--bg:#1c1916;--card:#26221e;--ink:#f1ebe4;--muted:#b3a89c;--accent:#e27a52;--accent-ink:#1c1916;--line:#3a342e;--chip:#332d27;--bad:#f0957a;--good:#8fd19e;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px max(16px,env(safe-area-inset-right)) 48px max(16px,env(safe-area-inset-left))}
.wrap{max-width:720px;margin:0 auto;display:grid;gap:20px}
a{color:var(--accent)}
h1{margin:0;font-size:1.9rem;line-height:1.2}
h2{margin:0;font-size:1.2rem}
.sub{color:var(--muted);margin:4px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;display:grid;gap:14px}
label{font-weight:600;display:block;margin-bottom:4px}
.hint{color:var(--muted);font-size:.9rem;font-weight:400}
input[type=text],input[type=password],select,textarea{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
textarea{min-height:90px;resize:vertical}
.row{display:flex;flex-wrap:wrap;gap:12px}.row>*{flex:1 1 200px;min-width:0}
.btn,button{font:inherit;font-weight:600;border-radius:8px;padding:10px 16px;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink);text-decoration:none;display:inline-block}
.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.danger{color:var(--bad)}
button:disabled{opacity:.55;cursor:default}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.drop{border:2px dashed var(--line);border-radius:10px;padding:22px 16px;text-align:center;cursor:pointer;display:block;color:var(--muted);font-weight:400}
.drop strong{display:block;color:var(--ink);font-size:1.05rem}
.drop input{position:absolute;width:1px;height:1px;opacity:0}
.thumbs{display:flex;flex-wrap:wrap;gap:8px}
.thumbs img{width:96px;height:96px;object-fit:cover;border-radius:6px;border:1px solid var(--line);background:var(--chip)}
.status{min-height:1.4em;color:var(--muted)}.status.err{color:var(--bad)}.status.ok{color:var(--good)}
.hp{position:absolute;left:-9999px}
.tabs{display:flex;flex-wrap:wrap;gap:6px}
.tabs a{padding:6px 14px;border-radius:999px;border:1px solid var(--line);text-decoration:none;color:var(--ink);font-weight:600}
.tabs a[aria-current=page]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.pill{font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 10px;border-radius:999px;background:var(--chip);color:var(--accent);white-space:nowrap}
.head{display:flex;justify-content:space-between;gap:12px;align-items:start;flex-wrap:wrap}
.meta{color:var(--muted);font-size:.9rem}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.actions form{margin:0}
details summary{cursor:pointer;color:var(--bad);font-weight:600;list-style:none;padding:10px 0}
.empty{color:var(--muted);text-align:center;padding:28px 8px}
.notes{white-space:pre-wrap;border-left:3px solid var(--accent);padding-left:10px;margin:0}
.section-label{margin:0;font-size:1.05rem}
.dish{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.ph{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg);display:grid;position:relative}
.ph.off{opacity:.45}
.ph img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:var(--chip)}
.ph .pb{display:grid;gap:6px;padding:8px}
.ph input[type=text]{padding:6px 8px;font-size:.9rem}
.ph .opt{display:flex;gap:6px;align-items:center;font-weight:500;font-size:.9rem;margin:0;cursor:pointer}
.ph .x{position:absolute;top:6px;right:6px;padding:2px 9px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;border:0;font-size:.9rem}
.ph .star{position:absolute;top:6px;left:6px;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:999px;background:var(--accent);color:var(--accent-ink)}
.nocover{font-weight:400;color:var(--muted);display:flex;gap:6px;align-items:center;margin:0;cursor:pointer}
.switch{color:var(--muted);margin:0}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

// ---------------------------------------------------------------- public submit pages

// Photo picker for dish photos: each photo gets a "Photo by" tag, and one can be the cover.
// Plain (backtick-free) client code, shared by both public pages.
const DISH_PICKER = `
function shrink(file,max,q){return (async()=>{try{const bmp=await createImageBitmap(file);const s=Math.min(1,max/Math.max(bmp.width,bmp.height));
  const c=document.createElement("canvas");c.width=Math.round(bmp.width*s);c.height=Math.round(bmp.height*s);
  c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
  return await new Promise((r)=>c.toBlob((b)=>r(b||file),"image/jpeg",q));}catch(e){return file;}})();}
function dishPicker(opts){
  // galleryFirst: the recipe already has a cover, so photos just join the gallery unless the sender suggests one as the new cover.
  const items=[];let cover=0,galleryFirst=false;const list=document.getElementById(opts.list);const none=document.getElementById(opts.none);
  function render(){
    list.replaceChildren(...items.map((it,i)=>{
      const d=document.createElement("div");d.className="ph";
      const img=document.createElement("img");img.src=it.url;img.alt="Dish photo "+(i+1);
      const x=document.createElement("button");x.type="button";x.className="x";x.textContent="✕";x.setAttribute("aria-label","Remove photo "+(i+1));
      x.onclick=()=>{items.splice(i,1);if(cover===i)cover=items.length?0:-1;else if(cover>i)cover--;render();};
      const pb=document.createElement("div");pb.className="pb";
      const by=document.createElement("input");by.type="text";by.maxLength=80;by.placeholder="Photo by (optional)";by.value=it.by;
      by.setAttribute("aria-label","Who made or took photo "+(i+1));by.oninput=()=>{it.by=by.value;};
      const lab=document.createElement("label");lab.className="opt";
      const r=document.createElement("input");r.type="radio";r.name="coverpick";r.checked=cover===i;r.onchange=()=>{cover=i;render();};
      lab.append(r,galleryFirst?" Suggest as the new cover":" Cover photo");pb.append(by,lab);d.append(img,x,pb);
      if(cover===i){const s=document.createElement("span");s.className="star";s.textContent=galleryFirst?"Suggested cover":"Cover";d.append(s);}
      return d;}));
    if(none){none.hidden=!items.length;none.querySelector("input").checked=cover<0&&items.length>0;
      none.querySelector("span").textContent=galleryFirst?" Just add to the gallery (keep the current cover)":" None of these as the cover photo";}
  }
  document.getElementById(opts.input).addEventListener("change",(e)=>{
    for(const f of e.target.files){if(items.length>=opts.max)break;items.push({file:f,url:URL.createObjectURL(f),by:""});}
    e.target.value="";if(cover<0&&items.length&&!galleryFirst)cover=0;render();});
  if(none)none.querySelector("input").addEventListener("change",()=>{cover=-1;render();});
  return{count:()=>items.length,reset:()=>{items.length=0;cover=galleryFirst?-1:0;render();},
    setGalleryFirst(v){galleryFirst=!!v;cover=galleryFirst?-1:0;render();},
    async addTo(fd,defaultBy){for(const [i,it] of items.entries()){fd.append("dish",await shrink(it.file,1600,0.82),"dish-"+(i+1)+".jpg");fd.append("dishBy",it.by.trim()||defaultBy);}
      fd.set("cover",String(items.length?cover:-1));}};
}`;

function dishSection(heading, hint) {
  return `
  <div><h2 class="section-label">${heading}</h2><p class="hint" style="margin:2px 0 0">${hint}</p></div>
  <label class="drop" for="dish">
    <input id="dish" type="file" accept="image/*" multiple>
    <strong>Tap to add photos of the dish</strong>
    Up to ${MAX_DISH_PHOTOS}. You can add who made it or took each photo.
  </label>
  <div class="dish" id="dishlist"></div>
  <label class="nocover" id="nocover" hidden><input type="radio" name="coverpick"><span> None of these as the cover photo</span></label>`;
}

function submitScript(env, { needRecipePhotos }) {
  return `${env.TURNSTILE_SITE_KEY ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
<script>${DISH_PICKER}
const MAX=${MAX_PHOTOS}; let files=[];
const $=(id)=>document.getElementById(id);
const dish=dishPicker({input:"dish",list:"dishlist",none:"nocover",max:${MAX_DISH_PHOTOS}});
if($("target")){const t=$("target"),sync=()=>dish.setGalleryFirst(t.selectedOptions[0]&&t.selectedOptions[0].dataset.cover==="1");
  t.addEventListener("change",sync);sync();}
if($("photos"))$("photos").addEventListener("change",(e)=>{files=[...e.target.files].slice(0,MAX);
  $("thumbs").replaceChildren(...files.map((f)=>Object.assign(document.createElement("img"),{src:URL.createObjectURL(f),alt:""})));});
$("f").addEventListener("submit",async(e)=>{e.preventDefault();const st=$("status"),btn=$("send");
  ${needRecipePhotos
    ? `if(!files.length){st.className="status err";st.textContent="Add at least one photo of the recipe.";return;}`
    : `if(!$("target").value){st.className="status err";st.textContent="Pick which recipe these photos are for.";return;}
  if(!dish.count()){st.className="status err";st.textContent="Add at least one photo.";return;}`}
  btn.disabled=true;st.className="status";st.textContent="Sending…";
  const fd=new FormData($("f"));fd.delete("photos");fd.delete("coverpick");
  for(const [i,f] of files.entries()){fd.append("photos",await shrink(f,2000,0.85),"photo-"+(i+1)+".jpg");}
  await dish.addTo(fd,($("name").value||"").trim());
  try{const r=await fetch("/submit",{method:"POST",body:fd});const msg=await r.text();
    if(r.ok){$("f").reset();files=[];if($("thumbs"))$("thumbs").replaceChildren();dish.reset();st.className="status ok";st.textContent=msg;}
    else{st.className="status err";st.textContent=msg;}
  }catch{st.className="status err";st.textContent="Couldn't send. Check your connection and try again.";}
  finally{btn.disabled=false;if(window.turnstile)turnstile.reset();}});
</script>`;
}

const spamFields = (env) => `
  <div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
  ${env.TURNSTILE_SITE_KEY ? `<div class="cf-turnstile" data-sitekey="${esc(env.TURNSTILE_SITE_KEY)}"></div>` : ""}`;

function submitPage(env) {
  return page("Share a Recipe", `
<header>
  <h1>Share a recipe</h1>
  <p class="sub">Send a photo of a recipe card, cookbook page or handwritten note. It'll be checked before it goes on <a href="${SITE_URL}">Recipe Box</a>.</p>
  <p class="switch">Have a photo of a dish that's already on the site? <a href="/photos">Add photos to a recipe</a></p>
</header>
<form class="card" id="f" novalidate>
  <input type="hidden" name="kind" value="recipe">
  <label class="drop" for="photos">
    <input id="photos" name="photos" type="file" accept="image/*" multiple>
    <strong>Tap to take or choose photos of the recipe</strong>
    Up to ${MAX_PHOTOS}. Front and back of a card is fine.
  </label>
  <div class="thumbs" id="thumbs"></div>
  <div class="row">
    <div><label for="recipe">Recipe name <span class="hint">(optional)</span></label>
      <input id="recipe" name="recipe" type="text" maxlength="120" placeholder="e.g. Grandma's apple pie"></div>
    <div><label for="name">Your name <span class="hint">(optional, shown with the recipe)</span></label>
      <input id="name" name="name" type="text" maxlength="80" autocomplete="name"></div>
  </div>
  <div><label for="category">Dish type</label>
    <select id="category" name="category"><option value="">Not sure</option>
      ${CATEGORIES.map((c) => `<option>${c}</option>`).join("")}</select></div>
  <div><label for="notes">Notes <span class="hint">(optional)</span></label>
    <textarea id="notes" name="notes" maxlength="2000" placeholder="Anything to know about it: where it's from, changes you make…"></textarea></div>
  ${dishSection("Photos of the finished dish <span class=\"hint\">(optional)</span>", "These are shown on the recipe's page. The cover photo also appears on the recipe's card.")}
  ${spamFields(env)}
  <div class="actions"><button class="primary" id="send" type="submit">Send recipe</button></div>
  <div class="status" id="status" role="status"></div>
</form>
${submitScript(env, { needRecipePhotos: true })}`);
}

async function photosPage(env, url) {
  const recipes = await siteRecipes();
  const want = url.searchParams.get("recipe") || "";
  const picked = recipes.find((r) => r.title === want);
  return page("Add Recipe Photos", `
<header>
  <h1>Add photos to a recipe</h1>
  <p class="sub">Made something from <a href="${SITE_URL}">Recipe Box</a>? Share a photo of it. Photos are checked before they appear on the site.</p>
  <p class="switch">Sending a whole new recipe instead? <a href="/">Share a recipe</a></p>
</header>
<form class="card" id="f" novalidate>
  <input type="hidden" name="kind" value="photos">
  <div><label for="target">Recipe</label>
    <select id="target" name="target" required>
      <option value="">Choose a recipe…</option>
      ${recipes.map((r) => `<option value="${esc(r.title)}"${r.hasCover ? ' data-cover="1"' : ""}${r === picked ? " selected" : ""}>${esc(r.name)}${r.hasCover ? "" : " · needs a cover photo"}</option>`).join("")}
    </select>
    ${recipes.length ? "" : `<p class="hint">Couldn't load the recipe list. Please try again in a minute.</p>`}</div>
  <div><label for="name">Your name <span class="hint">(optional, shown with your photos)</span></label>
    <input id="name" name="name" type="text" maxlength="80" autocomplete="name"></div>
  ${dishSection("Your photos", "They're added to the recipe's photo gallery. If it already has a cover photo, you can suggest one of yours as the new cover, and the reviewer decides.")}
  <div><label for="notes">Notes <span class="hint">(optional, for the reviewer)</span></label>
    <textarea id="notes" name="notes" maxlength="1000"></textarea></div>
  ${spamFields(env)}
  <div class="actions"><button class="primary" id="send" type="submit">Send photos</button></div>
  <div class="status" id="status" role="status"></div>
</form>
${submitScript(env, { needRecipePhotos: false })}`);
}

async function submit(request, env) {
  const form = await request.formData();
  if (form.get("website")) return text("Thanks! Your recipe was sent."); // honeypot: quietly drop bots

  if (env.TURNSTILE_SECRET_KEY) {
    const body = new FormData();
    body.append("secret", env.TURNSTILE_SECRET_KEY);
    body.append("response", String(form.get("cf-turnstile-response") || ""));
    body.append("remoteip", clientIp(request));
    const check = await (await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body })).json();
    if (!check.success) return text("The spam check didn't pass. Please reload the page and try again.", 400);
  }
  if (!(await underLimit(env, "submit", request, SUBMITS_PER_HOUR))) {
    return text("That's a lot of recipes at once! Please wait an hour and send the rest.", 429);
  }

  const kind = form.get("kind") === "photos" ? "photos" : "recipe";
  const files = (k, max) => form.getAll(k).filter((p) => typeof p === "object" && p.size > 0).slice(0, max);
  const photos = kind === "recipe" ? files("photos", MAX_PHOTOS) : [];
  const dish = files("dish", MAX_DISH_PHOTOS);
  const clip = (v, n) => String(v || "").trim().slice(0, n);

  let target = "";
  if (kind === "recipe" && !photos.length) return text("Add at least one photo of the recipe.", 400);
  if (kind === "photos") {
    if (!dish.length) return text("Add at least one photo.", 400);
    target = clip(form.get("target"), 200);
    if (!(await siteRecipes()).some((r) => r.title === target)) return text("Pick which recipe these photos are for.", 400);
  }
  for (const p of [...photos, ...dish]) {
    if (!PHOTO_TYPES.includes(p.type)) return text("Photos need to be JPEG, PNG, WebP or GIF.", 400);
    if (p.size > MAX_PHOTO_BYTES) return text("One of the photos is too large (over 8 MB).", 400);
  }

  const id = crypto.randomUUID();
  const photoIds = [];
  for (let i = 0; i < photos.length; i++) {
    const pid = `${id}-${i + 1}`;
    await env.SUBMISSIONS.put(`photo:${pid}`, await photos[i].arrayBuffer(), { metadata: { type: photos[i].type } });
    photoIds.push(pid);
  }
  const name = clip(form.get("name"), 80);
  const credits = form.getAll("dishBy");
  const cover = parseInt(String(form.get("cover") ?? "0"), 10);
  const dishList = [];
  for (let i = 0; i < dish.length; i++) {
    const pid = `${id}-d${i + 1}`;
    await env.SUBMISSIONS.put(`photo:${pid}`, await dish[i].arrayBuffer(), { metadata: { type: dish[i].type } });
    dishList.push({ pid, by: clip(credits[i], 80) || name, cover: i === cover });
  }
  const category = clip(form.get("category"), 20);
  await putSub(env, {
    id,
    kind,
    createdAt: new Date().toISOString(),
    status: "pending",
    recipe: kind === "recipe" ? clip(form.get("recipe"), 120) : "",
    target,
    name,
    category: kind === "recipe" && CATEGORIES.includes(category) ? category : "",
    notes: clip(form.get("notes"), 2000),
    photos: photoIds,
    dish: dishList,
  });
  return text(kind === "photos"
    ? "Thanks! Your photos were sent and will show up on the recipe once they've been checked."
    : "Thanks! Your recipe was sent and will be added once it's been checked.");
}

// ---------------------------------------------------------------- photos

async function photo(request, env, pid) {
  const m = pid.match(/^([0-9a-f-]{36})-(d?\d+)$/);
  if (!m) return text("Not found", 404);
  const sub = await getSub(env, m[1]);
  if (!sub || !(sub.photos.includes(pid) || dishOf(sub).some((d) => d.pid === pid))) return text("Not found", 404);
  // Approved photos are about to be public anyway; everything else is for the owner only.
  if (sub.status !== "approved" && !(await isAdmin(request, env))) return text("Not found", 404);
  const { value, metadata } = await env.SUBMISSIONS.getWithMetadata(`photo:${pid}`, "arrayBuffer");
  if (!value) return text("Not found", 404);
  return new Response(value, {
    headers: { "content-type": metadata?.type || "image/jpeg", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------- admin

function loginPage(message = "") {
  return page("Recipe Submissions", `
<header><h1>Recipe submissions</h1><p class="sub">Sign in to review recipes people have sent.</p></header>
<form class="card" method="post" action="/admin">
  <div><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus></div>
  <div class="actions"><button class="primary" type="submit">Sign in</button></div>
  ${message ? `<div class="status err">${esc(message)}</div>` : ""}
</form>`);
}

async function login(request, env) {
  if (!(await underLimit(env, "login", request, LOGINS_PER_HOUR))) {
    return html(loginPage("Too many tries. Wait an hour and try again."), 429);
  }
  const form = await request.formData();
  const given = await sha256(String(form.get("password") || "") + "|recipe-box-admin");
  if (given !== (await adminToken(env))) return html(loginPage("That password isn't right."), 401);
  return redirect("/admin", {
    "set-cookie": `rb_admin=${given}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`,
  });
}

function logout() {
  return redirect("/admin", { "set-cookie": "rb_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
}

async function adminPage(request, env, url) {
  if (!(await isAdmin(request, env))) return html(loginPage());
  const tab = ["pending", "approved", "added"].includes(url.searchParams.get("tab")) ? url.searchParams.get("tab") : "pending";
  const imported = await importedIds();
  const all = await allSubs(env);
  await cleanUpImported(env, imported, all); // photos already on the site don't need to be stored here
  const subs = all.map((s) => ({ ...s, shown: imported.has(s.id) ? "added" : s.status }));
  const count = (t) => subs.filter((s) => s.shown === t).length;
  const shown = subs.filter((s) => s.shown === tab);
  const labels = { pending: "To review", approved: "Approved", added: "On the site" };
  const pill = { pending: "Waiting for you", approved: "Approved", added: "On the site" };
  const withCover = shown.some((s) => kindOf(s) === "photos")
    ? new Set((await siteRecipes()).filter((r) => r.hasCover).map((r) => r.title)) : new Set();

  const cards = shown.map((s) => {
    const isPhotos = kindOf(s) === "photos";
    const dish = dishOf(s);
    const editable = s.shown === "pending" && !s.cleaned;
    const title = isPhotos ? `Photos for ${prettyTitle(s.target)}` : (s.recipe || "Untitled recipe");
    const dishHtml = !dish.length || s.cleaned ? "" : `
  <div><h3 class="section-label">${isPhotos ? "Photos" : "Dish photos"}</h3>
  ${editable ? `<p class="hint" style="margin:2px 0 0">Untick any photo you don't want. Pick the cover, and fix a name if needed.</p>` : ""}</div>
  <div class="dish">${dish.map((d, i) => `
    <div class="ph">
      <a href="/photo/${d.pid}" target="_blank" rel="noopener"><img src="/photo/${d.pid}" alt="Dish photo ${i + 1}" loading="lazy"></a>
      ${d.cover ? `<span class="star">Cover</span>` : ""}
      <div class="pb">${editable ? `
        <label class="opt"><input type="checkbox" name="keep" value="${d.pid}" form="ap-${s.id}" checked> Use this photo</label>
        <label class="opt"><input type="radio" name="cover" value="${d.pid}" form="ap-${s.id}"${d.cover ? " checked" : ""}> Cover photo</label>
        <input type="text" name="by:${d.pid}" value="${esc(d.by)}" maxlength="80" placeholder="Photo by" aria-label="Photo ${i + 1} by" form="ap-${s.id}">`
        : `<span class="meta">${d.by ? `📷 ${esc(d.by)}` : "No name given"}${d.cover ? " · cover" : ""}</span>`}
      </div>
    </div>`).join("")}
  </div>
  ${editable ? `<label class="nocover"><input type="radio" name="cover" value="" form="ap-${s.id}"${dish.some((d) => d.cover) ? "" : " checked"}> ${isPhotos && withCover.has(s.target) ? "Gallery only (keep the current cover)" : "No cover photo from this submission"}</label>` : ""}
  ${editable && isPhotos && withCover.has(s.target) ? `<p class="hint" style="margin:0">This recipe already has a cover. Picking a cover here replaces it when approved (the old cover stays in the gallery).</p>` : ""}`;

    return `
<article class="card">
  <div class="head"><h2>${esc(title)}</h2><span class="pill">${isPhotos ? "Photos · " : ""}${pill[s.shown]}</span></div>
  <div class="meta">Sent ${esc(new Date(s.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}${s.name ? ` by ${esc(s.name)}` : ""}${s.category ? ` · ${esc(s.category)}` : ""}</div>
  ${s.photos.length && !s.cleaned ? `<div><h3 class="section-label">Recipe photos</h3></div>
  <div class="thumbs">${s.photos.map((p) => `<a href="/photo/${p}" target="_blank" rel="noopener"><img src="/photo/${p}" alt="Recipe photo" loading="lazy"></a>`).join("")}</div>` : ""}
  ${dishHtml}
  ${s.cleaned ? `<p class="meta">The photos are on the site now, so they've been cleared from storage here.</p>` : ""}
  ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ""}
  <div class="actions">
    ${s.shown === "pending" ? `<form method="post" action="/admin/action" id="ap-${s.id}"><input type="hidden" name="id" value="${esc(s.id)}"><input type="hidden" name="action" value="approve"><button type="submit" class="primary">Approve</button></form>` : ""}
    ${s.shown === "approved" ? actionButton(s.id, "unapprove", "Move back to review", "") : ""}
    <details><summary>Delete…</summary>
      <p class="meta">This removes the submission and its photos for good.${s.shown === "added" ? " Anything already on the site stays there." : ""}</p>
      ${actionButton(s.id, "delete", "Delete for good", "danger")}
    </details>
  </div>
</article>`;
  }).join("");

  const empty = {
    pending: "Nothing to review right now. New submissions will show up here.",
    approved: "Nothing approved is waiting. When there is, ask Claude Code to add the approved submissions to Recipe Box.",
    added: "Recipes and photos that have been added to the site show up here.",
  }[tab];

  return html(page("Recipe Submissions", `
<header class="head">
  <div><h1>Recipe submissions</h1>
  <p class="sub">Public forms: <a href="/">new recipe</a> · <a href="/photos">add photos</a> · <a href="/admin/logout">Sign out</a></p></div>
</header>
<nav class="tabs" aria-label="Show">
  ${Object.entries(labels).map(([t, l]) => `<a href="/admin?tab=${t}"${t === tab ? ' aria-current="page"' : ""}>${l} (${count(t)})</a>`).join("")}
</nav>
${cards || `<div class="empty">${empty}</div>`}
${tab === "approved" && shown.length ? `<p class="meta">To put these on the site, ask Claude Code: "add the approved submissions to Recipe Box". Once they're on the site, their photos are cleared from storage here automatically.</p>` : ""}`), 200, { "cache-control": "no-store" });
}

function actionButton(id, action, label, cls) {
  return `<form method="post" action="/admin/action"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="${action}"><button type="submit" class="${cls}">${label}</button></form>`;
}

async function deleteSub(env, sub) {
  for (const p of [...sub.photos, ...dishOf(sub).map((d) => d.pid)]) await env.SUBMISSIONS.delete(`photo:${p}`);
  await env.SUBMISSIONS.delete(`sub:${sub.id}`);
}

async function adminAction(request, env) {
  if (!(await isAdmin(request, env))) return redirect("/admin");
  const form = await request.formData();
  const sub = await getSub(env, String(form.get("id") || ""));
  if (!sub) return redirect("/admin");
  const action = form.get("action");
  if (action === "approve") {
    // Drop dish photos the reviewer unticked, and apply their cover pick and name fixes.
    const keep = new Set(form.getAll("keep").map(String));
    const cover = String(form.get("cover") || "");
    const kept = [];
    for (const d of dishOf(sub)) {
      if (!keep.has(d.pid)) { await env.SUBMISSIONS.delete(`photo:${d.pid}`); continue; }
      const by = form.get(`by:${d.pid}`);
      kept.push({ ...d, by: by === null ? d.by : String(by).trim().slice(0, 80), cover: d.pid === cover });
    }
    if (kindOf(sub) === "photos" && !kept.length) { await deleteSub(env, sub); return redirect("/admin?tab=pending"); }
    sub.dish = kept;
    sub.status = "approved";
    sub.approvedAt = new Date().toISOString();
    await putSub(env, sub);
    return redirect("/admin?tab=pending");
  }
  if (action === "unapprove") { sub.status = "pending"; await putSub(env, sub); return redirect("/admin?tab=approved"); }
  if (action === "delete") { await deleteSub(env, sub); return redirect("/admin"); }
  return redirect("/admin");
}

// ---------------------------------------------------------------- approved list (read-only)

async function approvedApi(env, url) {
  const subs = (await allSubs(env)).filter((s) => s.status === "approved" && !s.cleaned);
  return json(subs.map((s) => ({
    id: s.id,
    kind: kindOf(s),          // "recipe" (a new recipe) or "photos" (photos for a recipe on the site)
    target: s.target || "",   // for "photos": the recipe's exact title line in data/recipes.txt
    createdAt: s.createdAt,
    recipe: s.recipe,
    name: s.name,
    category: s.category,
    notes: s.notes,
    photos: s.photos.map((p) => `${url.origin}/photo/${p}`),
    dish: dishOf(s).map((d) => ({ url: `${url.origin}/photo/${d.pid}`, by: d.by, cover: d.cover })),
  })));
}
