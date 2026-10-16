# Hosting Starkheben 5×5

The setup uses two free services:

- **GitHub Pages** serves the web page: `https://mathiashuber.github.io/Starkheben5mal5/`
- **Supabase** stores everyone's data. Accounts are a username and a password, created in the app.

The Supabase project URL and key are already in [`src/config.js`](../src/config.js). Two steps are left:

## 1. Create the database tables

1. Open your project in Supabase → **SQL Editor** → **New query**.
2. Paste the whole of [`supabase/schema.sql`](../supabase/schema.sql) and press **Run**. It should say "Success. No rows returned".

Running it again later is safe. It also removes the tables from the earlier Google sign-in draft if you ran that script; they never held data.

## 2. Turn on GitHub Pages

1. Open the repository on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment**: Source **Deploy from a branch**, branch **`claude/rea-agent-setup-4wjmkd`**, folder **`/ (root)`** → **Save**.
3. After a minute it shows "Your site is live at https://mathiashuber.github.io/Starkheben5mal5/".

Open the page, tap **New here? Create an account**, and send your partner the link so they can create theirs.

## How accounts work

- **Passwords** are stored as bcrypt hashes. Signing in gives the device a random token, which stays valid until you sign out.
- **The app reaches the database only through the `crew_*` functions** in the schema. Everyone signed in can read everyone's data, but only change their own.
- **Security is deliberately minimal.** There's no password reset, no rate limiting and no email. Use a password you don't use anywhere else.
- **At most 20 accounts** can be created. Change `>= 20` in `crew_register` to allow more.
- **Admin tasks** are done in Supabase → **Table Editor**:
  - **Delete an account** in `crew_accounts`; its data goes with it.
  - **Reset a forgotten password** by deleting the account; the person registers again under the same name and their old data is gone.

## Good to know

- **Free-tier pause.** Supabase pauses a free project after about a week without use. Training a few times a week keeps it awake. If it does pause, open the Supabase dashboard and click **Restore**. No data is lost.
- **Update speed.** Changes from other people or devices show up within about 15 seconds, and right away when you switch back to the app.
- **Existing data.** Workouts saved on a device before signing in are added to your account the first time you sign in there.
- **The Android APK** uses the same accounts and syncs too. Without a connection it keeps working and syncs later.
