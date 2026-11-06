# Connect Sam's YouTube — Google Cloud steps (do these in Firefox)

Sign in to Google with the account that **owns the Sam's YouTube channel**.
About 10 minutes. Nothing here posts anything.

## 1. Create a project just for Sam's
Open https://console.cloud.google.com/projectcreate
- Project name: **Sams Social Studio** → **Create**
- When it's done, check the project picker at the top of the page says **Sams Social Studio**
  (not "Sindbad" — keep the two businesses apart).

## 2. Turn on the YouTube API
Open https://console.cloud.google.com/apis/library/youtube.googleapis.com
- Top picker still says **Sams Social Studio** → press **Enable**

## 3. Consent screen (what you'll see when connecting)
Open https://console.cloud.google.com/auth/overview → **Get started**
- App name: **Sams Social Studio**
- User support email: your Gmail
- Audience: **External**
- Contact email: your Gmail → tick the agreement → **Create**

## 4. Allow your own account in
Left menu **Audience** → **Test users** → **+ Add users**
- Add the Google account that owns the Sam's channel → **Save**

## 5. Permissions
Left menu **Data Access** → **Add or remove scopes**
- Tick **`.../auth/youtube.upload`** and **`.../auth/youtube.readonly`**
  (type "youtube" in the filter box to find them) → **Update** → **Save**

## 6. The login client
Left menu **Clients** → **+ Create client**
- Application type: **Web application**
- Name: **Sams Social Studio Web**
- Authorized redirect URIs → **+ Add URI** →
  `https://api.sams-social-system.sams.ge/auth/youtube/callback`
- **Create**

## 7. Keep the two keys handy — but DON'T paste them in chat
A box shows **Client ID** and **Client secret**. Press **Download JSON**
(the secret is shown only once). You'll paste both into our own private
setup form, which I'm building now.

---

### Two honest caveats (Google's rules, not ours)
- **Uploads stay "Private" at first.** Google locks videos uploaded through a new,
  unaudited API project to Private until the project passes YouTube's API audit
  (same idea as TikTok's review). We request that audit after the first test works.
- **Testing mode logs you out every 7 days.** Once the test works we switch the
  consent screen to **In production** — you'll then see a "Google hasn't verified
  this app" warning when connecting; for your own account that's expected: press
  **Advanced → Go to Sams Social Studio**.
