/**
 * Types for Twitter/X scraping
 */

export interface TwitterUser {
  userId: string;
  username: string; // handle without @
  displayName: string;
  avatarUrl?: string;
  isVerified?: boolean;
  isBlueVerified?: boolean;
}

export interface TwitterPost {
  postId: string;
  author: TwitterUser;
  content: string;
  timestamp: Date;
  media: TwitterMedia[];
  metrics: PostMetrics;
  engagementRate: number;
  isRetweet?: boolean;
  retweetedFrom?: TwitterUser;
  quotedPost?: TwitterPost;
  url: string;
}

export interface TwitterMedia {
  type: 'image' | 'video' | 'gif';
  url: string;
  thumbnailUrl?: string;
  duration?: number; // for videos in seconds
}

export interface PostMetrics {
  likesCount: number;
  retweetsCount: number;
  quotesCount: number;
  repliesCount: number;
  impressionsCount: number;
  bookmarksCount: number;
}

export interface TwitterProfile extends TwitterUser {
  bannerUrl?: string;
  bio?: string;
  location?: string;
  website?: string;
  joinedDate?: Date;
  followingCount: number;
  followersCount: number;
  postsCount: number;
  isFollowing?: boolean;
  isFollowedBy?: boolean;
  latestPosts?: TwitterPost[];
}

export interface TwitterComment {
  commentId: string;
  commentUrl: string;
  author: TwitterUser;
  content: string;
  timestamp: Date;
  likesCount: number;
  repliesCount: number;
  parentCommentId?: string;
  parentCommentUrl?: string;
  media?: TwitterMedia[];
}

export interface SearchOptions {
  query: string;
  fromUser?: string;
  toUser?: string;
  minLikes?: number;
  minRetweets?: number;
  minReplies?: number;
  includeReplies?: boolean;
  onlyVerified?: boolean;
  hasMedia?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  language?: string;
}

export interface ScrapeOptions {
  maxPosts?: number;
  maxAgeHours?: number;          // stop once posts are older than this (ignores reposts); replaces maxPosts when set
  scrollTimeout?: number;        // absolute safety backstop (ms)
  waitBetweenScrolls?: number;
  maxNoNewScrolls?: number;      // stop after this many consecutive scrolls with no new posts (end of feed)
  maxConsecutiveOldPosts?: number; // when maxAgeHours is set, stop only after this many consecutive originals older than the cutoff (the feed isn't strictly chronological)
  ageStopsScroll?: boolean;      // false = maxAgeHours only filters posts, never ends the scroll (for feeds with no chronological order, e.g. For You)
}

/**
 * Type for posting tweets with optional media attachments
 */
export interface TweetWithMedia {
  text: string;
  media?: string[];
} 