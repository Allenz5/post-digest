import { Page } from "playwright";
import { TwitterPost, ScrapeOptions } from "../types";
import { waitForTwitterReady, dismissPopups } from "./utils";
import { scrapePosts } from "./post-scraper";

export type TimelineType = 'for-you' | 'following';

/**
 * Scrape posts from timeline (For You or Following)
 */
export async function scrapeTimeline(
  page: Page,
  timelineType: TimelineType = 'for-you',
  options: ScrapeOptions = {}
): Promise<TwitterPost[]> {
  // Navigate to home
  await page.goto('https://x.com/home');
  await waitForTwitterReady(page);
  await dismissPopups(page);
  
  // Switch to the desired timeline tab
  await switchTimelineTab(page, timelineType);
  
  // Wait for timeline to load
  await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});
  
  console.log(`Scraping ${timelineType} timeline...`);
  
  // Scrape posts. Age can only bound the scroll on a feed that is actually in
  // time order. "Following" roughly is; "For you" is not — X seeds it with older
  // popular posts, so a run of them is normal mid-feed and must not be read as
  // "we have scrolled past the window". There, age filters and nothing more.
  const posts = await scrapePosts(page, {
    ...options,
    ageStopsScroll: timelineType === 'following',
  });
  
  console.log(`Scraped ${posts.length} posts from ${timelineType} timeline`);
  
  return posts;
}

/**
 * Switch between timeline tabs
 */
async function switchTimelineTab(page: Page, timelineType: TimelineType) {
  const tabText = timelineType === 'for-you' ? 'For you' : 'Following';

  try {
    // The "For you" / "Following" tabs live in a tablist at the top of the home
    // column — NOT in the sidebar nav. Match by ARIA role + accessible name so
    // we don't depend on the exact DOM nesting.
    const tab = page.getByRole('tab', { name: tabText, exact: true }).first();
    await tab.waitFor({ state: 'visible', timeout: 8000 });

    const isSelected = async () =>
      (await tab.getAttribute('aria-selected').catch(() => null)) === 'true';

    if (await isSelected()) {
      console.log(`"${tabText}" tab already selected`);
      return;
    }

    // X renders an overlay container (<div id="layers">) that often intercepts
    // pointer events over the tab, so a normal click times out. Clear popups,
    // try a real click, then fall back to a direct DOM click dispatch (which
    // ignores the overlay hit-test) and verify the tab actually became selected.
    await dismissPopups(page);
    await page.keyboard.press('Escape').catch(() => {});

    await tab.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);

    if (!(await isSelected())) {
      console.log(`"${tabText}" click intercepted; dispatching DOM click`);
      await tab.dispatchEvent('click').catch(() => {});
      await page.waitForTimeout(1500);
    }

    const selected = await isSelected();
    console.log(`Switched to "${tabText}" tab (selected=${selected})`);
    if (!selected) {
      console.error(
        `WARNING: "${tabText}" tab did not become selected — timeline may still ` +
        `be showing the default (For you) feed.`
      );
    }
  } catch (error) {
    console.error(`Error switching to ${tabText} tab:`, error);
  }
}

/**
 * Scrape both timelines
 */
export async function scrapeBothTimelines(
  page: Page,
  options: ScrapeOptions = {}
): Promise<{
  forYou: TwitterPost[];
  following: TwitterPost[];
}> {
  console.log('Scraping both timelines...');
  
  // Scrape "For You" timeline
  const forYou = await scrapeTimeline(page, 'for-you', options);
  
  // Scrape "Following" timeline
  const following = await scrapeTimeline(page, 'following', options);
  
  return {
    forYou,
    following
  };
}

/**
 * Get latest posts since a specific time
 */
export async function getLatestPosts(
  page: Page,
  since: Date,
  timelineType: TimelineType = 'for-you',
  maxPosts: number = 100
): Promise<TwitterPost[]> {
  const posts = await scrapeTimeline(page, timelineType, { maxPosts });
  
  // Filter posts newer than the specified date
  return posts.filter(post => post.timestamp > since);
}

/**
 * Monitor timeline for new posts
 */
export async function monitorTimeline(
  page: Page,
  timelineType: TimelineType,
  callback: (newPosts: TwitterPost[]) => void,
  checkInterval: number = 60000 // Check every minute
): Promise<() => void> {
  const seenPostIds = new Set<string>();
  let isMonitoring = true;
  
  // Initial scrape to populate seen posts
  const initialPosts = await scrapeTimeline(page, timelineType, { maxPosts: 20 });
  initialPosts.forEach(post => seenPostIds.add(post.postId));
  
  const monitor = async () => {
    while (isMonitoring) {
      try {
        // Refresh the page
        await page.reload();
        await waitForTwitterReady(page);
        
        // Scrape latest posts
        const posts = await scrapeTimeline(page, timelineType, { maxPosts: 20 });
        
        // Find new posts
        const newPosts = posts.filter(post => !seenPostIds.has(post.postId));
        
        if (newPosts.length > 0) {
          console.log(`Found ${newPosts.length} new posts`);
          newPosts.forEach(post => seenPostIds.add(post.postId));
          callback(newPosts);
        }
        
        // Wait before next check
        await page.waitForTimeout(checkInterval);
      } catch (error) {
        console.error('Error monitoring timeline:', error);
      }
    }
  };
  
  // Start monitoring in background
  monitor();
  
  // Return stop function
  return () => {
    isMonitoring = false;
  };
}

/**
 * Get posts from specific users in timeline
 */
export async function getPostsFromUsers(
  page: Page,
  usernames: string[],
  timelineType: TimelineType = 'following',
  options: ScrapeOptions = {}
): Promise<TwitterPost[]> {
  const posts = await scrapeTimeline(page, timelineType, options);
  
  // Filter posts by usernames
  const usernameSet = new Set(usernames.map(u => u.replace('@', '').toLowerCase()));
  
  return posts.filter(post => 
    usernameSet.has(post.author.username.toLowerCase())
  );
} 