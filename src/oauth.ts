import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import { google } from 'googleapis';
import express from 'express';
import { homedir } from 'os';
import open from 'open';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const BLOGGER_READ_SCOPE = 'https://www.googleapis.com/auth/blogger.readonly';
export const BLOGGER_WRITE_SCOPE = 'https://www.googleapis.com/auth/blogger';

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface StoredTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null;
}

export class BloggerOAuth {
  private oauth2Client: any;
  private config: OAuthConfig;
  private tokenFile: string;

  constructor() {
    this.config = {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    };

    const configuredTokenPath = process.env.BLOGGER_TOKEN_PATH;
    const defaultTokenDir = path.join(homedir(), '.config', 'blogger-mcp-server');
    this.tokenFile = configuredTokenPath || path.join(defaultTokenDir, 'tokens.json');

    this.oauth2Client = this.createOAuthClient(this.getRedirectUri());
  }

  async getAuthenticatedClient(requireWrite: boolean = false) {
    const requiredScopes = this.getRequiredScopes(requireWrite);

    try {
      const tokens = await this.loadTokens();

      if (!this.hasRequiredScopes(tokens, requiredScopes)) {
        return await this.performOAuthFlow(requiredScopes);
      }

      this.oauth2Client = this.createOAuthClient(this.getRedirectUri());
      this.oauth2Client.setCredentials(tokens);

      if ((tokens.expiry_date || 0) <= Date.now() + 60_000) {
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        const refreshedTokens: StoredTokens = {
          ...tokens,
          ...credentials,
          refresh_token: credentials.refresh_token || tokens.refresh_token,
          scope: credentials.scope || tokens.scope,
        };

        await this.saveTokens(refreshedTokens);
        this.oauth2Client.setCredentials(refreshedTokens);
      }

      return this.oauth2Client;
    } catch {
      return await this.performOAuthFlow(requiredScopes);
    }
  }

  private createOAuthClient(redirectUri: string) {
    return new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
      redirectUri
    );
  }

  private getOAuthPort() {
    const configuredPort = Number(process.env.BLOGGER_OAUTH_PORT || '3000');
    if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536) {
      return configuredPort;
    }

    return 3000;
  }

  private getRedirectUri() {
    return `http://127.0.0.1:${this.getOAuthPort()}/oauth/callback`;
  }

  private getRequiredScopes(requireWrite: boolean) {
    return requireWrite ? [BLOGGER_WRITE_SCOPE] : [BLOGGER_READ_SCOPE];
  }

  private hasRequiredScopes(tokens: StoredTokens, requiredScopes: string[]) {
    const grantedScopes = new Set((tokens.scope || '').split(/\s+/).filter(Boolean));

    return requiredScopes.every((scope) => {
      if (scope === BLOGGER_READ_SCOPE && grantedScopes.has(BLOGGER_WRITE_SCOPE)) {
        return true;
      }

      return grantedScopes.has(scope);
    });
  }

  private async loadTokens() {
    const tokenData = await fs.readFile(this.tokenFile, 'utf8');
    return JSON.parse(tokenData) as StoredTokens;
  }

  private async performOAuthFlow(requiredScopes: string[]) {
    return new Promise<any>((resolve, reject) => {
      const app = express();
      app.disable('x-powered-by');

      const host = '127.0.0.1';
      const port = this.getOAuthPort();
      const redirectUri = this.getRedirectUri();
      const oauth2Client = this.createOAuthClient(redirectUri);
      const state = randomBytes(24).toString('hex');

      let server: any;
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;

        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        if (server) {
          server.close();
        }

        callback();
      };

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        include_granted_scopes: true,
        prompt: 'consent',
        scope: requiredScopes,
        state,
      });

      app.get('/oauth/callback', async (req, res) => {
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const error = typeof req.query.error === 'string' ? req.query.error : '';
        const returnedState = typeof req.query.state === 'string' ? req.query.state : '';

        if (error) {
          res.status(400).send(`Authentication failed: ${error}`);
          finish(() => reject(new Error(`OAuth error: ${error}`)));
          return;
        }

        if (!returnedState || returnedState !== state) {
          res.status(400).send('Authentication failed: invalid OAuth state');
          finish(() => reject(new Error('OAuth state validation failed')));
          return;
        }

        if (!code) {
          res.status(400).send('No authorization code received');
          finish(() => reject(new Error('No authorization code received')));
          return;
        }

        try {
          const { tokens } = await oauth2Client.getToken(code);
          await this.saveTokens(tokens);
          oauth2Client.setCredentials(tokens);
          this.oauth2Client = oauth2Client;

          res.send(`
            <html>
              <body>
                <h2>Authentication successful</h2>
                <p>You can close this window and return to Claude.</p>
                <script>setTimeout(() => window.close(), 1500);</script>
              </body>
            </html>
          `);

          finish(() => resolve(oauth2Client));
        } catch (tokenError) {
          res.status(500).send('Token exchange failed');
          finish(() => reject(tokenError));
        }
      });

      server = app.listen(port, host, () => {
        console.error('\nOAuth setup required');
        console.error(`Listening for the OAuth callback on ${redirectUri}`);
        console.error('Opening the browser for Google authentication...\n');

        open(authUrl).catch(() => {
          console.error('Could not open the browser automatically.');
          console.error('Visit this URL manually:');
          console.error(authUrl);
        });
      });

      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          finish(() => reject(new Error(
            `OAuth callback port ${port} is already in use. Set BLOGGER_OAUTH_PORT to a free port and try again.`
          )));
          return;
        }

        finish(() => reject(error));
      });

      timeoutHandle = setTimeout(() => {
        finish(() => reject(new Error('OAuth flow timed out after 5 minutes')));
      }, 300000);
    });
  }

  private async saveTokens(tokens: StoredTokens) {
    try {
      await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
      await fs.writeFile(this.tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      await fs.chmod(this.tokenFile, 0o600);
    } catch (error) {
      console.error('Failed to save OAuth tokens:', error);
    }
  }

  async revokeAuth() {
    try {
      await this.oauth2Client.revokeCredentials();
      await fs.unlink(this.tokenFile).catch(() => {});
      console.error('Authentication revoked successfully');
    } catch (error) {
      console.error('Failed to revoke authentication:', error);
    }
  }
}
