# OAuth Setup Instructions

To enable post creation, updating, and deletion, you need to set up OAuth 2.0 authentication with Google.

## Step 1: Create OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (or create a new one)
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth 2.0 Client IDs**
5. Choose **Desktop Application** as the application type
6. Name it "Blogger MCP Server"
7. Click **Create**
8. Download the JSON file or note the Client ID and Client Secret

## Step 2: Configure Environment Variables

Add these to your environment (or Claude config):

```bash
# Required for authenticated draft access and write operations
GOOGLE_CLIENT_ID=your_oauth_client_id_here
GOOGLE_CLIENT_SECRET=your_oauth_client_secret_here

# Still needed for read operations if OAuth fails
BLOGGER_API_KEY=your_api_key_here

# Optional: lock the server to one blog unless explicitly overridden
BLOGGER_ID=your_blog_id_here
BLOGGER_ALLOW_BLOG_OVERRIDE=false

# Optional: store tokens outside the repo checkout
BLOGGER_TOKEN_PATH=$HOME/.config/blogger-mcp-server/tokens.json
```

## Step 3: Update Claude Configuration

```json
{
  "mcpServers": {
    "blogger": {
      "command": "node",
      "args": [
        "C:\\path\\to\\blogger-mcp-server\\dist\\index.js"
      ],
      "env": {
        "BLOGGER_API_KEY": "your_api_key",
        "GOOGLE_CLIENT_ID": "your_oauth_client_id",
        "GOOGLE_CLIENT_SECRET": "your_oauth_client_secret"
      }
    }
  }
}
```

## Step 4: Authentication Flow

When you first try to create a post:

1. The server will automatically open your browser
2. Sign in to Google and grant permissions
3. The server will save OAuth tokens locally (default: `~/.config/blogger-mcp-server/tokens.json`)
4. Future requests will use the saved tokens automatically

## Security Notes

- The OAuth token file contains sensitive auth tokens
- Tokens are stored with restricted file permissions
- You can override the token file path with `BLOGGER_TOKEN_PATH`
- Keep your OAuth credentials secure
- The server runs a temporary local server on `127.0.0.1` only during authentication

## Troubleshooting

### "OAuth credentials missing" warning
- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables
- Read operations will still work with just `BLOGGER_API_KEY`

### Authentication fails
- Check that OAuth credentials are correct
- Ensure Blogger API is enabled in Google Cloud Console
- Try deleting `tokens.json` to force re-authentication

### Port 3000 in use
- The OAuth flow temporarily uses port 3000 by default
- Set `BLOGGER_OAUTH_PORT` if you need a different local callback port
- After authentication completes, the port is freed
