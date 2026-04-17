/**
 * CinemaCity Scraper — based on working Cinecityfinal.js
 * Uses native fetch (not undici) to match the working implementation.
 * CDN URLs expire quickly, so we use a lazy proxy for playback.
 */
import * as cheerio from 'cheerio';

const MAIN_URL = 'https://cinemacity.cc';

const _b = (s: string) => Buffer.from(s, 'base64').toString();

const HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    'Cookie': `dle_user_id=${_b('MzI3Mjk=')}; dle_password=${_b('ODk0MTcxYzZhOGRhYjE4ZWU1OTRkNWM2NTIwMDlhMzU=')};`,
    'Referer': MAIN_URL + '/'
};

export const CINEMACITY_HEADERS = HEADERS;

const TMDB_API_KEY = _b('MTg2NWY0M2EwNTQ5Y2E1MGQzNDFkZDlhYjhiMjlmNDk=');

const atobPolyfill = (str: string): string => {
    try {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
        let output = '';
        str = String(str).replace(/[=]+$/, '');
        if (str.length % 4 === 1) return '';

        for (
            let bc = 0, bs = 0, buffer: any, i = 0;
            (buffer = str.charAt(i++));
            ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
                ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
                : 0
        ) {
            buffer = chars.indexOf(buffer);
        }
        return output;
    } catch {
        return '';
    }
};

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, { headers: HEADERS });
    return await res.text();
}

async function fetchJson(url: string): Promise<any> {
    const res = await fetch(url);
    return await res.json();
}

/**
 * Match a JSON array value for a given key in decoded text.
 * Uses bracket counting to handle nested arrays/objects.
 */
function matchJsonArray(text: string, key: string): RegExpMatchArray | null {
    const keyPattern = new RegExp(`${key}\\s*:\\s*\\[`);
    const keyMatch = keyPattern.exec(text);
    if (!keyMatch) return null;

    const startIdx = keyMatch.index! + keyMatch[0].length - 1; // position of '['
    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < text.length; i++) {
        if (text[i] === '[') depth++;
        else if (text[i] === ']') depth--;
        if (depth === 0) {
            endIdx = i + 1;
            break;
        }
    }
    if (depth !== 0) return null;

    const arrayStr = text.substring(startIdx, endIdx);
    // Return in RegExpMatchArray-like format: [fullMatch, capturedGroup]
    const result = [arrayStr, arrayStr] as unknown as RegExpMatchArray;
    result.index = keyMatch.index;
    result.input = text;
    return result;
}

/**
 * Extract file data from a CinemaCity page HTML.
 * Shared between discovery (getCinemaCityStreams) and lazy resolve (extractFreshStreamUrl).
 */
function extractFileData(html: string): any {
    const $ = cheerio.load(html);
    let fileData: any = null;

    $('script').each((_i: number, el: any) => {
        if (fileData) return;

        const scriptHtml = $(el).html();
        if (!scriptHtml || !scriptHtml.includes('atob')) return;

        const regex = /atob\s*\(\s*(['"])(.*?)\1\s*\)/g;
        let match;

        while ((match = regex.exec(scriptHtml)) !== null) {
            const decoded = atobPolyfill(match[2]);

            const fileMatch =
                decoded.match(/file\s*:\s*(['"])(.*?)\1/s) ||
                matchJsonArray(decoded, 'file') ||
                matchJsonArray(decoded, 'sources');

            if (fileMatch) {
                let raw = fileMatch[2] || fileMatch[1];
                try {
                    if (raw.startsWith('[') || raw.startsWith('{')) {
                        // Only strip backslashes that aren't valid JSON escapes
                        // Preserve \uXXXX, \\, \", \/, \b, \f, \n, \r, \t for JSON.parse
                        raw = raw.replace(/\\(?![u"\\\/bfnrt])/g, '');
                        fileData = JSON.parse(raw);
                    } else {
                        fileData = raw;
                    }
                } catch {
                    fileData = raw;
                }
                console.log('[CinemaCity] File data extracted, type:', Array.isArray(fileData) ? `array[${fileData.length}]` : typeof fileData,
                    Array.isArray(fileData) && fileData[0]?.folder ? '(has folders)' : '');
            }
        }
    });

    return fileData;
}

/**
 * Parse subtitle string from CinemaCity player data.
 * Format: "[Label1]https://url1.vtt,[Label2]https://url2.vtt,..."
 */
function parseSubtitles(subtitleStr: string): SubtitleTrack[] {
    if (!subtitleStr || typeof subtitleStr !== 'string') return [];
    const tracks: SubtitleTrack[] = [];
    // Split on ,[ but keep the bracket
    const parts = subtitleStr.split(/,(?=\[)/);
    for (const part of parts) {
        const match = part.match(/^\[([^\]]+)\](https?:\/\/.+)$/);
        if (match) {
            tracks.push({ label: match[1], url: match[2].replace(/\\\/\//g, '/') });
        }
    }
    return tracks;
}

/**
 * Navigate file data to pick the correct stream URL.
 * For movies: returns the first file URL.
 * For series: navigates season → episode folder structure.
 */
function pickStream(fileData: any, type: string, season: number = 1, episode: number = 1): string | null {
    if (typeof fileData === 'string') {
        return fileData.startsWith('//') ? 'https:' + fileData : fileData;
    }

    if (!Array.isArray(fileData)) return null;

    // Flat array of files (movie or single-level)
    if (type === 'movie' || fileData.every((x: any) => x && typeof x === 'object' && 'file' in x && !('folder' in x))) {
        const url = fileData[0]?.file || null;
        if (!url) return null;
        return url.startsWith('//') ? 'https:' + url : url;
    }

    // Nested folder structure: Season → Episode
    let selectedSeasonFolder: any[] | null = null;
    for (const s of fileData) {
        if (!s || typeof s !== 'object' || !s.folder) continue;
        const title = (s.title || '').toLowerCase();
        const seasonRegex = new RegExp(`(?:season|stagione|s)\\s*0*${season}\\b`, 'i');
        if (seasonRegex.test(title)) {
            selectedSeasonFolder = s.folder;
            break;
        }
    }
    // Fallback: first folder
    if (!selectedSeasonFolder) {
        for (const s of fileData) {
            if (s && s.folder) {
                selectedSeasonFolder = s.folder;
                break;
            }
        }
    }
    if (!selectedSeasonFolder) return null;

    // Find episode by title
    let selectedEpisodeFile: string | null = null;
    for (const e of selectedSeasonFolder) {
        if (!e || typeof e !== 'object' || !e.file) continue;
        const title = (e.title || '').toLowerCase();
        const epRegex = new RegExp(`(?:episode|episodio|e)\\s*0*${episode}\\b`, 'i');
        if (epRegex.test(title)) {
            selectedEpisodeFile = e.file;
            break;
        }
    }
    // Fallback: index-based
    if (!selectedEpisodeFile) {
        const idx = Math.max(0, episode - 1);
        const epData = idx < selectedSeasonFolder.length ? selectedSeasonFolder[idx] : selectedSeasonFolder[0];
        selectedEpisodeFile = epData?.file || null;
    }

    if (!selectedEpisodeFile) return null;
    return selectedEpisodeFile.startsWith('//') ? 'https:' + selectedEpisodeFile : selectedEpisodeFile;
}

/**
 * Pick the subtitle string for the correct episode from file data.
 */
function pickSubtitleStr(fileData: any, type: string, season: number = 1, episode: number = 1): string {
    if (!Array.isArray(fileData)) return '';

    // Flat array (movie)
    if (type === 'movie' || fileData.every((x: any) => x && typeof x === 'object' && 'file' in x && !('folder' in x))) {
        return fileData[0]?.subtitle || '';
    }

    // Nested folder: Season → Episode
    let selectedSeasonFolder: any[] | null = null;
    for (const s of fileData) {
        if (!s || typeof s !== 'object' || !s.folder) continue;
        const title = (s.title || '').toLowerCase();
        const seasonRegex = new RegExp(`(?:season|stagione|s)\\s*0*${season}\\b`, 'i');
        if (seasonRegex.test(title)) { selectedSeasonFolder = s.folder; break; }
    }
    if (!selectedSeasonFolder) {
        for (const s of fileData) { if (s && s.folder) { selectedSeasonFolder = s.folder; break; } }
    }
    if (!selectedSeasonFolder) return '';

    // Find episode
    for (const e of selectedSeasonFolder) {
        if (!e || typeof e !== 'object') continue;
        const title = (e.title || '').toLowerCase();
        const epRegex = new RegExp(`(?:episode|episodio|e)\\s*0*${episode}\\b`, 'i');
        if (epRegex.test(title)) return e.subtitle || '';
    }
    // Fallback index
    const idx = Math.max(0, episode - 1);
    const epData = idx < selectedSeasonFolder.length ? selectedSeasonFolder[idx] : selectedSeasonFolder[0];
    return epData?.subtitle || '';
}

/**
 * Resolve a relative or absolute URL against a base.
 */
function resolveAbsUrl(base: string, rel: string): string {
    if (rel.startsWith('http://') || rel.startsWith('https://')) return rel;
    try {
        return new URL(rel, base).toString();
    } catch {
        return rel;
    }
}

/**
 * Extract the player.php iframe URL from a CinemaCity page.
 * CDN segments require this as the Referer header.
 */
function extractPlayerReferer(html: string, pageUrl: string): string {
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']*player\.php[^"']*)["']/i);
    if (!iframeMatch || !iframeMatch[1]) return pageUrl;
    return resolveAbsUrl(pageUrl, iframeMatch[1]);
}

/**
 * Build the headers needed for CDN requests (HLS playlists + segments).
 * Uses the player referer (not the page URL) — the CDN checks this.
 */
function buildStreamHeaders(playerReferer: string, pageUrl: string): Record<string, string> {
    let origin: string;
    try {
        origin = new URL(pageUrl).origin;
    } catch {
        origin = MAIN_URL;
    }
    return {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': playerReferer,
        'Origin': origin,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Cookie': HEADERS['Cookie']
    };
}

/**
 * Search CinemaCity and return the first matching page URL.
 * If exactMatch=false (e.g. IMDB search), take the first result without title filtering.
 */
async function searchCinemaCity(query: string, exactMatch: boolean = true): Promise<string | null> {
    const searchUrl = `${MAIN_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
    console.log(`[CinemaCity] Search URL: ${searchUrl}`);

    const searchHtml = await fetchText(searchUrl);

    // Debug: detect Cloudflare block
    if (searchHtml.includes('Just a moment') || searchHtml.includes('cf-browser-verification')) {
        console.log('[CinemaCity] WARNING: Cloudflare challenge detected! Cookies may be expired.');
        return null;
    }

    const $ = cheerio.load(searchHtml);
    const items = $('div.dar-short_item');
    console.log(`[CinemaCity] Found ${items.length} results for: ${query}`);

    let mediaUrl: string | null = null;
    let firstUrl: string | null = null;

    items.each((_i: number, el: any) => {
        if (mediaUrl) return;
        const anchor = $(el).find("a[href*='.html']").first();
        if (!anchor.length) return;

        const href = anchor.attr('href');
        if (!href) return;

        // Always save the first result as fallback
        if (!firstUrl) firstUrl = href;

        if (!exactMatch) {
            // For IMDB ID search: take first result (the site matched it already)
            mediaUrl = href;
            console.log('[CinemaCity] Match (IMDB):', href);
            return;
        }

        const foundTitle = anchor.text().split('(')[0].trim();
        if (
            foundTitle.toLowerCase().includes(query.toLowerCase()) ||
            query.toLowerCase().includes(foundTitle.toLowerCase())
        ) {
            mediaUrl = href;
            console.log('[CinemaCity] Match:', href);
        }
    });

    // Fallback: if title search found results but none matched, take the first
    if (!mediaUrl && firstUrl) {
        console.log('[CinemaCity] No exact match, using first result:', firstUrl);
        mediaUrl = firstUrl;
    }

    return mediaUrl;
}

/**
 * Main entry: discover streams for a TMDB ID.
 * Returns the CDN URL directly with behaviorHints so Stremio handles HLS natively.
 * No self-proxy needed — the CDN tokens are valid for hours.
 */
export async function getCinemaCityStreams(
    tmdbId: string,
    mediaType: string,
    season?: string,
    episode?: string,
    preferredLang?: string
): Promise<any[]> {
    try {
        const lang = preferredLang || 'en';
        console.log(`[CinemaCity] id=${tmdbId}, type=${mediaType}, S=${season}, E=${episode}, lang=${lang}`);

        // 1. TMDB — get IMDB ID + title (localized + English)
        const tmdbType = mediaType === 'series' ? 'tv' : 'movie';
        let imdbId: string | null = null;
        let title: string | null = null;
        let titleEn: string | null = null;

        // If the input is already an IMDB ID, use it directly
        if (tmdbId.startsWith('tt')) {
            imdbId = tmdbId;
            // Fetch both localized and English titles from TMDB
            try {
                const findData = await fetchJson(
                    `https://api.themoviedb.org/3/find/${tmdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
                );
                const results = findData?.movie_results?.[0] || findData?.tv_results?.[0];
                titleEn = results?.title || results?.name || null;
            } catch { /* proceed without */ }
            if (lang !== 'en') {
                try {
                    const findData = await fetchJson(
                        `https://api.themoviedb.org/3/find/${tmdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=${lang}`
                    );
                    const results = findData?.movie_results?.[0] || findData?.tv_results?.[0];
                    title = results?.title || results?.name || null;
                } catch { /* proceed without */ }
            }
            if (!title) title = titleEn;
        } else {
            const tmdbData = await fetchJson(
                `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`
            );
            imdbId = tmdbData?.imdb_id || tmdbData?.external_ids?.imdb_id || null;
            titleEn = tmdbData?.title || tmdbData?.name || null;

            if (lang !== 'en') {
                try {
                    const langData = await fetchJson(
                        `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=${lang}`
                    );
                    title = langData?.title || langData?.name || null;
                } catch { /* fallback */ }
            }
            if (!title) title = titleEn;
        }

        console.log(`[CinemaCity] IMDB: ${imdbId}, Title: ${title}, TitleEN: ${titleEn}`);

        if (!imdbId && !title) return [];

        // 2. Search CinemaCity — IMDB ID first, then localized title, then English title
        let mediaUrl: string | null = null;

        if (imdbId) {
            mediaUrl = await searchCinemaCity(imdbId, false);
        }
        if (!mediaUrl && title) {
            mediaUrl = await searchCinemaCity(title);
        }
        if (!mediaUrl && titleEn && titleEn !== title) {
            mediaUrl = await searchCinemaCity(titleEn);
        }

        if (!mediaUrl) {
            console.log('[CinemaCity] No results found');
            return [];
        }

        // 3. Verify page has playable content (quick check, no URL extraction yet)
        const pageHtml = await fetchText(mediaUrl);
        const fileData = extractFileData(pageHtml);

        if (!fileData) {
            console.log('[CinemaCity] No playable content on page');
            return [];
        }

        // 4. Return lazy proxy URL — CDN URL resolved fresh at playback time
        //    IP-locked: only the server can download from CDN, so we must proxy.
        const tokenData: any = { page: mediaUrl };
        if (season) tokenData.s = parseInt(season, 10);
        if (episode) tokenData.e = parseInt(episode, 10);
        if (lang) tokenData.lang = lang;
        const pageToken = Buffer.from(JSON.stringify(tokenData)).toString('base64url');

        console.log(`[CinemaCity] Stream ready (lazy proxy)`);
        return [{
            name: 'CinemaCity',
            title: `🎬 ${title}`,
            url: `/proxy/cc/manifest.m3u8?token=${pageToken}`
        }];
    } catch (err: any) {
        console.error('[CinemaCity] Error:', err?.message || err);
        return [];
    }
}

export interface SubtitleTrack {
    label: string;
    url: string;
}

export interface FreshStream {
    url: string;
    headers: Record<string, string>;
    subtitles: SubtitleTrack[];
}

/**
 * Extract a fresh stream URL + proper CDN headers from a CinemaCity page.
 * Called at playback time by the lazy proxy endpoint in addon.ts.
 */
export async function extractFreshStreamUrl(pageUrl: string, season?: number, episode?: number): Promise<FreshStream | null> {
    try {
        const type = (season || episode) ? 'series' : 'movie';
        console.log(`[CinemaCity] Lazy resolve: ${pageUrl} (type=${type}, S=${season}, E=${episode})`);
        const pageHtml = await fetchText(pageUrl);
        const fileData = extractFileData(pageHtml);

        if (!fileData) {
            console.log('[CinemaCity] Lazy resolve: no file data');
            return null;
        }

        const url = pickStream(fileData, type, season || 1, episode || 1);
        if (!url) {
            console.log('[CinemaCity] Lazy resolve: no stream URL from pickStream');
            return null;
        }

        const subtitleStr = pickSubtitleStr(fileData, type, season || 1, episode || 1);
        const subtitles = parseSubtitles(subtitleStr);
        console.log(`[CinemaCity] Subtitles found: ${subtitles.length}`);

        const playerReferer = extractPlayerReferer(pageHtml, pageUrl);
        const streamHeaders = buildStreamHeaders(playerReferer, pageUrl);
        console.log(`[CinemaCity] Fresh URL: ${url.substring(0, 100)}...`);
        console.log(`[CinemaCity] Player Referer: ${playerReferer}`);

        return { url, headers: streamHeaders, subtitles };
    } catch (err: any) {
        console.error('[CinemaCity] Lazy resolve error:', err?.message || err);
        return null;
    }
}
