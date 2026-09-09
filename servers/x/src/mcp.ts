#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  TextContent,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Page } from "playwright";
import { z } from "zod";

import { getAuthenticatedPage } from "./behaviors/login";
import {
  scrapeComments,
  scrapePosts,
  scrapeProfile,
  scrapeTimeline,
  scrapeTrendingTopics,
  SearchPresets,
  searchTwitter,
} from "./scrapers";
import { TweetWithMedia, TwitterComment, TwitterPost } from "./types";
import { getRateLimitHit, RateLimitError } from "./utils";
import { Throttle } from "./throttle";

type Profile = "director" | "explorer";

// Import post interaction functions
import {
  bookmarkPost,
  likePost,
  postThread,
  postTweet,
  quoteTweet,
  replyToPost,
  retweetPost,
  unbookmarkPost,
  unlikePost,
  unretweetPost,
} from "./behaviors/interact-with-post";

// Import comment interaction functions
import {
  likeCommentById,
  replaceCommentById,
  replyToCommentById,
  unlikeCommentById,
} from "./behaviors/interact-with-comment";
import { readFileSync, unlinkSync } from "fs";

// Validation schemas using Zod
const TweetSchema = z.object({
  text: z.string().min(1).max(280).describe("The text content of the tweet"),
  media: z
    .array(z.string())
    .optional()
    .describe("Array of media file paths (images/videos) to attach to the tweet"),
});

const ThreadSchema = z.object({
  tweets: z
    .array(TweetSchema)
    .min(2)
    .describe("Array of tweet objects with text and optional media"),
});

const ScrapePostsSchema = z.object({
  maxPosts: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe("Maximum number of posts to scrape"),
});

const ScrapeProfileSchema = z.object({
  username: z.string().describe("Username to scrape (without @)"),
  maxPosts: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .default(5)
    .describe("Maximum number of posts to include"),
});

const GetPostSchema = z.object({
  url: z.string().url().describe("URL of the post to read"),
  comment_limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Number of replies to return"),
});

// Shared rendering. Every research-path tool across the reddit, x and
// xiaohongshu servers returns the same four lines — title, author + engagement +
// date, URL, excerpt — so the caller reads one shape regardless of platform.
// An x post has no title, so its content *is* the first line and there is no
// fourth.
const EXCERPT_CAP = 2000;

function excerpt(text: string | undefined | null): string {
  if (!text) return "";
  const flat = text.split(/\s+/).join(" ").trim();
  return flat.length <= EXCERPT_CAP
    ? flat
    : `${flat.slice(0, EXCERPT_CAP)}… (full text ${flat.length} chars)`;
}

function day(ts: Date | string | undefined): string {
  if (!ts) return "";
  const d = ts instanceof Date ? ts : new Date(ts);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function postMeta(post: TwitterPost): string {
  const m = post.metrics;
  const parts = [
    `@${post.author.username}`,
    `♥${m.likesCount} 🔁${m.retweetsCount} 💬${m.repliesCount}`,
  ];
  const d = day(post.timestamp);
  if (d) parts.push(d);
  return parts.join(" · ");
}

// Shared by search and the timeline. A feed and a search result are the same
// thing to a reader, so they get the same lines.
function renderPostList(header: string, posts: TwitterPost[], empty: string): string {
  if (!posts.length) return empty;
  const lines = [header, ""];
  posts.forEach((post, i) => {
    lines.push(`${i + 1}. ${excerpt(post.content)}`);
    const rt = post.isRetweet ? ` · RT @${post.retweetedFrom?.username ?? "?"}` : "";
    lines.push(`   ${postMeta(post)}${rt}`);
    lines.push(`   ${post.url}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function renderResults(query: string, posts: TwitterPost[]): string {
  return renderPostList(
    `${posts.length} results for "${query}" · x`,
    posts,
    `no results for "${query}" · x`
  );
}

function renderTimeline(label: string, posts: TwitterPost[]): string {
  return renderPostList(`${posts.length} posts · ${label}`, posts, `no posts · ${label}`);
}

// How many articles to look through for the requested post. A status page shows
// the post, whatever it replies to, and the start of the reply tree, so the one
// we want is near the top — but not dependably first.
const GET_POST_SCAN = 8;

/** The status id in a post URL, or undefined if this is not a status URL. */
function parseStatusId(url: string): string | undefined {
  return /\/status\/(\d+)/.exec(url)?.[1];
}

function renderPost(post: TwitterPost | undefined, url: string, comments: TwitterComment[]): string {
  const lines = post
    ? [post.content, postMeta(post), post.url]
    : ["(post body not captured)", "", url];
  lines.push("-".repeat(60), `COMMENTS (${comments.length})`);
  for (const c of comments) {
    lines.push(`♥${c.likesCount} @${c.author.username}: ${excerpt(c.content)}`);
  }
  return lines.join("\n");
}

const SearchSchema = z.object({
  query: z.string().describe("Search query"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe("Number of posts to return"),
});

const SearchViralSchema = z.object({
  query: z.string().describe("Search query"),
  minLikes: z
    .number()
    .min(100)
    .optional()
    .default(1000)
    .describe("Minimum number of likes for viral posts"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe("Number of posts to return"),
});

const ScrapeTimelineSchema = z.object({
  type: z
    .enum(["for-you", "following"])
    .optional()
    .default("for-you")
    .describe("Timeline type to scrape"),
  maxPosts: z
    .number()
    .min(1)
    .optional()
    .describe("Optional hard cap on number of posts to scrape (omit for no cap)"),
  maxAgeHours: z
    .number()
    .min(0)
    .optional()
    .describe(
      "Stop scraping once posts are older than this many hours. Reposts are " +
      "ignored for this check since they carry the original tweet's timestamp."
    ),
});

// Post interaction schemas
const LikePostSchema = z.object({
  postUrl: z.string().url().describe("URL of the post to like"),
});

const UnlikePostSchema = z.object({
  postUrl: z.string().url().describe("URL of the post to unlike"),
});

const BookmarkPostSchema = z.object({
  postUrl: z.string().url().describe("URL of the post to bookmark"),
});

const UnbookmarkPostSchema = z.object({
  postUrl: z.string().url().describe("URL of the post to remove bookmark from"),
});

const RetweetPostSchema = z.object({
  postUrl: z.string().url().describe("URL of the post to retweet/repost"),
});

const UnretweetPostSchema = z.object({
  postUrl: z.string().url().describe("URL of the post to unretweet"),
});

const QuoteTweetSchema = z.object({
  postUrl: z.string().url().describe("URL of the post to quote tweet"),
  quoteText: z.string().min(1).max(280).describe("Text for the quote tweet"),
});

const ReplyToPostSchema = z.object({
  postUrl: z.string().url().describe("URL of the post to reply to"),
  replyText: z.string().min(1).max(280).describe("Text for the reply"),
});

// Comment interaction schemas
const LikeCommentByIdSchema = z.object({
  commentUrl: z.string().url().describe("Direct URL to the comment"),
});

const UnlikeCommentByIdSchema = z.object({
  commentUrl: z.string().url().describe("Direct URL to the comment"),
});

const ReplyToCommentByIdSchema = z.object({
  commentUrl: z.string().url().describe("Direct URL to the comment"),
  replyText: z.string().min(1).max(280).describe("Text for the reply"),
});

const ReplaceCommentByIdSchema = z.object({
  commentUrl: z.string().url().describe("Direct URL to the comment"),
  newText: z.string().min(1).max(280).describe("The new text to replace the comment with"),
});

export class TwitterMCPServer {
  private server: Server;
  private authenticatedPage: Page | null = null;
  private browserContextClose: (() => Promise<void>) | null = null;
  private readonly throttle = new Throttle();
  /**
   * One browser, one page, and callers that arrive in parallel: the digest runs
   * its screeners concurrently and every one of them reaches this same server.
   * `pace` spaces out when calls *start*; it never stopped two from being in
   * flight at once, so one call's `goto` landed in the middle of another's
   * scroll loop and the second caller was handed the first one's replies. This
   * is the gate the dispatcher's comment already claimed to have — held from
   * navigation through to the last scrape.
   */
  private gate: Promise<void> = Promise.resolve();
  private readonly profile: Profile;

  /**
   * Two profiles over one server, same split as the firecrawl and reddit servers.
   * `get_post` returns a post's full text plus its reply tree — unbounded, and the
   * one thing that must not land in the main loop's context. Everything else
   * returns bounded lines. `wait` belongs to both: either side can hit a cooldown.
   */
  private isToolVisible(name: string): boolean {
    if (name === "wait") return true;
    const explorerOnly = name === "get_post";
    return this.profile === "explorer" ? explorerOnly : !explorerOnly;
  }

  constructor(profile: Profile = "director") {
    this.profile = profile;
    this.server = new Server(
      {
        name: `twitter-playwright-mcp-${profile}`,
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Error handler
    this.server.onerror = (error) => {
      console.error("[MCP Error]:", error);
    };

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.error("Shutting down server...");
      if (this.browserContextClose) {
        await this.browserContextClose();
      }
      await this.server.close();
      process.exit(0);
    });

    // Register tool handlers
    this.setupToolHandlers();
  }

  /**
   * Resolves once the caller owns the page; call what it returns to hand it on.
   * A caller that never releases would stall every later tool call, so the
   * release belongs in a `finally`, not at the end of the happy path.
   */
  private acquire(): Promise<() => void> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => (release = resolve));
    return previous.then(() => release);
  }

  private async ensureAuthenticated() {
    if (!this.authenticatedPage) {
      const { page, close } = await getAuthenticatedPage();
      this.authenticatedPage = page;
      this.browserContextClose = close;
    }
    return this.authenticatedPage;
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ([
        {
          name: "tweet",
          description: "Post a tweet to Twitter/X",
          inputSchema: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "The text content of the tweet",
                maxLength: 280,
                minLength: 1,
              },
              media: {
                type: "array",
                description: "Array of media file paths (images/videos) to attach to the tweet",
                items: {
                  type: "string",
                },
              },
            },
            required: ["text"],
          },
        } as Tool,
        {
          name: "thread",
          description: "Post a thread of tweets",
          inputSchema: {
            type: "object",
            properties: {
              tweets: {
                type: "array",
                description: "Array of tweet objects with text and optional media",
                items: {
                  type: "object",
                  properties: {
                    text: {
                      type: "string",
                      description: "Tweet text",
                    },
                    media: {
                      type: "array",
                      description: "Media files for this tweet",
                      items: {
                        type: "string",
                      },
                    },
                  },
                  required: ["text"],
                },
                minItems: 2,
              },
            },
            required: ["tweets"],
          },
        } as Tool,
        {
          name: "scrape_posts",
          description: "Scrape posts from current page",
          inputSchema: {
            type: "object",
            properties: {
              maxPosts: {
                type: "number",
                description: "Maximum number of posts to scrape",
                minimum: 1,
                maximum: 100,
                default: 10,
              },
            },
            required: [],
          },
        } as Tool,
        {
          name: "scrape_profile",
          description: "Scrape a user profile",
          inputSchema: {
            type: "object",
            properties: {
              username: {
                type: "string",
                description: "Username to scrape (without @)",
              },
              maxPosts: {
                type: "number",
                description: "Maximum number of posts to include",
                minimum: 1,
                maximum: 50,
                default: 5,
              },
            },
            required: ["username"],
          },
        } as Tool,
        {
          name: "get_post",
          description: "Read one post in full: its text and its replies",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "URL of the post to read, as returned by search",
              },
              comment_limit: {
                type: "number",
                description: "Number of replies to return",
                minimum: 1,
                maximum: 100,
                default: 20,
              },
            },
            required: ["url"],
          },
        } as Tool,
        {
          name: "wait",
          description:
            "Sit out X's rate-limit cooldown. Call this when search or get_post says X is cooling down; retry after it returns. A long cooldown takes several calls — the result says when more is left.",
          inputSchema: { type: "object", properties: {} },
        } as Tool,
        {
          name: "search",
          description:
            "Search posts on X. Returns text, author, engagement, date and URL per post; pass a URL to get_post to read its replies.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query",
              },
              limit: {
                type: "number",
                description: "Number of posts to return",
                minimum: 1,
                maximum: 100,
                default: 10,
              },
            },
            required: ["query"],
          },
        } as Tool,
        {
          name: "search_viral",
          description: "Search for viral posts",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query",
              },
              minLikes: {
                type: "number",
                description: "Minimum number of likes for viral posts",
                minimum: 100,
                default: 1000,
              },
              limit: {
                type: "number",
                description: "Number of posts to return",
                minimum: 1,
                maximum: 100,
                default: 10,
              },
            },
            required: ["query"],
          },
        } as Tool,
        {
          name: "scrape_timeline",
          description: "Scrape posts from timeline",
          inputSchema: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "Timeline type to scrape",
                enum: ["for-you", "following"],
                default: "for-you",
              },
              maxPosts: {
                type: "number",
                description: "Optional hard cap on number of posts to scrape (omit for no cap)",
                minimum: 1,
              },
              maxAgeHours: {
                type: "number",
                description:
                  "Stop scraping once posts are older than this many hours (reposts ignored)",
                minimum: 0,
              },
            },
            required: [],
          },
        } as Tool,
        {
          name: "scrape_trending",
          description: "Get trending topics",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        } as Tool,
        // Post interaction tools
        {
          name: "like_post",
          description: "Like a specific post",
          inputSchema: {
            type: "object",
            properties: {
              postUrl: {
                type: "string",
                description: "URL of the post to like",
              },
            },
            required: ["postUrl"],
          },
        } as Tool,
        {
          name: "unlike_post",
          description: "Unlike a specific post",
          inputSchema: {
            type: "object",
            properties: {
              postUrl: {
                type: "string",
                description: "URL of the post to unlike",
              },
            },
            required: ["postUrl"],
          },
        } as Tool,
        {
          name: "bookmark_post",
          description: "Bookmark a specific post",
          inputSchema: {
            type: "object",
            properties: {
              postUrl: {
                type: "string",
                description: "URL of the post to bookmark",
              },
            },
            required: ["postUrl"],
          },
        } as Tool,
        {
          name: "unbookmark_post",
          description: "Remove bookmark from a specific post",
          inputSchema: {
            type: "object",
            properties: {
              postUrl: {
                type: "string",
                description: "URL of the post to remove bookmark from",
              },
            },
            required: ["postUrl"],
          },
        } as Tool,
        {
          name: "retweet_post",
          description: "Retweet/repost a specific post",
          inputSchema: {
            type: "object",
            properties: {
              postUrl: {
                type: "string",
                description: "URL of the post to retweet/repost",
              },
            },
            required: ["postUrl"],
          },
        } as Tool,
        {
          name: "unretweet_post",
          description: "Remove retweet/repost of a specific post",
          inputSchema: {
            type: "object",
            properties: {
              postUrl: {
                type: "string",
                description: "URL of the post to unretweet",
              },
            },
            required: ["postUrl"],
          },
        } as Tool,
        {
          name: "quote_tweet",
          description: "Quote tweet a post with custom text",
          inputSchema: {
            type: "object",
            properties: {
              postUrl: {
                type: "string",
                description: "URL of the post to quote tweet",
              },
              quoteText: {
                type: "string",
                description: "Text for the quote tweet",
                minLength: 1,
                maxLength: 280,
              },
            },
            required: ["postUrl", "quoteText"],
          },
        } as Tool,
        {
          name: "reply_to_post",
          description: "Reply to a post with a comment",
          inputSchema: {
            type: "object",
            properties: {
              postUrl: {
                type: "string",
                description: "URL of the post to reply to",
              },
              replyText: {
                type: "string",
                description: "Text for the reply",
                minLength: 1,
                maxLength: 280,
              },
            },
            required: ["postUrl", "replyText"],
          },
        } as Tool,
        // Comment interaction tools
        {
          name: "like_comment_by_id",
          description: "Like a comment by its direct URL",
          inputSchema: {
            type: "object",
            properties: {
              commentUrl: {
                type: "string",
                description: "Direct URL to the comment",
              },
            },
            required: ["commentUrl"],
          },
        } as Tool,
        {
          name: "unlike_comment_by_id",
          description: "Unlike a comment by its direct URL",
          inputSchema: {
            type: "object",
            properties: {
              commentUrl: {
                type: "string",
                description: "Direct URL to the comment",
              },
            },
            required: ["commentUrl"],
          },
        } as Tool,
        {
          name: "reply_to_comment_by_id",
          description: "Reply to a comment with a comment",
          inputSchema: {
            type: "object",
            properties: {
              commentUrl: {
                type: "string",
                description: "Direct URL to the comment",
              },
              replyText: {
                type: "string",
                description: "Text for the reply",
                minLength: 1,
                maxLength: 280,
              },
            },
            required: ["commentUrl", "replyText"],
          },
        } as Tool,
        {
          name: "replace_comment_by_id",
          description:
            "Replace/edit a comment by its direct URL (Note: Twitter/X may not support comment editing)",
          inputSchema: {
            type: "object",
            properties: {
              commentUrl: {
                type: "string",
                description: "Direct URL to the comment",
              },
              newText: {
                type: "string",
                description: "The new text to replace the comment with",
                minLength: 1,
                maxLength: 280,
              },
            },
            required: ["commentUrl", "newText"],
          },
        } as Tool,
      ] as Tool[]).filter((t) => this.isToolVisible(t.name)),
    }));

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      console.error(`Tool called: ${name}`, args);

      // `wait` exists to be callable while cooling down, so it goes ahead of
      // the gate; everything else drives the shared browser and waits behind it.
      if (name === "wait") return await this.handleWait();

      const cooling = this.throttle.check();
      if (cooling) {
        return { content: [{ type: "text", text: cooling }] as TextContent[], isError: true };
      }
      // Queued, not rejected: a caller that waits its turn is slower than one
      // that reads the wrong post, and only one of those is recoverable.
      const release = await this.acquire();
      await this.throttle.pace();

      const dispatchedAt = Date.now();

      try {
        const result = await (async () => {
          switch (name) {
            case "tweet":
              return await this.handleTweet(args);
            case "thread":
              return await this.handleThread(args);
            case "scrape_posts":
              return await this.handleScrapePosts(args);
            case "scrape_profile":
              return await this.handleScrapeProfile(args);
            case "get_post":
              return await this.handleGetPost(args);
            case "search":
              return await this.handleSearch(args);
            case "search_viral":
              return await this.handleSearchViral(args);
            case "scrape_timeline":
              return await this.handleScrapeTimeline(args);
            case "scrape_trending":
              return await this.handleScrapeTrending();
            // Post interaction tools
            case "like_post":
              return await this.handleLikePost(args);
            case "unlike_post":
              return await this.handleUnlikePost(args);
            case "bookmark_post":
              return await this.handleBookmarkPost(args);
            case "unbookmark_post":
              return await this.handleUnbookmarkPost(args);
            case "retweet_post":
              return await this.handleRetweetPost(args);
            case "unretweet_post":
              return await this.handleUnretweetPost(args);
            case "quote_tweet":
              return await this.handleQuoteTweet(args);
            case "reply_to_post":
              return await this.handleReplyToPost(args);
            // Comment interaction tools
            case "like_comment_by_id":
              return await this.handleLikeCommentById(args);
            case "unlike_comment_by_id":
              return await this.handleUnlikeCommentById(args);
            case "reply_to_comment_by_id":
              return await this.handleReplyToCommentById(args);
            case "replace_comment_by_id":
              return await this.handleReplaceCommentById(args);
            default:
              throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
          }
        })();
        this.throwIfRateLimited(dispatchedAt);
        this.throttle.succeed();
        return result;
      } catch (error) {
        const upgraded = this.upgradeToRateLimit(error, dispatchedAt);
        // A 429 was already being detected here and then thrown away; this is
        // what makes it change the server's behaviour rather than just its
        // error message.
        if (upgraded instanceof RateLimitError) this.throttle.penalize();
        return this.handleError(upgraded);
      } finally {
        release();
      }
    });
  }

  // Tool handlers
  private async handleTweet(args: unknown) {
    const result = TweetSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const tweetData: TweetWithMedia = {
      text: result.data.text,
      media: result.data.media,
    };
    const page = await this.ensureAuthenticated();
    await postTweet(page, tweetData);
    return {
      content: [
        {
          type: "text",
          text: `Tweet posted successfully: "${result.data.text}"${
            result.data.media ? ` with ${result.data.media.length} media file(s)` : ""
          }`,
        },
      ] as TextContent[],
    };
  }

  private async handleThread(args: unknown) {
    const result = ThreadSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await postThread(page, result.data.tweets);

    // Count tweets and media
    let mediaCount = 0;
    result.data.tweets.forEach((tweet) => {
      if (tweet.media && Array.isArray(tweet.media)) {
        mediaCount += tweet.media.length;
      }
    });

    return {
      content: [
        {
          type: "text",
          text: `Thread posted successfully with ${result.data.tweets.length} tweets${
            mediaCount > 0 ? ` and ${mediaCount} media file(s)` : ""
          }`,
        },
      ] as TextContent[],
    };
  }

  private async handleScrapePosts(args: unknown) {
    const result = ScrapePostsSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    const posts = await scrapePosts(page, {
      maxPosts: result.data.maxPosts,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: posts.length,
              posts: posts.map((post) => ({
                author: post.author.username,
                content: post.content.substring(0, 100) + "...",
                likes: post.metrics.likesCount,
                retweets: post.metrics.retweetsCount,
                engagement: post.engagementRate.toFixed(2) + "%",
                url: post.url,
              })),
            },
            null,
            2
          ),
        },
      ] as TextContent[],
    };
  }

  private async handleScrapeProfile(args: unknown) {
    const result = ScrapeProfileSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    const profile = await scrapeProfile(page, result.data.username, {
      maxPosts: result.data.maxPosts,
    });

    if (!profile) {
      throw new McpError(
        ErrorCode.InternalError,
        `Could not find profile for @${result.data.username}`
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              followers: profile.followersCount,
              following: profile.followingCount,
              posts: profile.postsCount,
              verified: profile.isVerified,
              latestPosts: profile.latestPosts?.map((post) => ({
                content: post.content.substring(0, 100) + "...",
                likes: post.metrics.likesCount,
                retweets: post.metrics.retweetsCount,
              })),
            },
            null,
            2
          ),
        },
      ] as TextContent[],
    };
  }

  private async handleWait() {
    const { slept, remaining } = await this.throttle.cool();
    const secs = (ms: number) => Math.ceil(ms / 1000);
    const text =
      slept === 0 && remaining > 0
        ? `Waited too many times already, ${secs(remaining)}s still left. Stop waiting and report this read as failed.`
        : slept === 0
          ? "Not cooling down — retry now."
          : remaining > 0
          ? `Waited ${secs(slept)}s, ${secs(remaining)}s still to go — call wait again.`
          : `Waited ${secs(slept)}s, cooldown over — retry now.`;
    return { content: [{ type: "text", text }] as TextContent[] };
  }

  private async handleGetPost(args: unknown) {
    const result = GetPostSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    const { url, comment_limit: commentLimit } = result.data;

    await page.goto(url);

    // The requested post is not reliably the first article on the page. When it
    // is a reply or a quote, X renders what it answers above it, and taking
    // article #1 silently returns that other post under the caller's URL — a
    // wrong body attributed to the right link, which is worse than an error
    // because nothing downstream can tell. So scan a few articles and pick the
    // one whose id actually matches; the id was always there to check against.
    const wantedId = parseStatusId(url);
    const posts = await scrapePosts(page, { maxPosts: GET_POST_SCAN, scrollTimeout: 15000 });
    const post = wantedId ? posts.find((p) => p.postId === wantedId) : posts[0];

    if (wantedId && !post) {
      const seen = posts.map((p) => `${p.postId} @${p.author.username}`).join(", ") || "none";
      throw new McpError(
        ErrorCode.InternalError,
        `get_post could not find post ${wantedId} on ${url}. Articles seen: ${seen}. ` +
          `The post may be deleted, protected, or the page did not finish rendering — retry, ` +
          `but do not treat any other post on that page as this one.`
      );
    }

    const comments = await scrapeComments(page, url, { maxPosts: commentLimit });

    return {
      content: [{ type: "text", text: renderPost(post, url, comments) }] as TextContent[],
    };
  }

  private async handleSearch(args: unknown) {
    const result = SearchSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    const posts = await searchTwitter(
      page,
      { query: result.data.query },
      { maxPosts: result.data.limit }
    );

    return {
      content: [
        { type: "text", text: renderResults(result.data.query, posts) },
      ] as TextContent[],
    };
  }

  private async handleSearchViral(args: unknown) {
    const result = SearchViralSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    const posts = await searchTwitter(
      page,
      SearchPresets.viral(result.data.query, result.data.minLikes),
      { maxPosts: result.data.limit }
    );

    return {
      content: [
        { type: "text", text: renderResults(result.data.query, posts) },
      ] as TextContent[],
    };
  }
  private async handleScrapeTimeline(args: unknown) {
    const result = ScrapeTimelineSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    const posts = await scrapeTimeline(page, result.data.type as any, {
      maxPosts: result.data.maxPosts,
      maxAgeHours: result.data.maxAgeHours,
    });

    return {
      content: [
        {
          type: "text",
          text: renderTimeline(`x ${result.data.type} timeline`, posts),
        },
      ] as TextContent[],
    };
  }

  private async handleScrapeTrending() {
    const page = await this.ensureAuthenticated();
    const trends = await scrapeTrendingTopics(page);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              trendingTopics: trends,
            },
            null,
            2
          ),
        },
      ] as TextContent[],
    };
  }

  private throwIfRateLimited(since: number) {
    const hit = getRateLimitHit(this.authenticatedPage);
    if (hit && hit.at >= since) {
      throw new RateLimitError(hit);
    }
  }

  private upgradeToRateLimit(error: unknown, since: number): unknown {
    if (error instanceof RateLimitError) return error;
    const hit = getRateLimitHit(this.authenticatedPage);
    if (hit && hit.at >= since) {
      return new RateLimitError(hit);
    }
    return error;
  }

  private async handleError(error: unknown) {
    if (this.authenticatedPage && process.env.DEBUG_WEBHOOK_URL) {
      try {
        const filePath = "debug_screenshot.png";
        this.authenticatedPage?.screenshot({ path: filePath });
        const fileBuffer = readFileSync(filePath);
        await fetch(process.env.DEBUG_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename=\"${filePath}\"`,
          },
          body: fileBuffer,
        });
        unlinkSync(filePath);
      } catch {}
    }

    if (error instanceof RateLimitError) {
      throw new McpError(ErrorCode.InternalError, error.message);
    }

    if (error instanceof McpError) {
      throw error;
    }

    console.error("Unexpected error:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ] as TextContent[],
      isError: true,
    };
  }

  // Post interaction handlers
  private async handleLikePost(args: unknown) {
    const result = LikePostSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    const success = await likePost(page, result.data.postUrl);

    return {
      content: [
        {
          type: "text",
          text: success
            ? `Successfully liked post: ${result.data.postUrl}`
            : `Post was already liked: ${result.data.postUrl}`,
        },
      ] as TextContent[],
    };
  }

  private async handleUnlikePost(args: unknown) {
    const result = UnlikePostSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    const success = await unlikePost(page, result.data.postUrl);

    return {
      content: [
        {
          type: "text",
          text: success
            ? `Successfully unliked post: ${result.data.postUrl}`
            : `Post was not liked: ${result.data.postUrl}`,
        },
      ] as TextContent[],
    };
  }

  private async handleBookmarkPost(args: unknown) {
    const result = BookmarkPostSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await bookmarkPost(page, result.data.postUrl);

    return {
      content: [
        {
          type: "text",
          text: `Successfully bookmarked post: ${result.data.postUrl}`,
        },
      ] as TextContent[],
    };
  }

  private async handleUnbookmarkPost(args: unknown) {
    const result = UnbookmarkPostSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await unbookmarkPost(page, result.data.postUrl);

    return {
      content: [
        {
          type: "text",
          text: `Successfully removed bookmark from post: ${result.data.postUrl}`,
        },
      ] as TextContent[],
    };
  }

  private async handleRetweetPost(args: unknown) {
    const result = RetweetPostSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await retweetPost(page, result.data.postUrl);

    return {
      content: [
        {
          type: "text",
          text: `Successfully retweeted post: ${result.data.postUrl}`,
        },
      ] as TextContent[],
    };
  }

  private async handleUnretweetPost(args: unknown) {
    const result = UnretweetPostSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await unretweetPost(page, result.data.postUrl);

    return {
      content: [
        {
          type: "text",
          text: `Successfully unretweeted post: ${result.data.postUrl}`,
        },
      ] as TextContent[],
    };
  }

  private async handleQuoteTweet(args: unknown) {
    const result = QuoteTweetSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await quoteTweet(page, result.data.postUrl, result.data.quoteText);

    return {
      content: [
        {
          type: "text",
          text: `Successfully quote tweeted: "${result.data.quoteText}" on post ${result.data.postUrl}`,
        },
      ] as TextContent[],
    };
  }

  private async handleReplyToPost(args: unknown) {
    const result = ReplyToPostSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await replyToPost(page, result.data.postUrl, result.data.replyText);

    return {
      content: [
        {
          type: "text",
          text: `Successfully replied to post ${result.data.postUrl} with: "${result.data.replyText}"`,
        },
      ] as TextContent[],
    };
  }

  // Comment interaction handlers
  private async handleLikeCommentById(args: unknown) {
    const result = LikeCommentByIdSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await likeCommentById(page, result.data.commentUrl);

    return {
      content: [
        {
          type: "text",
          text: `Successfully liked comment: ${result.data.commentUrl}`,
        },
      ] as TextContent[],
    };
  }

  private async handleUnlikeCommentById(args: unknown) {
    const result = UnlikeCommentByIdSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await unlikeCommentById(page, result.data.commentUrl);

    return {
      content: [
        {
          type: "text",
          text: `Successfully unliked comment: ${result.data.commentUrl}`,
        },
      ] as TextContent[],
    };
  }

  private async handleReplyToCommentById(args: unknown) {
    const result = ReplyToCommentByIdSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await replyToCommentById(page, result.data.commentUrl, result.data.replyText);

    return {
      content: [
        {
          type: "text",
          text: `Successfully replied to comment ${result.data.commentUrl} with: "${result.data.replyText}"`,
        },
      ] as TextContent[],
    };
  }

  private async handleReplaceCommentById(args: unknown) {
    const result = ReplaceCommentByIdSchema.safeParse(args);
    if (!result.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${result.error.message}`);
    }

    const page = await this.ensureAuthenticated();
    await replaceCommentById(page, result.data.commentUrl, result.data.newText);

    return {
      content: [
        {
          type: "text",
          text: `Successfully replaced comment: ${result.data.commentUrl} with: "${result.data.newText}"`,
        },
      ] as TextContent[],
    };
  }

  async start(): Promise<void> {
    // On the stdio transport, stdout is reserved exclusively for JSON-RPC
    // messages. Any stray console.log (e.g. scraper progress like
    // "Scraped post 25: ...") corrupts the protocol stream and the client
    // fails to parse it. Redirect console.log to stderr so diagnostic output
    // is preserved without breaking the protocol.
    console.log = (...args: unknown[]) => console.error(...args);

    // When the client disconnects, stdout is closed under us. The next write
    // (a response or a flushed log) then raises EPIPE, which Node turns into an
    // unhandled 'error' event and a noisy crash. Treat a broken pipe as a clean
    // shutdown signal instead of crashing.
    process.stdout.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") process.exit(0);
      throw err;
    });

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Twitter Playwright MCP server running on stdio");
  }

  async startSSE(port: number = 3000): Promise<void> {
    const app = express();
    app.use(express.json());

    // Store transports for multiple connections
    const transports: { [sessionId: string]: SSEServerTransport } = {};

    // SSE connection endpoint
    app.get("/sse", async (_req, res) => {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;

      res.on("close", () => {
        console.error(`SSE connection closed: ${transport.sessionId}`);
        delete transports[transport.sessionId];
      });

      await this.server.connect(transport);
      console.error(`SSE connection established: ${transport.sessionId}`);
    });

    // Message handling endpoint
    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = transports[sessionId];

      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send("No transport found for sessionId");
      }
    });

    app.get("/ping", (_req, res) => {
      res.send("pong");
    });

    app.listen(port, () => {
      console.error(`Twitter Playwright MCP server running on HTTP port ${port}`);
      console.error(`SSE endpoint: http://localhost:${port}/sse`);
      console.error(`Messages endpoint: http://localhost:${port}/messages`);
    });
  }
}

if (require.main === module) {
  const profileArg = process.argv.indexOf("--profile");
  const profile: Profile =
    profileArg !== -1 && process.argv[profileArg + 1] === "explorer" ? "explorer" : "director";
  const server = new TwitterMCPServer(profile);

  const useSSE = process.env.MCP_TRANSPORT === "sse" || process.env.MCP_TRANSPORT === "http";
  const port = parseInt(process.env.MCP_PORT || "3000");

  if (useSSE) {
    server.startSSE(port).catch((error) => {
      console.error("Failed to start SSE server:", error);
      process.exit(1);
    });
  } else {
    server.start().catch((error) => {
      console.error("Failed to start server:", error);
      process.exit(1);
    });
  }
}
