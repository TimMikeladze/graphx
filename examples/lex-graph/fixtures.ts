/**
 * Both shows' fixtures as episodes, for the tests: `fixtures/lex/` holds 18 items of the live feed
 * across every era of its format, their podcast-page entries plus one the feed dropped, and that
 * one's recovered item; `fixtures/mindscape/` holds 17 feed items covering every title shape and
 * their posts in the site's sitemap.
 * Several people are on both (Max Tegmark, Nick Bostrom, Joel David Hamkins), and one name is two people (John Danaher).
 */
import { type FeedItem, parseFeed } from './parse.ts';
import { joinSources, parsePage } from './podcasts/lex.ts';
import { parseEpisodes, parseSitemap } from './podcasts/mindscape.ts';

const text = (path: string) => Bun.file(new URL(`./fixtures/${path}`, import.meta.url)).text();

export const lexFeed = parseFeed(await text('lex/feed.xml'));
export const lexPage = parsePage(await text('lex/podcast.html'));
export const lexRecovered: Record<string, FeedItem> = JSON.parse(await text('lex/recovered.json'));
export const lexEpisodes = joinSources([...lexFeed, ...Object.values(lexRecovered)], lexPage);

export const mindscapeFeed = parseFeed(await text('mindscape/feed.xml'));
export const mindscapePosts = parseSitemap(await text('mindscape/posts.xml'));
export const mindscapeEpisodes = parseEpisodes(mindscapeFeed, mindscapePosts);

export const episodes = [...lexEpisodes, ...mindscapeEpisodes];
