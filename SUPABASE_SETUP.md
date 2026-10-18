# Setting up online chat (Supabase)

Right now, friend messages only save in *your* browser, so your friends never get them.
This guide connects Procrastinote to **Supabase**, a free online database, so messages
travel between different people on different devices, live.

**Why Supabase?** It gives you real accounts (sign up / log in), a database, live updates and
"who's online", all free, with no server for you to run. Its security rules are plain SQL
you can read (they're in [`supabase/setup.sql`](supabase/setup.sql)).

What stays the same: your homework, timetable, notes, etc. still save in your browser like
before. AI Buddy chats also stay in your browser. Only **accounts** and **friend messages**
go online.

Takes about 15 minutes.

---

## 1. Create your Supabase project

1. Go to <https://supabase.com> and click **Start your project**. Sign in with GitHub
   (use the same GitHub account as the Procrastinote repo).
2. Click **New project**.
   - **Name:** `procrastinote`
   - **Database password:** click *Generate a password* and save it somewhere safe
     (a password manager). You won't need it for the app, and **never put it in the code**.
   - **Region:** pick the one closest to you (e.g. *Mumbai* if you're in India).
   - Plan: **Free**.
3. Click **Create new project** and wait a minute or two until it's ready.

## 2. Create the database tables and security rules

1. In the left sidebar, open **SQL Editor**, then click **New query**.
2. Open [`supabase/setup.sql`](supabase/setup.sql) from this repo, copy **everything** in it,
   and paste it into the editor.
3. Click **Run**. You should see *"Success. No rows returned"*.

That created:
- `profiles`: your name and class, so friends see who they're talking to.
- `messages`: the chat messages.
- **Security rules (Row Level Security):** you can only read messages in chats that include
  your own email, and you can only send messages as yourself. Nobody can edit or delete messages.
- Live updates for new messages.

## 3. Set up sign-in

1. Sidebar: **Authentication → Sign In / Providers** (on some dashboards: *Providers*).
   Make sure **Email** is turned on.
2. Leave **Confirm email** turned **ON**. This makes people click a link in their inbox
   before they can log in. It matters for chat: without it, someone could sign up using your
   friend's email address (before your friend does) and read the messages meant for them.
3. Sidebar: **Authentication → URL Configuration**.
   - **Site URL:** your Vercel address, e.g. `https://procrastinote.vercel.app`
   - **Redirect URLs:** click *Add URL* and add your Vercel address again, plus
     `https://*.vercel.app` if you want preview deployments to work.

> Heads-up: Supabase's free built-in email only sends a few emails per hour. If a
> confirmation email doesn't arrive while testing, wait an hour and try again (check spam too).

## 4. Put your project's address and public key in the app

1. Sidebar: **Project Settings** (gear icon) → **API Keys**.
2. Copy the **Publishable key** (it starts with `sb_publishable_`). If you only see a
   "Legacy API keys" tab, copy the key labelled **anon / public** instead.
3. Find your **Project URL**: **Project Settings → Data API** (or the **Connect** button at the
   top of the dashboard). It looks like `https://abcdefghijklmnop.supabase.co`.
4. Open [`supabase-config.js`](supabase-config.js) in your code editor and paste them in:

   ```js
   window.PROCRASTINOTE_SUPABASE = {
       url: 'https://abcdefghijklmnop.supabase.co',
       publishableKey: 'sb_publishable_xxxxxxxxxxxx'
   };
   ```

5. Save the file.

Do this yourself in your editor. **Don't paste keys into chats** (including with Claude).

### Wait, isn't putting a key in the code dangerous?

Not this one. Supabase gives you two kinds of keys:

| Key | Starts with | Safe in the website code? |
|---|---|---|
| **Publishable** (old name: *anon public*) | `sb_publishable_` | ✅ Yes. It's *designed* to be public |
| **Secret** (old name: *service_role*) | `sb_secret_` | ❌ **Never.** It skips every security rule |

The publishable key is like your school's street address: anyone can know it, but that
doesn't get them inside. What people can actually *do* is decided by the security rules from
step 2, which check who is logged in. Any website that uses Supabase has its publishable key
visible in the browser, and that's normal.

The secret key is like the master key to the building. Never put it in this project, never
commit it to GitHub. (The app checks for this: if you paste a secret key by mistake, online
chat turns off and a warning appears in the browser console.)

## 5. Test it

You need two different accounts in two different browsers (for example Chrome and Edge, or a
normal window and a private/incognito window). Use two emails you can open, because each one
needs its confirmation link clicked.

1. Open the app in browser 1 and **sign up** (name, class, email, password of 6+ characters).
   Click the confirmation link in the email, then **log in**.
2. Do the same in browser 2 with your second email.
3. In browser 1: **Friends → Friends tab** → type the second email → **Add**.
4. Click the friend and send a message. It should appear in browser 2 within a second or two,
   with no refreshing, and the friend should show a green "Online" dot.
5. Reply from browser 2.

**Already had an account before this update?** Just log in with your old email and password.
The app moves your account online automatically and keeps all your planner data.
(Someone who was already logged in gets asked to log in once more.)

## 6. Push and redeploy on Vercel

The code is on a branch called **`feature/supabase-chat`**.

1. Open **GitHub Desktop**. Make sure *Current branch* says `feature/supabase-chat`.
2. In the list of changed files, tick these:
   `index.html`, `school-app.js`, `supabase-config.js`, `supabase/setup.sql`, `SUPABASE_SETUP.md`.
   **Untick** anything inside `.claude/`. That's a local testing file and doesn't belong online.
3. Before you commit, click `supabase-config.js` and check it has **only** your project URL and
   the `sb_publishable_` key. No `sb_secret_`, no database password.
4. Write a summary like *"Online friends chat with Supabase"* and click **Commit to feature/supabase-chat**.
5. Click **Publish branch** (or **Push origin**).
6. Vercel automatically builds a **Preview** for the branch. Find its link in your Vercel
   dashboard (or on the GitHub branch page) and test chat there with your two accounts.
7. When it works, in GitHub Desktop click **Create Pull Request**, then on GitHub click
   **Merge pull request**. Vercel redeploys your main site automatically in about a minute.

## If something goes wrong

- **"No Procrastinote account uses that email yet"**: your friend hasn't signed up (and
  confirmed their email) yet.
- **Nothing happens online / chat still local-only**: `supabase-config.js` is empty, or the
  page is an old cached version. Hard-refresh with **Ctrl+Shift+R**.
- **"Message not sent: ... row-level security"**: you're not logged in properly. Log out and back in.
- **Error mentioning `get_profiles` or `messages` "does not exist"**: step 2 wasn't run. Run
  `setup.sql` again (running it twice is fine).
- Open the browser console (**F12 → Console**) to see more detailed errors.
