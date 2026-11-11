# VendorFlow

Vendor onboarding and multi-step invoice approvals, driven from Claude over MCP.
No AI inside the app: no AI keys, no AI calls. Claude does the thinking, the app stores, notifies and audits.

## Run locally
```
npm install
MCP_TOKEN=secret123 ADMIN_PASS=pick-one npm start
```

## Environment variables
| Name | Purpose |
|---|---|
| BASE_URL | Public URL of the app, used in emails and links |
| MCP_TOKEN | Secret in the MCP URL |
| ADMIN_USER / ADMIN_PASS | Login for the web app |
| RESEND_API_KEY, MAIL_FROM | Optional, enables real emails (without it emails are logged) |
| DB_PATH | SQLite file path. Point it at a persistent disk or volume on your host |
| PORT | Set by most hosts |

## Deploy (Render or Railway)
1. Push this folder to GitHub, create a Node web service, start command `npm start`.
2. Add a persistent disk/volume and set `DB_PATH` to a file on it.
3. Set the env vars above. `BASE_URL` is your service URL.

## Connect to Claude
1. Claude → Settings → Connectors → Add custom connector.
2. Paste `https://YOUR-APP/mcp/YOUR_MCP_TOKEN`.
3. Start a chat and try: "Register ABC Technologies as a vendor (GST 24ABCDE1234F1Z5) and create an invoice approval request for ₹80,000, invoice INV-101. Approvers in order: Priya (manager, priya@example.com), then Rahul (finance head, rahul@example.com)."

## Test login for reviewers
Web app: `ADMIN_USER` / `ADMIN_PASS` (share the values you set).
