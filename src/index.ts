#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import { BloggerOAuth } from './oauth.js';
import { parseIsDraft } from './validation.js';

const API_KEY = process.env.BLOGGER_API_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BLOGGER_ID = process.env.BLOGGER_ID?.trim();
const ALLOW_BLOG_OVERRIDE = process.env.BLOGGER_ALLOW_BLOG_OVERRIDE === 'true';
const MAX_LIST_POSTS = 50;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('OAuth credentials missing. Draft access and mutating operations will be unavailable.');
  console.error('To enable authenticated features, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  console.error('Public read operations can still work with BLOGGER_API_KEY.');
}

if (!API_KEY && (!CLIENT_ID || !CLIENT_SECRET)) {
  console.error('Either BLOGGER_API_KEY or OAuth credentials (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) are required');
  process.exit(1);
}

const oauthHandler = CLIENT_ID && CLIENT_SECRET ? new BloggerOAuth() : null;

class BloggerMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'blogger-mcp-server',
        version: '1.1.1',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async getAuthClient(options: { requireOAuth?: boolean; requireWrite?: boolean } = {}) {
    const requireOAuth = options.requireOAuth || false;
    const requireWrite = options.requireWrite || false;

    if (requireWrite) {
      if (!oauthHandler) {
        throw new Error('OAuth authentication required for write operations. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
      }

      return await oauthHandler.getAuthenticatedClient(true);
    }

    if (requireOAuth) {
      if (!oauthHandler) {
        throw new Error('OAuth authentication required for this operation. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
      }

      return await oauthHandler.getAuthenticatedClient(false);
    }

    if (API_KEY) {
      return API_KEY;
    }

    if (oauthHandler) {
      return await oauthHandler.getAuthenticatedClient(false);
    }

    throw new Error('No authentication method available');
  }

  private getBloggerClient(auth: any) {
    return google.blogger({ version: 'v3', auth });
  }

  private formatError(error: unknown) {
    if (error instanceof McpError) {
      return error.message;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private resolveBlogId(blogId?: string) {
    const requestedBlogId = blogId?.trim();

    if (requestedBlogId) {
      if (BLOGGER_ID && requestedBlogId !== BLOGGER_ID && !ALLOW_BLOG_OVERRIDE) {
        throw new Error(
          'blogId override is disabled for safety. Set BLOGGER_ALLOW_BLOG_OVERRIDE=true to target a different blog.'
        );
      }

      return requestedBlogId;
    }

    if (BLOGGER_ID) {
      return BLOGGER_ID;
    }

    throw new Error('blogId is required. Either provide it in the request or set BLOGGER_ID.');
  }

  private resolveBlogReference(blogUrl?: string) {
    const requestedReference = blogUrl?.trim();

    if (requestedReference) {
      if (BLOGGER_ID && requestedReference !== BLOGGER_ID && !ALLOW_BLOG_OVERRIDE) {
        throw new Error(
          'Cross-blog lookup is disabled for safety. Set BLOGGER_ALLOW_BLOG_OVERRIDE=true to target a different blog.'
        );
      }

      return requestedReference;
    }

    if (BLOGGER_ID) {
      return BLOGGER_ID;
    }

    throw new Error('blogUrl is required. Either provide it in the request or set BLOGGER_ID.');
  }

  private normalizeMaxResults(maxResults?: number) {
    const parsed = Number.isFinite(maxResults) ? Math.trunc(maxResults as number) : 10;
    return Math.min(Math.max(parsed || 10, 1), MAX_LIST_POSTS);
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: any[] = [
        {
          name: 'get_blog_info',
          description: 'Get information about a blog by URL or ID. If BLOGGER_ID is configured, it is used by default.',
          inputSchema: {
            type: 'object',
            properties: {
              blogUrl: {
                type: 'string',
                description: 'Optional blog URL (e.g., myblog.blogspot.com) or blog ID.',
              },
            },
          },
        },
        {
          name: 'list_posts',
          description: 'List posts from a blog. Draft and scheduled posts require OAuth.',
          inputSchema: {
            type: 'object',
            properties: {
              blogId: {
                type: 'string',
                description: 'Optional blog ID. If omitted, BLOGGER_ID is used.',
              },
              maxResults: {
                type: 'number',
                description: 'Maximum posts to return (default: 10, max: 50).',
                default: 10,
                minimum: 1,
                maximum: 50,
              },
              status: {
                type: 'string',
                description: 'Filter posts by status: "draft", "live", or "scheduled".',
                enum: ['draft', 'live', 'scheduled'],
              },
              includeContent: {
                type: 'boolean',
                description: 'Include post HTML bodies in the response. Defaults to false.',
                default: false,
              },
            },
          },
        },
        {
          name: 'get_post',
          description: 'Get a specific post by ID.',
          inputSchema: {
            type: 'object',
            properties: {
              blogId: {
                type: 'string',
                description: 'Optional blog ID. If omitted, BLOGGER_ID is used.',
              },
              postId: {
                type: 'string',
                description: 'Post ID.',
              },
            },
            required: ['postId'],
          },
        },
        {
          name: 'search_posts',
          description: 'Search for posts in a blog.',
          inputSchema: {
            type: 'object',
            properties: {
              blogId: {
                type: 'string',
                description: 'Optional blog ID. If omitted, BLOGGER_ID is used.',
              },
              query: {
                type: 'string',
                description: 'Search query.',
              },
            },
            required: ['query'],
          },
        },
      ];

      if (oauthHandler) {
        tools.push(
          {
            name: 'create_post',
            description: 'Create a new blog post. Drafts are the default for safety.',
            inputSchema: {
              type: 'object',
              properties: {
                blogId: {
                  type: 'string',
                  description: 'Optional blog ID. If omitted, BLOGGER_ID is used.',
                },
                title: {
                  type: 'string',
                  description: 'Post title.',
                },
                content: {
                  type: 'string',
                  description: 'Post content. HTML is allowed.',
                },
                labels: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional post labels.',
                },
                isDraft: {
                  type: 'boolean',
                  description: 'Whether to create a draft. Must be a boolean; omit it for a draft. Set false to publish immediately. Any non-boolean value is rejected.',
                  default: true,
                },
              },
              required: ['title', 'content'],
            },
          },
          {
            name: 'update_post',
            description: 'Update an existing blog post.',
            inputSchema: {
              type: 'object',
              properties: {
                blogId: {
                  type: 'string',
                  description: 'Optional blog ID. If omitted, BLOGGER_ID is used.',
                },
                postId: {
                  type: 'string',
                  description: 'Post ID.',
                },
                title: {
                  type: 'string',
                  description: 'New post title (optional).',
                },
                content: {
                  type: 'string',
                  description: 'New post content (optional, HTML allowed).',
                },
                labels: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'New post labels (optional).',
                },
              },
              required: ['postId'],
            },
          },
          {
            name: 'delete_post',
            description: 'Delete a blog post. Requires confirmPostId to match postId.',
            inputSchema: {
              type: 'object',
              properties: {
                blogId: {
                  type: 'string',
                  description: 'Optional blog ID. If omitted, BLOGGER_ID is used.',
                },
                postId: {
                  type: 'string',
                  description: 'Post ID.',
                },
                confirmPostId: {
                  type: 'string',
                  description: 'Repeat the post ID to confirm deletion.',
                },
              },
              required: ['postId', 'confirmPostId'],
            },
          }
        );
      }

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (!args) {
        throw new McpError(ErrorCode.InvalidParams, 'Arguments are required');
      }

      try {
        switch (name) {
          case 'get_blog_info':
            return await this.getBlogInfo(args.blogUrl as string | undefined);

          case 'list_posts':
            return await this.listPosts(
              args.blogId as string | undefined,
              args.maxResults as number | undefined,
              args.status as string | undefined,
              args.includeContent as boolean | undefined
            );

          case 'get_post':
            return await this.getPost(
              args.blogId as string | undefined,
              args.postId as string
            );

          case 'search_posts':
            return await this.searchPosts(
              args.blogId as string | undefined,
              args.query as string
            );

          case 'create_post': {
            // Validate before any auth or API work so a malformed flag never publishes.
            const isDraft = parseIsDraft(args.isDraft);
            return await this.createPost(
              args.blogId as string | undefined,
              args.title as string,
              args.content as string,
              (args.labels as string[] | undefined) || [],
              isDraft
            );
          }

          case 'update_post':
            return await this.updatePost(
              args.blogId as string | undefined,
              args.postId as string,
              args.title as string | undefined,
              args.content as string | undefined,
              args.labels as string[] | undefined
            );

          case 'delete_post':
            return await this.deletePost(
              args.blogId as string | undefined,
              args.postId as string,
              args.confirmPostId as string
            );

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }

        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${this.formatError(error)}`);
      }
    });
  }

  private async getBlogInfo(blogUrl?: string) {
    try {
      const targetBlog = this.resolveBlogReference(blogUrl);
      const auth = await this.getAuthClient();
      const bloggerClient = this.getBloggerClient(auth);

      const response = targetBlog.includes('.')
        ? await bloggerClient.blogs.getByUrl({
            url: targetBlog.startsWith('http') ? targetBlog : `https://${targetBlog}`,
          })
        : await bloggerClient.blogs.get({
            blogId: targetBlog,
          });

      const blog = response.data;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: blog.id,
              name: blog.name,
              description: blog.description,
              url: blog.url,
              published: blog.published,
              updated: blog.updated,
              posts: {
                totalItems: blog.posts?.totalItems || 0,
              },
              pages: {
                totalItems: blog.pages?.totalItems || 0,
              },
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to get blog info: ${this.formatError(error)}`);
    }
  }

  private async listPosts(blogId?: string, maxResults?: number, status?: string, includeContent?: boolean) {
    try {
      const targetBlogId = this.resolveBlogId(blogId);
      const requireOAuth = status === 'draft' || status === 'scheduled';
      const auth = await this.getAuthClient({ requireOAuth });
      const bloggerClient = this.getBloggerClient(auth);

      const listParams: any = {
        blogId: targetBlogId,
        maxResults: this.normalizeMaxResults(maxResults),
      };

      if (status) {
        listParams.status = status.toLowerCase();
      }

      if (includeContent) {
        listParams.fetchBodies = true;
        listParams.fetchImages = true;
      }

      const response = await bloggerClient.posts.list(listParams);
      const posts = response.data.items || [];
      const statusText = status ? ` (status: ${status})` : '';

      return {
        content: [
          {
            type: 'text',
            text: `Found ${posts.length} posts${statusText}:\n\n` +
              posts.map((post: any) => {
                let postText = `**${post.title || '(Untitled post)'}**\n` +
                  `ID: ${post.id}\n` +
                  `Published: ${post.published || 'Not published'}\n` +
                  `Status: ${post.status || 'live'}\n` +
                  (post.url ? `URL: ${post.url}\n` : '') +
                  (post.labels && post.labels.length > 0 ? `Labels: ${post.labels.join(', ')}\n` : '');

                if (includeContent && post.content) {
                  postText += `\n**Content:**\n${post.content}\n`;
                }

                return postText + '---';
              }).join('\n\n'),
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to list posts: ${this.formatError(error)}`);
    }
  }

  private async getPost(blogId: string | undefined, postId: string) {
    try {
      const targetBlogId = this.resolveBlogId(blogId);

      if (API_KEY) {
        try {
          const bloggerClient = this.getBloggerClient(API_KEY);
          const response = await bloggerClient.posts.get({
            blogId: targetBlogId,
            postId,
            fetchBody: true,
            fetchImages: true,
          });

          return this.renderPost(response.data);
        } catch (error) {
          if (!oauthHandler) {
            throw error;
          }
        }
      }

      const auth = await this.getAuthClient({ requireOAuth: true });
      const bloggerClient = this.getBloggerClient(auth);
      const response = await bloggerClient.posts.get({
        blogId: targetBlogId,
        postId,
        fetchBody: true,
        fetchImages: true,
      });

      return this.renderPost(response.data);
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to get post: ${this.formatError(error)}`);
    }
  }

  private renderPost(post: any) {
    return {
      content: [
        {
          type: 'text',
          text: `**${post.title || '(Untitled post)'}**\n\n` +
            `Published: ${post.published || 'Not published'}\n` +
            `Updated: ${post.updated || 'Unknown'}\n` +
            `Status: ${post.status || 'live'}\n` +
            (post.url ? `URL: ${post.url}\n` : '') +
            (post.labels && post.labels.length > 0 ? `Labels: ${post.labels.join(', ')}\n` : '') +
            `\n**Content:**\n${post.content || '(No content)'}`,
        },
      ],
    };
  }

  private async searchPosts(blogId: string | undefined, query: string) {
    try {
      const targetBlogId = this.resolveBlogId(blogId);
      const auth = await this.getAuthClient();
      const bloggerClient = this.getBloggerClient(auth);

      const response = await bloggerClient.posts.search({
        blogId: targetBlogId,
        q: query,
      });

      const posts = response.data.items || [];
      return {
        content: [
          {
            type: 'text',
            text: `Found ${posts.length} posts matching "${query}":\n\n` +
              posts.map((post: any) =>
                `**${post.title || '(Untitled post)'}**\n` +
                `ID: ${post.id}\n` +
                `Published: ${post.published || 'Not published'}\n` +
                (post.url ? `URL: ${post.url}\n` : '') +
                '---'
              ).join('\n\n'),
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to search posts: ${this.formatError(error)}`);
    }
  }

  private async createPost(
    blogId: string | undefined,
    title: string,
    content: string,
    labels: string[],
    isDraft: boolean
  ) {
    try {
      const targetBlogId = this.resolveBlogId(blogId);
      const auth = await this.getAuthClient({ requireWrite: true });
      const bloggerClient = this.getBloggerClient(auth);

      const post = {
        kind: 'blogger#post',
        title,
        content,
        labels,
      };

      const response = await bloggerClient.posts.insert({
        blogId: targetBlogId,
        requestBody: post,
        ...(isDraft ? { isDraft: true } : {}),
      });

      const createdPost = response.data;
      return {
        content: [
          {
            type: 'text',
            text: isDraft
              ? `Successfully created draft: **${createdPost.title}**\n\n` +
                `Post ID: ${createdPost.id}\n` +
                `Status: Draft\n` +
                `Created: ${createdPost.published || 'Draft (not published)'}`
              : `Successfully created post: **${createdPost.title}**\n\n` +
                `Post ID: ${createdPost.id}\n` +
                `URL: ${createdPost.url}\n` +
                `Published: ${createdPost.published}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to create post: ${this.formatError(error)}`);
    }
  }

  private async updatePost(
    blogId: string | undefined,
    postId: string,
    title?: string,
    content?: string,
    labels?: string[]
  ) {
    try {
      const targetBlogId = this.resolveBlogId(blogId);
      const auth = await this.getAuthClient({ requireWrite: true });
      const bloggerClient = this.getBloggerClient(auth);

      const updateData: any = {};
      if (title) updateData.title = title;
      if (content) updateData.content = content;
      if (labels) updateData.labels = labels;

      if (Object.keys(updateData).length === 0) {
        throw new Error('At least one of title, content, or labels must be provided.');
      }

      const response = await bloggerClient.posts.patch({
        blogId: targetBlogId,
        postId,
        requestBody: updateData,
      });

      const updatedPost = response.data;
      return {
        content: [
          {
            type: 'text',
            text: `Successfully updated post: **${updatedPost.title}**\n\n` +
              `Post ID: ${updatedPost.id}\n` +
              (updatedPost.url ? `URL: ${updatedPost.url}\n` : '') +
              `Last Updated: ${updatedPost.updated}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to update post: ${this.formatError(error)}`);
    }
  }

  private async deletePost(blogId: string | undefined, postId: string, confirmPostId: string) {
    try {
      if (postId !== confirmPostId) {
        throw new Error('confirmPostId must exactly match postId before a post can be deleted.');
      }

      const targetBlogId = this.resolveBlogId(blogId);
      const auth = await this.getAuthClient({ requireWrite: true });
      const bloggerClient = this.getBloggerClient(auth);

      await bloggerClient.posts.delete({
        blogId: targetBlogId,
        postId,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully deleted post with ID: ${postId}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to delete post: ${this.formatError(error)}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

const server = new BloggerMCPServer();
server.run().catch(console.error);
