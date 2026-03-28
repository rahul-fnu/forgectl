# Apple Shortcut for forgectl Dispatch

Submit tasks to forgectl directly from your iPhone or iPad using an Apple Shortcut.

Two approaches are documented:

1. **Direct to forgectl daemon** -- requires your daemon to be reachable from your phone (same network or tunnel)
2. **Direct to Linear API** -- simpler setup, no tunnel needed; forgectl picks up the issue via polling

---

## Approach 1: Direct to forgectl Daemon

### Prerequisites

- forgectl daemon running (`forgectl daemon start`)
- Daemon reachable from your phone (see [Exposing the Daemon](#exposing-the-daemon))
- Daemon token (see [Getting the Daemon Token](#getting-the-daemon-token))

### Getting the Daemon Token

The daemon writes a bearer token to `~/.forgectl/daemon.token` on startup. Retrieve it with:

```bash
cat ~/.forgectl/daemon.token
```

Copy this value -- you will paste it into the Shortcut.

### Exposing the Daemon

The daemon listens on port `4856` by default. Your phone must be able to reach it.

**Option A: Same local network**

If your phone and server are on the same Wi-Fi/LAN, use the server's local IP directly:

```
http://192.168.1.100:4856
```

**Option B: Cloudflare Tunnel (recommended for remote access)**

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Create a tunnel
cloudflared tunnel --url http://localhost:4856
```

This gives you a public `https://<random>.trycloudflare.com` URL. For a stable hostname, set up a named tunnel with `cloudflared tunnel create forgectl`.

### Building the Shortcut

Open the **Shortcuts** app on your iPhone and create a new shortcut with these actions:

1. **Ask for Input**
   - Prompt: `What do you want to build?`
   - Input Type: Text (multi-line)
   - Save output to variable: `TaskDescription`

2. **Ask for Input**
   - Prompt: `Which repo? (owner/name, or leave blank)`
   - Input Type: Text (single line)
   - Save output to variable: `Repo`

3. **Text**
   - Content (build the JSON body):
   ```
   {
     "title": "FIRST_LINE_OF_TaskDescription",
     "description": "FULL_TaskDescription",
     "repo": "Repo"
   }
   ```
   In practice, use the **Split Text** action to extract the first line of `TaskDescription` for the title, and use the full `TaskDescription` for the description. If `Repo` is empty, omit the `"repo"` field or leave it as `""`.

4. **Get Contents of URL**
   - URL: `https://YOUR-SERVER:4856/api/v1/dispatch`
   - Method: **POST**
   - Headers:
     - `Authorization`: `Bearer YOUR_DAEMON_TOKEN`
     - `Content-Type`: `application/json`
   - Request Body: **File** -- pass the Text from step 3

5. **Show Result**
   - Input: Contents of URL (the response from step 4)

The response will look like:

```json
{
  "id": "dispatch-1711234567890-a1b2",
  "status": "dispatched"
}
```

### Detailed Step-by-Step

For those unfamiliar with Shortcuts:

1. Open **Shortcuts** app > tap **+** (top right)
2. Tap **Add Action**, search "Ask for Input", select it
   - Set prompt to `What do you want to build?`
3. Tap **+** again, add another **Ask for Input**
   - Set prompt to `Which repo? (owner/name, or leave blank)`
4. Add a **Text** action and type the JSON body, inserting the variables from steps 1-2 using the variable picker
5. Add **Get Contents of URL**
   - Tap the URL field, enter your server URL
   - Tap **Show More**, set Method to POST
   - Under Headers, add `Authorization` = `Bearer <your-token>` and `Content-Type` = `application/json`
   - Under Request Body, select **File** and pass the Text from step 4
6. Add **Show Result** and pass the output from step 5
7. Name the shortcut (e.g., "forgectl Dispatch") and tap **Done**

### Installing the .shortcut File

A pre-built shortcut file is provided at [`docs/forgectl-dispatch.shortcut`](./forgectl-dispatch.shortcut).

To install:

1. Transfer the file to your iPhone (AirDrop, iCloud Drive, email attachment)
2. Open the file -- iOS will prompt you to add it to Shortcuts
3. Tap **Add Shortcut**
4. Open the shortcut and edit the two placeholder values:
   - Replace `https://YOUR-SERVER:4856` with your actual daemon URL
   - Replace `YOUR_DAEMON_TOKEN` with the token from `~/.forgectl/daemon.token`

---

## Approach 2: Direct to Linear API

If you don't want to expose your daemon, the shortcut can create a Linear issue directly. forgectl's orchestrator polls Linear for new issues and picks them up automatically.

### Prerequisites

- A Linear API key (Settings > API > Personal API Keys)
- A Linear team ID (find it in Settings > Teams, or via the API)
- forgectl configured with `tracker.kind: linear` and polling enabled

### Building the Shortcut

1. **Ask for Input**
   - Prompt: `What do you want to build?`
   - Input Type: Text (multi-line)
   - Save output to variable: `TaskDescription`

2. **Text** (build the GraphQL mutation):
   ```
   {"query": "mutation { issueCreate(input: { teamId: \"YOUR_TEAM_ID\", title: \"FIRST_LINE\", description: \"FULL_DESCRIPTION\" }) { success issue { id identifier url } } }"}
   ```
   Use **Split Text** to extract the first line for the title.

3. **Get Contents of URL**
   - URL: `https://api.linear.app/graphql`
   - Method: **POST**
   - Headers:
     - `Authorization`: `YOUR_LINEAR_API_KEY`
     - `Content-Type`: `application/json`
   - Request Body: **File** -- pass the Text from step 2

4. **Get Dictionary Value** (optional)
   - Extract `data.issueCreate.issue.identifier` from the response

5. **Show Result**
   - Show the issue identifier (e.g., `ENG-42`) or the full response

### How It Works End-to-End

1. You run the shortcut on your phone and type a task
2. The shortcut creates a Linear issue via the API
3. forgectl's orchestrator polls Linear, finds the new issue
4. forgectl dispatches the task to an agent in a Docker container
5. The agent works on the task, and forgectl creates a PR when done

---

## Tips

- Add the shortcut to your Home Screen for quick access (long-press the shortcut > Add to Home Screen)
- Use Siri to trigger it: name it something like "Dispatch Task" and say "Hey Siri, Dispatch Task"
- The `repo` field in the daemon approach accepts `owner/repo` format (e.g., `rahul-fnu/forgectl`)
- You can extend the shortcut to also pass `priority` and `labels` fields to the dispatch API
