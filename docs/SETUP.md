# Hosting Starkheben 5×5 with Google sign-in

The setup uses three free services:

- **GitHub Pages** serves the web page: `https://mathiashuber.github.io/Starkheben5mal5/`
- **Supabase** stores the data and handles sign-in.
- **Google Cloud** provides the "Continue with Google" login.

It takes about 20 minutes. Do the steps in order, because some steps need values from earlier ones.

## 1. Turn on GitHub Pages

1. Open the repository on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment**: Source **Deploy from a branch**, branch **`claude/rea-agent-setup-4wjmkd`**, folder **`/ (root)`** → **Save**.
3. After a minute the page shows "Your site is live at https://mathiashuber.github.io/Starkheben5mal5/".

The app already works there without accounts, storing data on each device only.

## 2. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) (GitHub login works) → **New project**.
2. Name `starkheben`, choose a database password (you won't need it in the app), region **Central EU (Frankfurt)** → **Create**.
3. When it's ready, open **Project Settings → API Keys** (or the **Connect** button) and note:
   - **Project URL**: `https://<something>.supabase.co`
   - **Publishable key** (`sb_publishable_…`), or the legacy **anon public** key. Either works.
4. Open **Authentication → Sign In / Providers → Google** and copy the **Callback URL (for OAuth)**:
   `https://<something>.supabase.co/auth/v1/callback`. Leave this page open for step 5.

## 3. Create the tables

1. In Supabase, open **SQL Editor → New query**.
2. Paste the contents of [`supabase/schema.sql`](../supabase/schema.sql).
3. In the `insert into public.members` lines, replace the two example addresses with **your Gmail address and your partner's**.
4. Press **Run**. It should say "Success. No rows returned".

Only the addresses on that list can see or save anything. To add someone later, run:
`insert into public.members (email) values ('their.address@gmail.com');`

## 4. Create the Google login

1. Open [console.cloud.google.com](https://console.cloud.google.com) and sign in with your Google account → create a project (e.g. `starkheben`).
2. Go to **APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform**) → **Get started**:
   - App name `Starkheben 5×5`, support email: your address.
   - Audience: **External**.
   - Contact email: your address → agree → **Create**.
3. **Audience** → **Test users** → **Add users**: add your Gmail and your partner's. While the app is in "Testing", only these accounts can sign in, which suits two people.
4. **Clients** (or **Credentials → Create credentials → OAuth client ID**):
   - Application type **Web application**, name `Starkheben web`.
   - **Authorized JavaScript origins**: `https://mathiashuber.github.io`
   - **Authorized redirect URIs**: the Supabase callback URL from step 2.4.
   - **Create**, then copy the **Client ID** and **Client secret**.

## 5. Connect Google to Supabase

1. Back in Supabase, **Authentication → Sign In / Providers → Google**: switch it **on**, paste the **Client ID** and **Client Secret** → **Save**.
2. **Authentication → URL Configuration**:
   - **Site URL**: `https://mathiashuber.github.io/Starkheben5mal5/`
   - **Redirect URLs** → **Add URL**: `https://mathiashuber.github.io/Starkheben5mal5/` → **Save**.

## 6. Point the app at Supabase

Put the Project URL and the publishable key into [`src/config.js`](../src/config.js), then commit and push. GitHub Pages redeploys within a minute. Both values are meant to be public; the rules from step 3 decide who can read and write.

Then open the page, tap **Continue with Google**, and send your partner the link.

## Good to know

- **Free-tier pause.** Supabase pauses a free project after about a week without any use. Training a few times a week keeps it awake. If it does pause, open the Supabase dashboard and click **Restore**. No data is lost.
- **Existing data.** Workouts saved on a device before signing in are added to your account the first time you sign in on that device.
- **The Android APK** stays offline-only, because Google doesn't allow its sign-in inside embedded app web views. Use the web page in your phone's browser, and add it to your home screen for an app-like icon.
