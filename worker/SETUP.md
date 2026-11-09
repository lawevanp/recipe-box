# Setting up recipe submissions (Cloudflare, free)

This puts a "Share a recipe" page online that anyone can use, plus a password-protected page
where you approve submissions. It takes about 15 minutes, all in the Cloudflare website.
Cloudflare's menus move around now and then, so if a name below doesn't match exactly, look for
the closest one.

## 1. Create a free Cloudflare account
Sign up at https://dash.cloudflare.com/sign-up. The free plan is all you need, and you don't need
a credit card or your own domain.

## 2. Make a storage area for submissions
1. In the left menu, open **Storage & databases → Workers KV**.
2. Click **Create** (or **Create instance**), name it `recipe-submissions`, and click **Create**.

## 3. Create the worker
1. In the left menu, open **Compute → Workers & Pages** and click **Create**.
2. Choose **Start with Hello World**, name it `recipe-box-submit`, and click **Deploy**.
3. Click **Edit code**. Delete everything in the editor, then paste in the whole of
   https://raw.githubusercontent.com/lawevanp/recipe-box/main/worker/worker.js
   (open that link, select all, and copy).
4. Click **Deploy**.

## 4. Connect the storage
1. Go back to the worker's page and open **Settings → Bindings** (or the **Bindings** tab).
2. Click **Add binding**, choose **KV namespace**, and set:
   - **Variable name:** `SUBMISSIONS`
   - **KV namespace:** `recipe-submissions`
3. Click **Add binding** / **Deploy**.

## 5. Set your review password
1. In the worker's **Settings → Variables and Secrets**, click **Add**.
2. Type: **Secret**. Name: `ADMIN_PASSWORD`. Value: a password you don't use anywhere else.
3. Click **Deploy**.

## 6. (Recommended) Turn on the spam check
1. In the left menu, open **Turnstile** (under **Application security** or **Protect & connect**) and click **Add widget**.
2. Name it `Recipe Box`, and add your worker's address as the hostname, for example
   `recipe-box-submit.yourname.workers.dev` (it's shown on the worker's page). Leave the widget mode on **Managed**.
3. Click **Create**. It shows a **Site key** and a **Secret key**.
4. In the worker's **Settings → Variables and Secrets**, add:
   - Type **Text**, name `TURNSTILE_SITE_KEY`, value: the site key
   - Type **Secret**, name `TURNSTILE_SECRET_KEY`, value: the secret key
5. Click **Deploy**.

## 7. Try it
- Public page: `https://recipe-box-submit.<yourname>.workers.dev/`. Send yourself a test recipe.
- Review page: the same address with `/admin` on the end. Sign in with your password.

Then send Claude Code the public page's address. It will point the site's **+ Add recipe** button
at it.

## Day to day
- People send recipes from the public page. They wait under **To review** on `/admin`.
- **Approve** the ones you want; **Delete** the rest.
- Ask Claude Code to "add the approved submissions to Recipe Box". It reads the approved photos,
  types them up, adds them to the site, and they move to **On the site**.

Free-plan limits are far above what a family recipe site needs: about 1,000 saves a day
(each submission uses a few) and 1 GB of storage (thousands of photos).
