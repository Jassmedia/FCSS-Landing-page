# ASTS FCCS: Google Sheet + Apps Script

One Google Apps Script Web App and one Google Sheet save every registration from
the FCCS landing page. The Sheet is the only source of truth.

```
Visitor ──► FCCS landing page (index.html) ──POST──► Apps Script Web App ──► Google Sheet
                                                      (Code.gs)                (private)
```

| File | What it is |
| --- | --- |
| `apps-script/Code.gs` | The complete Apps Script. Paste it into the Sheet's Apps Script editor. |
| `index.html`, line 16 | The landing page: `ASTS_CONFIG.APPS_SCRIPT_URL` |

---

## 1. Google Sheet structure

One tab, `Leads`, with one row per saved registration. `setup()` creates it with these exact headers.

| Column | Contents |
| --- | --- |
| Lead ID | e.g. `FCCS-20261010-7F3A1C` (date in the Sheet's time zone) |
| Submitted At | When the Apps Script saved it (the visitor's device clock is not trusted) |
| Name, Email | From the form |
| Phone | Country code + number, digits only (e.g. `919876543210`) |
| Country, Country Code | From the phone country picker (e.g. `India`, `IN`) |
| Role | The "Select Your Current Role" answer |
| Availability | The "Are you available for the demo?" answer |
| Course | `FCCS` (`ASTS_CONFIG.COURSE` in `index.html`) |
| Consent | `Yes` (the form cannot be sent without it) |
| UTM Source, UTM Medium, UTM Campaign, UTM Term, GCLID | Google Ads attribution saved with the registration |
| Page URL | The page the form was sent from |
| Source | `website` |

Notes:
- Do not rename the tab or the header names. Reordering columns is fine.
- All text is stored as plain text, so a value like `=IMPORTXML(...)` can never run as a formula.
- Keep the Sheet **private**. Do not share it or "publish to web". The web app writes to it on your behalf.

---

## 2. Deploy the Apps Script

1. **Create the Google Sheet.** Go to https://sheets.new and name it, for example,
   `ASTS FCCS Registrations`. Then set its time zone: **File → Settings → Time zone →
   (GMT+05:30) India Standard Time → Save settings**.
2. **Open Extensions → Apps Script.**
3. **Paste the code.** Delete everything in `Code.gs` (the sample `function myFunction() {}`),
   then paste the **entire** contents of `apps-script/Code.gs` from this project.
   Optionally rename the project (top left) to `ASTS FCCS`.
4. **Save** (Ctrl+S / ⌘S).
5. **Authorize** by running the setup: in the toolbar, choose **`setup`** in the function list,
   then click **Run**. Google asks for permission:
   **Review permissions → choose your account → "Google hasn't verified this app" → Advanced →
   Go to ASTS FCCS (unsafe) → Allow.** (It is your own script; it only gets access to this one
   spreadsheet because of the `@OnlyCurrentDoc` line.)
6. **Check the setup.** The execution log shows `Setup complete…`. The Sheet now has the `Leads`
   tab with bold, frozen headers. (The empty `Sheet1` can be deleted.)
7. **Deploy → New deployment.** Click the gear next to "Select type" and choose **Web app**.
8. Fill in: Description `ASTS FCCS v1` · **Execute as: Me** · **Who has access: Anyone**.
9. Click **Deploy**. If Google asks to authorize again, repeat the steps from step 5.
10. **Copy the Web app URL.** It looks like `https://script.google.com/macros/s/…/exec`.
    Use the one that ends in **`/exec`**, not the `/dev` test URL.
11. **Check that it answers:** open the `/exec` URL in your browser. You should see
    `{"ok":true,"service":"ASTS FCCS registrations","status":"ok",…}`. It contains no data.

### Changing the script later (keeps the same URL)

After editing the code in Apps Script: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**
Don't use "New deployment" again, because that creates a different URL.

---

## 3. Connect the landing page

File **`index.html`**, **line 16**, inside `window.ASTS_CONFIG`:

```js
    APPS_SCRIPT_URL: 'PASTE_YOUR_WEB_APP_URL_HERE',
```

Replace only the text between the quotes with your real `/exec` URL, keeping the quotes and the comma.
Then publish the site. Until the real URL is there, the form says "The form is not connected yet".

## 4. Test it

1. Open the landing page, fill in the form with your own details and submit.
2. The page shows **Thanks, …! You're registered.** and a new row appears in `Leads`.
3. Delete the test row afterwards (row 2 and below only, never the header row).

Also worth trying once: open the page with ad tags, for example
`?utm_source=google&utm_medium=cpc&utm_campaign=test&gclid=TEST123`, then register. The row shows those values.

## 5. What the script accepts and answers

The page sends one POST with a JSON body (as plain text, so no CORS pre-check is needed):

```
name, email, phone, country, country_code, role, availability, course, consent,
gclid, utm_source, utm_medium, utm_campaign, utm_term, page_url, source, hp
```

| Answer | Meaning |
| --- | --- |
| `{"ok": true, "leadId": "FCCS-…"}` | Saved in the Sheet |
| `{"ok": true, "leadId": "FCCS-…", "duplicate": true}` | The same phone, email and course were saved in the last 10 minutes; no second row |
| `{"ok": false, "error": "…"}` | Not saved. The page shows an error and keeps what was typed |

The script checks the same rules as the form (name, email, phone, role, consent). `hp` is the hidden
spam field: anything in it means a bot, and nothing is saved.

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Form says "The form is not connected yet" | `index.html` line 16 still has the placeholder |
| Form says "We couldn't register you just now" | Check the `/exec` URL. Check the deployment has **Who has access: Anyone**. After code changes, deploy a **New version** |
| Code changes have no effect | Deploy → Manage deployments → Edit → **New version** |
| The role list on the page was changed | Make the same change to `ROLES` at the top of `Code.gs`, then deploy a **New version** |
