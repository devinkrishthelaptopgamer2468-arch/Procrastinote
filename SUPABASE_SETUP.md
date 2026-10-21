# Setting up online accounts and chat (Supabase)

Right now, everything (your account, homework, timetable, notes, friend messages) saves only in
*one* browser. This guide connects Procrastinote to **Supabase**, a free online database, so:

- **Your account works on every device.** Log in on your phone or another computer and your
  planner is there.
- **Friend messages travel between people**, live.

**Why Supabase?** It gives you real accounts (sign up / log in), a database, live updates and
"who's online", all free, with no server for you to run. Its security rules are plain SQL
you can read (they're in [`supabase/setup.sql`](supabase/setup.sql)).

**Saved to your account:** homework, timetable, uniforms, day order setup, holidays, home study
plan, half-days, notes (text and picture links), friends list and theme. Changes save
automatically a moment after you make them, and other devices pick them up when you open the app.

**Stays on each device:** your Groq AI key (it's locked to the browser where you saved it, so enter
it again on a new device), pictures uploaded into notes (too big for the free plan), and AI Buddy
chats.

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
- `planner_data`: each account's planner (one row per account).
- **Security rules (Row Level Security):** only you can read or change your own planner. You can
  only read messages in chats that include your own email, and you can only send messages as
  yourself. Nobody can edit or delete messages.
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

"Forgot password?" emails use the same **Site URL** and **Redirect URLs**: the link in the email
opens your site, which then asks for a new password. Nothing else needs turning on.

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

The code is on the branch **`feature/supabase-chat`**. The Friends page shows "Coming Soon" until
`supabase-config.js` is filled in, then switches to the real chat by itself.

1. Commit `supabase-config.js` on `feature/supabase-chat`. Before you commit, check it has **only**
   your project URL and the `sb_publishable_` key. No `sb_secret_`, no database password.
2. Push the branch. Vercel builds a **Preview** link for it. Test chat there with your two accounts.
3. When it works, merge it into `main` with a pull request as usual.

## 7. Turn on sharing notes with friends

Sharing notes needs one more table. You only do this once:

1. In Supabase, open **SQL Editor** → **New query**.
2. Open `supabase/add-note-sharing.sql` from this project, copy **all** of it, paste it in, and press **Run**.
   You should see "Success. No rows returned".
3. Check **Table Editor**: there is now a `shared_notes` table.

Until this is done, pressing **Send** on a note says "Sharing isn't switched on yet".

## 8. Turn on sending photos and documents in chat

Also once only:

1. In Supabase, open **SQL Editor** → **New query**.
2. Open `supabase/add-file-sharing.sql`, copy **all** of it, paste it in, and press **Run**.
   If Supabase warns about "destructive operations", that's only the lines that recreate this
   feature's own rules. Press **Run** anyway; no data is deleted.
3. Check **Storage**: there is now a private bucket called `shared-files`. **Table Editor** has a
   new `shared_files` table.

Files can be up to 10 MB each. The free plan has 1 GB of storage in total.

## 9. Turn on Classes

The **Classes** page (class chats, class timetable and homework, files, activity groups) needs its
own tables, security rules and a private file bucket. You only do this once:

1. In Supabase, open **SQL Editor** → **New query**.
2. Open `supabase/add-classes.sql` from this project, copy **all** of it, paste it in, and press
   **Run**. If Supabase warns about "destructive operations", that's only the lines that recreate
   Classes' own rules. Press **Run** anyway; no data is deleted. You should see
   "Success. No rows returned".
3. Check **Table Editor**: there are now tables such as `classes`, `class_members` and
   `group_messages`. **Storage** has a private bucket called `class-files`.

Until this is done, the Classes page says "Classes aren't switched on yet".

**Only you create classes.** The account `devinthegamer2468@gmail.com` is the site owner, and it's
the only account with a **+ Create a class** button (the database refuses everyone else). A new
class is ready straight away: give its code to the class admin, and once they've joined, open
**People** and press **Hand over** next to their name. That happens straight away too, and you
become a co-admin (you can then leave the class).

The site owner also sees **Approvals** on the Classes page: when a class owner asks to make
someone a co-admin or hand the class to someone else, it waits there for you, and reported
messages show up there with a **Delete message** button. You can also delete any class
or activity group from there. To make a different account the site owner, change the email in
**both** `is_site_owner()` near the top of `supabase/add-classes.sql` (then run the file again)
and `SITE_OWNER_EMAIL` near the top of `classes.js`.

**Limits** (all checked by the database, in `add-classes.sql`):

| What | Limit |
|---|---|
| Creating classes | Site owner only |
| Wrong join codes | 10 per hour per account |
| Invite-only chats | 15 per class, 1 per person (the General chat doesn't count) |
| Activity groups | Small = up to 5 people (1 point), Big = up to 20 (2 points); 6 points per person |
| Files | 10 MB each, 100 MB per class or activity group |

The free plan has 1 GB of storage for the whole site, shared with photos sent in chat.

**Pings:** in class chats, `@Name` pings someone (up to 20 people per message) and
`@Procrasti-Bot` gets a reply from the AI helper. The reply is written with the AI key of the
person who pinged the bot (only their message is sent to the AI), or is one of the bot's
built-in tips if they haven't added a key.

**Updating:** whenever `add-classes.sql` changes, run the whole file again in the SQL Editor.
It keeps all existing classes, messages and files.

**Test it** with two browsers, like step 5: create a class with the site-owner account, then
join it with the code in the other browser. Send a message in General, post
homework (it lands in the other account's Homework list once they tick **Follow class homework**),
and share a timetable.

## 9. Phone notifications when Procrastinote is closed

Without this step, notifications already work while Procrastinote is open in the background
(another tab or app). This step adds notifications when it's fully closed, and the daily
homework reminder.

1. Run `supabase/add-push-notifications.sql` in **SQL Editor** (same as the other scripts).
2. The rest (a push key pair, the `send-push` Edge Function and the triggers that call it) comes
   in the next part of the setup.

## If something goes wrong

- **"No Procrastinote account uses that email yet"**: your friend hasn't signed up (and
  confirmed their email) yet.
- **Nothing happens online / chat still local-only**: `supabase-config.js` is empty, or the
  page is an old cached version. Hard-refresh with **Ctrl+Shift+R**.
- **"Message not sent: ... row-level security"**: you're not logged in properly. Log out and back in.
- **Error mentioning `get_profiles` or `messages` "does not exist"**: step 2 wasn't run. Run
  `setup.sql` again (running it twice is fine).
- Open the browser console (**F12 → Console**) to see more detailed errors.
