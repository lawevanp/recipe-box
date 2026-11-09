// Recipe Box submissions - a Cloudflare Worker.
//
//   /               public page where anyone can send in recipe photos
//   /admin          password-protected page where the owner approves or deletes them
//   /api/approved   read-only JSON list of approved submissions (used when adding them to the site)
//
// Setup (see SETUP.md): bind a KV namespace as SUBMISSIONS and add an ADMIN_PASSWORD secret.
// Optional spam check: TURNSTILE_SITE_KEY (variable) and TURNSTILE_SECRET_KEY (secret).

const SITE_URL = "https://lawevanp.github.io/recipe-box/";
const IMPORTED_URL = SITE_URL + "data/imported-submissions.txt";
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const SUBMITS_PER_HOUR = 5;
const LOGINS_PER_HOUR = 10;
const CATEGORIES = ["breakfast", "entree", "side", "soup", "bread", "dessert", "snack", "sauce"];
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (!env.SUBMISSIONS || !env.ADMIN_PASSWORD) {
        return text("This page isn't set up yet: the SUBMISSIONS storage or ADMIN_PASSWORD is missing.", 503);
      }
      if (path === "/" && request.method === "GET") return html(submitPage(env));
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
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

// ---------------------------------------------------------------- public submit page

function submitPage(env) {
  const siteKey = env.TURNSTILE_SITE_KEY || "";
  return page("Share a Recipe", `
<header>
  <h1>Share a recipe</h1>
  <p class="sub">Send a photo of a recipe card, cookbook page or handwritten note. It'll be checked before it goes on <a href="${SITE_URL}">Recipe Box</a>.</p>
</header>
<form class="card" id="f" novalidate>
  <label class="drop" for="photos">
    <input id="photos" name="photos" type="file" accept="image/*" multiple>
    <strong>Tap to take or choose photos</strong>
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
  <div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
  ${siteKey ? `<div class="cf-turnstile" data-sitekey="${esc(siteKey)}"></div>` : ""}
  <div class="actions"><button class="primary" id="send" type="submit">Send recipe</button></div>
  <div class="status" id="status" role="status"></div>
</form>
${siteKey ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
<script>
const MAX=${MAX_PHOTOS}; let files=[];
const $=(id)=>document.getElementById(id);
$("photos").addEventListener("change",(e)=>{files=[...e.target.files].slice(0,MAX);
  $("thumbs").replaceChildren(...files.map((f)=>Object.assign(document.createElement("img"),{src:URL.createObjectURL(f),alt:""})));});
async function shrink(file){ // send a reasonably sized JPEG instead of a huge phone photo
  try{const bmp=await createImageBitmap(file);const s=Math.min(1,2000/Math.max(bmp.width,bmp.height));
    const c=document.createElement("canvas");c.width=Math.round(bmp.width*s);c.height=Math.round(bmp.height*s);
    c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
    return await new Promise((r)=>c.toBlob((b)=>r(b||file),"image/jpeg",0.85));}catch{return file;}}
$("f").addEventListener("submit",async(e)=>{e.preventDefault();const st=$("status"),btn=$("send");
  if(!files.length){st.className="status err";st.textContent="Add at least one photo.";return;}
  btn.disabled=true;st.className="status";st.textContent="Sending…";
  const fd=new FormData($("f"));fd.delete("photos");
  for(const [i,f] of files.entries()){fd.append("photos",await shrink(f),"photo-"+(i+1)+".jpg");}
  try{const r=await fetch("/submit",{method:"POST",body:fd});const msg=await r.text();
    if(r.ok){$("f").reset();files=[];$("thumbs").replaceChildren();st.className="status ok";st.textContent=msg;}
    else{st.className="status err";st.textContent=msg;}
  }catch{st.className="status err";st.textContent="Couldn't send. Check your connection and try again.";}
  finally{btn.disabled=false;if(window.turnstile)turnstile.reset();}});
</script>`);
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

  const photos = form.getAll("photos").filter((p) => typeof p === "object" && p.size > 0).slice(0, MAX_PHOTOS);
  if (!photos.length) return text("Add at least one photo.", 400);
  for (const p of photos) {
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
  const clip = (k, n) => String(form.get(k) || "").trim().slice(0, n);
  const category = clip("category", 20);
  await putSub(env, {
    id,
    createdAt: new Date().toISOString(),
    status: "pending",
    recipe: clip("recipe", 120),
    name: clip("name", 80),
    category: CATEGORIES.includes(category) ? category : "",
    notes: clip("notes", 2000),
    photos: photoIds,
  });
  return text("Thanks! Your recipe was sent and will be added once it's been checked.");
}

// ---------------------------------------------------------------- photos

async function photo(request, env, pid) {
  const m = pid.match(/^([0-9a-f-]{36})-(\d+)$/);
  if (!m) return text("Not found", 404);
  const sub = await getSub(env, m[1]);
  if (!sub || !sub.photos.includes(pid)) return text("Not found", 404);
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
  const subs = (await allSubs(env)).map((s) => ({ ...s, shown: imported.has(s.id) ? "added" : s.status }));
  const count = (t) => subs.filter((s) => s.shown === t).length;
  const shown = subs.filter((s) => s.shown === tab);
  const labels = { pending: "To review", approved: "Approved", added: "On the site" };
  const pill = { pending: "Waiting for you", approved: "Approved", added: "On the site" };

  const cards = shown.map((s) => `
<article class="card">
  <div class="head"><h2>${esc(s.recipe || "Untitled recipe")}</h2><span class="pill">${pill[s.shown]}</span></div>
  <div class="meta">Sent ${esc(new Date(s.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}${s.name ? ` by ${esc(s.name)}` : ""}${s.category ? ` · ${esc(s.category)}` : ""}</div>
  <div class="thumbs">${s.photos.map((p) => `<a href="/photo/${p}" target="_blank" rel="noopener"><img src="/photo/${p}" alt="Recipe photo" loading="lazy"></a>`).join("")}</div>
  ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ""}
  <div class="actions">
    ${s.shown === "pending" ? actionButton(s.id, "approve", "Approve", "primary") : ""}
    ${s.shown === "approved" ? actionButton(s.id, "unapprove", "Move back to review", "") : ""}
    <details><summary>Delete…</summary>
      <p class="meta">This removes the submission and its photos for good.${s.shown === "added" ? " The recipe stays on the site." : ""}</p>
      ${actionButton(s.id, "delete", "Delete for good", "danger")}
    </details>
  </div>
</article>`).join("");

  const empty = {
    pending: "Nothing to review right now. New submissions will show up here.",
    approved: "No approved recipes waiting. When there are, ask Claude Code to add the approved submissions to Recipe Box.",
    added: "Recipes that have been added to the site show up here.",
  }[tab];

  return html(page("Recipe Submissions", `
<header class="head">
  <div><h1>Recipe submissions</h1>
  <p class="sub">Public form: <a href="/">${esc(url.origin)}/</a> · <a href="/admin/logout">Sign out</a></p></div>
</header>
<nav class="tabs" aria-label="Show">
  ${Object.entries(labels).map(([t, l]) => `<a href="/admin?tab=${t}"${t === tab ? ' aria-current="page"' : ""}>${l} (${count(t)})</a>`).join("")}
</nav>
${cards || `<div class="empty">${empty}</div>`}
${tab === "approved" && shown.length ? `<p class="meta">To put these on the site, ask Claude Code: "add the approved submissions to Recipe Box".</p>` : ""}`), 200, { "cache-control": "no-store" });
}

function actionButton(id, action, label, cls) {
  return `<form method="post" action="/admin/action"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="${action}"><button type="submit" class="${cls}">${label}</button></form>`;
}

async function adminAction(request, env) {
  if (!(await isAdmin(request, env))) return redirect("/admin");
  const form = await request.formData();
  const sub = await getSub(env, String(form.get("id") || ""));
  if (!sub) return redirect("/admin");
  const action = form.get("action");
  if (action === "approve") { sub.status = "approved"; sub.approvedAt = new Date().toISOString(); await putSub(env, sub); return redirect("/admin?tab=pending"); }
  if (action === "unapprove") { sub.status = "pending"; await putSub(env, sub); return redirect("/admin?tab=approved"); }
  if (action === "delete") {
    for (const p of sub.photos) await env.SUBMISSIONS.delete(`photo:${p}`);
    await env.SUBMISSIONS.delete(`sub:${sub.id}`);
    return redirect("/admin");
  }
  return redirect("/admin");
}

// ---------------------------------------------------------------- approved list (read-only)

async function approvedApi(env, url) {
  const subs = (await allSubs(env)).filter((s) => s.status === "approved");
  return json(subs.map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    recipe: s.recipe,
    name: s.name,
    category: s.category,
    notes: s.notes,
    photos: s.photos.map((p) => `${url.origin}/photo/${p}`),
  })));
}
