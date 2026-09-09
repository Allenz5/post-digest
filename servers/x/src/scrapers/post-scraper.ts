import { Page } from "playwright";
import { TwitterPost, PostMetrics, ScrapeOptions } from "../types";
import { 
  waitForTwitterReady, 
  scrollAndWait, 
  parseCount, 
  calculateEngagementRate,
  extractUserFromElement,
  extractMediaFromElement,
  isAdElement
} from "./utils";

/**
 * Scrape posts from the current page
 */
export async function scrapePosts(
  page: Page, 
  options: ScrapeOptions = {}
): Promise<TwitterPost[]> {
  const {
    // Optional hard cap on post count. When time bounds the scroll, maxPosts
    // defaults to unlimited; when time is only a filter (see ageStopsScroll)
    // it cannot bound anything, so the count cap has to.
    maxAgeHours,
    // Whether an old post means "we have scrolled past the window" (true) or
    // just "skip this one" (false). Only a genuinely reverse-chronological
    // feed can use age as a boundary — see the caller in timeline-scraper.
    ageStopsScroll = true,
    maxPosts = maxAgeHours != null && ageStopsScroll ? Infinity : 10,
    // Absolute safety backstop so we can never scroll truly forever (e.g. if
    // the feed keeps lazy-loading). Primary stops are the time cutoff and
    // end-of-feed detection below.
    scrollTimeout = 600000,
    waitBetweenScrolls = 2000,
    // Stop once this many consecutive scrolls produce no new posts — i.e. we've
    // reached the bottom of the loadable timeline. Kept generous because each
    // incremental scroll is small and X lazy-loads, so brief stalls are normal.
    maxNoNewScrolls = 8,
    // When bounding by time, stop only after this many original posts older than
    // the cutoff appear back-to-back. The Following/For-You feed is NOT strictly
    // reverse-chronological — X injects out-of-order and "popular" older posts
    // near the top — so stopping on the very first old post truncates the scrape
    // to a handful of tweets. Requiring a run of old posts means we only stop
    // once we've genuinely scrolled past the time window.
    maxConsecutiveOldPosts = 12,
  } = options;

  // Time window: stop once we scroll past a post older than the cutoff. Reposts
  // carry the ORIGINAL tweet's timestamp (not their feed-appearance time), so
  // they must not trigger the cutoff.
  const cutoffMs = maxAgeHours != null ? Date.now() - maxAgeHours * 3600_000 : null;

  await waitForTwitterReady(page);

  const posts: TwitterPost[] = [];
  const seenPostIds = new Set<string>();
  const startTime = Date.now();
  let noNewScrolls = 0;
  let reachedCutoff = false;
  let consecutiveOld = 0;

  while (posts.length < maxPosts && (Date.now() - startTime) < scrollTimeout) {
    const countBefore = posts.length;

    // Get all tweet articles on the page
    const tweetElements = await page.$$('article[data-testid="tweet"]');

    for (const element of tweetElements) {
      if (posts.length >= maxPosts) break;

      try {
        if (await isAdElement(element)) {
          console.log('Skipping ad post');
          continue;
        }

        const post = await extractPostFromElement(element, page);

        if (!post || seenPostIds.has(post.postId)) continue;

        // An original post older than the cutoff *suggests* we've passed the
        // window, but the feed isn't strictly reverse-chronological (X sprinkles
        // in out-of-order/older posts), so skip the stray old post and keep
        // going. Only stop once we hit a sustained run of old originals, which
        // means we've truly scrolled past the time window.
        if (cutoffMs !== null && !post.isRetweet && post.timestamp.getTime() < cutoffMs) {
          seenPostIds.add(post.postId); // mark seen so it isn't re-counted
          // Filter-only mode: drop it and keep scrolling. Never let age end the
          // scroll, because in this feed age carries no ordering information.
          if (!ageStopsScroll) continue;
          consecutiveOld++;
          if (consecutiveOld >= maxConsecutiveOldPosts) {
            reachedCutoff = true;
            break;
          }
          continue;
        }
        consecutiveOld = 0;

        seenPostIds.add(post.postId);
        posts.push(post);
        console.log(`Scraped post ${posts.length}: ${post.postId}`);
      } catch (error) {
        console.error('Error extracting post:', error);
      }
    }

    if (reachedCutoff) {
      console.log(`Reached ${maxAgeHours}h cutoff; stopping with ${posts.length} posts`);
      break;
    }
    if (posts.length >= maxPosts) break;

    // End-of-feed detection: if a scroll cycle adds nothing new for several
    // rounds in a row, assume we've hit the bottom and stop.
    if (posts.length === countBefore) {
      noNewScrolls++;
      if (noNewScrolls >= maxNoNewScrolls) {
        console.log(
          `No new posts after ${noNewScrolls} scrolls; assuming end of feed at ${posts.length} posts`
        );
        break;
      }
    } else {
      noNewScrolls = 0;
    }

    await scrollAndWait(page, waitBetweenScrolls);
  }

  return posts;
}

/**
 * Extract post data from a tweet element
 */
async function extractPostFromElement(element: any, _page: Page): Promise<TwitterPost | null> {
  try {
    // Extract post URL and ID. It has to be the article's OWN permalink, not
    // the first /status/ link it happens to contain: on a status page X does
    // not render the focal tweet's timestamp as a self-link, so for a post that
    // quotes another the first match is the QUOTED tweet — which is how
    // get_post came back "could not find post <id>" on a post that was right
    // there, and kept coming back that way on every retry. The timestamp anchor
    // is the permalink on any tweet that has one; the views/analytics anchor is
    // the focal tweet's own and is what remains when it does not.
    const postLink =
      (await element.$('a[href*="/status/"]:has(time)')) ||
      (await element.$('a[href*="/status/"][href$="/analytics"]')) ||
      (await element.$('a[href*="/status/"]'));
    if (!postLink) return null;

    const href = await postLink.getAttribute('href');
    if (!href) return null;

    const postIdMatch = href.match(/\/status\/(\d+)/);
    if (!postIdMatch) return null;

    const postId = postIdMatch[1];
    const url = `https://x.com${href.replace(/\/analytics$/, '')}`;
    
    // Extract author
    const author = await extractUserFromElement(element);
    
    // Extract content
    const contentElement = await element.$('[data-testid="tweetText"]');
    const content = contentElement ? await contentElement.textContent() : '';
    
    // Extract timestamp
    const timeElement = await element.$('time');
    const dateTime = await timeElement?.getAttribute('datetime');
    const timestamp = dateTime ? new Date(dateTime) : new Date();
    
    // Extract media
    const media = await extractMediaFromElement(element);
    
    // Extract metrics
    const metrics = await extractMetricsFromElement(element);
    
    // Calculate engagement rate
    const engagementRate = calculateEngagementRate(
      metrics.likesCount,
      metrics.retweetsCount,
      metrics.repliesCount,
      metrics.impressionsCount
    );
    
    // Check if it's a retweet
    const retweetIndicator = await element.$('[data-testid="socialContext"]');
    const isRetweet = retweetIndicator !== null;
    
    let retweetedFrom = undefined;
    if (isRetweet) {
      const retweetText = await retweetIndicator?.textContent();
      if (retweetText && retweetText.includes('reposted')) {
        // Extract original author from retweet context
        const retweetAuthorElement = await retweetIndicator.$('a');
        if (retweetAuthorElement) {
          const retweetAuthorHref = await retweetAuthorElement.getAttribute('href');
          const retweetAuthorName = await retweetAuthorElement.textContent();
          if (retweetAuthorHref) {
            retweetedFrom = {
              userId: retweetAuthorHref.replace('/', ''),
              username: retweetAuthorHref.replace('/', ''),
              displayName: retweetAuthorName || ''
            };
          }
        }
      }
    }
    
    return {
      postId,
      author,
      content,
      timestamp,
      media,
      metrics,
      engagementRate,
      isRetweet,
      retweetedFrom,
      url
    };
  } catch (error) {
    console.error('Error in extractPostFromElement:', error);
    return null;
  }
}

/**
 * Extract metrics from a tweet element
 */
async function extractMetricsFromElement(element: any): Promise<PostMetrics> {
  const metrics: PostMetrics = {
    likesCount: 0,
    retweetsCount: 0,
    quotesCount: 0,
    repliesCount: 0,
    impressionsCount: 0,
    bookmarksCount: 0
  };
  
  try {
    // Extract reply count
    const replyButton = await element.$('[data-testid="reply"]');
    if (replyButton) {
      const replyText = await replyButton.textContent();
      metrics.repliesCount = parseCount(replyText || '0');
    }
    
    // Extract retweet count
    const retweetButton = await element.$('[data-testid="retweet"]');
    if (retweetButton) {
      const retweetText = await retweetButton.textContent();
      metrics.retweetsCount = parseCount(retweetText || '0');
    }
    
    // Extract like count
    const likeButton = await element.$('[data-testid="like"]');
    if (likeButton) {
      const likeText = await likeButton.textContent();
      metrics.likesCount = parseCount(likeText || '0');
    }
    
    // Extract view/impression count
    const viewsElement = await element.$('[href$="/analytics"]');
    if (viewsElement) {
      const viewsText = await viewsElement.textContent();
      metrics.impressionsCount = parseCount(viewsText || '0');
    }
    
    // Extract bookmark count (usually not visible in feed)
    const bookmarkButton = await element.$('[data-testid="bookmark"]');
    if (bookmarkButton) {
      const bookmarkText = await bookmarkButton.textContent();
      metrics.bookmarksCount = parseCount(bookmarkText || '0');
    }
    
  } catch (error) {
    console.error('Error extracting metrics:', error);
  }
  
  return metrics;
}

/**
 * Scrape a single post by URL
 */
export async function scrapeSinglePost(page: Page, postUrl: string): Promise<TwitterPost | null> {
  await page.goto(postUrl);
  await waitForTwitterReady(page);
  
  // Find the main tweet (not replies)
  const mainTweet = await page.$('article[data-testid="tweet"]').catch(() => null);
  if (!mainTweet) return null;
  
  // Check if it's an ad
  if (await isAdElement(mainTweet)) {
    console.log('Main tweet is an ad, skipping');
    return null;
  }
  
  return extractPostFromElement(mainTweet, page);
} 